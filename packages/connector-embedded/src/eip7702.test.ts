import {
  delegateAccount,
  estimateFees,
  prepareDelegationAuthorization,
} from "@naculus/connect-core";
import type { StorageAdapter, WalletData } from "@naculus/wallet-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPocketConnector } from "./index";

/**
 * EIP-7702 authorization signing through the embedded connector, with real
 * keys (index.test.ts mocks secp256k1, which would make these vacuous).
 */

// Fee estimation is the only thing faked; wallet-engine imports it from core.
vi.mock("@naculus/connect-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@naculus/connect-core")>()),
  estimateFees: vi.fn(),
}));

class MemoryStorage implements StorageAdapter {
  private d: WalletData | null = null;
  readonly type = "memory" as const;
  isAvailable() {
    return true;
  }
  async load() {
    return this.d;
  }
  async save(x: WalletData) {
    this.d = x;
  }
  async clear() {
    this.d = null;
  }
}

const PK = `0x${"ab".repeat(32)}`;
const ACCOUNT = "0xe239cdc5fbe977a8a141B72194D3CF8c41bC5BC6";
const DELEGATE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

async function connected() {
  const connector = createPocketConnector({
    storage: new MemoryStorage(),
    chainId: "eip155:1",
    rpcUrl: "https://rpc.invalid",
  });
  const session = await connector.connect();
  await connector.importFromPrivateKey(PK);
  return { connector, session };
}

function prepare(
  overrides: { chainId?: string; account?: `0x${string}` } = {},
) {
  return prepareDelegationAuthorization({
    account: overrides.account ?? ACCOUNT,
    chainId: overrides.chainId ?? "eip155:1",
    delegate: DELEGATE,
    allowlist: [DELEGATE],
    sender: "relayer",
    getTransactionCount: async () => "0x7",
  });
}

describe("PocketConnector.signAuthorization", () => {
  it("signs a prepared authorization for its own account", async () => {
    const { connector, session } = await connected();
    // viem 2.56.5 signature for this key and authorization; see
    // wallet-engine signers/evm-tx.test.ts.
    await expect(
      connector.signAuthorization(session, await prepare()),
    ).resolves.toEqual({
      account: ACCOUNT,
      chainId: "eip155:1",
      address: DELEGATE,
      nonce: "0x7",
      yParity: 1,
      r: "0x8590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5",
      s: "0x41f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b",
    });
  });

  it("refuses an authorization prepared for another account", async () => {
    const { connector, session } = await connected();
    const request = await prepare({
      account: "0x1111111111111111111111111111111111111111",
    });
    await expect(
      connector.signAuthorization(session, request),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a chain the wallet is not configured for", async () => {
    const { connector, session } = await connected();
    await expect(
      connector.signAuthorization(
        session,
        await prepare({ chainId: "eip155:10" }),
      ),
    ).rejects.toMatchObject({ code: "chain_mismatch" });
  });

  it.each(["eip155:0", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", undefined])(
    "refuses chain %s even when handed a request built by hand",
    async (chainId) => {
      const { connector, session } = await connected();
      const request = { ...(await prepare()), chainId } as never;
      await expect(
        connector.signAuthorization(session, request),
      ).rejects.toMatchObject({ code: "invalid_chain" });
    },
  );

  it("refuses while the Solana account is active", async () => {
    const connector = createPocketConnector({
      storage: new MemoryStorage(),
      chainId: "eip155:1",
    });
    const session = await connector.connect();
    await connector.importFromMnemonic(MNEMONIC);
    connector.setActiveNamespace("solana");
    const request = await prepare({ account: ACCOUNT });
    await expect(
      connector.signAuthorization(session, request),
    ).rejects.toMatchObject({ code: "namespace_mismatch" });
  });

  it("refuses after disconnect", async () => {
    const { connector, session } = await connected();
    const request = await prepare();
    await connector.disconnect(session);
    await expect(
      connector.signAuthorization(session, request),
    ).rejects.toMatchObject({ code: "session_expired" });
  });
});

describe("PocketConnector.sendDelegation", () => {
  const TX_HASH = `0x${"ff".repeat(32)}`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockRpc() {
    const methods: string[] = [];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, opts) => {
        const body = JSON.parse((opts as RequestInit).body as string);
        methods.push(body.method);
        const result =
          (
            {
              eth_getTransactionCount: "0x6",
              eth_estimateGas: "0xb3b0",
              eth_sendRawTransaction: TX_HASH,
            } as Record<string, string>
          )[body.method] ?? null;
        return {
          ok: true,
          json: async () => ({ jsonrpc: "2.0", id: body.id, result }),
        } as Response;
      });
    return { methods, spy };
  }

  it("delegates its own account through core's delegateAccount", async () => {
    const { connector, session } = await connected();
    vi.mocked(estimateFees).mockResolvedValue({
      type: "eip1559",
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    const { methods } = mockRpc();

    const sent = await delegateAccount({
      connector,
      session,
      account: ACCOUNT,
      chainId: "eip155:1",
      delegate: DELEGATE,
      allowlist: [DELEGATE],
      getTransactionCount: async () => "0x6",
    });

    expect(sent).toEqual({
      hash: TX_HASH,
      // Pending count 6: the transaction takes 6, the authorization 7 — the
      // same viem-checked signature as above.
      authorization: {
        account: ACCOUNT,
        chainId: "eip155:1",
        address: DELEGATE,
        nonce: "0x7",
        yParity: 1,
        r: "0x8590d30e098d3e27cd8e83b30b6965999605a2129f77b170dec7af1762a9e1c5",
        s: "0x41f93e1aa5100e4ff37f1cf8c61d39d289b93cb994cbd27bc62db429919c149b",
      },
    });
    expect(methods).toEqual(["eth_estimateGas", "eth_sendRawTransaction"]);
  });

  it("refuses a request for another account before any RPC call", async () => {
    const { connector, session } = await connected();
    const { spy } = mockRpc();
    await expect(
      connector.sendDelegation(session, {
        account: "0x1111111111111111111111111111111111111111",
        chainId: "eip155:1",
        address: DELEGATE,
        nonce: "0x7",
        transactionNonce: "0x6",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses after disconnect", async () => {
    const { connector, session } = await connected();
    await connector.disconnect(session);
    const { spy } = mockRpc();
    await expect(
      connector.sendDelegation(session, {
        account: ACCOUNT,
        chainId: "eip155:1",
        address: DELEGATE,
        nonce: "0x7",
        transactionNonce: "0x6",
      }),
    ).rejects.toMatchObject({ code: "session_expired" });
    expect(spy).not.toHaveBeenCalled();
  });
});

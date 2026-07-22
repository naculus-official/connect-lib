import { SignClient } from "@walletconnect/sign-client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// ── Config ──────────────────────────────────────────────────────

const PROJECT_ID =
  process.env.VITE_WALLETCONNECT_PROJECT_ID ||
  "70f75bd70b2718c8bcea689f413cc666";

const WALLET_METADATA = {
  name: "E2E Test Wallet",
  description: "Programmatic wallet for automated E2E testing",
  url: "https://naculus.dev",
  icons: [],
};

const REQUIRED_NAMESPACES = {
  eip155: {
    methods: [
      "eth_accounts",
      "eth_requestAccounts",
      "personal_sign",
      "eth_sign",
      "eth_signTransaction",
      "eth_sendTransaction",
      "eth_sendRawTransaction",
      "wallet_switchEthereumChain",
    ],
    events: ["accountsChanged", "chainChanged", "disconnect"],
  },
};

// Generate a deterministic wallet for testing
const TEST_PRIVATE_KEY = process.env.E2E_WALLET_PK || generatePrivateKey();

const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const TEST_ADDRESS = TEST_ACCOUNT.address;

const SUPPORTED_CHAINS = [
  "eip155:1",
  "eip155:137",
  "eip155:42161",
  "eip155:10",
];

// ── Wallet Adapter ──────────────────────────────────────────────

export class E2EWalletAdapter {
  constructor() {
    this.client = null;
    this.sessionTopic = null;
    this._pendingTimeout = null;
  }

  async init() {
    this.client = await SignClient.init({
      projectId: PROJECT_ID,
      metadata: WALLET_METADATA,
    });

    this.client.on("session_proposal", async (proposal) => {
      console.log(`[wallet] Session proposal received: ${proposal.id}`);
      await this._handleSessionProposal(proposal);
    });

    this.client.on("session_request", async (requestEvent) => {
      console.log(
        `[wallet] Session request: ${requestEvent.params.request.method}`,
      );
      await this._handleSessionRequest(requestEvent);
    });

    this.client.on("session_delete", () => {
      console.log("[wallet] Session deleted");
      this.sessionTopic = null;
    });
  }

  async pair(uri) {
    if (!this.client) throw new Error("Wallet not initialized");

    console.log(`[wallet] Pairing with URI: ${uri.slice(0, 50)}...`);
    await this.client.pair({ uri });

    // Wait for session proposal to be handled
    await new Promise((resolve, reject) => {
      this._pendingTimeout = setTimeout(() => {
        reject(new Error("Timeout waiting for session proposal"));
      }, 30000);
      const interval = setInterval(() => {
        if (this.sessionTopic) {
          clearInterval(interval);
          if (this._pendingTimeout) clearTimeout(this._pendingTimeout);
          resolve();
        }
      }, 200);
    });
  }

  async _handleSessionProposal(proposal) {
    if (!this.client) throw new Error("Wallet not initialized");

    const { id, params } = proposal;
    const { requiredNamespaces, optionalNamespaces } = params;

    const namespaces = {};

    // Build eip155 namespace
    const eip155Chains = requiredNamespaces.eip155?.chains ?? SUPPORTED_CHAINS;
    const eip155Methods =
      requiredNamespaces.eip155?.methods ?? REQUIRED_NAMESPACES.eip155.methods;
    const eip155Events = requiredNamespaces.eip155?.events ?? [
      "accountsChanged",
      "chainChanged",
      "disconnect",
    ];

    namespaces.eip155 = {
      chains: eip155Chains,
      methods: eip155Methods,
      events: eip155Events,
      accounts: eip155Chains.map((chain) => `${chain}:${TEST_ADDRESS}`),
    };

    // Handle optional namespaces
    if (optionalNamespaces) {
      for (const [ns, config] of Object.entries(optionalNamespaces)) {
        if (namespaces[ns]) continue;
        const chains = config.chains ?? [];
        if (chains.length === 0) continue;
        namespaces[ns] = {
          chains,
          methods: config.methods ?? [],
          events: config.events ?? [],
          accounts: chains.map((chain) => `${chain}:${TEST_ADDRESS}`),
        };
      }
    }

    console.log(`[wallet] Approving session...`);
    await this.client.approve({
      id,
      namespaces,
    });

    this.sessionTopic = params.pairingTopic;
    console.log(`[wallet] Session approved ✓`);
  }

  async _handleSessionRequest(requestEvent) {
    if (!this.client) throw new Error("Wallet not initialized");

    const { topic, id, params } = requestEvent;
    const { request } = params;

    console.log(`[wallet] Handling request: ${request.method}`);

    try {
      let result;

      switch (request.method) {
        case "personal_sign": {
          // personal_sign params: [message, address] or [address, message]
          // We try both to be compatible
          const data = request.params[0];
          const address = request.params[1];

          // Determine which param is the address
          const addrParam =
            address && address.startsWith("0x") && address.length === 42
              ? address
              : data.startsWith("0x") && data.length === 42
                ? data
                : null;

          if (!addrParam) {
            throw new Error(
              "Could not determine address from personal_sign params",
            );
          }

          // If the address is the second param, it's [message, address]
          // If the address is the first param, it's [address, message]
          const msgParam =
            addrParam === request.params[0]
              ? request.params[1]
              : request.params[0];

          result = await TEST_ACCOUNT.signMessage({
            message: { raw: msgParam },
          });
          console.log(`[wallet] personal_sign → ${result.slice(0, 20)}...`);
          break;
        }

        case "eth_signTypedData_v4": {
          // Params can be [address, typedDataJSON]
          const typedDataStr = request.params[1] || request.params[0];
          const typedData =
            typeof typedDataStr === "string"
              ? JSON.parse(typedDataStr)
              : typedDataStr;
          result = await TEST_ACCOUNT.signTypedData(typedData);
          console.log(
            `[wallet] eth_signTypedData_v4 → ${result.slice(0, 20)}...`,
          );
          break;
        }

        case "eth_accounts":
        case "eth_requestAccounts": {
          result = [TEST_ADDRESS];
          break;
        }

        default:
          throw new Error(`Unsupported method: ${request.method}`);
      }

      await this.client.respond({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          result,
        },
      });

      console.log(`[wallet] Response sent ✓`);
    } catch (error) {
      console.error(
        `[wallet] Error handling ${request.method}:`,
        error.message,
      );
      await this.client.respond({
        topic,
        response: {
          id,
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: error.message,
          },
        },
      });
    }
  }

  async disconnect() {
    if (!this.client || !this.sessionTopic) return;
    try {
      await this.client.disconnect({
        topic: this.sessionTopic,
        reason: { code: 6000, message: "E2E test complete" },
      });
    } catch (e) {
      // Session may already be closed
    }
    this.sessionTopic = null;
  }

  async destroy() {
    await this.disconnect();
    if (this._pendingTimeout) clearTimeout(this._pendingTimeout);
  }
}

// ── Run as CLI ──────────────────────────────────────────────────

export async function runE2EWallet(uri) {
  const wcUri = uri || process.env.WC_URI;
  if (!wcUri) {
    console.error("Usage: WC_URI=wc:... node e2e-wallet.js");
    console.error("   or:  node e2e-wallet.js wc:...");
    process.exit(1);
  }

  const wallet = new E2EWalletAdapter();
  console.log(`[wallet] Initializing wallet at ${TEST_ADDRESS}...`);
  await wallet.init();
  await wallet.pair(wcUri);

  console.log(
    `[wallet] Paired and ready! Session topic: ${wallet.sessionTopic}`,
  );
  console.log(`[wallet] Press Ctrl+C to disconnect and exit.`);

  // Keep alive
  process.on("SIGINT", async () => {
    console.log("\n[wallet] Shutting down...");
    await wallet.destroy();
    process.exit(0);
  });
}

// Run as CLI
const isMain = process.argv[1]?.includes("e2e-wallet");
if (isMain) {
  runE2EWallet(process.argv[2]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

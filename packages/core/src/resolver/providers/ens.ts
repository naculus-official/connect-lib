import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

const textEncoder = new TextEncoder();
function stringToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

import type { AddressResult, NameResult, ResolverProvider } from "../types";
import { ResolutionError } from "../types";

// ── Constants ────────────────────────────────────────────────────

/** ENS Registry (Ethereum Mainnet). */
export const ENS_REGISTRY_ADDRESS =
  "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" as const;

/** Reverse Registrar. */
export const ENS_REVERSE_REGISTRAR =
  "0x084b1c3C81545dD370363A3AaE2416F0D5Ee5c0" as const;

/** ENS Registry ABI (minimal — only the functions we need). */
const ENS_REGISTRY_ABI = [
  {
    name: "resolver",
    type: "function",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "owner",
    type: "function",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/** Resolver ABI (minimal). */
const RESOLVER_ABI = [
  {
    name: "addr",
    type: "function",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "name",
    type: "function",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const EMPTY_ADDR = `0x${"00".repeat(20)}` as const;

/**
 * ENS namehash algorithm.
 * Converts a domain like "vitalik.eth" into a 32-byte node hash.
 */
function namehash(name: string): `0x${string}` {
  let node: Uint8Array = new Uint8Array(32).fill(0);

  if (name) {
    const labels = name.split(".");
    for (let i = labels.length - 1; i >= 0; i--) {
      const labelHash = keccak_256(stringToBytes(labels[i].toLowerCase()));
      node = keccak_256(concatBytes(node, labelHash));
    }
  }

  return `0x${bytesToHex(node)}`;
}

/**
 * Labelhash for a single label (used in reverse lookup).
 */
function labelhash(label: string): `0x${string}` {
  return `0x${bytesToHex(keccak_256(stringToBytes(label.toLowerCase())))}`;
}

// ── ABI Encoding ─────────────────────────────────────────────────

/**
 * Encode a function call for eth_call.
 * Minimal ABI encoder — no dependency on ethers.js.
 */
function encodeFunctionCall(
  abi: readonly { name: string; inputs: readonly { type: string }[] }[],
  fnName: string,
  args: (`0x${string}` | string)[],
): `0x${string}` {
  const abiEntry = abi.find((f) => f.name === fnName);
  if (!abiEntry) throw new Error(`Function ${fnName} not found in ABI`);

  // Compute function selector (first 4 bytes of keccak256 of signature)
  const inputs = abiEntry.inputs.map((i) => i.type).join(",");
  const signature = `${fnName}(${inputs})`;
  const selector = keccak_256(stringToBytes(signature)).slice(0, 4);

  // Encode arguments
  const encodedArgs = args.map((arg) => {
    if (typeof arg === "string" && arg.startsWith("0x")) {
      // bytes32 or address — pad to 32 bytes
      const hex = arg.slice(2).padStart(64, "0");
      return hexToBytes(hex);
    }
    // string — dynamic encoding
    const bytes = stringToBytes(arg);
    // Offset (currently at position 0 as first dynamic arg)
    const offset = new Uint8Array(32);
    // Length
    const lengthBytes = new Uint8Array(32);
    const lenView = new DataView(lengthBytes.buffer);
    lenView.setBigUint64(24, BigInt(bytes.length), false);
    // Data padded to 32 bytes
    const paddedLen = Math.ceil(bytes.length / 32) * 32;
    const padded = new Uint8Array(paddedLen);
    padded.set(bytes);
    return concatBytes(offset, lengthBytes, padded);
  });

  const encoded = concatBytes(selector, ...encodedArgs);
  return `0x${bytesToHex(encoded)}`;
}

/**
 * Decode an address (first 12 bytes zero-padded address).
 */
function decodeAddress(data: `0x${string}`): `0x${string}` {
  const bytes = hexToBytes(data.slice(2));
  // Address is bytes12 padding + bytes20 address
  if (bytes.length < 32) {
    throw new ResolutionError(
      "INVALID_ADDRESS",
      "Invalid response length for address decode",
    );
  }
  const addrBytes = bytes.slice(12, 32);
  return `0x${bytesToHex(addrBytes)}`;
}

/**
 * Decode a string from ABI-encoded data.
 */
function decodeString(data: `0x${string}`): string {
  const bytes = hexToBytes(data.slice(2));
  if (bytes.length < 32)
    throw new ResolutionError(
      "INVALID_ADDRESS",
      "Invalid response for string decode",
    );

  // offset (first 32 bytes)
  // length (second 32 bytes)
  const lengthBytes = bytes.slice(32, 64);
  const len = Number(new DataView(lengthBytes.buffer).getBigUint64(24, false));
  // string data starts at byte 64
  const strBytes = bytes.slice(64, 64 + len);
  return new TextDecoder().decode(strBytes);
}

// ── RPC Helper ───────────────────────────────────────────────────

interface EthCallParams {
  to: `0x${string}`;
  data: `0x${string}`;
}

async function ethCall(
  rpcUrl: string,
  params: EthCallParams,
): Promise<`0x${string}`> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [params, "latest"],
    }),
  });

  if (!response.ok) {
    throw new ResolutionError(
      "PROVIDER_UNAVAILABLE",
      `ENS RPC call failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    result?: `0x${string}`;
    error?: { message: string };
  };

  if (json.error) {
    throw new ResolutionError(
      "NAME_NOT_FOUND",
      `ENS lookup failed: ${json.error.message}`,
    );
  }

  return json.result ?? "0x";
}

// ── Provider ─────────────────────────────────────────────────────

/**
 * ENS name resolution provider.
 *
 * Resolves `.eth` names via direct eth_call to ENS contracts.
 * Does NOT depend on ethers.js or web3.js — uses plain fetch + minimal
 * ABI encoding.
 */
export class ENSProvider implements ResolverProvider {
  readonly chainType = "eip155" as const;
  private readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  supportsName(name: string): boolean {
    return name.toLowerCase().endsWith(".eth");
  }

  async resolveName(name: string): Promise<AddressResult | null> {
    const cleanName = name.toLowerCase();
    if (!cleanName.endsWith(".eth")) return null;

    const node = namehash(cleanName);

    // 1. Get resolver address from ENS Registry
    const resolverAddr = await this.getResolver(node);
    if (
      !resolverAddr ||
      resolverAddr === "0x0000000000000000000000000000000000000000"
    ) {
      return null;
    }

    // 2. Call resolver.addr(node)
    const addrData = encodeFunctionCall(RESOLVER_ABI, "addr", [node]);
    const result = await ethCall(this.rpcUrl, {
      to: resolverAddr,
      data: addrData,
    });

    if (
      !result ||
      result === "0x" ||
      result ===
        "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      return null;
    }

    const address = decodeAddress(result);

    return {
      address,
      chainType: "eip155",
      name: cleanName,
    };
  }

  async lookupAddress(address: string): Promise<NameResult | null> {
    const cleanAddr = address.startsWith("0x")
      ? (address.toLowerCase() as `0x${string}`)
      : `0x${address.toLowerCase()}`;

    // Reverse lookup: addr.reverse node
    const reverseNode = namehash(
      `${cleanAddr.slice(2).toLowerCase()}.addr.reverse`,
    );

    // 1. Get resolver from reverse registrar
    const resolverAddr = await this.getResolver(reverseNode);
    if (
      !resolverAddr ||
      resolverAddr === "0x0000000000000000000000000000000000000000"
    ) {
      return null;
    }

    // 2. Call resolver.name(node)
    const nameData = encodeFunctionCall(RESOLVER_ABI, "name", [reverseNode]);
    const result = await ethCall(this.rpcUrl, {
      to: resolverAddr,
      data: nameData,
    });

    if (!result || result === "0x") return null;

    try {
      const name = decodeString(result);
      if (!name) return null;

      return {
        name,
        chainType: "eip155",
        isPrimary: true,
      };
    } catch {
      return null;
    }
  }

  private async getResolver(
    node: `0x${string}`,
  ): Promise<`0x${string}` | null> {
    const data = encodeFunctionCall(ENS_REGISTRY_ABI, "resolver", [node]);
    try {
      const result = await ethCall(this.rpcUrl, {
        to: ENS_REGISTRY_ADDRESS,
        data,
      });
      if (!result || result === "0x") return null;
      return decodeAddress(result);
    } catch {
      return null;
    }
  }
}

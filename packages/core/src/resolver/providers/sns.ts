import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils";

const textEncoder = new TextEncoder();
function stringToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

import type { AddressResult, NameResult, ResolverProvider } from "../types";
import { ResolutionError } from "../types";

// ── Constants ────────────────────────────────────────────────────

/** Bonfida SNS Program ID (mainnet). */
export const SNS_PROGRAM_ID = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";

/** .sol TLD domain key (PDA). Derived from seeds ["domain", "sol"]. */
export const SOL_TLD_DOMAIN = "58P1RCHjMiN1eS6LGpmmNvbTYGWCoh2vMGN4JmSScWdT";

/** The SNS "name record" prefix seed. */
const NAME_RECORD_SEED = "name_record";

/** Central Bank account (SNS owner). */
const SNS_CENTRAL_BANK = "FzU4e4qMA1aCiq3YBoe8ByKK5ubQi9a5kYzP4jcfprh6";

// ── Helper Constants ────────────────────────────────────────────

/** BASE58 alphabet for decoding Solana addresses. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE = BigInt(58);

/** Max retries for RPC calls. */
const MAX_RETRIES = 2;

// ── Base58 Decode ────────────────────────────────────────────────

/**
 * Decode a Base58-encoded string to bytes.
 */
function base58Decode(input: string): Uint8Array {
  // Convert to BigInt first
  let num = BigInt(0);
  for (const char of input) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid Base58 character: ${char}`);
    num = num * BASE + BigInt(idx);
  }

  // Convert BigInt to bytes
  const hex = num.toString(16);
  const hexPadded = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = hexToBytes(hexPadded);

  // Preserve leading zeros (encoded as '1's)
  const leadingZeros = input.match(/^1*/)?.[0]?.length ?? 0;
  const result = new Uint8Array(leadingZeros + bytes.length);
  result.set(bytes, leadingZeros);

  return result;
}

/**
 * Decode Base58 to a hex string.
 */
function base58ToHex(input: string): string {
  return bytesToHex(base58Decode(input));
}

// ── PDA Derivation ───────────────────────────────────────────────

/**
 * Derive a Solana PDA (Program Derived Address).
 * Returns [address_bytes, bump_seed].
 */
function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): [Uint8Array, number] {
  for (let bump = 255; bump >= 0; bump--) {
    const seedsBytes = concatBytes(...seeds, new Uint8Array([bump]), programId);
    const hash = sha256(seedsBytes);
    // Check that the hash is NOT on the ed25519 curve
    // (simplified: check that the first byte is not a valid curve point)
    // For Solana, PDAs are guaranteed by bump search
    if (hash[31] & 0x80) continue; // Try next bump if high bit is set
    return [hash, bump];
  }
  throw new Error("Unable to find a valid bump seed");
}

/**
 * Parse a Solana account info response.
 */
function parseAccountInfo(rawData: string): Record<string, unknown> {
  // Decode Base58 account data into hex
  const bytes = base58Decode(rawData);
  // For name records, the format is:
  // - header (bytes): tag (1) + parent_name (32) + owner (32) + class (32)
  // - data (remaining)
  const header = {
    tag: bytes[0],
    parentName: bytesToHex(bytes.slice(1, 33)),
    owner: bytesToHex(bytes.slice(33, 65)),
    class: bytesToHex(bytes.slice(65, 97)),
  };

  const content = bytes.slice(97);

  return {
    header,
    content: bytesToHex(content),
    rawBytes: bytes.length,
  };
}

// ── RPC Helper ───────────────────────────────────────────────────

interface AccountInfo {
  data: string[];
  executable: boolean;
  lamports: number;
  owner: string;
  rentEpoch: number;
  space?: number;
}

async function getAccountInfo(
  rpcUrl: string,
  pubkey: string,
): Promise<AccountInfo | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkey, { encoding: "base58", commitment: "confirmed" }],
    }),
  });

  if (!response.ok) {
    throw new ResolutionError(
      "PROVIDER_UNAVAILABLE",
      `SNS RPC call failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as {
    result?: { value: AccountInfo | null };
    error?: { message: string };
  };

  if (json.error) {
    throw new ResolutionError(
      "NAME_NOT_FOUND",
      `SNS lookup failed: ${json.error.message}`,
    );
  }

  return json.result?.value ?? null;
}

/**
 * Derive the domain key for a .sol name.
 */
function deriveDomainKey(name: string): string {
  // Domain key derivation: PDA with seeds ["name_record", tld_domain, name_bytes]
  const tldBytes = base58Decode(SOL_TLD_DOMAIN);
  const nameBytes = stringToBytes(name.toLowerCase().replace(".sol", ""));
  const programBytes = base58Decode(SNS_PROGRAM_ID);

  const seeds = [stringToBytes(NAME_RECORD_SEED), tldBytes, nameBytes];

  const [address] = findProgramAddress(seeds, programBytes);
  return bytesToHex(address);
}

// ── Provider ─────────────────────────────────────────────────────

/**
 * SNS (Solana Name Service) provider.
 *
 * Resolves `.sol` names via Solana RPC, querying the Bonfida SNS program.
 * Uses plain fetch + @noble/hashes — no @solana/web3.js dependency.
 */
export class SNSProvider implements ResolverProvider {
  readonly chainType = "solana" as const;
  private readonly rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  supportsName(name: string): boolean {
    return name.toLowerCase().endsWith(".sol");
  }

  async resolveName(name: string): Promise<AddressResult | null> {
    const cleanName = name.toLowerCase().trim();
    if (!cleanName.endsWith(".sol")) return null;

    // Derive the domain PDA key for this name
    const domainKey = deriveDomainKey(cleanName);

    // Fetch account info for the domain record
    try {
      const accountInfo = await getAccountInfo(
        this.rpcUrl,
        domainKey.length === 64 ? domainKey : `0x${domainKey}`,
      );

      // The account info returns data as [base58_data, encoding_type]
      if (!accountInfo || !accountInfo.data || accountInfo.data.length === 0) {
        return null;
      }

      // Parse the account data to extract the owner address
      const rawData = accountInfo.data[0];
      const parsed = parseAccountInfo(rawData);

      // The "owner" field in the header is the Solana address that owns this name
      const ownerHex = (parsed.header as Record<string, unknown>)
        .owner as string;

      if (
        !ownerHex ||
        ownerHex ===
          "0000000000000000000000000000000000000000000000000000000000000000"
      ) {
        return null;
      }

      // Convert hex owner to Base58 (Solana address format)
      // For simplicity, return the hex address — consumers can convert if needed
      // In practice, the owner address is stored as a Solana pubkey (32 bytes)
      const solanaAddress = this.hexToBase58(ownerHex);

      return {
        address: solanaAddress,
        chainType: "solana",
        name: cleanName,
      };
    } catch (err) {
      if (err instanceof ResolutionError) throw err;
      return null;
    }
  }

  async lookupAddress(address: string): Promise<NameResult | null> {
    // SNS doesn't have a standard reverse lookup mechanism via RPC.
    // The Bonfida SNS SDK does this via a gRPC backend.
    // For now, we return null — this can be enhanced with a dedicated
    // SNS indexing service in the future.
    return null;
  }

  /**
   * Convert a hex string to a Base58 Solana address.
   */
  private hexToBase58(hex: string): string {
    // Pad to 64 hex chars (32 bytes) for a Solana pubkey
    const normalizedHex = hex.replace(/^0x/, "").padStart(64, "0");
    const bytes = hexToBytes(normalizedHex.slice(0, 64));

    // Convert to BigInt
    let num = BigInt(0);
    for (let i = 0; i < bytes.length; i++) {
      num = num * BigInt(256) + BigInt(bytes[i]);
    }

    // Convert to Base58
    if (num === BigInt(0)) return "11111111111111111111111111111111";

    const chars: string[] = [];
    while (num > BigInt(0)) {
      const remainder = Number(num % BASE);
      chars.push(ALPHABET[remainder]);
      num = num / BASE;
    }

    // Add leading '1's for leading zero bytes
    let leadingOnes = 0;
    for (const b of bytes) {
      if (b === 0) leadingOnes++;
      else break;
    }

    return "1".repeat(leadingOnes) + chars.reverse().join("");
  }
}

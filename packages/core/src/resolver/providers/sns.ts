// Base58 comes from @scure/base. The hand-written pair that used to live here
// produced one byte too many whenever the decoded value was zero — the
// all-zeros Solana System Program ID came back 33 bytes instead of 32 — and
// those bytes are hashed into a program-derived address, so a wrong length
// resolves a name to a different account entirely.

import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

const textEncoder = new TextEncoder();
function stringToBytes(str: string): Uint8Array {
  return textEncoder.encode(str);
}

import type { AddressResult, NameResult, ResolverProvider } from "../types";
import { ResolutionError } from "../types";

// ── Constants ────────────────────────────────────────────────────

/** Bonfida SNS Program ID (mainnet). */
export const SNS_PROGRAM_ID = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";

/** Bonfida's .sol TLD authority (the parent Name Service account). */
export const SOL_TLD_AUTHORITY = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";

/** Backwards-compatible alias; this is an authority, not a derived PDA. */
export const SOL_TLD_DOMAIN = SOL_TLD_AUTHORITY;

/** SPL Name Service PDA hash prefix. */
const HASH_PREFIX = "SPL Name Service";

/** Solana's canonical program-derived-address marker. */
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

// ── Helper Constants ────────────────────────────────────────────

/** BASE58 alphabet for decoding Solana addresses. */

// ── Base58 Decode ────────────────────────────────────────────────

// ── PDA Derivation ───────────────────────────────────────────────

/**
 * Derive a Solana PDA (Program Derived Address).
 * Returns [address_bytes, bump_seed].
 */
function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): [Uint8Array, number] {
  if (programId.length !== 32) {
    throw new Error("Solana program IDs must be 32 bytes");
  }
  const totalSeedLength = seeds.reduce((sum, seed) => sum + seed.length, 0);
  if (
    seeds.length > 16 ||
    seeds.some((seed) => seed.length > 32) ||
    totalSeedLength + seeds.length + 1 > 512
  ) {
    throw new Error("Solana PDA seeds exceed the runtime limits");
  }
  for (let bump = 255; bump >= 0; bump--) {
    const seedsBytes = concatBytes(
      ...seeds,
      new Uint8Array([bump]),
      programId,
      PDA_MARKER,
    );
    const hash = sha256(seedsBytes);
    // A Solana PDA must be off the Ed25519 curve. A bit test is not an
    // equivalent curve-membership check and can derive runtime-invalid PDAs.
    try {
      // 2.x split fromHex (string) from fromBytes (Uint8Array); 1.x accepted
      // both through fromHex. The check itself is unchanged — construction
      // throws for a point that is not on the curve, which is what makes this
      // a real membership test rather than a bit inspection.
      ed25519.Point.fromBytes(hash);
    } catch {
      return [hash, bump];
    }
  }
  throw new Error("Unable to find a valid bump seed");
}

/**
 * Parse a Solana account info response.
 */
function parseAccountInfo(rawData: string): Record<string, unknown> {
  // Decode Base58 account data into hex
  const bytes = base58.decode(rawData);
  if (bytes.length < 96) throw new Error("Invalid SNS name registry data");
  // For name records, the format is:
  // - header (bytes): parent_name (32) + owner (32) + class (32)
  // - data (remaining)
  const header = {
    parentName: bytesToHex(bytes.slice(0, 32)),
    owner: bytesToHex(bytes.slice(32, 64)),
    class: bytesToHex(bytes.slice(64, 96)),
  };

  const content = bytes.slice(96);

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
  // Canonical SPL Name Service derivation: hash the label, then derive the
  // name account from [hashed_name, zero class, .sol TLD authority].
  const bareName = name.toLowerCase().replace(/\.sol$/, "");
  const hashedName = sha256(stringToBytes(HASH_PREFIX + bareName));
  const tldBytes = base58.decode(SOL_TLD_AUTHORITY);
  const programBytes = base58.decode(SNS_PROGRAM_ID);

  const seeds = [hashedName, new Uint8Array(32), tldBytes];

  const [address] = findProgramAddress(seeds, programBytes);
  return base58.encode(address);
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
      const accountInfo = await getAccountInfo(this.rpcUrl, domainKey);

      // The account info returns data as [base58_data, encoding_type]
      if (!accountInfo?.data || accountInfo.data.length === 0) {
        return null;
      }
      if (accountInfo.owner !== SNS_PROGRAM_ID || accountInfo.executable) {
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

    return base58.encode(bytes);
  }
}

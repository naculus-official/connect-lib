/**
 * CAIP-122 Message Format — Sign-In With X
 *
 * Creates and parses SIWx messages according to CAIP-122.
 * Supports all chain namespaces (EVM, Solana, XRPL).
 *
 * References:
 *   - CAIP-122: https://standards.chainagnostic.org/CAIPs/caip-122
 *   - EIP-4361: https://eips.ethereum.org/EIPS/eip-4361
 */

import type { SiwxMessage, SiwxParams } from "./types";
import { nowISO } from "./utils";

/**
 * Default nonce length for SIWx messages.
 */
export const DEFAULT_NONCE_LENGTH = 16;

/**
 * Current version of the SIWx message format.
 */
export const SIWX_VERSION = 1;

/**
 * Derive a human-readable blockchain name from a CAIP-2 chain ID.
 *
 * Reference: Reown AppKit's `getNetworkNameByCaipNetworkId`
 * maps CAIP-2 namespace → display name.
 */
export function getBlockchainName(chainId: string): string {
  if (chainId.startsWith("eip155:")) return "Ethereum";
  if (chainId.startsWith("solana:")) return "Solana";
  if (chainId.startsWith("xrpl:")) return "XRP Ledger";
  return "blockchain";
}

/**
 * Create a CAIP-122 formatted SIWx message string.
 * The returned string is what the user signs.
 */
export function createSiwxMessage(params: SiwxParams): string {
  const domain = params.domain;
  const address = params.address;
  const statement = params.statement;
  const uri = params.uri;
  const version = params.version ?? SIWX_VERSION;
  const chainId = params.chainId;
  const nonce = params.nonce;
  const issuedAt = params.issuedAt ?? nowISO();
  const expirationTime = params.expirationTime;
  const notBefore = params.notBefore;
  const resources = params.resources ?? [];
  const requestId = params.requestId;

  const lines: string[] = [];

  // Line 1: Domain wants you to sign in with your {blockchain} account:
  const blockchainName =
    params.blockchain ?? getBlockchainName(chainId) ?? "blockchain";
  lines.push(
    `${domain} wants you to sign in with your ${blockchainName} account:`,
  );
  lines.push(`${address}`);

  // Optional statement
  if (statement) {
    lines.push("");
    lines.push(statement);
  }

  // URI
  lines.push("");
  lines.push(`URI: ${uri}`);

  // Version
  lines.push(`Version: ${version}`);

  // Chain ID (CAIP-2)
  lines.push(`Chain ID: ${chainId}`);

  // Nonce
  lines.push(`Nonce: ${nonce}`);

  // Issued At
  lines.push(`Issued At: ${issuedAt}`);

  // Expiration Time (optional)
  if (expirationTime) {
    lines.push(`Expiration Time: ${expirationTime}`);
  }

  // Not Before (optional)
  if (notBefore) {
    lines.push(`Not Before: ${notBefore}`);
  }

  // Request ID (optional)
  if (requestId) {
    lines.push(`Request ID: ${requestId}`);
  }

  // Resources (optional)
  if (resources.length > 0) {
    lines.push(`Resources:`);
    for (const resource of resources) {
      lines.push(`- ${resource}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse a CAIP-122 SIWx message string into its structured components.
 * Returns null if parsing fails.
 */
export function parseSiwxMessage(raw: string): SiwxMessage | null {
  try {
    const lines = raw.split("\n");
    if (lines.length < 4) return null;

    // Line 1: "{domain} wants you to sign in with your {blockchain} account:"
    // OR legacy: "{domain} wants you to sign in with your account:"
    const firstLine = lines[0];
    const wantsMatch = firstLine.match(
      /^(.+) wants you to sign in with your( (.+))? account:$/,
    );
    if (!wantsMatch) return null;
    const domain = wantsMatch[1].trim();
    const blockchain = wantsMatch[3]?.trim() || "blockchain";

    // Line 2: blockchain address
    const address = lines[1].trim();

    // Find field lines by scanning for known prefixes
    let statement: string | null = null;
    let uri = "";
    let version = SIWX_VERSION;
    let chainId = "";
    let nonce = "";
    let issuedAt: string | null = null;
    let expirationTime: string | null = null;
    let notBefore: string | null = null;
    let requestId: string | null = null;
    const resources: string[] = [];
    let inResources = false;
    const statementLines: string[] = [];

    // Statement is everything between address (line 1) and the first field
    // Fields are: URI:, Version:, Chain ID:, Nonce:, Issued At:, etc.
    let fieldStart = -1;
    for (let i = 2; i < lines.length; i++) {
      if (
        lines[i].startsWith("URI:") ||
        lines[i].startsWith("Version:") ||
        lines[i].startsWith("Chain ID:") ||
        lines[i].startsWith("Nonce:") ||
        lines[i].startsWith("Issued At:") ||
        lines[i].startsWith("Expiration Time:") ||
        lines[i].startsWith("Not Before:") ||
        lines[i].startsWith("Request ID:") ||
        lines[i].startsWith("Resources:")
      ) {
        fieldStart = i;
        break;
      }
      statementLines.push(lines[i]);
    }

    if (statementLines.length > 0) {
      statement = statementLines
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n");
      if (statement.length === 0) statement = null;
    }

    if (fieldStart === -1) return null;

    // Parse fields
    for (let i = fieldStart; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("URI:")) {
        uri = line.slice(4).trim();
      } else if (line.startsWith("Version:")) {
        version = parseInt(line.slice(8).trim(), 10) || SIWX_VERSION;
      } else if (line.startsWith("Chain ID:")) {
        chainId = line.slice(9).trim();
      } else if (line.startsWith("Nonce:")) {
        nonce = line.slice(6).trim();
      } else if (line.startsWith("Issued At:")) {
        issuedAt = line.slice(10).trim();
      } else if (line.startsWith("Expiration Time:")) {
        expirationTime = line.slice(16).trim();
      } else if (line.startsWith("Not Before:")) {
        notBefore = line.slice(11).trim();
      } else if (line.startsWith("Request ID:")) {
        requestId = line.slice(11).trim();
      } else if (line.startsWith("Resources:")) {
        inResources = true;
      } else if (inResources && line.startsWith("- ")) {
        resources.push(line.slice(2).trim());
      }
    }

    // Validate required fields
    if (!domain || !address || !uri || !chainId || !nonce) {
      return null;
    }

    return {
      raw,
      domain,
      address,
      statement: statement ?? null,
      uri,
      version,
      chainId,
      nonce,
      issuedAt: issuedAt ?? null,
      expirationTime: expirationTime ?? null,
      notBefore: notBefore ?? null,
      resources,
      requestId: requestId ?? null,
      blockchain,
    };
  } catch {
    return null;
  }
}

/**
 * Type guard to check if an object is a valid SiwxMessage.
 */
export function isSiwxMessage(obj: unknown): obj is SiwxMessage {
  if (!obj || typeof obj !== "object") return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.raw === "string" &&
    typeof m.domain === "string" &&
    typeof m.address === "string" &&
    typeof m.uri === "string" &&
    typeof m.version === "number" &&
    typeof m.chainId === "string" &&
    typeof m.nonce === "string" &&
    typeof m.blockchain === "string"
  );
}

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
import { isValidDomain, nowISO } from "./utils";

/**
 * Default nonce length for SIWx messages.
 */
export const DEFAULT_NONCE_LENGTH = 16;

/**
 * Current version of the SIWx message format.
 */
export const SIWX_VERSION = 1;

const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const REQUEST_ID_PATTERN =
  /^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}|[!$&'()*+,;=:@])*$/;
const FIELD_PREFIXES = [
  "URI: ",
  "Version: ",
  "Chain ID: ",
  "Nonce: ",
  "Issued At: ",
  "Expiration Time: ",
  "Not Before: ",
  "Request ID: ",
  "Resources:",
] as const;

function isValidRfc3339(value: string): boolean {
  return (
    RFC3339_PATTERN.test(value) && Number.isFinite(new Date(value).getTime())
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || code === 0x7f;
  });
}

function hasInvalidStatementCharacter(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f || code > 0x7f;
  });
}

function isValidUri(value: string): boolean {
  if (!value || hasControlCharacter(value)) return false;
  try {
    // URL accepts the URI schemes used by CAIP-122 resources (https, ipfs,
    // urn, did, etc.) and rejects malformed authorities and control bytes.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validateParams(params: SiwxParams): void {
  if (!isValidDomain(params.domain)) {
    throw new Error(`Invalid SIWx domain: "${params.domain}"`);
  }
  if (!params.address || /[\r\n]/.test(params.address)) {
    throw new Error("Invalid SIWx account address");
  }
  if (!isValidUri(params.uri)) {
    throw new Error(`Invalid SIWx URI: "${params.uri}"`);
  }
  if (params.version !== undefined && params.version !== SIWX_VERSION) {
    throw new Error(`Unsupported SIWx version: ${params.version}`);
  }
  if (!CAIP2_PATTERN.test(params.chainId)) {
    throw new Error(`Invalid CAIP-2 chain ID: "${params.chainId}"`);
  }
  if (
    params.chainId.startsWith("eip155:") &&
    !/^eip155:[1-9][0-9]*$/.test(params.chainId)
  ) {
    throw new Error(`Invalid EIP-155 chain ID: "${params.chainId}"`);
  }
  if (
    params.chainId.startsWith("eip155:") &&
    !/^0x[0-9a-fA-F]{40}$/.test(params.address)
  ) {
    throw new Error("Invalid EIP-155 account address");
  }
  if (!/^[A-Za-z0-9]{8,}$/.test(params.nonce)) {
    throw new Error(
      "Invalid SIWx nonce: expected at least 8 alphanumeric characters",
    );
  }
  const issuedAt = params.issuedAt ?? nowISO();
  if (!isValidRfc3339(issuedAt)) {
    throw new Error(`Invalid SIWx issuedAt: "${issuedAt}"`);
  }
  for (const [label, value] of [
    ["expirationTime", params.expirationTime],
    ["notBefore", params.notBefore],
  ] as const) {
    if (value !== undefined && !isValidRfc3339(value)) {
      throw new Error(`Invalid SIWx ${label}: "${value}"`);
    }
  }
  if (
    params.statement !== undefined &&
    hasInvalidStatementCharacter(params.statement)
  ) {
    throw new Error("Invalid SIWx statement: must be single-line ASCII");
  }
  if (
    params.requestId !== undefined &&
    !REQUEST_ID_PATTERN.test(params.requestId)
  ) {
    throw new Error(`Invalid SIWx requestId: "${params.requestId}"`);
  }
  for (const resource of params.resources ?? []) {
    if (!isValidUri(resource)) {
      throw new Error(`Invalid SIWx resource URI: "${resource}"`);
    }
  }
}

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
  validateParams(params);
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
    // The canonical serialization uses LF; accepting CRLF would create a
    // different signed byte sequence across implementations.
    if (!raw || raw.includes("\r")) return null;
    const lines = raw.split("\n");
    if (lines.length < 4) return null;

    // Line 1: "{domain} wants you to sign in with your {blockchain} account:"
    // OR legacy: "{domain} wants you to sign in with your account:"
    // Split on literal delimiter to avoid ReDoS from nested greedy regex quantifiers
    const firstLine = lines[0];
    const PREFIX = " wants you to sign in with your";
    const prefixIdx = firstLine.indexOf(PREFIX);
    if (prefixIdx === -1) return null;
    const domain = firstLine.slice(0, prefixIdx).trim();
    const rest = firstLine.slice(prefixIdx + PREFIX.length);
    const blockMatch = rest.match(/^ (.+) account:$/);
    const blockchain = blockMatch?.[1]?.trim() || "blockchain";

    // Line 2: blockchain address
    const address = lines[1].trim();

    // Find field lines by scanning for known prefixes
    let statement: string | null = null;
    let uri = "";
    let version = 0;
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
      if (FIELD_PREFIXES.some((prefix) => lines[i].startsWith(prefix))) {
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

    // Parse fields. Each field appears at most once and follows the order in
    // the EIP-4361/CAIP-122 text representation.
    const fieldOrder = [
      "URI: ",
      "Version: ",
      "Chain ID: ",
      "Nonce: ",
      "Issued At: ",
      "Expiration Time: ",
      "Not Before: ",
      "Request ID: ",
      "Resources:",
    ];
    const seen = new Set<string>();
    let previousOrder = -1;
    for (let i = fieldStart; i < lines.length; i++) {
      const line = lines[i];

      const field = fieldOrder.find((prefix) => line.startsWith(prefix));
      if (field) {
        const order = fieldOrder.indexOf(field);
        if (seen.has(field) || order < previousOrder) return null;
        seen.add(field);
        previousOrder = order;
      }

      if (line.startsWith("URI: ")) {
        uri = line.slice("URI: ".length);
      } else if (line.startsWith("Version: ")) {
        const value = line.slice("Version: ".length);
        if (!/^1$/.test(value)) return null;
        version = SIWX_VERSION;
      } else if (line.startsWith("Chain ID: ")) {
        chainId = line.slice("Chain ID: ".length);
      } else if (line.startsWith("Nonce: ")) {
        nonce = line.slice("Nonce: ".length);
      } else if (line.startsWith("Issued At: ")) {
        issuedAt = line.slice("Issued At: ".length);
      } else if (line.startsWith("Expiration Time: ")) {
        expirationTime = line.slice("Expiration Time: ".length);
      } else if (line.startsWith("Not Before: ")) {
        notBefore = line.slice("Not Before: ".length);
      } else if (line.startsWith("Request ID: ")) {
        requestId = line.slice("Request ID: ".length);
      } else if (line === "Resources:") {
        inResources = true;
      } else if (inResources && line.startsWith("- ")) {
        resources.push(line.slice(2));
      } else {
        // Unknown field-like lines would otherwise be omitted from the
        // signed data model while still being shown to a user.
        return null;
      }
    }

    // Validate required fields
    if (
      !isValidDomain(domain) ||
      !address ||
      !uri ||
      !isValidUri(uri) ||
      version !== SIWX_VERSION ||
      !CAIP2_PATTERN.test(chainId) ||
      (chainId.startsWith("eip155:") &&
        !/^eip155:[1-9][0-9]*$/.test(chainId)) ||
      (chainId.startsWith("eip155:") && !/^0x[0-9a-fA-F]{40}$/.test(address)) ||
      !/^[A-Za-z0-9]{8,}$/.test(nonce) ||
      !issuedAt ||
      !isValidRfc3339(issuedAt) ||
      (statement !== null && hasInvalidStatementCharacter(statement)) ||
      (expirationTime !== null && !isValidRfc3339(expirationTime)) ||
      (notBefore !== null && !isValidRfc3339(notBefore)) ||
      (requestId !== null && !REQUEST_ID_PATTERN.test(requestId)) ||
      resources.some((resource) => !isValidUri(resource))
    ) {
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

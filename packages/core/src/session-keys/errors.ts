/**
 * Session Key Error Codes
 */

import { WalletError } from "../errors";

export type SessionKeyErrorCode =
  | "session_key_not_found"
  | "session_key_expired"
  | "session_key_revoked"
  | "session_key_scope_exceeded"
  | "session_key_method_forbidden"
  | "session_key_contract_not_allowed"
  | "session_key_chain_not_allowed"
  | "session_key_storage_unavailable"
  | "session_key_encryption_failed"
  | "session_key_required_fields_missing"
  | "session_key_max_tx_count_exceeded"
  | "session_key_value_limit_exceeded"
  | "session_key_gas_limit_exceeded"
  | "session_key_invalid_input";

export const SESSION_KEY_ERROR_MESSAGES: Record<SessionKeyErrorCode, string> = {
  session_key_not_found:
    "Session key not found. Check the session ID or create a new one.",
  session_key_expired:
    "Session key has expired. Please create a new session key.",
  session_key_revoked:
    "Session key has been revoked. Please create a new session key.",
  session_key_scope_exceeded:
    "Transaction exceeds the session key's permitted scope.",
  session_key_method_forbidden:
    "The requested method is forbidden for session keys.",
  session_key_contract_not_allowed:
    "The target contract is not in the session key's allowed list.",
  session_key_chain_not_allowed:
    "The target chain is not in the session key's allowed list.",
  session_key_storage_unavailable:
    "Session key storage is not available in this environment.",
  session_key_encryption_failed: "Failed to encrypt/decrypt session key data.",
  session_key_required_fields_missing:
    "Required session key fields are missing.",
  session_key_max_tx_count_exceeded:
    "Maximum transaction count for this session key has been reached.",
  session_key_value_limit_exceeded:
    "Transaction value exceeds the session key's remaining allowance.",
  session_key_gas_limit_exceeded:
    "Gas limit exceeds the session key's allowance.",
  session_key_invalid_input: "Session key signing input is invalid.",
};

const DISPLAY_DETAIL_MAX_CODE_POINTS = 200;

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function getDisplayDetail(details: unknown): string | undefined {
  if (typeof details !== "string") return undefined;

  const withoutControls = Array.from(details, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      isBidiControl(codePoint)
      ? " "
      : character;
  }).join("");
  const cleaned = withoutControls.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;

  const codePoints = Array.from(cleaned);
  if (codePoints.length > DISPLAY_DETAIL_MAX_CODE_POINTS) {
    return `${codePoints.slice(0, DISPLAY_DETAIL_MAX_CODE_POINTS).join("")}…`;
  }

  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

/**
 * Create a WalletError with a session-key-specific error code.
 */
export function createSessionKeyError(
  code: SessionKeyErrorCode,
  details?: unknown,
): WalletError {
  const displayDetail = getDisplayDetail(details);
  const message = displayDetail
    ? `${SESSION_KEY_ERROR_MESSAGES[code]} ${displayDetail}`
    : SESSION_KEY_ERROR_MESSAGES[code];

  return new WalletError(code as unknown as any, message, details);
}

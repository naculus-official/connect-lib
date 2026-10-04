// Example for docs/guides/upgrading-to-0.10.md (action needed). Typechecked by
// the root `tsc --noEmit`; not shipped in any package.
import { isWalletError, type SessionKeyManager } from "@naculus/connect-core";

/**
 * Since 0.10.0, preparing the delegation of a hand-built `eip7702` scope that
 * sets `tokenMaxPerTx` (or several token allowances, or a period limit for
 * another token) throws instead of returning a looser delegation.
 */
export async function prepareOrExplain(
  keys: SessionKeyManager,
  keyId: string,
  chainId: number,
) {
  try {
    return await keys.prepareDelegation(keyId, chainId);
  } catch (error) {
    // `WalletError.code` is typed without the session-key codes, hence the
    // widening to string.
    if (
      isWalletError(error) &&
      (error.code as string) === "session_key_invalid_input"
    ) {
      // error.message is generic; the reason is in error.details, e.g.
      // "Cannot express this scope as an EIP-7702 delegation:
      //  tokenMaxPerTx has no on-chain caveat yet"
      console.warn(error.details);
    }
    throw error;
  }
}

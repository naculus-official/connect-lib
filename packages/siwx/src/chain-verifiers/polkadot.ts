import type { SignInVerificationInput } from "./types";

export async function verifyPolkadotSignInMessage(
  input: SignInVerificationInput,
): Promise<boolean> {
  try {
    // signatureVerify lives in @polkadot/util-crypto, not @polkadot/keyring —
    // keyring re-exports decodeAddress but not signatureVerify, so importing
    // both from keyring left this verifier calling undefined.
    const { decodeAddress, signatureVerify } = await import(
      "@polkadot/util-crypto"
    );
    const publicKey = decodeAddress(input.address);
    const result = signatureVerify(input.message, input.signature, publicKey);
    return result.isValid;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      throw new Error(
        "@polkadot/util-crypto is required for Polkadot SIWx verification. " +
          "Install it via: pnpm add @polkadot/util-crypto",
      );
    }
    console.warn("polkadot SIWx verification failed:", err);
    return false;
  }
}

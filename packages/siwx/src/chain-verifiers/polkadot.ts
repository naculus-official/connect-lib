export async function verifyPolkadotSignInMessage(input: {
  address: string;
  message: string;
  signature: string;
  chainId?: string;
}): Promise<boolean> {
  try {
    const { decodeAddress, signatureVerify } = await import(
      // @ts-ignore — @polkadot/keyring is optional; caught at runtime
      "@polkadot/keyring"
    );
    const publicKey = decodeAddress(input.address);
    const result = signatureVerify(input.message, input.signature, publicKey);
    return result.isValid;
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      throw new Error(
        "@polkadot/keyring is required for Polkadot SIWx verification. " +
          "Install it via: pnpm add @polkadot/keyring",
      );
    }
    console.warn("polkadot SIWx verification failed:", err);
    return false;
  }
}

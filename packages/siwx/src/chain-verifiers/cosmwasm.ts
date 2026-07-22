export async function verifyCosmwasmSignInMessage(input: {
  address: string;
  message: string;
  signature: string;
  chainId?: string;
}): Promise<boolean> {
  try {
    // @ts-expect-error — @cosmjs/amino is optional; caught at runtime
    const { verifyArbitrary } = await import("@cosmjs/amino");
    return await verifyArbitrary(input.address, {
      data: new TextEncoder().encode(input.message),
      signature: {
        type: "amino_secp256k1",
        signature: Buffer.from(input.signature, "base64"),
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      throw new Error(
        "@cosmjs/amino is required for Cosmwasm SIWx verification. " +
          "Install it via: pnpm add @cosmjs/amino",
      );
    }
    console.warn("cosmwasm SIWx verification failed:", err);
    return false;
  }
}

export async function verifyStarknetSignInMessage(input: {
  address: string;
  message: string;
  signature: string;
  chainId?: string;
}): Promise<boolean> {
  try {
    // @ts-expect-error — starknet is optional; caught at runtime
    const { verifyMessage } = await import("starknet");
    return await verifyMessage(input.message, input.signature, input.address);
  } catch (err) {
    if (err instanceof Error && err.message.includes("Cannot find module")) {
      throw new Error(
        "starknet package is required for Starknet SIWx verification. " +
          "Install it via: pnpm add starknet",
      );
    }
    console.warn("starknet SIWx verification failed:", err);
    return false;
  }
}

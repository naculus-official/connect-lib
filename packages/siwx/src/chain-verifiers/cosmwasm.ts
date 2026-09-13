import type { SignInVerificationInput } from "./types";

function decodeBase64(value: string): Uint8Array {
  if (typeof atob !== "function") {
    throw new Error("Cosmwasm SIWx verification requires a base64 decoder");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function verifyCosmwasmSignInMessage(
  input: SignInVerificationInput,
): Promise<boolean> {
  try {
    // @ts-expect-error — @cosmjs/amino is optional; caught at runtime
    const { verifyArbitrary } = await import("@cosmjs/amino");
    return await verifyArbitrary(input.address, {
      data: new TextEncoder().encode(input.message),
      signature: {
        type: "amino_secp256k1",
        signature: decodeBase64(input.signature),
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

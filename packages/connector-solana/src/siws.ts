import { createSiwxMessage, parseSiwxMessage } from "@naculus/siwx";

export interface SolanaSiwsInput {
  domain: string;
  address: string;
  uri: string;
  version?: string;
  chainId?: string;
  nonce?: string;
  statement?: string;
  expirationTime?: string;
  notBefore?: string;
  resources?: string[];
}

export interface SolanaSiwsMessage {
  domain: string;
  address: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  statement?: string;
  expirationTime?: string;
  notBefore?: string;
  resources?: string[];
}

export function createSolanaSiwsMessage(input: SolanaSiwsInput): string {
  const chainId = input.chainId ?? "1";
  const version = input.version ? parseInt(input.version, 10) : 1;

  return createSiwxMessage({
    domain: input.domain,
    address: input.address,
    uri: input.uri,
    version,
    chainId,
    nonce: input.nonce ?? generateNonce(),
    statement: input.statement,
    expirationTime: input.expirationTime,
    notBefore: input.notBefore,
    resources: input.resources,
  });
}

export async function verifySolanaSiwsMessage(
  message: string,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const parsed = parseSiwxMessage(message);
  if (!parsed) return false;

  const messageBytes = new TextEncoder().encode(message);
  return verifySignature(messageBytes, signature, publicKey);
}

export async function verifySignature(
  message: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  try {
    const nacl = await import("tweetnacl");
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    console.warn(
      "tweetnacl is required for Solana SIWS verification. Install: pnpm add tweetnacl",
    );
    return false;
  }
}

function generateNonce(): string {
  const array = new Uint8Array(12);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export function encodeSiwsMessage(message: SolanaSiwsMessage): string {
  return createSolanaSiwsMessage({
    domain: message.domain,
    address: message.address,
    uri: message.uri,
    version: message.version,
    chainId: message.chainId,
    nonce: message.nonce,
    statement: message.statement,
    expirationTime: message.expirationTime,
    notBefore: message.notBefore,
    resources: message.resources,
  });
}

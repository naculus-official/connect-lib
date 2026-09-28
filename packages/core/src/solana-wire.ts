import { concatBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";
import { WalletError } from "./errors";

/**
 * Solana wire helpers shared by solana-payment.ts and solana-channel.ts.
 * Internal: not re-exported from the package barrel.
 */

function fail(message: string): never {
  throw new WalletError("invalid_input", message);
}

export function key(address: string, what: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(address);
  } catch {
    fail(`${what} is not a base58 address.`);
  }
  if (bytes.length !== 32) fail(`${what} is not a 32-byte address.`);
  return bytes;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export function shortVec(n: number): Uint8Array {
  const out: number[] = [];
  let rest = n;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    if (rest === 0) {
      out.push(byte);
      return new Uint8Array(out);
    }
    out.push(byte | 0x80);
  }
}

export interface Meta {
  address: string;
  signer: boolean;
  writable: boolean;
}

/** Compile a v0 transaction with `feePayer` first and no lookup tables. */
export function compileV0(
  feePayer: string,
  instructions: { program: string; accounts: Meta[]; data: Uint8Array }[],
  recentBlockhash: string,
): Uint8Array {
  const metas = new Map<string, Meta>();
  const add = (m: Meta) => {
    const seen = metas.get(m.address);
    metas.set(m.address, {
      address: m.address,
      signer: m.signer || (seen?.signer ?? false),
      writable: m.writable || (seen?.writable ?? false),
    });
  };
  add({ address: feePayer, signer: true, writable: true });
  for (const ix of instructions) {
    for (const a of ix.accounts) add(a);
    add({ address: ix.program, signer: false, writable: false });
  }
  const all = [...metas.values()];
  const group = (signer: boolean, writable: boolean) =>
    all.filter((m) => m.signer === signer && m.writable === writable);
  const ordered = [
    ...group(true, true),
    ...group(true, false),
    ...group(false, true),
    ...group(false, false),
  ].map((m) => m.address);
  const signers = group(true, true).length + group(true, false).length;
  const index = (a: string) => ordered.indexOf(a);
  const message = concatBytes(
    new Uint8Array([
      0x80,
      signers,
      group(true, false).length,
      group(false, false).length,
    ]),
    shortVec(ordered.length),
    ...ordered.map((k) => key(k, "account")),
    key(recentBlockhash, "recentBlockhash"),
    shortVec(instructions.length),
    ...instructions.map((ix) =>
      concatBytes(
        new Uint8Array([index(ix.program)]),
        shortVec(ix.accounts.length),
        new Uint8Array(ix.accounts.map((a) => index(a.address))),
        shortVec(ix.data.length),
        ix.data,
      ),
    ),
    shortVec(0),
  );
  return concatBytes(shortVec(signers), new Uint8Array(64 * signers), message);
}

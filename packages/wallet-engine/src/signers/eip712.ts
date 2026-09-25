/**
 * EIP-712 typed-data hashing (eth_signTypedData_v4), shared by EVMSigner and
 * the crypto worker so both sign exactly the same digest.
 *
 * Moved verbatim out of EVMSigner.signTypedData; its byte output is pinned
 * by vectors from viem in evm.test.ts / eip712.test.ts. No key material and
 * no imports that would pull connect-core into the worker bundle.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";

/** The 32-byte EIP-712 digest of JSON-stringified typed data. */
export function typedDataSigningHash(typedData: string): Uint8Array {
  const data = JSON.parse(typedData) as {
    domain?: Record<string, unknown>;
    types?: Record<string, Array<{ name: string; type: string }>>;
    primaryType?: string;
    message?: Record<string, unknown>;
  };
  const domain = data.domain ?? {};
  const types = { ...(data.types ?? {}) };
  const primaryType = data.primaryType ?? "";
  const message = data.message ?? {};

  // EIP-712 requires referenced struct definitions to be appended once,
  // sorted alphabetically. A flat `Type(...)` encoding is not interoperable
  // for nested structs because it produces a different type hash.
  const encodeType = (typeName: string): string => {
    const fields = types[typeName];
    if (!fields) throw new Error(`Missing EIP-712 type: ${typeName}`);
    const dependencies = new Set<string>();
    const visit = (name: string) => {
      for (const field of types[name] ?? []) {
        const dependency = field.type.replace(/\[\]$/, "");
        if (
          types[dependency] &&
          dependency !== typeName &&
          !dependencies.has(dependency)
        ) {
          dependencies.add(dependency);
          visit(dependency);
        }
      }
    };
    visit(typeName);
    const render = (name: string) =>
      `${name}(${(types[name] ?? []).map((field) => `${field.type} ${field.name}`).join(",")})`;
    return render(typeName) + [...dependencies].sort().map(render).join("");
  };

  const typeHash = (typeName: string): Uint8Array =>
    keccak_256(new TextEncoder().encode(encodeType(typeName)));

  const abiEncode = (type: string, value: unknown): Uint8Array => {
    const arrayMatch = type.match(/^(.*)\[(\d*)\]$/);
    if (arrayMatch) {
      if (!Array.isArray(value)) throw new Error(`Expected array for ${type}`);
      if (arrayMatch[2] && value.length !== Number(arrayMatch[2])) {
        throw new Error(`Invalid array length for ${type}`);
      }
      return keccak_256(
        concatBytesArray(value.map((item) => abiEncode(arrayMatch[1], item))),
      );
    }
    if (types[type])
      return hashStruct(type, (value ?? {}) as Record<string, unknown>);
    if (type === "address") {
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error("Invalid EIP-712 address");
      }
      return hexToFixedBytes(value, 32, "right");
    }
    if (type.startsWith("uint") || type.startsWith("int")) {
      const bits = Number(type.slice(type.startsWith("uint") ? 4 : 3) || 256);
      if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0) {
        throw new Error(`Invalid EIP-712 integer type: ${type}`);
      }
      if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error(
          "EIP-712 integer numbers must be safe integers; use a string or bigint for larger values",
        );
      }
      const n = BigInt(value as string | number | bigint);
      const limit = 1n << BigInt(bits);
      if (type.startsWith("uint") && (n < 0n || n >= limit))
        throw new Error(`uint overflow: ${type}`);
      if (type.startsWith("int") && (n < -(limit >> 1n) || n >= limit >> 1n))
        throw new Error(`int overflow: ${type}`);
      // ABI encodes every signed integer as a 256-bit two's complement word
      // (sign-extended), whatever N is; using 2^N here signed a digest no
      // verifier computes for a negative intN < int256.
      const encoded = type.startsWith("int") && n < 0n ? (1n << 256n) + n : n;
      return bigintWordBytes(encoded);
    }
    if (type === "bool") {
      if (typeof value !== "boolean") throw new Error("Invalid EIP-712 bool");
      return bigintWordBytes(value ? 1n : 0n);
    }
    if (type === "string") {
      if (typeof value !== "string") throw new Error("Invalid EIP-712 string");
      return keccak_256(new TextEncoder().encode(value));
    }
    if (type === "bytes") {
      if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value))
        throw new Error("Invalid EIP-712 bytes");
      return keccak_256(hexToBytesStrict(value));
    }
    const fixedBytes = type.match(/^bytes([1-9]|[12][0-9]|3[0-2])$/);
    if (fixedBytes) {
      if (
        typeof value !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2})*$/.test(value) ||
        (value.length - 2) / 2 !== Number(fixedBytes[1])
      ) {
        throw new Error(`Invalid ${type}`);
      }
      return hexToFixedBytes(value, 32, "left");
    }
    throw new Error(`Unsupported EIP-712 type: ${type}`);
  };

  const hashStruct = (
    typeName: string,
    values: Record<string, unknown>,
  ): Uint8Array => {
    const fields = types[typeName];
    if (!fields) throw new Error(`Missing EIP-712 type: ${typeName}`);
    for (const field of fields) {
      if (!(field.name in values)) {
        throw new Error(`Missing EIP-712 field: ${typeName}.${field.name}`);
      }
    }
    return keccak_256(
      concatBytesArray([
        typeHash(typeName),
        ...fields.map((field) => abiEncode(field.type, values[field.name])),
      ]),
    );
  };

  // Most eth_signTypedData_v4 callers include EIP712Domain in `types`; for
  // clients that omit it, infer the canonical field order from the domain.
  if (!types.EIP712Domain) {
    const domainOrder = [
      "name",
      "version",
      "chainId",
      "verifyingContract",
      "salt",
    ];
    types.EIP712Domain = domainOrder
      .filter((name) => name in domain)
      .map((name) => ({
        name,
        type:
          name === "name" || name === "version"
            ? "string"
            : name === "chainId"
              ? "uint256"
              : name === "verifyingContract"
                ? "address"
                : "bytes32",
      }));
  }
  if (!primaryType || !types[primaryType])
    throw new Error("Missing EIP-712 primaryType");

  const domainHash = hashStruct("EIP712Domain", domain);
  const messageHash = hashStruct(primaryType, message);
  const prefix = new TextEncoder().encode("\x19\x01");
  const digest = keccak_256(
    concatBytesArray([prefix, domainHash, messageHash]),
  );
  return digest;
}

// ── EIP-712 helpers ────────────────────────────────────────────

function hexToFixedBytes(
  hex: string,
  targetLen: number,
  alignment: "left" | "right" = "right",
): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const padded =
    alignment === "left"
      ? clean.padEnd(targetLen * 2, "0").slice(0, targetLen * 2)
      : clean.padStart(targetLen * 2, "0").slice(-targetLen * 2);
  const bytes = new Uint8Array(targetLen);
  for (let i = 0; i < targetLen; i++)
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bigintWordBytes(value: bigint): Uint8Array {
  if (value < 0n || value >= 1n << 256n)
    throw new Error("EIP-712 integer exceeds 256 bits");
  return hexToFixedBytes(value.toString(16), 32);
}

function hexToBytesStrict(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2)
    bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  return bytes;
}

function concatBytesArray(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}

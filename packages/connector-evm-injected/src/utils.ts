export function toHexValue(value: string): string {
  if (/^0x[0-9a-fA-F]+$/.test(value)) {
    return `0x${BigInt(value).toString(16)}`;
  }
  if (/^\d+$/.test(value)) return `0x${BigInt(value).toString(16)}`;
  throw new Error(`Invalid EIP-1474 quantity: ${value}`);
}

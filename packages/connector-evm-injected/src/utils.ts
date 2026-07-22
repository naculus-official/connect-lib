export function toHexValue(value: string): string {
  if (value.startsWith("0x")) return value;
  return `0x${BigInt(value).toString(16)}`;
}

/** Custom error class for wallet operations */
export class WalletError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

// wagmi stub for tests
// wagmi is an optional peer dep — this stub provides minimal exports for test
export class ChainNotConfiguredError extends Error {
  name = "ChainNotConfiguredError";
}

export class SwitchChainError extends Error {
  name = "SwitchChainError";
  constructor(cause) {
    super("Switch chain error", { cause });
  }
}

export class SwitchChainNotSupportedError extends Error {
  name = "SwitchChainNotSupportedError";
  constructor(cause) {
    super("Failed to switch chain.", { cause });
  }
}

export const createConnector = (fn) => fn;

// Needed by connector-wagmi import from @wagmi/core
export const Connector = class {};
export const CreateConnectorFn = class {};

/**
 * Configurable Logger
 *
 * Replaces raw `console.*` calls across the SDK with a logger that can
 * be silenced, namespaced, or have custom sinks injected.
 *
 * Usage:
 *   import { logger } from "@naculus/connect-core";
 *   logger.warn("core/session", "Failed to save", err);
 *
 * At app level:
 *   import { setLogLevel, setLogSink } from "@naculus/connect-core";
 *   setLogLevel("error");          // suppress debug/info/warn
 *   setLogSink((level, ns, args) => myLogger(level, ns, args));
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 999,
};

let currentLevel: LogLevel = "warn";
let currentSink:
  | ((level: LogLevel, ns: string, ...args: unknown[]) => void)
  | null = null;

/** Set the minimum log level. Messages below this threshold are suppressed. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Replace the default console-based sink with a custom handler. */
export function setLogSink(
  sink: ((level: LogLevel, ns: string, ...args: unknown[]) => void) | null,
): void {
  currentSink = sink;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function log(level: LogLevel, ns: string, ...args: unknown[]): void {
  if (!shouldLog(level)) return;

  if (currentSink) {
    currentSink(level, ns, ...args);
    return;
  }

  const prefix = `[${ns}]`;
  switch (level) {
    case "debug":
      console.debug(prefix, ...args);
      break;
    case "info":
      console.info(prefix, ...args);
      break;
    case "warn":
      console.warn(prefix, ...args);
      break;
    case "error":
      console.error(prefix, ...args);
      break;
  }
}

/** Namespace-bound convenience wrapper returned by `logger.for(ns)`. */
export interface LoggerNamespace {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function createNamespace(ns: string): LoggerNamespace {
  return {
    debug: (...args: unknown[]) => log("debug", ns, ...args),
    info: (...args: unknown[]) => log("info", ns, ...args),
    warn: (...args: unknown[]) => log("warn", ns, ...args),
    error: (...args: unknown[]) => log("error", ns, ...args),
  };
}

/**
 * Global logger object.
 *   logger.warn("my-ns", "message", err);
 *   const l = logger.for("my-ns"); l.warn("message", err);
 */
export const logger = {
  debug: (ns: string, ...args: unknown[]) => log("debug", ns, ...args),
  info: (ns: string, ...args: unknown[]) => log("info", ns, ...args),
  warn: (ns: string, ...args: unknown[]) => log("warn", ns, ...args),
  error: (ns: string, ...args: unknown[]) => log("error", ns, ...args),
  for: createNamespace,
  setLogLevel,
  setLogSink,
  /** Current effective level (for tests / introspection). */
  getLogLevel: () => currentLevel,
};

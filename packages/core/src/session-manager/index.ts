/**
 * Session Manager Module
 *
 * Unified multi-chain session management.
 *
 * @see SRS-009
 */

export type { SessionErrorCode } from "./errors";
export { createSessionError, SESSION_ERROR_MESSAGES } from "./errors";
export type {
  SessionEvent,
  SessionEventHandler,
  SessionEventPayloads,
} from "./events";

export { SessionEventEmitter } from "./events";
export { createSessionPersistence, SessionPersistence } from "./persistence";
export { createSessionManager, SessionManager } from "./session-manager";
export type {
  ActiveSessionBundle,
  ChainSession,
  PersistedSessionData,
  RefreshFeesOptions,
  SessionManagerConfig,
  UserFeeOverrides,
} from "./types";
export {
  parseChainId,
  validateChainId,
} from "./types";

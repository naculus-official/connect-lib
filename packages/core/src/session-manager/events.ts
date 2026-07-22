/**
 * Event system for SessionManager
 *
 * Provides a typed event emitter that dispatches session lifecycle events
 * for consumption by React hooks and UI layers.
 *
 * @see SRS-009 §7
 */

import type { FeeValues } from "../fee-estimation";
import type { ActiveSessionBundle, ChainSession } from "./types";

// ─── Event Types ───────────────────────────────────────────────────────

export type SessionEvent =
  | "sessionConnected"
  | "sessionDisconnected"
  | "chainChanged"
  | "chainSessionAdded"
  | "chainSessionRemoved"
  | "feesUpdated"
  | "accountsChanged";

export interface SessionEventPayloads {
  sessionConnected: { bundle: ActiveSessionBundle };
  sessionDisconnected: { connectorId: string; topic?: string };
  chainChanged: {
    bundle: ActiveSessionBundle;
    previousChainId: string;
    newChainId: string;
  };
  chainSessionAdded: {
    bundle: ActiveSessionBundle;
    chainSession: ChainSession;
  };
  chainSessionRemoved: {
    bundle: ActiveSessionBundle;
    chainId: string;
  };
  feesUpdated: {
    chainId: string;
    fees: FeeValues;
  };
  accountsChanged: {
    bundle: ActiveSessionBundle;
    accounts: string[];
  };
}

export type SessionEventHandler<E extends SessionEvent = SessionEvent> = (
  payload: SessionEventPayloads[E],
) => void;

// ─── Event Emitter ─────────────────────────────────────────────────────

export class SessionEventEmitter {
  private listeners: Map<SessionEvent, Set<SessionEventHandler>> = new Map();

  /**
   * Register an event handler.
   */
  on<E extends SessionEvent>(event: E, handler: SessionEventHandler<E>): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler as SessionEventHandler);
  }

  /**
   * Remove a previously registered event handler.
   */
  off<E extends SessionEvent>(event: E, handler: SessionEventHandler<E>): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler as SessionEventHandler);
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Remove all handlers for a specific event.
   */
  removeAllListeners(event?: SessionEvent): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Emit an event to all registered handlers.
   * Errors in handlers are caught and logged to prevent cascading failures.
   */
  protected emit<E extends SessionEvent>(
    event: E,
    payload: SessionEventPayloads[E],
  ): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        handler(payload as SessionEventPayloads[SessionEvent]);
      } catch (error) {
        console.error(
          `[SessionEventEmitter] Error in handler for "${event}":`,
          error,
        );
      }
    }
  }
}

/**
 * Auto-Reconnect Manager
 *
 * Handles automatic reconnection to previously connected wallets
 * with configurable retry strategies.
 */

import type { UniversalWalletSession } from "./session";

export interface AutoReconnectConfig {
  enabled: boolean;
  maxRetries: number;
  retryDelay: number;
  onReconnecting?: () => void;
  onReconnected?: () => void;
  onFailed?: (error: Error) => void;
}

interface ReconnectState<T = UniversalWalletSession> {
  lastSession: T | null;
  retryCount: number;
  isReconnecting: boolean;
}

export class AutoReconnectManager<T = UniversalWalletSession> {
  private config: AutoReconnectConfig;
  private state: ReconnectState<T> = {
    lastSession: null,
    retryCount: 0,
    isReconnecting: false,
  };
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<AutoReconnectConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      maxRetries: config.maxRetries ?? 3,
      retryDelay: config.retryDelay ?? 2000,
      onReconnecting: config.onReconnecting,
      onReconnected: config.onReconnected,
      onFailed: config.onFailed,
    };
  }

  setLastSession(session: T): void {
    this.state.lastSession = session;
    this.state.retryCount = 0;
  }

  getState(): ReconnectState<T> {
    return {
      lastSession: this.state.lastSession,
      retryCount: this.state.retryCount,
      isReconnecting: this.state.isReconnecting,
    };
  }

  needsReconnect(): boolean {
    return this.config.enabled && this.state.lastSession !== null;
  }

  async reconnect(
    reconnectFn: (session: T) => Promise<unknown>,
  ): Promise<boolean> {
    if (!this.config.enabled || !this.state.lastSession) {
      return false;
    }

    if (this.state.isReconnecting) {
      return false;
    }

    this.state.isReconnecting = true;
    this.config.onReconnecting?.();

    try {
      await reconnectFn(this.state.lastSession);
      this.state.isReconnecting = false;
      this.state.retryCount = 0;
      this.config.onReconnected?.();
      return true;
    } catch (error) {
      this.state.isReconnecting = false;
      return this.handleReconnectError(error as Error, reconnectFn);
    }
  }

  private async handleReconnectError(
    error: Error,
    reconnectFn: (session: T) => Promise<unknown>,
  ): Promise<boolean> {
    if (this.state.retryCount >= this.config.maxRetries) {
      this.config.onFailed?.(error);
      this.clearSession();
      return false;
    }

    this.state.retryCount++;

    const delay = Math.min(
      this.config.retryDelay * this.state.retryCount,
      2147483647,
    );

    return new Promise<boolean>((resolve) => {
      this.retryTimeout = setTimeout(async () => {
        try {
          const success = await this.reconnect(reconnectFn);
          resolve(success);
        } catch {
          resolve(false);
        }
      }, delay);
    });
  }

  cancel(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    this.state.isReconnecting = false;
  }

  clearSession(): void {
    this.state.lastSession = null;
    this.state.retryCount = 0;
    this.state.isReconnecting = false;
    this.cancel();
  }

  updateConfig(config: Partial<AutoReconnectConfig>): void {
    this.config = { ...this.config, ...config };
  }

  reset(): void {
    this.clearSession();
    this.config.onFailed = undefined;
    this.config.onReconnected = undefined;
    this.config.onReconnecting = undefined;
  }
}

export function createAutoReconnectManager<T = UniversalWalletSession>(
  config?: Partial<AutoReconnectConfig>,
): AutoReconnectManager<T> {
  return new AutoReconnectManager<T>(config);
}

import type { ProviderInterface } from "@coinbase/wallet-sdk";

/**
 * Adapter that bridges the Coinbase wallet-sdk ProviderInterface
 * (EIP-1193 compatible) to Naculus's internal EIP-6963 provider type.
 *
 * Handles provider event subscriptions and cleanup so the connector
 * can react to accountsChanged, chainChanged, and disconnect events
 * without leaking listeners.
 */
export class CoinbaseProviderAdapter {
  private readonly rawProvider: ProviderInterface;
  private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  constructor(provider: ProviderInterface) {
    this.rawProvider = provider;
  }

  /**
   * Get the underlying provider instance.
   */
  getProvider(): ProviderInterface {
    return this.rawProvider;
  }

  /**
   * Subscribe to a provider event.
   * Avoids duplicate handler registration for the same event+handler pair.
   */
  on(event: string, handler: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event);
    if (!existing) {
      const set = new Set<(...args: unknown[]) => void>();
      set.add(handler);
      this.listeners.set(event, set);
      this.rawProvider.on(event as any, handler as any);
    } else if (!existing.has(handler)) {
      existing.add(handler);
      this.rawProvider.on(event as any, handler as any);
    }
  }

  /**
   * Unsubscribe from a provider event.
   */
  off(event: string, handler: (...args: unknown[]) => void): void {
    const existing = this.listeners.get(event);
    if (existing) {
      existing.delete(handler);
      this.rawProvider.off(event as any, handler as any);
      if (existing.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  /**
   * Remove all event listeners registered through this adapter.
   */
  removeAllListeners(): void {
    for (const [event, handlers] of this.listeners.entries()) {
      for (const handler of handlers) {
        this.rawProvider.off(event as any, handler as any);
      }
    }
    this.listeners.clear();
  }

  /**
   * Clean up all subscriptions and prepare for garbage collection.
   */
  cleanup(): void {
    this.removeAllListeners();
  }
}

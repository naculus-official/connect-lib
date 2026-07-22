/**
 * Shared Types
 *
 * Common type definitions shared across connect-lib modules.
 * Kept minimal to avoid coupling between independent sub-modules.
 */

/**
 * Configuration for services that require an API key.
 * Used by route providers (LiFi), paymaster services, and bundler clients.
 */
export interface ApiKeyConfig {
  /** Optional API key for authenticated service access */
  apiKey?: string;
}

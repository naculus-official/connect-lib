/**
 * @naculus/connect — convenience umbrella package
 *
 * No need to install packages individually. This package lists the supported
 * @naculus/* packages as dependencies, re-exports the core API, and exposes
 * each connector behind a collision-free namespace:
 *
 * ```sh
 * npm install @naculus/connect
 * ```
 *
 * Equivalent to installing all of the following:
 * - @naculus/connect-core
 * - @naculus/connector-walletconnect
 * - @naculus/connector-evm-injected
 * - @naculus/connector-embedded
 * - @naculus/connector-passkeys
 * - @naculus/connector-solana
 * - @naculus/connector-xrpl
 * - @naculus/siwx
 * - @naculus/wallet-engine
 */
export * from "@naculus/connect-core";

export * as coinbase from "@naculus/connector-coinbase";
export * as embedded from "@naculus/connector-embedded";
export * as evmInjected from "@naculus/connector-evm-injected";
export * as passkeys from "@naculus/connector-passkeys";
export * as safe from "@naculus/connector-safe";
export * as solana from "@naculus/connector-solana";
export * as walletConnect from "@naculus/connector-walletconnect";
export * as xrpl from "@naculus/connector-xrpl";
export * as siwx from "@naculus/siwx";
export * as walletEngine from "@naculus/wallet-engine";

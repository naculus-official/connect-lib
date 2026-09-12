---
"@naculus/wallet-engine": minor
---

Finish removing the third-party simulation provider, and stop hardcoding provider preference.

The earlier removal only cleaned `connect-core`. `wallet-engine` still declared `"blowfish"` in `SimulationProviderName`, still advertised a `blowfishApiKey` config field a consumer could set and never benefit from, and still had a routing branch preferring a provider by that name. The generated API report also still described a `BlowfishProvider` class and a `setBlowfishApiKey` method that no longer exist; it has been regenerated.

That routing branch turned out not to be dead code: it was the only way a consumer-registered provider could win in `"auto"` mode, so removing it regressed custom providers — caught by the existing tests. Auto mode now prefers any registered provider that is available and is not the built-in `eth_call` fallback, which keeps the capability without the SDK naming who supplies it.

`BalanceChange.tokenDecimals` is now `number | undefined`, matching the copy in `connect-core`. The two had drifted: one side admitted the precision may be unknown while the other guaranteed a number, so the same value was optional on one half of the workspace and required on the other. A caller that cannot tell "unknown" from a real value has no choice but to guess, and guessing 18 for a 6-decimal token understates an amount by a factor of a trillion.

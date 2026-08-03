# Architecture Decisions

## Why NO social login
Social login (Google/Facebook) puts recovery on a centralized platform.
Banking-grade auth is the standard for SenderPay — passkeys + biometric
(FaceID/TouchID) without third-party custody.

## Why NO gas sponsorship in connect-lib
Gas policy is business logic. SenderPay knows when and how much gas a
user needs. connect-lib only signs meta-transactions via wallet-engine.
Relay integration (Gelato/EIP-2771) lives in SenderPay, not here.

## Why server-side auth IS in connect-lib
CAIP-122 (SIWx) is a chain-native auth standard. No server-specific
assumptions — works with any backend that accepts SIWx messages.
@senderpay/backend implements the JWT/session layer.

## Why NO embedded MFA/email recovery
Non-custodial wallets don't need company-managed recovery. BIP39 seed
phrase is the user's sovereignty. Emergency recovery via passkey multi-sig
is a legal/insurance layer, not a protocol concern.

## Why multi-chain (Solana, XRPL)
The connector interface is chain-agnostic by design. Adding a new chain is
a new @naculus/connector-* package, not a core rewrite.

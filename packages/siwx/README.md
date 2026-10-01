# @naculus/siwx

Sign-In With X (CAIP-122) library for Naculus Connect — cross-chain sign-in message creation and verification. Supports Ethereum (SIWE), Solana (SIWS), and XRPL.

> **Part of [@naculus/connect](https://www.npmjs.com/package/@naculus/connect)** — install the umbrella package to get all packages at once.

## Install

```bash
npm install @naculus/siwx
# or
pnpm add @naculus/siwx
```

## Smart-account signatures

`createEVMVerifier({ call, getCode })` verifies deployed smart accounts through
ERC-1271 and counterfactual accounts through ERC-6492. The supplied `call`
must pass through an optional `to`: ERC-1271 calls include the account address,
while address-free ERC-6492 verification intentionally sends a contract-creation
`eth_call` with only `data`. Standard JSON-RPC nodes support both forms.

## License

MIT

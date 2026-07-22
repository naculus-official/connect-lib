# Wallet Support

# Table of Contents
- [Wallet Support](#wallet-support)
- [Table of Contents](#table-of-contents)
  - [EVM Wallets](#evm-wallets)
    - [MetaMask](#metamask)
    - [Coinbase Wallet](#coinbase-wallet)
    - [Rabby](#rabby)
    - [Trust Wallet](#trust-wallet)
  - [Solana Wallets](#solana-wallets)
    - [Phantom](#phantom)
    - [Solflare](#solflare)
    - [Backpack](#backpack)
  - [XRPL Wallets](#xrpl-wallets)
    - [Xaman](#xaman)
  - [Wallet Selection Flow](#wallet-selection-flow)

## EVM Wallets

### MetaMask

| Feature | Support |
|---------|----------|
| EIP-6963 | ✅ |
| Deep Link | ✅ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (EIP-6963)
- WalletConnect QR Code
- Mobile Deep Link (`metamask://`)

**Documentation:** [MetaMask Docs](https://docs.metamask.io/)

---

### Coinbase Wallet

| Feature | Support |
|---------|----------|
| EIP-6963 | ✅ |
| Deep Link | ✅ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (EIP-6963)
- SDK (`@coinbase/wallet-sdk`)
- WalletConnect QR Code
- Mobile Deep Link (`cbwallet://`)

**Documentation:** [Coinbase Wallet SDK](https://docs.cdp.coinbase.com/wallet-sdk/)

---

### Rabby

| Feature | Support |
|---------|----------|
| EIP-6963 | ✅ |
| Deep Link | ❌ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (EIP-6963)
- WalletConnect QR Code

**Documentation:** [Rabby Integration](https://rabby.io/docs/integrating-rabby-wallet)

---

### Trust Wallet

| Feature | Support |
|---------|----------|
| EIP-6963 | ✅ |
| Deep Link | ✅ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (EIP-6963)
- WalletConnect QR Code
- Mobile Deep Link (`trust://`)

**Documentation:** [Trust Wallet Dev](https://developer.trustwallet.com/)

---

## Solana Wallets

### Phantom

| Feature | Support |
|---------|----------|
| Provider Injection | ✅ |
| Deep Link | ✅ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (`window.phantom.solana`)
- WalletConnect QR Code
- Mobile Deep Link

**Documentation:** [Phantom Docs](https://docs.phantom.com/solana/integrating-phantom)

---

### Solflare

| Feature | Support |
|---------|----------|
| Provider Injection | ✅ |
| Deep Link | ✅ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (`window.solflare`)
- SDK
- WalletConnect QR Code
- Mobile Deep Link

**Documentation:** [Solflare SDK](https://github.com/solflare-wallet/solflare-sdk)

---

### Backpack

| Feature | Support |
|---------|----------|
| Provider Injection | ✅ |
| Deep Link | ✅ |
| QR Code | Via WalletConnect |
| SIWx | ✅ |

**Connection Methods:**
- Browser Extension (`window.backpack`)
- Mobile Deep Link

**Documentation:** [Backpack](https://backpack.app/)

---

## XRPL Wallets

### Xaman

| Feature | Support |
|---------|----------|
| SDK | ✅ |
| Deep Link | ✅ |
| Sign Request | ✅ |
| SIWx | ✅ |

**Connection Methods:**
- SDK (`xumm`)
- Deep Link (`xaman://`)
- Sign Request (push transaction)

**Documentation:** [Xaman Developer Docs](https://docs.xaman.dev/)

---

## Wallet Selection Flow

```
User clicks ConnectButton
        │
        ▼
┌───────────────────┐
│  Check Platform   │
└───────────────────┘
        │
    ┌───┴───┐
    │       │
Desktop   Mobile
    │       │
    ▼       ▼
┌─────────────┐   ┌─────────────┐
│ EIP-6963    │   │ Deep Link   │
│ Detection   │   │ Available?  │
└─────────────┘   └──────┬──────┘
        │                │
        │    ┌──────────┴──────────┐
        │    │                     │
        │    ▼                     ▼
        │ ┌─────────┐      ┌─────────┐
        │ │Has Wallet│     │No Wallet│
        │ │ Extension│     │  Found  │
        │ └────┬────┘     └────┬────┘
        │      │               │
        │      │         ┌─────┴─────┐
        │      │         │           │
        │      │         ▼           ▼
        │      │   ┌──────────┐  ┌──────────┐
        │      │   │ WalletConnect │ │ Wallet  │
        │      │   │   QR Code      │ │Connect  │
        │      │   └──────────┘  └──────────┘
        │      │
        └──────┼─────────────────────────────┘
               │
               ▼
        ┌─────────────┐
        │Show Wallet  │
        │   Modal     │
        └─────────────┘
```
# EIP Standards Implementation

## Overview

This document covers the EIP standards implemented in @naculus/connect.

## Table of Contents
- [EIP Standards Implementation](#eip-standards-implementation)
  - [Overview](#overview)
  - [Table of Contents](#table-of-contents)
  - [EIP-6963: Multi-Wallet Discovery](#eip-6963-multi-wallet-discovery)
    - [Purpose](#purpose)
    - [How It Works](#how-it-works)
    - [Event Format](#event-format)
    - [Usage](#usage)
    - [Wallet Detection Flow](#wallet-detection-flow)
  - [EIP-2255: Wallet Permissions](#eip-2255-wallet-permissions)
    - [Purpose](#purpose-1)
    - [Implementation](#implementation)
  - [Sign-In with Ethereum (SIWx)](#sign-in-with-ethereum-siwx)
    - [Purpose](#purpose-2)
    - [Configuration](#configuration)
    - [Usage](#usage-1)
  - [Integration with UI](#integration-with-ui)
    - [MultiWalletSelector Component](#multiwalletselector-component)
    - [ConnectButton Enhancement](#connectbutton-enhancement)
  - [Status](#status)


## EIP-6963: Multi-Wallet Discovery

### Purpose

EIP-6963 enables automatic detection of installed Ethereum wallet extensions through a standardized event system. This eliminates the need for users to manually select wallets or rely on `window.ethereum` detection.

### How It Works

1. Wallets announce themselves via `eip6963:announceProvider` event
2. Dapps listen and collect wallet information
3. Users can select from detected wallets

### Event Format

```typescript
window.addEventListener('eip6963:announceProvider', (event: CustomEvent) => {
  const { info, provider } = event.detail
  // info: { uuid, name, icon, rdns }
  // provider: EthereumProvider
})
```

### Usage

```typescript
import { eip6963Connector, DiscoveredWallet } from '@naculus/connector-evm-injected'

eip6963Connector.startDiscovery()

const wallets = eip6963Connector.getDiscoveredWallets()

const unsubscribe = eip6963Connector.onUpdate((wallets: DiscoveredWallet[]) => {
  console.log('Available wallets:', wallets)
})
```

### Wallet Detection Flow

```
┌────────────────────────────────────────────────────────┐
│                    Browser Page                        │
├────────────────────────────────────────────────────────┤
│  1. Dispatch 'eip6963:requestProvider' event           │
│                        │                               │
│                        ▼                               │
│  ┌──────────────────────────────────────────────────┐ │
│  │  Wallet Extensions (MetaMask, Coinbase, etc.)    │ │
│  │  Listen for request → Send announceProvider     │ │
│  └──────────────────────────────────────────────────┘ │
│                        │                               │
│                        ▼                               │
│  2. collect wallet info via announceProvider event   │
│                        │                               │
│                        ▼                               │
│  3. Render wallet selection UI                        │
└────────────────────────────────────────────────────────┘
```

## EIP-2255: Wallet Permissions

### Purpose

EIP-2255 provides a standardized way to request and manage wallet permissions, giving users control over which sites can access their wallet data.

### Implementation

```typescript
// Check permissions
const permissions = await provider.request({
  method: 'wallet_getPermissions'
})

// Request permissions
const granted = await provider.request({
  method: 'wallet_requestPermissions',
  params: [{ eth_accounts: {} }]
})
```

## Sign-In with Ethereum (SIWx)

### Purpose

SIWx (CAIP-122) enables users to sign messages that verify ownership of an Ethereum account, commonly used for authentication.

### Configuration

```typescript
interface SIWxConfig {
  enabled: boolean
  triggerWhen?: {
    onFirstConnect?: boolean
    onSessionExpired?: boolean
    onPermissionRequest?: boolean
    custom?: (context) => boolean
  }
  statement?: string
  resources?: string[]
  domain?: string
  uri?: string
}
```

### Usage

```typescript
import { signSIWxMessage, verifySIWxSignature } from '@naculus/connect-core'

const message = signSIWxMessage({
  domain: window.location.hostname,
  address: account,
  statement: 'Sign in to MyApp',
  resources: ['https://myapp.com'],
  nonce: generateNonce()
})

const signature = await provider.request({
  method: 'personal_sign',
  params: [message, address]
})

const isValid = verifySIWxSignature(message, signature, address)
```

## Integration with UI

### MultiWalletSelector Component

The `MultiWalletSelector` component automatically discovers and displays EIP-6963 compliant wallets:

```tsx
import { MultiWalletSelector } from '@naculus/connect-ui'

function App() {
  const handleSelect = (wallet: DiscoveredWallet) => {
    console.log('Selected:', wallet.name)
  }

  return (
    <MultiWalletSelector
      onSelect={handleSelect}
      wallets={detectedWallets}
    />
  )
}
```

### ConnectButton Enhancement

The `ConnectButton` component now includes EIP-6963 support:

```tsx
import { ConnectButton } from '@naculus/connect-ui'

function App() {
  return <ConnectButton onConnect={() => {}} />
}
```

## Status

- [x] EIP-6963 connector package
- [x] EIP-6963 discovery hook
- [x] Multi-wallet selector UI
- [x] EIP-2255 permission system
- [x] SIWx message signing
- [x] Integration tests
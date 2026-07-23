/**
 * EVMRouteExecutor Tests
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, it, expect } from 'vitest'
import { EVMRouteExecutor, type ViemWalletClient } from '../executor/EVMRouteExecutor'
import { RouteEngineError } from '../types'
import type { Route, Token, RouteStep } from '../types'

const WETH: Token = {
  chainId: 1,
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  decimals: 18,
  symbol: 'WETH',
}

const USDC_ETH: Token = {
  chainId: 1,
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  symbol: 'USDC',
}

function createMockWalletClient(): ViemWalletClient {
  return {
    sendTransaction: async (args) => {
      return '0x' + 'a'.repeat(64)
    },
    estimateGas: async () => 100_000n,
    writeContract: async (args) => {
      return '0x' + 'b'.repeat(64)
    },
  }
}

describe('EVMRouteExecutor', () => {
  it('executes a simple swap route', async () => {
    const client = createMockWalletClient()
    const executor = new EVMRouteExecutor(client)

    const route: Route = {
      fromChain: { chainId: 1, name: 'Ethereum' },
      toChain: { chainId: 1, name: 'Ethereum' },
      inputToken: WETH,
      outputToken: USDC_ETH,
      inputAmount: 1_000_000_000_000_000_000n,
      outputAmount: 2_000_000_000n,
      totalCost: 100_000n,
      slippage: 0.5,
      steps: [{
        type: 'swap',
        fromToken: WETH,
        toToken: USDC_ETH,
        amount: 1_000_000_000_000_000_000n,
        estimatedGas: 100_000n,
        description: 'Swap WETH → USDC',
      }],
    }

    const result = await executor.executeRoute(route)
    expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/)
  })

  it('executes a bridge route', async () => {
    const client = createMockWalletClient()
    const executor = new EVMRouteExecutor(client)

    const route: Route = {
      fromChain: { chainId: 1, name: 'Ethereum' },
      toChain: { chainId: 137, name: 'Polygon' },
      inputToken: WETH,
      outputToken: WETH,
      inputAmount: 1_000_000_000_000_000_000n,
      outputAmount: 990_000_000_000_000_000n,
      totalCost: 1_000_000n,
      slippage: 0,
      steps: [{
        type: 'bridge',
        fromToken: WETH,
        toToken: WETH,
        amount: 1_000_000_000_000_000_000n,
        estimatedGas: 1_000_000n,
        description: 'Bridge WETH → Polygon via Axelar',
      }],
    }

    const result = await executor.executeRoute(route)
    expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/)
  })

  it('executes multi-step routes', async () => {
    const client = createMockWalletClient()
    const executor = new EVMRouteExecutor(client)

    const route: Route = {
      fromChain: { chainId: 1, name: 'Ethereum' },
      toChain: { chainId: 1, name: 'Ethereum' },
      inputToken: WETH,
      outputToken: USDC_ETH,
      inputAmount: 1_000_000_000_000_000_000n,
      outputAmount: 2_000_000_000n,
      totalCost: 200_000n,
      slippage: 0.5,
      steps: [
        {
          type: 'swap',
          fromToken: WETH,
          toToken: WETH,
          amount: 1_000_000_000_000_000_000n,
          estimatedGas: 100_000n,
          description: 'Wrap ETH → WETH',
        },
        {
          type: 'swap',
          fromToken: WETH,
          toToken: USDC_ETH,
          amount: 1_000_000_000_000_000_000n,
          estimatedGas: 100_000n,
          description: 'Swap WETH → USDC',
        },
      ],
    }

    const result = await executor.executeRoute(route)
    expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/)
  })

  it('throws on empty route (no steps)', async () => {
    const client = createMockWalletClient()
    const executor = new EVMRouteExecutor(client)

    const route: Route = {
      fromChain: { chainId: 1, name: 'Ethereum' },
      toChain: { chainId: 1, name: 'Ethereum' },
      inputToken: WETH,
      outputToken: USDC_ETH,
      inputAmount: 1_000_000_000_000_000_000n,
      outputAmount: 0n,
      totalCost: 0n,
      slippage: 0,
      steps: [],
    }

    await expect(executor.executeRoute(route)).rejects.toThrow(RouteEngineError)
    await expect(executor.executeRoute(route)).rejects.toMatchObject({ code: 'execution_failed' })
  })

  it('approves tokens via writeContract', async () => {
    const client = createMockWalletClient()
    const executor = new EVMRouteExecutor(client)

    const result = await executor.approveToken(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      1_000_000n,
    )

    expect(result.txHash).toMatch(/^0x[a-f0-9]{64}$/)
  })

  it('throws if writeContract is not available for approve', async () => {
    const client: ViemWalletClient = {
      sendTransaction: async () => '0x' + 'a'.repeat(64),
    }

    const executor = new EVMRouteExecutor(client)

    await expect(
      executor.approveToken(
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        1_000_000n,
      ),
    ).rejects.toThrow(RouteEngineError)
  })
})

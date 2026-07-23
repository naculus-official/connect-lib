/**
 * RouteEngine Tests
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, it, expect, beforeEach } from 'vitest'
import { RouteEngine, RouteEngineError } from '../RouteEngine'
import type { SwapProvider, BridgeProvider, RouteQuote, Route, Token } from '../types'

// ─── Mock Providers ────────────────────────────────────────────────────

const USDC_ETH: Token = {
  chainId: 1,
  address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  decimals: 6,
  symbol: 'USDC',
}

const USDC_POLY: Token = {
  chainId: 137,
  address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  decimals: 6,
  symbol: 'USDC',
}

const USDT_ETH: Token = {
  chainId: 1,
  address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  decimals: 6,
  symbol: 'USDT',
}

const WETH: Token = {
  chainId: 1,
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  decimals: 18,
  symbol: 'WETH',
}

function createMockSwapProvider(name: string, cost: bigint = 100_000n, timeMs: number = 10_000): SwapProvider {
  return {
    name,
    async estimate(params: { amount: bigint; fromToken: Token; toToken: Token }): Promise<RouteQuote> {
      return {
        totalCost: cost,
        estimatedTimeMs: timeMs,
        slippage: 0.5,
        provider: name,
        steps: [{
          type: 'swap',
          fromToken: params.fromToken,
          toToken: params.toToken,
          amount: params.amount,
          estimatedGas: cost,
          description: `Swap via ${name}`,
        }],
      }
    },
    async execute(_route: Route): Promise<{ txHash: string }> {
      return { txHash: '0x' + 'a'.repeat(64) }
    },
  }
}

function createMockBridgeProvider(name: string, cost: bigint = 1_000_000n, timeMs: number = 60_000): BridgeProvider {
  return {
    name,
    async estimate(params: {
      amount: bigint
      fromChain: { chainId: number }
      toChain: { chainId: number }
      fromToken: Token
      toToken: Token
    }): Promise<RouteQuote> {
      return {
        totalCost: cost,
        estimatedTimeMs: timeMs,
        slippage: 0,
        provider: name,
        steps: [{
          type: 'bridge',
          fromToken: params.fromToken,
          toToken: params.toToken,
          amount: params.amount,
          estimatedGas: cost,
          description: `Bridge via ${name}`,
        }],
      }
    },
    async execute(_route: Route): Promise<{ txHash: string }> {
      return { txHash: '0x' + 'b'.repeat(64) }
    },
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('RouteEngine', () => {
  let engine: RouteEngine

  beforeEach(() => {
    engine = new RouteEngine()
  })

  describe('provider registration', () => {
    it('registers and lists swap providers', () => {
      const swap = createMockSwapProvider('LiFi')
      engine.registerSwapProvider(swap)
      expect(engine.listSwapProviders()).toHaveLength(1)
      expect(engine.listSwapProviders()[0].name).toBe('LiFi')
    })

    it('registers and lists bridge providers', () => {
      const bridge = createMockBridgeProvider('Axelar')
      engine.registerBridgeProvider(bridge)
      expect(engine.listBridgeProviders()).toHaveLength(1)
      expect(engine.listBridgeProviders()[0].name).toBe('Axelar')
    })

    it('retrieves a swap provider by name', () => {
      const swap = createMockSwapProvider('LiFi')
      engine.registerSwapProvider(swap)
      expect(engine.getSwapProvider('LiFi')).toBe(swap)
      expect(engine.getSwapProvider('Unknown')).toBeUndefined()
    })

    it('retrieves a bridge provider by name', () => {
      const bridge = createMockBridgeProvider('Axelar')
      engine.registerBridgeProvider(bridge)
      expect(engine.getBridgeProvider('Axelar')).toBe(bridge)
      expect(engine.getBridgeProvider('Unknown')).toBeUndefined()
    })
  })

  describe('getBestRoute — same chain', () => {
    it('returns the cheapest swap route for same-chain swaps', async () => {
      const cheapSwap = createMockSwapProvider('CheapSwap', 50_000n)
      const expensiveSwap = createMockSwapProvider('ExpensiveSwap', 500_000n)

      engine.registerSwapProvider(cheapSwap)
      engine.registerSwapProvider(expensiveSwap)

      const route = await engine.getBestRoute({
        inputToken: WETH,
        outputToken: USDC_ETH,
        amount: 1_000_000_000_000_000_000n, // 1 ETH
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      expect(route).not.toBeNull()
      expect(route!.fromChain.chainId).toBe(1)
      expect(route!.toChain.chainId).toBe(1)
      expect(route!.inputToken.symbol).toBe('WETH')
      expect(route!.outputToken.symbol).toBe('USDC')
      // The cheapest swap should have totalCost = 50_000
      expect(route!.totalCost).toBe(50_000n)
    })

    it('returns null when no swap providers are registered', async () => {
      const route = await engine.getBestRoute({
        inputToken: WETH,
        outputToken: USDC_ETH,
        amount: 1_000_000_000_000_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      expect(route).toBeNull()
    })

    it('returns null when all providers fail', async () => {
      const failing = createMockSwapProvider('Failing')
      failing.estimate = async () => { throw new Error('API down') }
      engine.registerSwapProvider(failing)

      const route = await engine.getBestRoute({
        inputToken: WETH,
        outputToken: USDC_ETH,
        amount: 1_000_000_000_000_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      expect(route).toBeNull()
    })
  })

  describe('getBestRoute — cross-chain', () => {
    it('includes bridge provider quotes for cross-chain routes', async () => {
      // Make the swap provider extremely expensive so the bridge provider wins
      const expensiveSwap = createMockSwapProvider('ExpensiveLiFi', 10_000_000_000n)
      const cheapBridge = createMockBridgeProvider('Axelar', 50_000n)

      engine.registerSwapProvider(expensiveSwap)
      engine.registerBridgeProvider(cheapBridge)

      const route = await engine.getBestRoute({
        inputToken: USDC_ETH,
        outputToken: USDC_POLY,
        amount: 1_000_000n, // 1 USDC
        fromChain: { chainId: 1 },
        toChain: { chainId: 137 },
      })

      expect(route).not.toBeNull()
      expect(route!.fromChain.chainId).toBe(1)
      expect(route!.toChain.chainId).toBe(137)
      // Bridge is cheaper, so the selected route should be the bridge
      expect(route!.steps.some(s => s.type === 'bridge')).toBe(true)
      expect(route!.totalCost).toBe(50_000n)
    })
  })

  describe('USDC priority logic', () => {
    it('prefers USDC path by default', async () => {
      engine.registerSwapProvider(createMockSwapProvider('LiFi'))

      const route = await engine.getBestRouteWithUSDCPriority({
        inputToken: WETH,
        outputToken: USDC_ETH,
        amount: 1_000_000_000_000_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      expect(route).not.toBeNull()
      // outputToken should be USDC (not USDT)
      expect(route!.outputToken.symbol).toBe('USDC')
    })

    it('falls back to USDT when USDC has high slippage and USDT is cheaper', async () => {
      // Create a swap provider that simulates USDC with high slippage
      const highSlippageProvider: SwapProvider = {
        name: 'HighSlippageSwap',
        async estimate(params: { amount: bigint; fromToken: Token; toToken: Token }): Promise<RouteQuote> {
          if (params.toToken.symbol === 'USDC') {
            return {
              totalCost: 500_000n,
              estimatedTimeMs: 30_000,
              slippage: 1.5, // > threshold (0.5)
              provider: 'HighSlippageSwap',
              steps: [{
                type: 'swap',
                fromToken: params.fromToken,
                toToken: params.toToken,
                amount: params.amount,
                estimatedGas: 500_000n,
                description: 'Swap with high slippage',
              }],
            }
          }
          // USDT path is cheaper
          return {
            totalCost: 50_000n,
            estimatedTimeMs: 10_000,
            slippage: 0.1,
            provider: 'HighSlippageSwap',
            steps: [{
              type: 'swap',
              fromToken: params.fromToken,
              toToken: params.toToken,
              amount: params.amount,
              estimatedGas: 50_000n,
              description: 'Swap with low slippage',
            }],
          }
        },
        async execute(_route: Route): Promise<{ txHash: string }> {
          return { txHash: '0x' + 'c'.repeat(64) }
        },
      }

      engine.registerSwapProvider(highSlippageProvider)

      const route = await engine.getBestRouteWithUSDCPriority({
        inputToken: WETH,
        outputToken: highSlippageProvider as unknown as Token,
        amount: 1_000_000_000_000_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      expect(route).not.toBeNull()
      // The cheaper USDT path should be chosen
      expect(route!.outputToken.symbol).toBe('USDT')
    })
  })

  describe('executeRoute', () => {
    it('throws when no executor is registered', async () => {
      const route: Route = {
        fromChain: { chainId: 1, name: 'Ethereum' },
        toChain: { chainId: 1, name: 'Ethereum' },
        inputToken: WETH,
        outputToken: USDC_ETH,
        inputAmount: 1_000_000_000_000_000_000n,
        outputAmount: 1_000_000n,
        totalCost: 100_000n,
        slippage: 0.5,
        steps: [{
          type: 'swap',
          fromToken: WETH,
          toToken: USDC_ETH,
          amount: 1_000_000_000_000_000_000n,
          estimatedGas: 100_000n,
          description: 'Test swap',
        }],
      }

      await expect(engine.executeRoute(route)).rejects.toThrow(RouteEngineError)
      await expect(engine.executeRoute(route)).rejects.toMatchObject({ code: 'execution_failed' })
    })
  })

  describe('getRouteStatus', () => {
    it('returns pending status by default', async () => {
      const status = await engine.getRouteStatus('0xdeadbeef')
      expect(status).toEqual({ status: 'pending', confirmations: 0 })
    })
  })

  describe('edge cases', () => {
    it('tolerates provider failures gracefully', async () => {
      const goodSwap = createMockSwapProvider('GoodSwap', 100_000n)
      const badSwap: SwapProvider = {
        name: 'BadSwap',
        async estimate() { throw new Error('Internal error') },
        async execute() { throw new Error('Internal error') },
      }

      engine.registerSwapProvider(goodSwap)
      engine.registerSwapProvider(badSwap)

      const route = await engine.getBestRoute({
        inputToken: WETH,
        outputToken: USDC_ETH,
        amount: 1_000_000_000_000_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      expect(route).not.toBeNull()
      // Only the good provider should be chosen
      expect(route!.steps[0].description).toContain('GoodSwap')
    })

    it('handles zero amount gracefully', async () => {
      engine.registerSwapProvider(createMockSwapProvider('LiFi'))

      const route = await engine.getBestRoute({
        inputToken: WETH,
        outputToken: USDC_ETH,
        amount: 0n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 1 },
      })

      // It should return a route (no validation on amount in provider estimation)
      // But outputAmount should be 0 since amount <= totalCost
      expect(route).not.toBeNull()
      if (route) {
        expect(route.outputAmount).toBe(0n)
      }
    })
  })
})

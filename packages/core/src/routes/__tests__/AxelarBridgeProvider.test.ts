/**
 * AxelarBridgeProvider Tests
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { AxelarBridgeProvider } from '../providers/AxelarBridgeProvider'
import { RouteEngineError } from '../types'
import type { Token } from '../types'

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

describe('AxelarBridgeProvider', () => {
  let provider: AxelarBridgeProvider

  beforeEach(() => {
    provider = new AxelarBridgeProvider({ apiUrl: 'https://api.axelarscan.io' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a RouteQuote for a valid bridge estimate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        baseFee: '5000000000000000', // 0.005 in 18 decimals
        sourceGasFee: '250000000000000', // 0.00025
        destinationGasFee: '300000000000000', // 0.0003
      }),
    } as Response)

    const quote = await provider.estimate({
      amount: 1_000_000n,
      fromChain: { chainId: 1 },
      toChain: { chainId: 137 },
      fromToken: USDC_ETH,
      toToken: USDC_POLY,
    })

    expect(quote.provider).toBe('Axelar')
    expect(quote.estimatedTimeMs).toBe(120_000)
    expect(quote.slippage).toBe(0)
    expect(quote.steps).toHaveLength(1)
    expect(quote.steps[0].type).toBe('bridge')

    // totalCost = baseFee + sourceGasFee + destGasFee
    const expectedTotal =
      5_000_000_000_000_000n +
      250_000_000_000_000n +
      300_000_000_000_000n
    expect(quote.totalCost).toBe(expectedTotal)
  })

  it('throws when Axelar API returns non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response)

    await expect(
      provider.estimate({
        amount: 1_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 137 },
        fromToken: USDC_ETH,
        toToken: USDC_POLY,
      }),
    ).rejects.toThrow(RouteEngineError)

    await expect(
      provider.estimate({
        amount: 1_000_000n,
        fromChain: { chainId: 1 },
        toChain: { chainId: 137 },
        fromToken: USDC_ETH,
        toToken: USDC_POLY,
      }),
    ).rejects.toMatchObject({ code: 'no_routes_available' })
  })

  it('handles missing fee fields gracefully', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}), // no fee fields
    } as Response)

    const quote = await provider.estimate({
      amount: 1_000_000n,
      fromChain: { chainId: 1 },
      toChain: { chainId: 137 },
      fromToken: USDC_ETH,
      toToken: USDC_POLY,
    })

    // All fees should default to 0n
    expect(quote.totalCost).toBe(0n)
    expect(quote.steps[0].estimatedGas).toBe(0n)
  })

  it('uses correct Axelar chain names', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response)

    await provider.estimate({
      amount: 1_000_000n,
      fromChain: { chainId: 1 },
      toChain: { chainId: 137 },
      fromToken: USDC_ETH,
      toToken: USDC_POLY,
    })

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
    expect(body.sourceChain).toBe('ethereum')
    expect(body.destinationChain).toBe('polygon')
  })

  it('execute throws with a clear message', async () => {
    const route = {
      fromChain: { chainId: 1, name: 'Ethereum' },
      toChain: { chainId: 137, name: 'Polygon' },
      inputToken: USDC_ETH,
      outputToken: USDC_POLY,
      inputAmount: 1_000_000n,
      outputAmount: 990_000n,
      totalCost: 1_000_000n,
      slippage: 0,
      steps: [],
    }

    await expect(provider.execute(route)).rejects.toThrow(RouteEngineError)
  })
})

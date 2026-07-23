/**
 * LiFISwapProvider Tests
 */

import { ADDRESSES } from "@naculus/test-utils/test-constants";

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { LiFISwapProvider, parseBigIntSafe } from '../providers/LiFISwapProvider'
import { RouteEngineError } from '../types'
import type { Token } from '../types'

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

function mockLiFiResponse() {
  return {
    estimate: {
      toAmount: '999000',
      toAmountMin: '994000',
      fromAmount: '1000000',
      approvalAddress: '0x1234567890123456789012345678901234567890',
      fees: [
        { amount: '5000', token: USDC_ETH.address, included: true },
      ],
    },
    transactionRequest: {
      data: '0xdeadbeef',
      to: '0x1234567890123456789012345678901234567890',
      value: '0',
      chainId: 1,
      gasLimit: '250000',
      gasPrice: '50000000000', // 50 gwei
    },
    id: 'lifi_route_123',
  }
}

describe('LiFISwapProvider', () => {
  let provider: LiFISwapProvider

  beforeEach(() => {
    provider = new LiFISwapProvider({ apiUrl: 'https://li.quest/v1' })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a RouteQuote for a valid swap estimate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockLiFiResponse(),
    } as Response)

    const quote = await provider.estimate({
      amount: 1_000_000n,
      fromToken: WETH,
      toToken: USDC_ETH,
    })

    expect(quote.provider).toBe('LiFi')
    expect(quote.slippage).toBe(0.5)
    expect(quote.steps).toHaveLength(1)
    expect(quote.steps[0].type).toBe('swap')
    expect(quote.steps[0].fromToken.symbol).toBe('WETH')
    expect(quote.steps[0].toToken.symbol).toBe('USDC')

    // totalCost = gas(250000 * 50 gwei) + fees(5000)
    // gas = 250000n * 50000000000n = 12500000000000000n
    // total = 12500000000000000n + 5000n
    const expectedGas = 250_000n * 50_000_000_000n
    expect(quote.totalCost).toBe(expectedGas + 5000n)
  })

  it('throws when LiFi API returns non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    } as Response)

    await expect(
      provider.estimate({
        amount: 1_000_000n,
        fromToken: WETH,
        toToken: USDC_ETH,
      }),
    ).rejects.toThrow(RouteEngineError)

    await expect(
      provider.estimate({
        amount: 1_000_000n,
        fromToken: WETH,
        toToken: USDC_ETH,
      }),
    ).rejects.toMatchObject({ code: 'no_routes_available' })
  })

  it('throws when LiFi returns incomplete data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: '123' }), // missing estimate and transactionRequest
    } as Response)

    await expect(
      provider.estimate({
        amount: 1_000_000n,
        fromToken: WETH,
        toToken: USDC_ETH,
      }),
    ).rejects.toThrow(RouteEngineError)
  })

  it('includes the API key in request headers when configured', async () => {
    const providerWithKey = new LiFISwapProvider({ apiKey: 'test-key' })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockLiFiResponse(),
    } as Response)

    await providerWithKey.estimate({
      amount: 1_000_000n,
      fromToken: WETH,
      toToken: USDC_ETH,
    })

    const callUrl = fetchSpy.mock.calls[0][0] as string
    expect(callUrl).toContain('li.quest')
    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['x-lifi-api-key']).toBe('test-key')
  })

  it('execute throws with a clear message', async () => {
    const route = {
      fromChain: { chainId: 1, name: 'Ethereum' },
      toChain: { chainId: 1, name: 'Ethereum' },
      inputToken: WETH,
      outputToken: USDC_ETH,
      inputAmount: 1_000_000n,
      outputAmount: 999_000n,
      totalCost: 100_000n,
      slippage: 0.5,
      steps: [],
    }

    await expect(provider.execute(route)).rejects.toThrow(RouteEngineError)
  })
})

// ─── parseBigIntSafe ─────────────────────────────────────────────────────

describe('parseBigIntSafe', () => {
  it('accepts decimal string', () => {
    expect(parseBigIntSafe('12345', 'field')).toBe(12345n)
  })

  it('accepts hex string with 0x prefix', () => {
    expect(parseBigIntSafe('0xff', 'field')).toBe(255n)
  })

  it('handles large BigInt boundary values', () => {
    const large = '1234567890123456789012345678901234567890'
    expect(parseBigIntSafe(large, 'field')).toBe(BigInt(large))
  })

  it('rejects empty string', () => {
    expect(() => parseBigIntSafe('', 'field')).toThrow(RouteEngineError)
  })

  it('rejects null', () => {
    expect(() => parseBigIntSafe(null, 'field')).toThrow(RouteEngineError)
  })

  it('rejects undefined', () => {
    expect(() => parseBigIntSafe(undefined, 'field')).toThrow(RouteEngineError)
  })

  it('rejects invalid hex characters', () => {
    expect(() => parseBigIntSafe('0xGG', 'field')).toThrow(RouteEngineError)
    expect(() => parseBigIntSafe('xyz', 'field')).toThrow(RouteEngineError)
  })

  it('includes field name in error message', () => {
    expect(() => parseBigIntSafe('', 'myField')).toThrow('myField')
  })
})

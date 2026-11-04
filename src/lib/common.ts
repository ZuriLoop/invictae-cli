/** Shared config, encoding, and quoting helpers for Invictae. */
import fs from 'fs'
import path from 'path'

import { ethers } from 'ethers'

export interface BridgeConfig {
    oApp: string
    stable: string // key into Chain.stables
}

export interface Venue {
    /** 'v3' = SwapRouter02-compatible; 'v3-01' = SwapRouter01-style (needs a V3Router01Adapter) */
    kind: 'v3' | 'v3-01'
    default?: boolean
    /** What goes in Order.router / ZapParams.srcRouter. Null until an adapter is deployed for v3-01 venues. */
    router: string | null
    quoter: string | null
    /** Fee tiers (v3) or tick spacings (slipstream-style v3-01) to scan when quoting. */
    tiers: number[]
    underlyingRouter?: string
    tierMeaning?: string
    notes?: string
}

export interface CctpConfig {
    domain: number
    tokenMessengerV2: string
    messageTransmitterV2: string
}

export interface Chain {
    name: string
    chainId: number
    lzEid: number
    rpcEnv: string
    publicRpc: string
    lzEndpoint: string
    wrappedNative: string | null
    /** CoinGecko asset-platform id for dynamic ticker resolution (null = registry/address only) */
    coingeckoPlatform?: string | null
    stables: Record<string, string>
    bridges: Record<string, BridgeConfig>
    venues: Record<string, Venue>
    cctp?: CctpConfig
    composer: string | null
    zap: string | null
}

export interface ChainsConfig {
    feeBps: number
    cctp?: { irisApi: string }
    chains: Chain[]
}

export function loadConfig(): ChainsConfig {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/chains.json'), 'utf8'))
}

/** Curated symbol registry (majors, xStocks, Ondo) per chain: config/tokens.json. */
export function loadTokens(): Record<string, Record<string, string>> {
    try {
        return JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/tokens.json'), 'utf8'))
    } catch {
        return {}
    }
}

export interface TokenResolution {
    address: string
    native: boolean
    /** how the input resolved — 'coingecko' means re-verified on-chain but worth showing the user */
    via: 'native' | 'wrapped' | 'stable' | 'registry' | 'address' | 'coingecko'
    name?: string
}

/** Resolves 'eth'/'native', a wrapped-native symbol, a registry symbol, or a raw address on `chain`. */
export function resolveToken(chain: Chain, nameOrAddress: string): TokenResolution {
    const lower = nameOrAddress.toLowerCase()
    if (lower === 'eth' || lower === 'native') {
        if (!chain.wrappedNative) throw new Error(`${chain.name} has no wrapped native configured`)
        return { address: chain.wrappedNative, native: true, via: 'native' }
    }
    // wrapped-native symbols resolve to the wrapped ERC-20 (not unwrapped delivery)
    if (['weth', 'wbnb', 'wpol', 'wmatic', 'wavax', 'whype', 'wsei', 'wmnt'].includes(lower)) {
        if (!chain.wrappedNative) throw new Error(`${chain.name} has no wrapped native configured`)
        return { address: chain.wrappedNative, native: false, via: 'wrapped' }
    }
    if (chain.stables[lower]) return { address: chain.stables[lower], native: false, via: 'stable' }
    const registry = loadTokens()[chain.name]
    const hit = registry && Object.entries(registry).find(([sym]) => sym.toLowerCase() === lower)
    if (hit) return { address: hit[1], native: false, via: 'registry' }
    if (!/^0x[0-9a-fA-F]{40}$/.test(nameOrAddress)) {
        const known = [...Object.keys(chain.stables), ...Object.keys(registry ?? {})].join(', ')
        throw new Error(
            `unknown token '${nameOrAddress}' on ${chain.name} — use 'eth'/'native', a registry symbol (${known || 'none registered'}), or an ERC-20 address`
        )
    }
    return { address: ethers.utils.getAddress(nameOrAddress), native: false, via: 'address' }
}

/**
 * resolveToken plus a live CoinGecko fallback for unknown tickers. A CoinGecko
 * hit is never trusted blindly: the address must exist on this chain and its
 * on-chain symbol() must match the requested ticker (case-insensitive), or we
 * refuse and ask for an explicit address. Callers should surface via/name so
 * the user sees what the ticker resolved to before signing anything.
 */
export async function resolveTokenAny(chain: Chain, nameOrAddress: string): Promise<TokenResolution> {
    try {
        return resolveToken(chain, nameOrAddress)
    } catch (err) {
        if (!chain.coingeckoPlatform || /^0x/.test(nameOrAddress)) throw err
    }
    const ticker = nameOrAddress.toLowerCase()
    const search = await fetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(ticker)}`)
    if (!search.ok) throw new Error(`ticker lookup failed (CoinGecko ${search.status}) — pass the ERC-20 address instead`)
    const { coins } = (await search.json()) as { coins?: { id: string; symbol: string; name: string }[] }
    const coin = (coins ?? []).find((c) => c.symbol.toLowerCase() === ticker)
    if (!coin) throw new Error(`unknown ticker '${nameOrAddress}' — pass the ERC-20 address instead`)
    const detail = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coin.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`
    )
    if (!detail.ok) throw new Error(`ticker lookup failed (CoinGecko ${detail.status}) — pass the ERC-20 address instead`)
    const d = (await detail.json()) as { platforms?: Record<string, string> }
    const address = d.platforms?.[chain.coingeckoPlatform!]
    if (!address) throw new Error(`'${coin.name}' has no ${chain.name} deployment per CoinGecko — pass the ERC-20 address if one exists`)
    const checksummed = ethers.utils.getAddress(address)
    const onchain: string = await new ethers.Contract(checksummed, ERC20_ABI, provider(chain)).symbol().catch(() => '')
    if (onchain.toLowerCase() !== ticker) {
        throw new Error(
            `refusing '${nameOrAddress}': CoinGecko resolved it to ${checksummed} but that contract's symbol() is '${onchain || '?'}' — pass the address explicitly`
        )
    }
    return { address: checksummed, native: false, via: 'coingecko', name: coin.name }
}

const CHAIN_ALIASES: Record<string, string> = {
    eth: 'ethereum', mainnet: 'ethereum',
    bsc: 'bnb', binance: 'bnb', 'bnb-chain': 'bnb',
    arb: 'arbitrum', 'arbitrum-one': 'arbitrum',
    op: 'optimism',
    matic: 'polygon', pol: 'polygon',
    avax: 'avalanche',
    hype: 'hyperevm', hyperliquid: 'hyperevm',
    uni: 'unichain',
}

/** Accepts a chain name, a common alias, a numeric chainId, or an endpoint id. */
export function getChain(config: ChainsConfig, nameOrId: string | number): Chain {
    const q = String(nameOrId).trim().toLowerCase()
    if (/^\d+$/.test(q)) {
        const n = parseInt(q)
        const byId = config.chains.find((c) => c.chainId === n || c.lzEid === n)
        if (byId) return byId
        throw new Error(
            `Unknown chain id '${q}'. Known: ${config.chains.map((c) => `${c.name} (${c.chainId})`).join(', ')}`
        )
    }
    const resolved = CHAIN_ALIASES[q] ?? q
    const chain = config.chains.find((c) => c.name.toLowerCase() === resolved)
    if (!chain) {
        throw new Error(`Unknown chain '${nameOrId}'. Known: ${config.chains.map((c) => c.name).join(', ')}`)
    }
    return chain
}

export function provider(chain: Chain): ethers.providers.JsonRpcProvider {
    return new ethers.providers.JsonRpcProvider(process.env[chain.rpcEnv] ?? chain.publicRpc)
}

/**
 * Picks the bridge both chains support for the requested stable: Stargate
 * everywhere, USDT0 preferred for USDT lanes where both ends have it.
 */
export function pickBridge(src: Chain, dst: Chain, stable: 'usdt' | 'usdc'): { key: string; src: BridgeConfig; dst: BridgeConfig } {
    const candidates = stable === 'usdt' ? ['usdt0', 'stargateUsdt'] : ['stargateUsdc']
    for (const key of candidates) {
        if (src.bridges[key] && dst.bridges[key]) {
            return { key, src: src.bridges[key], dst: dst.bridges[key] }
        }
    }
    // mixed lane: any bridge of this stable on each side still lands the same
    // stable with the composer — fall back to per-side selection
    const srcKey = candidates.find((k) => src.bridges[k])
    const dstKey = candidates.find((k) => dst.bridges[k])
    if (srcKey && dstKey) return { key: `${srcKey}->${dstKey}`, src: src.bridges[srcKey], dst: dst.bridges[dstKey] }
    throw new Error(`No ${stable.toUpperCase()} bridge lane between ${src.name} and ${dst.name}`)
}

/** Order payload consumed by SwapComposer. `router` zero = the default venue;
 *  `tokenOut` zero = native delivery; `maxRelayFee` caps the CCTP relayer skim. */
export function encodeOrder(
    buyer: string,
    tokenOut: string,
    minAmountOut: ethers.BigNumberish,
    deadline: number,
    swapPath: string,
    router: string = ethers.constants.AddressZero,
    maxRelayFee: ethers.BigNumberish = 0
): string {
    return ethers.utils.defaultAbiCoder.encode(
        ['address', 'address', 'uint256', 'uint256', 'address', 'uint256', 'bytes'],
        [buyer, tokenOut, minAmountOut, deadline, router, maxRelayFee, swapPath]
    )
}

/** Uniswap V3 packed path: token (fee token)+ */
export function encodePath(tokens: string[], fees: number[]): string {
    if (tokens.length !== fees.length + 1) throw new Error('encodePath: tokens must be one longer than fees')
    const types: string[] = ['address']
    const values: (string | number)[] = [tokens[0]]
    for (let i = 0; i < fees.length; i++) {
        types.push('uint24', 'address')
        values.push(fees[i], tokens[i + 1])
    }
    return ethers.utils.solidityPack(types, values)
}

/** Messaging options: receive gas top-up + compose gas (+ optional native value).
 *  Hand-rolled type-3 executor options (validated byte-for-byte against the
 *  reference SDK): 0x0003 | [worker 0x01, size, type 0x01, gas u128] |
 *  [worker 0x01, size, type 0x03, index u16, gas u128, (value u128)]. */
export function composeOptions(composeGas: number, composeValue: ethers.BigNumberish = 0): string {
    const u128 = (v: ethers.BigNumberish) => ethers.utils.hexZeroPad(ethers.BigNumber.from(v).toHexString(), 16).slice(2)
    const u16 = (v: number) => ethers.utils.hexZeroPad(ethers.BigNumber.from(v).toHexString(), 2).slice(2)
    const value = ethers.BigNumber.from(composeValue)
    const receiveOpt = '01' + u16(17) + '01' + u128(300_000)
    const composeParams = '03' + u16(0) + u128(composeGas) + (value.isZero() ? '' : u128(value))
    const composeOpt = '01' + u16(composeParams.length / 2) + composeParams
    return '0x0003' + receiveOpt + composeOpt
}

export const ERC20_ABI = [
    'function approve(address spender, uint256 value) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
]

export const QUOTER_V2_ABI = [
    'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
    'function quoteExactOutput(bytes path, uint256 amountOut) returns (uint256 amountIn, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
]

export const OFT_ABI = [
    'function quoteSend((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, bool payInLzToken) view returns ((uint256 nativeFee, uint256 lzTokenFee))',
    'function quoteOFT((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam) view returns ((uint256 minAmountLD, uint256 maxAmountLD), (int256 feeAmountLD, string description)[], (uint256 amountSentLD, uint256 amountReceivedLD))',
    'function send((uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) sendParam, (uint256 nativeFee, uint256 lzTokenFee) fee, address refundAddress) payable',
]

export const ZAP_ABI = [
    'function zap((address tokenIn, uint256 amountIn, bytes srcPath, address srcRouter, uint256 minBridgeAmount, address bridge, uint32 dstEid, bytes32 composer, uint256 minAmountLD, bytes extraOptions, bytes composeMsg) p) payable returns (bytes32)',
    'function zapNative((address tokenIn, uint256 amountIn, bytes srcPath, address srcRouter, uint256 minBridgeAmount, address bridge, uint32 dstEid, bytes32 composer, uint256 minAmountLD, bytes extraOptions, bytes composeMsg) p) payable returns (bytes32)',
    'function zapPermit2((address tokenIn, uint256 amountIn, bytes srcPath, address srcRouter, uint256 minBridgeAmount, address bridge, uint32 dstEid, bytes32 composer, uint256 minAmountLD, bytes extraOptions, bytes composeMsg) p, uint256 nonce, uint256 deadline, bytes signature) payable returns (bytes32)',
    'function zapCctp((address tokenIn, uint256 amountIn, bytes srcPath, address srcRouter, uint256 minBridgeAmount, uint32 dstDomain, bytes32 mintRecipient, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) p)',
    'function zapCctpNative((address tokenIn, uint256 amountIn, bytes srcPath, address srcRouter, uint256 minBridgeAmount, uint32 dstDomain, bytes32 mintRecipient, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) p) payable',
    'function zapCctpPermit2((address tokenIn, uint256 amountIn, bytes srcPath, address srcRouter, uint256 minBridgeAmount, uint32 dstDomain, bytes32 mintRecipient, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) p, uint256 nonce, uint256 deadline, bytes signature)',
    'function bridgeToken(address oApp) view returns (address)',
]

export const COMPOSER_ABI = [
    'function relayAndSwap(bytes message, bytes attestation, uint256 relayFee)',
    'function executeHook(bytes message, bytes attestation, uint256 relayFee)',
    'function processedCctpMessages(bytes32 msgHash) view returns (bool)',
]

export function defaultVenue(chain: Chain): [string, Venue] {
    const entry = Object.entries(chain.venues).find(([, v]) => v.default)
    if (!entry) throw new Error(`${chain.name} has no default venue configured`)
    return entry
}

export async function quoteExactInput(
    chain: Chain,
    quoter: string,
    swapPath: string,
    amountIn: ethers.BigNumber
): Promise<ethers.BigNumber> {
    const q = new ethers.Contract(quoter, QUOTER_V2_ABI, provider(chain))
    const result = await q.callStatic.quoteExactInput(swapPath, amountIn)
    return result.amountOut
}

export interface BestRoute {
    venue: string
    /** Order.router value: zero address when the default venue won. */
    router: string
    tier: number
    path: string
    amountOut: ethers.BigNumber
}

/**
 * Scans every routable venue (router + quoter configured), every tier, and —
 * when the chain has a wrapped native — two-hop paths through it, for the best
 * fill of tokenIn -> tokenOut, quoting in parallel. Venues whose quoter
 * reverts for a path (no pool) are simply skipped.
 */
export async function bestVenueRoute(
    chain: Chain,
    tokenIn: string,
    tokenOut: string,
    amountIn: ethers.BigNumber
): Promise<BestRoute> {
    const probes: Promise<BestRoute | null>[] = []
    const probe = (name: string, venue: Venue, path: string, tier: number) =>
        quoteExactInput(chain, venue.quoter!, path, amountIn)
            .then((amountOut) => ({
                venue: name,
                router: venue.default ? ethers.constants.AddressZero : venue.router!,
                tier,
                path,
                amountOut,
            }))
            .catch(() => null)

    const mid = chain.wrappedNative
    const useMid = mid && mid.toLowerCase() !== tokenIn.toLowerCase() && mid.toLowerCase() !== tokenOut.toLowerCase()
    for (const [name, venue] of Object.entries(chain.venues)) {
        if (!venue.router || !venue.quoter) continue
        for (const tier of venue.tiers) {
            probes.push(probe(name, venue, encodePath([tokenIn, tokenOut], [tier]), tier))
            if (useMid) {
                for (const tier2 of venue.tiers) {
                    probes.push(probe(name, venue, encodePath([tokenIn, mid!, tokenOut], [tier, tier2]), tier2))
                }
            }
        }
    }
    const routes = (await Promise.all(probes)).filter((r): r is BestRoute => r !== null && !r.amountOut.isZero())
    if (routes.length === 0) {
        throw new Error(`no venue on ${chain.name} quotes ${tokenIn} -> ${tokenOut} (no pools?)`)
    }
    routes.sort((a, b) => (b.amountOut.gt(a.amountOut) ? 1 : -1))
    return routes[0]
}

/**
 * Exact-out counterpart of bestVenueRoute: the route needing the LEAST input
 * for a fixed output. Returns the forward-direction path (what the order carries).
 */
export async function bestVenueRouteExactOut(
    chain: Chain,
    tokenIn: string,
    tokenOut: string,
    amountOut: ethers.BigNumber
): Promise<BestRoute & { amountIn: ethers.BigNumber }> {
    const probes: Promise<(BestRoute & { amountIn: ethers.BigNumber }) | null>[] = []
    const probe = (name: string, venue: Venue, forwardTokens: string[], forwardTiers: number[], tier: number) => {
        const forward = encodePath(forwardTokens, forwardTiers)
        const reversed = encodePath([...forwardTokens].reverse(), [...forwardTiers].reverse())
        const q = new ethers.Contract(venue.quoter!, QUOTER_V2_ABI, provider(chain))
        return q.callStatic
            .quoteExactOutput(reversed, amountOut)
            .then((r: { amountIn: ethers.BigNumber }) => ({
                venue: name,
                router: venue.default ? ethers.constants.AddressZero : venue.router!,
                tier,
                path: forward,
                amountOut,
                amountIn: r.amountIn,
            }))
            .catch(() => null)
    }
    const mid = chain.wrappedNative
    const useMid = mid && mid.toLowerCase() !== tokenIn.toLowerCase() && mid.toLowerCase() !== tokenOut.toLowerCase()
    for (const [name, venue] of Object.entries(chain.venues)) {
        if (!venue.router || !venue.quoter) continue
        for (const tier of venue.tiers) {
            probes.push(probe(name, venue, [tokenIn, tokenOut], [tier], tier))
            if (useMid) {
                for (const tier2 of venue.tiers) {
                    probes.push(probe(name, venue, [tokenIn, mid!, tokenOut], [tier, tier2], tier2))
                }
            }
        }
    }
    const routes = (await Promise.all(probes)).filter(
        (r): r is BestRoute & { amountIn: ethers.BigNumber } => r !== null && !r.amountIn.isZero()
    )
    if (routes.length === 0) {
        throw new Error(`no venue on ${chain.name} quotes exact-out ${tokenIn} -> ${tokenOut}`)
    }
    routes.sort((a, b) => (a.amountIn.lt(b.amountIn) ? -1 : 1))
    return routes[0]
}

/** Reverse quote on a specific route: input required for an exact output. */
export async function quoteExactOutputOnRoute(
    chain: Chain,
    venueName: string,
    route: BestRoute,
    amountOut: ethers.BigNumber
): Promise<ethers.BigNumber> {
    const venue = chain.venues[venueName]
    if (!venue?.quoter) throw new Error(`venue ${venueName} has no quoter`)
    // QuoterV2 exact-output paths run tokenOut -> tokenIn: reverse the packed path
    const bytes = ethers.utils.arrayify(route.path)
    const tokens: string[] = []
    const tiers: number[] = []
    for (let i = 0; i < bytes.length; ) {
        tokens.push(ethers.utils.hexlify(bytes.slice(i, i + 20)))
        i += 20
        if (i < bytes.length) {
            tiers.push(parseInt(ethers.utils.hexlify(bytes.slice(i, i + 3)), 16))
            i += 3
        }
    }
    const reversed = encodePath(tokens.reverse(), tiers.reverse())
    const q = new ethers.Contract(venue.quoter, QUOTER_V2_ABI, provider(chain))
    const result = await q.callStatic.quoteExactOutput(reversed, amountOut)
    return result.amountIn
}

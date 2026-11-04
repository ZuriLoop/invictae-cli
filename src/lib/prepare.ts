/**
 * Shared swap preparation + transaction building, used by the CLI and the API.
 */
import { ethers } from 'ethers'

import {
    bestVenueRoute,
    bestVenueRouteExactOut,
    composeOptions,
    encodeOrder,
    getChain,
    loadConfig,
    pickBridge,
    provider,
    resolveToken,
    ERC20_ABI,
    OFT_ABI,
    ZAP_ABI,
    type BestRoute,
    type Chain,
} from './common'

export interface Prepared {
    srcChain: Chain
    dstChain: Chain
    stableKey: 'usdt' | 'usdc'
    /** 'cctp' = Circle burn/mint (lossless, relayer completes); 'oft' = USDT0/Stargate compose. */
    rail: 'oft' | 'cctp'
    bridgeSrc: string
    payToken: string
    payNative: boolean
    payDecimals: number
    amountIn: ethers.BigNumber
    srcRoute: BestRoute | null // null when paying with the bridge stable
    minBridgeAmount: ethers.BigNumber
    bridgeReceived: ethers.BigNumber // net of bridge fees, source-side decimals
    dstReceived: ethers.BigNumber // same amount in destination-side decimals
    dstStableDecimals: number
    feeAmount: ethers.BigNumber
    maxRelayFee: ethers.BigNumber
    dstRoute: BestRoute | null // null for bridge-only (tokenOut == stable)
    tokenOut: string // address(0) for native delivery
    tokenOutResolved: string // the ERC-20 actually swapped into (wrapped native when native)
    expectedOut: ethers.BigNumber
    minOut: ethers.BigNumber
    deadline: number
    order: string
    lzFeeNative: ethers.BigNumber
    extraOptions: string
}

export async function prepare(opts: {
    from: string
    to: string
    pay: string
    amount: string
    tokenOut: string
    stable?: string
    exactOut?: boolean
    slippageBps: number
    composeGas: number
    relayFeeCap: string
    buyer: string
    deadlineSeconds: number
}): Promise<Prepared> {
    const config = loadConfig()
    const srcChain = getChain(config, opts.from)
    const dstChain = getChain(config, opts.to)

    // Pay token: 'eth'/'native', a registry symbol, 'usdt'/'usdc', or an address
    const payRes = resolveToken(srcChain, opts.pay)
    const payToken = payRes.address
    const payLower = opts.pay.toLowerCase()

    // Which stable rides the bridge: explicit, the pay token itself, or USDC.
    const stableKey = (opts.stable ?? (payLower === 'usdt' ? 'usdt' : 'usdc')) as 'usdt' | 'usdc'
    if (!srcChain.stables[stableKey] || !dstChain.stables[stableKey]) {
        throw new Error(`${stableKey.toUpperCase()} is not configured on both ${srcChain.name} and ${dstChain.name}`)
    }
    // CCTP is the premium USDC lane (lossless burn/mint) wherever Circle
    // serves both ends; OFT compose (USDT0/Stargate) covers everything else.
    const rail: 'oft' | 'cctp' = stableKey === 'usdc' && srcChain.cctp && dstChain.cctp ? 'cctp' : 'oft'
    const bridge = rail === 'oft' ? pickBridge(srcChain, dstChain, stableKey) : null
    const srcStable = srcChain.stables[stableKey]
    const dstStable = dstChain.stables[stableKey]

    const payErc20 = new ethers.Contract(payToken, ERC20_ABI, provider(srcChain))
    const payDecimals: number = await payErc20.decimals()

    // Token out: 'eth'/'native' (delivered unwrapped), a registry symbol, or an address
    const outRes = resolveToken(dstChain, opts.tokenOut)
    const tokenOutResolved = outRes.address
    const tokenOut = outRes.native ? ethers.constants.AddressZero : tokenOutResolved
    const bridgeOnly = !outRes.native && tokenOutResolved.toLowerCase() === dstStable.toLowerCase()
    const deadline = Math.floor(Date.now() / 1000) + opts.deadlineSeconds

    const srcDec: number = await new ethers.Contract(srcStable, ERC20_ABI, provider(srcChain)).decimals()
    const dstDec: number = await new ethers.Contract(dstStable, ERC20_ABI, provider(dstChain)).decimals()
    const scaleUp = (v: ethers.BigNumber) =>
        dstDec >= srcDec ? v.mul(ethers.BigNumber.from(10).pow(dstDec - srcDec)) : v.div(ethers.BigNumber.from(10).pow(srcDec - dstDec))
    const scaleDown = (v: ethers.BigNumber) =>
        dstDec >= srcDec ? v.div(ethers.BigNumber.from(10).pow(dstDec - srcDec)) : v.mul(ethers.BigNumber.from(10).pow(srcDec - dstDec))

    const feeBps = config.feeBps ?? 0
    const maxRelayFee = rail === 'cctp' ? ethers.utils.parseUnits(opts.relayFeeCap, dstDec) : ethers.constants.Zero

    let amountIn: ethers.BigNumber
    let srcRoute: BestRoute | null = null
    let minBridgeAmount: ethers.BigNumber
    let dstRoute: BestRoute | null = null
    let expectedOut: ethers.BigNumber
    let minOut = ethers.constants.Zero

    if (opts.exactOut) {
        if (bridgeOnly) throw new Error('--exact-out does not apply to bridge-only transfers')
        // Work backwards: desired output -> stable needed on dst -> gross bridge
        // amount -> pay amount on src, with the slippage buffer on the input side.
        const outErc20 = new ethers.Contract(tokenOutResolved, ERC20_ABI, provider(dstChain))
        const outDec: number = await outErc20.decimals()
        expectedOut = ethers.utils.parseUnits(opts.amount, outDec)
        minOut = expectedOut // exact-out: the floor IS the target
        const r = await bestVenueRouteExactOut(dstChain, dstStable, tokenOutResolved, expectedOut)
        dstRoute = r
        const netNeeded = r.amountIn
        // gross = net / (1 - feeBps) + relay fee cap, buffered for input-side slippage
        let grossDst = netNeeded.mul(10_000).div(10_000 - feeBps).add(maxRelayFee)
        grossDst = grossDst.mul(10_000 + opts.slippageBps).div(10_000)
        minBridgeAmount = scaleDown(grossDst)
        if (payToken.toLowerCase() !== srcStable.toLowerCase()) {
            const sr = await bestVenueRouteExactOut(srcChain, payToken, srcStable, minBridgeAmount)
            srcRoute = sr
            amountIn = sr.amountIn.mul(10_000 + opts.slippageBps).div(10_000)
        } else {
            amountIn = minBridgeAmount
        }
    } else {
        amountIn = ethers.utils.parseUnits(opts.amount, payDecimals)
        minBridgeAmount = amountIn
        if (payToken.toLowerCase() !== srcStable.toLowerCase()) {
            srcRoute = await bestVenueRoute(srcChain, payToken, srcStable, amountIn)
            minBridgeAmount = srcRoute.amountOut.mul(10_000 - opts.slippageBps).div(10_000)
        }
        expectedOut = ethers.constants.Zero // filled below
    }

    // Bridge leg. OFT: quoteOFT for the delivered amount (pool fees out) and
    // quoteSend for the LZ fee. CCTP: burn == mint at standard finality.
    const extraOptions = composeOptions(opts.composeGas)
    const composerB32 = ethers.utils.hexZeroPad(dstChain.composer ?? ethers.constants.AddressZero, 32)
    let bridgeReceived: ethers.BigNumber
    let oft: ethers.Contract | null = null
    let probe: Record<string, unknown> | null = null
    if (rail === 'oft') {
        oft = new ethers.Contract(bridge!.src.oApp, OFT_ABI, provider(srcChain))
        probe = {
            dstEid: dstChain.lzEid,
            to: composerB32,
            amountLD: minBridgeAmount,
            minAmountLD: 0,
            extraOptions,
            composeMsg: encodeOrder(opts.buyer, tokenOut, 1, deadline, '0x'),
            oftCmd: '0x',
        }
        const [, , receipt] = await oft.quoteOFT(probe)
        bridgeReceived = receipt.amountReceivedLD
    } else {
        bridgeReceived = minBridgeAmount
    }

    const dstReceived = scaleUp(bridgeReceived)
    const netIn = dstReceived.sub(maxRelayFee).mul(10_000 - feeBps).div(10_000)
    const feeAmount = dstReceived.sub(maxRelayFee).sub(netIn)

    if (!opts.exactOut) {
        expectedOut = netIn
        if (!bridgeOnly) {
            if (netIn.lte(0)) throw new Error('relay fee cap exceeds the bridged amount')
            dstRoute = await bestVenueRoute(dstChain, dstStable, tokenOutResolved, netIn)
            expectedOut = dstRoute.amountOut
            minOut = expectedOut.mul(10_000 - opts.slippageBps).div(10_000)
            if (minOut.isZero()) throw new Error('quoted minAmountOut is zero — amount too small or no usable pool')
        }
    }

    const order = encodeOrder(
        opts.buyer,
        tokenOut,
        minOut,
        deadline,
        dstRoute?.path ?? '0x',
        dstRoute?.router ?? ethers.constants.AddressZero,
        maxRelayFee
    )
    let lzFeeNative = ethers.constants.Zero
    if (rail === 'oft') {
        const sendParam = { ...probe!, minAmountLD: bridgeReceived, composeMsg: order }
        ;[lzFeeNative] = await oft!.quoteSend(sendParam, false)
    }

    return {
        srcChain, dstChain, stableKey, rail,
        bridgeSrc: rail === 'oft' ? bridge!.src.oApp : srcChain.cctp!.tokenMessengerV2,
        payToken, payNative: payRes.native, payDecimals, amountIn,
        srcRoute, minBridgeAmount, bridgeReceived, dstReceived, dstStableDecimals: dstDec, feeAmount, maxRelayFee,
        dstRoute, tokenOut, tokenOutResolved, expectedOut, minOut, deadline, order,
        lzFeeNative, extraOptions,
    }
}


export interface PlannedTx {
    label: string
    to: string
    data: string
    value: string
}

export interface SwapTxOptions {
    maxFee?: string // CCTP fast-transfer budget (USDC units)
    minFinality?: number
}

/** Builds the ready-to-sign transactions for a prepared swap. */
export function buildSwapTxs(prep: Prepared, opts: SwapTxOptions = {}): PlannedTx[] {
    const srcChain = prep.srcChain
    const dstChain = prep.dstChain
    if (!srcChain.zap) throw new Error(`SourceZap is not deployed on ${srcChain.name} yet (config chains.json .zap)`)
    if (!dstChain.composer) throw new Error(`SwapComposer is not deployed on ${dstChain.name} yet (config chains.json .composer)`)

    const zapIface = new ethers.utils.Interface(ZAP_ABI)
    const erc20 = new ethers.utils.Interface(ERC20_ABI)
    const composerB32 = ethers.utils.hexZeroPad(dstChain.composer, 32)

    let zapTx: PlannedTx
    if (prep.rail === 'cctp') {
        const params = {
            tokenIn: prep.payToken,
            amountIn: prep.amountIn,
            srcPath: prep.srcRoute?.path ?? '0x',
            srcRouter: prep.srcRoute?.router ?? ethers.constants.AddressZero,
            minBridgeAmount: prep.srcRoute ? prep.minBridgeAmount : 0,
            dstDomain: dstChain.cctp!.domain,
            mintRecipient: composerB32,
            maxFee: ethers.utils.parseUnits(opts.maxFee ?? '0', 6),
            minFinalityThreshold: opts.minFinality ?? 2000,
            hookData: prep.order,
        }
        zapTx = prep.payNative
            ? { label: 'zapCctpNative', to: srcChain.zap, data: zapIface.encodeFunctionData('zapCctpNative', [params]), value: prep.amountIn.toString() }
            : { label: 'zapCctp', to: srcChain.zap, data: zapIface.encodeFunctionData('zapCctp', [params]), value: '0' }
    } else {
        const params = {
            tokenIn: prep.payToken,
            amountIn: prep.amountIn,
            srcPath: prep.srcRoute?.path ?? '0x',
            srcRouter: prep.srcRoute?.router ?? ethers.constants.AddressZero,
            minBridgeAmount: prep.srcRoute ? prep.minBridgeAmount : 0,
            bridge: prep.bridgeSrc,
            dstEid: dstChain.lzEid,
            composer: composerB32,
            minAmountLD: prep.bridgeReceived,
            extraOptions: prep.extraOptions,
            composeMsg: prep.order,
        }
        const lzFee = prep.lzFeeNative.mul(110).div(100) // headroom; excess refunds to the sender
        zapTx = prep.payNative
            ? { label: 'zapNative', to: srcChain.zap, data: zapIface.encodeFunctionData('zapNative', [params]), value: prep.amountIn.add(lzFee).toString() }
            : { label: 'zap', to: srcChain.zap, data: zapIface.encodeFunctionData('zap', [params]), value: lzFee.toString() }
    }

    return prep.payNative
        ? [zapTx]
        : [
              { label: 'approve zap', to: prep.payToken, data: erc20.encodeFunctionData('approve', [srcChain.zap, prep.amountIn]), value: '0' },
              zapTx,
          ]
}

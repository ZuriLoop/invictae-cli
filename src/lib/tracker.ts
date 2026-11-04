/**
 * Swap lifecycle tracker: follows a source-chain transaction through the
 * bridge to its final outcome on the destination composer, emitting typed
 * step events. Shared by the API's SSE stream and the CLI's watch command.
 */
import { ethers } from 'ethers'

import { getChain, loadConfig, provider, ZAP_ABI, type Chain, type ChainsConfig } from './common'

export type SwapStepName =
    | 'source_confirmed'
    | 'bridging' // OFT rail: bridge in flight
    | 'attesting' // CCTP rail: waiting on Circle
    | 'attested' // CCTP rail: ready to relay / relaying
    | 'delivered' // funds arrived at the destination composer
    | 'executed' // swap succeeded; buyer paid
    | 'refunded' // order failed its checks; stable refunded to the buyer
    | 'escrowed' // refund could not be delivered; claimable escrow
    | 'timeout'

export interface StepEvent {
    step: SwapStepName
    state: 'active' | 'done' | 'failed'
    rail: 'oft' | 'cctp' | 'unknown'
    detail: string
    txHash?: string
    at: number // unix ms
    final?: boolean
}

export interface TrackOptions {
    /** overall budget before emitting a timeout event (default 45 min) */
    maxMs?: number
    pollMs?: number
}

const COMPOSER_EVENTS_ABI = [
    'event SwapExecuted(address indexed buyer, address indexed tokenOut, address tokenIn, uint256 amountIn, uint256 amountOut)',
    'event SwapRefunded(address indexed recipient, address tokenIn, uint256 amountIn, bytes reason)',
    'event RefundEscrowed(address indexed recipient, address tokenIn, uint256 amountIn, bytes reason)',
]

const ORDER_TYPES = ['address', 'address', 'uint256', 'uint256', 'address', 'uint256', 'bytes']

interface DecodedIntent {
    rail: 'oft' | 'cctp'
    buyer: string | null
    dstChain: Chain | null
}

/** Pulls rail, buyer, and destination out of the original zap calldata. */
function decodeIntent(config: ChainsConfig, data: string): DecodedIntent | null {
    const iface = new ethers.Interface(ZAP_ABI)
    let parsed: ethers.TransactionDescription | null
    try {
        parsed = iface.parseTransaction({ data })
    } catch {
        return null
    }
    if (!parsed) return null
    const p = parsed.args.p
    const isCctp = parsed.name.startsWith('zapCctp')
    const orderBytes: string = isCctp ? p.hookData : p.composeMsg
    let buyer: string | null = null
    try {
        ;[buyer] = ethers.AbiCoder.defaultAbiCoder().decode(ORDER_TYPES, orderBytes)
    } catch {
        // bridge-only or foreign payload — outcome matching falls back to time-window scan
    }
    let dstChain: Chain | null = null
    if (isCctp) {
        dstChain = config.chains.find((c) => c.cctp?.domain === p.dstDomain) ?? null
    } else {
        dstChain = config.chains.find((c) => c.lzEid === p.dstEid) ?? null
    }
    return { rail: isCctp ? 'cctp' : 'oft', buyer, dstChain }
}

/** Watches the composer for this buyer's outcome event from a given block. */
async function findOutcome(
    dstChain: Chain,
    buyer: string | null,
    fromBlock: number
): Promise<StepEvent | null> {
    if (!dstChain.composer) return null
    const p = provider(dstChain)
    const composer = new ethers.Contract(dstChain.composer, COMPOSER_EVENTS_ABI, p)
    const latest = await p.getBlockNumber()
    const topicBuyer = buyer ? [ethers.zeroPadValue(buyer, 32)] : null

    const scan = async (eventName: string): Promise<ethers.EventLog | undefined> => {
        const filter = composer.filters[eventName](topicBuyer ? buyer : null)
        const events = await composer.queryFilter(filter, Math.max(fromBlock, latest - 9000), latest)
        const last = events[events.length - 1]
        return last && 'args' in last ? last : undefined
    }

    const executed = await scan('SwapExecuted')
    if (executed) {
        return {
            step: 'executed',
            state: 'done',
            rail: 'unknown',
            detail: `swap executed: ${executed.args!.amountOut.toString()} of ${executed.args!.tokenOut} to ${executed.args!.buyer}`,
            txHash: executed.transactionHash,
            at: Date.now(),
            final: true,
        }
    }
    const refunded = await scan('SwapRefunded')
    if (refunded) {
        return {
            step: 'refunded',
            state: 'done',
            rail: 'unknown',
            detail: `order refunded ${refunded.args!.amountIn.toString()} to ${refunded.args!.recipient}`,
            txHash: refunded.transactionHash,
            at: Date.now(),
            final: true,
        }
    }
    const escrowed = await scan('RefundEscrowed')
    if (escrowed) {
        return {
            step: 'escrowed',
            state: 'done',
            rail: 'unknown',
            detail: `refund escrowed for ${escrowed.args!.recipient} — claimable via claimRefund`,
            txHash: escrowed.transactionHash,
            at: Date.now(),
            final: true,
        }
    }
    return null
}

/**
 * Follows a swap end to end, calling `emit` for every lifecycle step.
 * Resolves when a terminal event has been emitted (final outcome or timeout).
 */
export async function trackSwap(
    chainName: string,
    txHash: string,
    emit: (e: StepEvent) => void,
    opts: TrackOptions = {}
): Promise<void> {
    const config = loadConfig()
    const srcChain = getChain(config, chainName)
    const srcProvider = provider(srcChain)
    const deadline = Date.now() + (opts.maxMs ?? 45 * 60_000)
    const pollMs = opts.pollMs ?? 8_000
    const sleep = () => new Promise((r) => setTimeout(r, pollMs))
    const expired = () => Date.now() > deadline

    // ── source confirmation ─────────────────────────────────────────────────
    emit({ step: 'source_confirmed', state: 'active', rail: 'unknown', detail: 'waiting for the source transaction', at: Date.now() })
    let receipt: ethers.TransactionReceipt | null = null
    while (!receipt && !expired()) {
        receipt = await srcProvider.getTransactionReceipt(txHash).catch(() => null)
        if (!receipt) await sleep()
    }
    if (!receipt) {
        emit({ step: 'timeout', state: 'failed', rail: 'unknown', detail: 'source transaction not found', at: Date.now(), final: true })
        return
    }
    if (receipt.status === 0) {
        emit({ step: 'source_confirmed', state: 'failed', rail: 'unknown', detail: 'source transaction reverted', txHash, at: Date.now(), final: true })
        return
    }

    const tx = await srcProvider.getTransaction(txHash)
    const intent = tx?.data ? decodeIntent(config, tx.data) : null
    const rail = intent?.rail ?? 'unknown'
    emit({
        step: 'source_confirmed',
        state: 'done',
        rail,
        detail: `confirmed on ${srcChain.name} in block ${receipt.blockNumber}`,
        txHash,
        at: Date.now(),
    })

    const dstChain = intent?.dstChain ?? null
    const dstFromBlock = dstChain ? await provider(dstChain).getBlockNumber().catch(() => 0) : 0

    // ── bridge leg ──────────────────────────────────────────────────────────
    if (rail === 'cctp') {
        const srcDomain = srcChain.cctp!.domain
        const irisApi = config.cctp?.irisApi ?? 'https://iris-api.circle.com'
        emit({ step: 'attesting', state: 'active', rail, detail: "waiting for Circle's attestation (~1–15 min)", at: Date.now() })
        let attested = false
        while (!attested && !expired()) {
            const res = await fetch(`${irisApi}/v2/messages/${srcDomain}?transactionHash=${txHash}`).catch(() => null)
            if (res?.ok) {
                const body = (await res.json()) as { messages?: { status: string }[] }
                const msgs = body.messages ?? []
                if (msgs.length > 0 && msgs.every((m) => m.status === 'complete')) attested = true
            }
            if (!attested) await sleep()
        }
        if (!attested) {
            emit({ step: 'timeout', state: 'failed', rail, detail: 'attestation did not complete in time', at: Date.now(), final: true })
            return
        }
        emit({ step: 'attested', state: 'done', rail, detail: 'Circle attested the burn — relayer completing the swap', at: Date.now() })
    } else {
        emit({ step: 'bridging', state: 'active', rail, detail: 'bridge delivering (~1–3 min)', at: Date.now() })
        let delivered = false
        let dstTx: string | undefined
        while (!delivered && !expired()) {
            const res = await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${txHash}`).catch(() => null)
            if (res?.ok) {
                const body = (await res.json()) as {
                    data?: { status?: { name?: string }; destination?: { tx?: { txHash?: string } } }[]
                }
                const m = (body.data ?? [])[0]
                const status = m?.status?.name ?? ''
                if (status === 'DELIVERED') {
                    delivered = true
                    dstTx = m?.destination?.tx?.txHash
                } else if (status === 'FAILED' || status === 'BLOCKED') {
                    emit({ step: 'bridging', state: 'failed', rail, detail: `bridge reports ${status} — delivery can be retried`, at: Date.now(), final: true })
                    return
                }
            }
            if (!delivered) await sleep()
        }
        if (!delivered) {
            emit({ step: 'timeout', state: 'failed', rail, detail: 'bridge delivery did not complete in time', at: Date.now(), final: true })
            return
        }
        emit({ step: 'delivered', state: 'done', rail, detail: 'funds arrived on the destination', txHash: dstTx, at: Date.now() })
    }

    // ── final outcome on the composer ───────────────────────────────────────
    if (!dstChain?.composer) {
        emit({
            step: 'executed',
            state: 'done',
            rail,
            detail: 'bridge leg complete (no composer configured on the destination to report the swap outcome)',
            at: Date.now(),
            final: true,
        })
        return
    }
    emit({ step: 'executed', state: 'active', rail, detail: 'waiting for the destination swap', at: Date.now() })
    while (!expired()) {
        const outcome = await findOutcome(dstChain, intent?.buyer ?? null, dstFromBlock)
        if (outcome) {
            emit({ ...outcome, rail })
            return
        }
        await sleep()
    }
    emit({ step: 'timeout', state: 'failed', rail, detail: 'no outcome observed in time — check pnpm swap status', at: Date.now(), final: true })
}

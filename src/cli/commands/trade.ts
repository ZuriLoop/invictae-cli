/** quote + swap: the trading commands. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { getChain, loadConfig, provider, ERC20_ABI } from '../../lib/common'
import { buildSwapTxs, prepare, type Prepared } from '../../lib/prepare'
import { enforcePolicy, findByKey, loadPolicy, recordSwap } from '../../lib/policy'
import { trackSwap } from '../../lib/tracker'
import { c, confirm, emitJson, kv, note, spinner } from '../ui'

/** `TOKEN@CHAIN` → { token, chain }; chain accepts names/aliases/ids. */
function parsePair(s: string): { token: string; chain: string } {
    const i = s.lastIndexOf('@')
    if (i <= 0 || i === s.length - 1) {
        throw new Error(`'${s}' — expected TOKEN@CHAIN (e.g. usdc@base, eth@arbitrum, 0x…@8453)`)
    }
    return { token: s.slice(0, i), chain: s.slice(i + 1) }
}

export const sharedTradeOptions = (cmd: Command) =>
    cmd
        .argument('[amount]', 'amount of the pay token (of the OUT token with --exact-out)')
        .argument('[pay]', 'what you pay, as TOKEN@CHAIN (e.g. usdc@base)')
        .argument('[receive]', 'what you receive, as TOKEN@CHAIN (e.g. eth@arbitrum)')
        .option('--from <chain>', 'source chain (alternative to TOKEN@CHAIN form)')
        .option('--to <chain>', 'destination chain')
        .option('--pay <token>', "'eth'/'native', a ticker, or an ERC-20 address")
        .option('--amount <n>', 'amount of the pay token')
        .option('--token-out <token>', "'eth'/'native', a ticker, an address, or the stable itself (bridge-only)")
        .option('--stable <usdt|usdc>', 'bridge stable (default: the pay token, else usdc)')
        .option('--exact-out', 'treat the amount as the exact amount of token-out to receive', false)
        .option('--slippage-bps <n>', 'slippage tolerance per swap leg', '100')
        .option('--compose-gas <n>', 'destination compose gas', '600000')
        .option('--relay-fee-cap <n>', 'max stable the CCTP relayer may skim for gas (cctp rail)', '0')
        .option('--deadline-seconds <n>', 'order validity window', '1800')

export function tradeOpts(opts: Record<string, string>, amount?: string, pay?: string, receive?: string) {
    const merged = { ...opts }
    if (amount) merged.amount = amount
    if (pay) {
        const p = parsePair(pay)
        merged.pay = p.token
        merged.from = p.chain
    }
    if (receive) {
        const r = parsePair(receive)
        merged.tokenOut = r.token
        merged.to = r.chain
    }
    for (const k of ['from', 'to', 'pay', 'amount', 'tokenOut'] as const) {
        if (!merged[k]) {
            throw new Error(
                `missing ${k} — use positional form (invictae quote 100 usdc@base eth@arbitrum) or flags (--from --to --pay --amount --token-out)`
            )
        }
    }
    return {
        from: merged.from,
        to: merged.to,
        pay: merged.pay,
        amount: merged.amount,
        tokenOut: merged.tokenOut,
        stable: merged.stable,
        exactOut: Boolean(merged.exactOut),
        slippageBps: parseInt(merged.slippageBps),
        composeGas: parseInt(merged.composeGas),
        relayFeeCap: merged.relayFeeCap ?? '0',
        deadlineSeconds: parseInt(merged.deadlineSeconds),
    }
}

/** Stable JSON shape shared by quote --json and swap --json's plan event. */
export function quoteJson(prep: Prepared) {
    return {
        rail: prep.rail,
        from: prep.srcChain.name,
        to: prep.dstChain.name,
        stable: prep.stableKey,
        payToken: prep.payToken,
        payNative: prep.payNative,
        payVia: prep.payVia,
        amountIn: prep.amountIn.toString(),
        srcVenue: prep.srcRoute ? { venue: prep.srcRoute.venue, tier: prep.srcRoute.tier } : null,
        arrives: prep.dstReceived.toString(),
        feeBps: loadConfig().feeBps,
        feeAmount: prep.feeAmount.toString(),
        maxRelayFee: prep.maxRelayFee.toString(),
        tokenOut: prep.tokenOut,
        tokenOutResolved: prep.tokenOutResolved,
        outVia: prep.outVia,
        dstVenue: prep.dstRoute ? { venue: prep.dstRoute.venue, tier: prep.dstRoute.tier } : null,
        expectedOut: prep.expectedOut.toString(),
        minOut: prep.minOut.toString(),
        deadline: prep.deadline,
        lzFeeNative: prep.lzFeeNative.toString(),
    }
}

async function describe(prep: Prepared, opts: Record<string, unknown>): Promise<[string, string][]> {
    const outErc20 = new ethers.Contract(prep.tokenOutResolved, ERC20_ABI, provider(prep.dstChain))
    const [outSymRaw, outDecRaw] = await Promise.all([outErc20.symbol(), outErc20.decimals()])
    const outDec = Number(outDecRaw)
    const outSym = prep.tokenOut === ethers.ZeroAddress ? `${outSymRaw} → native` : outSymRaw
    const rows: [string, string][] = []
    rows.push(['route', `${prep.srcChain.name} → ${prep.dstChain.name}`])
    if (prep.payVia === 'coingecko') {
        rows.push(['pay token', `${prep.payToken} ${c.yellow(`← resolved via CoinGecko (${prep.payName}) — verify this address`)}`])
    }
    rows.push([
        'token out',
        `${prep.tokenOut === ethers.ZeroAddress ? `native (unwraps ${prep.tokenOutResolved})` : prep.tokenOutResolved}` +
            (prep.outVia === 'coingecko' ? ` ${c.yellow(`← resolved via CoinGecko (${prep.outName}) — verify this address`)}` : ''),
    ])
    rows.push([
        'rail',
        prep.rail === 'cctp' ? c.cyan('CCTP v2 — lossless, relayer completes') : c.cyan(`token bridge (${prep.bridgeSrc.slice(0, 10)}…)`),
    ])
    if (prep.srcRoute) rows.push(['source swap', `${prep.srcRoute.venue} (tier ${prep.srcRoute.tier})`])
    rows.push(['arrives', `~${ethers.formatUnits(prep.dstReceived, prep.dstStableDecimals)} ${prep.stableKey.toUpperCase()}`])
    if (prep.feeAmount !== 0n) rows.push(['protocol fee', `${loadConfig().feeBps} bps`])
    if (prep.maxRelayFee !== 0n)
        rows.push(['relay fee cap', `${ethers.formatUnits(prep.maxRelayFee, prep.dstStableDecimals)} ${prep.stableKey.toUpperCase()}`])
    if (opts.exactOut) {
        rows.push(['you pay (max)', `${ethers.formatUnits(prep.amountIn, prep.payDecimals)}`])
        rows.push(['you receive', c.bold(`exactly ${ethers.formatUnits(prep.minOut, outDec)} ${outSym}`)])
    } else {
        rows.push([
            'expected out',
            c.bold(`${ethers.formatUnits(prep.expectedOut, outDec)} ${outSym}`) +
                (prep.dstRoute ? c.dim(` via ${prep.dstRoute.venue} (tier ${prep.dstRoute.tier})`) : ''),
        ])
        if (prep.minOut !== 0n)
            rows.push(['min out', `${ethers.formatUnits(prep.minOut, outDec)} ${outSym} (${opts.slippageBps} bps)`])
    }
    rows.push([
        'bridge fee',
        prep.rail === 'oft' ? `${ethers.formatEther(prep.lzFeeNative)} native` : 'none (standard finality ~1–15 min)',
    ])
    return rows
}

export function registerTrade(program: Command): void {
    sharedTradeOptions(
        program.command('quote').description('Preview a cross-chain swap (positional: invictae quote 100 usdc@base eth@arbitrum)')
    )
        .option('--buyer <address>', 'recipient (defaults to zero placeholder for quoting)')
        .option('--json', 'print the quote as one JSON object on stdout', false)
        .action(async (amount, pay, receive, opts) => {
            const parsed = tradeOpts(opts, amount, pay, receive)
            const spin = spinner('quoting across venues…')
            let prep: Prepared
            try {
                prep = await prepare({ ...parsed, buyer: opts.buyer ?? ethers.ZeroAddress })
            } finally {
                spin.stop()
            }
            if (opts.json) {
                emitJson(quoteJson(prep))
                return
            }
            console.log(`\n${c.bold(`Swap ${parsed.amount} ${parsed.pay}${parsed.exactOut ? ' (exact-out)' : ''}`)}`)
            kv(await describe(prep, { ...opts, exactOut: parsed.exactOut }))
            console.log()
        })

    sharedTradeOptions(
        program.command('swap').description('Execute a cross-chain swap (positional: invictae swap 100 usdc@base eth@arbitrum --yes)')
    )
        .option('--buyer <address>', 'recipient on the destination chain (default: your signer)')
        .option('--max-fee <n>', 'CCTP fast-transfer fee budget in USDC units (cctp rail)', '0')
        .option('--min-finality <n>', 'CCTP finality: 2000 standard, 1000 fast (cctp rail)', '2000')
        .option('--yes', 'skip the confirmation prompt (required in non-interactive sessions)', false)
        .option('--allow-unverified', 'permit swapping tokens resolved via CoinGecko instead of the curated registry or an explicit address', false)
        .option('--idempotency-key <key>', 'refuse to broadcast twice for the same key (returns the original tx instead)')
        .option('--no-follow', 'do not stream the swap steps after broadcasting')
        .option('--json', 'emit NDJSON events on stdout: plan, tx, step, done', false)
        .option('--dry-run', 'print the wallet payloads instead of broadcasting', false)
        .action(async (amount, pay, receive, opts) => {
            const parsed = tradeOpts(opts, amount, pay, receive)
            const config = loadConfig()
            const srcChain = getChain(config, parsed.from)
            const dstChain = getChain(config, parsed.to)
            if (!srcChain.zap) throw new Error(`SourceZap is not deployed on ${srcChain.name} yet (config chains.json .zap)`)
            if (!dstChain.composer) throw new Error(`SwapComposer is not deployed on ${dstChain.name} yet (config chains.json .composer)`)

            const key = process.env.PRIVATE_KEY
            const signer = key ? new ethers.Wallet(key, provider(srcChain)) : undefined
            if (!signer && !opts.dryRun) throw new Error('PRIVATE_KEY missing — use --dry-run to print payloads')
            const buyer = opts.buyer ?? signer?.address
            if (!buyer) throw new Error('--buyer is required with --dry-run')

            const spin = spinner('quoting across venues…')
            let prep: Prepared
            try {
                prep = await prepare({ ...parsed, buyer })
            } finally {
                spin.stop()
            }
            if (opts.idempotencyKey) {
                const prior = findByKey(opts.idempotencyKey)
                if (prior) {
                    if (opts.json) emitJson({ event: 'duplicate', idempotencyKey: opts.idempotencyKey, txHash: prior.txHash, at: prior.at })
                    else note(`idempotency key already used — original tx ${prior.txHash}; nothing sent`)
                    return
                }
            }
            const loaded = loadPolicy()
            if (loaded && !opts.dryRun) {
                const verdict = enforcePolicy(loaded.policy, prep, buyer)
                if (verdict === 'escalate') {
                    if (!process.stdin.isTTY || opts.json) {
                        throw new Error(
                            `policy: this swap exceeds escalateAbove (${loaded.policy.escalateAbove} ${prep.stableKey.toUpperCase()}) and needs a human at an interactive terminal — run the same command there`
                        )
                    }
                    const approve = await confirm(
                        `${c.yellow('policy escalation:')} this swap moves more than ${loaded.policy.escalateAbove} ${prep.stableKey.toUpperCase()}. Approve it explicitly?`
                    )
                    if (!approve) {
                        note('escalation declined — nothing sent')
                        return
                    }
                } else if (!opts.json) note(`policy ok (${loaded.source})`)
            }
            if ((prep.payVia === 'coingecko' || prep.outVia === 'coingecko') && !opts.allowUnverified && !opts.dryRun) {
                const which = prep.payVia === 'coingecko' ? prep.payToken : prep.tokenOutResolved
                throw new Error(
                    `refusing to swap a token resolved via CoinGecko (${which}) — verify the address and pass it explicitly, or add --allow-unverified`
                )
            }
            const txs = buildSwapTxs(prep, { maxFee: opts.maxFee, minFinality: parseInt(opts.minFinality ?? '2000') })

            if (opts.json) {
                emitJson({ event: 'plan', buyer, ...quoteJson(prep), txs: opts.dryRun ? txs : txs.map((t) => t.label) })
            } else {
                console.log(`\n${c.bold(`Swap ${parsed.amount} ${parsed.pay} → ${parsed.tokenOut}`)}  ${c.dim(`buyer ${buyer}`)}`)
                kv(await describe(prep, { ...opts, exactOut: parsed.exactOut }))
            }

            if (opts.dryRun) {
                if (!opts.json) {
                    for (const tx of txs) {
                        console.log(`\n${c.dim(`// ${tx.label}`)}\n{ to: '${tx.to}', value: '${tx.value}', data: '${tx.data}' }`)
                    }
                }
                return
            }
            if (!opts.yes) {
                if (!process.stdin.isTTY || opts.json) {
                    throw new Error('non-interactive session: pass --yes to broadcast (or --dry-run to inspect)')
                }
                const go = await confirm(`\nBroadcast ${txs.length} transaction${txs.length > 1 ? 's' : ''} from ${signer!.address} on ${srcChain.name}?`)
                if (!go) {
                    note('aborted — nothing sent')
                    return
                }
            }

            let lastHash = ''
            for (const tx of txs) {
                const s = spinner(`${tx.label} — broadcasting…`)
                try {
                    const sent = await signer!.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
                    s.update(`${tx.label} — waiting for confirmation (${sent.hash.slice(0, 14)}…)`)
                    const rc = await sent.wait()
                    lastHash = rc!.hash
                    s.stop(`${c.green('✓')} ${tx.label}  ${c.dim(lastHash)}`)
                    if (opts.json) emitJson({ event: 'tx', label: tx.label, hash: lastHash })
                    if (tx === txs[txs.length - 1]) {
                        recordSwap({ at: Date.now(), txHash: lastHash, route: `${parsed.amount} ${parsed.pay}@${prep.srcChain.name} -> ${parsed.tokenOut}@${prep.dstChain.name}`, key: opts.idempotencyKey })
                    }
                } catch (err) {
                    s.stop(`${c.red('✗')} ${tx.label} failed: ${(err as Error).message}`)
                    if (opts.json) emitJson({ event: 'error', label: tx.label, message: (err as Error).message })
                    process.exit(1)
                }
            }

            if (opts.follow === false) {
                if (opts.json) emitJson({ event: 'done', followed: false, txHash: lastHash })
                else console.log(`Follow later with: ${c.cyan(`invictae watch --from ${srcChain.name} --tx ${lastHash}`)}`)
                return
            }
            if (!opts.json) note('\nfollowing the swap live (ctrl-c to stop; resume any time with invictae watch)…')
            let finalStep: string | undefined
            await trackSwap(srcChain.name, lastHash, (e) => {
                if (opts.json) emitJson({ event: 'step', ...e })
                else {
                    const t = new Date(e.at).toLocaleTimeString()
                    const mark = e.state === 'done' ? c.green('✓') : e.state === 'failed' ? c.red('✗') : c.dim('…')
                    console.log(`[${t}] ${mark} ${e.step} — ${e.detail}`)
                }
                if (e.final) finalStep = e.step
            })
            if (opts.json) emitJson({ event: 'done', followed: true, txHash: lastHash, outcome: finalStep })
            if (!opts.json && prep.rail === 'cctp') {
                note(`(if no relayer is running: invictae relay --from ${srcChain.name} --to ${dstChain.name} --tx ${lastHash})`)
            }
        })
}

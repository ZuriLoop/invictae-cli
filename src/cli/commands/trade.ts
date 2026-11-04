/** quote + swap: the trading commands. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { getChain, loadConfig, provider, ERC20_ABI } from '../../lib/common'
import { buildSwapTxs, prepare, type Prepared } from '../../lib/prepare'
import { trackSwap } from '../../lib/tracker'
import { c, confirm, kv, note, spinner } from '../ui'

export const sharedTradeOptions = (cmd: Command) =>
    cmd
        .requiredOption('--from <chain>', 'source chain')
        .requiredOption('--to <chain>', 'destination chain')
        .requiredOption('--pay <token>', "'eth'/'native', 'usdt'/'usdc', a registry symbol, or an ERC-20 address")
        .requiredOption('--amount <n>', 'amount of the pay token (of the OUT token with --exact-out)')
        .requiredOption('--token-out <token>', "'eth'/'native', a registry symbol, an address, or the stable itself (bridge-only)")
        .option('--stable <usdt|usdc>', 'bridge stable (default: the pay token, else usdc)')
        .option('--exact-out', 'treat --amount as the exact amount of token-out to receive', false)
        .option('--slippage-bps <n>', 'slippage tolerance per swap leg', '100')
        .option('--compose-gas <n>', 'destination compose gas', '600000')
        .option('--relay-fee-cap <n>', 'max stable the CCTP relayer may skim for gas (cctp rail)', '0')
        .option('--deadline-seconds <n>', 'order validity window', '1800')

export function tradeOpts(opts: Record<string, string>) {
    return {
        from: opts.from,
        to: opts.to,
        pay: opts.pay,
        amount: opts.amount,
        tokenOut: opts.tokenOut,
        stable: opts.stable,
        exactOut: Boolean(opts.exactOut),
        slippageBps: parseInt(opts.slippageBps),
        composeGas: parseInt(opts.composeGas),
        relayFeeCap: opts.relayFeeCap ?? '0',
        deadlineSeconds: parseInt(opts.deadlineSeconds),
    }
}

async function describe(prep: Prepared, opts: Record<string, string>): Promise<[string, string][]> {
    const outErc20 = new ethers.Contract(prep.tokenOutResolved, ERC20_ABI, provider(prep.dstChain))
    const [outSymRaw, outDec] = await Promise.all([outErc20.symbol(), outErc20.decimals()])
    const outSym = prep.tokenOut === ethers.constants.AddressZero ? `${outSymRaw} → native` : outSymRaw
    const rows: [string, string][] = []
    rows.push(['route', `${prep.srcChain.name} → ${prep.dstChain.name}`])
    if (prep.payVia === 'coingecko') {
        rows.push(['pay token', `${prep.payToken} ${c.yellow(`← '${opts.pay}' resolved via CoinGecko (${prep.payName}) — verify this address`)}`])
    }
    rows.push([
        'token out',
        `${prep.tokenOut === ethers.constants.AddressZero ? `native (unwraps ${prep.tokenOutResolved})` : prep.tokenOutResolved}` +
            (prep.outVia === 'coingecko' ? ` ${c.yellow(`← '${opts.tokenOut}' resolved via CoinGecko (${prep.outName}) — verify this address`)}` : ''),
    ])
    rows.push([
        'rail',
        prep.rail === 'cctp' ? c.cyan('CCTP v2 — lossless, relayer completes') : c.cyan(`LayerZero OFT (${prep.bridgeSrc.slice(0, 10)}…)`),
    ])
    if (prep.srcRoute) rows.push(['source swap', `${prep.srcRoute.venue} (tier ${prep.srcRoute.tier})`])
    rows.push(['arrives', `~${ethers.utils.formatUnits(prep.dstReceived, prep.dstStableDecimals)} ${prep.stableKey.toUpperCase()}`])
    if (!prep.feeAmount.isZero()) rows.push(['protocol fee', `${loadConfig().feeBps} bps`])
    if (!prep.maxRelayFee.isZero())
        rows.push(['relay fee cap', `${ethers.utils.formatUnits(prep.maxRelayFee, prep.dstStableDecimals)} ${prep.stableKey.toUpperCase()}`])
    if (Boolean(opts.exactOut)) {
        rows.push(['you pay (max)', `${ethers.utils.formatUnits(prep.amountIn, prep.payDecimals)} ${opts.pay}`])
        rows.push(['you receive', c.bold(`exactly ${ethers.utils.formatUnits(prep.minOut, outDec)} ${outSym}`)])
    } else {
        rows.push([
            'expected out',
            c.bold(`${ethers.utils.formatUnits(prep.expectedOut, outDec)} ${outSym}`) +
                (prep.dstRoute ? c.dim(` via ${prep.dstRoute.venue} (tier ${prep.dstRoute.tier})`) : ''),
        ])
        if (!prep.minOut.isZero())
            rows.push(['min out', `${ethers.utils.formatUnits(prep.minOut, outDec)} ${outSym} (${opts.slippageBps} bps)`])
    }
    rows.push([
        'bridge fee',
        prep.rail === 'oft' ? `${ethers.utils.formatEther(prep.lzFeeNative)} native (LayerZero)` : 'none (standard finality ~1–15 min)',
    ])
    return rows
}

export function registerTrade(program: Command): void {
    sharedTradeOptions(program.command('quote').description('Preview a cross-chain swap'))
        .option('--buyer <address>', 'recipient (defaults to zero placeholder for quoting)')
        .option('--json', 'print the prepared quote as JSON', false)
        .action(async (opts) => {
            const spin = spinner('quoting across venues…')
            let prep: Prepared
            try {
                prep = await prepare({ ...tradeOpts(opts), buyer: opts.buyer ?? ethers.constants.AddressZero })
            } finally {
                spin.stop()
            }
            if (opts.json) {
                console.log(
                    JSON.stringify(
                        {
                            rail: prep.rail,
                            from: prep.srcChain.name,
                            to: prep.dstChain.name,
                            amountIn: prep.amountIn.toString(),
                            arrives: prep.dstReceived.toString(),
                            expectedOut: prep.expectedOut.toString(),
                            minOut: prep.minOut.toString(),
                            srcVenue: prep.srcRoute?.venue ?? null,
                            dstVenue: prep.dstRoute?.venue ?? null,
                            lzFeeNative: prep.lzFeeNative.toString(),
                            deadline: prep.deadline,
                        },
                        null,
                        2
                    )
                )
                return
            }
            console.log(`\n${c.bold(`Swap ${opts.amount} ${opts.pay}${opts.exactOut ? ' (exact-out)' : ''}`)}`)
            kv(await describe(prep, opts))
            console.log()
        })

    sharedTradeOptions(program.command('swap').description('Execute a cross-chain swap through the SourceZap'))
        .option('--buyer <address>', 'recipient on the destination chain (default: your signer)')
        .option('--max-fee <n>', 'CCTP fast-transfer fee budget in USDC units (cctp rail)', '0')
        .option('--min-finality <n>', 'CCTP finality: 2000 standard, 1000 fast (cctp rail)', '2000')
        .option('--yes', 'skip the confirmation prompt', false)
        .option('--no-follow', 'do not stream the swap steps after broadcasting')
        .option('--dry-run', 'print the wallet payloads instead of broadcasting', false)
        .action(async (opts) => {
            const config = loadConfig()
            const srcChain = getChain(config, opts.from)
            const dstChain = getChain(config, opts.to)
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
                prep = await prepare({ ...tradeOpts(opts), buyer })
            } finally {
                spin.stop()
            }
            const txs = buildSwapTxs(prep, { maxFee: opts.maxFee, minFinality: parseInt(opts.minFinality ?? '2000') })

            console.log(`\n${c.bold(`Swap ${opts.amount} ${opts.pay} → ${opts.tokenOut}`)}  ${c.dim(`buyer ${buyer}`)}`)
            kv(await describe(prep, opts))

            if (opts.dryRun) {
                for (const tx of txs) {
                    console.log(`\n${c.dim(`// ${tx.label}`)}\n{ to: '${tx.to}', value: '${tx.value}', data: '${tx.data}' }`)
                }
                return
            }
            if (!opts.yes) {
                const go = await confirm(`\nBroadcast ${txs.length} transaction${txs.length > 1 ? 's' : ''} from ${signer!.address} on ${srcChain.name}?`)
                if (!go) {
                    note('aborted — nothing sent')
                    return
                }
            }

            let lastHash = ''
            for (const tx of txs) {
                const s = spinner(`${tx.label} — confirm in your wallet / broadcasting…`)
                try {
                    const sent = await signer!.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
                    s.update(`${tx.label} — waiting for confirmation (${sent.hash.slice(0, 14)}…)`)
                    const rc = await sent.wait()
                    lastHash = rc.transactionHash
                    s.stop(`${c.green('✓')} ${tx.label}  ${c.dim(lastHash)}`)
                } catch (err) {
                    s.stop(`${c.red('✗')} ${tx.label} failed: ${(err as Error).message}`)
                    process.exit(1)
                }
            }

            if (opts.follow === false) {
                console.log(`Follow later with: ${c.cyan(`invictae watch --from ${srcChain.name} --tx ${lastHash}`)}`)
                return
            }
            console.log(c.dim('\nfollowing the swap live (ctrl-c to stop; resume any time with invictae watch)…'))
            await trackSwap(srcChain.name, lastHash, (e) => {
                const t = new Date(e.at).toLocaleTimeString()
                const mark = e.state === 'done' ? c.green('✓') : e.state === 'failed' ? c.red('✗') : c.dim('…')
                console.log(`[${t}] ${mark} ${e.step} — ${e.detail}`)
            })
            if (prep.rail === 'cctp') {
                note(`(if no relayer is running: invictae relay --from ${srcChain.name} --to ${dstChain.name} --tx ${lastHash})`)
            }
        })
}

/** chains + tokens + venues + routes: discovery commands. */
import { Command } from 'commander'

import { getChain, loadConfig, loadTokens, pickBridge } from '../../lib/common'
import { c, emitJson, note, table } from '../ui'

export function registerInfo(program: Command): void {
    program
        .command('chains')
        .description('List configured chains, rails, and venues')
        .option('--json', 'print raw config entries', false)
        .action((opts) => {
            const config = loadConfig()
            if (opts.json) {
                console.log(JSON.stringify(config.chains, null, 2))
                return
            }
            table(
                ['chain', 'eid', 'stables', 'rails', 'venues', 'deployed'],
                config.chains.map((ch) => {
                    const venues = Object.entries(ch.venues).filter(([, v]) => v.router && v.quoter).map(([k]) => k)
                    const rails = [...Object.keys(ch.bridges), ...(ch.cctp ? ['cctp'] : [])]
                    const deployed = ch.composer && ch.zap ? c.green('yes') : c.dim('not yet')
                    return [ch.name, String(ch.lzEid), Object.keys(ch.stables).join(','), rails.join(','), venues.join(',') || c.dim('bridge-only'), deployed]
                })
            )
        })

    program
        .command('tokens [chain]')
        .description('Curated token registry (xStocks, Ondo, …) usable as --pay / --token-out symbols')
        .option('--json', 'print the registry as JSON', false)
        .action((chain: string | undefined, opts: { json: boolean }) => {
            const registry = loadTokens()
            if (opts.json) {
                emitJson(chain ? { [chain.toLowerCase()]: registry[chain.toLowerCase()] ?? {} } : registry)
                return
            }
            const names = chain ? [chain.toLowerCase()] : Object.keys(registry)
            for (const name of names) {
                const tokens = registry[name]
                if (!tokens) {
                    note(`${name}: no registry entries (any ERC-20 still works by address)`)
                    continue
                }
                console.log(c.bold(name))
                table(['symbol', 'address'], Object.entries(tokens).map(([sym, addr]) => [sym, c.dim(addr)]))
                console.log()
            }
        })

    program
        .command('venues')
        .description('Swap venues per chain and whether orders can route to them')
        .requiredOption('--chain <name>', 'chain to inspect')
        .option('--json', 'print venues as JSON', false)
        .action((opts) => {
            const chain = getChain(loadConfig(), opts.chain)
            if (opts.json) {
                emitJson(
                    Object.fromEntries(
                        Object.entries(chain.venues).map(([name, v]) => [
                            name,
                            { kind: v.kind, default: Boolean(v.default), routable: Boolean(v.router && v.quoter), router: v.router, quoter: v.quoter, tiers: v.tiers },
                        ])
                    )
                )
                return
            }
            table(
                ['venue', 'kind', 'routable', 'default', 'tiers', 'router'],
                Object.entries(chain.venues).map(([name, v]) => [
                    name,
                    v.kind,
                    v.router && v.quoter ? c.green('yes') : c.yellow(v.router ? 'no quoter' : 'needs adapter deploy'),
                    v.default ? '●' : '',
                    v.tiers.join('/'),
                    c.dim(v.router ?? v.underlyingRouter ?? '—'),
                ])
            )
            if (Object.keys(chain.venues).length === 0) note('bridge-only chain: stables in and out, no local swaps yet')
        })

    program
        .command('routes')
        .description('Which rails connect two chains, per stable')
        .requiredOption('--from <chain>', 'source chain')
        .requiredOption('--to <chain>', 'destination chain')
        .option('--json', 'print routes as JSON', false)
        .action((opts) => {
            const config = loadConfig()
            const src = getChain(config, opts.from)
            const dst = getChain(config, opts.to)
            if (opts.json) {
                const lanes: Record<string, { rail: string | null; kind: string | null }> = {}
                for (const stable of ['usdc', 'usdt'] as const) {
                    if (!src.stables[stable] || !dst.stables[stable]) lanes[stable] = { rail: null, kind: null }
                    else if (stable === 'usdc' && src.cctp && dst.cctp) lanes[stable] = { rail: 'cctp', kind: 'burn-mint' }
                    else {
                        try {
                            lanes[stable] = { rail: pickBridge(src, dst, stable).key, kind: 'oft-compose' }
                        } catch {
                            lanes[stable] = { rail: null, kind: null }
                        }
                    }
                }
                const venues = Object.entries(dst.venues).filter(([, v]) => v.router && v.quoter).map(([k]) => k)
                emitJson({ from: src.name, to: dst.name, lanes, destinationVenues: venues })
                return
            }
            const rows: string[][] = []
            for (const stable of ['usdc', 'usdt'] as const) {
                if (!src.stables[stable] || !dst.stables[stable]) {
                    rows.push([stable.toUpperCase(), c.dim('—'), c.dim(`${stable.toUpperCase()} not on both chains`)])
                    continue
                }
                if (stable === 'usdc' && src.cctp && dst.cctp) {
                    rows.push([stable.toUpperCase(), c.green('CCTP v2'), 'lossless burn/mint, ~1–15 min, relayer completes'])
                    continue
                }
                try {
                    const bridge = pickBridge(src, dst, stable)
                    rows.push([stable.toUpperCase(), c.green(bridge.key), 'OFT compose, fully on-chain, ~1–3 min'])
                } catch {
                    rows.push([stable.toUpperCase(), c.red('none'), 'no shared rail for this stable'])
                }
            }
            console.log(c.bold(`${src.name} → ${dst.name}`))
            table(['stable', 'rail', 'notes'], rows)
            const dstVenues = Object.entries(dst.venues).filter(([, v]) => v.router && v.quoter).length
            note(dstVenues > 0 ? `${dstVenues} routable venue(s) on ${dst.name} for the destination swap` : `${dst.name} is bridge-only today`)
        })
}

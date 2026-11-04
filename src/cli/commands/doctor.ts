/** doctor: validates environment, config, and on-chain wiring per chain. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { loadConfig, provider, type Chain } from '../../lib/common'
import { c, emitJson, fail, note, ok, warn } from '../ui'

const OFT_ABI = ['function token() view returns (address)']
const FACTORY_ABI = ['function factory() view returns (address)']
const COMPOSER_ABI = [
    'function composerToken(address) view returns (address)',
    'function allowedRouters(address) view returns (bool)',
    'function swapRouter() view returns (address)',
    'function paused() view returns (bool)',
]
const ZAP_ABI_MIN = [
    'function bridgeToken(address) view returns (address)',
    'function allowedRouters(address) view returns (bool)',
    'function tokenMessenger() view returns (address)',
]

interface Check {
    level: 'ok' | 'warn' | 'fail'
    detail: string
}

async function checkChain(chain: Chain, human: boolean): Promise<Check[]> {
    if (human) console.log(`\n${c.bold(chain.name)}`)
    const checks: Check[] = []
    const report = (level: Check['level'], detail: string) => {
        checks.push({ level, detail })
        if (human) (level === 'ok' ? ok : level === 'warn' ? warn : fail)(detail)
    }
    const p = provider(chain)

    // RPC + identity
    try {
        const net = await p.getNetwork()
        if (net.chainId !== chain.chainId) {
            report('fail', `RPC answers chainId ${net.chainId}, config says ${chain.chainId}`)
            return checks
        }
        report('ok', `RPC reachable (${process.env[chain.rpcEnv] ? chain.rpcEnv : 'public fallback'}), chainId ${net.chainId}`)
    } catch (err) {
        report('fail', `RPC unreachable: ${(err as Error).message.slice(0, 80)}`)
        return checks
    }

    // LayerZero endpoint
    if ((await p.getCode(chain.lzEndpoint)) === '0x') report('fail', `LayerZero endpoint has no code at ${chain.lzEndpoint}`)
    else report('ok', 'LayerZero endpoint present')

    // Bridges deliver the configured stables
    for (const [name, bridge] of Object.entries(chain.bridges)) {
        try {
            const tok: string = await new ethers.Contract(bridge.oApp, OFT_ABI, p).token()
            const want = chain.stables[bridge.stable]
            if (tok.toLowerCase() === want.toLowerCase()) report('ok', `bridge ${name} wraps ${bridge.stable.toUpperCase()}`)
            else report('fail', `bridge ${name}: token() = ${tok}, config says ${want}`)
        } catch {
            report('fail', `bridge ${name}: token() probe failed at ${bridge.oApp}`)
        }
    }

    // Venues: router and quoter agree on a factory
    for (const [name, venue] of Object.entries(chain.venues)) {
        if (!venue.router || !venue.quoter) {
            report('warn', `venue ${name}: not routable yet (${!venue.router ? 'router unset — deploy its adapter' : 'quoter unset'})`)
            continue
        }
        try {
            const [rf, qf] = await Promise.all([
                new ethers.Contract(venue.router, FACTORY_ABI, p).factory(),
                new ethers.Contract(venue.quoter, FACTORY_ABI, p).factory(),
            ])
            if (rf === qf) report('ok', `venue ${name}: router/quoter factories match`)
            else report('fail', `venue ${name}: router factory ${rf} != quoter factory ${qf}`)
        } catch {
            // adapters (shims) have no factory(); verify code exists instead
            if ((await p.getCode(venue.router)) !== '0x') report('ok', `venue ${name}: adapter code present`)
            else report('fail', `venue ${name}: no code at router ${venue.router}`)
        }
    }

    // Deployed contracts and their wiring
    if (!chain.composer) report('warn', 'SwapComposer not deployed (chains.json .composer is null)')
    else {
        const composer = new ethers.Contract(chain.composer, COMPOSER_ABI, p)
        try {
            if (await composer.paused()) report('warn', 'composer is PAUSED')
            for (const [name, bridge] of Object.entries(chain.bridges)) {
                const mapped: string = await composer.composerToken(bridge.oApp)
                const want = chain.stables[bridge.stable]
                if (mapped.toLowerCase() === want.toLowerCase()) report('ok', `composer trusts ${name}`)
                else report('fail', `composer does not trust ${name} (setComposer missing)`)
            }
            const defaultRouter: string = await composer.swapRouter()
            for (const [name, venue] of Object.entries(chain.venues)) {
                if (!venue.router) continue
                if (venue.router.toLowerCase() === defaultRouter.toLowerCase()) report('ok', `venue ${name} is the composer default`)
                else if (await composer.allowedRouters(venue.router)) report('ok', `venue ${name} allowlisted on the composer`)
                else report('fail', `venue ${name} not allowlisted (setRouterAllowed missing)`)
            }
        } catch (err) {
            report('fail', `composer probes failed at ${chain.composer}: ${(err as Error).message.slice(0, 60)}`)
        }
    }
    if (!chain.zap) report('warn', 'SourceZap not deployed (chains.json .zap is null)')
    else {
        const zap = new ethers.Contract(chain.zap, ZAP_ABI_MIN, p)
        try {
            for (const [name, bridge] of Object.entries(chain.bridges)) {
                const mapped: string = await zap.bridgeToken(bridge.oApp)
                if (mapped !== ethers.constants.AddressZero) report('ok', `zap allowlists ${name}`)
                else report('fail', `zap does not allowlist ${name} (setBridge missing)`)
            }
            if (chain.cctp) {
                const messenger: string = await zap.tokenMessenger()
                if (messenger.toLowerCase() === chain.cctp.tokenMessengerV2.toLowerCase()) report('ok', 'zap CCTP configured')
                else report('fail', 'zap CCTP not configured (setCctp missing)')
            }
        } catch (err) {
            report('fail', `zap probes failed at ${chain.zap}: ${(err as Error).message.slice(0, 60)}`)
        }
    }
    return checks
}

export function registerDoctor(program: Command): void {
    program
        .command('doctor')
        .description('Check environment, config, and on-chain wiring (all chains, or one with --chain)')
        .option('--chain <name>', 'limit the check to one chain')
        .option('--json', 'print all checks as one JSON object', false)
        .action(async (opts) => {
            const config = loadConfig()
            const human = !opts.json
            const signer = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY).address : null
            if (human) {
                console.log(c.bold('environment'))
                if (signer) ok(`PRIVATE_KEY set (signer ${signer})`)
                else warn('PRIVATE_KEY not set — quote/watch work, swap/relay/claim need it')
                note(`protocol fee: ${config.feeBps} bps · ${config.chains.length} chains configured`)
            }

            const chains = opts.chain
                ? [config.chains.find((ch) => ch.name === String(opts.chain).toLowerCase())].filter((x): x is Chain => Boolean(x))
                : config.chains
            if (chains.length === 0) throw new Error(`unknown chain '${opts.chain}'`)

            const results: Record<string, Check[]> = {}
            for (const chain of chains) {
                results[chain.name] = await checkChain(chain, human)
            }
            const failed = Object.values(results).some((checks) => checks.some((x) => x.level === 'fail'))

            if (opts.json) {
                emitJson({ signer, feeBps: config.feeBps, ok: !failed, chains: results })
            } else {
                console.log()
                if (!failed) ok(c.bold('all checks passed'))
                else fail(c.bold('some checks failed — see above'))
            }
            if (failed) process.exitCode = 1
        })
}

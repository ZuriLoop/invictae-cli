/** doctor: validates environment, config, and on-chain wiring per chain. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { loadConfig, provider, type Chain } from '../../lib/common'
import { c, fail, note, ok, warn } from '../ui'

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

async function checkChain(chain: Chain): Promise<boolean> {
    console.log(`\n${c.bold(chain.name)}`)
    let healthy = true
    const p = provider(chain)

    // RPC + identity
    try {
        const net = await p.getNetwork()
        if (net.chainId !== chain.chainId) {
            fail(`RPC answers chainId ${net.chainId}, config says ${chain.chainId}`)
            return false
        }
        ok(`RPC reachable (${process.env[chain.rpcEnv] ? chain.rpcEnv : 'public fallback'}), chainId ${net.chainId}`)
    } catch (err) {
        fail(`RPC unreachable: ${(err as Error).message.slice(0, 80)}`)
        return false
    }

    // LayerZero endpoint
    if ((await p.getCode(chain.lzEndpoint)) === '0x') {
        fail(`LayerZero endpoint has no code at ${chain.lzEndpoint}`)
        healthy = false
    } else ok('LayerZero endpoint present')

    // Bridges deliver the configured stables
    for (const [name, bridge] of Object.entries(chain.bridges)) {
        try {
            const tok: string = await new ethers.Contract(bridge.oApp, OFT_ABI, p).token()
            const want = chain.stables[bridge.stable]
            if (tok.toLowerCase() === want.toLowerCase()) ok(`bridge ${name} wraps ${bridge.stable.toUpperCase()}`)
            else {
                fail(`bridge ${name}: token() = ${tok}, config says ${want}`)
                healthy = false
            }
        } catch {
            fail(`bridge ${name}: token() probe failed at ${bridge.oApp}`)
            healthy = false
        }
    }

    // Venues: router and quoter agree on a factory
    for (const [name, venue] of Object.entries(chain.venues)) {
        if (!venue.router || !venue.quoter) {
            warn(`venue ${name}: not routable yet (${!venue.router ? 'router unset — deploy its adapter' : 'quoter unset'})`)
            continue
        }
        try {
            const [rf, qf] = await Promise.all([
                new ethers.Contract(venue.router, FACTORY_ABI, p).factory(),
                new ethers.Contract(venue.quoter, FACTORY_ABI, p).factory(),
            ])
            if (rf === qf) ok(`venue ${name}: router/quoter factories match`)
            else {
                fail(`venue ${name}: router factory ${rf} != quoter factory ${qf}`)
                healthy = false
            }
        } catch {
            // adapters (shims) have no factory(); verify code exists instead
            if ((await p.getCode(venue.router)) !== '0x') ok(`venue ${name}: adapter code present`)
            else {
                fail(`venue ${name}: no code at router ${venue.router}`)
                healthy = false
            }
        }
    }

    // Deployed contracts and their wiring
    if (!chain.composer) warn('SwapComposer not deployed (chains.json .composer is null)')
    else {
        const composer = new ethers.Contract(chain.composer, COMPOSER_ABI, p)
        try {
            if (await composer.paused()) warn('composer is PAUSED')
            for (const [name, bridge] of Object.entries(chain.bridges)) {
                const mapped: string = await composer.composerToken(bridge.oApp)
                const want = chain.stables[bridge.stable]
                if (mapped.toLowerCase() === want.toLowerCase()) ok(`composer trusts ${name}`)
                else {
                    fail(`composer does not trust ${name} (setComposer missing)`)
                    healthy = false
                }
            }
            const defaultRouter: string = await composer.swapRouter()
            for (const [name, venue] of Object.entries(chain.venues)) {
                if (!venue.router) continue
                if (venue.router.toLowerCase() === defaultRouter.toLowerCase()) ok(`venue ${name} is the composer default`)
                else if (await composer.allowedRouters(venue.router)) ok(`venue ${name} allowlisted on the composer`)
                else {
                    fail(`venue ${name} not allowlisted (setRouterAllowed missing)`)
                    healthy = false
                }
            }
        } catch (err) {
            fail(`composer probes failed at ${chain.composer}: ${(err as Error).message.slice(0, 60)}`)
            healthy = false
        }
    }
    if (!chain.zap) warn('SourceZap not deployed (chains.json .zap is null)')
    else {
        const zap = new ethers.Contract(chain.zap, ZAP_ABI_MIN, p)
        try {
            for (const [name, bridge] of Object.entries(chain.bridges)) {
                const mapped: string = await zap.bridgeToken(bridge.oApp)
                if (mapped !== ethers.constants.AddressZero) ok(`zap allowlists ${name}`)
                else {
                    fail(`zap does not allowlist ${name} (setBridge missing)`)
                    healthy = false
                }
            }
            if (chain.cctp) {
                const messenger: string = await zap.tokenMessenger()
                if (messenger.toLowerCase() === chain.cctp.tokenMessengerV2.toLowerCase()) ok('zap CCTP configured')
                else {
                    fail('zap CCTP not configured (setCctp missing)')
                    healthy = false
                }
            }
        } catch (err) {
            fail(`zap probes failed at ${chain.zap}: ${(err as Error).message.slice(0, 60)}`)
            healthy = false
        }
    }
    return healthy
}

export function registerDoctor(program: Command): void {
    program
        .command('doctor')
        .description('Check environment, config, and on-chain wiring (all chains, or one with --chain)')
        .option('--chain <name>', 'limit the check to one chain')
        .action(async (opts) => {
            const config = loadConfig()
            console.log(c.bold('environment'))
            if (process.env.PRIVATE_KEY) ok(`PRIVATE_KEY set (signer ${new ethers.Wallet(process.env.PRIVATE_KEY).address})`)
            else warn('PRIVATE_KEY not set — quote/watch work, swap/relay/claim need it')
            note(`protocol fee: ${config.feeBps} bps · ${config.chains.length} chains configured`)

            const chains = opts.chain ? config.chains.filter((ch) => ch.name === opts.chain.toLowerCase()) : config.chains
            if (chains.length === 0) throw new Error(`unknown chain '${opts.chain}'`)
            let allHealthy = true
            for (const chain of chains) {
                allHealthy = (await checkChain(chain)) && allHealthy
            }
            console.log()
            if (allHealthy) ok(c.bold('all checks passed'))
            else {
                fail(c.bold('some checks failed — see above'))
                process.exitCode = 1
            }
        })
}

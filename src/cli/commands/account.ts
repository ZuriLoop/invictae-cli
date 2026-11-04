/** balances + refunds/claim + history: account commands. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { getChain, loadConfig, loadTokens, provider, resolveToken, ERC20_ABI } from '../../lib/common'
import { c, emitJson, note, ok, table } from '../ui'

const COMPOSER_READ_ABI = [
    'function refundsOwed(address token, address account) view returns (uint256)',
    'function claimRefund(address token, address to)',
    'event SwapExecuted(address indexed buyer, address indexed tokenOut, address tokenIn, uint256 amountIn, uint256 amountOut)',
    'event SwapRefunded(address indexed recipient, address tokenIn, uint256 amountIn, bytes reason)',
    'event RefundEscrowed(address indexed recipient, address tokenIn, uint256 amountIn, bytes reason)',
    'event RefundClaimed(address indexed recipient, address tokenIn, uint256 amount)',
]

function resolveAddress(explicit?: string): string {
    if (explicit) return ethers.getAddress(explicit)
    const key = process.env.PRIVATE_KEY
    if (!key) throw new Error('pass --address or set PRIVATE_KEY')
    return new ethers.Wallet(key).address
}

export function registerAccount(program: Command): void {
    program
        .command('balances')
        .description('Native, stable, and registry-token balances on a chain')
        .requiredOption('--chain <name>', 'chain to inspect')
        .option('--address <address>', 'account (default: your signer)')
        .option('--json', 'print balances as JSON', false)
        .action(async (opts) => {
            const chain = getChain(loadConfig(), opts.chain)
            const who = resolveAddress(opts.address)
            const p = provider(chain)
            if (!opts.json) console.log(`${c.bold(chain.name)}  ${c.dim(who)}`)

            const json: Record<string, { amount: string; address?: string; decimals?: number }> = {}
            const rows: string[][] = []
            const native = await p.getBalance(who)
            json.native = { amount: native.toString(), decimals: 18 }
            rows.push(['native', ethers.formatEther(native), ''])

            const entries: [string, string][] = [
                ...Object.entries(chain.stables),
                ...Object.entries(loadTokens()[chain.name] ?? {}),
            ]
            for (const [sym, addr] of entries) {
                try {
                    const t = new ethers.Contract(addr, ERC20_ABI, p)
                    const [bal, decRaw] = await Promise.all([t.balanceOf(who), t.decimals()])
                    const dec = Number(decRaw)
                    if (bal === 0n) continue
                    json[sym] = { amount: bal.toString(), address: addr, decimals: dec }
                    rows.push([sym, ethers.formatUnits(bal, dec), c.dim(addr)])
                } catch {
                    // unreadable token — skip
                }
            }
            if (opts.json) {
                emitJson({ chain: chain.name, address: who, balances: json })
                return
            }
            table(['asset', 'balance', 'address'], rows)
            if (rows.length === 1) note('(zero balances in the registry are hidden)')
        })

    program
        .command('refunds')
        .description('Escrowed refunds owed to an account on a chain (and how to claim)')
        .requiredOption('--chain <name>', 'chain of the composer')
        .option('--address <address>', 'account (default: your signer)')
        .option('--claim', 'claim everything found (needs PRIVATE_KEY for gas; payout goes to the account)', false)
        .option('--json', 'print owed refunds (and claim tx hashes) as JSON', false)
        .action(async (opts) => {
            const chain = getChain(loadConfig(), opts.chain)
            if (!chain.composer) throw new Error(`SwapComposer is not deployed on ${chain.name}`)
            const who = resolveAddress(opts.address)
            const p = provider(chain)
            const composer = new ethers.Contract(chain.composer, COMPOSER_READ_ABI, p)

            const candidates: [string, string][] = [
                ...Object.entries(chain.stables),
                ...(chain.wrappedNative ? ([['wrapped native', chain.wrappedNative]] as [string, string][]) : []),
            ]
            const owed: { sym: string; addr: string; amount: bigint; dec: number }[] = []
            for (const [sym, addr] of candidates) {
                const amount: bigint = await composer.refundsOwed(addr, who)
                if (amount === 0n) continue
                const dec: number = Number(await new ethers.Contract(addr, ERC20_ABI, p).decimals())
                owed.push({ sym, addr, amount, dec })
            }
            if (owed.length === 0) {
                if (opts.json) emitJson({ chain: chain.name, address: who, owed: [] })
                else ok(`no escrowed refunds for ${who} on ${chain.name}`)
                return
            }
            if (opts.json && !opts.claim) {
                emitJson({ chain: chain.name, address: who, owed: owed.map((o) => ({ token: o.addr, symbol: o.sym, amount: o.amount.toString(), decimals: o.dec })) })
                return
            }
            if (!opts.json) table(['token', 'owed'], owed.map((o) => [o.sym, ethers.formatUnits(o.amount, o.dec)]))
            if (!opts.claim) {
                note(`claim with: invictae refunds --chain ${chain.name} --address ${who} --claim`)
                return
            }
            const key = process.env.PRIVATE_KEY
            if (!key) throw new Error('PRIVATE_KEY missing (claiming is permissionless but someone must pay gas)')
            const signer = new ethers.Wallet(key, p)
            const claims: { token: string; amount: string; txHash: string }[] = []
            for (const o of owed) {
                const tx = await (composer.connect(signer) as ethers.Contract).getFunction('claimRefund')(o.addr, who)
                const rc = await tx.wait()
                claims.push({ token: o.addr, amount: o.amount.toString(), txHash: rc!.hash })
                ok(`claimed ${ethers.formatUnits(o.amount, o.dec)} ${o.sym} → ${who}  ${c.dim(rc.transactionHash)}`)
            }
            if (opts.json) emitJson({ chain: chain.name, address: who, claimed: claims })
        })

    program
        .command('history')
        .description("An account's recent swap outcomes on a destination chain")
        .requiredOption('--chain <name>', 'chain of the composer')
        .option('--address <address>', 'account (default: your signer)')
        .option('--blocks <n>', 'how far back to scan', '9000')
        .option('--json', 'print outcomes as JSON', false)
        .action(async (opts) => {
            const chain = getChain(loadConfig(), opts.chain)
            if (!chain.composer) throw new Error(`SwapComposer is not deployed on ${chain.name}`)
            const who = resolveAddress(opts.address)
            const p = provider(chain)
            const composer = new ethers.Contract(chain.composer, COMPOSER_READ_ABI, p)
            const latest = await p.getBlockNumber()
            const from = Math.max(0, latest - parseInt(opts.blocks))

            const rows: [number, string[]][] = []
            const jsonRows: { block: number; outcome: string; txHash: string; args: Record<string, string> }[] = []
            const push = async (eventName: string, label: string, fmt: (a: ethers.Result) => string) => {
                const events = await composer.queryFilter(composer.filters[eventName](who), from, latest)
                for (const e of events) {
                    if (!('args' in e)) continue
                    rows.push([e.blockNumber, [String(e.blockNumber), label, fmt(e.args), c.dim(e.transactionHash)]])
                    jsonRows.push({
                        block: e.blockNumber,
                        outcome: eventName,
                        txHash: e.transactionHash,
                        args: Object.fromEntries(Object.entries(e.args.toObject()).map(([k, v]) => [k, String(v)])),
                    })
                }
            }
            await push('SwapExecuted', c.green('executed'), (a) => `${a.amountOut.toString()} of ${a.tokenOut}`)
            await push('SwapRefunded', c.yellow('refunded'), (a) => `${a.amountIn.toString()} of ${a.tokenIn}`)
            await push('RefundEscrowed', c.yellow('escrowed'), (a) => `${a.amountIn.toString()} of ${a.tokenIn}`)
            await push('RefundClaimed', c.green('claimed'), (a) => `${a.amount.toString()} of ${a.tokenIn}`)

            if (opts.json) {
                jsonRows.sort((a, b) => a.block - b.block)
                emitJson({ chain: chain.name, address: who, fromBlock: from, toBlock: latest, outcomes: jsonRows })
                return
            }
            if (rows.length === 0) {
                note(`no outcomes for ${who} on ${chain.name} in the last ${opts.blocks} blocks`)
                return
            }
            rows.sort((a, b) => a[0] - b[0])
            table(['block', 'outcome', 'amount', 'tx'], rows.map(([, r]) => r))
        })
}

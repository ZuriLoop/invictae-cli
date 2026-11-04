/** balances + refunds/claim + history: account commands. */
import { Command } from 'commander'
import { ethers } from 'ethers'

import { getChain, loadConfig, loadTokens, provider, resolveToken, ERC20_ABI } from '../../lib/common'
import { c, kv, note, ok, table } from '../ui'

const COMPOSER_READ_ABI = [
    'function refundsOwed(address token, address account) view returns (uint256)',
    'function claimRefund(address token, address to)',
    'event SwapExecuted(address indexed buyer, address indexed tokenOut, address tokenIn, uint256 amountIn, uint256 amountOut)',
    'event SwapRefunded(address indexed recipient, address tokenIn, uint256 amountIn, bytes reason)',
    'event RefundEscrowed(address indexed recipient, address tokenIn, uint256 amountIn, bytes reason)',
    'event RefundClaimed(address indexed recipient, address tokenIn, uint256 amount)',
]

function resolveAddress(explicit?: string): string {
    if (explicit) return ethers.utils.getAddress(explicit)
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
        .action(async (opts) => {
            const chain = getChain(loadConfig(), opts.chain)
            const who = resolveAddress(opts.address)
            const p = provider(chain)
            console.log(`${c.bold(chain.name)}  ${c.dim(who)}`)

            const rows: string[][] = []
            const native = await p.getBalance(who)
            rows.push(['native', ethers.utils.formatEther(native), ''])

            const entries: [string, string][] = [
                ...Object.entries(chain.stables),
                ...Object.entries(loadTokens()[chain.name] ?? {}),
            ]
            for (const [sym, addr] of entries) {
                try {
                    const t = new ethers.Contract(addr, ERC20_ABI, p)
                    const [bal, dec] = await Promise.all([t.balanceOf(who), t.decimals()])
                    if (bal.isZero()) continue
                    rows.push([sym, ethers.utils.formatUnits(bal, dec), c.dim(addr)])
                } catch {
                    // unreadable token — skip
                }
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
            const owed: { sym: string; addr: string; amount: ethers.BigNumber; dec: number }[] = []
            for (const [sym, addr] of candidates) {
                const amount: ethers.BigNumber = await composer.refundsOwed(addr, who)
                if (amount.isZero()) continue
                const dec: number = await new ethers.Contract(addr, ERC20_ABI, p).decimals()
                owed.push({ sym, addr, amount, dec })
            }
            if (owed.length === 0) {
                ok(`no escrowed refunds for ${who} on ${chain.name}`)
                return
            }
            table(['token', 'owed'], owed.map((o) => [o.sym, ethers.utils.formatUnits(o.amount, o.dec)]))
            if (!opts.claim) {
                note(`claim with: invictae refunds --chain ${chain.name} --address ${who} --claim`)
                return
            }
            const key = process.env.PRIVATE_KEY
            if (!key) throw new Error('PRIVATE_KEY missing (claiming is permissionless but someone must pay gas)')
            const signer = new ethers.Wallet(key, p)
            for (const o of owed) {
                const tx = await composer.connect(signer).claimRefund(o.addr, who)
                const rc = await tx.wait()
                ok(`claimed ${ethers.utils.formatUnits(o.amount, o.dec)} ${o.sym} → ${who}  ${c.dim(rc.transactionHash)}`)
            }
        })

    program
        .command('history')
        .description("An account's recent swap outcomes on a destination chain")
        .requiredOption('--chain <name>', 'chain of the composer')
        .option('--address <address>', 'account (default: your signer)')
        .option('--blocks <n>', 'how far back to scan', '9000')
        .action(async (opts) => {
            const chain = getChain(loadConfig(), opts.chain)
            if (!chain.composer) throw new Error(`SwapComposer is not deployed on ${chain.name}`)
            const who = resolveAddress(opts.address)
            const p = provider(chain)
            const composer = new ethers.Contract(chain.composer, COMPOSER_READ_ABI, p)
            const latest = await p.getBlockNumber()
            const from = Math.max(0, latest - parseInt(opts.blocks))

            const rows: [number, string[]][] = []
            const push = async (eventName: string, label: string, fmt: (a: ethers.utils.Result) => string) => {
                const events = await composer.queryFilter(composer.filters[eventName](who), from, latest)
                for (const e of events) rows.push([e.blockNumber, [String(e.blockNumber), label, fmt(e.args!), c.dim(e.transactionHash)]])
            }
            await push('SwapExecuted', c.green('executed'), (a) => `${a.amountOut.toString()} of ${a.tokenOut}`)
            await push('SwapRefunded', c.yellow('refunded'), (a) => `${a.amountIn.toString()} of ${a.tokenIn}`)
            await push('RefundEscrowed', c.yellow('escrowed'), (a) => `${a.amountIn.toString()} of ${a.tokenIn}`)
            await push('RefundClaimed', c.green('claimed'), (a) => `${a.amount.toString()} of ${a.tokenIn}`)

            if (rows.length === 0) {
                note(`no outcomes for ${who} on ${chain.name} in the last ${opts.blocks} blocks`)
                return
            }
            rows.sort((a, b) => a[0] - b[0])
            table(['block', 'outcome', 'amount', 'tx'], rows.map(([, r]) => r))
        })
}

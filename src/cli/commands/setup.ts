/** demo + init: the first-run experience. */
import fs from 'fs'
import path from 'path'

import { Command } from 'commander'
import { ethers } from 'ethers'

import { loadConfig, provider, ERC20_ABI } from '../../lib/common'
import { prepare } from '../../lib/prepare'
import { c, kv, note, ok, spinner, warn } from '../ui'

export function printWelcome(): void {
    console.log(`
${c.bold('invictae')} — cross-chain swaps in one command
${c.dim('stables · native coins · blue chips · tokenized stocks · 12 chains')}

Try it right now (live mainnet data, nothing signed, no key needed):

  ${c.cyan('npx invictae demo')}
  ${c.cyan('npx invictae quote 100 usdc@base eth@arbitrum')}
  ${c.cyan('npx invictae chains')}

Then: ${c.dim('invictae --help')} for everything, ${c.dim('invictae init')} to set up signing.
`)
}

export function registerSetup(program: Command): void {
    program
        .command('demo')
        .description('A 30-second live demonstration — real quotes from mainnet, nothing signed')
        .action(async () => {
            const config = loadConfig()
            console.log(`\n${c.bold('Live quotes from mainnet')} ${c.dim('(read-only — no key, no funds, no signatures)')}\n`)

            const demos: { label: string; args: Parameters<typeof prepare>[0] }[] = [
                {
                    label: '100 USDC on Base → ETH on Arbitrum',
                    args: { from: 'base', to: 'arbitrum', pay: 'usdc', amount: '100', tokenOut: 'eth', exactOut: false, slippageBps: 100, composeGas: 600_000, relayFeeCap: '0', deadlineSeconds: 1800, buyer: ethers.constants.AddressZero },
                },
                {
                    label: '1000 USDT on Ethereum → LINK on Arbitrum',
                    args: { from: 'ethereum', to: 'arbitrum', pay: 'usdt', amount: '1000', tokenOut: 'LINK', exactOut: false, slippageBps: 100, composeGas: 600_000, relayFeeCap: '0', deadlineSeconds: 1800, buyer: ethers.constants.AddressZero },
                },
            ]

            for (const d of demos) {
                const spin = spinner(`quoting: ${d.label} …`)
                try {
                    const prep = await prepare(d.args)
                    const outErc20 = new ethers.Contract(prep.tokenOutResolved, ERC20_ABI, provider(prep.dstChain))
                    const [sym, dec] = await Promise.all([outErc20.symbol(), outErc20.decimals()])
                    spin.stop()
                    console.log(c.bold(`  ${d.label}`))
                    kv([
                        ['rail', prep.rail === 'cctp' ? 'CCTP burn/mint — arrives whole, zero bridge fee' : 'token bridge — fully on-chain'],
                        ['you receive', c.green(`~${ethers.utils.formatUnits(prep.expectedOut, dec)} ${sym}`) + c.dim(` via ${prep.dstRoute?.venue ?? 'bridge'}`)],
                        ['protocol fee', `${config.feeBps} bps (0.0${config.feeBps}%)`],
                    ])
                    console.log()
                } catch (err) {
                    spin.stop(`${c.yellow('!')} ${d.label}: ${(err as Error).message.slice(0, 80)}`)
                }
            }
            console.log(`${c.dim('Those numbers came from live pools across venues, scanned just now.')}
Next:
  ${c.cyan('invictae quote <amount> <token>@<chain> <token>@<chain>')}   any route you like
  ${c.cyan('invictae tokens ethereum')}                                  tickers incl. tokenized stocks
  ${c.cyan('invictae init')}                                             set up signing + guardrails
`)
        })

    program
        .command('init')
        .description('Set up signing and guardrails: writes .env and invictae.policy.json templates')
        .option('--force', 'overwrite existing files', false)
        .action((opts) => {
            const envPath = path.resolve(process.cwd(), '.env')
            const policyFile = path.resolve(process.cwd(), 'invictae.policy.json')

            if (!fs.existsSync(envPath) || opts.force) {
                fs.writeFileSync(
                    envPath,
                    `# invictae configuration — see https://github.com/ZuriLoop/invictae-cli#readme
# Signing key (only needed for swap / relay / refunds --claim). Keep this file out of version control.
PRIVATE_KEY=

# Optional dedicated RPCs (public fallbacks are used when unset)
RPC_URL_ETH_MAINNET=
RPC_URL_BASE_MAINNET=
RPC_URL_ARB_MAINNET=
`
                )
                ok(`wrote ${envPath}`)
            } else {
                warn('.env exists — left untouched (use --force to overwrite)')
            }

            if (!fs.existsSync(policyFile) || opts.force) {
                fs.writeFileSync(
                    policyFile,
                    JSON.stringify(
                        {
                            maxStablePerSwap: '1000',
                            maxSwapsPerDay: 20,
                            registryTokensOnly: true,
                        },
                        null,
                        2
                    ) + '\n'
                )
                ok(`wrote ${policyFile} — guardrails enforced before any transaction is built`)
            } else {
                warn('invictae.policy.json exists — left untouched (use --force to overwrite)')
            }

            note('\nnext steps:')
            console.log(`  1. put a key in .env           ${c.dim('(or leave empty — quotes and tracking never need one)')}
  2. ${c.cyan('invictae doctor')}             ${c.dim('verify every chain is reachable and wired')}
  3. ${c.cyan('invictae quote 100 usdc@base eth@arbitrum')}`)
        })
}

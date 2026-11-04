#!/usr/bin/env node
/**
 * invictae — cross-chain swaps.
 *
 * Trading        quote · swap
 * Lifecycle      watch · status · relay
 * Discovery      chains · routes · venues · tokens
 * Account        balances · refunds · history
 * Operations     doctor
 */
import 'dotenv/config'

import fs from 'fs'
import path from 'path'

import { Command } from 'commander'

import { registerTrade } from './commands/trade'
import { registerTrack } from './commands/track'
import { registerInfo } from './commands/info'
import { registerAccount } from './commands/account'
import { registerDoctor } from './commands/doctor'
import { c } from './ui'

const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))

const program = new Command()
program
    .name('invictae')
    .description('Cross-chain swaps — stables, native coins, blue chips, tokenized stocks')
    .version(pkg.version, '-v, --version')
    .addHelpText(
        'after',
        `
Examples:
  $ invictae quote --from base --to bnb --pay usdc --amount 100 --token-out WBNB
  $ invictae swap  --from base --to arbitrum --pay eth --amount 0.5 --token-out eth
  $ invictae swap  --from ethereum --to bnb --pay usdt --amount 1000 --token-out TSLAon --exact-out
  $ invictae watch --from base --tx 0x…
  $ invictae refunds --chain arbitrum --claim
  $ invictae doctor

Environment: .env with RPC_URL_* (public fallbacks exist) and PRIVATE_KEY for signing.`
    )

program
    .command('schema')
    .description('Machine-readable description of every command, input, and output shape (for agents)')
    .action(() => {
        const schema = {
            name: 'invictae',
            version: pkg.version,
            conventions: {
                stdout: 'data only when --json is passed (one JSON object, or NDJSON for streams); human tables otherwise',
                stderr: 'progress, spinners, and warnings — never parse it',
                exitCodes: { '0': 'success', '1': 'error or failed checks' },
                tokens: "tickers (registry first, CoinGecko fallback re-verified on-chain), 'eth'/'native', wrapped symbols, or ERC-20 addresses",
                chains: 'names, aliases (eth,bsc,arb,op,matic,avax,hype,uni), chain ids, or endpoint ids',
                positional: 'quote/swap accept: AMOUNT TOKEN@CHAIN TOKEN@CHAIN',
                nonInteractive: 'swap requires --yes when stdin is not a TTY or --json is passed; --dry-run never signs',
            },
            commands: {
                quote: { args: '[amount] [pay@chain] [receive@chain]', flags: ['--from', '--to', '--pay', '--amount', '--token-out', '--stable', '--exact-out', '--slippage-bps', '--relay-fee-cap', '--buyer', '--json'], json: 'object: rail, amountIn, arrives, expectedOut, minOut, venues, fees, deadline' },
                swap: { args: 'same as quote', flags: ['all quote flags', '--yes', '--max-fee', '--min-finality', '--no-follow', '--dry-run', '--json'], json: "NDJSON events: {event:'plan'|'tx'|'step'|'done'|'error', ...}", requires: 'PRIVATE_KEY (unless --dry-run)' },
                watch: { flags: ['--from', '--tx', '--json'], json: "NDJSON StepEvents: {step, state, rail, detail, txHash?, at, final?}" },
                status: { flags: ['--from', '--tx', '--json'], json: 'object: {rail, messages[]}' },
                relay: { flags: ['--from', '--to', '--tx', '--fee'], requires: 'PRIVATE_KEY' },
                chains: { flags: ['--json'], json: 'array of chain configs' },
                routes: { flags: ['--from', '--to', '--json'], json: 'object: {from, to, lanes:{usdc,usdt}, destinationVenues[]}' },
                venues: { flags: ['--chain', '--json'], json: 'object keyed by venue name' },
                tokens: { args: '[chain]', flags: ['--json'], json: 'registry object keyed by chain then symbol' },
                balances: { flags: ['--chain', '--address', '--json'], json: 'object: {chain, address, balances:{sym:{amount,decimals,address?}}}' },
                refunds: { flags: ['--chain', '--address', '--claim', '--json'], json: 'object: {chain, address, owed[]} or {claimed[]}', requires: 'PRIVATE_KEY only with --claim' },
                history: { flags: ['--chain', '--address', '--blocks', '--json'], json: 'object: {chain, address, outcomes[]}' },
                doctor: { flags: ['--chain', '--json'], json: 'object: {signer, ok, chains:{name:[{level,detail}]}}', exit: 'non-zero when any check fails' },
                schema: { json: 'this document' },
            },
        }
        console.log(JSON.stringify(schema, null, 2))
    })

registerTrade(program)
registerTrack(program)
registerInfo(program)
registerAccount(program)
registerDoctor(program)

program.parseAsync(process.argv).catch((err) => {
    console.error(`${c.red('error:')} ${(err as Error).message}`)
    process.exit(1)
})

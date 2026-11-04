#!/usr/bin/env node
/**
 * invictae — cross-chain swaps on LayerZero.
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
    .description('Cross-chain swaps on LayerZero — stables, native coins, blue chips, tokenized stocks')
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

registerTrade(program)
registerTrack(program)
registerInfo(program)
registerAccount(program)
registerDoctor(program)

program.parseAsync(process.argv).catch((err) => {
    console.error(`${c.red('error:')} ${(err as Error).message}`)
    process.exit(1)
})

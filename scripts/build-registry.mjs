#!/usr/bin/env node
/**
 * Expands config/tokens.json with major tokens: fetches each CoinGecko id's
 * per-platform contract addresses, then VERIFIES every address on-chain
 * (symbol() must answer) before it enters the registry. Run occasionally;
 * the output is committed, so users never depend on CoinGecko at runtime
 * for these symbols.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const chainsFile = path.resolve(dir, '../config/chains.json')
const tokensFile = path.resolve(dir, '../config/tokens.json')
const config = JSON.parse(fs.readFileSync(chainsFile, 'utf8'))
const registry = JSON.parse(fs.readFileSync(tokensFile, 'utf8'))

// CoinGecko ids chosen by hand — search-by-ticker is ambiguous, ids are not.
const COINS = [
    'wrapped-bitcoin', 'coinbase-wrapped-btc', 'chainlink', 'uniswap', 'aave',
    'curve-dao-token', 'lido-dao', 'pepe', 'shiba-inu', 'arbitrum', 'optimism',
    'ondo-finance', 'dai', 'ethena', 'aerodrome-finance', 'pancakeswap-token',
]

const byPlatform = new Map(config.chains.filter((c) => c.coingeckoPlatform).map((c) => [c.coingeckoPlatform, c]))

const SYMBOL_SIG = '0x95d89b41' // symbol()
async function onchainSymbol(rpc, address) {
    const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: address, data: SYMBOL_SIG }, 'latest'] }),
    })
    const { result } = await res.json()
    if (!result || result === '0x') return null
    try {
        const hex = result.slice(2)
        const offset = parseInt(hex.slice(0, 64), 16) * 2
        const len = parseInt(hex.slice(offset, offset + 64), 16) * 2
        return Buffer.from(hex.slice(offset + 64, offset + 64 + len), 'hex').toString('utf8')
    } catch {
        return null
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const id of COINS) {
    let d
    for (let attempt = 0; attempt < 5; attempt++) {
        const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`)
        if (res.ok) { d = await res.json(); break }
        console.log(`${id}: HTTP ${res.status} — backing off`)
        await sleep(30_000)
    }
    if (!d) { console.log(`${id}: SKIPPED`); continue }
    for (const [platform, address] of Object.entries(d.platforms ?? {})) {
        const chain = byPlatform.get(platform)
        if (!chain || !address) continue
        const rpc = process.env[chain.rpcEnv] ?? chain.publicRpc
        const sym = await onchainSymbol(rpc, address).catch(() => null)
        if (!sym) { console.log(`${id} @ ${chain.name}: on-chain verification FAILED (${address})`); continue }
        registry[chain.name] = registry[chain.name] ?? {}
        registry[chain.name][sym] = address
        console.log(`${chain.name}: ${sym} ${address}`)
    }
    await sleep(13_000) // free-tier rate limit
}

const sorted = Object.fromEntries(Object.entries(registry).sort().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort())]))
fs.writeFileSync(tokensFile, JSON.stringify(sorted, null, 2) + '\n')
console.log('tokens.json updated')

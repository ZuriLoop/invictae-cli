#!/usr/bin/env node
/**
 * invictae-mcp — a Model Context Protocol server over stdio, dependency-free.
 *
 * Speaks JSON-RPC 2.0, one message per line (the MCP stdio transport).
 * Read tools are always available; execute_swap additionally requires
 * PRIVATE_KEY in the environment, an explicit confirm flag from the caller,
 * and passes the same policy guardrails as the CLI (invictae.policy.json).
 *
 *   Claude Desktop / MCP clients:
 *     { "mcpServers": { "invictae": { "command": "invictae-mcp" } } }
 */
import 'dotenv/config'

import readline from 'readline'

import { ethers } from 'ethers'

import { getChain, loadConfig, loadTokens, pickBridge, provider, ERC20_ABI } from '../lib/common'
import { buildSwapTxs, prepare, type Prepared } from '../lib/prepare'
import { enforcePolicy, findByKey, loadPolicy, recordSwap } from '../lib/policy'
import { trackSwap, type StepEvent } from '../lib/tracker'

// ── tool implementations ─────────────────────────────────────────────────────

const swapInputs = {
    from: { type: 'string', description: 'source chain (name, alias, chain id, or endpoint id)' },
    to: { type: 'string', description: 'destination chain' },
    pay: { type: 'string', description: "what to pay with: ticker, 'eth'/'native', or ERC-20 address" },
    amount: { type: 'string', description: 'amount of the pay token (of the OUT token when exactOut)' },
    tokenOut: { type: 'string', description: "what to receive: ticker, 'eth'/'native', address, or the stable itself (bridge-only)" },
    exactOut: { type: 'boolean', description: 'treat amount as the exact amount to receive' },
    slippageBps: { type: 'number', description: 'slippage tolerance per swap leg (default 100)' },
    relayFeeCap: { type: 'string', description: 'max stable the relayer may take for gas on the cctp rail (default 0)' },
}

function quoteJson(prep: Prepared) {
    return {
        rail: prep.rail,
        from: prep.srcChain.name,
        to: prep.dstChain.name,
        stable: prep.stableKey,
        payToken: prep.payToken,
        payVia: prep.payVia,
        amountIn: prep.amountIn.toString(),
        payDecimals: prep.payDecimals,
        arrives: prep.dstReceived.toString(),
        stableDecimals: prep.dstStableDecimals,
        feeBps: loadConfig().feeBps,
        tokenOut: prep.tokenOut,
        tokenOutResolved: prep.tokenOutResolved,
        outVia: prep.outVia,
        srcVenue: prep.srcRoute?.venue ?? null,
        dstVenue: prep.dstRoute?.venue ?? null,
        expectedOut: prep.expectedOut.toString(),
        minOut: prep.minOut.toString(),
        deadline: prep.deadline,
        lzFeeNative: prep.lzFeeNative.toString(),
        warnings:
            prep.payVia === 'coingecko' || prep.outVia === 'coingecko'
                ? ['a token resolved via CoinGecko — show the resolved address to the user and get confirmation before swapping']
                : [],
    }
}

async function doPrepare(args: Record<string, unknown>, buyer: string): Promise<Prepared> {
    return prepare({
        from: String(args.from),
        to: String(args.to),
        pay: String(args.pay),
        amount: String(args.amount),
        tokenOut: String(args.tokenOut),
        stable: args.stable ? String(args.stable) : undefined,
        exactOut: Boolean(args.exactOut),
        slippageBps: Number(args.slippageBps ?? 100),
        composeGas: 600_000,
        relayFeeCap: String(args.relayFeeCap ?? '0'),
        deadlineSeconds: 1800,
        buyer,
    })
}

interface Tool {
    description: string
    inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
    handler: (args: Record<string, unknown>) => Promise<unknown>
}

const TOOLS: Record<string, Tool> = {
    list_chains: {
        description: 'Supported chains with their stables, rails, venues, and deployment state.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () =>
            loadConfig().chains.map((c) => ({
                name: c.name,
                chainId: c.chainId,
                stables: Object.keys(c.stables),
                rails: [...Object.keys(c.bridges), ...(c.cctp ? ['cctp'] : [])],
                venues: Object.entries(c.venues).filter(([, v]) => v.router && v.quoter).map(([k]) => k),
                deployed: Boolean(c.composer && c.zap),
            })),
    },
    get_route: {
        description: 'Which rail connects two chains for each stable, and the destination venues.',
        inputSchema: { type: 'object', properties: { from: swapInputs.from, to: swapInputs.to }, required: ['from', 'to'] },
        handler: async (args) => {
            const config = loadConfig()
            const src = getChain(config, String(args.from))
            const dst = getChain(config, String(args.to))
            const lanes: Record<string, string | null> = {}
            for (const stable of ['usdc', 'usdt'] as const) {
                if (!src.stables[stable] || !dst.stables[stable]) lanes[stable] = null
                else if (stable === 'usdc' && src.cctp && dst.cctp) lanes[stable] = 'cctp'
                else {
                    try {
                        lanes[stable] = pickBridge(src, dst, stable).key
                    } catch {
                        lanes[stable] = null
                    }
                }
            }
            return { from: src.name, to: dst.name, lanes, destinationVenues: Object.entries(dst.venues).filter(([, v]) => v.router && v.quoter).map(([k]) => k) }
        },
    },
    list_tokens: {
        description: 'Curated ticker registry per chain (every address verified on-chain).',
        inputSchema: { type: 'object', properties: { chain: { type: 'string', description: 'optional chain filter' } } },
        handler: async (args) => {
            const registry = loadTokens()
            return args.chain ? { [String(args.chain).toLowerCase()]: registry[String(args.chain).toLowerCase()] ?? {} } : registry
        },
    },
    get_quote: {
        description: 'Quote a cross-chain swap (read-only). Amounts are integer strings in each token’s own decimals. Always show expectedOut/minOut and any warnings to the user before executing.',
        inputSchema: { type: 'object', properties: swapInputs, required: ['from', 'to', 'pay', 'amount', 'tokenOut'] },
        handler: async (args) => quoteJson(await doPrepare(args, ethers.constants.AddressZero)),
    },
    plan_swap: {
        description: 'Build the exact unsigned transactions for a swap (nothing is signed or sent). Use to inspect or to sign elsewhere.',
        inputSchema: {
            type: 'object',
            properties: { ...swapInputs, buyer: { type: 'string', description: 'recipient on the destination chain' } },
            required: ['from', 'to', 'pay', 'amount', 'tokenOut', 'buyer'],
        },
        handler: async (args) => {
            const prep = await doPrepare(args, String(args.buyer))
            return { quote: quoteJson(prep), transactions: buildSwapTxs(prep) }
        },
    },
    execute_swap: {
        description:
            'Broadcast a cross-chain swap and follow it briefly. REQUIRES: PRIVATE_KEY in the server environment, confirm=true (set it only after the user approved this exact swap), and it obeys the local policy file. Returns the broadcast tx; use track_swap for the final outcome.',
        inputSchema: {
            type: 'object',
            properties: {
                ...swapInputs,
                buyer: { type: 'string', description: 'recipient (default: the signer address)' },
                confirm: { type: 'boolean', description: 'must be true; set only after explicit user approval of this exact swap' },
                idempotencyKey: { type: 'string', description: 'refuse to broadcast twice for the same key' },
            },
            required: ['from', 'to', 'pay', 'amount', 'tokenOut', 'confirm'],
        },
        handler: async (args) => {
            if (args.confirm !== true) throw new Error('confirm must be true — obtain explicit user approval for this exact swap first')
            const key = process.env.PRIVATE_KEY
            if (!key) throw new Error('PRIVATE_KEY is not set in the MCP server environment')
            if (args.idempotencyKey) {
                const prior = findByKey(String(args.idempotencyKey))
                if (prior) return { duplicate: true, txHash: prior.txHash, at: prior.at }
            }
            const srcChain = getChain(loadConfig(), String(args.from))
            const signer = new ethers.Wallet(key, provider(srcChain))
            const buyer = args.buyer ? String(args.buyer) : signer.address
            const prep = await doPrepare(args, buyer)
            if (prep.payVia === 'coingecko' || prep.outVia === 'coingecko') {
                throw new Error('refusing to execute with a CoinGecko-resolved token — use an explicit address the user confirmed')
            }
            const loaded = loadPolicy()
            if (loaded) enforcePolicy(loaded.policy, prep, buyer)

            const txs = buildSwapTxs(prep)
            const hashes: { label: string; hash: string }[] = []
            for (const tx of txs) {
                const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
                const rc = await sent.wait()
                hashes.push({ label: tx.label, hash: rc.transactionHash })
            }
            const last = hashes[hashes.length - 1].hash
            recordSwap({
                at: Date.now(),
                txHash: last,
                route: `${args.amount} ${args.pay}@${prep.srcChain.name} -> ${args.tokenOut}@${prep.dstChain.name}`,
                key: args.idempotencyKey ? String(args.idempotencyKey) : undefined,
            })
            return { broadcast: hashes, quote: quoteJson(prep), next: `track_swap { from: "${prep.srcChain.name}", tx: "${last}" }` }
        },
    },
    track_swap: {
        description: 'Follow a swap for up to timeoutSec (default 120) and return the lifecycle events observed so far; call again to keep following.',
        inputSchema: {
            type: 'object',
            properties: {
                from: swapInputs.from,
                tx: { type: 'string', description: 'source-chain transaction hash' },
                timeoutSec: { type: 'number', description: 'how long to watch before returning (default 120)' },
            },
            required: ['from', 'tx'],
        },
        handler: async (args) => {
            const events: StepEvent[] = []
            await trackSwap(String(args.from), String(args.tx), (e) => events.push(e), {
                maxMs: Number(args.timeoutSec ?? 120) * 1000,
                pollMs: 5000,
            })
            const final = events.find((e) => e.final)
            return { events, outcome: final?.step ?? 'pending', final: Boolean(final && final.step !== 'timeout') }
        },
    },
    get_balances: {
        description: 'Native, stable, and registry-token balances for an address on a chain.',
        inputSchema: {
            type: 'object',
            properties: { chain: { type: 'string' }, address: { type: 'string' } },
            required: ['chain', 'address'],
        },
        handler: async (args) => {
            const chain = getChain(loadConfig(), String(args.chain))
            const who = ethers.utils.getAddress(String(args.address))
            const p = provider(chain)
            const out: Record<string, { amount: string; decimals: number; address?: string }> = {
                native: { amount: (await p.getBalance(who)).toString(), decimals: 18 },
            }
            const entries = [...Object.entries(chain.stables), ...Object.entries(loadTokens()[chain.name] ?? {})]
            for (const [sym, addr] of entries) {
                try {
                    const t = new ethers.Contract(addr, ERC20_ABI, p)
                    const [bal, dec] = await Promise.all([t.balanceOf(who), t.decimals()])
                    if (!bal.isZero()) out[sym] = { amount: bal.toString(), decimals: dec, address: addr }
                } catch {
                    // unreadable token — skip
                }
            }
            return { chain: chain.name, address: who, balances: out }
        },
    },
}

// ── minimal MCP (JSON-RPC 2.0 over stdio, newline-delimited) ────────────────

type Rpc = { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const send = (msg: Rpc) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id: Rpc['id'], result: unknown) => send({ jsonrpc: '2.0', id, result })
const replyError = (id: Rpc['id'], code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg: Rpc): Promise<void> {
    const { id, method, params } = msg
    if (!method) return
    try {
        switch (method) {
            case 'initialize':
                reply(id, {
                    protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'invictae', version: '0.3.0' },
                })
                return
            case 'notifications/initialized':
            case 'notifications/cancelled':
                return // notifications take no response
            case 'ping':
                reply(id, {})
                return
            case 'tools/list':
                reply(id, {
                    tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
                })
                return
            case 'tools/call': {
                const name = String(params?.name)
                const tool = TOOLS[name]
                if (!tool) {
                    replyError(id, -32602, `unknown tool '${name}'`)
                    return
                }
                try {
                    const result = await tool.handler((params?.arguments as Record<string, unknown>) ?? {})
                    reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
                } catch (err) {
                    reply(id, { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true })
                }
                return
            }
            default:
                if (id !== undefined) replyError(id, -32601, `method '${method}' not supported`)
        }
    } catch (err) {
        if (id !== undefined) replyError(id, -32603, (err as Error).message)
    }
}

// Exit only after stdin has closed AND every in-flight tool call has answered.
let pending = 0
let stdinClosed = false
const maybeExit = () => {
    if (stdinClosed && pending === 0) process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
    if (!line.trim()) return
    let msg: Rpc
    try {
        msg = JSON.parse(line)
    } catch {
        return // not JSON — ignore
    }
    pending++
    void handle(msg).finally(() => {
        pending--
        maybeExit()
    })
})
process.stdin.on('close', () => {
    stdinClosed = true
    maybeExit()
})

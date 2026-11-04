/**
 * Agent guardrails: a local policy file the runtime enforces before any
 * transaction is built, plus an idempotency ledger so retried automations
 * can never double-spend.
 *
 * Policy file locations (first found wins):
 *   $INVICTAE_POLICY  ·  ./invictae.policy.json  ·  ~/.invictae/policy.json
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { ethers } from 'ethers'

import type { Prepared } from './prepare'

export interface Policy {
    /** cap on the bridged stable per swap, in human units (e.g. "1000" = 1000 USDC/USDT) */
    maxStablePerSwap?: string
    /** swaps above this stable amount require a human at an interactive terminal
     *  (they cannot be --yes'd or executed through the MCP server) */
    escalateAbove?: string
    /** cap on broadcast swaps per rolling 24h (counted from the local ledger) */
    maxSwapsPerDay?: number
    /** chain names the policy allows as source or destination */
    allowedChains?: string[]
    /** forbid tokens that resolved outside native/wrapped/stable/registry tiers */
    registryTokensOnly?: boolean
    /** buyer/recipient allowlist */
    allowedRecipients?: string[]
}

export function policyPath(): string | null {
    const candidates = [
        process.env.INVICTAE_POLICY,
        path.resolve(process.cwd(), 'invictae.policy.json'),
        path.join(os.homedir(), '.invictae', 'policy.json'),
    ].filter((x): x is string => Boolean(x))
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) return p
        } catch {
            // unreadable location — keep looking
        }
    }
    return null
}

export function loadPolicy(): { policy: Policy; source: string } | null {
    const p = policyPath()
    if (!p) return null
    return { policy: JSON.parse(fs.readFileSync(p, 'utf8')) as Policy, source: p }
}

/** Throws on violation; returns 'escalate' when the swap needs interactive human approval. */
export function enforcePolicy(policy: Policy, prep: Prepared, buyer: string): 'ok' | 'escalate' {
    if (policy.allowedChains) {
        const allowed = policy.allowedChains.map((c) => c.toLowerCase())
        for (const chain of [prep.srcChain.name, prep.dstChain.name]) {
            if (!allowed.includes(chain)) throw new Error(`policy: chain '${chain}' is not in allowedChains`)
        }
    }
    if (policy.registryTokensOnly) {
        for (const [label, via] of [
            ['pay token', prep.payVia],
            ['token out', prep.outVia],
        ] as const) {
            if (!['native', 'wrapped', 'stable', 'registry'].includes(via)) {
                throw new Error(`policy: ${label} resolved via '${via}' but registryTokensOnly is set`)
            }
        }
    }
    if (policy.allowedRecipients) {
        const allowed = policy.allowedRecipients.map((a) => a.toLowerCase())
        if (!allowed.includes(buyer.toLowerCase())) throw new Error(`policy: recipient ${buyer} is not in allowedRecipients`)
    }
    if (policy.maxStablePerSwap) {
        const cap = ethers.parseUnits(policy.maxStablePerSwap, prep.dstStableDecimals)
        if (prep.dstReceived > cap) {
            throw new Error(
                `policy: swap moves ${ethers.formatUnits(prep.dstReceived, prep.dstStableDecimals)} ${prep.stableKey.toUpperCase()}, above maxStablePerSwap ${policy.maxStablePerSwap}`
            )
        }
    }
    if (policy.maxSwapsPerDay !== undefined) {
        const recent = readLedger().entries.filter((e) => Date.now() - e.at < 24 * 3600_000)
        if (recent.length >= policy.maxSwapsPerDay) {
            throw new Error(`policy: maxSwapsPerDay (${policy.maxSwapsPerDay}) reached — ${recent.length} swaps in the last 24h`)
        }
    }
    if (policy.escalateAbove) {
        const bar = ethers.parseUnits(policy.escalateAbove, prep.dstStableDecimals)
        if (prep.dstReceived > bar) return 'escalate'
    }
    return 'ok'
}

// ── idempotency / local swap ledger ──────────────────────────────────────────

export interface LedgerEntry {
    at: number
    txHash: string
    route: string
    key?: string
    /** sha256 over the previous entry's hash + this entry's fields: a
     *  tamper-evident chain — editing history breaks every later hash */
    hash?: string
    prevHash?: string
}

function ledgerPath(): string {
    return process.env.INVICTAE_LEDGER ?? path.join(os.homedir(), '.invictae', 'ledger.json')
}

export function readLedger(): { entries: LedgerEntry[] } {
    try {
        return JSON.parse(fs.readFileSync(ledgerPath(), 'utf8'))
    } catch {
        return { entries: [] }
    }
}

/** A previously recorded broadcast for this idempotency key, if any. */
export function findByKey(key: string): LedgerEntry | undefined {
    return readLedger().entries.find((e) => e.key === key)
}

export function recordSwap(entry: LedgerEntry): void {
    const file = ledgerPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const ledger = readLedger()
    const prevHash = ledger.entries[ledger.entries.length - 1]?.hash ?? 'genesis'
    entry.prevHash = prevHash
    entry.hash = crypto
        .createHash('sha256')
        .update(prevHash + JSON.stringify({ at: entry.at, txHash: entry.txHash, route: entry.route, key: entry.key }))
        .digest('hex')
    ledger.entries.push(entry)
    // keep the ledger bounded
    if (ledger.entries.length > 5000) ledger.entries = ledger.entries.slice(-5000)
    fs.writeFileSync(file, JSON.stringify(ledger))
}

/** Walks the hash chain; returns the index of the first tampered entry, or -1. */
export function verifyLedger(): number {
    const { entries } = readLedger()
    let prev = 'genesis'
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        const expect = crypto
            .createHash('sha256')
            .update(prev + JSON.stringify({ at: e.at, txHash: e.txHash, route: e.route, key: e.key }))
            .digest('hex')
        if (e.hash !== expect || e.prevHash !== prev) return i
        prev = e.hash
    }
    return -1
}

/** Unit tests for the library layer. Run against the compiled output:
 *    npm run build && npm test
 *  Everything here is offline — no RPC, no network. */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { composeOptions, encodeOrder, encodePath, getChain, loadConfig, loadTokens, resolveToken } from '../dist/lib/common.js'

const config = loadConfig()

// ── chain resolution ─────────────────────────────────────────────────────────

test('getChain resolves names, aliases, chain ids, and endpoint ids', () => {
    assert.equal(getChain(config, 'base').chainId, 8453)
    assert.equal(getChain(config, 'BASE').chainId, 8453)
    assert.equal(getChain(config, 'eth').name, 'ethereum')
    assert.equal(getChain(config, 'bsc').name, 'bnb')
    assert.equal(getChain(config, 'arb').name, 'arbitrum')
    assert.equal(getChain(config, 'matic').name, 'polygon')
    assert.equal(getChain(config, '8453').name, 'base')
    assert.equal(getChain(config, 8453).name, 'base')
    assert.equal(getChain(config, '30184').name, 'base') // endpoint id
    assert.equal(getChain(config, '999').name, 'hyperevm')
})

test('getChain rejects unknown inputs with the known list', () => {
    assert.throws(() => getChain(config, 'notachain'), /Unknown chain 'notachain'/)
    assert.throws(() => getChain(config, '424242'), /Unknown chain id/)
})

// ── token resolution (offline tiers only) ────────────────────────────────────

test('resolveToken handles native, wrapped, stables, registry, and addresses', () => {
    const base = getChain(config, 'base')
    assert.deepEqual(resolveToken(base, 'eth'), { address: base.wrappedNative, native: true, via: 'native' })
    assert.deepEqual(resolveToken(base, 'WETH'), { address: base.wrappedNative, native: false, via: 'wrapped' })
    assert.equal(resolveToken(base, 'usdc').via, 'stable')
    assert.equal(resolveToken(base, 'usdc').address, base.stables.usdc)

    const eth = getChain(config, 'ethereum')
    const tslaon = resolveToken(eth, 'TSLAon')
    assert.equal(tslaon.via, 'registry')
    assert.match(tslaon.address, /^0x[0-9a-fA-F]{40}$/)
    assert.equal(resolveToken(eth, 'tslaon').address, tslaon.address) // case-insensitive

    const raw = resolveToken(base, '0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4')
    assert.equal(raw.via, 'address')
    assert.equal(raw.address, '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4') // checksummed
})

test('resolveToken rejects unknown symbols with the available registry', () => {
    const base = getChain(config, 'base')
    assert.throws(() => resolveToken(base, 'NOTATOKEN'), /unknown token 'NOTATOKEN' on base/)
})

// ── byte encodings (golden vectors, validated against the reference SDK) ─────

test('composeOptions matches the reference byte layout', () => {
    assert.equal(
        composeOptions(600000),
        '0x000301001101000000000000000000000000000493e0010013030000000000000000000000000000000927c0'
    )
    assert.equal(
        composeOptions(600000, '655418515020166'),
        '0x000301001101000000000000000000000000000493e0010023030000000000000000000000000000000927c000000000000000000002541983c45986'
    )
})

test('encodePath packs token/fee hops', () => {
    assert.equal(
        encodePath(
            ['0xdAC17F958D2ee523a2206206994597C13D831ec7', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
            [100]
        ),
        '0xdac17f958d2ee523a2206206994597c13d831ec7000064a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
    )
    assert.throws(() => encodePath(['0xdAC17F958D2ee523a2206206994597C13D831ec7'], [100]), /one longer/)
})

test('encodeOrder produces the 7-field payload', () => {
    const order = encodeOrder('0x000000000000000000000000000000000000bEEF', '0x0000000000000000000000000000000000000000', '1', 1700000000, '0x')
    assert.equal(
        order,
        '0x000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000006553f1000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000000000000000000000000000000000000000000000'
    )
})

// ── config invariants ────────────────────────────────────────────────────────

test('every chain is self-consistent', () => {
    for (const chain of config.chains) {
        assert.ok(chain.name && chain.chainId > 0 && chain.lzEid > 0, chain.name)
        assert.match(chain.lzEndpoint, /^0x[0-9a-fA-F]{40}$/, `${chain.name} endpoint`)
        for (const [key, bridge] of Object.entries(chain.bridges)) {
            assert.ok(chain.stables[bridge.stable], `${chain.name} bridge ${key} references stable '${bridge.stable}'`)
            assert.match(bridge.oApp, /^0x[0-9a-fA-F]{40}$/)
        }
        const defaults = Object.values(chain.venues).filter((v) => v.default)
        assert.ok(defaults.length <= 1, `${chain.name} has multiple default venues`)
        if (Object.keys(chain.venues).length > 0) assert.equal(defaults.length, 1, `${chain.name} needs a default venue`)
        if (chain.cctp) {
            assert.ok(chain.stables.usdc, `${chain.name} has cctp but no usdc stable`)
        }
    }
})

test('registry addresses are well-formed and chains exist', () => {
    const registry = loadTokens()
    for (const [chainName, tokens] of Object.entries(registry)) {
        assert.ok(config.chains.some((c) => c.name === chainName), `registry chain '${chainName}'`)
        for (const [sym, addr] of Object.entries(tokens)) {
            assert.match(addr, /^0x[0-9a-fA-F]{40}$/, `${chainName}:${sym}`)
        }
    }
})

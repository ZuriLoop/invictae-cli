# invictae

[![CI](https://github.com/ZuriLoop/invictae-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/ZuriLoop/invictae-cli/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) ![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**Agentic cross-chain swaps.** Pay with what you hold on one chain, receive what you want on another — stablecoins, native coins, blue chips, and tokenized U.S. stocks — in one approval. No solvers, no off-chain fill trust, and an interface built to be driven by AI agents as much as by humans: JSON everywhere, streamed lifecycle events, and a self-describing schema.

```
$ invictae swap --from base --to arbitrum --pay eth --amount 0.5 --token-out eth

Swap 0.5 eth → eth  buyer 0xAb…
  route         base → arbitrum
  rail          CCTP v2 — lossless, relayer completes
  source swap   uniswap (tier 500)
  arrives       ~1152.42 USDC
  expected out  0.494418 WETH → native via uniswap (tier 500)
  bridge fee    none (standard finality ~1–15 min)

Broadcast 1 transaction from 0xAb… on base? [y/N] y
✓ zapNative  0x9afc…
[12:01:05] ✓ source_confirmed — confirmed on base in block 53246949
[12:03:11] ✓ attested — Circle attested the burn
[12:03:40] ✓ executed — swap executed: 0.4951 WETH to 0xAb…
```

## How it works

Every swap is one or two transactions to two fixed, auditable contracts per chain. A stablecoin rides one of three rails — Circle CCTP v2 (lossless USDC), Tether USDT0 (lossless USDT), or Stargate V2 (universal fallback) — and is swapped on the destination chain across the best of its allowlisted venues (Uniswap V3 everywhere, PancakeSwap on BNB, Aerodrome on Base, Velodrome on Optimism, HyperSwap on HyperEVM). Buyer protections (`minAmountOut`, deadline, venue allowlist) are enforced on-chain, and every failure terminates in an automatic refund or claimable escrow — never a stuck swap.

## Install

```bash
npm install -g invictae     # or: npx invictae …
invictae --help
```

From source: `git clone … && npm install && npm run build && npm link`.
Configuration: copy `.env.example` to `.env` — public RPC fallbacks work out of the box; `PRIVATE_KEY` is only needed for signing commands.

## Examples

```bash
# Quote: positional form — AMOUNT  PAY@CHAIN  RECEIVE@CHAIN
invictae quote 100 usdc@base eth@arbitrum

# Native in, native out: ETH on Base becomes ETH on Arbitrum
invictae swap 0.5 eth@base eth@arbitrum

# Buy a tokenized stock with USDT (chain aliases work: eth, bsc, arb, op…)
invictae quote 1000 usdt@eth TSLAon@eth

# Exact-out: "I want exactly 0.1 ETH on Arbitrum, tell me what it costs"
invictae quote 0.1 usdc@base eth@arbitrum --exact-out

# Bridge-only: move dollars between chains, no swap (receive the stable itself)
invictae swap 500 usdc@base usdc@optimism

# Long-tail ticker: resolved via CoinGecko, re-verified on-chain, address shown
invictae quote 200 usdc@arb TOSHI@base

# Any ERC-20 by address, chains by id
invictae quote 1000 usdt@1 0x912CE59144191C1204E64559FE8253a0e49E6548@42161

# Inspect the exact transactions without signing anything
invictae swap 100 usdc@base eth@arbitrum --dry-run --buyer 0xYou

# Tighter slippage and a faster CCTP transfer
invictae swap 2500 usdc@ethereum eth@base --slippage-bps 30 --min-finality 1000 --yes

# Follow any in-flight swap to its on-chain outcome; one-shot status
invictae watch --from base --tx 0xabc…
invictae status --from base --tx 0xabc…

# Complete a CCTP swap yourself (permissionless), requesting the order-capped fee
invictae relay --from base --to arbitrum --tx 0xabc… --fee 0.5

# What exists: chains, the rail between two of them, venues, known tickers
invictae chains
invictae routes --from base --to bnb
invictae venues --chain bnb
invictae tokens ethereum

# Your money: balances, escrowed refunds (and claiming them), outcome history
invictae balances --chain arbitrum
invictae refunds --chain arbitrum --claim
invictae history --chain arbitrum --blocks 50000

# Verify every configured address against the live chains (CI-friendly exit code)
invictae doctor --json
```

Agent-flavored (stdout is pure JSON/NDJSON; narration goes to stderr):

```bash
invictae quote 100 usdc@base eth@arbitrum --json | jq .expectedOut
invictae swap 100 usdc@base eth@arbitrum --yes --json | while read -r e; do echo "$e" | jq -r .event; done
invictae watch --from base --tx 0xabc… --json   # NDJSON step events, ends on final:true
invictae schema                                  # the whole interface, as JSON
```

## Commands

| | |
| --- | --- |
| `quote` | Preview a swap: best venue per leg, expected/min out, fees. `--exact-out` works backwards from the amount you want. `--json` for scripts. |
| `swap` | Execute: summary → confirmation → broadcast → follows the live step stream to the final on-chain outcome. `--dry-run` prints wallet payloads. |
| `watch` | Re-attach to any swap by tx hash; `--json` emits NDJSON step events. |
| `status` | One-shot "where's my money" across the bridge explorers. |
| `relay` | Complete a CCTP swap yourself (permissionless); `--fee` requests the order-capped relayer fee. |
| `chains` / `routes` / `venues` / `tokens` | What's supported: 12 chains, the rail connecting any two of them per stable, venue routability, and the curated token registry (xStocks, Ondo tokenized stocks). |
| `balances` / `refunds` / `history` | Account views; `refunds --claim` pays out escrowed refunds. |
| `doctor` | Live verification of every configured chain: RPC identity, messaging endpoints, each bridge's wrapped token, venue router/quoter pairing, and deployed-contract wiring. Non-zero exit for CI. |

## For agents

**MCP server** — `invictae-mcp` ships in this package: a dependency-free Model Context Protocol server (stdio) exposing `get_quote`, `plan_swap`, `execute_swap`, `track_swap`, `get_balances`, `list_chains`, `get_route`, and `list_tokens`. Point any MCP client at it:

```json
{ "mcpServers": { "invictae": { "command": "invictae-mcp" } } }
```

`execute_swap` is deliberately hard to misuse: it requires `confirm: true` (to be set only after the user approved that exact swap), refuses CoinGecko-resolved tokens outright, honors the policy file below, supports idempotency keys, and needs `PRIVATE_KEY` in the server's environment — read tools never do.

**Skill** — [SKILL.md](SKILL.md) teaches any CLI-driving agent the full workflow and its safety rules.

**Policy guardrails** — drop an `invictae.policy.json` next to the process (or `~/.invictae/policy.json`, or point `INVICTAE_POLICY` at one) and both the CLI and the MCP server enforce it before building any transaction: per-swap stable cap, swaps-per-day cap, chain allowlist, registry-tokens-only, recipient allowlist. See [invictae.policy.example.json](invictae.policy.example.json). Give your agent a budget, not your keys.

**Idempotency** — `swap --idempotency-key <k>` (or the MCP argument) records broadcasts in a local ledger and returns the original transaction instead of double-firing on retries.

The CLI itself is built to be driven by software: `--json` on every command (one object for reads, NDJSON for streams), data on stdout and narration on stderr, documented exit codes, a `schema` command that returns the full interface as JSON, and compact positional syntax — `invictae quote 100 usdc@base eth@arbitrum`. `swap` refuses to broadcast non-interactively without `--yes`, and `--dry-run` returns raw signable payloads without touching a key. See [AGENTS.md](AGENTS.md).

## Tickers, addresses, chains

Token inputs (`--pay`, `--token-out`) accept, in order of trust:

1. **`eth` / `native`** — the chain's native coin (wrapped automatically; delivery unwraps). Wrapped symbols (`WETH`, `WBNB`, `WAVAX`, …) resolve to the wrapped ERC-20.
2. **Registry tickers** — `config/tokens.json`, 103 entries across the 12 chains (majors, Ondo tokenized stocks, xStocks), every address verified on-chain before it enters the file. Regenerate with `node scripts/build-registry.mjs`.
3. **Any other ticker** — resolved live via CoinGecko by exact symbol, then **re-verified against the contract's own `symbol()`**; a mismatch refuses and asks for the address. A fallback-resolved ticker is always displayed with its full address in the summary — read it before confirming.
4. **A raw ERC-20 address** — always works, no lookups.

Chain inputs (`--from`, `--to`, `--chain`) accept names (`base`), aliases (`eth`, `bsc`, `arb`, `op`, `matic`, `avax`, `hype`, `uni`), numeric chain ids (`8453`), and endpoint ids (`30184`).

## Chains

Ethereum, BNB Chain, Base, Arbitrum, Optimism, HyperEVM, Polygon, Avalanche, Unichain, Sei, Mantle, Plasma. Rails and venues per chain live in `config/chains.json`; every address in it is verifiable with `invictae doctor`, which checks the live chain, not this repo's claims.

## Trust model

Built so you can check it rather than take our word for it.

- Value moves on the issuers' own transfer systems (Circle, Tether) and audited public exchanges — there are no intermediaries holding user funds in transit.
- The contracts hold nothing at rest. Orders carry the user's slippage floor and deadline, enforced on-chain, and every outcome ends in delivery, an automatic refund, or a claimable balance (`invictae refunds --claim`).
- Approvals are scoped to one order, one venue, and cleared afterward.
- `invictae doctor` re-verifies every address in this repo against the live chains — endpoints, each bridge's wrapped token, venue pairings — and exits non-zero on any mismatch.
- The dependency tree is three pinned packages with a committed lockfile and offline tests; the byte encodings ship in-repo with golden-vector tests.
- Tokens from outside the curated registry show their resolved address and require `--allow-unverified` to swap — quotes scan every venue and the chosen one is pinned in the signed order.

Details for security researchers, including how to report privately, live in [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom | Meaning / fix |
| --- | --- |
| `no venue on <chain> quotes X -> Y (no pools?)` | The out token has no reachable pool on that chain. Try another destination chain or check `invictae venues --chain <chain>`. |
| `non-interactive session: pass --yes to broadcast` | You ran `swap` from a script/agent. Add `--yes` (or `--dry-run` to inspect without signing). |
| `PRIVATE_KEY missing` | Signing commands read the key from the environment (`.env` works). Read-only commands never need it. |
| `… resolved via CoinGecko — verify this address` | The ticker wasn't in the curated registry. Confirm the printed address is the token you mean, or pass the address directly. |
| `SourceZap is not deployed on <chain> yet` | The protocol contracts aren't live on that chain yet; quoting works, swapping doesn't. |
| Quote looks stale/slow | Set a dedicated `RPC_URL_*` in `.env`; the public fallbacks are rate-limited. |

## Contributing & security

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` runs an offline unit suite with golden byte vectors; `invictae doctor` verifies config changes against the live chains. Vulnerabilities: see [SECURITY.md](SECURITY.md) (private reporting, please).

This CLI is MIT-licensed; use it, fork it, or wire its `lib/` (quote preparation, transaction building, lifecycle tracker) into your own tooling.

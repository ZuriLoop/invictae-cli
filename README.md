# invictae

Cross-chain swap CLI: pay with what you hold on one chain, receive what you want on another — stablecoins, native coins, blue chips, and tokenized U.S. stocks — in one approval, with no solvers and no off-chain fill trust.

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

The CLI is built to be driven by software: `--json` on every command (one object for reads, NDJSON for streams), data on stdout and narration on stderr, documented exit codes, a `schema` command that returns the full interface as JSON, and compact positional syntax — `invictae quote 100 usdc@base eth@arbitrum`. `swap` refuses to broadcast non-interactively without `--yes`, and `--dry-run` returns raw signable payloads without touching a key. See [AGENTS.md](AGENTS.md).

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

- No solvers, no private orderflow: bridging is Circle/Tether/Stargate's own systems; swaps are public AMMs.
- The order carries the user's slippage floor and deadline; the destination contract enforces them.
- Any failure after funds land refunds the stablecoin to the buyer on the destination chain, escrowed claimably (`invictae refunds --claim`) if the token rejects the transfer.
- Quotes scan every venue × fee tier (including two-hop routes through the wrapped native) and route to the best fill; the chosen venue is pinned in the signed order.

This CLI is MIT-licensed; use it, fork it, or wire its `lib/` (quote preparation, transaction building, lifecycle tracker) into your own tooling.

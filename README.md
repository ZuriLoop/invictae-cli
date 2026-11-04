# invictae

Cross-chain swap CLI on LayerZero: pay with what you hold on one chain, receive what you want on another — stablecoins, native coins, blue chips, and tokenized U.S. stocks — in one approval, with no solvers and no off-chain fill trust.

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
| `status` | One-shot "where's my money" across LayerZero Scan and Circle Iris. |
| `relay` | Complete a CCTP swap yourself (permissionless); `--fee` requests the order-capped relayer fee. |
| `chains` / `routes` / `venues` / `tokens` | What's supported: 12 chains, the rail connecting any two of them per stable, venue routability, and the curated token registry (xStocks, Ondo tokenized stocks). |
| `balances` / `refunds` / `history` | Account views; `refunds --claim` pays out escrowed refunds. |
| `doctor` | Live verification of every configured chain: RPC identity, LayerZero endpoints, each bridge's wrapped token, venue router/quoter pairing, and deployed-contract wiring. Non-zero exit for CI. |

## Chains

Ethereum, BNB Chain, Base, Arbitrum, Optimism, HyperEVM, Polygon, Avalanche, Unichain, Sei, Mantle, Plasma. Rails and venues per chain live in `config/chains.json`; every address in it is verifiable with `invictae doctor`, which checks the live chain, not this repo's claims.

## Trust model

- No solvers, no private orderflow: bridging is Circle/Tether/Stargate's own systems; swaps are public AMMs.
- The order carries the user's slippage floor and deadline; the destination contract enforces them.
- Any failure after funds land refunds the stablecoin to the buyer on the destination chain, escrowed claimably (`invictae refunds --claim`) if the token rejects the transfer.
- Quotes scan every venue × fee tier (including two-hop routes through the wrapped native) and route to the best fill; the chosen venue is pinned in the signed order.

The protocol contracts live in the [Invictae](https://github.com/ZuriLoop/invictae-xyz) repository. This CLI is MIT-licensed; use it, fork it, or wire its `lib/` (quote preparation, transaction building, lifecycle tracker) into your own tooling.

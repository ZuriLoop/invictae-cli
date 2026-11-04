---
name: invictae
description: Cross-chain swaps and transfers from the command line — quote, execute, and track swaps of stablecoins, native coins, and tokenized stocks across 12 chains. Use when the user wants to move or swap crypto assets between chains, check cross-chain routes/balances, or follow an in-flight swap to its outcome.
---

# invictae — cross-chain swaps

You drive the `invictae` CLI. It is designed for agents: pass `--json` and stdout is pure JSON (one object for reads, NDJSON for streams); progress text goes to stderr; exit code 0 means success.

## Setup check

```bash
invictae --version || npm install -g invictae
invictae doctor --json   # verifies every chain's wiring; ok:true means ready
```

`PRIVATE_KEY` in the environment is needed only for `swap`, `relay`, and `refunds --claim`. Never print or echo it.

## Core flow

1. **Discover**: `invictae chains --json`, `invictae routes --from <a> --to <b> --json`, `invictae tokens <chain> --json`.
2. **Quote** (read-only): `invictae quote 100 usdc@base eth@arbitrum --json`. Amounts in the JSON are integer strings in each token's own decimals. `--exact-out` works backwards from the amount to receive.
3. **Inspect before signing**: add `--dry-run --json --buyer <address>` to `swap` — the plan event contains the raw transactions without signing anything.
4. **Execute**: `invictae swap 100 usdc@base eth@arbitrum --yes --json` streams NDJSON events (`plan`, `tx`, `step`…, `done`). The final step is the on-chain outcome: `executed`, `refunded`, `escrowed`, or `timeout`.
5. **Re-attach anytime**: `invictae watch --from <chain> --tx <hash> --json`.

## Rules

- Prefer registry tickers (`invictae tokens <chain>`) or explicit addresses. If a quote's `payVia` or `outVia` is `"coingecko"`, STOP and show the user the resolved address for confirmation; `swap` will refuse such tokens without `--allow-unverified`.
- Always quote before swapping and show the user `expectedOut`, `minOut`, and fees before asking to proceed. Never pass `--yes` without the user's explicit go-ahead for that specific swap.
- `minOut` is enforced on-chain. Do not widen `--slippage-bps` beyond 100 unless the user asks.
- On the CCTP rail, if the stream stalls at `attested`, finish with `invictae relay --from <src> --to <dst> --tx <hash>`.
- If a swap ends `escrowed`, recover with `invictae refunds --chain <dst> --address <buyer> --claim`.
- `invictae schema` returns the full machine-readable interface if you need flags or output shapes.

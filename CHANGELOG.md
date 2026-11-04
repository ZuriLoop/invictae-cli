# Changelog

## 0.2.0 — 2026-11-04

- Agent-first interface: `--json` on every command (NDJSON event streams for `swap`/`watch`), data on stdout / narration on stderr, `schema` command, `AGENTS.md`.
- Positional syntax: `invictae quote 100 usdc@base eth@arbitrum`.
- Ticker resolution: curated on-chain-verified registry (103 entries, 12 chains) plus a CoinGecko fallback re-verified against the contract's `symbol()`; chain inputs accept names, aliases, chain ids, and endpoint ids.
- Non-interactive safety: `swap` requires `--yes` without a TTY; `--dry-run` returns signable payloads without a key.
- Offline unit suite (`npm test`) with golden byte vectors for the options/path/order encodings.
- Zero bridge-SDK dependencies: the options encoding is built in (byte-validated against the reference implementation).

## 0.1.0 — 2026-11-04

- Initial release: quote, swap (confirmation + live step following), watch, status, relay, chains, routes, venues, tokens, balances, refunds --claim, history, doctor across 12 chains and three stable rails.

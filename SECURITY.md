# Security Policy

This CLI signs transactions with a locally held key. Bugs that could lead to loss of funds — wrong addresses, broken slippage math, payload-encoding errors, ticker-resolution confusion — are security issues even when they look like UX.

## Threat model (what is enforced where)

| Threat | Enforcement |
| --- | --- |
| Agent tricked into swapping to an attacker's token | Curated on-chain-verified registry; CoinGecko fallback re-verified against `symbol()` and refused by `swap`/MCP without explicit override |
| Agent exceeds its mandate | Policy file enforced **in code, outside the model** (per-swap cap, daily cap, chains, token tiers, recipients); amounts above `escalateAbove` require a human at an interactive terminal — the MCP server cannot approve them |
| Retry storms double-spending | Idempotency keys; the local ledger is hash-chained (tamper-evident; `verifyLedger`) |
| Malicious dependency | 3 runtime deps, exact-pinned, lockfile, `npm ci`, no postinstall scripts, no bridge SDK (encodings in-repo with golden-vector tests) |
| Key exposure | Key never leaves the environment; never required for reads; MCP read tools function without it |
| Funds stuck mid-route | Contract-enforced refunds/escrow on the destination; `refunds --claim` is permissionless |

## Reporting

Please use GitHub's private vulnerability reporting on this repository ("Security" → "Report a vulnerability"). Do not open public issues for anything that could put user funds at risk. We aim to acknowledge reports within 72 hours.

## Supply-chain posture

- **Three runtime dependencies** (`commander`, `dotenv`, `ethers`), pinned to exact versions with a committed lockfile; CI installs with `npm ci` and fails on critical advisories. No postinstall scripts.
- **Zero known production advisories.** The CLI runs on ethers v6 (noble-curves cryptography); `npm audit --omit=dev` is clean and CI fails on high-severity production advisories.
- The options/path/order byte encodings are implemented in-repo with golden-vector tests — no bridge SDK in the dependency tree.
- Tokens resolved outside the curated registry cannot be swapped without `--allow-unverified`; the registry itself only admits addresses that answered `symbol()` on-chain at build time.

## Scope notes

- The CLI never transmits your private key; it is read from the environment and used only to sign locally.
- Ticker resolution falls back to CoinGecko for unknown symbols; the result is re-verified against the contract's on-chain `symbol()` and flagged in the output. Treat the flag as part of the security model: verify flagged addresses before swapping.
- `--dry-run` must never sign or broadcast; a violation of that invariant is a critical bug.

# Security Policy

This CLI signs transactions with a locally held key. Bugs that could lead to loss of funds — wrong addresses, broken slippage math, payload-encoding errors, ticker-resolution confusion — are security issues even when they look like UX.

## Reporting

Please use GitHub's private vulnerability reporting on this repository ("Security" → "Report a vulnerability"). Do not open public issues for anything that could put user funds at risk. We aim to acknowledge reports within 72 hours.

## Scope notes

- The CLI never transmits your private key; it is read from the environment and used only to sign locally.
- Ticker resolution falls back to CoinGecko for unknown symbols; the result is re-verified against the contract's on-chain `symbol()` and flagged in the output. Treat the flag as part of the security model: verify flagged addresses before swapping.
- `--dry-run` must never sign or broadcast; a violation of that invariant is a critical bug.

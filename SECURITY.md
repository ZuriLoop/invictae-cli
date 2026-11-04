# Security Policy

This CLI signs transactions with a locally held key. Bugs that could lead to loss of funds — wrong addresses, broken slippage math, payload-encoding errors, ticker-resolution confusion — are security issues even when they look like UX.

## Reporting

Please use GitHub's private vulnerability reporting on this repository ("Security" → "Report a vulnerability"). Do not open public issues for anything that could put user funds at risk. We aim to acknowledge reports within 72 hours.

## Supply-chain posture

- **Three runtime dependencies** (`commander`, `dotenv`, `ethers`), pinned to exact versions with a committed lockfile; CI installs with `npm ci` and fails on critical advisories. No postinstall scripts.
- **Known advisory, accepted for now:** ethers v5 transitively bundles an `elliptic` version with a published advisory (GHSA-848j-6mx2-7j84). The affected edge cases are in signature verification paths; local signing uses deterministic nonces. The planned fix is the ethers v6 migration (noble-curves based), tracked as the next minor release. We state this rather than suppress it.
- The options/path/order byte encodings are implemented in-repo with golden-vector tests — no bridge SDK in the dependency tree.
- Tokens resolved outside the curated registry cannot be swapped without `--allow-unverified`; the registry itself only admits addresses that answered `symbol()` on-chain at build time.

## Scope notes

- The CLI never transmits your private key; it is read from the environment and used only to sign locally.
- Ticker resolution falls back to CoinGecko for unknown symbols; the result is re-verified against the contract's on-chain `symbol()` and flagged in the output. Treat the flag as part of the security model: verify flagged addresses before swapping.
- `--dry-run` must never sign or broadcast; a violation of that invariant is a critical bug.

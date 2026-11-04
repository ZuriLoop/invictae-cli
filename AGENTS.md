# invictae — agent guide

This CLI is designed to be driven by AI agents and scripts. Read this once; `invictae schema` returns the same contract as JSON.

## Conventions

- **stdout is data.** With `--json`, every command prints machine output only: one JSON object for reads, NDJSON (one JSON object per line) for streams (`swap`, `watch`). Without `--json`, stdout is human tables.
- **stderr is narration.** Spinners, progress, and warnings go to stderr. Never parse it.
- **Exit codes:** `0` success; `1` error (message on stderr as `error: …`) or failed `doctor` checks.
- **Nothing signs without intent.** `quote`, `watch`, `status`, and all discovery/account reads are safe. `swap`, `relay`, and `refunds --claim` need `PRIVATE_KEY` in the environment. `swap` refuses to broadcast in a non-interactive session unless `--yes` is passed; `--dry-run` returns the exact transactions without signing anything.

## Inputs

- **Tokens** (`--pay`, `--token-out`): a ticker (curated registry first, then a live CoinGecko fallback that is re-verified against the contract's on-chain `symbol()` — check `payVia`/`outVia` in the JSON: the value `coingecko` means you should confirm `payToken`/`tokenOutResolved` is the contract you intend), `eth`/`native`, a wrapped symbol (`WETH`, `WBNB`, …), or an ERC-20 address. Addresses are always the unambiguous choice.
- **Chains** (`--from`, `--to`, `--chain`): names (`base`), aliases (`eth`, `bsc`, `arb`, `op`, `matic`, `avax`, `hype`, `uni`), chain ids (`8453`), or LayerZero EIDs (`30184`).
- **Positional shorthand:** `invictae quote 100 usdc@base eth@arbitrum` ≡ `--amount 100 --pay usdc --from base --token-out eth --to arbitrum`.

## Recipes

Discover what exists:
```bash
invictae chains --json
invictae routes --from base --to bnb --json
invictae tokens base --json
```

Quote (read-only, no key needed):
```bash
invictae quote 100 usdc@base eth@arbitrum --json
# → {"rail":"cctp","amountIn":"100000000","expectedOut":"…","minOut":"…","dstVenue":{"venue":"uniswap","tier":500},…}
```
Amounts are integer strings in the token's own decimals. `arrives`/`feeAmount`/`maxRelayFee` are in the destination stable's decimals; `expectedOut`/`minOut` in the out token's decimals.

Inspect before signing:
```bash
invictae swap 100 usdc@base eth@arbitrum --dry-run --json --buyer 0xYou
# plan event includes txs: [{label,to,data,value}] — raw payloads you can sign elsewhere
```

Execute and follow (NDJSON until a final event):
```bash
invictae swap 100 usdc@base eth@arbitrum --yes --json
# {"event":"plan",…}
# {"event":"tx","label":"zapCctp","hash":"0x…"}
# {"event":"step","step":"source_confirmed","state":"done",…}
# {"event":"step","step":"executed","state":"done","final":true,…}
# {"event":"done","outcome":"executed","txHash":"0x…"}
```
Terminal outcomes: `executed` (buyer paid), `refunded` (stable returned to buyer on the destination), `escrowed` (claim with `invictae refunds --chain <dst> --address <buyer> --claim`), `timeout` (keep watching with `invictae watch`).

Re-attach to any swap:
```bash
invictae watch --from base --tx 0x… --json
```

Health-check everything before operating:
```bash
invictae doctor --json   # exit 1 if any check fails
```

## Safety notes for agents

1. Prefer registry tickers or raw addresses. If a quote's `payVia` or `outVia` is `"coingecko"`, surface the resolved address to your principal before swapping.
2. `minOut` is enforced on-chain; widen `--slippage-bps` only deliberately.
3. On the CCTP rail, `swap --json` ends with `attested` → `executed` only if a relayer runs; otherwise finish with `invictae relay --from <src> --to <dst> --tx <hash>` (also permissionless).
4. Never echo `PRIVATE_KEY` or write it anywhere; the CLI only reads it from the environment.

# Contributing

Thanks for considering a contribution.

## Setup

```bash
git clone https://github.com/ZuriLoop/invictae-cli.git
cd invictae-cli
npm install
npm test          # builds, then runs the offline unit suite
npm run dev -- chains   # run from source
```

## Ground rules

- `npm test` must pass. Tests are offline by design — no RPC calls, no network; new library behavior needs a test.
- Keep stdout parseable: data goes to stdout only under `--json`; anything decorative goes through `ui.ts` (which writes to stderr). Breaking a `--json` shape is a breaking change — call it out in the PR.
- Config changes (`config/chains.json`, `config/tokens.json`) must be verifiable on-chain. `invictae doctor` has to pass for chain/rail changes; registry additions go through `node scripts/build-registry.mjs` (it refuses addresses that don't answer `symbol()`).
- No new runtime dependencies without discussion — the dependency tree is deliberately tiny (`commander`, `dotenv`, `ethers`).
- Commits: present-tense summary line; explain the why in the body.

## Releases

Maintainers bump `version` in `package.json`, update `CHANGELOG.md`, tag, and `npm publish` (the `prepublishOnly` hook builds).

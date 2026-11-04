# Distribution checklist (triaged, Nov 2026)

Ordered by value. Artifacts referenced below are already in the repo.

1. **npm publish** — prerequisite for most of the rest. `npm publish` (add `--provenance` for supply-chain attestation). Package name `invictae`; `mcpName` field already set.
2. **Official MCP Registry** — the canonical source; Glama/PulseMCP mirror it. `server.json` is committed. Steps: install `mcp-publisher`, authenticate with GitHub (namespace `io.github.zuriloop`), `mcp-publisher publish`. ~30 min.
3. **skills.sh** — `SKILL.md` is at the repo root; submit the repo URL on skills.sh. Users install with `npx skills add ZuriLoop/invictae-cli`.
4. **Glama** (glama.ai/mcp/servers) — auto-indexes; claim the listing, add a logo.
5. **awesome-mcp-servers (punkpeye)** — one-line PR, alphabetical:
   > [invictae](https://github.com/ZuriLoop/invictae-cli) — Cross-chain swaps across 12 chains: quote, plan, confirm-gated execute with local policy guardrails (spend caps, escalation), and lifecycle tracking. Dependency-free stdio server.
6. **Claude Code plugin** — `.claude-plugin/marketplace.json` is committed; users run `claude plugin marketplace add ZuriLoop/invictae-cli`. Also submit to community marketplace indexes.
7. **Anthropic Connectors Directory** — tool `title`s + `readOnlyHint`/`destructiveHint` annotations and the README Privacy policy section are in place (their stdio requirements). Submit via claude.com/docs/connectors/building/submission. Curated; no guarantee.
8. **cryptoskill.org** — Quick Submit form (name, repo URL, category). Trivial.
9. **ClawHub** — submit the skill; passes VirusTotal/ClawScan trivially (dependency-free). Crypto-native audience.
10. **x402 ecosystem** — after integrating `@x402/mcp` (roadmap): listing via the x402-foundation repo / slack.x402.org.
11. **OpenAI Apps Directory** — blocked on a hosted (remote) MCP endpoint + org verification; confirm crypto policy fit first.
12. **PulseMCP** — submissions paused (Oct 2026); re-check monthly. **Skip**: Smithery hosting (shut down), SEO-shell directories (accept auto-indexing only).

## Launch sequencing
- **Quiet launch now**: Show HN + r/ethdev on the "agent-safe, read-only-by-default, verify-with-doctor" story (demo SVG + policy file as the hook).
- **Loud launch at mainnet**: benchmark-led ("same $1000 transfer: us vs aggregators"), second HN post ("now live on 12 chains").

## Positioning note
After the ClawHub malware wave (hundreds of malicious crypto skills found early 2026), the market is primed for exactly our pitch: auditable, dependency-free, policy-guarded, no key custody — with evidence in the repo (threat model, golden-vector tests, hash-chained ledger), not adjectives.

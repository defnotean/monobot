# Security & Architecture Audits

Read-only audits of distinct subsystems. Each file follows the same shape:
inventory, defense layers, per-component findings, top-5 risk list, and
remediation. Severity reflects the highest-ranked finding in that audit.

| Audit | Scope | Last audited | Top headline finding | Severity |
|---|---|---|---|---|
| [AUDIT-discord-intents.md](./AUDIT-discord-intents.md) | Every `GatewayIntentBits.*` on both bots vs the events actually wired up. | 2026-05-16 | All declared intents on both bots map to live code paths — current declarations are tight; nothing to remove. | MEDIUM |
| [AUDIT-economy-gambling.md](./AUDIT-economy-gambling.md) | Balance mutations, multi-player pots (poker / lottery / heist / auction), RNG, and overflow across `packages/eris/`. | 2026-06-01 | Original bank double-credit finding is fixed; race tests now cover parallel deposits and withdrawals. | MEDIUM |
| [AUDIT-env-vars.md](./AUDIT-env-vars.md) | Every `process.env.*` callsite, both `.env.example` files, and the boot fail-fast loop. | 2026-06-01 | `REQUIRE_PERSISTENCE=1`, env examples, Lavalink password handling, and secret redaction have been rechecked; residual risk is operator secret handling. | LOW |
| [AUDIT-github-tools.md](./AUDIT-github-tools.md) | Eris's five GitHub executor tools + the two deploy-adjacent tools that share the same Octokit/PAT. | 2026-06-01 | Original Render `serviceId` URL injection is fixed; service ids are validated/encoded and write ops use `GITHUB_REPO_ALLOWLIST`. | MEDIUM |
| [AUDIT-irene-moderation.md](./AUDIT-irene-moderation.md) | Irene's slash mod commands, the auto-mod pipeline, and the AI-tool mod calls in `moderationExecutor.js`. | 2026-06-01 | AI-initiated destructive moderation now defers to human confirmation, with regression tests for confirm and audit paths. | MEDIUM |
| [AUDIT-pc-agent.md](./AUDIT-pc-agent.md) | Eris's owner-only host-execution pipeline — `pcAgent.js` gates, PC tools, and the Electron agent-UI poller. | 2026-06-01 | Original agent-UI kill-switch gap is fixed; PC-agent remains intentionally powerful and should stay disabled on hosted deployments. | HIGH |
| [AUDIT-web-tools.md](./AUDIT-web-tools.md) | Every code path where the bots fetch user/LLM-supplied URLs or run upstream web searches; the `safeFetch` defense-in-depth chain. | 2026-06-01 | Search backends now route through `safeFetch`; remaining notes focus on HTML stripping and firewall fail-closed behavior. | MEDIUM |

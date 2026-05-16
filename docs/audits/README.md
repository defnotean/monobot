# Security & Architecture Audits

Read-only audits of distinct subsystems. Each file follows the same shape:
inventory, defense layers, per-component findings, top-5 risk list, and
remediation. Severity reflects the highest-ranked finding in that audit.

| Audit | Scope | Last audited | Top headline finding | Severity |
|---|---|---|---|---|
| [AUDIT-discord-intents.md](./AUDIT-discord-intents.md) | Every `GatewayIntentBits.*` on both bots vs the events actually wired up. | 2026-05-16 | All declared intents on both bots map to live code paths — current declarations are tight; nothing to remove. | MEDIUM |
| [AUDIT-economy-gambling.md](./AUDIT-economy-gambling.md) | Balance mutations, multi-player pots (poker / lottery / heist / auction), RNG, and overflow across `packages/eris/`. | 2026-05-16 | `/bank deposit` and `/bank withdraw` slash paths are non-atomic — parallel requests can double-credit the bank from a single wallet debit. | HIGH |
| [AUDIT-env-vars.md](./AUDIT-env-vars.md) | Every `process.env.*` callsite, both `.env.example` files, and the boot fail-fast loop. | 2026-05-16 | `REQUIRE_PERSISTENCE=1` is documented in both `.env.example` files but the validation block silently ignores it. | MEDIUM |
| [AUDIT-github-tools.md](./AUDIT-github-tools.md) | Eris's five GitHub executor tools + the two deploy-adjacent tools that share the same Octokit/PAT. | 2026-05-16 | `check_deploy` interpolates `serviceId` unescaped into the Render REST URL under the bot's bearer token. | HIGH |
| [AUDIT-irene-moderation.md](./AUDIT-irene-moderation.md) | Irene's slash mod commands, the auto-mod pipeline, and the 18 AI-tool mod calls in `moderationExecutor.js`. | 2026-05-16 | No confirmation step on destructive AI tool calls — a fuzzy `findMember` match plus a mis-parsed "ban whoever's been spamming" can ban the wrong person. | HIGH |
| [AUDIT-pc-agent.md](./AUDIT-pc-agent.md) | Eris's owner-only host-execution pipeline — `pcAgent.js` gates, six PC tools, and the Electron agent-UI poller. | 2026-05-16 | The agent-UI Electron poller drains and executes queued commands regardless of `PC_AGENT_DISABLED` — kill switch only blocks enqueue. | CRITICAL |
| [AUDIT-web-tools.md](./AUDIT-web-tools.md) | Every code path where the bots fetch user/LLM-supplied URLs or run upstream web searches; the `safeFetch` defense-in-depth chain. | 2026-05-16 | `performWebSearch` has no response-size cap on any backend — a compromised upstream can OOM the process with a multi-GB body. | HIGH |

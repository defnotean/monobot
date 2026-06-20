# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file tracks the MonoBot monorepo as a whole. Individual package versions
are recorded in `packages/eris/package.json` (currently `3.2.0`) and
`packages/irene/package.json` (currently `2.2.0`).

## [Unreleased]

P0 + P1 hardening pass across the monorepo. High-level summary:

### Added
- CI workflow (`.github/workflows/test.yml`): runs the version-sync lint,
  `npm audit --audit-level=moderate`, the full test suite, and the
  `tsc --noEmit` typecheck across a Node 22/24 matrix on push and pull
  request — the target the README CI badge points at.
- Shared local vision helper (`@defnotean/shared/localVision`) for conservative
  Ollama-backed image evidence. Eris and Irene now support multiple image
  attachments while keeping raw image bytes local and out of the external chat
  provider request.
- Local vision crop passes for tall/large screenshots, so phone screenshots can
  preserve small UI text instead of relying only on one downscaled whole-image
  pass.
- `npm run provision:gemini-keys` helper for Google Cloud CLI users. It creates
  restricted Gemini API keys and writes them to the local bot `.env` files
  without printing key values.
- Irene channel-level AI silence controls, so admins can tell Irene to stop or
  resume responding in a specific channel.
- Irene gateway watchdog and login retry helpers to recover from repeated
  Discord gateway opening-handshake timeouts without losing the HTTP liveness
  server.
- Irene TikTok embed fixer for public TikTok links, including short
  `vm.tiktok.com` and `vt.tiktok.com` URLs.
- ElevenLabs integration surfaces for Irene TTS, voice transcription, audio
  isolation, sound-effect generation, and multi-speaker dialogue clips.
- Owner-only Higgsfield bridge tools for video generation, image animation,
  short-form clip jobs, reusable character training, and virality scoring.

### Changed
- Dev loop now uses `node --watch index.js` (Node 22.12.0+ in this repo) for both
  bots instead of the broken `tsx --watch index.ts` (only `index.js` ships),
  so `npm run dev:eris` / `dev:irene` work on a clean checkout.
- Render `buildCommand` switched from `npm install` to `npm ci` for both
  services so deploys honour the committed lockfile.
- Image analysis is now evidence-first: the local vision prompt asks for
  `Visible`, `Text`, and `Unclear` facts, the chat model is told not to invent
  visual details from filenames/URLs, and the default local vision model is
  `qwen2.5vl:7b`.
- Irene keeps the Discord typing indicator alive during slow local vision,
  prompt building, model generation, and tool calls, then hands off to the
  human-paced reply sender.
- Irene welcome templates now treat `{user}` as display text and `{mention}` as
  the explicit ping placeholder, avoiding duplicate mentions in public welcome
  copy.
- Health/readiness probes now tolerate discord.js `isReady()` lag when the
  websocket is already open and the bot user is populated.

### Fixed
- Documentation honesty: corrected the `ARCHITECTURE.md` tool-surface claim
  that Eris uses the two-tier tool path — neither bot does today; the full
  (profile-filtered) schema is sent every turn and the registry tiering is
  planned/being wired.
- Irene TTS toggle requests now route directly to the TTS tool instead of the
  wake-word/STT listener. Enabling TTS verifies the Lavalink join before saving
  the channel setting and surfaces join/playback failures.
- Irene image generation rotates across configured Gemini keys, retries
  transient upstream failures, uses a longer image-tool timeout, and avoids
  repeatedly re-calling generation after provider failures.
- Eris `analyze_image` no longer falls back to sending raw image bytes to
  Gemini; it uses the same local multi-image evidence path as normal chat.
- `safeFetch`'s DNS-pinned Undici dispatcher now supports lookup callers that
  request `all: true`, fixing newer Node/Undici callback shape compatibility.
- The foreground launcher now exits when either bot exits instead of waiting
  for both processes, letting the cleanup trap re-arm systemd promptly.

## [3.2.0] - 2026-05-16

Hardening release. Closes several CRITICAL and HIGH severity findings surfaced
by the security audits in `docs/audits/`, extracts duplicated code into a
shared package, splits the message-handling god-functions, and adds the test
and documentation scaffolding that a public repository needs.

### Added
- Shared package `@defnotean/shared` extracted from files duplicated between
  Eris and Irene (logger, key pool, `safeFetch`, `lruCache`, `rateLimit`,
  `twinSign`, `roleCategorizer`).
- LLM-based episodic-memory consolidation for users above the size threshold,
  plus periodic prune to bound memory growth.
- Saga log and reconciliation pass for Irene's dual-write fanout to catch
  drift between the primary store and downstream caches.
- In-memory cache schema defaults wired into seven Irene DB getters.
- Deterministic test harness with fake timers and seeded RNG for reproducible
  test runs across CI and local development.
- Event-handler test coverage: Eris `guildCreate`, `ready`,
  `messageReactionAdd`; Irene `guildBanAdd`, `voiceStateUpdate`.
- GitHub Actions test workflow, Dependabot config, CODEOWNERS, PR and issue
  templates, `.editorconfig`, `.gitattributes`.
- README CI status badge.
- Documentation: `SECURITY.md`, `ARCHITECTURE.md`, `MONITORING.md`,
  `SCALING.md`, `CONFIGURATION.md`, `PERSISTENCE.md`, `TOOLCALLING.md`,
  audit index (`docs/audits/README.md`), and seven subsystem audits covering
  Discord intents, economy & gambling, env vars, GitHub tools, Irene
  moderation, the PC-agent surface, and web tools.
- Module-header documentation pass across shared/eris/irene
  (`safeFetch`, `lruCache`, `rateLimit`, `twinSign`, `roleCategorizer`,
  eris/irene `database`, `personality`, `messageCreate`, `executor`).
- Glossary, debugging, and cheatsheet refreshes; local-dev guide for
  migration apply and twin local testing; testing patterns doc for
  fake-timer + seeded-RNG.

### Changed
- Split both `messageCreate` god-functions (Eris and Irene) into per-phase
  modules to make the hot path readable and unit-testable.
- Eris `messageCreate` cold-path modules are now lazy-imported (was 18 eager
  imports), trimming cold-start work.
- Single source of truth for the economy-mutating tool list in Eris's
  executor.
- Tightened the Eris flush debounce to 200ms and bounded the shutdown drain
  so graceful exits no longer hang on backlogged writes.
- Cleaned up stale documentation references surfaced during the
  public-release audit; cross-linked `SECURITY.md` from `README.md` and
  `GETTING_STARTED.md`.
- Documented `WEB_SEARCH_GEMINI_GROUNDING` and `TWIN_BOT_ID` in the env
  template.

### Fixed
- Eris `/bank deposit` and `/bank withdraw` are now atomic, eliminating the
  double-credit window where parallel requests could mint money against a
  single wallet debit.
- Eris gambling stake deduction uses `tryDeductBalance` (atomic) instead of
  read-then-write.
- Atomic balance RPC migration (`pkg_eris_economy.adjust_balance`) so
  concurrent economy updates can no longer interleave and lose writes.
- Blackjack interactions reject re-entrant button clicks, closing a
  double-spend window when a user hammered Hit/Stand during latency spikes.
- Rate-limited the `/api/twin/state` endpoint and refreshed `ask_eris` docs
  to match current behaviour, preventing trivial flood abuse against the
  twin bridge.
- Widened the semantic-cache `msgHash` to a 64-bit SHA-256 prefix, removing
  collisions that occasionally returned the wrong cached response.
- Concurrency and lifecycle holes in the Irene AI subsystem (overlapping
  turns, dangling listeners on disconnect, double-fire on retry).
- Irene mod tools: explicit per-permission re-check on destructive AI calls;
  AI-path `warn_user` escalation capped at TIMEOUT (no silent auto-ban).
- Eris executor: structured unknown-tool error and alias-vs-registry parity
  check at boot.
- Logger redacts secrets and truncates oversized payloads before write.
- Memory proxy (`media`) routes URL fetches through `safeFetch` and applies
  per-user rate limits.
- All web-search backends now route through `safeFetch` (was bypassing the
  defense chain on some providers).
- GitHub deploy tool: repository allowlist enforced, `serviceId`
  `encodeURIComponent`'d before interpolation into the Render REST URL.
- Eris `REQUIRE_PERSISTENCE=1` now fail-fasts at boot (parity with Irene),
  instead of being silently ignored.
- Irene Lavalink: refuses to connect with the default password against a
  non-localhost host.
- Stabilized three Eris tests under parallel worker mode.

### Security
- **CRITICAL — PC-agent bypasses closed.** The Electron agent-UI poller
  previously drained and executed queued commands regardless of
  `PC_AGENT_DISABLED` (kill switch only blocked enqueue). Closed, along with
  alias, encoded-command, chained, and unicode-whitespace bypasses in the
  PC-agent command parser.
- **HIGH — CORS hardening.** `/api/*` endpoints now require exact-origin
  match (was permissive prefix match); twin `/punish` endpoint moved to
  HMAC-only auth.
- **HIGH — Twin punish HMAC.** The cross-bot punish channel no longer
  accepts bearer tokens; HMAC-signed payloads only.
- **HIGH — Economy double-spend.** The atomic bank deposit/withdraw fix, the
  atomic stake deduction, the atomic `adjust_balance` RPC, and the
  blackjack re-entrancy guard together close four race-condition based
  double-spend paths in the economy.
- **HIGH — Logger PII/secret leak.** Logger now redacts known secret-shaped
  keys and truncates payloads above the size threshold.
- **MEDIUM — SSRF defense parity.** All web-search backends and media-URL
  fetches now flow through `safeFetch` (DNS rebinding, private IP, and
  scheme guards apply uniformly).
- Seven subsystem security audits published under `docs/audits/` covering
  Discord intents, economy & gambling, env vars, GitHub tools, Irene
  moderation, the PC-agent surface, and web tools.

### Removed
- Duplicated copies of shared utilities from `packages/eris/` and
  `packages/irene/` (now consumed from `@defnotean/shared`).

## [3.1.0] - 2026-05-16

First public, self-hostable release of MonoBot. Prior history is internal and
not reproduced here; this entry summarises the state at the time of opening
the repository.

### Added
- Full self-hosting support: setup docs, environment templates, and an
  `EXTERNAL_URL` fallback so the twin bridge works without a fixed deployment
  URL.
- Local AI provider documentation and wiring for Ollama and LM Studio,
  letting operators run Eris and Irene against an on-box model rather than a
  hosted API.
- Universal web search engine support, including Brave Search Pro (with
  `extra_snippets` and Brave Answers), with a hard latency cap and per-turn
  result reuse to keep token spend predictable.
- Cross-platform shell scripts and a graceful deploy-tools flow so the
  monorepo runs on Windows, macOS, and Linux out of the box.

### Changed
- Refactored the monorepo to remove legacy code paths that only made sense
  for the internal deployment, simplifying the public surface.
- Scrubbed deployment- and identity-specific details (URLs, owner handles,
  internal IDs) from source; everything sensitive now lives in environment
  variables.
- Replaced ad-hoc OpenRouter model selection with explicit per-environment
  config (Owl Alpha, Qwen, NVIDIA Kimi K2.6).

### Fixed
- Numerous AI pipeline fixes: DDG Lite POST fallback now bypasses `safeFetch`
  correctly, `safeFetch` accepts method and body, hallucinated JSON tool
  calls in OpenAI-compatible providers are repaired rather than crashing,
  unescaped quotes in tool calls are handled, the "crack someone" slang case
  in DDG fallback is repaired, and Gemini grounding is gated behind a
  slang-guard to reduce false-positive refusals.
- Tuned the casual-emotion prompt path so Eris and Irene no longer reflex
  into therapy-bot mode on mild negative wording.

### Security
- All Discord IDs, webhook URLs, and provider keys are now env-only; nothing
  identifying the original deployment ships in the repository.

[Unreleased]: https://github.com/defnotean/monobot/compare/v3.2.0...HEAD
[3.2.0]: https://github.com/defnotean/monobot/releases/tag/v3.2.0

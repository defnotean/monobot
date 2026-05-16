# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file tracks the MonoBot monorepo as a whole. Individual package versions
are recorded in `packages/eris/package.json` (currently `3.1.0`) and
`packages/irene/package.json` (currently `2.1.0`).

## [Unreleased]

### Added
- Deterministic test harness with fake timers and seeded RNG for reproducible
  runs across CI and local development.

### Changed
- Tightened the Eris flush debounce to 200ms and bounded the shutdown drain so
  graceful exits no longer hang on backlogged writes.
- Cleaned up stale documentation references surfaced during the public-release
  audit.

### Fixed
- Rate-limited the `/api/twin/state` endpoint and refreshed `ask_eris` docs to
  match current behaviour, preventing trivial flood abuse against the twin
  bridge.
- Added an atomic balance RPC migration (`pkg_eris_economy.adjust_balance`) so
  concurrent economy updates can no longer interleave and lose writes.
- Blackjack interactions now reject re-entrant button clicks, eliminating a
  double-spend window when a user hammered Hit/Stand during latency spikes.
- Widened the semantic-cache `msgHash` to a 64-bit SHA-256 prefix, removing
  collisions that occasionally returned the wrong cached response.
- Closed several concurrency and lifecycle holes in the Irene AI subsystem
  (overlapping turns, dangling listeners on disconnect, double-fire on retry).

### Security
- The atomic balance RPC and blackjack re-entrancy guard together close two
  race-condition based double-spend paths in the economy.

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

[Unreleased]: https://github.com/defnotean/MonoBot/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/defnotean/MonoBot/releases/tag/v3.1.0

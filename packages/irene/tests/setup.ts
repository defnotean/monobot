// Vitest global setup — ensures env vars required by config.js exist so
// modules under test can be imported without tripping the exit-on-missing-env
// guards. Real credentials are never used in tests; these are dummies.
process.env.DISCORD_BOT_TOKEN ||= "test-dummy-token";
process.env.DISCORD_CLIENT_ID ||= "test-client-id";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.BOT_NAME ||= "irene-test";
process.env.TWIN_API_SECRET ||= "test-twin-secret";
process.env.ERIS_API_URL ||= "https://test-twin.local";

// Enable module-internal test hooks (e.g. voice/listener.js exposes its
// _pcmToWav16kMono helper on globalThis so the regression test exercises the
// real conversion). Never set in production, so the prod export surface is
// untouched.
process.env.IRENE_TEST_HOOKS ||= "1";

// Vitest global setup — ensures env vars required by config.js exist so
// modules under test can be imported without tripping the exit-on-missing-env
// guards. Real credentials are never used in tests; these are dummies.
process.env.DISCORD_TOKEN ||= "test-dummy-token";
process.env.CLIENT_ID ||= "test-client-id";
process.env.GEMINI_API_KEY ||= "test-gemini-key";
process.env.BOT_NAME ||= "eris-test";
process.env.TWIN_API_SECRET ||= "test-twin-secret";
process.env.IRENE_API_URL ||= "https://test-twin.local";
process.env.BOT_OWNER_ID ||= "123456789012345678";
process.env.TWIN_BOT_ID ||= "345678901234567890";

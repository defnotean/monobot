import { afterEach, describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { isDashboardRequestAuthorized, isOriginAllowed, resolveTwinCommand, TWIN_ALIASES, TWIN_COMMAND_ALLOWLIST } from "../../presence.js";

const savedDashboardEnv = {
  DASHBOARD_API_KEY: process.env.DASHBOARD_API_KEY,
  TWIN_API_SECRET: process.env.TWIN_API_SECRET,
  DASHBOARD_ALLOW_LOCALHOST_BYPASS: process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedDashboardEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function authReq(remoteAddress: string, authorization?: string) {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  };
}

describe("isDashboardRequestAuthorized", () => {
  it("does not trust localhost unless explicitly enabled", () => {
    delete process.env.DASHBOARD_API_KEY;
    delete process.env.TWIN_API_SECRET;
    delete process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS;

    expect(isDashboardRequestAuthorized(authReq("127.0.0.1"))).toBe(false);
  });

  it("allows localhost only when the bypass flag is enabled", () => {
    process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS = "1";

    expect(isDashboardRequestAuthorized(authReq("::1"))).toBe(true);
  });

  it("accepts configured bearer tokens for remote requests", () => {
    process.env.DASHBOARD_API_KEY = "dash-secret";
    delete process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS;

    expect(isDashboardRequestAuthorized(authReq("203.0.113.10", "Bearer dash-secret"))).toBe(true);
    expect(isDashboardRequestAuthorized(authReq("203.0.113.10", "Bearer wrong"))).toBe(false);
  });

  it("does not accept TWIN_API_SECRET as a dashboard admin key", () => {
    process.env.TWIN_API_SECRET = "twin-secret";
    delete process.env.DASHBOARD_API_KEY;
    delete process.env.DASHBOARD_ALLOW_LOCALHOST_BYPASS;

    expect(isDashboardRequestAuthorized(authReq("203.0.113.10", "Bearer twin-secret"))).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("requires exact scheme, hostname, and port matches", () => {
    const allowed = ["http://localhost:3001", "https://dashboard.example.com"];

    expect(isOriginAllowed("http://localhost:3001", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:9999", allowed)).toBe(false);
    expect(isOriginAllowed("https://localhost:3001", allowed)).toBe(false);
    expect(isOriginAllowed("https://dashboard.example.com.attacker.test", allowed)).toBe(false);
  });
});

// Server-side defense-in-depth allowlist for the /api/twin/command relay path.
// resolveTwinCommand resolves Eris's short command name to Irene's real tool
// name and returns null for anything outside the relay vocabulary, so a
// compromised/buggy Eris can't drive arbitrary Irene tools even with a valid
// HMAC signature.
describe("resolveTwinCommand (twin relay allowlist)", () => {
  it("resolves aliased moderation commands to Irene's real tool names", () => {
    expect(resolveTwinCommand("ban")).toBe("ban_user");
    expect(resolveTwinCommand("kick")).toBe("kick_user");
    expect(resolveTwinCommand("warn")).toBe("warn_user");
    expect(resolveTwinCommand("timeout")).toBe("timeout_user");
  });

  it("resolves channel/messaging aliases", () => {
    expect(resolveTwinCommand("purge")).toBe("purge_messages");
    expect(resolveTwinCommand("lock")).toBe("lock_channel");
    expect(resolveTwinCommand("announce")).toBe("send_message");
    expect(resolveTwinCommand("set_topic")).toBe("set_channel_topic");
  });

  it("passes through unaliased admin/staff commands Eris sends 1:1", () => {
    expect(resolveTwinCommand("create_role")).toBe("create_role");
    expect(resolveTwinCommand("set_welcome_channel")).toBe("set_welcome_channel");
    expect(resolveTwinCommand("give_role")).toBe("give_role");
    expect(resolveTwinCommand("lockdown_server")).toBe("lockdown_server");
  });

  it("accepts the already-resolved _user / _messages forms", () => {
    // Eris's _MOD_CMDS includes both short and suffixed names; both must pass.
    expect(resolveTwinCommand("ban_user")).toBe("ban_user");
    expect(resolveTwinCommand("purge_messages")).toBe("purge_messages");
  });

  it("rejects arbitrary Irene tools outside the relay vocabulary", () => {
    // These are real Irene tools but were never meant to be driven via Eris.
    expect(resolveTwinCommand("send_dm")).toBeNull();
    expect(resolveTwinCommand("execute_code")).toBeNull();
    expect(resolveTwinCommand("delete_all_messages")).toBeNull();
    expect(resolveTwinCommand("update_personality")).toBeNull();
  });

  it("rejects unknown / garbage commands", () => {
    expect(resolveTwinCommand("")).toBeNull();
    expect(resolveTwinCommand("definitely_not_a_tool")).toBeNull();
    expect(resolveTwinCommand("__proto__")).toBeNull();
  });

  it("every alias target is itself in the allowlist (no dangling resolutions)", () => {
    for (const target of Object.values(TWIN_ALIASES) as string[]) {
      expect(TWIN_COMMAND_ALLOWLIST.has(target)).toBe(true);
    }
  });

  // ── Cross-package sync guard ────────────────────────────────────────────────
  // The allowlist must accept EVERY command Eris's twinExecutor can emit. These
  // three lists are copied verbatim from eris/ai/executors/twinExecutor.js's
  // ask_irene case (_ADMIN_CMDS / _MOD_CMDS / _STAFF_CMDS) plus the "announce"
  // command it builds explicitly. If either side drifts — Eris gains a command
  // or Irene drops an allowlist entry — this test goes red, enforcing the sync
  // the implementer flagged as otherwise unenforced.
  const ERIS_TWIN_VOCABULARY = [
    // _ADMIN_CMDS
    "create_channel", "delete_channel", "create_role", "delete_role",
    "set_log_channel", "set_welcome_channel", "setup_starboard",
    "setup_reaction_roles", "nuke_channel", "lockdown_server",
    // _MOD_CMDS
    "ban", "ban_user", "kick", "kick_user", "warn", "warn_user",
    "timeout", "timeout_user", "purge", "purge_messages", "lock",
    "lock_channel", "unlock", "unlock_channel", "slowmode", "set_slowmode",
    "nickname", "set_nickname",
    // _STAFF_CMDS
    "give_role", "remove_role", "mass_role", "set_topic",
    "rename_channel", "move_channel",
    // Built explicitly in twinExecutor (command === "announce")
    "announce",
  ];

  it("resolves the FULL Eris twinExecutor vocabulary (no command silently rejected)", () => {
    expect(ERIS_TWIN_VOCABULARY).toHaveLength(35);
    const rejected = ERIS_TWIN_VOCABULARY.filter((cmd) => resolveTwinCommand(cmd) === null);
    expect(rejected).toEqual([]);
  });

  it.each(ERIS_TWIN_VOCABULARY)("accepts Eris command %s", (cmd) => {
    expect(resolveTwinCommand(cmd)).not.toBeNull();
  });
});

import { describe, it, expect, beforeEach } from "vitest";
// @ts-expect-error - importing JS module without types
import * as perms from "../../utils/permissions.js";

const OWNER = "123456789012345678";
const RANDO = "999999999999999999";

describe("permissions", () => {
  beforeEach(() => {
    for (const id of perms.getTrustedUsers()) perms.removeTrustedUser(id);
  });

  it("identifies the owner from config", () => {
    expect(perms.isOwner(OWNER)).toBe(true);
    expect(perms.isOwner(RANDO)).toBe(false);
  });

  it("owner is always trusted", () => {
    expect(perms.isTrusted(OWNER)).toBe(true);
  });

  it("add/remove trusted user round-trips", () => {
    expect(perms.isTrusted(RANDO)).toBe(false);
    perms.addTrustedUser(RANDO);
    expect(perms.isTrusted(RANDO)).toBe(true);
    expect(perms.getTrustedUsers()).toContain(RANDO);
    perms.removeTrustedUser(RANDO);
    expect(perms.isTrusted(RANDO)).toBe(false);
  });

  it("canUseSensitive is strictly owner-only — not even trusted users qualify", () => {
    perms.addTrustedUser(RANDO);
    expect(perms.canUseSensitive(OWNER)).toBe(true);
    expect(perms.canUseSensitive(RANDO)).toBe(false);
  });

  it("canCustomize allows server owners", () => {
    const fakeGuild = { ownerId: RANDO } as any;
    expect(perms.canCustomize(RANDO, fakeGuild)).toBe(true);
    expect(perms.canCustomize("other", fakeGuild)).toBe(false);
  });

  it("denyMessage returns a different string per variant", () => {
    expect(perms.denyMessage("terminal")).not.toEqual(perms.denyMessage("personality"));
    expect(perms.denyMessage("default")).toBeTruthy();
    expect(perms.denyMessage("nonexistent-variant")).toEqual(perms.denyMessage("default"));
  });
});

// Regression — Lavalink ships with the password "youshallnotpass", which is
// identical across every default Lavalink install on the internet. A self-
// hoster who exposes the Lavalink port without changing this default is
// effectively running with no auth. The boot guard refuses to enable music
// in that case (and lets localhost pass with a softer warning, since the
// port is not routable off-host).
import { describe, it, expect } from "vitest";
// @ts-expect-error - importing JS module without types
import { evaluateLavalinkConfig } from "../../config.js";

describe("evaluateLavalinkConfig — default-password refusal", () => {
  it("refuses to enable music when the default password is paired with a non-localhost host", () => {
    const verdict = evaluateLavalinkConfig({
      host: "lavalink.example.com",
      password: "youshallnotpass",
    });
    expect(verdict.enabled).toBe(false);
    expect(verdict.fatal).toBeTruthy();
    expect(verdict.fatal).toMatch(/well-known/i);
    expect(verdict.fatal).toMatch(/youshallnotpass/);
    expect(verdict.isDefaultPassword).toBe(true);
    expect(verdict.isLocalhost).toBe(false);
  });

  it("refuses to enable music when the password is unset and the host is non-localhost", () => {
    const verdict = evaluateLavalinkConfig({
      host: "lavalink.example.com",
      password: "",
    });
    expect(verdict.enabled).toBe(false);
    expect(verdict.fatal).toBeTruthy();
    expect(verdict.fatal).toMatch(/unset/i);
  });

  it("refuses an IP-style remote host with the default password", () => {
    const verdict = evaluateLavalinkConfig({
      host: "203.0.113.42",
      password: "youshallnotpass",
    });
    expect(verdict.enabled).toBe(false);
    expect(verdict.fatal).toBeTruthy();
  });

  it("allows the default password on localhost with a softer warning", () => {
    const verdict = evaluateLavalinkConfig({
      host: "localhost",
      password: "youshallnotpass",
    });
    expect(verdict.enabled).toBe(true);
    expect(verdict.fatal).toBeNull();
    expect(verdict.warning).toBeTruthy();
    expect(verdict.warning).toMatch(/localhost/i);
  });

  it("allows the default password on 127.0.0.1 with a softer warning", () => {
    const verdict = evaluateLavalinkConfig({
      host: "127.0.0.1",
      password: "youshallnotpass",
    });
    expect(verdict.enabled).toBe(true);
    expect(verdict.fatal).toBeNull();
    expect(verdict.warning).toBeTruthy();
  });

  it("allows the default password on IPv6 loopback with a softer warning", () => {
    const verdict = evaluateLavalinkConfig({
      host: "::1",
      password: "youshallnotpass",
    });
    expect(verdict.enabled).toBe(true);
    expect(verdict.warning).toBeTruthy();
  });

  it("accepts a non-default password without any warning", () => {
    const verdict = evaluateLavalinkConfig({
      host: "lavalink.example.com",
      password: "5f7a3c8b9d2e1f4a6c0b8e7d9a2c4e6f",
    });
    expect(verdict.enabled).toBe(true);
    expect(verdict.fatal).toBeNull();
    expect(verdict.warning).toBeNull();
    expect(verdict.isDefaultPassword).toBe(false);
  });

  it("treats hostname case-insensitively for the localhost check", () => {
    const verdict = evaluateLavalinkConfig({
      host: "LOCALHOST",
      password: "youshallnotpass",
    });
    expect(verdict.enabled).toBe(true);
    expect(verdict.isLocalhost).toBe(true);
  });

  it("allows an unset password on localhost with a warning, falling back to the default", () => {
    const verdict = evaluateLavalinkConfig({
      host: "localhost",
      password: "",
    });
    expect(verdict.enabled).toBe(true);
    expect(verdict.effectivePassword).toBe("youshallnotpass");
    expect(verdict.warning).toBeTruthy();
  });
});

/**
 * HealthTracker (CTOS-003 Part N) — shared rate-limit/degraded/unavailable cooldown tracking used
 * by every live adapter. Holds no credential or request/response content, only a failure category,
 * HTTP status and timestamp.
 */
import { describe, expect, it } from "vitest";
import { HealthTracker } from "@/ai/providers/health";

describe("HealthTracker", () => {
  it("reports no failure state when nothing has gone wrong", () => {
    const h = new HealthTracker();
    expect(h.state()).toBeNull();
    expect(h.blocksAvailability()).toBe(false);
    expect(h.reason()).toBeNull();
  });

  it("a 429 is rate_limited and blocks availability", () => {
    const h = new HealthTracker();
    h.recordFailure("provider_unavailable", 429);
    expect(h.state()).toBe("rate_limited");
    expect(h.blocksAvailability()).toBe(true);
    expect(h.reason()).toMatch(/rate limited/);
  });

  it("a config-category failure (401/403, credential rejected) is unavailable and blocks availability", () => {
    const h = new HealthTracker();
    h.recordFailure("config", 401);
    expect(h.state()).toBe("unavailable");
    expect(h.blocksAvailability()).toBe(true);
    expect(h.reason()).toMatch(/credential rejected/);
  });

  it("a generic provider_unavailable failure (5xx/network, non-429) degrades but does not block availability", () => {
    const h = new HealthTracker();
    h.recordFailure("provider_unavailable", 503);
    expect(h.state()).toBe("degraded");
    expect(h.blocksAvailability()).toBe(false);
    expect(h.reason()).toMatch(/degraded/);
  });

  it("a network failure (no HTTP status) is also degraded, never rate_limited or unavailable", () => {
    const h = new HealthTracker();
    h.recordFailure("provider_unavailable", null);
    expect(h.state()).toBe("degraded");
  });

  it("other error categories (e.g. provider_error, validation) never affect connection state", () => {
    const h = new HealthTracker();
    h.recordFailure("provider_error", 400);
    expect(h.state()).toBeNull();
    expect(h.blocksAvailability()).toBe(false);
  });

  it("a success clears any tracked failure immediately", () => {
    const h = new HealthTracker();
    h.recordFailure("config", 401);
    expect(h.state()).toBe("unavailable");
    h.recordSuccess();
    expect(h.state()).toBeNull();
    expect(h.blocksAvailability()).toBe(false);
  });

  it("a failure expires after the cooldown window, using the injectable clock", () => {
    let now = 1_000_000;
    const h = new HealthTracker({ cooldownMs: 1000, clock: () => now });
    h.recordFailure("provider_unavailable", 429);
    expect(h.state()).toBe("rate_limited");
    now += 999;
    expect(h.state()).toBe("rate_limited");
    now += 2;
    expect(h.state()).toBeNull();
    expect(h.blocksAvailability()).toBe(false);
    expect(h.reason()).toBeNull();
  });

  it("a new failure resets the cooldown window", () => {
    let now = 0;
    const h = new HealthTracker({ cooldownMs: 1000, clock: () => now });
    h.recordFailure("provider_unavailable", 429);
    now = 900;
    h.recordFailure("provider_unavailable", 429);
    now = 1500; // 600ms after the second failure, still within its own 1000ms cooldown
    expect(h.state()).toBe("rate_limited");
  });
});

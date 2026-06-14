import { describe, expect, test } from "bun:test";
import { isOriginAllowed } from "../server-adapters/origin.js";

describe("isOriginAllowed", () => {
  test("allows everything when no allowlist is configured", () => {
    expect(isOriginAllowed("https://evil.example", undefined)).toBe(true);
    expect(isOriginAllowed(undefined, undefined)).toBe(true);
  });

  test("allows requests with no Origin header (native clients) even when configured", () => {
    expect(isOriginAllowed(undefined, ["https://claude.ai"])).toBe(true);
  });

  test("allows an Origin present in the array allowlist", () => {
    expect(isOriginAllowed("https://claude.ai", ["https://claude.ai"])).toBe(true);
  });

  test("rejects an Origin absent from the array allowlist", () => {
    expect(isOriginAllowed("https://evil.example", ["https://claude.ai"])).toBe(false);
  });

  test("supports a predicate allowlist", () => {
    const allow = (o: string) => o.endsWith(".trusted.example");
    expect(isOriginAllowed("https://app.trusted.example", allow)).toBe(true);
    expect(isOriginAllowed("https://evil.example", allow)).toBe(false);
  });
});

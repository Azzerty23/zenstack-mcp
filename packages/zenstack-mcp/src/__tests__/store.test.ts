import { describe, test, expect } from "bun:test";
import { createInMemoryTokenStore, pkceVerify, randomCode, randomToken } from "../auth-adapters/oauth/store.js";

describe("createInMemoryTokenStore — authorization codes", () => {
  test("saveCode then takeCode returns stored entry", async () => {
    const store = createInMemoryTokenStore();
    const code = "abc123";
    const user = { id: "user-1" };
    const challenge = "ch_xyz";
    const expiresAt = Date.now() + 60_000;

    await store.saveCode(code, user, challenge, expiresAt);
    const result = await store.takeCode(code);

    expect(result).not.toBeNull();
    expect(result?.user).toEqual(user);
    expect(result?.codeChallenge).toBe(challenge);
    expect(result?.expiresAt).toBe(expiresAt);
  });

  test("takeCode is one-time use (second call returns null)", async () => {
    const store = createInMemoryTokenStore();
    const expiresAt = Date.now() + 60_000;
    await store.saveCode("code1", { id: "u1" }, "ch1", expiresAt);

    await store.takeCode("code1");
    const second = await store.takeCode("code1");
    expect(second).toBeNull();
  });

  test("takeCode returns null for unknown code", async () => {
    const store = createInMemoryTokenStore();
    const result = await store.takeCode("nonexistent");
    expect(result).toBeNull();
  });

  test("takeCode returns null for expired code", async () => {
    const store = createInMemoryTokenStore();
    // expiresAt in the past
    await store.saveCode("expired", { id: "u1" }, "ch1", Date.now() - 1);
    const result = await store.takeCode("expired");
    expect(result).toBeNull();
  });
});

describe("createInMemoryTokenStore — refresh tokens", () => {
  test("saveRefreshToken then takeRefreshToken returns stored entry", async () => {
    const store = createInMemoryTokenStore();
    const token = "rt_abc";
    const user = { id: "user-2" };
    const expiresAt = Date.now() + 86_400_000;

    await store.saveRefreshToken(token, user, expiresAt);
    const result = await store.takeRefreshToken(token);

    expect(result).not.toBeNull();
    expect(result?.user).toEqual(user);
    expect(result?.expiresAt).toBe(expiresAt);
  });

  test("takeRefreshToken is one-time use (second call returns null)", async () => {
    const store = createInMemoryTokenStore();
    await store.saveRefreshToken("rt1", { id: "u1" }, Date.now() + 86_400_000);
    await store.takeRefreshToken("rt1");
    const second = await store.takeRefreshToken("rt1");
    expect(second).toBeNull();
  });

  test("takeRefreshToken returns null for unknown token", async () => {
    const store = createInMemoryTokenStore();
    const result = await store.takeRefreshToken("unknown");
    expect(result).toBeNull();
  });

  test("takeRefreshToken returns null for expired token", async () => {
    const store = createInMemoryTokenStore();
    await store.saveRefreshToken("rt_exp", { id: "u1" }, Date.now() - 1);
    const result = await store.takeRefreshToken("rt_exp");
    expect(result).toBeNull();
  });

  test("revokeRefreshToken prevents subsequent takeRefreshToken", async () => {
    const store = createInMemoryTokenStore();
    await store.saveRefreshToken("rt_rev", { id: "u1" }, Date.now() + 86_400_000);
    await store.revokeRefreshToken("rt_rev");
    const result = await store.takeRefreshToken("rt_rev");
    expect(result).toBeNull();
  });

  test("revokeRefreshToken on non-existent token does not throw", async () => {
    const store = createInMemoryTokenStore();
    await expect(store.revokeRefreshToken("nope")).resolves.toBeUndefined();
  });
});

describe("createInMemoryTokenStore — expired entry purge on write", () => {
  test("expired codes are purged when a new code is saved", async () => {
    const store = createInMemoryTokenStore();
    // Save an already-expired code
    await store.saveCode("stale", { id: "u1" }, "ch", Date.now() - 1);
    // Trigger purge by saving another code
    await store.saveCode("fresh", { id: "u2" }, "ch2", Date.now() + 60_000);
    // The stale code should be gone (takeCode returns null because it was purged)
    const result = await store.takeCode("stale");
    expect(result).toBeNull();
  });
});

describe("pkceVerify", () => {
  test("returns true for correct verifier/challenge pair", async () => {
    // Pre-computed: S256(verifier "abc123") = base64url of SHA-256("abc123")
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    // Compute the expected challenge from the verifier
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await pkceVerify(verifier, challenge)).toBe(true);
  });

  test("returns false for wrong verifier", async () => {
    const verifier = "correct_verifier";
    const wrongVerifier = "wrong_verifier";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await pkceVerify(wrongVerifier, challenge)).toBe(false);
  });
});

describe("randomCode and randomToken", () => {
  test("randomCode returns a 64-char hex string", () => {
    const code = randomCode();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
  });

  test("randomToken returns a 64-char hex string", () => {
    const token = randomToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test("consecutive calls produce different values", () => {
    expect(randomCode()).not.toBe(randomCode());
    expect(randomToken()).not.toBe(randomToken());
  });
});

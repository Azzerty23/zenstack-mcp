import { describe, test, expect } from "bun:test";
import { SignJWT } from "jose";
import { signToken, verifyToken } from "../auth-adapters/oauth/jwt.js";

const SECRET = "test-secret-key-for-jwt-signing";

describe("signToken / verifyToken", () => {
  test("round-trip: verifyToken recovers the signed payload", async () => {
    const payload = { id: "user-1", email: "alice@example.com" };
    const token = await signToken(payload, SECRET, 3600);
    const recovered = await verifyToken(token, SECRET);
    expect(recovered).toEqual(payload);
  });

  test("verifyToken throws for a token signed with a different secret", async () => {
    const token = await signToken({ id: "u1" }, SECRET, 3600);
    await expect(verifyToken(token, "wrong-secret")).rejects.toThrow();
  });

  test("verifyToken throws for an expired token", async () => {
    const expiredToken = await new SignJWT({ data: { id: "u1" } })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(new Date(Date.now() - 1000))
      .sign(new TextEncoder().encode(SECRET));
    await expect(verifyToken(expiredToken, SECRET)).rejects.toThrow();
  });

  test("verifyToken throws for a malformed token", async () => {
    await expect(verifyToken("totally.invalid.token", SECRET)).rejects.toThrow();
  });

  test("supports arbitrary serializable payloads", async () => {
    const payload = { roles: ["admin", "user"], meta: { count: 42 } };
    const token = await signToken(payload, SECRET, 3600);
    const recovered = await verifyToken(token, SECRET);
    expect(recovered).toEqual(payload);
  });

  test("two tokens with the same payload but different secrets differ", async () => {
    const payload = { id: "u1" };
    const t1 = await signToken(payload, "secret-a", 3600);
    const t2 = await signToken(payload, "secret-b", 3600);
    expect(t1).not.toBe(t2);
  });
});

describe("audience (aud) binding — RFC 8707", () => {
  const AUD = "https://mcp.example";

  test("round-trip with matching audience succeeds", async () => {
    const token = await signToken({ id: "u1" }, SECRET, 3600, AUD);
    const recovered = await verifyToken(token, SECRET, AUD);
    expect(recovered).toEqual({ id: "u1" });
  });

  test("rejects a token minted for a different audience", async () => {
    const token = await signToken({ id: "u1" }, SECRET, 3600, "https://other.example");
    await expect(verifyToken(token, SECRET, AUD)).rejects.toThrow();
  });

  test("rejects a token without aud when an audience is expected", async () => {
    const token = await signToken({ id: "u1" }, SECRET, 3600);
    await expect(verifyToken(token, SECRET, AUD)).rejects.toThrow();
  });

  test("verification without expected audience still accepts aud-bearing tokens", async () => {
    const token = await signToken({ id: "u1" }, SECRET, 3600, AUD);
    const recovered = await verifyToken(token, SECRET);
    expect(recovered).toEqual({ id: "u1" });
  });
});

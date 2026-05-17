import { describe, test, expect } from "bun:test";
import { getRequestUser, requestContext } from "../context.js";

describe("getRequestUser", () => {
  test("returns undefined outside a request context", () => {
    expect(getRequestUser()).toBeUndefined();
  });

  test("returns the user stored in AsyncLocalStorage", async () => {
    const user = { id: "user-1", email: "alice@example.com" };
    let captured: unknown;

    await new Promise<void>((resolve) => {
      requestContext.run({ user }, () => {
        captured = getRequestUser();
        resolve();
      });
    });

    expect(captured).toEqual(user);
  });

  test("returns undefined after the context run exits", async () => {
    const user = { id: "user-1" };

    await new Promise<void>((resolve) => {
      requestContext.run({ user }, () => {
        resolve();
      });
    });

    expect(getRequestUser()).toBeUndefined();
  });

  test("nested contexts each see their own user", async () => {
    const outerUser = { id: "outer" };
    const innerUser = { id: "inner" };
    const results: unknown[] = [];

    await new Promise<void>((resolve) => {
      requestContext.run({ user: outerUser }, async () => {
        results.push(getRequestUser());
        await new Promise<void>((innerResolve) => {
          requestContext.run({ user: innerUser }, () => {
            results.push(getRequestUser());
            innerResolve();
          });
        });
        results.push(getRequestUser());
        resolve();
      });
    });

    expect(results).toEqual([outerUser, innerUser, outerUser]);
  });

  test("supports undefined user for public/anonymous access", async () => {
    let captured: unknown = "sentinel";

    await new Promise<void>((resolve) => {
      requestContext.run({ user: undefined }, () => {
        captured = getRequestUser();
        resolve();
      });
    });

    expect(captured).toBeUndefined();
  });
});

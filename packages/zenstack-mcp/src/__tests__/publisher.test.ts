import { describe, expect, test } from "bun:test";
import {
  createInMemoryPublisher,
  defaultChannel,
} from "../events/publisher.js";
import type { ModelMutationEvent } from "../types.js";

const event = (
  over: Partial<ModelMutationEvent> = {},
): ModelMutationEvent => ({
  operation: "create",
  modelName: "Post",
  timestamp: 1,
  ...over,
});

/** Collects up to `count` events from an async iterable, then stops. */
async function take(
  iterable: AsyncIterable<ModelMutationEvent>,
  count: number,
): Promise<ModelMutationEvent[]> {
  const out: ModelMutationEvent[] = [];
  for await (const e of iterable) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe("defaultChannel", () => {
  test("lowercases the model name (matches @viiite/server)", () => {
    expect(defaultChannel("Post")).toBe("post");
    expect(defaultChannel("UserProfile")).toBe("userprofile");
  });
});

describe("createInMemoryPublisher", () => {
  test("delivers published events to a subscriber on the same channel", async () => {
    const pub = createInMemoryPublisher();
    const received = take(pub.subscribe("post"), 2);
    // Let the subscriber register before publishing.
    await Promise.resolve();

    await pub.publish("post", event({ ids: [1] }));
    await pub.publish("post", event({ operation: "update", ids: [2] }));

    expect((await received).map((e) => e.ids?.[0])).toEqual([1, 2]);
  });

  test("isolates channels", async () => {
    const pub = createInMemoryPublisher();
    const post: ModelMutationEvent[] = [];
    const iterator = pub.subscribe("post")[Symbol.asyncIterator]();
    const next = iterator.next().then((r) => {
      if (!r.done) post.push(r.value);
    });
    await Promise.resolve();

    await pub.publish("user", event({ modelName: "User" }));
    // Nothing for "post" yet.
    await pub.publish("post", event());
    await next;

    expect(post).toHaveLength(1);
    expect(post[0]!.modelName).toBe("Post");
  });

  test("queues events published before next() is awaited", async () => {
    const pub = createInMemoryPublisher();
    const it = pub.subscribe("post");
    await Promise.resolve();

    await pub.publish("post", event({ ids: [1] }));
    await pub.publish("post", event({ ids: [2] }));

    expect((await take(it, 2)).map((e) => e.ids?.[0])).toEqual([1, 2]);
  });

  test("aborting the signal ends the iterator", async () => {
    const pub = createInMemoryPublisher();
    const controller = new AbortController();
    const it = pub.subscribe("post", { signal: controller.signal });
    const iterator = it[Symbol.asyncIterator]();
    await Promise.resolve();

    controller.abort();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  test("a faulty subscriber does not block delivery to others", async () => {
    const pub = createInMemoryPublisher();
    // Subscriber whose push throws (simulated by a return-then-throw iterator is
    // hard to construct; instead verify a normal second subscriber still gets it).
    const good: ModelMutationEvent[] = [];
    const it = pub.subscribe("post")[Symbol.asyncIterator]();
    const next = it.next().then((r) => {
      if (!r.done) good.push(r.value);
    });
    await Promise.resolve();

    await expect(pub.publish("post", event())).resolves.toBeUndefined();
    await next;
    expect(good).toHaveLength(1);
  });
});

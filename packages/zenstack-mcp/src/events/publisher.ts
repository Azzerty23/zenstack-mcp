import type { ModelMutationEvent, MutationPublisher } from "../types.js";

export type { ModelMutationEvent, MutationPublisher };

/** Default channel naming — matches `@viiite/server`'s default. */
export function defaultChannel(modelName: string): string {
  return modelName.toLowerCase();
}

/**
 * In-memory {@link MutationPublisher}. Holds subscriptions in a single process's
 * memory, so it only delivers events published within that same process.
 *
 * Correct for a single long-running instance (Bun/Node). **Not** suitable for
 * serverless or multi-instance deployments (Cloudflare Workers, Lambda,
 * autoscaled hosts), where a publish on one instance must reach a stream held by
 * another — supply a distributed implementation (Durable Object, Redis pub/sub,
 * Postgres LISTEN/NOTIFY) there.
 *
 * Resumption via `lastEventId` is not implemented; this default is best-effort
 * live delivery only.
 */
export function createInMemoryPublisher(): MutationPublisher {
  const channels = new Map<string, Set<(event: ModelMutationEvent) => void>>();

  return {
    async publish(channel, event) {
      const subscribers = channels.get(channel);
      if (!subscribers) return;
      // Snapshot: a subscriber may unsubscribe (mutating the set) during delivery.
      for (const push of [...subscribers]) {
        // A faulty subscriber must not block delivery to the others.
        try {
          push(event);
        } catch {
          // ignore — delivery is best-effort
        }
      }
    },

    subscribe(channel, options) {
      const signal = options?.signal;

      // Register eagerly (on subscribe, not on first iteration) so events
      // published between subscribe() and the start of iteration are queued
      // rather than lost.
      const queue: ModelMutationEvent[] = [];
      let pending:
        | ((result: IteratorResult<ModelMutationEvent>) => void)
        | null = null;
      let closed = false;

      const push = (event: ModelMutationEvent) => {
        if (closed) return;
        if (pending) {
          pending({ value: event, done: false });
          pending = null;
        } else {
          queue.push(event);
        }
      };

      const subscribers = channels.get(channel) ?? new Set();
      channels.set(channel, subscribers);
      subscribers.add(push);

      const close = () => {
        if (closed) return;
        closed = true;
        subscribers.delete(push);
        if (subscribers.size === 0) channels.delete(channel);
        if (pending) {
          pending({ value: undefined, done: true });
          pending = null;
        }
      };

      if (signal) {
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
      }

      const iterator: AsyncIterator<ModelMutationEvent> = {
        next(): Promise<IteratorResult<ModelMutationEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            pending = resolve;
          });
        },
        return(): Promise<IteratorResult<ModelMutationEvent>> {
          close();
          return Promise.resolve({ value: undefined, done: true });
        },
      };

      return {
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
    },
  };
}

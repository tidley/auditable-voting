const MIN_PUBLISH_INTERVAL_MS = 1000;
const PER_RELAY_PUBLISH_STAGGER_MS = 250;

let nextAllowedAt = 0;
let tail: Promise<void> = Promise.resolve();

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

export function queueNostrPublish<T>(task: () => Promise<T>): Promise<T> {
  const run = tail.then(async () => {
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }

    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      nextAllowedAt = startedAt + MIN_PUBLISH_INTERVAL_MS;
    }
  });

  tail = run.then(() => undefined, () => undefined);
  return run;
}

export async function publishToRelaysStaggered(
  publishSingleRelay: (relay: string) => Promise<unknown>,
  relays: string[],
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];

  for (const [index, relay] of relays.entries()) {
    if (index > 0) {
      await delay(PER_RELAY_PUBLISH_STAGGER_MS);
    }

    try {
      const value = await publishSingleRelay(relay);
      results.push({ status: "fulfilled", value });
    } catch (error) {
      results.push({ status: "rejected", reason: error });
    }
  }

  return results;
}

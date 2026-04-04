const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 1500;
const DEFAULT_PER_RELAY_PUBLISH_STAGGER_MS = 600;

type QueueState = {
  nextAllowedAt: number;
  tail: Promise<void>;
};

const queueStates = new Map<string, QueueState>();

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function getQueueState(channel: string): QueueState {
  const existing = queueStates.get(channel);
  if (existing) {
    return existing;
  }

  const created: QueueState = {
    nextAllowedAt: 0,
    tail: Promise.resolve(),
  };
  queueStates.set(channel, created);
  return created;
}

export function queueNostrPublish<T>(
  task: () => Promise<T>,
  options?: { channel?: string; minIntervalMs?: number },
): Promise<T> {
  const channel = options?.channel ?? "default";
  const minIntervalMs = options?.minIntervalMs ?? DEFAULT_MIN_PUBLISH_INTERVAL_MS;
  const state = getQueueState(channel);

  const run = state.tail.then(async () => {
    const waitMs = Math.max(0, state.nextAllowedAt - Date.now());
    if (waitMs > 0) {
      await delay(waitMs);
    }

    const startedAt = Date.now();
    try {
      return await task();
    } finally {
      state.nextAllowedAt = startedAt + minIntervalMs;
    }
  });

  state.tail = run.then(() => undefined, () => undefined);
  return run;
}

export async function publishToRelaysStaggered(
  publishSingleRelay: (relay: string) => Promise<unknown>,
  relays: string[],
  options?: { staggerMs?: number },
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = [];
  const staggerMs = options?.staggerMs ?? DEFAULT_PER_RELAY_PUBLISH_STAGGER_MS;

  for (const [index, relay] of relays.entries()) {
    if (index > 0) {
      await delay(staggerMs);
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

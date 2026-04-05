const DEFAULT_MIN_PUBLISH_INTERVAL_MS = 1500;
const DEFAULT_PER_RELAY_PUBLISH_STAGGER_MS = 600;
const DEFAULT_PRIMARY_RELAY_COUNT = 2;

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
  const staggerMs = options?.staggerMs ?? DEFAULT_PER_RELAY_PUBLISH_STAGGER_MS;
  return Promise.all(
    relays.map(async (relay, index) => {
      if (index > 0 && staggerMs > 0) {
        await delay(index * staggerMs);
      }

      try {
        const value = await publishSingleRelay(relay);
        return { status: "fulfilled", value } satisfies PromiseFulfilledResult<unknown>;
      } catch (error) {
        return { status: "rejected", reason: error } satisfies PromiseRejectedResult;
      }
    }),
  );
}

export type RelayPublishOutcome = {
  relay: string;
  success: boolean;
  error?: string;
};

export async function publishToRelayTiers(
  publishSingleRelay: (relay: string) => Promise<unknown>,
  relays: string[],
  options?: {
    primaryCount?: number;
    staggerMs?: number;
    fallbackStaggerMs?: number;
    minPrimarySuccesses?: number;
  },
): Promise<RelayPublishOutcome[]> {
  const primaryCount = Math.max(
    1,
    Math.min(options?.primaryCount ?? DEFAULT_PRIMARY_RELAY_COUNT, relays.length),
  );
  const minPrimarySuccesses = Math.max(1, options?.minPrimarySuccesses ?? 1);
  const primaryRelays = relays.slice(0, primaryCount);
  const fallbackRelays = relays.slice(primaryCount);

  const mapOutcomes = (
    tierRelays: string[],
    results: PromiseSettledResult<unknown>[],
  ): RelayPublishOutcome[] => (
    results.map((result, index) => (
      result.status === "fulfilled"
        ? { relay: tierRelays[index], success: true }
        : {
            relay: tierRelays[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }
    ))
  );

  const primaryResults = await publishToRelaysStaggered(
    publishSingleRelay,
    primaryRelays,
    { staggerMs: options?.staggerMs },
  );
  const primaryOutcomes = mapOutcomes(primaryRelays, primaryResults);
  const primarySuccesses = primaryOutcomes.filter((result) => result.success).length;

  if (fallbackRelays.length === 0 || primarySuccesses >= minPrimarySuccesses) {
    return primaryOutcomes;
  }

  const fallbackResults = await publishToRelaysStaggered(
    publishSingleRelay,
    fallbackRelays,
    { staggerMs: options?.fallbackStaggerMs ?? options?.staggerMs },
  );

  return [
    ...primaryOutcomes,
    ...mapOutcomes(fallbackRelays, fallbackResults),
  ];
}

const MIN_PUBLISH_INTERVAL_MS = 1000;

let nextAllowedAt = 0;
let tail: Promise<void> = Promise.resolve();

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
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

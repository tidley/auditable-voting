import { normalizeRelaysRust } from "./wasm/auditableVotingCore";

type RelayHealth = {
  cooldownUntil: number;
  consecutiveFailures: number;
  lastError?: string;
  lastSuccessAt?: number;
};

const relayHealth = new Map<string, RelayHealth>();
const RELAY_MAX_PENALTY_MS = 30 * 60_000;
const RELAY_FAILURES_BEFORE_COOLDOWN = 2;
const RELAY_JITTER_RATIO = 0.2;

function normalizeRelay(relay: string) {
  return normalizeRelaysRust([relay])[0] ?? relay.trim();
}

function penaltyMsForError(error?: string) {
  const normalized = (error ?? "").toLowerCase();
  if (!normalized) {
    return 60_000;
  }
  if (normalized.includes("rate-limited") || normalized.includes("too much")) {
    return 3 * 60_000;
  }
  if (normalized.includes("pow")) {
    return 10 * 60_000;
  }
  if (
    normalized.includes("blocked")
    || normalized.includes("spam")
    || normalized.includes("policy violated")
    || normalized.includes("web of trust")
  ) {
    return 20 * 60_000;
  }
  if (normalized.includes("initialized but not ready") || normalized.includes("not ready")) {
    return 2 * 60_000;
  }
  if (normalized.includes("insufficient resources")) {
    return 3 * 60_000;
  }
  if (normalized.includes("timed out") || normalized.includes("timeout")) {
    return 90_000;
  }
  if (
    normalized.includes("websocket connection")
    || normalized.includes("network")
    || normalized.includes("failed")
    || normalized.includes("closed")
  ) {
    return 2 * 60_000;
  }
  return 2 * 60_000;
}

function jitterPenaltyMs(ms: number, relay: string, failures: number) {
  const jitterSeed = Math.abs(
    [...relay].reduce((acc, char) => ((acc * 31) + char.charCodeAt(0)) | 0, failures * 97),
  );
  const ratio = 1 - RELAY_JITTER_RATIO + ((jitterSeed % 10_000) / 10_000) * RELAY_JITTER_RATIO * 2;
  return Math.max(1_000, Math.round(ms * ratio));
}

function extractRelayFromText(value: string): string | null {
  const match = value.match(/wss?:\/\/[^\s'"]+/i);
  if (!match) {
    return null;
  }
  return normalizeRelay(match[0]);
}

export function recordRelayOutcome(relay: string, success: boolean, error?: string) {
  const normalizedRelay = normalizeRelay(relay);
  if (!normalizedRelay) {
    return;
  }

  if (success) {
    relayHealth.set(normalizedRelay, {
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastError: undefined,
      lastSuccessAt: Date.now(),
    });
    return;
  }

  const previous = relayHealth.get(normalizedRelay);
  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const basePenaltyMs = penaltyMsForError(error);
  const scaledPenaltyMs = Math.min(
    RELAY_MAX_PENALTY_MS,
    basePenaltyMs * Math.min(8, 2 ** (consecutiveFailures - 1)),
  );
  const shouldCooldown = consecutiveFailures >= RELAY_FAILURES_BEFORE_COOLDOWN;
  relayHealth.set(normalizedRelay, {
    cooldownUntil: shouldCooldown ? Date.now() + jitterPenaltyMs(scaledPenaltyMs, normalizedRelay, consecutiveFailures) : 0,
    consecutiveFailures,
    lastError: error,
    lastSuccessAt: previous?.lastSuccessAt,
  });
}

export function recordRelayCloseReasons(reasons: string[]) {
  for (const reason of reasons) {
    const relay = extractRelayFromText(reason);
    if (!relay) {
      continue;
    }
    recordRelayOutcome(relay, false, reason);
  }
}

export async function withRelayOutcomes<T>(relays: string[], task: Promise<T>): Promise<T> {
  try {
    const result = await task;
    for (const relay of relays) {
      recordRelayOutcome(relay, true);
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const relay of relays) {
      recordRelayOutcome(relay, false, message);
    }
    throw error;
  }
}

export function rankRelaysByBackoff(relays: string[]) {
  const normalized = normalizeRelaysRust(relays);
  const now = Date.now();
  const healthy: string[] = [];
  const unhealthy: Array<{ relay: string; cooldownUntil: number }> = [];

  for (const relay of normalized) {
    const health = relayHealth.get(relay);
    if (!health || health.cooldownUntil <= now) {
      healthy.push(relay);
      continue;
    }
    unhealthy.push({ relay, cooldownUntil: health.cooldownUntil });
  }

  unhealthy.sort((left, right) => left.cooldownUntil - right.cooldownUntil);
  return [...healthy, ...unhealthy.map((entry) => entry.relay)];
}

export function selectRelaysWithBackoff(relays: string[], maxRelays: number) {
  const ranked = rankRelaysByBackoff(relays);
  const now = Date.now();
  const healthy = ranked.filter((relay) => {
    const health = relayHealth.get(relay);
    return !health || health.cooldownUntil <= now;
  });
  const source = healthy.length > 0 ? healthy : ranked;
  const limit = Math.max(1, Math.min(maxRelays, source.length));
  const limited = source.slice(0, limit);
  if (limited.length > 0) {
    return limited;
  }
  return ranked.slice(0, 1);
}

export function relayCooldownRemainingMs(relay: string) {
  const normalizedRelay = normalizeRelay(relay);
  const health = relayHealth.get(normalizedRelay);
  if (!health) {
    return 0;
  }
  return Math.max(0, health.cooldownUntil - Date.now());
}

export function relayCanAttempt(relay: string) {
  return relayCooldownRemainingMs(relay) <= 0;
}

export function relayHealthSnapshot(relay: string) {
  const normalizedRelay = normalizeRelay(relay);
  const health = relayHealth.get(normalizedRelay);
  return health ? { ...health } : null;
}

export function resetRelayHealthForTests() {
  relayHealth.clear();
}

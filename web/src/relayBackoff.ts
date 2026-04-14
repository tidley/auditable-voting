import { normalizeRelaysRust } from "./wasm/auditableVotingCore";

type RelayHealth = {
  cooldownUntil: number;
  consecutiveFailures: number;
  lastError?: string;
};

const relayHealth = new Map<string, RelayHealth>();
const RELAY_MAX_PENALTY_MS = 30 * 60_000;

function normalizeRelay(relay: string) {
  return relay.trim();
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
  relayHealth.set(normalizedRelay, {
    cooldownUntil: Date.now() + scaledPenaltyMs,
    consecutiveFailures,
    lastError: error,
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
  const limited = ranked.slice(0, Math.min(maxRelays, ranked.length));
  if (limited.length > 0) {
    return limited;
  }
  return ranked.slice(0, 1);
}

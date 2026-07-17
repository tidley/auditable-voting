export type RustDeliveryState = {
  status?: string | null;
  eventId?: string | null;
  responseId?: string | null;
  priorEventIds?: string[] | null;
  priorResponseIds?: string[] | null;
  attempts?: number | null;
  lastAttemptAt?: string | null;
};

export type RustAckSummary = {
  actorNpub: string;
  ackedAction: string;
  ackedEventId: string;
  responseId?: string | null;
};

export type VoterCoordinatorDiagnosticRust = {
  coordinatorNpub: string;
  coordinatorIndex: number;
  follow: { tone: string; text: string };
  round: { tone: string; text: string };
  blindKey: { tone: string; text: string };
  request: { tone: string; text: string };
  ticket: { tone: string; text: string };
};

export type CoordinatorFollowerRowRust = {
  id: string;
  voterNpub: string;
  voterId: string;
  followingText: string;
  canSendTicket: boolean;
  sendLabel: string;
  follow: { tone: string; text: string };
  pendingRequest: { tone: string; text: string };
  ticket: { tone: string; text: string };
  receipt?: { tone: string; text: string } | null;
};

export function normalizeCoordinatorNpubsRust(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function normalizeRelaysRust(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.startsWith("wss://")))];
}

export function buildActorRelaySetRust(input: {
  preferredRelays?: string[];
  fallbackRelays: string[];
  extraRelays?: string[];
}) {
  return normalizeRelaysRust([...(input.preferredRelays ?? []), ...input.fallbackRelays, ...(input.extraRelays ?? [])]);
}

export function buildConversationRelaySetRust(input: {
  recipientInboxRelays: string[];
  senderOutboxRelays?: string[];
  fallbackRelays: string[];
}) {
  return normalizeRelaysRust([...input.recipientInboxRelays, ...(input.senderOutboxRelays ?? []), ...input.fallbackRelays]);
}

export function deriveActorDisplayIdRust(value: string) {
  return value.trim().slice(0, 8).toUpperCase();
}

export function extractNpubFromScanRust(value: string) {
  return value.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/)?.[0] ?? null;
}

export function sha256HexRust(input: string) {
  let state = 0x811c9dc5;
  for (const char of input) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  const chunk = state.toString(16).padStart(8, "0");
  return chunk.repeat(8);
}

export function deriveTokenIdFromProofSecretsRust(proofSecrets: string[], length: number) {
  const normalized = proofSecrets.map((secret) => secret.trim()).filter(Boolean).sort();
  if (normalized.length === 0) {
    return null;
  }
  return sha256HexRust(normalized.map(sha256HexRust).join(":")).slice(0, length);
}

export function tokenIdLabelRust(tokenId: string | null | undefined) {
  if (!tokenId) {
    return "Unavailable";
  }
  return tokenId.length <= 14 ? tokenId : `${tokenId.slice(0, 8)}...${tokenId.slice(-6)}`;
}

export function tokenPatternDetailRust(tokenId: string, size: number) {
  let seed = 0x811c9dc5;
  for (const character of tokenId.toLowerCase()) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 0x01000193) >>> 0;
  }
  return Array.from({ length: size * size }, (_, index) => ({
    filled: ((Math.imul(seed ^ index, 0x45d9f3b) >>> 16) & 1) === 0,
    colorIndex: (Math.imul(seed ^ (index + 1), 0x27d4eb2d) >>> 16) % 6,
  }));
}

export function tokenPatternCellsRust(tokenId: string, size: number) {
  return tokenPatternDetailRust(tokenId, size).map((cell) => cell.filled);
}

export function tokenQrPayloadRust(tokenId: string) {
  return `auditable-voting:token:${tokenId}`;
}

export function sortSimpleVotesCanonicalRust<T extends { createdAt: string; eventId: string }>(votes: T[]) {
  return [...votes].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.eventId.localeCompare(right.eventId));
}

export function sortRecordsByCreatedAtDescRust<T extends { createdAt: string }>(values: T[]) {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function buildSimpleVoteTicketRowsRust<
  T extends {
    votingId: string;
    prompt: string;
    createdAt: string;
    thresholdT?: number;
    thresholdN?: number;
    coordinatorNpub: string;
  },
>(entries: T[], configuredCoordinatorTargets: string[]) {
  const rows = new Map<string, T & { countsByCoordinator: Record<string, number> }>();
  for (const entry of entries) {
    if (!configuredCoordinatorTargets.includes(entry.coordinatorNpub) || !entry.prompt.trim()) {
      continue;
    }
    const current = rows.get(entry.votingId);
    if (!current) {
      rows.set(entry.votingId, {
        ...entry,
        countsByCoordinator: { [entry.coordinatorNpub]: 1 },
      });
      continue;
    }
    if (entry.createdAt > current.createdAt) {
      current.createdAt = entry.createdAt;
      current.prompt = entry.prompt;
      current.thresholdT = entry.thresholdT;
      current.thresholdN = entry.thresholdN;
    }
    current.countsByCoordinator[entry.coordinatorNpub] = (current.countsByCoordinator[entry.coordinatorNpub] ?? 0) + 1;
  }
  return [...rows.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function buildVoterCoordinatorDiagnosticsRust(input: {
  configuredCoordinatorTargets: string[];
  activeVotingId?: string | null;
  discoveredRoundSources: Array<{ coordinatorNpub: string; votingId: string }>;
  knownBlindKeyIds: string[];
  followDeliveries: Record<string, RustDeliveryState>;
  requestDeliveries: Record<string, RustDeliveryState>;
  acknowledgements: RustAckSummary[];
  ticketReceivedCoordinatorNpubs: string[];
}) {
  return input.configuredCoordinatorTargets.map((coordinatorNpub, coordinatorIndex) => ({
    coordinatorNpub,
    coordinatorIndex,
    follow: { tone: "muted", text: "Not checked in tests" },
    round: { tone: "muted", text: "Not checked in tests" },
    blindKey: { tone: "muted", text: "Not checked in tests" },
    request: { tone: "muted", text: "Not checked in tests" },
    ticket: { tone: "muted", text: "Not checked in tests" },
  })) satisfies VoterCoordinatorDiagnosticRust[];
}

export function selectFollowRetryTargetsRust(input: { configuredCoordinatorTargets: string[] }) {
  return input.configuredCoordinatorTargets;
}

export function selectRequestRetryKeysRust(input: { pendingRequests: Array<{ key: string }> }) {
  return input.pendingRequests.map((request) => request.key);
}

export function mergeSimpleFollowersRust<T extends { voterNpub: string; createdAt: string }>(current: T[], next: T[]) {
  const byNpub = new Map<string, T>();
  for (const entry of [...current, ...next]) {
    byNpub.set(entry.voterNpub, entry);
  }
  return [...byNpub.values()];
}

export function buildCoordinatorFollowerRowsRust(input: {
  followers: Array<{ id: string; voterNpub: string; voterId: string; createdAt: string }>;
}) {
  return input.followers.map((follower) => ({
    id: follower.id,
    voterNpub: follower.voterNpub,
    voterId: follower.voterId,
    followingText: "Following",
    canSendTicket: true,
    sendLabel: "Send ballot",
    follow: { tone: "ok", text: "Following" },
    pendingRequest: { tone: "muted", text: "No request" },
    ticket: { tone: "muted", text: "No ticket" },
    receipt: null,
  })) satisfies CoordinatorFollowerRowRust[];
}

export function selectTicketRetryTargetsRust(input: {
  followers: Array<{ id: string }>;
}) {
  return input.followers.map((follower) => follower.id);
}

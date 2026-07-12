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
  return sha256HexRust(proofSecrets.join("|")).slice(0, length);
}

export function tokenIdLabelRust(tokenId: string | null | undefined) {
  return tokenId ? tokenId.slice(0, 8).toUpperCase() : "PENDING";
}

export function tokenPatternDetailRust(tokenId: string, size: number) {
  return Array.from({ length: size * size }, (_, index) => ({
    filled: (tokenId.charCodeAt(index % Math.max(1, tokenId.length)) + index) % 2 === 0,
    colorIndex: index % 6,
  }));
}

export function tokenPatternCellsRust(tokenId: string, size: number) {
  return tokenPatternDetailRust(tokenId, size).map((cell) => cell.filled);
}

export function tokenQrPayloadRust(tokenId: string) {
  return `auditable-voting:${tokenId}`;
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
  return entries.map((entry) => ({ ...entry, countsByCoordinator: Object.fromEntries(configuredCoordinatorTargets.map((npub) => [npub, 0])) }));
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

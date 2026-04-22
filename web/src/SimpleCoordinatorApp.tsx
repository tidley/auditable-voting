import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec, isValidNpub } from "./nostrIdentity";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  subscribeSimpleCoordinatorFollowers,
  subscribeSimpleDmAcknowledgements,
  subscribeSimpleCoordinatorShareAssignments,
  subscribeSimpleCoordinatorMlsWelcomes,
  subscribeSimpleShardRequests,
  subscribeSimpleSubCoordinatorApplications,
  sendSimpleCoordinatorRoster,
  sendSimpleCoordinatorMlsWelcome,
  sendSimpleDmAcknowledgement,
  sendSimpleShareAssignment,
  sendSimpleSubCoordinatorJoin,
  sendSimpleRoundTicket,
  isDeliveryConfirmed,
  type SimpleDmAcknowledgement,
  type SimpleCoordinatorFollower,
  type SimpleShardRequest,
  type SimpleSubCoordinatorApplication,
} from "./simpleShardDm";
import {
  subscribeSimpleLiveVotes,
  subscribeSimpleSubmittedVotes,
  publishSimpleLiveVote,
  SIMPLE_PUBLIC_RELAYS,
  type SimpleLiveVoteSession,
  type SimpleSubmittedVote,
} from "./simpleVotingSession";
import {
  deriveCoordinatorElectionId,
  CoordinatorControlService,
  npubsToHexRoster,
  type CoordinatorControlCache,
  type CoordinatorControlPublishDiagnostic,
} from "./services/CoordinatorControlService";
import {
  ProtocolStateService,
  SIMPLE_PUBLIC_ELECTION_ID,
  type ProtocolStateCache,
} from "./services/ProtocolStateService";
import type {
  CoordinatorEngineStatus,
  CoordinatorEngineView,
} from "./core/coordinatorCoreAdapter";
import { SIMPLE_COORDINATOR_CONTROL_KIND } from "./core/coordinatorEventBridge";
import {
  fetchCoordinatorControlEvents,
  subscribeCoordinatorControl,
  type CoordinatorControlReadMode,
} from "./nostr/subscribeCoordinatorControl";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import SimpleQrScanner from "./SimpleQrScanner";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUnlockGate from "./SimpleUnlockGate";
import TokenFingerprint from "./TokenFingerprint";
import QuestionnaireCoordinatorPanel from "./QuestionnaireCoordinatorPanel";
import { extractNpubFromScan } from "./npubScan";
import {
  processOptionAQueuesForCoordinatorLive,
  QuestionnaireOptionACoordinatorRuntime,
} from "./questionnaireOptionARuntime";
import { buildInviteUrl } from "./questionnaireInvite";
import {
  primeNip65RelayHints,
  setNip65EnabledForSession,
} from "./nip65RelayHints";
import { formatRoundOptionLabel } from "./roundLabel";
import {
  fetchLatestSimpleBlindKeyAnnouncement,
  generateSimpleBlindKeyPair,
  publishSimpleBlindKeyAnnouncement,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindPrivateKey,
} from "./simpleShardCertificate";
import {
  downloadSimpleActorBackup,
  clearSimpleActorState,
  isSimpleActorStateLocked,
  loadSimpleActorState,
  loadSimpleActorStateWithOptions,
  parseEncryptedSimpleActorBackupBundle,
  parseSimpleActorBackupBundle,
  saveSimpleActorState,
  SimpleActorStateLockedError,
  type SimpleActorKeypair,
} from "./simpleLocalState";
import {
  buildCoordinatorFollowerRowsRust,
  mergeSimpleFollowersRust,
  normalizeRelaysRust,
  selectTicketRetryTargetsRust,
} from "./wasm/auditableVotingCore";
import { createSignerService, SignerServiceError } from "./services/signerService";
import { getSharedNostrPool } from "./sharedNostrPool";
import type { BallotSubmission, QuestionnaireAnswer } from "./questionnaireOptionA";
import type { QuestionnaireResponsePayload } from "./questionnaireProtocol";
import type { QuestionnaireAcceptedResponse } from "./questionnaireRuntime";
import { loadCoordinatorState } from "./questionnaireOptionAStorage";
import { tryWriteClipboard } from "./clipboard";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_PROTOCOL_VERSION_V2,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
} from "./questionnaireProtocolConstants";

type CoordinatorTab = "configure" | "delegate" | "participants" | "voting" | "settings";

type SimpleCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

function optionAAnswerToQuestionnaireAnswer(answer: QuestionnaireAnswer): QuestionnaireResponsePayload["answers"][number] {
  if (answer.type === "yes_no") {
    return {
      questionId: answer.questionId,
      answerType: "yes_no",
      value: answer.answer === "yes",
    };
  }
  if (answer.type === "multiple_choice") {
    return {
      questionId: answer.questionId,
      answerType: "multiple_choice",
      selectedOptionIds: answer.answer,
    };
  }
  return {
    questionId: answer.questionId,
    answerType: "free_text",
    text: answer.answer,
  };
}

function optionASubmissionToAcceptedResponse(submission: BallotSubmission): QuestionnaireAcceptedResponse {
  const parsedSubmittedAt = Date.parse(submission.submittedAt);
  const submittedAt = Number.isFinite(parsedSubmittedAt)
    ? Math.floor(parsedSubmittedAt / 1000)
    : Math.floor(Date.now() / 1000);
  const payload: QuestionnaireResponsePayload = {
    schemaVersion: 1,
    kind: "questionnaire_response_payload",
    questionnaireId: submission.electionId,
    responseId: submission.submissionId,
    submittedAt,
    answers: submission.payload.responses.map(optionAAnswerToQuestionnaireAnswer),
  };
  return {
    eventId: `optiona:${submission.submissionId}`,
    authorPubkey: submission.invitedNpub,
    envelope: {
      schemaVersion: 1,
      eventType: "questionnaire_response_private",
      questionnaireId: submission.electionId,
      responseId: submission.submissionId,
      createdAt: submittedAt,
      authorPubkey: submission.invitedNpub,
      ciphertextScheme: "nip44v2",
      ciphertextRecipient: "option_a_dm",
      ciphertext: "option_a_dm_submission",
      payloadHash: submission.submissionId,
    },
    payload,
  };
}

const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";

type TicketRelayResult = {
  relay: string;
  success: boolean;
  error?: string;
};

type TicketDeliveryState = {
  status: string;
  eventId?: string;
  requestId?: string;
  responseId?: string;
  priorEventIds?: string[];
  priorResponseIds?: string[];
  attempts?: number;
  resendCount?: number;
  ticketBuiltAt?: string;
  ticketPublishStartedAt?: string;
  ticketPublishSucceededAt?: string;
  ticketLastBackfillAttemptAt?: string;
  ticketStillMissing?: boolean;
  ticketRelayTargets?: string[];
  ticketRelaySuccessCount?: number;
  ticketPublishEventKind?: number;
  ticketPublishEventCreatedAt?: number;
  ticketPublishEventTags?: string[][];
  ticketPublishEventContent?: string;
  lastAttemptAt?: string;
  relayResults?: TicketRelayResult[];
};

type SimpleCoordinatorCache = {
  leadCoordinatorNpub: string;
  nip65Enabled: boolean;
  followers: SimpleCoordinatorFollower[];
  subCoordinators: SimpleSubCoordinatorApplication[];
  ticketDeliveries: Record<string, TicketDeliveryState>;
  autoSendFollowers: Record<string, boolean>;
  pendingRequests: SimpleShardRequest[];
  registrationStatus: string | null;
  assignmentStatus: string | null;
  questionPrompt: string;
  questionThresholdT: string;
  questionThresholdN: string;
  questionShareIndex: string;
  roundBlindPrivateKeys: Record<string, SimpleBlindPrivateKey>;
  roundBlindKeyAnnouncements: Record<string, SimpleBlindKeyAnnouncement>;
  publishStatus: string | null;
  coordinatorControlCache?: CoordinatorControlCache | null;
  protocolStateCache?: ProtocolStateCache | null;
  publishedVotes: SimpleLiveVoteSession[];
  selectedVotingId: string;
  selectedSubmittedVotingId: string;
  submittedVotes: SimpleSubmittedVote[];
};

type CoordinatorRuntimeReadiness = {
  phase: string;
  mlsJoinComplete: boolean;
  welcomeAckSent: boolean;
  initialControlBackfillComplete: boolean;
  autoApprovalComplete: boolean;
  roundOpenPublishSafe: boolean;
  blindKeyPublishSafe: boolean;
  ticketPlaneSafe: boolean;
};

type StartupRelayResult = {
  relay: string;
  success: boolean;
  error?: string;
};

type StartupControlReadFilter = {
  mode: CoordinatorControlReadMode;
  relays: string[];
  kinds: number[];
  tags: string[];
  since: number | null;
  until: number | null;
  limit: number;
  startedAt: string;
};

type BlindKeyDiagnostics = {
  blindKeyPublishAttempted: boolean;
  blindKeyPublishStartedAt: string | null;
  blindKeyPublishSucceeded: boolean;
  blindKeyPublishSucceededAt: string | null;
  blindKeyObservedBackLocally: boolean;
  blindKeyPublishAttemptCount: number;
  blindKeyPublishLastError: string | null;
  blindKeyEventId: string | null;
  blindKeyRelayTargets: string[];
  blindKeyRelaySuccessCount: number;
  blindKeyFailureClass:
    | "blind_key_not_attempted"
    | "blind_key_publish_unconfirmed"
    | "blind_key_published_not_observed"
    | "blind_key_published_and_observed_but_not_applied"
    | null;
};

type CoordinatorStartupDiagnostics = {
  mlsJoinStartedAt: string | null;
  mlsJoinLastAttemptAt: string | null;
  mlsJoinAttemptCount: number;
  mlsJoinLastResult: "pending" | "joined" | "not_joined" | "failed";
  mlsJoinResolvedAt: string | null;
  mlsJoinPackagePublishAttemptCount: number;
  mlsJoinPackagePublishSuccessCount: number;
  mlsJoinPackagePublishFailureCount: number;
  mlsJoinPackageLastPublishAt: string | null;
  mlsJoinPackageLastRelayResults: StartupRelayResult[];
  mlsWelcomeObservedCount: number;
  mlsWelcomeLastObservedAt: string | null;
  mlsWelcomePublishAttemptCount: number;
  mlsWelcomePublishSuccessCount: number;
  mlsWelcomePublishFailureCount: number;
  mlsWelcomeLastPublishAt: string | null;
  mlsWelcomeLastRelayResults: StartupRelayResult[];
  controlCarrierFetchAttemptCount: number;
  controlCarrierFetchLastAt: string | null;
  controlCarrierFetchLastCount: number;
  controlCarrierFetchLastError: string | null;
  controlCarrierSubscriptionObservedCount: number;
  controlCarrierSubscriptionLastObservedAt: string | null;
  controlCarrierLastObservedEventId: string | null;
  controlCarrierLastObservedSource: "initial_backfill" | "periodic_backfill" | "subscription" | "post_join_backfill" | null;
  startupPublishAttempted: boolean;
  startupPublishSucceeded: boolean;
  startupPublishEventId: string | null;
  startupPublishEventType: string | null;
  startupPublishEventKind: number | null;
  startupPublishEventTags: string[][];
  startupPublishEventCreatedAt: number | null;
  startupPublishRelayTargets: string[];
  startupPublishRelaySuccessCount: number;
  startupPublishRelayResults: StartupRelayResult[];
  startupPublishLocalEchoApplied: boolean;
  startupPublishProbeEventFoundByKindOnly: boolean;
  startupLiveFilter: StartupControlReadFilter | null;
  startupBackfillFilter: StartupControlReadFilter | null;
  startupObservedLive: boolean;
  startupObservedBackfill: boolean;
  startupProbeKindOnlyCount: number;
  startupProbeFilteredCount: number;
  startupProbeKindElectionCount: number;
  startupProbeKindElectionGroupCount: number;
  startupWriteSuccessRelays: string[];
  startupReadLiveRelays: string[];
  startupReadBackfillRelays: string[];
  startupRelayOverlap: string[];
  startupRelayNoOverlap: boolean;
  startupWriteRelayQueriedByBackfill: boolean;
  startupForcedRecoveryAttemptCount: number;
  startupForcedRecoveryLastAttemptAt: string | null;
  startupForcedRecoveryLastOutcome: "pending" | "recovered" | "not_recovered" | null;
  startupJoinFailureBucket: "publish_failure" | "observation_failure" | "state_transition_failure" | null;
};

type ImportedKnownVoterContact = {
  npub: string;
  nip05: string | null;
  profileName: string | null;
  petname: string | null;
};

const SIMPLE_TICKET_SEND_STAGGER_MS = 900;
const SIMPLE_HUMAN_ACTION_JITTER_MAX_MS = 30000;
const SIMPLE_COORDINATOR_CONTROL_BACKFILL_INTERVAL_MS = 4000;
const SIMPLE_COORDINATOR_ROUND_OPEN_POST_WELCOME_GRACE_MS = 1200;
const SIMPLE_COORDINATOR_ROUND_OPEN_RETRY_DELAY_MS = 5000;
const SIMPLE_COORDINATOR_ROUND_OPEN_RETRY_MAX_ATTEMPTS = 3;
const OPTION_A_LOCAL_NSEC_BACKGROUND_PROCESS_INTERVAL_MS = 30_000;
const OPTION_A_DEFAULT_BACKGROUND_PROCESS_INTERVAL_MS = 60_000;
const SIMPLE_TICKET_RETRY_MIN_AGE_MS = 10000;
const SIMPLE_TICKET_RETRY_MAX_ATTEMPTS = 3;
const SIMPLE_TICKET_SEND_MAX_CONCURRENCY = 3;
const SIMPLE_TICKET_OBSERVE_RECOVERY_AGE_MS = 5000;
const SIMPLE_COORDINATOR_STARTUP_FORCED_RECOVERY_DELAY_MS = 6000;
const SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT = 200;

function readDeploymentModeFromUrl() {
  if (typeof window === "undefined") {
    return "legacy";
  }
  return (new URLSearchParams(window.location.search).get("deployment") ?? "legacy")
    .trim()
    .toLowerCase();
}

function sortCoordinatorRoster(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function randomHumanActionDelayMs() {
  const processEnv = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  if (import.meta.env.MODE === "test" || processEnv?.VITEST) {
    return 0;
  }
  return Math.floor(Math.random() * SIMPLE_HUMAN_ACTION_JITTER_MAX_MS);
}

function createCoordinatorStartupDiagnostics(): CoordinatorStartupDiagnostics {
  return {
    mlsJoinStartedAt: null,
    mlsJoinLastAttemptAt: null,
    mlsJoinAttemptCount: 0,
    mlsJoinLastResult: "pending",
    mlsJoinResolvedAt: null,
    mlsJoinPackagePublishAttemptCount: 0,
    mlsJoinPackagePublishSuccessCount: 0,
    mlsJoinPackagePublishFailureCount: 0,
    mlsJoinPackageLastPublishAt: null,
    mlsJoinPackageLastRelayResults: [],
    mlsWelcomeObservedCount: 0,
    mlsWelcomeLastObservedAt: null,
    mlsWelcomePublishAttemptCount: 0,
    mlsWelcomePublishSuccessCount: 0,
    mlsWelcomePublishFailureCount: 0,
    mlsWelcomeLastPublishAt: null,
    mlsWelcomeLastRelayResults: [],
    controlCarrierFetchAttemptCount: 0,
    controlCarrierFetchLastAt: null,
    controlCarrierFetchLastCount: 0,
    controlCarrierFetchLastError: null,
    controlCarrierSubscriptionObservedCount: 0,
    controlCarrierSubscriptionLastObservedAt: null,
    controlCarrierLastObservedEventId: null,
    controlCarrierLastObservedSource: null,
    startupPublishAttempted: false,
    startupPublishSucceeded: false,
    startupPublishEventId: null,
    startupPublishEventType: null,
    startupPublishEventKind: null,
    startupPublishEventTags: [],
    startupPublishEventCreatedAt: null,
    startupPublishRelayTargets: [],
    startupPublishRelaySuccessCount: 0,
    startupPublishRelayResults: [],
    startupPublishLocalEchoApplied: false,
    startupPublishProbeEventFoundByKindOnly: false,
    startupLiveFilter: null,
    startupBackfillFilter: null,
    startupObservedLive: false,
    startupObservedBackfill: false,
    startupProbeKindOnlyCount: 0,
    startupProbeFilteredCount: 0,
    startupProbeKindElectionCount: 0,
    startupProbeKindElectionGroupCount: 0,
    startupWriteSuccessRelays: [],
    startupReadLiveRelays: [],
    startupReadBackfillRelays: [],
    startupRelayOverlap: [],
    startupRelayNoOverlap: true,
    startupWriteRelayQueriedByBackfill: false,
    startupForcedRecoveryAttemptCount: 0,
    startupForcedRecoveryLastAttemptAt: null,
    startupForcedRecoveryLastOutcome: null,
    startupJoinFailureBucket: null,
  };
}

function createBlindKeyDiagnostics(): BlindKeyDiagnostics {
  return {
    blindKeyPublishAttempted: false,
    blindKeyPublishStartedAt: null,
    blindKeyPublishSucceeded: false,
    blindKeyPublishSucceededAt: null,
    blindKeyObservedBackLocally: false,
    blindKeyPublishAttemptCount: 0,
    blindKeyPublishLastError: null,
    blindKeyEventId: null,
    blindKeyRelayTargets: [],
    blindKeyRelaySuccessCount: 0,
    blindKeyFailureClass: null,
  };
}

function readRuntimeIntOverride(name: string, fallback: number) {
  const processEnv = (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
  const importMetaEnv = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env) ?? {};
  const candidates = [
    importMetaEnv[`VITE_${name}`],
    importMetaEnv[name],
    processEnv[`VITE_${name}`],
    processEnv[name],
  ];
  for (const candidate of candidates) {
    const parsed = Number.parseInt(candidate ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeLiveVoteSession(
  vote: Partial<SimpleLiveVoteSession> | null | undefined,
  fallbackCoordinatorNpubs: string[] = [],
): SimpleLiveVoteSession | null {
  if (
    !vote
    || typeof vote.votingId !== "string"
    || typeof vote.prompt !== "string"
    || typeof vote.coordinatorNpub !== "string"
    || typeof vote.createdAt !== "string"
    || typeof vote.eventId !== "string"
  ) {
    return null;
  }

  const authorizedCoordinatorNpubs = sortCoordinatorRoster(
    Array.isArray(vote.authorizedCoordinatorNpubs)
      ? vote.authorizedCoordinatorNpubs
      : [vote.coordinatorNpub, ...fallbackCoordinatorNpubs],
  );

  return {
    votingId: vote.votingId,
    prompt: vote.prompt,
    coordinatorNpub: vote.coordinatorNpub,
    createdAt: vote.createdAt,
    thresholdT: typeof vote.thresholdT === "number" ? vote.thresholdT : undefined,
    thresholdN: typeof vote.thresholdN === "number" ? vote.thresholdN : undefined,
    authorizedCoordinatorNpubs,
    eventId: vote.eventId,
  };
}

function createSimpleCoordinatorKeypair(): SimpleCoordinatorKeypair {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

function toHexPubkey(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Expected npub.");
    }
    return decoded.data as string;
  }
  return trimmed;
}

function extractNostrBech32Candidates(value: string): string[] {
  const matches = value.match(/(?:npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]+/gi) ?? [];
  const deduped = new Set<string>();
  for (const match of matches) {
    const normalized = match.trim().toLowerCase();
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return [...deduped];
}

function normalizeInviteNpubInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const withoutScheme = trimmed.toLowerCase().startsWith("nostr:")
    ? trimmed.slice("nostr:".length).trim()
    : trimmed;

  const candidates = new Set<string>([
    withoutScheme.toLowerCase(),
    ...extractNostrBech32Candidates(withoutScheme),
  ]);

  try {
    const decodedUri = decodeURIComponent(withoutScheme);
    candidates.add(decodedUri.toLowerCase());
    for (const match of extractNostrBech32Candidates(decodedUri)) {
      candidates.add(match);
    }
  } catch {
    // Ignore URI decode errors and keep raw candidates.
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (isValidNpub(candidate)) {
      return candidate;
    }
    try {
      const decoded = nip19.decode(candidate);
      if (decoded.type === "npub") {
        const npub = nip19.npubEncode(decoded.data as string);
        if (isValidNpub(npub)) {
          return npub;
        }
      }
      if (decoded.type === "nprofile") {
        const data = decoded.data as { pubkey?: string } | undefined;
        if (!data?.pubkey) {
          continue;
        }
        const npub = nip19.npubEncode(data.pubkey);
        if (isValidNpub(npub)) {
          return npub;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function createLocalNsecSignerService(nsec: string) {
  const secretKey = decodeNsec(nsec);
  if (!secretKey) {
    return createSignerService();
  }
  const npub = nip19.npubEncode(getPublicKey(secretKey));
  return {
    async isAvailable() {
      return true;
    },
    async getPublicKey() {
      return npub;
    },
    async signMessage(message: string) {
      return `local:${message}`;
    },
    async signEvent<T extends Record<string, unknown>>(event: T) {
      const signed = finalizeEvent({
        ...(event as Record<string, unknown>),
      } as never, secretKey);
      return signed as T & { id?: string; sig?: string; pubkey?: string };
    },
    async nip44Encrypt(pubkey: string, plaintext: string) {
      const targetHex = toHexPubkey(pubkey);
      const conversationKey = nip44.v2.utils.getConversationKey(secretKey, targetHex);
      return nip44.v2.encrypt(plaintext, conversationKey);
    },
    async nip44Decrypt(pubkey: string, ciphertext: string) {
      const senderHex = toHexPubkey(pubkey);
      const conversationKey = nip44.v2.utils.getConversationKey(secretKey, senderHex);
      return nip44.v2.decrypt(ciphertext, conversationKey);
    },
  };
}

function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

function formatRelayHost(relay: string) {
  return relay.replace(/^wss?:\/\//, '').replace(/\/$/, '');
}

function uniqueRelays(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function reconcileStartupRelayDiagnostics(current: CoordinatorStartupDiagnostics) {
  const writeSuccessRelays = uniqueRelays(current.startupWriteSuccessRelays);
  const liveRelays = uniqueRelays(current.startupReadLiveRelays);
  const backfillRelays = uniqueRelays(current.startupReadBackfillRelays);
  const readRelays = uniqueRelays([...liveRelays, ...backfillRelays]);
  const overlap = writeSuccessRelays.filter((relay) => readRelays.includes(relay));
  const backfillOverlap = writeSuccessRelays.some((relay) => backfillRelays.includes(relay));
  return {
    startupWriteSuccessRelays: writeSuccessRelays,
    startupReadLiveRelays: liveRelays,
    startupReadBackfillRelays: backfillRelays,
    startupRelayOverlap: overlap,
    startupRelayNoOverlap: writeSuccessRelays.length > 0 && overlap.length === 0,
    startupWriteRelayQueriedByBackfill: backfillOverlap,
  } satisfies Partial<CoordinatorStartupDiagnostics>;
}

function deliveryToneClass(tone: string) {
  return tone === "error"
    ? "simple-delivery-error"
    : tone === "ok"
      ? "simple-delivery-ok"
      : "simple-delivery-waiting";
}

function formatCoordinatorControlStateLabel(
  view: CoordinatorEngineView | null,
  status?: CoordinatorEngineStatus | null,
) {
  if (status?.blocked_reason) {
    const latestRoundId = view?.latest_round?.round_id;
    return latestRoundId
      ? `${status.blocked_reason.replace(/\.$/, "")} for ${shortVotingId(latestRoundId)}.`
      : status.blocked_reason;
  }

  const latestRound = view?.latest_round ?? null;
  if (!latestRound) {
    if (status?.engine_kind === "open_mls" && !status.group_ready) {
      return "Waiting for supervisory group readiness.";
    }
    return null;
  }

  if (latestRound.phase === "open") {
    return `Coordinator round open agreed for ${shortVotingId(latestRound.round_id)}.`;
  }

  if (latestRound.phase === "open_proposed") {
    if (latestRound.missing_open_committers.length === 0) {
      return `Coordinator approvals received for ${shortVotingId(latestRound.round_id)}.`;
    }

    return `Waiting for coordinator approvals for ${shortVotingId(latestRound.round_id)}.`;
  }

  if (latestRound.phase === "draft") {
    return `Round draft prepared for ${shortVotingId(latestRound.round_id)}.`;
  }

  if (latestRound.phase === "published") {
    return `Coordinator result approval completed for ${shortVotingId(latestRound.round_id)}.`;
  }

  return `Coordinator control state: ${latestRound.phase.replace(/_/g, " ")}.`;
}

function findLatestRoundRequest(
  requests: SimpleShardRequest[],
  voterNpub: string,
  votingId: string,
) {
  return requests
    .filter((request) => request.voterNpub === voterNpub && request.votingId === votingId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function buildShareAssignmentSignature(
  applications: SimpleSubCoordinatorApplication[],
  thresholdN: number | undefined,
) {
  const sortedApplications = [...applications].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.coordinatorNpub.localeCompare(right.coordinatorNpub),
  );

  return [
    String(thresholdN ?? ''),
    ...sortedApplications.map(
      (application, index) => `${application.coordinatorNpub}:${index + 2}`,
    ),
  ].join('|');
}

function formatCoordinatorList(values: string[]) {
  const labels = values.map((npub) => `Coordinator ${deriveActorDisplayId(npub)}`);
  if (labels.length <= 1) {
    return labels[0] ?? "Coordinator";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

export default function SimpleCoordinatorApp() {
  const [keypair, setKeypair] = useState<SimpleCoordinatorKeypair | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [coordinatorId, setCoordinatorId] = useState("pending");
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);
  const [signerNpub, setSignerNpub] = useState<string>("");
  const [signerStatus, setSignerStatus] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [storagePassphrase, setStoragePassphrase] = useState("");
  const [storageLocked, setStorageLocked] = useState(false);
  const [storageStatus, setStorageStatus] = useState<string | null>(null);
  const [leadCoordinatorNpub, setLeadCoordinatorNpub] = useState("");
  const [nip65Enabled, setNip65Enabled] = useState(false);
  const [leadScannerActive, setLeadScannerActive] = useState(false);
  const [leadScannerStatus, setLeadScannerStatus] = useState<string | null>(null);
  const [followers, setFollowers] = useState<SimpleCoordinatorFollower[]>([]);
  const [subCoordinators, setSubCoordinators] = useState<SimpleSubCoordinatorApplication[]>([]);
  const [ticketDeliveries, setTicketDeliveries] = useState<Record<string, TicketDeliveryState>>({});
  const [autoSendFollowers, setAutoSendFollowers] = useState<Record<string, boolean>>({});
  const [followerSearch, setFollowerSearch] = useState("");
  const [pendingRequests, setPendingRequests] = useState<SimpleShardRequest[]>([]);
  const [dmAcknowledgements, setDmAcknowledgements] = useState<SimpleDmAcknowledgement[]>([]);
  const [registrationStatus, setRegistrationStatus] = useState<string | null>(null);
  const [assignmentStatus, setAssignmentStatus] = useState<string | null>(null);
  const [questionPrompt, setQuestionPrompt] = useState("Should the proposal pass?");
  const [questionThresholdT, setQuestionThresholdT] = useState("1");
  const [questionThresholdN, setQuestionThresholdN] = useState("1");
  const [questionShareIndex, setQuestionShareIndex] = useState("1");
  const [roundBlindPrivateKeys, setRoundBlindPrivateKeys] = useState<Record<string, SimpleBlindPrivateKey>>({});
  const [roundBlindKeyAnnouncements, setRoundBlindKeyAnnouncements] = useState<Record<string, SimpleBlindKeyAnnouncement>>({});
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [coordinatorControlCache, setCoordinatorControlCache] = useState<CoordinatorControlCache | null>(null);
  const [protocolStateCache, setProtocolStateCache] = useState<ProtocolStateCache | null>(null);
  const [derivedProtocolState, setDerivedProtocolState] = useState<Awaited<ReturnType<ProtocolStateService["replayPublicState"]>>["derivedState"] | null>(null);
  const [derivedPublicRounds, setDerivedPublicRounds] = useState<SimpleLiveVoteSession[]>([]);
  const [coordinatorControlView, setCoordinatorControlView] = useState<CoordinatorEngineView | null>(null);
  const [coordinatorControlStateLabel, setCoordinatorControlStateLabel] = useState<string | null>(null);
  const [blindKeyDiagnosticsVersion, setBlindKeyDiagnosticsVersion] = useState(0);
  const [initialControlBackfillComplete, setInitialControlBackfillComplete] = useState(false);
  const [autoApprovalComplete, setAutoApprovalComplete] = useState(false);
  const [welcomeAckSent, setWelcomeAckSent] = useState(false);
  const [publishedVotes, setPublishedVotes] = useState<SimpleLiveVoteSession[]>([]);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [selectedSubmittedVotingId, setSelectedSubmittedVotingId] =
    useState('');
  const [submittedVotes, setSubmittedVotes] = useState<SimpleSubmittedVote[]>([]);
  const [activeTab, setActiveTab] = useState<CoordinatorTab>("configure");
  const [questionnaireRosterAnnouncement, setQuestionnaireRosterAnnouncement] = useState<{
    questionnaireId: string;
    state: string | null;
  }>({
    questionnaireId: "",
    state: null,
  });
  const updateQuestionnaireRosterAnnouncement = useCallback((nextStatus: {
    questionnaireId: string;
    state: string | null;
  }) => {
    setQuestionnaireRosterAnnouncement((current) => {
      const nextQuestionnaireId = nextStatus.questionnaireId.trim();
      return {
        // Keep the last known questionnaire id when panel status callbacks emit transient blanks.
        questionnaireId: nextQuestionnaireId || current.questionnaireId,
        state: nextStatus.state ?? current.state,
      };
    });
  }, []);
  const [knownVoterDraftNpub, setKnownVoterDraftNpub] = useState("");
  const [knownVoterInviteStatus, setKnownVoterInviteStatus] = useState<string | null>(null);
  const [knownVoterInviteRefreshNonce, setKnownVoterInviteRefreshNonce] = useState(0);
  const [optimisticKnownVoterNpubs, setOptimisticKnownVoterNpubs] = useState<string[]>([]);
  const [knownVoterContactsLoading, setKnownVoterContactsLoading] = useState(false);
  const [importedKnownVoterContacts, setImportedKnownVoterContacts] = useState<ImportedKnownVoterContact[]>([]);
  const [knownVoterContactSearch, setKnownVoterContactSearch] = useState("");
  const [selectedImportedKnownVoterNpubs, setSelectedImportedKnownVoterNpubs] = useState<string[]>([]);
  const [shareAssignmentsInFlight, setShareAssignmentsInFlight] =
    useState(false);
  const [
    lastSuccessfulShareAssignmentSignature,
    setLastSuccessfulShareAssignmentSignature,
  ] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const activeCoordinatorNpub = signerNpub.trim() || keypair?.npub?.trim() || "";
  const deploymentMode = useMemo(() => readDeploymentModeFromUrl(), []);
  const isCourseFeedbackMode = deploymentMode === "course_feedback";
  const optionASigner = useMemo(() => {
    if (!signerNpub.trim() && keypair?.nsec?.trim()) {
      return createLocalNsecSignerService(keypair.nsec);
    }
    return createSignerService();
  }, [signerNpub, keypair?.nsec]);
  const optionAElectionId = useMemo(() => {
    const announced = questionnaireRosterAnnouncement.questionnaireId.trim();
    if (announced) {
      return announced;
    }
    if (typeof window === "undefined") {
      return "";
    }
    const params = new URLSearchParams(window.location.search);
    return (params.get("election_id") ?? params.get("questionnaire") ?? "").trim();
  }, [questionnaireRosterAnnouncement.questionnaireId]);
  const questionnaireFlowActive = isCourseFeedbackMode || optionAElectionId.length > 0;
  const optionACoordinatorRuntime = useMemo(() => (
    optionAElectionId
      ? new QuestionnaireOptionACoordinatorRuntime(
        optionASigner,
        optionAElectionId,
        signerNpub.trim() ? undefined : keypair?.nsec,
      )
      : null
  ), [keypair?.nsec, optionAElectionId, optionASigner, signerNpub]);
  useEffect(() => {
    return () => {
      optionACoordinatorRuntime?.dispose();
    };
  }, [optionACoordinatorRuntime]);
  const optionAKnownVoters = useMemo(() => {
    const runtimeWhitelist = Object.values(optionACoordinatorRuntime?.getSnapshot()?.whitelist ?? {});
    if (!activeCoordinatorNpub.trim() || !optionAElectionId.trim()) {
      return runtimeWhitelist;
    }
    const persisted = loadCoordinatorState({
      coordinatorNpub: activeCoordinatorNpub,
      electionId: optionAElectionId,
    });
    const persistedWhitelist = Object.values(persisted?.whitelist ?? {});
    const mergedByNpub = new Map<string, (typeof runtimeWhitelist)[number]>();
    for (const entry of persistedWhitelist) {
      const npub = entry.invitedNpub.trim();
      if (!npub) {
        continue;
      }
      mergedByNpub.set(npub, entry);
    }
    for (const entry of runtimeWhitelist) {
      const npub = entry.invitedNpub.trim();
      if (!npub) {
        continue;
      }
      mergedByNpub.set(npub, entry);
    }
    return [...mergedByNpub.values()];
  }, [activeCoordinatorNpub, optionACoordinatorRuntime, optionAElectionId, knownVoterInviteRefreshNonce]);
  const visibleOptionAKnownVoters = useMemo(() => {
    const byNpub = new Map<string, (typeof optionAKnownVoters)[number]>();
    for (const entry of optionAKnownVoters) {
      const npub = entry.invitedNpub.trim();
      if (!npub) {
        continue;
      }
      byNpub.set(npub, entry);
    }
    for (const npub of optimisticKnownVoterNpubs) {
      const normalized = npub.trim();
      if (!normalized || byNpub.has(normalized)) {
        continue;
      }
      byNpub.set(normalized, {
        electionId: optionAElectionId || "",
        invitedNpub: normalized,
        addedAt: new Date().toISOString(),
        claimState: "invited",
      });
    }
    return [...byNpub.values()];
  }, [optimisticKnownVoterNpubs, optionAElectionId, optionAKnownVoters]);
  const invitedKnownVoterSet = useMemo(
    () => new Set(
      visibleOptionAKnownVoters
        .filter((entry) => entry.claimState === "invited")
        .map((entry) => entry.invitedNpub.trim())
        .filter((value) => value.length > 0),
    ),
    [visibleOptionAKnownVoters],
  );
  const optionAPendingAuthorizations = useMemo(
    () => optionACoordinatorRuntime?.getPendingAuthorizations() ?? [],
    [optionACoordinatorRuntime, knownVoterInviteRefreshNonce],
  );
  const optionAHasInviteQueue = optionAPendingAuthorizations.length > 0;
  const optionABlindSigningPublicKey = optionACoordinatorRuntime?.getSnapshot()?.election.blindSigningPublicKey ?? null;
  const optionAAcceptedResponses = useMemo(() => {
    const snapshot = optionACoordinatorRuntime?.getSnapshot();
    if (!snapshot) {
      return [];
    }
    return Object.values(snapshot.acceptanceResults)
      .filter((result) => result.accepted)
      .map((result) => snapshot.receivedSubmissions[result.submissionId])
      .filter((submission): submission is BallotSubmission => Boolean(submission))
      .map(optionASubmissionToAcceptedResponse)
      .sort((left, right) => left.payload.submittedAt - right.payload.submittedAt);
  }, [optionACoordinatorRuntime, knownVoterInviteRefreshNonce]);

  useEffect(() => {
    setKnownVoterInviteStatus(null);
    setOptimisticKnownVoterNpubs([]);
  }, [optionAElectionId]);
  const optionAAcceptedCount = Math.max(optionACoordinatorRuntime?.getAcceptedUniqueCount() ?? 0, optionAAcceptedResponses.length);
  const optionAKnownVoterCount = Math.max(followers.length, visibleOptionAKnownVoters.length);
  const filteredImportedKnownVoterContacts = useMemo(() => {
    const query = knownVoterContactSearch.trim().toLowerCase();
    if (!query) {
      return importedKnownVoterContacts;
    }
    return importedKnownVoterContacts.filter((contact) => (
      contact.npub.toLowerCase().includes(query)
      || (contact.nip05 ?? "").toLowerCase().includes(query)
      || (contact.profileName ?? "").toLowerCase().includes(query)
      || (contact.petname ?? "").toLowerCase().includes(query)
    ));
  }, [importedKnownVoterContacts, knownVoterContactSearch]);
  const selectedImportedKnownVoterSet = useMemo(
    () => new Set(selectedImportedKnownVoterNpubs),
    [selectedImportedKnownVoterNpubs],
  );
  const ticketRetryMinAgeMs = useMemo(
    () => readRuntimeIntOverride("SIMPLE_TICKET_RETRY_AGE_MS", SIMPLE_TICKET_RETRY_MIN_AGE_MS),
    [],
  );
  const ticketRetryMaxAttempts = useMemo(
    () => readRuntimeIntOverride("SIMPLE_TICKET_RETRY_MAX_ATTEMPTS", SIMPLE_TICKET_RETRY_MAX_ATTEMPTS),
    [],
  );
  const ticketSendMaxConcurrency = useMemo(
    () => readRuntimeIntOverride("SIMPLE_TICKET_SEND_MAX_CONCURRENCY", SIMPLE_TICKET_SEND_MAX_CONCURRENCY),
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    // Local nsec identities should not be overridden by a stale signer npub.
    if (keypair?.nsec?.trim()) {
      setSignerNpub("");
      return;
    }
    const persisted = window.localStorage.getItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY)?.trim() ?? "";
    if (persisted) {
      setSignerNpub(persisted);
      setSignerStatus(null);
    }
  }, [keypair?.nsec]);

  useEffect(() => {
    if (!optionACoordinatorRuntime || !activeCoordinatorNpub || !optionAElectionId) {
      return;
    }
    let cancelled = false;
    try {
      optionACoordinatorRuntime.bootstrapCoordinatorNpub({
        coordinatorNpub: activeCoordinatorNpub,
        summary: {
          electionId: optionAElectionId,
          title: questionPrompt,
          description: "",
          state: "open",
          protocolVersion: QUESTIONNAIRE_PROTOCOL_VERSION_V2,
          flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
          responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
        },
      });
      setKnownVoterInviteRefreshNonce((value) => value + 1);
      void optionACoordinatorRuntime.ensureBlindSigningPublicKey().then(() => {
        if (!cancelled) {
          setKnownVoterInviteRefreshNonce((value) => value + 1);
        }
      }).catch(() => {
        // The invite/send paths will surface key setup failures.
      });
    } catch {
      // Manual login remains available.
    }
    return () => {
      cancelled = true;
    };
  }, [activeCoordinatorNpub, optionACoordinatorRuntime, optionAElectionId, questionPrompt]);
  const ticketObserveRecoveryAgeMs = useMemo(
    () => readRuntimeIntOverride("SIMPLE_TICKET_OBSERVE_RECOVERY_AGE_MS", SIMPLE_TICKET_OBSERVE_RECOVERY_AGE_MS),
    [],
  );
  const blindKeyRepublishAtRef = useRef<Record<string, number>>({});
  const autoSendInFlightRef = useRef<Set<string>>(new Set());
  const optionAAutoAuthorizeInFlightRef = useRef<Set<string>>(new Set());
  const autoShareAssignmentAttemptRef = useRef('');
  const coordinatorControlServiceRef = useRef<CoordinatorControlService | null>(null);
  const protocolStateServiceRef = useRef<ProtocolStateService | null>(null);
  const roundBroadcastInFlightRef = useRef<string | null>(null);
  const pendingRoundOpenAttemptRef = useRef(false);
  const roundOpenRetryAttemptsRef = useRef<Record<string, number>>({});
  const identityHydrationEpochRef = useRef(0);
  const sentMlsWelcomeEventIdsRef = useRef<Record<string, string>>({});
  const sentMlsWelcomeAckIdsRef = useRef<Set<string>>(new Set());
  const verifyAllVisibleRef = useRef<HTMLInputElement | null>(null);
  const isLeadCoordinator = !leadCoordinatorNpub.trim() || leadCoordinatorNpub.trim() === (keypair?.npub ?? "");
  const canShowNotifyLeadButton = Boolean(
    leadCoordinatorNpub.trim()
    && leadCoordinatorNpub.trim() !== (keypair?.npub ?? ""),
  );
  const activeShareIndex = isLeadCoordinator ? 1 : (Number.parseInt(questionShareIndex, 10) || 0);
  const hasAssignedShareIndex = !isLeadCoordinator && activeShareIndex > 0;
  const availableCoordinatorCount = Math.max(1, subCoordinators.length + 1);
  const liveVoteSourceNpub = isLeadCoordinator ? (keypair?.npub ?? "") : leadCoordinatorNpub.trim();
  const coordinatorRoster = useMemo(
    () => sortCoordinatorRoster([
      keypair?.npub ?? "",
      leadCoordinatorNpub.trim(),
      ...subCoordinators.map((application) => application.coordinatorNpub),
    ]),
    [keypair?.npub, leadCoordinatorNpub, subCoordinators],
  );
  const coordinatorHexRoster = useMemo(
    () => npubsToHexRoster(coordinatorRoster),
    [coordinatorRoster],
  );
  const singleCoordinatorMode = coordinatorHexRoster.length === 1;
  const coordinatorRuntimeEngineKind = singleCoordinatorMode ? "deterministic" : "open_mls";
  const coordinatorHexRosterSignature = useMemo(
    () => coordinatorHexRoster.join("|"),
    [coordinatorHexRoster],
  );
  const localCoordinatorHexPubkey = useMemo(
    () => npubsToHexRoster(keypair?.npub ? [keypair.npub] : [])[0] ?? "",
    [keypair?.npub],
  );
  const leadCoordinatorHexPubkey = useMemo(
    () => npubsToHexRoster(leadCoordinatorNpub.trim() ? [leadCoordinatorNpub.trim()] : [])[0] ?? "",
    [leadCoordinatorNpub],
  );
  const coordinatorElectionId = useMemo(
    () => keypair?.npub
      ? deriveCoordinatorElectionId({
          coordinatorNpub: keypair.npub,
          leadCoordinatorNpub: leadCoordinatorNpub.trim() || undefined,
        })
      : "",
    [keypair?.npub, leadCoordinatorNpub],
  );
  const visiblePublishedVotes = derivedPublicRounds.length > 0 ? derivedPublicRounds : publishedVotes;
  const selectedPublishedVote = useMemo(
    () => visiblePublishedVotes.find((vote) => vote.votingId === selectedVotingId) ?? visiblePublishedVotes[0] ?? null,
    [selectedVotingId, visiblePublishedVotes],
  );
  const selectedSubmittedVote = useMemo(
    () =>
      visiblePublishedVotes.find(
        (vote) => vote.votingId === selectedSubmittedVotingId,
      ) ??
      visiblePublishedVotes[0] ??
      null,
    [selectedSubmittedVotingId, visiblePublishedVotes],
  );
  const activeVotingId = selectedPublishedVote?.votingId ?? "";
  const activeThresholdT = selectedPublishedVote?.thresholdT ?? (Number.parseInt(questionThresholdT, 10) || undefined);
  const activeThresholdN = selectedPublishedVote?.thresholdN ?? (Number.parseInt(questionThresholdN, 10) || undefined);
  const activeBlindPrivateKey = activeVotingId ? roundBlindPrivateKeys[activeVotingId] ?? null : null;
  const activeBlindKeyAnnouncement = activeVotingId ? roundBlindKeyAnnouncements[activeVotingId] ?? null : null;
  const maxThresholdT = Math.max(
    1,
    Math.min(Number.parseInt(questionThresholdN, 10) || 1, availableCoordinatorCount),
  );
  const sentFollowAckStateRef = useRef<Record<string, string>>({});
  const sentRosterStateRef = useRef<Record<string, string>>({});
  const sentRequestAckIdsRef = useRef<Set<string>>(new Set());
  const sentSubCoordinatorAckIdsRef = useRef<Set<string>>(new Set());
  const sentAssignmentAckIdsRef = useRef<Set<string>>(new Set());
  const sentMlsWelcomeStateRef = useRef<Record<string, string>>({});
  const seenMlsWelcomeIdsRef = useRef<Set<string>>(new Set());
  const mlsBootstrapInFlightRef = useRef(false);
  const singleCoordinatorBootstrapAttemptRef = useRef("");
  const startupDiagnosticsRef = useRef<CoordinatorStartupDiagnostics>(createCoordinatorStartupDiagnostics());
  const blindKeyDiagnosticsRef = useRef<BlindKeyDiagnostics>(createBlindKeyDiagnostics());
  const startupJoinPendingSinceRef = useRef<number | null>(null);
  const startupForcedRecoveryInFlightRef = useRef(false);
  const startupForcedRecoveryAttemptedRef = useRef(false);
  const latestCoordinatorHexRosterRef = useRef<string[]>([]);
  const latestCoordinatorElectionIdRef = useRef("");
  const saveStateDebounceTimerRef = useRef<number | null>(null);
  const lastSavedStateSignatureRef = useRef<string>("");
  const optionAQueueProcessingInFlightRef = useRef(false);
  const optionAQueueLifecycleRefreshAtRef = useRef(0);

  useEffect(() => {
    latestCoordinatorHexRosterRef.current = coordinatorHexRoster;
    latestCoordinatorElectionIdRef.current = coordinatorElectionId;
  }, [coordinatorElectionId, coordinatorHexRoster]);

  function updateStartupDiagnostics(
    update:
      | Partial<CoordinatorStartupDiagnostics>
      | ((current: CoordinatorStartupDiagnostics) => Partial<CoordinatorStartupDiagnostics>),
  ) {
    const current = startupDiagnosticsRef.current;
    const patch = typeof update === "function" ? update(current) : update;
    startupDiagnosticsRef.current = {
      ...current,
      ...patch,
    };
  }

  function updateBlindKeyDiagnostics(
    update:
      | Partial<BlindKeyDiagnostics>
      | ((current: BlindKeyDiagnostics) => Partial<BlindKeyDiagnostics>),
  ) {
    const current = blindKeyDiagnosticsRef.current;
    const patch = typeof update === "function" ? update(current) : update;
    blindKeyDiagnosticsRef.current = {
      ...current,
      ...patch,
    };
    setBlindKeyDiagnosticsVersion((value) => value + 1);
  }

  function recordStartupPublishDiagnostic(diagnostic: CoordinatorControlPublishDiagnostic) {
    const successfulRelays = diagnostic.relayResults
      .filter((entry) => entry.success)
      .map((entry) => entry.relay);
    updateStartupDiagnostics((current) => {
      const next = {
        ...current,
        startupPublishAttempted: true,
        startupPublishSucceeded: current.startupPublishSucceeded || diagnostic.relaySuccessCount > 0,
        startupPublishEventId: diagnostic.eventId,
        startupPublishEventType: diagnostic.eventType,
        startupPublishEventKind: diagnostic.kind,
        startupPublishEventTags: diagnostic.tags,
        startupPublishEventCreatedAt: diagnostic.createdAt,
        startupPublishRelayTargets: diagnostic.relayTargets,
        startupPublishRelaySuccessCount: diagnostic.relaySuccessCount,
        startupPublishRelayResults: diagnostic.relayResults.map((entry) => ({
          relay: entry.relay,
          success: entry.success,
          error: entry.error,
        })),
        startupPublishLocalEchoApplied: diagnostic.localEchoApplied,
        startupWriteSuccessRelays: uniqueRelays([
          ...current.startupWriteSuccessRelays,
          ...successfulRelays,
        ]),
      } satisfies CoordinatorStartupDiagnostics;
      return {
        ...next,
        ...reconcileStartupRelayDiagnostics(next),
      };
    });

    void (async () => {
      try {
        const kindOnlyEvents = await fetchCoordinatorControlEvents({
          electionId: diagnostic.electionId,
          coordinatorHexPubkeys: latestCoordinatorHexRosterRef.current,
          mode: "kind_only",
          limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
        });
        updateStartupDiagnostics({
          startupPublishProbeEventFoundByKindOnly: kindOnlyEvents.some((event) => event.id === diagnostic.eventId),
        });
      } catch {
        updateStartupDiagnostics({
          startupPublishProbeEventFoundByKindOnly: false,
        });
      }
    })();
  }

  function getOutstandingMlsWelcomeAckNpubs() {
    if (!isLeadCoordinator) {
      return [];
    }

    const expectedSubCoordinators = subCoordinators.filter(
      (application) => application.mlsJoinPackage?.trim(),
    );

    return expectedSubCoordinators
      .map((application) => application.coordinatorNpub)
      .filter((coordinatorNpub) => {
        const welcomeEventId = sentMlsWelcomeEventIdsRef.current[coordinatorNpub];
        if (!welcomeEventId) {
          return true;
        }

        return !dmAcknowledgements.some((ack) => (
          ack.actorNpub === coordinatorNpub
          && ack.ackedAction === "simple_mls_welcome"
          && ack.ackedEventId === welcomeEventId
        ));
      });
  }

  const coordinatorEngineStatus =
    coordinatorControlServiceRef.current?.getEngineStatus() ?? null;
  const coordinatorRuntimeReadiness = useMemo<CoordinatorRuntimeReadiness | null>(() => {
    if (!coordinatorEngineStatus) {
      return null;
    }

    const mlsJoinComplete =
      coordinatorEngineStatus.engine_kind !== "open_mls"
      || singleCoordinatorMode
      || coordinatorEngineStatus.joined_group;
    const welcomeAckSatisfied =
      coordinatorEngineStatus.engine_kind !== "open_mls"
        || singleCoordinatorMode
        ? true
        : isLeadCoordinator
          ? getOutstandingMlsWelcomeAckNpubs().length === 0
          : welcomeAckSent;
    const roundOpenPublishSafe =
      mlsJoinComplete
      && welcomeAckSatisfied
      && initialControlBackfillComplete
      && autoApprovalComplete;
    const blindKeyPublishSafe =
      roundOpenPublishSafe
      && ["open", "tallied", "published", "disputed"].includes(
        coordinatorEngineStatus.public_round_visibility,
      );
    const ticketPlaneSafe =
      blindKeyPublishSafe
      && (!activeVotingId || Boolean(activeBlindKeyAnnouncement));

    let phase = "ticket_plane_safe";
    if (!mlsJoinComplete) {
      phase = "mls_join_pending";
    } else if (!welcomeAckSatisfied) {
      phase = "welcome_ack_pending";
    } else if (!initialControlBackfillComplete) {
      phase = "initial_control_backfill_pending";
    } else if (!autoApprovalComplete) {
      phase = "auto_approval_pending";
    } else if (!roundOpenPublishSafe) {
      phase = "round_open_publish_pending";
    } else if (!blindKeyPublishSafe) {
      phase = "blind_key_publish_pending";
    } else if (!ticketPlaneSafe) {
      phase = "ticket_plane_pending";
    }

    return {
      phase,
      mlsJoinComplete,
      welcomeAckSent: welcomeAckSatisfied,
      initialControlBackfillComplete,
      autoApprovalComplete,
      roundOpenPublishSafe,
      blindKeyPublishSafe,
      ticketPlaneSafe,
    };
  }, [
    activeBlindKeyAnnouncement,
    activeVotingId,
    autoApprovalComplete,
    coordinatorEngineStatus,
    initialControlBackfillComplete,
    isLeadCoordinator,
    singleCoordinatorMode,
    welcomeAckSent,
    subCoordinators,
    dmAcknowledgements,
  ]);

  useEffect(() => {
    if (singleCoordinatorMode) {
      startupJoinPendingSinceRef.current = null;
      return;
    }
    if (!coordinatorRuntimeReadiness) {
      startupJoinPendingSinceRef.current = null;
      return;
    }
    if (coordinatorRuntimeReadiness.phase === "mls_join_pending") {
      startupJoinPendingSinceRef.current = startupJoinPendingSinceRef.current ?? Date.now();
      updateStartupDiagnostics((current) => ({
        mlsJoinStartedAt: current.mlsJoinStartedAt ?? new Date().toISOString(),
      }));
      return;
    }
    startupJoinPendingSinceRef.current = null;
  }, [coordinatorRuntimeReadiness, singleCoordinatorMode]);

  useEffect(() => {
    if (!singleCoordinatorMode || !isLeadCoordinator || !keypair?.nsec) {
      return;
    }
    if (!initialControlBackfillComplete) {
      return;
    }
    const service = coordinatorControlServiceRef.current;
    if (!service) {
      return;
    }
    const status = service.getEngineStatus();
    if (status.engine_kind !== "open_mls" || status.group_ready || mlsBootstrapInFlightRef.current) {
      return;
    }
    const attemptKey = `${coordinatorElectionId}:${coordinatorHexRosterSignature}`;
    if (singleCoordinatorBootstrapAttemptRef.current === attemptKey) {
      return;
    }
    singleCoordinatorBootstrapAttemptRef.current = attemptKey;
    void ensureCoordinatorControlGroupReady();
  }, [
    coordinatorElectionId,
    coordinatorHexRosterSignature,
    initialControlBackfillComplete,
    isLeadCoordinator,
    keypair?.nsec,
    singleCoordinatorMode,
  ]);

  useEffect(() => {
    if (singleCoordinatorMode) {
      updateStartupDiagnostics({
        startupJoinFailureBucket: null,
        startupPublishAttempted: false,
        startupPublishSucceeded: false,
        startupObservedLive: true,
        startupObservedBackfill: false,
        controlCarrierFetchAttemptCount: 0,
        controlCarrierFetchLastCount: 0,
      });
      return;
    }
    if (!coordinatorEngineStatus || coordinatorEngineStatus.engine_kind !== "open_mls") {
      return;
    }
    if (coordinatorEngineStatus.joined_group || coordinatorEngineStatus.group_ready) {
      updateStartupDiagnostics({
        mlsJoinResolvedAt: startupDiagnosticsRef.current.mlsJoinResolvedAt ?? new Date().toISOString(),
        mlsJoinLastResult: "joined",
        startupJoinFailureBucket: null,
      });
      return;
    }

    if (coordinatorRuntimeReadiness?.phase !== "mls_join_pending") {
      updateStartupDiagnostics({
        startupJoinFailureBucket: null,
      });
      return;
    }

    const current = startupDiagnosticsRef.current;
    let bucket: CoordinatorStartupDiagnostics["startupJoinFailureBucket"] = null;

    if (isLeadCoordinator) {
      if (
        current.mlsWelcomePublishAttemptCount > 0
        && current.mlsWelcomePublishSuccessCount === 0
      ) {
        bucket = "publish_failure";
      } else if (
        current.mlsWelcomePublishSuccessCount > 0
        && current.controlCarrierSubscriptionObservedCount === 0
        && current.controlCarrierFetchLastCount === 0
      ) {
        bucket = "observation_failure";
      } else if (
        current.mlsWelcomePublishSuccessCount > 0
        && (current.controlCarrierSubscriptionObservedCount > 0 || current.controlCarrierFetchLastCount > 0)
      ) {
        bucket = "state_transition_failure";
      }
    } else if (
      current.mlsJoinPackagePublishAttemptCount > 0
      && current.mlsJoinPackagePublishSuccessCount === 0
    ) {
      bucket = "publish_failure";
    } else if (
      current.mlsWelcomeObservedCount === 0
      && current.mlsJoinAttemptCount === 0
    ) {
      bucket = "observation_failure";
    } else if (
      current.mlsWelcomeObservedCount > 0
      || current.mlsJoinAttemptCount > 0
    ) {
      bucket = "state_transition_failure";
    }

    if (!bucket) {
      if (
        current.controlCarrierFetchAttemptCount > 0
        && current.controlCarrierFetchLastCount === 0
        && current.controlCarrierSubscriptionObservedCount === 0
      ) {
        bucket = "observation_failure";
      } else if (
        current.mlsJoinAttemptCount > 0
        || current.controlCarrierFetchLastCount > 0
        || current.controlCarrierSubscriptionObservedCount > 0
      ) {
        bucket = "state_transition_failure";
      } else {
        bucket = "publish_failure";
      }
    }

    updateStartupDiagnostics({
      startupJoinFailureBucket: bucket,
    });
  }, [coordinatorEngineStatus, coordinatorRuntimeReadiness?.phase, isLeadCoordinator, singleCoordinatorMode]);

  useEffect(() => {
    const current = blindKeyDiagnosticsRef.current;
    let blindKeyFailureClass: BlindKeyDiagnostics["blindKeyFailureClass"] = null;
    if (coordinatorRuntimeReadiness?.phase === "blind_key_publish_pending") {
      if (!current.blindKeyPublishAttempted) {
        blindKeyFailureClass = "blind_key_not_attempted";
      } else if (!current.blindKeyPublishSucceeded) {
        blindKeyFailureClass = "blind_key_publish_unconfirmed";
      } else if (!current.blindKeyObservedBackLocally) {
        blindKeyFailureClass = "blind_key_published_not_observed";
      } else {
        blindKeyFailureClass = "blind_key_published_and_observed_but_not_applied";
      }
    }
    updateBlindKeyDiagnostics({
      blindKeyFailureClass,
    });
  }, [coordinatorRuntimeReadiness?.phase, activeBlindKeyAnnouncement?.event.id]);

  useEffect(() => {
    if (singleCoordinatorMode) {
      startupForcedRecoveryAttemptedRef.current = false;
      startupForcedRecoveryInFlightRef.current = false;
      return;
    }
    if (
      !coordinatorRuntimeReadiness
      || coordinatorRuntimeReadiness.phase !== "mls_join_pending"
      || !coordinatorEngineStatus
      || coordinatorEngineStatus.engine_kind !== "open_mls"
      || coordinatorEngineStatus.group_ready
      || coordinatorEngineStatus.joined_group
    ) {
      startupForcedRecoveryAttemptedRef.current = false;
      startupForcedRecoveryInFlightRef.current = false;
      return;
    }
    if (startupForcedRecoveryAttemptedRef.current || startupForcedRecoveryInFlightRef.current) {
      return;
    }
    const pendingSince = startupJoinPendingSinceRef.current;
    if (!pendingSince || Date.now() - pendingSince < SIMPLE_COORDINATOR_STARTUP_FORCED_RECOVERY_DELAY_MS) {
      return;
    }

    const service = coordinatorControlServiceRef.current;
    if (!service) {
      return;
    }

    startupForcedRecoveryAttemptedRef.current = true;
    startupForcedRecoveryInFlightRef.current = true;

    void (async () => {
      const startupReadRelays = normalizeRelaysRust([...SIMPLE_PUBLIC_RELAYS]).slice(0, 3);
      const since = Math.floor(pendingSince / 1000);
      updateStartupDiagnostics((current) => {
        const next = {
          ...current,
          startupForcedRecoveryAttemptCount: current.startupForcedRecoveryAttemptCount + 1,
          startupForcedRecoveryLastAttemptAt: new Date().toISOString(),
          startupForcedRecoveryLastOutcome: "pending",
          startupBackfillFilter: {
            mode: "kind_election_group",
            relays: startupReadRelays,
            kinds: [SIMPLE_COORDINATOR_CONTROL_KIND],
            tags: ["election", "group"],
            since,
            until: null,
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            startedAt: new Date().toISOString(),
          },
          startupReadBackfillRelays: startupReadRelays,
        } as CoordinatorStartupDiagnostics;
        return {
          ...next,
          ...reconcileStartupRelayDiagnostics(next),
        };
      });
      try {
        updateStartupDiagnostics((current) => ({
          controlCarrierFetchAttemptCount: current.controlCarrierFetchAttemptCount + 1,
          controlCarrierFetchLastAt: new Date().toISOString(),
          controlCarrierFetchLastError: null,
        }));

        const precise = await fetchCoordinatorControlEvents({
          electionId: coordinatorElectionId,
          coordinatorHexPubkeys: coordinatorHexRoster,
          mode: "kind_election_group",
          limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
          since,
        });
        let events = precise;
        let kindOnlyCount = 0;
        let kindElectionCount = 0;
        let kindElectionGroupCount = precise.length;
        if (events.length === 0) {
          const kindOnly = await fetchCoordinatorControlEvents({
            electionId: coordinatorElectionId,
            coordinatorHexPubkeys: coordinatorHexRoster,
            mode: "kind_only",
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            since,
          });
          const kindElection = await fetchCoordinatorControlEvents({
            electionId: coordinatorElectionId,
            coordinatorHexPubkeys: coordinatorHexRoster,
            mode: "kind_election",
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            since,
          });
          const kindElectionGroup = await fetchCoordinatorControlEvents({
            electionId: coordinatorElectionId,
            coordinatorHexPubkeys: coordinatorHexRoster,
            mode: "kind_election_group",
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            since,
          });
          kindOnlyCount = kindOnly.length;
          kindElectionCount = kindElection.length;
          kindElectionGroupCount = kindElectionGroup.length;
          events = kindElectionGroup.length > 0
            ? kindElectionGroup
            : kindElection.length > 0
              ? kindElection
              : kindOnly;
        }

        updateStartupDiagnostics((current) => {
          const next = {
            ...current,
            controlCarrierFetchLastCount: events.length,
            controlCarrierFetchLastError: null,
            startupProbeKindOnlyCount: kindOnlyCount,
            startupProbeKindElectionCount: kindElectionCount,
            startupProbeKindElectionGroupCount: kindElectionGroupCount,
            startupProbeFilteredCount: kindElectionGroupCount,
            startupObservedBackfill: current.startupObservedBackfill || events.length > 0,
          } satisfies CoordinatorStartupDiagnostics;
          return {
            ...next,
            ...reconcileStartupRelayDiagnostics(next),
          };
        });

        if (events.length > 0) {
          service.ingestCoordinatorEvents(events);
          updateStartupDiagnostics((current) => ({
            controlCarrierSubscriptionObservedCount: current.controlCarrierSubscriptionObservedCount + events.length,
            controlCarrierSubscriptionLastObservedAt: new Date().toISOString(),
            controlCarrierLastObservedEventId: events[events.length - 1]?.id ?? current.controlCarrierLastObservedEventId,
            controlCarrierLastObservedSource: "periodic_backfill",
            startupObservedBackfill: true,
          }));
        }

        setCoordinatorControlCache(service.snapshot());
        setCoordinatorControlView(service.getState());
        setCoordinatorControlStateLabel(
          formatCoordinatorControlStateLabel(service.getState(), service.getEngineStatus()),
        );
        updateStartupDiagnostics({
          startupForcedRecoveryLastOutcome: service.getEngineStatus().group_ready ? "recovered" : "not_recovered",
        });
      } catch (error) {
        updateStartupDiagnostics({
          controlCarrierFetchLastCount: 0,
          controlCarrierFetchLastError: error instanceof Error ? error.message : String(error),
          startupForcedRecoveryLastOutcome: "not_recovered",
        });
      } finally {
        startupForcedRecoveryInFlightRef.current = false;
      }
    })();
  }, [
    coordinatorElectionId,
    coordinatorEngineStatus,
    coordinatorHexRoster,
    coordinatorRuntimeReadiness,
    singleCoordinatorMode,
  ]);

  useEffect(() => {
    let cancelled = false;
    const hydrationEpoch = identityHydrationEpochRef.current;

    void loadSimpleActorState("coordinator").then((storedState) => {
      if (cancelled || hydrationEpoch !== identityHydrationEpochRef.current) {
        return;
      }

      if (storedState?.keypair) {
        setKeypair(storedState.keypair);
        const cache = (storedState.cache ?? null) as Partial<SimpleCoordinatorCache> | null;
        if (cache) {
          const fallbackCoordinatorNpubs = sortCoordinatorRoster(
            Array.isArray(cache.subCoordinators)
              ? cache.subCoordinators.flatMap((application) => (
                application && typeof application.coordinatorNpub === "string"
                  ? [application.coordinatorNpub]
                  : []
              ))
              : [],
          );
          setLeadCoordinatorNpub(typeof cache.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
          setNip65Enabled(cache?.nip65Enabled === true);
          setFollowers(Array.isArray(cache.followers) ? cache.followers : []);
          setSubCoordinators(Array.isArray(cache.subCoordinators) ? cache.subCoordinators : []);
          setTicketDeliveries(cache.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {});
          setAutoSendFollowers(
            cache.autoSendFollowers && typeof cache.autoSendFollowers === "object"
              ? cache.autoSendFollowers
              : {},
          );
          setPendingRequests(Array.isArray(cache.pendingRequests) ? cache.pendingRequests : []);
          setRegistrationStatus(typeof cache.registrationStatus === "string" ? cache.registrationStatus : null);
          setAssignmentStatus(typeof cache.assignmentStatus === "string" ? cache.assignmentStatus : null);
          setQuestionPrompt(typeof cache.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
          setQuestionThresholdT(typeof cache.questionThresholdT === "string" ? cache.questionThresholdT : "1");
          setQuestionThresholdN(typeof cache.questionThresholdN === "string" ? cache.questionThresholdN : "1");
          setQuestionShareIndex(typeof cache.questionShareIndex === "string" ? cache.questionShareIndex : "1");
          setRoundBlindPrivateKeys(
            cache.roundBlindPrivateKeys && typeof cache.roundBlindPrivateKeys === "object"
              ? cache.roundBlindPrivateKeys as Record<string, SimpleBlindPrivateKey>
              : {},
          );
          setRoundBlindKeyAnnouncements(
            cache.roundBlindKeyAnnouncements && typeof cache.roundBlindKeyAnnouncements === "object"
              ? cache.roundBlindKeyAnnouncements as Record<string, SimpleBlindKeyAnnouncement>
              : {},
          );
          setPublishStatus(typeof cache.publishStatus === "string" ? cache.publishStatus : null);
          setCoordinatorControlCache(
            cache.coordinatorControlCache && typeof cache.coordinatorControlCache === "object"
              ? cache.coordinatorControlCache as CoordinatorControlCache
              : null,
          );
          setProtocolStateCache(
            cache.protocolStateCache && typeof cache.protocolStateCache === "object"
              ? cache.protocolStateCache as ProtocolStateCache
              : null,
          );
          setPublishedVotes(
            Array.isArray(cache.publishedVotes)
              ? cache.publishedVotes
                .map((vote) => normalizeLiveVoteSession(vote, fallbackCoordinatorNpubs))
                .filter((vote): vote is SimpleLiveVoteSession => vote !== null)
              : [],
          );
          setSelectedVotingId(typeof cache.selectedVotingId === "string" ? cache.selectedVotingId : "");
          setSelectedSubmittedVotingId(
            typeof cache.selectedSubmittedVotingId === 'string'
              ? cache.selectedSubmittedVotingId
              : '',
          );
          setSubmittedVotes(Array.isArray(cache.submittedVotes) ? cache.submittedVotes : []);
        }
        setStorageLocked(false);
        setIdentityReady(true);
        return;
      }

      const nextKeypair = createSimpleCoordinatorKeypair();
      void saveSimpleActorState({
        role: "coordinator",
        keypair: nextKeypair,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      setKeypair(nextKeypair);
      setStorageLocked(false);
      setIdentityReady(true);
    }).catch(async (error) => {
      if (cancelled || hydrationEpoch !== identityHydrationEpochRef.current) {
        return;
      }

      if (error instanceof SimpleActorStateLockedError || await isSimpleActorStateLocked("coordinator")) {
        setStorageLocked(true);
        setStorageStatus("Local coordinator state is locked.");
        return;
      }

      const nextKeypair = createSimpleCoordinatorKeypair();
      setKeypair(nextKeypair);
      setStorageLocked(false);
      setIdentityReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setNip65EnabledForSession(nip65Enabled);
  }, [nip65Enabled]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 15000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!identityReady || !keypair) {
      return;
    }

    const cache: SimpleCoordinatorCache = {
      leadCoordinatorNpub,
      nip65Enabled,
      followers,
      subCoordinators,
      ticketDeliveries,
      autoSendFollowers,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      roundBlindPrivateKeys,
      roundBlindKeyAnnouncements,
      publishStatus,
      coordinatorControlCache,
      protocolStateCache,
      publishedVotes,
      selectedVotingId,
      selectedSubmittedVotingId,
      submittedVotes,
    };

    const cacheSignature = JSON.stringify({
      leadCoordinatorNpub,
      nip65Enabled,
      followers,
      subCoordinators,
      ticketDeliveries,
      autoSendFollowers,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      roundBlindPrivateKeys,
      roundBlindKeyAnnouncements,
      publishStatus,
      coordinatorControlCache,
      protocolStateCache,
      publishedVotes,
      selectedVotingId,
      selectedSubmittedVotingId,
      submittedVotes,
    });
    if (cacheSignature === lastSavedStateSignatureRef.current) {
      return;
    }
    if (saveStateDebounceTimerRef.current !== null) {
      window.clearTimeout(saveStateDebounceTimerRef.current);
      saveStateDebounceTimerRef.current = null;
    }
    saveStateDebounceTimerRef.current = window.setTimeout(() => {
      saveStateDebounceTimerRef.current = null;
      lastSavedStateSignatureRef.current = cacheSignature;
      void saveSimpleActorState({
        role: 'coordinator',
        keypair,
        updatedAt: new Date().toISOString(),
        cache,
      }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    }, 800);
    return () => {
      if (saveStateDebounceTimerRef.current !== null) {
        window.clearTimeout(saveStateDebounceTimerRef.current);
        saveStateDebounceTimerRef.current = null;
      }
    };
  }, [
    assignmentStatus,
    autoSendFollowers,
    coordinatorControlCache,
    protocolStateCache,
    followers,
    identityReady,
    keypair,
    leadCoordinatorNpub,
    nip65Enabled,
    pendingRequests,
    publishStatus,
    publishedVotes,
    roundBlindKeyAnnouncements,
    roundBlindPrivateKeys,
    questionPrompt,
    questionShareIndex,
    questionThresholdN,
    questionThresholdT,
    registrationStatus,
    selectedSubmittedVotingId,
    selectedVotingId,
    storagePassphrase,
    subCoordinators,
    submittedVotes,
    ticketDeliveries,
  ]);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    let backfillHandle: number | null = null;
    let backfillInFlight = false;

    async function setupCoordinatorControl() {
      if (!identityReady || !keypair?.npub || !keypair.nsec || !coordinatorElectionId || !localCoordinatorHexPubkey) {
        coordinatorControlServiceRef.current = null;
        singleCoordinatorBootstrapAttemptRef.current = "";
        startupDiagnosticsRef.current = createCoordinatorStartupDiagnostics();
        blindKeyDiagnosticsRef.current = createBlindKeyDiagnostics();
        setCoordinatorControlView(null);
        setCoordinatorControlStateLabel(null);
        setInitialControlBackfillComplete(false);
        setAutoApprovalComplete(false);
        setWelcomeAckSent(false);
        return;
      }

      startupDiagnosticsRef.current = createCoordinatorStartupDiagnostics();
      blindKeyDiagnosticsRef.current = createBlindKeyDiagnostics();
      singleCoordinatorBootstrapAttemptRef.current = "";
      startupForcedRecoveryAttemptedRef.current = false;
      startupForcedRecoveryInFlightRef.current = false;
      startupJoinPendingSinceRef.current = null;
      setInitialControlBackfillComplete(false);
      setAutoApprovalComplete(false);
      setWelcomeAckSent(false);

      const service = await CoordinatorControlService.create({
        electionId: coordinatorElectionId,
        localPubkey: localCoordinatorHexPubkey,
        roster: coordinatorHexRoster,
        leadPubkey: isLeadCoordinator ? localCoordinatorHexPubkey : leadCoordinatorHexPubkey || null,
        engineKind: coordinatorRuntimeEngineKind,
        snapshot: coordinatorControlCache?.snapshot ?? null,
        onPublished: recordStartupPublishDiagnostic,
      });

      if (cancelled) {
        return;
      }

      coordinatorControlServiceRef.current = service;

      const syncState = () => {
        const nextCache = service.snapshot();
        const nextView = service.getState();
        const nextStatus = service.getEngineStatus();
        setCoordinatorControlCache(nextCache);
        setCoordinatorControlView(nextView);
        setCoordinatorControlStateLabel(formatCoordinatorControlStateLabel(nextView, nextStatus));
      };

      const syncStateWithReplayWarning = () => {
        syncState();
        setCoordinatorControlStateLabel("Waiting for coordinator-control replay.");
      };

      if (singleCoordinatorMode) {
        syncState();
        updateStartupDiagnostics({
          startupJoinFailureBucket: null,
          startupPublishAttempted: false,
          startupPublishSucceeded: false,
          startupObservedLive: true,
          startupObservedBackfill: false,
          controlCarrierFetchAttemptCount: 0,
          controlCarrierFetchLastCount: 0,
          startupProbeKindOnlyCount: 0,
          startupProbeFilteredCount: 0,
          startupProbeKindElectionCount: 0,
          startupProbeKindElectionGroupCount: 0,
        });
        setInitialControlBackfillComplete(true);
        setAutoApprovalComplete(true);
        return;
      }

      const startupReadRelays = normalizeRelaysRust([...SIMPLE_PUBLIC_RELAYS]).slice(0, 3);
      const startupReadKinds = [SIMPLE_COORDINATOR_CONTROL_KIND];
      const startupSinceSeconds = Math.floor(Date.now() / 1000) - 900;

      const recordStartupReadFilter = (
        target: "startupLiveFilter" | "startupBackfillFilter",
        mode: CoordinatorControlReadMode,
        options?: { since?: number },
      ) => {
        updateStartupDiagnostics((current) => {
          const next = {
            ...current,
            [target]: {
              mode,
              relays: startupReadRelays,
              kinds: startupReadKinds,
              tags: mode === "kind_only" ? [] : ["election", ...(mode === "kind_election_group" ? ["group"] : [])],
              since: options?.since ?? null,
              until: null,
              limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
              startedAt: new Date().toISOString(),
            },
            startupReadLiveRelays: target === "startupLiveFilter"
              ? startupReadRelays
              : current.startupReadLiveRelays,
            startupReadBackfillRelays: target === "startupBackfillFilter"
              ? startupReadRelays
              : current.startupReadBackfillRelays,
          } as CoordinatorStartupDiagnostics;
          return {
            ...next,
            ...reconcileStartupRelayDiagnostics(next),
          };
        });
      };

      const runStartupBackfill = async (options?: {
        since?: number;
        runDiagnosticFallback?: boolean;
      }) => {
        recordStartupReadFilter("startupBackfillFilter", "kind_election_group", {
          since: options?.since,
        });
        const preciseEvents = await fetchCoordinatorControlEvents({
          electionId: coordinatorElectionId,
          coordinatorHexPubkeys: coordinatorHexRoster,
          mode: "kind_election_group",
          limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
          since: options?.since,
        });
        let selectedEvents = preciseEvents;
        let kindOnlyCount = 0;
        let kindElectionCount = 0;
        let kindElectionGroupCount = preciseEvents.length;
        if (preciseEvents.length === 0 || options?.runDiagnosticFallback) {
          const kindOnlyEvents = await fetchCoordinatorControlEvents({
            electionId: coordinatorElectionId,
            coordinatorHexPubkeys: coordinatorHexRoster,
            mode: "kind_only",
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            since: options?.since,
          });
          const kindElectionEvents = await fetchCoordinatorControlEvents({
            electionId: coordinatorElectionId,
            coordinatorHexPubkeys: coordinatorHexRoster,
            mode: "kind_election",
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            since: options?.since,
          });
          const kindElectionGroupEvents = await fetchCoordinatorControlEvents({
            electionId: coordinatorElectionId,
            coordinatorHexPubkeys: coordinatorHexRoster,
            mode: "kind_election_group",
            limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
            since: options?.since,
          });
          kindOnlyCount = kindOnlyEvents.length;
          kindElectionCount = kindElectionEvents.length;
          kindElectionGroupCount = kindElectionGroupEvents.length;
          if (selectedEvents.length === 0) {
            selectedEvents = kindElectionGroupEvents.length > 0
              ? kindElectionGroupEvents
              : kindElectionEvents.length > 0
                ? kindElectionEvents
                : kindOnlyEvents;
          }
        }
        updateStartupDiagnostics({
          startupProbeKindOnlyCount: kindOnlyCount,
          startupProbeKindElectionCount: kindElectionCount,
          startupProbeKindElectionGroupCount: kindElectionGroupCount,
          startupProbeFilteredCount: kindElectionGroupCount,
        });
        return selectedEvents;
      };

      syncState();

      let initialEvents: Awaited<ReturnType<typeof fetchCoordinatorControlEvents>> = [];
      updateStartupDiagnostics((current) => ({
        controlCarrierFetchAttemptCount: current.controlCarrierFetchAttemptCount + 1,
        controlCarrierFetchLastAt: new Date().toISOString(),
        controlCarrierFetchLastError: null,
      }));
      try {
        initialEvents = await runStartupBackfill({
          since: startupSinceSeconds,
          runDiagnosticFallback: true,
        });
        updateStartupDiagnostics((current) => {
          const next = {
            ...current,
            controlCarrierFetchLastCount: initialEvents.length,
            controlCarrierFetchLastError: null,
            startupObservedBackfill: current.startupObservedBackfill || initialEvents.length > 0,
          } satisfies CoordinatorStartupDiagnostics;
          return {
            ...next,
            ...reconcileStartupRelayDiagnostics(next),
          };
        });
      } catch (error) {
        updateStartupDiagnostics({
          controlCarrierFetchLastCount: 0,
          controlCarrierFetchLastError: error instanceof Error ? error.message : String(error),
        });
      }

      if (cancelled) {
        return;
      }

      if (initialEvents.length > 0) {
        try {
          service.ingestCoordinatorEvents(initialEvents);
          syncState();
          updateStartupDiagnostics((current) => ({
            controlCarrierSubscriptionObservedCount: current.controlCarrierSubscriptionObservedCount + initialEvents.length,
            controlCarrierSubscriptionLastObservedAt: new Date().toISOString(),
            controlCarrierLastObservedEventId: initialEvents[initialEvents.length - 1]?.id ?? current.controlCarrierLastObservedEventId,
            controlCarrierLastObservedSource: "initial_backfill",
            startupObservedBackfill: true,
          }));
        } catch {
          syncStateWithReplayWarning();
        }
      }
      setInitialControlBackfillComplete(true);

      const maybeApprove = async () => {
        try {
          const approval = await service.maybeAutoApproveRoundOpen({
            coordinatorNsec: keypair.nsec,
          });
          if (approval) {
            syncState();
            setPublishStatus("Coordinator round-open approval sent.");
          }
        } catch {
          setPublishStatus("Coordinator round-open approval failed.");
        } finally {
          setAutoApprovalComplete(true);
        }
      };

      const backfillEvents = async () => {
        if (cancelled || backfillInFlight) {
          return;
        }

        backfillInFlight = true;

        try {
          updateStartupDiagnostics((current) => ({
            controlCarrierFetchAttemptCount: current.controlCarrierFetchAttemptCount + 1,
            controlCarrierFetchLastAt: new Date().toISOString(),
            controlCarrierFetchLastError: null,
          }));
          const events = await runStartupBackfill({
            since: startupDiagnosticsRef.current.startupPublishEventCreatedAt ?? startupSinceSeconds,
            runDiagnosticFallback: true,
          });
          updateStartupDiagnostics((current) => {
            const next = {
              ...current,
              controlCarrierFetchLastCount: events.length,
              controlCarrierFetchLastError: null,
              startupObservedBackfill: current.startupObservedBackfill || events.length > 0,
            } satisfies CoordinatorStartupDiagnostics;
            return {
              ...next,
              ...reconcileStartupRelayDiagnostics(next),
            };
          });

          if (cancelled || !coordinatorControlServiceRef.current) {
            return;
          }

          if (events.length > 0) {
            try {
              coordinatorControlServiceRef.current.ingestCoordinatorEvents(events);
              syncState();
              updateStartupDiagnostics((current) => ({
                controlCarrierSubscriptionObservedCount: current.controlCarrierSubscriptionObservedCount + events.length,
                controlCarrierSubscriptionLastObservedAt: new Date().toISOString(),
                controlCarrierLastObservedEventId: events[events.length - 1]?.id ?? current.controlCarrierLastObservedEventId,
                controlCarrierLastObservedSource: "periodic_backfill",
                startupObservedBackfill: true,
              }));
            } catch {
              syncStateWithReplayWarning();
            }
          }

          await maybeApprove();
        } catch (error) {
          updateStartupDiagnostics({
            controlCarrierFetchLastCount: 0,
            controlCarrierFetchLastError: error instanceof Error ? error.message : String(error),
          });
        } finally {
          backfillInFlight = false;
        }
      };

      await maybeApprove();
      backfillHandle = window.setInterval(() => {
        void backfillEvents();
      }, SIMPLE_COORDINATOR_CONTROL_BACKFILL_INTERVAL_MS);

      recordStartupReadFilter("startupLiveFilter", "kind_election_group", {
        since: startupSinceSeconds,
      });
      const unsubscribe = subscribeCoordinatorControl({
        electionId: coordinatorElectionId,
        coordinatorHexPubkeys: coordinatorHexRoster,
        mode: "kind_election_group",
        since: startupSinceSeconds,
        onEvents: (events) => {
          if (!coordinatorControlServiceRef.current) {
            return;
          }

          if (events.length > 0) {
            updateStartupDiagnostics((current) => {
              const next = {
                ...current,
                controlCarrierSubscriptionObservedCount: current.controlCarrierSubscriptionObservedCount + events.length,
                controlCarrierSubscriptionLastObservedAt: new Date().toISOString(),
                controlCarrierLastObservedEventId: events[events.length - 1]?.id ?? current.controlCarrierLastObservedEventId,
                controlCarrierLastObservedSource: "subscription",
                startupObservedLive: true,
              } satisfies CoordinatorStartupDiagnostics;
              return {
                ...next,
                ...reconcileStartupRelayDiagnostics(next),
              };
            });
          }

          try {
            coordinatorControlServiceRef.current.ingestCoordinatorEvents(events);
            syncState();
          } catch {
            syncStateWithReplayWarning();
          }
          void maybeApprove();
        },
      });

      cleanup = () => {
        unsubscribe();
        if (backfillHandle !== null) {
          window.clearInterval(backfillHandle);
          backfillHandle = null;
        }
      };
    }

    void setupCoordinatorControl();

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [
    coordinatorElectionId,
    coordinatorHexRosterSignature,
    coordinatorRuntimeEngineKind,
    identityReady,
    isLeadCoordinator,
    leadCoordinatorHexPubkey,
    localCoordinatorHexPubkey,
    singleCoordinatorMode,
    keypair?.npub,
    keypair?.nsec,
  ]);

  useEffect(() => {
    if (isLeadCoordinator || !keypair?.nsec) {
      return;
    }

    return subscribeSimpleCoordinatorMlsWelcomes({
      coordinatorNsec: keypair.nsec,
      onWelcomes: (welcomes) => {
        const service = coordinatorControlServiceRef.current;
        if (!service || service.getEngineStatus().engine_kind !== "open_mls") {
          return;
        }

        for (const welcome of welcomes) {
          if (
            welcome.electionId !== coordinatorElectionId
            || welcome.leadCoordinatorNpub !== leadCoordinatorNpub.trim()
            || seenMlsWelcomeIdsRef.current.has(welcome.id)
          ) {
            continue;
          }

          seenMlsWelcomeIdsRef.current.add(welcome.id);
          updateStartupDiagnostics((current) => ({
            mlsWelcomeObservedCount: current.mlsWelcomeObservedCount + 1,
            mlsWelcomeLastObservedAt: new Date().toISOString(),
          }));
          try {
            updateStartupDiagnostics((current) => ({
              mlsJoinAttemptCount: current.mlsJoinAttemptCount + 1,
              mlsJoinLastAttemptAt: new Date().toISOString(),
            }));
            const joined = service.joinSupervisoryGroup(welcome.welcomeBundle);
            if (joined) {
              updateStartupDiagnostics({
                mlsJoinLastResult: "joined",
                mlsJoinResolvedAt: startupDiagnosticsRef.current.mlsJoinResolvedAt ?? new Date().toISOString(),
              });
              setCoordinatorControlCache(service.snapshot());
              setCoordinatorControlView(service.getState());
              setCoordinatorControlStateLabel(
                formatCoordinatorControlStateLabel(service.getState(), service.getEngineStatus()),
              );
              setRegistrationStatus("Coordinator MLS join completed.");

              void (async () => {
                try {
                  updateStartupDiagnostics((current) => ({
                    controlCarrierFetchAttemptCount: current.controlCarrierFetchAttemptCount + 1,
                    controlCarrierFetchLastAt: new Date().toISOString(),
                    controlCarrierFetchLastError: null,
                  }));
                  const startupReadRelays = normalizeRelaysRust([...SIMPLE_PUBLIC_RELAYS]).slice(0, 3);
                  updateStartupDiagnostics((current) => {
                    const next = {
                      ...current,
                      startupBackfillFilter: {
                        mode: "kind_election_group",
                        relays: startupReadRelays,
                        kinds: [SIMPLE_COORDINATOR_CONTROL_KIND],
                        tags: ["election", "group"],
                        since: startupDiagnosticsRef.current.startupPublishEventCreatedAt ?? Math.floor(Date.now() / 1000) - 900,
                        until: null,
                        limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
                        startedAt: new Date().toISOString(),
                      },
                      startupReadBackfillRelays: startupReadRelays,
                    } as CoordinatorStartupDiagnostics;
                    return {
                      ...next,
                      ...reconcileStartupRelayDiagnostics(next),
                    };
                  });
                  const events = await fetchCoordinatorControlEvents({
                    electionId: coordinatorElectionId,
                    coordinatorHexPubkeys: coordinatorHexRoster,
                    mode: "kind_election_group",
                    limit: SIMPLE_COORDINATOR_STARTUP_BACKFILL_LIMIT,
                    since: startupDiagnosticsRef.current.startupPublishEventCreatedAt
                      ?? Math.floor(Date.now() / 1000) - 900,
                  });
                  updateStartupDiagnostics((current) => {
                    const next = {
                      ...current,
                      controlCarrierFetchLastCount: events.length,
                      controlCarrierFetchLastError: null,
                      startupObservedBackfill: current.startupObservedBackfill || events.length > 0,
                    } satisfies CoordinatorStartupDiagnostics;
                    return {
                      ...next,
                      ...reconcileStartupRelayDiagnostics(next),
                    };
                  });
                  if (events.length > 0) {
                    service.ingestCoordinatorEvents(events);
                    updateStartupDiagnostics((current) => {
                      const next = {
                        ...current,
                        controlCarrierSubscriptionObservedCount: current.controlCarrierSubscriptionObservedCount + events.length,
                        controlCarrierSubscriptionLastObservedAt: new Date().toISOString(),
                        controlCarrierLastObservedEventId: events[events.length - 1]?.id ?? current.controlCarrierLastObservedEventId,
                        controlCarrierLastObservedSource: "post_join_backfill",
                        startupObservedBackfill: true,
                      } satisfies CoordinatorStartupDiagnostics;
                      return {
                        ...next,
                        ...reconcileStartupRelayDiagnostics(next),
                      };
                    });
                  }
                  const approval = await service.maybeAutoApproveRoundOpen({
                    coordinatorNsec: keypair.nsec,
                  });
                  setCoordinatorControlCache(service.snapshot());
                  setCoordinatorControlView(service.getState());
                  setCoordinatorControlStateLabel(
                    formatCoordinatorControlStateLabel(service.getState(), service.getEngineStatus()),
                  );
                  if (approval) {
                    setPublishStatus("Coordinator round-open approval sent.");
                  }

                  const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
                  const coordinatorNpub = keypair?.npub ?? "";
                  if (
                    coordinatorSecretKey
                    && coordinatorNpub
                    && !sentMlsWelcomeAckIdsRef.current.has(welcome.dmEventId)
                  ) {
                    sentMlsWelcomeAckIdsRef.current.add(welcome.dmEventId);
                    try {
                      await sendSimpleDmAcknowledgement({
                        senderSecretKey: coordinatorSecretKey,
                        recipientNpub: welcome.leadCoordinatorNpub,
                        actorNpub: coordinatorNpub,
                        ackedAction: "simple_mls_welcome",
                        ackedEventId: welcome.dmEventId,
                      });
                      setWelcomeAckSent(true);
                    } catch {
                      sentMlsWelcomeAckIdsRef.current.delete(welcome.dmEventId);
                    }
                  }
                } catch {
                  updateStartupDiagnostics({
                    controlCarrierFetchLastCount: 0,
                    controlCarrierFetchLastError: "post_join_control_backfill_failed",
                  });
                  setCoordinatorControlStateLabel("Waiting for coordinator-control replay.");
                }
              })();
            } else {
              updateStartupDiagnostics({
                mlsJoinLastResult: "not_joined",
              });
            }
          } catch {
            updateStartupDiagnostics({
              mlsJoinLastResult: "failed",
            });
            seenMlsWelcomeIdsRef.current.delete(welcome.id);
          }
        }
      },
    });
  }, [coordinatorElectionId, isLeadCoordinator, keypair?.npub, keypair?.nsec, leadCoordinatorNpub]);

  useEffect(() => {
    if (!pendingRoundOpenAttemptRef.current || !isLeadCoordinator || roundBroadcastInFlightRef.current) {
      return;
    }

    const service = coordinatorControlServiceRef.current;
    if (!service) {
      return;
    }

    const status = service.getEngineStatus();
    if (status.engine_kind !== "open_mls") {
      return;
    }

    if (!status.group_ready || getOutstandingMlsWelcomeAckNpubs().length > 0) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (!pendingRoundOpenAttemptRef.current || roundBroadcastInFlightRef.current) {
        return;
      }

      const latestService = coordinatorControlServiceRef.current;
      if (!latestService) {
        return;
      }

      const latestStatus = latestService.getEngineStatus();
      if (latestStatus.engine_kind !== "open_mls" || !latestStatus.group_ready) {
        return;
      }

      if (getOutstandingMlsWelcomeAckNpubs().length > 0) {
        return;
      }

      pendingRoundOpenAttemptRef.current = false;
      void broadcastQuestion();
    }, SIMPLE_COORDINATOR_ROUND_OPEN_POST_WELCOME_GRACE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    dmAcknowledgements,
    isLeadCoordinator,
    questionPrompt,
    questionThresholdN,
    questionThresholdT,
    subCoordinators,
  ]);

  useEffect(() => {
    if (!isLeadCoordinator || roundBroadcastInFlightRef.current) {
      return;
    }

    const service = coordinatorControlServiceRef.current;
    const latestRound = coordinatorControlView?.latest_round ?? null;
    if (!service || !latestRound || latestRound.phase !== "open_proposed") {
      return;
    }

    if (
      !latestRound.prompt
      || latestRound.threshold_t == null
      || latestRound.threshold_n == null
      || latestRound.missing_open_committers.length === 0
    ) {
      return;
    }

    const retryKey = latestRound.round_id;
    const attemptCount = roundOpenRetryAttemptsRef.current[retryKey] ?? 0;
    if (attemptCount >= SIMPLE_COORDINATOR_ROUND_OPEN_RETRY_MAX_ATTEMPTS) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const latestService = coordinatorControlServiceRef.current;
      const currentRound = latestService?.getState().latest_round ?? null;
      if (
        !latestService
        || !currentRound
        || currentRound.round_id !== retryKey
        || currentRound.phase !== "open_proposed"
        || currentRound.missing_open_committers.length === 0
        || !currentRound.prompt
        || currentRound.threshold_t == null
        || currentRound.threshold_n == null
        || !keypair?.nsec
      ) {
        return;
      }

      roundOpenRetryAttemptsRef.current[retryKey] = attemptCount + 1;
      const localPubkey = localCoordinatorHexPubkey;
      const localCommitMissing = Boolean(
        localPubkey && currentRound.missing_open_committers.includes(localPubkey),
      );

      if (localCommitMissing) {
        setPublishStatus(
          `Retrying round-open commit (${attemptCount + 1}/${SIMPLE_COORDINATOR_ROUND_OPEN_RETRY_MAX_ATTEMPTS})...`,
        );

        void latestService.maybeAutoApproveRoundOpen({
          coordinatorNsec: keypair.nsec,
        }).then((approval) => {
          setCoordinatorControlCache(latestService.snapshot());
          setCoordinatorControlView(latestService.getState());
          setCoordinatorControlStateLabel(
            formatCoordinatorControlStateLabel(
              latestService.getState(),
              coordinatorControlServiceRef.current?.getEngineStatus() ?? null,
            ),
          );
          if (approval) {
            setPublishStatus("Coordinator round-open approval sent.");
          } else {
            setPublishStatus("Round-open commit retry had nothing to send.");
          }
        }).catch(() => {
          setPublishStatus("Round-open retry failed.");
        });
        return;
      }

      setPublishStatus(
        `Retrying round-open proposal (${attemptCount + 1}/${SIMPLE_COORDINATOR_ROUND_OPEN_RETRY_MAX_ATTEMPTS})...`,
      );

      void latestService.publishRoundOpenFlow({
        coordinatorNsec: keypair.nsec,
        roundId: currentRound.round_id,
        prompt: currentRound.prompt,
        thresholdT: currentRound.threshold_t,
        thresholdN: currentRound.threshold_n,
        roster: coordinatorHexRoster,
      }).then((result) => {
        setCoordinatorControlCache(latestService.snapshot());
        setCoordinatorControlView(result.state);
        setCoordinatorControlStateLabel(
          formatCoordinatorControlStateLabel(
            result.state,
            coordinatorControlServiceRef.current?.getEngineStatus() ?? null,
          ),
        );
        setPublishStatus(
          result.state.latest_round?.phase === "open"
            ? "Coordinator round open agreed. Broadcasting vote..."
            : "Round-open proposal resent. Waiting for coordinator approvals.",
        );
      }).catch(() => {
        setPublishStatus("Round-open retry failed.");
      });
    }, SIMPLE_COORDINATOR_ROUND_OPEN_RETRY_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    coordinatorControlView,
    coordinatorHexRoster,
    isLeadCoordinator,
    keypair?.nsec,
    localCoordinatorHexPubkey,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function replayProtocolState() {
      if (!identityReady || !keypair?.npub) {
        protocolStateServiceRef.current = null;
        setDerivedProtocolState(null);
        setDerivedPublicRounds([]);
        return;
      }

      const service = protocolStateServiceRef.current ?? await ProtocolStateService.create({
        electionId: SIMPLE_PUBLIC_ELECTION_ID,
        snapshot: protocolStateCache,
      });
      protocolStateServiceRef.current = service;

      const replay = service.replayPublicState({
        electionId: SIMPLE_PUBLIC_ELECTION_ID,
        authorPubkey: keypair.npub,
        rounds: publishedVotes,
        votes: submittedVotes,
      });
      const nextCache = service.snapshot();

      if (cancelled) {
        return;
      }

      setDerivedProtocolState(replay.derivedState);
      setDerivedPublicRounds(replay.roundSessions);
      setProtocolStateCache(nextCache);
    }

    void replayProtocolState();

    return () => {
      cancelled = true;
    };
  }, [identityReady, keypair?.npub, publishedVotes, submittedVotes]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";

    if (!coordinatorNsec) {
      setFollowers([]);
      return;
    }

    setFollowers([]);

    return subscribeSimpleCoordinatorFollowers({
      coordinatorNsec,
      onFollowers: (nextFollowers) => {
        setFollowers((current) => mergeSimpleFollowersRust(current, nextFollowers));
      },
    });
  }, [keypair?.nsec]);

  useEffect(() => {
    if (!isLeadCoordinator || !keypair?.nsec || !coordinatorControlView?.latest_round) {
      return;
    }

    const latestRound = coordinatorControlView.latest_round;
    if (latestRound.phase !== "open") {
      return;
    }

    if (!latestRound.prompt || latestRound.threshold_t == null || latestRound.threshold_n == null) {
      return;
    }

    const authorizedCoordinatorNpubs = latestRound.coordinator_roster.flatMap((pubkey) => {
      try {
        return [nip19.npubEncode(pubkey)];
      } catch {
        return [];
      }
    });

    if (publishedVotes.some((vote) => vote.votingId === latestRound.round_id)) {
      return;
    }

    if (roundBroadcastInFlightRef.current === latestRound.round_id) {
      return;
    }

    roundBroadcastInFlightRef.current = latestRound.round_id;
    setPublishStatus("Coordinator round open agreed. Broadcasting vote...");

    void publishSimpleLiveVote({
      coordinatorNsec: keypair.nsec,
      prompt: latestRound.prompt,
      votingId: latestRound.round_id,
      thresholdT: latestRound.threshold_t,
      thresholdN: latestRound.threshold_n,
      authorizedCoordinatorNpubs,
    }).then((result) => {
      setPublishedVotes((current) => {
        const nextVote = {
          votingId: result.votingId,
          prompt: latestRound.prompt ?? "",
          coordinatorNpub: result.coordinatorNpub,
          createdAt: result.createdAt,
          thresholdT: latestRound.threshold_t ?? undefined,
          thresholdN: latestRound.threshold_n ?? undefined,
          authorizedCoordinatorNpubs,
          eventId: result.eventId,
        };
        return [nextVote, ...current.filter((vote) => vote.votingId !== nextVote.votingId)];
      });
      setSelectedVotingId(result.votingId);
      setSelectedSubmittedVotingId(result.votingId);
      setPublishStatus(result.successes > 0 ? "Vote broadcast." : "Vote broadcast failed.");
      roundBroadcastInFlightRef.current = null;
    }).catch(() => {
      setPublishStatus("Vote broadcast failed.");
      roundBroadcastInFlightRef.current = null;
    });
  }, [coordinatorControlView, isLeadCoordinator, keypair?.nsec, publishedVotes]);

  useEffect(() => {
    const actorNsec = keypair?.nsec ?? "";

    if (!actorNsec) {
      setDmAcknowledgements([]);
      return;
    }

    setDmAcknowledgements([]);

    return subscribeSimpleDmAcknowledgements({
      actorNsec,
      onAcknowledgements: (nextAcknowledgements) => {
        setDmAcknowledgements(nextAcknowledgements);
      },
    });
  }, [keypair?.nsec]);

  useEffect(() => {
    const leadCoordinatorNsec = keypair?.nsec ?? "";

    if (!leadCoordinatorNsec || !isLeadCoordinator) {
      setSubCoordinators([]);
      return;
    }

    setSubCoordinators([]);

    return subscribeSimpleSubCoordinatorApplications({
      leadCoordinatorNsec,
      onApplications: (nextApplications) => {
        setSubCoordinators(nextApplications);
      },
    });
  }, [isLeadCoordinator, keypair?.nsec]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";

    if (!coordinatorNsec || isLeadCoordinator || !leadCoordinatorNpub.trim()) {
      return;
    }

    return subscribeSimpleCoordinatorShareAssignments({
      coordinatorNsec,
      onAssignments: (nextAssignments) => {
        const activeLeadCoordinatorNpub = leadCoordinatorNpub.trim();
        if (!activeLeadCoordinatorNpub) {
          return;
        }

        const latestAssignment = nextAssignments.find((assignment) => (
          assignment.leadCoordinatorNpub === activeLeadCoordinatorNpub
          && assignment.coordinatorNpub === (keypair?.npub ?? "")
        ));

        if (!latestAssignment) {
          return;
        }

        setQuestionShareIndex(String(latestAssignment.shareIndex));
        if (latestAssignment.thresholdN && latestAssignment.thresholdN > 0) {
          setQuestionThresholdN(String(latestAssignment.thresholdN));
        }
        setRegistrationStatus(null);
        setAssignmentStatus(`Assigned share index ${latestAssignment.shareIndex} by the lead coordinator.`);

        if (!latestAssignment.dmEventId || sentAssignmentAckIdsRef.current.has(latestAssignment.dmEventId)) {
          return;
        }

        const coordinatorSecretKey = decodeNsec(coordinatorNsec);

        if (!coordinatorSecretKey || !keypair?.npub) {
          return;
        }

        sentAssignmentAckIdsRef.current.add(latestAssignment.dmEventId);
        void sendSimpleDmAcknowledgement({
          senderSecretKey: coordinatorSecretKey,
          recipientNpub: latestAssignment.leadCoordinatorNpub,
          actorNpub: keypair.npub,
          ackedAction: "simple_share_assignment",
          ackedEventId: latestAssignment.dmEventId,
        }).catch(() => {
          sentAssignmentAckIdsRef.current.delete(latestAssignment.dmEventId);
        });
      },
    });
  }, [coordinatorId, isLeadCoordinator, keypair?.nsec, keypair?.npub, leadCoordinatorNpub]);

  useEffect(() => {
    const npub = activeCoordinatorNpub;

    if (!npub) {
      setCoordinatorId("pending");
      return;
    }

    setCoordinatorId(deriveActorDisplayId(npub));
  }, [activeCoordinatorNpub]);

  useEffect(() => {
    if (isLeadCoordinator) {
      setQuestionShareIndex("1");
    }
  }, [isLeadCoordinator, leadCoordinatorNpub]);

  useEffect(() => {
    if (!isLeadCoordinator) {
      return;
    }

    setQuestionThresholdN(String(availableCoordinatorCount));
  }, [availableCoordinatorCount, isLeadCoordinator]);

  useEffect(() => {
    if (!isLeadCoordinator) {
      return;
    }

    setQuestionThresholdT((current) => {
      const parsed = Number.parseInt(current, 10);
      const nextValue = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 1), maxThresholdT)
        : maxThresholdT;
      return String(nextValue);
    });
  }, [availableCoordinatorCount, isLeadCoordinator, questionThresholdN]);

  useEffect(() => {
    const coordinatorNpub = keypair?.npub ?? "";
    const activeRound = selectedPublishedVote;

    if (isCourseFeedbackMode) {
      return;
    }

    if (!coordinatorNpub || !activeRound || !activeRound.authorizedCoordinatorNpubs.includes(coordinatorNpub)) {
      return;
    }

    if (roundBlindPrivateKeys[activeRound.votingId]) {
      return;
    }

    let cancelled = false;
    void generateSimpleBlindKeyPair().then((nextBlindKey) => {
      if (!cancelled) {
        setRoundBlindPrivateKeys((current) => ({
          ...current,
          [activeRound.votingId]: nextBlindKey,
        }));
      }
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key generation failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isCourseFeedbackMode, keypair?.npub, roundBlindPrivateKeys, selectedPublishedVote]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";
    const coordinatorNpub = keypair?.npub ?? "";
    const activeRound = selectedPublishedVote;

    if (isCourseFeedbackMode) {
      return;
    }

    if (
      !coordinatorNsec
      || !coordinatorNpub
      || !activeRound
      || !activeRound.authorizedCoordinatorNpubs.includes(coordinatorNpub)
    ) {
      return;
    }

    const blindPrivateKey = roundBlindPrivateKeys[activeRound.votingId];
    if (!blindPrivateKey) {
      return;
    }

    let cancelled = false;
    void publishBlindKeyForRound({
      votingId: activeRound.votingId,
      blindPrivateKey,
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key announcement failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [isCourseFeedbackMode, keypair?.npub, keypair?.nsec, publishedVotes, roundBlindKeyAnnouncements, roundBlindPrivateKeys, selectedPublishedVote]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";
    if (!coordinatorNsec) {
      setPendingRequests([]);
      return;
    }

    if (isCourseFeedbackMode) {
      setPendingRequests([]);
      return;
    }

    setPendingRequests([]);

    return subscribeSimpleShardRequests({
      coordinatorNsec,
      onRequests: (nextRequests) => {
        setPendingRequests(nextRequests);
      },
    });
  }, [isCourseFeedbackMode, keypair?.nsec]);

  useEffect(() => {
    if (!activeBlindKeyAnnouncement) {
      return;
    }
    updateBlindKeyDiagnostics({
      blindKeyObservedBackLocally: true,
      blindKeyEventId: activeBlindKeyAnnouncement.event.id,
    });
  }, [activeBlindKeyAnnouncement]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!coordinatorSecretKey || !coordinatorNpub) {
      return;
    }

    const coordinatorRoster = isLeadCoordinator
      ? sortCoordinatorRoster([
          coordinatorNpub,
          ...subCoordinators.map((application) => application.coordinatorNpub),
        ])
      : [];

    for (const follower of followers) {
      if (!follower.dmEventId) {
        continue;
      }

      const rosterSignature = isLeadCoordinator
        ? `follow:${coordinatorRoster.join("|")}`
        : "follow";
      if (sentFollowAckStateRef.current[follower.dmEventId] === rosterSignature) {
        continue;
      }

      sentFollowAckStateRef.current[follower.dmEventId] = rosterSignature;
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: follower.voterNpub,
        actorNpub: coordinatorNpub,
        ackedAction: "simple_coordinator_follow",
        ackedEventId: follower.dmEventId,
        coordinatorNpubs: isLeadCoordinator ? coordinatorRoster : undefined,
        votingId: follower.votingId,
      }).catch(() => {
        delete sentFollowAckStateRef.current[follower.dmEventId];
      });
    }
  }, [followers, isLeadCoordinator, keypair?.nsec, keypair?.npub, subCoordinators]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!isLeadCoordinator || !coordinatorSecretKey || !coordinatorNpub || followers.length === 0) {
      return;
    }

    const coordinatorRoster = sortCoordinatorRoster([
      coordinatorNpub,
      ...subCoordinators.map((application) => application.coordinatorNpub),
    ]);
    const publishableQuestionnaireId =
      questionnaireRosterAnnouncement.questionnaireId.trim()
      && (
        questionnaireRosterAnnouncement.state === "open"
        || questionnaireRosterAnnouncement.state === "published"
      )
        ? questionnaireRosterAnnouncement.questionnaireId.trim()
        : "";
    const publishableQuestionnaireState = publishableQuestionnaireId
      ? questionnaireRosterAnnouncement.state
      : null;
    const rosterSignature = [
      coordinatorRoster.join("|"),
      publishableQuestionnaireId,
      publishableQuestionnaireState ?? "",
    ].join("|");

    for (const follower of followers) {
      if (sentRosterStateRef.current[follower.voterNpub] === rosterSignature) {
        continue;
      }

      sentRosterStateRef.current[follower.voterNpub] = rosterSignature;
      void sendSimpleCoordinatorRoster({
        leadCoordinatorSecretKey: coordinatorSecretKey,
        recipientNpub: follower.voterNpub,
        leadCoordinatorNpub: coordinatorNpub,
        coordinatorNpubs: coordinatorRoster,
        questionnaireId: publishableQuestionnaireId || undefined,
        questionnaireState: publishableQuestionnaireState ?? undefined,
      }).catch(() => {
        delete sentRosterStateRef.current[follower.voterNpub];
      });
    }
  }, [followers, isLeadCoordinator, keypair?.nsec, keypair?.npub, questionnaireRosterAnnouncement, subCoordinators]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!coordinatorSecretKey || !coordinatorNpub) {
      return;
    }

    for (const request of pendingRequests) {
      if (!request.dmEventId || sentRequestAckIdsRef.current.has(request.dmEventId)) {
        continue;
      }

      sentRequestAckIdsRef.current.add(request.dmEventId);
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: request.replyNpub,
        actorNpub: coordinatorNpub,
        ackedAction: "simple_shard_request",
        ackedEventId: request.dmEventId,
        votingId: request.votingId,
        requestId: request.blindRequest.requestId,
      }).catch(() => {
        sentRequestAckIdsRef.current.delete(request.dmEventId);
      });
    }
  }, [coordinatorId, keypair?.nsec, keypair?.npub, pendingRequests]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!isLeadCoordinator || !coordinatorSecretKey || !coordinatorNpub) {
      return;
    }

    for (const application of subCoordinators) {
      if (!application.dmEventId || sentSubCoordinatorAckIdsRef.current.has(application.dmEventId)) {
        continue;
      }

      sentSubCoordinatorAckIdsRef.current.add(application.dmEventId);
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: application.coordinatorNpub,
        actorNpub: coordinatorNpub,
        ackedAction: "simple_subcoordinator_join",
        ackedEventId: application.dmEventId,
      }).catch(() => {
        sentSubCoordinatorAckIdsRef.current.delete(application.dmEventId);
      });
    }
  }, [coordinatorId, isLeadCoordinator, keypair?.nsec, keypair?.npub, subCoordinators]);

  useEffect(() => {
    if (!liveVoteSourceNpub) {
      setPublishedVotes([]);
      return;
    }

    if (isCourseFeedbackMode) {
      setPublishedVotes([]);
      return;
    }

    setPublishedVotes([]);

    return subscribeSimpleLiveVotes({
      coordinatorNpub: liveVoteSourceNpub,
      onSessions: (nextVotes) => {
        setPublishedVotes(
          nextVotes
            .map((vote) => normalizeLiveVoteSession(vote))
            .filter((vote): vote is SimpleLiveVoteSession => vote !== null),
        );
      },
    });
  }, [isCourseFeedbackMode, liveVoteSourceNpub]);

  useEffect(() => {
    if (!visiblePublishedVotes.length) {
      setSelectedVotingId("");
      setSelectedSubmittedVotingId('');
      return;
    }

    if (!isLeadCoordinator) {
      setSelectedVotingId(visiblePublishedVotes[0].votingId);
    } else {
      setSelectedVotingId((current) =>
        visiblePublishedVotes.some((vote) => vote.votingId === current)
          ? current
          : visiblePublishedVotes[0].votingId,
      );
    }

    setSelectedSubmittedVotingId((current) =>
      visiblePublishedVotes.some((vote) => vote.votingId === current)
        ? current
        : visiblePublishedVotes[0].votingId,
    );
  }, [isLeadCoordinator, visiblePublishedVotes]);

  useEffect(() => {
    const votingId = selectedSubmittedVote?.votingId ?? '';

    if (!votingId) {
      setSubmittedVotes([]);
      return;
    }

    if (isCourseFeedbackMode) {
      setSubmittedVotes([]);
      return;
    }

    setSubmittedVotes([]);

    return subscribeSimpleSubmittedVotes({
      votingId,
      onVotes: (nextVotes) => {
        setSubmittedVotes(nextVotes);
      },
    });
  }, [isCourseFeedbackMode, selectedSubmittedVote?.votingId]);

  function refreshIdentity() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY);
    }
    setSignerNpub("");
    setSignerStatus(null);
    identityHydrationEpochRef.current += 1;
    const nextKeypair = createSimpleCoordinatorKeypair();
    void saveSimpleActorState({
      role: "coordinator",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setKeypair(nextKeypair);
    setIdentityStatus(null);
    setBackupStatus(null);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketDeliveries({});
    setAutoSendFollowers({});
    setPendingRequests([]);
    setDmAcknowledgements([]);
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setRoundBlindPrivateKeys({});
    setRoundBlindKeyAnnouncements({});
    setPublishStatus(null);
    setCoordinatorControlCache(null);
    setCoordinatorControlView(null);
    setCoordinatorControlStateLabel(null);
    setShareAssignmentsInFlight(false);
    setLastSuccessfulShareAssignmentSignature('');
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSelectedSubmittedVotingId('');
    setSubmittedVotes([]);
    setActiveTab("configure");
    sentFollowAckStateRef.current = {};
    sentRosterStateRef.current = {};
    sentRequestAckIdsRef.current.clear();
    sentSubCoordinatorAckIdsRef.current.clear();
    sentAssignmentAckIdsRef.current.clear();
    autoShareAssignmentAttemptRef.current = '';
    coordinatorControlServiceRef.current = null;
    blindKeyDiagnosticsRef.current = createBlindKeyDiagnostics();
    roundBroadcastInFlightRef.current = null;
  }

  function signOutSignerSession() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY);
    }
    setSignerNpub("");
    setSignerStatus(null);
  }

  async function loginWithSigner() {
    try {
      const signer = createSignerService();
      const rawPubkey = await signer.getPublicKey();
      const npub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY, npub);
      }
      setSignerNpub(npub);
      setSignerStatus("Signer connected.");
    } catch (error) {
      if (error instanceof SignerServiceError) {
        setSignerStatus(error.message);
        return;
      }
      setSignerStatus("Signer login failed.");
    }
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const handleLogin = () => {
      void loginWithSigner();
    };
    const handleSignOut = () => {
      signOutSignerSession();
    };
    const handleNewIdentity = () => {
      refreshIdentity();
    };
    window.addEventListener("auditable-voting:coordinator-login", handleLogin);
    window.addEventListener("auditable-voting:coordinator-signout", handleSignOut);
    window.addEventListener("auditable-voting:coordinator-new", handleNewIdentity);
    return () => {
      window.removeEventListener("auditable-voting:coordinator-login", handleLogin);
      window.removeEventListener("auditable-voting:coordinator-signout", handleSignOut);
      window.removeEventListener("auditable-voting:coordinator-new", handleNewIdentity);
    };
  }, [loginWithSigner, refreshIdentity, signOutSignerSession]);

  async function importKnownVotersFromContacts() {
    if (!optionACoordinatorRuntime) {
      setKnownVoterInviteStatus("Open or publish a questionnaire first.");
      return;
    }
    const sourceNpub = activeCoordinatorNpub.trim();
    if (!isValidNpub(sourceNpub)) {
      setKnownVoterInviteStatus("Login first so contacts can be imported.");
      return;
    }
    const sourceHex = npubsToHexRoster([sourceNpub])[0];
    if (!sourceHex) {
      setKnownVoterInviteStatus("Could not resolve coordinator public key.");
      return;
    }
    setKnownVoterContactsLoading(true);
    try {
      const relays = normalizeRelaysRust(SIMPLE_PUBLIC_RELAYS).slice(0, 6);
      const pool = getSharedNostrPool();
      const events = await pool.querySync(relays, {
        kinds: [3],
        authors: [sourceHex],
        limit: 20,
      });
      const latest = [...events]
        .sort((left, right) => right.created_at - left.created_at)
        .find((event) => event.pubkey === sourceHex);
      if (!latest) {
        setKnownVoterInviteStatus("No contacts list found for this coordinator.");
        return;
      }
      const contactEntries = (Array.isArray(latest.tags) ? latest.tags : [])
        .filter((tag) => Array.isArray(tag) && tag[0] === "p" && typeof tag[1] === "string" && tag[1].trim().length === 64)
        .map((tag) => ({
          hex: tag[1].trim(),
          petname: typeof tag[3] === "string" && tag[3].trim().length > 0 ? tag[3].trim() : null,
        }));
      const uniqueContactsByHex = new Map<string, { hex: string; petname: string | null }>();
      for (const entry of contactEntries) {
        if (!uniqueContactsByHex.has(entry.hex)) {
          uniqueContactsByHex.set(entry.hex, entry);
        }
      }
      if (uniqueContactsByHex.size === 0) {
        setKnownVoterInviteStatus("Contacts list is present, but contains no valid npubs.");
        return;
      }
      const uniqueHexContacts = [...uniqueContactsByHex.values()];
      const metadataEvents = await pool.querySync(relays, {
        kinds: [0],
        authors: uniqueHexContacts.map((entry) => entry.hex),
        limit: Math.max(50, uniqueHexContacts.length * 2),
      });
      const metadataByHex = new Map<string, { nip05: string | null; profileName: string | null }>();
      const sortedMetadataEvents = [...metadataEvents].sort((left, right) => right.created_at - left.created_at);
      for (const event of sortedMetadataEvents) {
        if (metadataByHex.has(event.pubkey)) {
          continue;
        }
        let nip05: string | null = null;
        let profileName: string | null = null;
        try {
          const profile = JSON.parse(event.content ?? "") as Record<string, unknown>;
          if (typeof profile.nip05 === "string" && profile.nip05.trim().length > 0) {
            nip05 = profile.nip05.trim();
          }
          const display = typeof profile.display_name === "string" && profile.display_name.trim().length > 0
            ? profile.display_name.trim()
            : typeof profile.name === "string" && profile.name.trim().length > 0
              ? profile.name.trim()
              : null;
          profileName = display;
        } catch {
          // ignore malformed profile metadata
        }
        metadataByHex.set(event.pubkey, { nip05, profileName });
      }
      const importedContacts = uniqueHexContacts
        .map((entry) => {
          const npub = nip19.npubEncode(entry.hex);
          if (!isValidNpub(npub)) {
            return null;
          }
          const metadata = metadataByHex.get(entry.hex);
          return {
            npub,
            nip05: metadata?.nip05 ?? null,
            profileName: metadata?.profileName ?? null,
            petname: entry.petname,
          } as ImportedKnownVoterContact;
        })
        .filter((entry): entry is ImportedKnownVoterContact => Boolean(entry))
        .sort((left, right) => {
          const leftLabel = left.profileName ?? left.petname ?? left.nip05 ?? left.npub;
          const rightLabel = right.profileName ?? right.petname ?? right.nip05 ?? right.npub;
          return leftLabel.localeCompare(rightLabel);
        });
      setImportedKnownVoterContacts(importedContacts);
      setKnownVoterContactSearch("");
      setSelectedImportedKnownVoterNpubs([]);
      const withNip05Count = importedContacts.filter((entry) => Boolean(entry.nip05)).length;
      setKnownVoterInviteStatus(
        `Imported ${importedContacts.length} contacts. ${withNip05Count} include NIP-05 metadata. Select contacts to whitelist.`,
      );
    } catch (error) {
      setKnownVoterInviteStatus(error instanceof Error ? error.message : "Could not import contacts.");
    } finally {
      setKnownVoterContactsLoading(false);
    }
  }

  function addSelectedImportedContactsToWhitelist() {
    if (!optionACoordinatorRuntime || selectedImportedKnownVoterNpubs.length === 0) {
      return;
    }
    let addedCount = 0;
    for (const npub of selectedImportedKnownVoterNpubs) {
      try {
        optionACoordinatorRuntime.addWhitelistNpub(npub);
        addedCount += 1;
      } catch {
        // Continue adding other selections.
      }
    }
    setKnownVoterInviteRefreshNonce((value) => value + 1);
    setKnownVoterInviteStatus(
      addedCount > 0
        ? `Added ${addedCount}/${selectedImportedKnownVoterNpubs.length} selected contact${selectedImportedKnownVoterNpubs.length === 1 ? "" : "s"} to known voters.`
        : "Could not add selected contacts.",
    );
  }

  function toggleImportedKnownVoterSelection(npub: string) {
    setSelectedImportedKnownVoterNpubs((current) => (
      current.includes(npub)
        ? current.filter((value) => value !== npub)
        : [...current, npub]
    ));
  }

  function toggleSelectAllVisibleImportedKnownVoters() {
    const visibleNpubs = filteredImportedKnownVoterContacts.map((entry) => entry.npub);
    if (visibleNpubs.length === 0) {
      return;
    }
    const allVisibleSelected = visibleNpubs.every((npub) => selectedImportedKnownVoterSet.has(npub));
    setSelectedImportedKnownVoterNpubs((current) => {
      if (allVisibleSelected) {
        return current.filter((npub) => !visibleNpubs.includes(npub));
      }
      const next = new Set(current);
      for (const npub of visibleNpubs) {
        next.add(npub);
      }
      return [...next];
    });
  }

  async function inviteKnownVoterNpub() {
    if (!optionACoordinatorRuntime) {
      return;
    }
    const rawValue = knownVoterDraftNpub.trim();
    if (!rawValue) {
      return;
    }
    const npub = normalizeInviteNpubInput(rawValue);
    if (!npub) {
      setKnownVoterInviteStatus("Enter a valid npub or nostr:nprofile.");
      return;
    }
    try {
      optionACoordinatorRuntime.addWhitelistNpub(npub);
      setOptimisticKnownVoterNpubs((current) => (current.includes(npub) ? current : [...current, npub]));
      setKnownVoterDraftNpub("");
      setKnownVoterInviteStatus(`Inviting ${deriveActorDisplayId(npub)}...`);
      setKnownVoterInviteRefreshNonce((value) => value + 1);
      await sendInviteToKnownVoter(npub);
    } catch (error) {
      setKnownVoterInviteStatus(error instanceof Error ? error.message : "Could not add known voter.");
    }
  }

  async function sendInviteToKnownVoter(invitedNpub: string) {
    if (!optionACoordinatorRuntime || !optionAElectionId || !activeCoordinatorNpub) {
      return;
    }
    try {
      optionACoordinatorRuntime.addWhitelistNpub(invitedNpub);
      const sent = await optionACoordinatorRuntime.sendInvite(invitedNpub, {
        title: questionPrompt.trim() || "Questionnaire",
        description: "",
        voteUrl: buildInviteUrl({
          invite: {
            type: "election_invite",
            schemaVersion: 1,
            electionId: optionAElectionId,
            title: questionPrompt.trim() || "Questionnaire",
            description: "",
            voteUrl: "",
            invitedNpub,
            coordinatorNpub: activeCoordinatorNpub,
            definition: null,
            expiresAt: null,
          },
        }),
      });
      const copied = await tryWriteClipboard(buildInviteUrl({ invite: sent.invite }));
      setOptimisticKnownVoterNpubs((current) => (current.includes(invitedNpub) ? current : [...current, invitedNpub]));
      setKnownVoterInviteStatus(
        sent.dmDelivered
          ? `Invite DM sent to ${deriveActorDisplayId(invitedNpub)}.${copied ? " Link copied." : ""}`
          : `Invite saved locally for ${deriveActorDisplayId(invitedNpub)}; DM delivery failed (${sent.dmFailureReason ?? "unknown error"}). ${copied ? "Link copied." : "Browser blocked clipboard copy."}`,
      );
      setAutoSendFollowers((current) => ({
        ...current,
        [invitedNpub]: true,
      }));
      setKnownVoterInviteRefreshNonce((value) => value + 1);
    } catch (error) {
      setKnownVoterInviteStatus(error instanceof Error ? error.message : "Invite failed.");
    }
  }

  async function sendInvitesToAllWhitelistedVoters() {
    if (!optionACoordinatorRuntime || !optionAElectionId || !activeCoordinatorNpub) {
      return;
    }
    const targets = visibleOptionAKnownVoters
      .map((entry) => entry.invitedNpub)
      .filter((npub, index, values) => values.indexOf(npub) === index);
    if (targets.length === 0) {
      setKnownVoterInviteStatus("No whitelisted voters to invite.");
      return;
    }

    const copiedLinks: string[] = [];
    let sentCount = 0;
    for (const invitedNpub of targets) {
      try {
        optionACoordinatorRuntime.addWhitelistNpub(invitedNpub);
        const sent = await optionACoordinatorRuntime.sendInvite(invitedNpub, {
          title: questionPrompt.trim() || "Questionnaire",
          description: "",
          voteUrl: buildInviteUrl({
            invite: {
              type: "election_invite",
              schemaVersion: 1,
              electionId: optionAElectionId,
              title: questionPrompt.trim() || "Questionnaire",
              description: "",
              voteUrl: "",
              invitedNpub,
              coordinatorNpub: activeCoordinatorNpub,
              definition: null,
              expiresAt: null,
            },
          }),
        });
        copiedLinks.push(buildInviteUrl({ invite: sent.invite }));
        setAutoSendFollowers((current) => ({
          ...current,
          [invitedNpub]: true,
        }));
        sentCount += 1;
      } catch {
        // Continue inviting remaining whitelist entries.
      }
    }

    const copied = copiedLinks.length > 0
      ? await tryWriteClipboard(copiedLinks.join("\n"))
      : false;
    setKnownVoterInviteRefreshNonce((value) => value + 1);
    setKnownVoterInviteStatus(
      sentCount > 0
        ? `Bulk invited ${sentCount}/${targets.length} whitelisted voters for ${optionAElectionId || "this questionnaire"}. ${copied ? "Invite links copied (newline-separated)." : "Browser blocked clipboard copy."}`
        : "Bulk invite could not send any invitations.",
    );
  }

  async function runOptionABackgroundProcessing() {
    if (!activeCoordinatorNpub.trim() || optionAQueueProcessingInFlightRef.current) {
      return false;
    }
    const localNsecMode = Boolean(keypair?.nsec?.trim() && !signerNpub.trim());
    if (!localNsecMode && (!optionAElectionId.trim() || !optionACoordinatorRuntime)) {
      return false;
    }
    optionAQueueProcessingInFlightRef.current = true;
    try {
      const syncStep = localNsecMode
        ? processOptionAQueuesForCoordinatorLive({
          coordinatorNpub: activeCoordinatorNpub,
          signer: optionASigner,
          fallbackNsec: keypair?.nsec,
          preferredElectionId: optionAElectionId,
          onlyPreferredElectionId: true,
          forceRepublishIssuances: false,
        }).then((result) => {
          if (optionACoordinatorRuntime && optionAElectionId.trim()) {
            optionACoordinatorRuntime.bootstrapCoordinatorNpub({
              coordinatorNpub: activeCoordinatorNpub,
              startDmSubscriptions: false,
            });
          }
          return result.processedElections;
        })
        : optionACoordinatorRuntime!.syncBlindRequestsFromDm()
          .then(() => optionACoordinatorRuntime!.syncSubmissionsFromDm())
          .then(() => optionACoordinatorRuntime!.processPendingBlindRequests())
          .then(() => optionACoordinatorRuntime!.publishPendingBlindIssuancesToDm())
          .then(() => optionACoordinatorRuntime!.processPendingSubmissions([]))
          .then(() => optionACoordinatorRuntime!.publishPendingAcceptanceResultsToDm())
          .then(() => 1);
      await syncStep;
      setKnownVoterInviteRefreshNonce((value) => value + 1);
      return true;
    } finally {
      optionAQueueProcessingInFlightRef.current = false;
    }
  }

  async function processKnownVoterRequests() {
    if (!activeCoordinatorNpub.trim()) {
      return;
    }
    if (optionAQueueProcessingInFlightRef.current) {
      setKnownVoterInviteStatus("Already checking questionnaire requests.");
      return;
    }
    try {
      const ran = await runOptionABackgroundProcessing();
      setKnownVoterInviteStatus(
        ran
          ? (
            optionAElectionId.trim()
              ? "Processed incoming requests/submissions for the current questionnaire."
              : "Processed incoming requests/submissions."
          )
          : "No matching questionnaires found for this coordinator.",
      );
    } catch (error) {
      setKnownVoterInviteStatus(error instanceof Error ? error.message : "Processing failed.");
    }
  }

  useEffect(() => {
    if (!activeCoordinatorNpub.trim()) {
      return;
    }
    const localNsecMode = Boolean(keypair?.nsec?.trim() && !signerNpub.trim());
    if (!localNsecMode && (!optionAElectionId.trim() || !optionACoordinatorRuntime)) {
      return;
    }

    const intervalMs = localNsecMode
      ? OPTION_A_LOCAL_NSEC_BACKGROUND_PROCESS_INTERVAL_MS
      : OPTION_A_DEFAULT_BACKGROUND_PROCESS_INTERVAL_MS;

    const intervalId = window.setInterval(() => {
      void runOptionABackgroundProcessing().catch(() => {
        // Keep background processing best-effort; explicit action shows errors.
      });
    }, intervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [activeCoordinatorNpub, optionACoordinatorRuntime, optionAElectionId, keypair?.nsec, signerNpub]);

  useEffect(() => {
    if (!activeCoordinatorNpub.trim()) {
      return;
    }
    const localNsecMode = Boolean(keypair?.nsec?.trim() && !signerNpub.trim());
    if (!localNsecMode && (!optionAElectionId.trim() || !optionACoordinatorRuntime)) {
      return;
    }
    const triggerRefresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      const now = Date.now();
      if (now - optionAQueueLifecycleRefreshAtRef.current < 1_500) {
        return;
      }
      optionAQueueLifecycleRefreshAtRef.current = now;
      void runOptionABackgroundProcessing().catch(() => {
        // Keep lifecycle refresh best-effort; explicit action shows errors.
      });
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        triggerRefresh();
      }
    };
    window.addEventListener("focus", triggerRefresh);
    window.addEventListener("online", triggerRefresh);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", triggerRefresh);
      window.removeEventListener("online", triggerRefresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeCoordinatorNpub, optionACoordinatorRuntime, optionAElectionId, keypair?.nsec, signerNpub]);
  async function authorizePendingRequester(invitedNpub: string) {
    if (!optionACoordinatorRuntime) {
      return;
    }
    try {
      await optionACoordinatorRuntime.authorizeRequester(invitedNpub);
      setKnownVoterInviteRefreshNonce((value) => value + 1);
      setKnownVoterInviteStatus(`Authorised ${deriveActorDisplayId(invitedNpub)}. Sending invite...`);
      await sendInviteToKnownVoter(invitedNpub);
    } catch (error) {
      setKnownVoterInviteStatus(error instanceof Error ? error.message : "Authorisation failed.");
    }
  }

  useEffect(() => {
    if (!optionACoordinatorRuntime || !optionAElectionId.trim() || optionAPendingAuthorizations.length === 0) {
      return;
    }
    const knownVoterSet = new Set(
      visibleOptionAKnownVoters
        .map((entry) => entry.invitedNpub.trim())
        .filter((value) => value.length > 0),
    );
    const runtimeWhitelist = optionACoordinatorRuntime.getSnapshot()?.whitelist ?? {};
    for (const pending of optionAPendingAuthorizations) {
      const invitedNpub = pending.invitedNpub.trim();
      if (!invitedNpub) {
        continue;
      }
      const isKnown = knownVoterSet.has(invitedNpub) || Boolean(runtimeWhitelist[invitedNpub]);
      if (!isKnown) {
        continue;
      }
      const key = `${optionAElectionId}:${invitedNpub}`;
      if (optionAAutoAuthorizeInFlightRef.current.has(key)) {
        continue;
      }
      optionAAutoAuthorizeInFlightRef.current.add(key);
      void authorizePendingRequester(invitedNpub).finally(() => {
        optionAAutoAuthorizeInFlightRef.current.delete(key);
      });
    }
  }, [optionACoordinatorRuntime, optionAElectionId, optionAPendingAuthorizations, visibleOptionAKnownVoters]);

  function restoreIdentity(nextNsec: string) {
    const trimmed = nextNsec.trim();
    const derivedNpub = deriveNpubFromNsec(trimmed);

    if (!trimmed || !derivedNpub) {
      setIdentityStatus("Enter a valid nsec.");
      return;
    }

    identityHydrationEpochRef.current += 1;
    const nextKeypair = {
      nsec: trimmed,
      npub: derivedNpub,
    };

    void saveSimpleActorState({
      role: "coordinator",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setKeypair(nextKeypair);
    setIdentityStatus("Identity restored from nsec.");
    setBackupStatus(null);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketDeliveries({});
    setAutoSendFollowers({});
    setPendingRequests([]);
    setDmAcknowledgements([]);
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setRoundBlindPrivateKeys({});
    setRoundBlindKeyAnnouncements({});
    setPublishStatus(null);
    setCoordinatorControlCache(null);
    setCoordinatorControlView(null);
    setCoordinatorControlStateLabel(null);
    setShareAssignmentsInFlight(false);
    setLastSuccessfulShareAssignmentSignature('');
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSelectedSubmittedVotingId('');
    setSubmittedVotes([]);
    setActiveTab("configure");
    sentFollowAckStateRef.current = {};
    sentRosterStateRef.current = {};
    sentRequestAckIdsRef.current.clear();
    sentSubCoordinatorAckIdsRef.current.clear();
    sentAssignmentAckIdsRef.current.clear();
    autoShareAssignmentAttemptRef.current = '';
    coordinatorControlServiceRef.current = null;
    blindKeyDiagnosticsRef.current = createBlindKeyDiagnostics();
    roundBroadcastInFlightRef.current = null;
  }

  function handleLeadCoordinatorScanDetected(rawValue: string) {
    const scannedNpub = extractNpubFromScan(rawValue);
    if (!scannedNpub) {
      setLeadScannerStatus("QR did not contain a valid npub.");
      return false;
    }

    setLeadCoordinatorNpub(scannedNpub);
    if (scannedNpub.trim() !== (keypair?.npub ?? '')) {
      setQuestionShareIndex('');
    }
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setLeadScannerStatus(`Scanned ${scannedNpub.slice(0, 18)}...`);
    return true;
  }

  function downloadBackup(passphrase?: string) {
    if (!keypair) {
      return;
    }

    void downloadSimpleActorBackup('coordinator', keypair as SimpleActorKeypair, {
      leadCoordinatorNpub,
      nip65Enabled,
      followers,
      subCoordinators,
      ticketDeliveries,
      autoSendFollowers,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      roundBlindPrivateKeys,
      roundBlindKeyAnnouncements,
      publishStatus,
      coordinatorControlCache,
      publishedVotes,
      selectedVotingId,
      selectedSubmittedVotingId,
      submittedVotes,
    } satisfies SimpleCoordinatorCache, { passphrase });
    setBackupStatus(passphrase?.trim() ? "Encrypted coordinator backup downloaded." : "Coordinator backup downloaded.");
  }

  async function restoreBackup(file: File, passphrase?: string) {
    try {
      const text = await file.text();
      const bundle = parseSimpleActorBackupBundle(text)
        ?? (passphrase?.trim() ? await parseEncryptedSimpleActorBackupBundle(text, passphrase.trim()) : null);
      if (!bundle || bundle.role !== "coordinator") {
        setBackupStatus("Backup file is not a coordinator backup.");
        return;
      }

      await saveSimpleActorState({
        role: "coordinator",
        keypair: bundle.keypair,
        updatedAt: new Date().toISOString(),
        cache: bundle.cache,
      }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
      identityHydrationEpochRef.current += 1;
      setKeypair(bundle.keypair);
      setIdentityStatus("Full local state restored from backup.");
      setBackupStatus(`Backup restored from ${bundle.exportedAt}.`);
      const cache = (bundle.cache ?? null) as Partial<SimpleCoordinatorCache> | null;
      const fallbackCoordinatorNpubs = sortCoordinatorRoster(
        Array.isArray(cache?.subCoordinators)
          ? cache.subCoordinators.flatMap((application) => (
            application && typeof application.coordinatorNpub === "string"
              ? [application.coordinatorNpub]
              : []
          ))
          : [],
      );
      setLeadCoordinatorNpub(typeof cache?.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
      setNip65Enabled(cache?.nip65Enabled === true);
      setFollowers(Array.isArray(cache?.followers) ? cache.followers : []);
      setSubCoordinators(Array.isArray(cache?.subCoordinators) ? cache.subCoordinators : []);
      setTicketDeliveries(
        cache?.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {},
      );
      setAutoSendFollowers(
        cache?.autoSendFollowers && typeof cache.autoSendFollowers === "object"
          ? cache.autoSendFollowers
          : {},
      );
      setPendingRequests(Array.isArray(cache?.pendingRequests) ? cache.pendingRequests : []);
      setDmAcknowledgements([]);
      setRegistrationStatus(typeof cache?.registrationStatus === "string" ? cache.registrationStatus : null);
      setAssignmentStatus(typeof cache?.assignmentStatus === "string" ? cache.assignmentStatus : null);
      setQuestionPrompt(typeof cache?.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
      setQuestionThresholdT(typeof cache?.questionThresholdT === "string" ? cache.questionThresholdT : "1");
      setQuestionThresholdN(typeof cache?.questionThresholdN === "string" ? cache.questionThresholdN : "1");
      setQuestionShareIndex(typeof cache?.questionShareIndex === "string" ? cache.questionShareIndex : "1");
      setRoundBlindPrivateKeys(
        cache?.roundBlindPrivateKeys && typeof cache.roundBlindPrivateKeys === "object"
          ? cache.roundBlindPrivateKeys as Record<string, SimpleBlindPrivateKey>
          : {},
      );
      setRoundBlindKeyAnnouncements(
        cache?.roundBlindKeyAnnouncements && typeof cache.roundBlindKeyAnnouncements === "object"
          ? cache.roundBlindKeyAnnouncements as Record<string, SimpleBlindKeyAnnouncement>
          : {},
      );
      setPublishStatus(typeof cache?.publishStatus === "string" ? cache.publishStatus : null);
      setCoordinatorControlCache(
        cache?.coordinatorControlCache && typeof cache.coordinatorControlCache === "object"
          ? cache.coordinatorControlCache as CoordinatorControlCache
          : null,
      );
      setPublishedVotes(
        Array.isArray(cache?.publishedVotes)
          ? cache.publishedVotes
            .map((vote) => normalizeLiveVoteSession(vote, fallbackCoordinatorNpubs))
            .filter((vote): vote is SimpleLiveVoteSession => vote !== null)
          : [],
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setSelectedSubmittedVotingId(
        typeof cache?.selectedSubmittedVotingId === 'string'
          ? cache.selectedSubmittedVotingId
          : '',
      );
      setSubmittedVotes(Array.isArray(cache?.submittedVotes) ? cache.submittedVotes : []);
      setActiveTab("configure");
      sentFollowAckStateRef.current = {};
      sentRosterStateRef.current = {};
      sentRequestAckIdsRef.current.clear();
      sentSubCoordinatorAckIdsRef.current.clear();
      sentAssignmentAckIdsRef.current.clear();
    } catch {
      setBackupStatus("Backup restore failed.");
    }
  }

  async function unlockLocalState(passphrase: string) {
    const trimmed = passphrase.trim();
    if (!trimmed) {
      setStorageStatus("Enter the passphrase.");
      return;
    }

    try {
      const storedState = await loadSimpleActorStateWithOptions("coordinator", { passphrase: trimmed });
      if (!storedState?.keypair) {
        setStorageStatus("No coordinator state was found.");
        return;
      }

      const cache = (storedState.cache ?? null) as Partial<SimpleCoordinatorCache> | null;
      const fallbackCoordinatorNpubs = sortCoordinatorRoster(
        Array.isArray(cache?.subCoordinators)
          ? cache.subCoordinators.flatMap((application) => (
            application && typeof application.coordinatorNpub === "string"
              ? [application.coordinatorNpub]
              : []
          ))
          : [],
      );
      setStoragePassphrase(trimmed);
      identityHydrationEpochRef.current += 1;
      setKeypair(storedState.keypair);
      setLeadCoordinatorNpub(typeof cache?.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
      setFollowers(Array.isArray(cache?.followers) ? cache.followers : []);
      setSubCoordinators(Array.isArray(cache?.subCoordinators) ? cache.subCoordinators : []);
      setTicketDeliveries(cache?.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {});
      setAutoSendFollowers(
        cache?.autoSendFollowers && typeof cache.autoSendFollowers === "object"
          ? cache.autoSendFollowers
          : {},
      );
      setPendingRequests(Array.isArray(cache?.pendingRequests) ? cache.pendingRequests : []);
      setRegistrationStatus(typeof cache?.registrationStatus === "string" ? cache.registrationStatus : null);
      setAssignmentStatus(typeof cache?.assignmentStatus === "string" ? cache.assignmentStatus : null);
      setQuestionPrompt(typeof cache?.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
      setQuestionThresholdT(typeof cache?.questionThresholdT === "string" ? cache.questionThresholdT : "1");
      setQuestionThresholdN(typeof cache?.questionThresholdN === "string" ? cache.questionThresholdN : "1");
      setQuestionShareIndex(typeof cache?.questionShareIndex === "string" ? cache.questionShareIndex : "1");
      setRoundBlindPrivateKeys(cache?.roundBlindPrivateKeys && typeof cache.roundBlindPrivateKeys === "object" ? cache.roundBlindPrivateKeys as Record<string, SimpleBlindPrivateKey> : {});
      setRoundBlindKeyAnnouncements(cache?.roundBlindKeyAnnouncements && typeof cache.roundBlindKeyAnnouncements === "object" ? cache.roundBlindKeyAnnouncements as Record<string, SimpleBlindKeyAnnouncement> : {});
      setPublishStatus(typeof cache?.publishStatus === "string" ? cache.publishStatus : null);
      setCoordinatorControlCache(
        cache?.coordinatorControlCache && typeof cache.coordinatorControlCache === "object"
          ? cache.coordinatorControlCache as CoordinatorControlCache
          : null,
      );
      setPublishedVotes(
        Array.isArray(cache?.publishedVotes)
          ? cache.publishedVotes
            .map((vote) => normalizeLiveVoteSession(vote, fallbackCoordinatorNpubs))
            .filter((vote): vote is SimpleLiveVoteSession => vote !== null)
          : [],
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setSelectedSubmittedVotingId(typeof cache?.selectedSubmittedVotingId === "string" ? cache.selectedSubmittedVotingId : "");
      setSubmittedVotes(Array.isArray(cache?.submittedVotes) ? cache.submittedVotes : []);
      setActiveTab("configure");
      setStorageLocked(false);
      setStorageStatus("Local coordinator state unlocked.");
      setIdentityReady(true);
    } catch {
      setStorageStatus("Unlock failed.");
    }
  }

  async function protectLocalState(passphrase: string) {
    if (!passphrase.trim() || !keypair) {
      setStorageStatus("Enter a passphrase first.");
      return;
    }
    setStoragePassphrase(passphrase.trim());
    setStorageStatus("Local coordinator state will be stored encrypted.");
  }

  async function disableLocalStateProtection(currentPassphrase?: string) {
    if (!keypair) {
      return;
    }
    if (!storagePassphrase && !currentPassphrase?.trim()) {
      setStorageStatus("Enter the current passphrase to remove protection.");
      return;
    }
    setStoragePassphrase("");
    setStorageStatus("Local coordinator state protection removed.");
  }

  function getThresholdLabel() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return `${configuredT} of ${configuredN}`;
    }

    return "1 of 1";
  }

  function getThresholdNumbers() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return { thresholdT: configuredT, thresholdN: configuredN };
    }

    return { thresholdT: 1, thresholdN: 1 };
  }

  async function publishBlindKeyForRound(input: {
    votingId: string;
    blindPrivateKey: SimpleBlindPrivateKey;
    force?: boolean;
  }) {
    const coordinatorNsec = keypair?.nsec ?? "";
    const coordinatorNpub = keypair?.npub ?? "";
    const activeRound =
      publishedVotes.find((vote) => vote.votingId === input.votingId) ?? null;

    if (
      !coordinatorNsec ||
      !coordinatorNpub ||
      !activeRound ||
      !activeRound.authorizedCoordinatorNpubs.includes(coordinatorNpub)
    ) {
      return null;
    }

    const existingAnnouncement = roundBlindKeyAnnouncements[input.votingId];
    const existingAnnouncementKeyId = existingAnnouncement?.publicKey?.keyId;
    if (!input.force && existingAnnouncementKeyId === input.blindPrivateKey.keyId) {
      updateBlindKeyDiagnostics({
        blindKeyObservedBackLocally: true,
        blindKeyEventId: existingAnnouncement?.event.id ?? blindKeyDiagnosticsRef.current.blindKeyEventId,
      });
      return existingAnnouncement ?? null;
    }

    updateBlindKeyDiagnostics((current) => ({
      blindKeyPublishAttempted: true,
      blindKeyPublishStartedAt: new Date().toISOString(),
      blindKeyPublishAttemptCount: current.blindKeyPublishAttemptCount + 1,
      blindKeyPublishLastError: null,
    }));
    let result: Awaited<ReturnType<typeof publishSimpleBlindKeyAnnouncement>>;
    try {
      result = await publishSimpleBlindKeyAnnouncement({
        coordinatorNsec,
        votingId: input.votingId,
        publicKey: input.blindPrivateKey,
      });
    } catch (error) {
      updateBlindKeyDiagnostics({
        blindKeyPublishSucceeded: false,
        blindKeyPublishLastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const nextAnnouncement: SimpleBlindKeyAnnouncement = {
      coordinatorNpub,
      votingId: input.votingId,
      publicKey: input.blindPrivateKey,
      createdAt: result.createdAt,
      event: result.event,
    };

    setRoundBlindKeyAnnouncements((current) => ({
      ...current,
      [input.votingId]: nextAnnouncement,
    }));
    updateBlindKeyDiagnostics({
      blindKeyPublishSucceeded: result.successes > 0,
      blindKeyPublishSucceededAt: result.successes > 0 ? new Date().toISOString() : null,
      blindKeyObservedBackLocally: true,
      blindKeyEventId: result.eventId,
      blindKeyRelayTargets: result.relayResults.map((entry) => entry.relay),
      blindKeyRelaySuccessCount: result.successes,
      blindKeyPublishLastError: result.successes > 0
        ? null
        : result.relayResults.find((entry) => !entry.success)?.error
          ?? "blind_key_publish_unconfirmed",
    });

    return nextAnnouncement;
  }

  async function republishActiveBlindKey() {
    if (!activeVotingId || !activeBlindPrivateKey) {
      return;
    }

    setPublishStatus("Republishing blind key...");

    try {
      const result = await publishBlindKeyForRound({
        votingId: activeVotingId,
        blindPrivateKey: activeBlindPrivateKey,
        force: true,
      });
      setPublishStatus(result ? "Blind key republished." : "Blind key republish failed.");
    } catch {
      setPublishStatus("Blind key republish failed.");
    }
  }

  async function ensureBlindKeyAnnouncementForRound(input: {
    votingId: string;
    blindPrivateKey: SimpleBlindPrivateKey;
    forceRepublish?: boolean;
  }) {
    const coordinatorNpub = keypair?.npub ?? "";
    if (!coordinatorNpub) {
      return null;
    }

    const existingAnnouncement = roundBlindKeyAnnouncements[input.votingId];
    if (existingAnnouncement && !input.forceRepublish) {
      updateBlindKeyDiagnostics({
        blindKeyObservedBackLocally: true,
        blindKeyEventId: existingAnnouncement.event.id,
      });
      return existingAnnouncement;
    }

    if (!input.forceRepublish) {
      try {
        const fetchedAnnouncement = await fetchLatestSimpleBlindKeyAnnouncement({
          coordinatorNpub,
          votingId: input.votingId,
        });
        if (fetchedAnnouncement) {
          setRoundBlindKeyAnnouncements((current) => ({
            ...current,
            [input.votingId]: fetchedAnnouncement,
          }));
          updateBlindKeyDiagnostics({
            blindKeyObservedBackLocally: true,
            blindKeyEventId: fetchedAnnouncement.event.id,
          });
          return fetchedAnnouncement;
        }
      } catch {
        // Fall through to republish with the local private key.
      }
    }

    return publishBlindKeyForRound({
      votingId: input.votingId,
      blindPrivateKey: input.blindPrivateKey,
      force: true,
    });
  }

  async function sendTicket(
    follower: SimpleCoordinatorFollower,
    options?: { preSendDelayMs?: number },
  ) {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const votingId = selectedPublishedVote?.votingId ?? "";
    const prompt = selectedPublishedVote?.prompt ?? "";
    const matchingRequest = findLatestRoundRequest(pendingRequests, follower.voterNpub, votingId);

    if (
      !coordinatorNpub
      || !coordinatorSecretKey
      || !activeBlindPrivateKey
      || !matchingRequest
      || !coordinatorId
      || coordinatorId === "pending"
      || !votingId
      || !prompt
      || activeShareIndex <= 0
    ) {
      return;
    }

    if (options?.preSendDelayMs && options.preSendDelayMs > 0) {
      await wait(options.preSendDelayMs);
    }

    const keyAnnouncement = await ensureBlindKeyAnnouncementForRound({
      votingId,
      blindPrivateKey: activeBlindPrivateKey,
    });
    if (!keyAnnouncement) {
      setTicketDeliveries((current) => ({
        ...current,
        [`${follower.voterNpub}:${votingId}`]: {
          status: "Blind key announcement unavailable.",
          attempts: (current[`${follower.voterNpub}:${votingId}`]?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
      }));
      return;
    }

    const ticketStatusKey = `${follower.voterNpub}:${votingId}`;
    setTicketDeliveries((current) => ({
      ...current,
      [ticketStatusKey]: {
        status: "Sending ticket...",
        requestId: matchingRequest.id,
        ticketBuiltAt: current[ticketStatusKey]?.ticketBuiltAt ?? new Date().toISOString(),
        ticketPublishStartedAt: new Date().toISOString(),
        ticketStillMissing: true,
        resendCount: (current[ticketStatusKey]?.attempts ?? 0) > 0
          ? (current[ticketStatusKey]?.resendCount ?? 0) + 1
          : (current[ticketStatusKey]?.resendCount ?? 0),
        attempts: (current[ticketStatusKey]?.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        relayResults: undefined,
      },
    }));

    try {
      if (activeShareIndex > 1) {
        await wait((activeShareIndex - 1) * SIMPLE_TICKET_SEND_STAGGER_MS);
      }
      const thresholdLabel = activeThresholdT && activeThresholdN
        ? `${activeThresholdT} of ${activeThresholdN}`
        : getThresholdLabel();
      const result = await sendSimpleRoundTicket({
        coordinatorSecretKey,
        blindPrivateKey: activeBlindPrivateKey,
        keyAnnouncementEvent: keyAnnouncement.event,
        recipientNpub: matchingRequest.replyNpub,
        coordinatorNpub,
        thresholdLabel,
        request: matchingRequest,
        votingPrompt: prompt,
        shareIndex: activeShareIndex,
        thresholdT: activeThresholdT,
        thresholdN: activeThresholdN,
        attemptNo: (ticketDeliveries[ticketStatusKey]?.attempts ?? 0) + 1,
        supersedesEventId: ticketDeliveries[ticketStatusKey]?.eventId,
        ticketId: ticketDeliveries[ticketStatusKey]?.responseId,
      });

      setTicketDeliveries((current) => {
        const previousDelivery = current[ticketStatusKey];
        const priorEventIds = Array.from(new Set([
          ...(previousDelivery?.priorEventIds ?? []),
          ...(previousDelivery?.eventId && previousDelivery.eventId !== result.eventId
            ? [previousDelivery.eventId]
            : []),
        ]));
        const priorResponseIds = Array.from(new Set([
          ...(previousDelivery?.priorResponseIds ?? []),
          ...(previousDelivery?.responseId && previousDelivery.responseId !== result.responseId
            ? [previousDelivery.responseId]
            : []),
        ]));

        return {
          ...current,
          [ticketStatusKey]: {
          status: result.successes > 0 ? "Ticket sent." : "Ticket send failed.",
          eventId: result.eventId,
          requestId: matchingRequest.id,
          responseId: result.responseId,
          resendCount: previousDelivery?.eventId
            ? (previousDelivery?.resendCount ?? 0) + 1
            : (previousDelivery?.resendCount ?? 0),
          ticketBuiltAt: previousDelivery?.ticketBuiltAt ?? new Date().toISOString(),
          ticketPublishStartedAt: previousDelivery?.ticketPublishStartedAt ?? new Date().toISOString(),
          ticketPublishSucceededAt: result.successes > 0 ? new Date().toISOString() : previousDelivery?.ticketPublishSucceededAt,
          ticketLastBackfillAttemptAt: previousDelivery?.ticketLastBackfillAttemptAt,
          ticketStillMissing: result.successes > 0,
          ticketRelayTargets: result.relayResults.map((entry) => entry.relay),
          ticketRelaySuccessCount: result.relayResults.filter((entry) => entry.success).length,
          ticketPublishEventKind: result.eventKind,
          ticketPublishEventCreatedAt: result.eventCreatedAt,
          ticketPublishEventTags: result.eventTags,
          ticketPublishEventContent: result.eventContent,
          priorEventIds,
          priorResponseIds,
          attempts: (previousDelivery?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          relayResults: result.relayResults,
        },
        };
      });
    } catch {
      setTicketDeliveries((current) => ({
        ...current,
        [ticketStatusKey]: {
          status: "Ticket send failed.",
          requestId: matchingRequest.id,
          ticketBuiltAt: current[ticketStatusKey]?.ticketBuiltAt ?? new Date().toISOString(),
          ticketPublishStartedAt: current[ticketStatusKey]?.ticketPublishStartedAt ?? new Date().toISOString(),
          ticketStillMissing: true,
          attempts: current[ticketStatusKey]?.attempts ?? 1,
          lastAttemptAt: new Date().toISOString(),
          relayResults: undefined,
        },
      }));
    }
  }

  async function resendRoundInfo(follower: SimpleCoordinatorFollower) {
    const coordinatorNsec = keypair?.nsec ?? "";
    const votingId = selectedPublishedVote?.votingId ?? "";
    const prompt = selectedPublishedVote?.prompt ?? "";

    if (!coordinatorNsec || !votingId || !prompt || !activeBlindPrivateKey) {
      return;
    }

    const followerId = deriveActorDisplayId(follower.voterNpub);
    setPublishStatus(`Resending round info for Voter ${followerId}...`);

    try {
      let announcementRepublished = false;

      if (isLeadCoordinator) {
        const result = await publishSimpleLiveVote({
          coordinatorNsec,
          prompt,
          votingId,
          thresholdT: selectedPublishedVote?.thresholdT,
          thresholdN: selectedPublishedVote?.thresholdN,
          authorizedCoordinatorNpubs: selectedPublishedVote?.authorizedCoordinatorNpubs,
        });
        announcementRepublished = result.successes > 0;
      }

      const keyAnnouncement = await ensureBlindKeyAnnouncementForRound({
        votingId,
        blindPrivateKey: activeBlindPrivateKey,
        forceRepublish: true,
      });

      if (keyAnnouncement && (announcementRepublished || !isLeadCoordinator)) {
        setPublishStatus(`Round info resent for Voter ${followerId}.`);
      } else {
        setPublishStatus(`Round info resend failed for Voter ${followerId}.`);
      }
    } catch {
      setPublishStatus(`Round info resend failed for Voter ${followerId}.`);
    }
  }

  async function broadcastQuestion() {
    const prompt = questionPrompt.trim();

    if (!keypair?.nsec || !prompt || !isLeadCoordinator) {
      return;
    }

    pendingRoundOpenAttemptRef.current = true;

    const service = coordinatorControlServiceRef.current;
    if (!service) {
      setPublishStatus("Coordinator control engine is not ready.");
      return;
    }

    if (!(await ensureCoordinatorControlGroupReady())) {
      return;
    }

    setPublishStatus("Proposing round open...");

    try {
      const threshold = getThresholdNumbers();
      const roundId = crypto.randomUUID();
      const result = await service.publishRoundOpenFlow({
        coordinatorNsec: keypair.nsec,
        roundId,
        prompt,
        thresholdT: threshold.thresholdT,
        thresholdN: threshold.thresholdN,
        roster: coordinatorHexRoster,
      });
      setCoordinatorControlCache(service.snapshot());
      setCoordinatorControlView(result.state);
      setCoordinatorControlStateLabel(
        formatCoordinatorControlStateLabel(
          result.state,
          coordinatorControlServiceRef.current?.getEngineStatus() ?? null,
        ),
      );
      pendingRoundOpenAttemptRef.current = false;
      setSelectedVotingId(roundId);
      setSelectedSubmittedVotingId(roundId);
      setPublishStatus(
        result.state.latest_round?.phase === "open"
          ? "Coordinator round open agreed. Broadcasting vote..."
          : "Round-open proposal sent. Waiting for coordinator approvals.",
      );
    } catch {
      setCoordinatorControlCache(service.snapshot());
      setCoordinatorControlView(service.getState());
      setCoordinatorControlStateLabel(
        formatCoordinatorControlStateLabel(
          service.getState(),
          coordinatorControlServiceRef.current?.getEngineStatus() ?? null,
        ),
      );
      pendingRoundOpenAttemptRef.current = false;
      setPublishStatus("Round-open proposal failed.");
    }
  }

  function selectRound(votingId: string) {
    setSelectedVotingId(votingId);
  }

  function selectTab(nextTab: CoordinatorTab) {
    setActiveTab(nextTab);
  }

  async function submitToLeadCoordinator() {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const nextLeadCoordinatorNpub = leadCoordinatorNpub.trim();

    if (
      !coordinatorNpub
      || !coordinatorSecretKey
      || !nextLeadCoordinatorNpub
      || nextLeadCoordinatorNpub === coordinatorNpub
      || coordinatorId === "pending"
    ) {
      return;
    }

    setRegistrationStatus("Notifying lead coordinator...");

    try {
      const service = coordinatorControlServiceRef.current ?? (
        coordinatorElectionId && localCoordinatorHexPubkey
          ? await CoordinatorControlService.create({
            electionId: coordinatorElectionId,
            localPubkey: localCoordinatorHexPubkey,
            roster: coordinatorHexRoster,
            leadPubkey: isLeadCoordinator ? localCoordinatorHexPubkey : leadCoordinatorHexPubkey || null,
            engineKind: coordinatorRuntimeEngineKind,
            snapshot: coordinatorControlCache?.snapshot ?? null,
            onPublished: recordStartupPublishDiagnostic,
          })
          : null
      );
      if (service && coordinatorControlServiceRef.current !== service) {
        coordinatorControlServiceRef.current = service;
        setCoordinatorControlCache(service.snapshot());
        setCoordinatorControlView(service.getState());
        setCoordinatorControlStateLabel(
          formatCoordinatorControlStateLabel(service.getState(), service.getEngineStatus()),
        );
      }
      const mlsJoinPackage = service?.getEngineStatus().engine_kind === "open_mls"
        ? service.exportSupervisoryJoinPackage() ?? undefined
        : undefined;
      updateStartupDiagnostics((current) => ({
        mlsJoinPackagePublishAttemptCount: current.mlsJoinPackagePublishAttemptCount + 1,
        mlsJoinPackageLastPublishAt: new Date().toISOString(),
      }));
      const result = await sendSimpleSubCoordinatorJoin({
        coordinatorSecretKey,
        leadCoordinatorNpub: nextLeadCoordinatorNpub,
        coordinatorNpub,
        mlsJoinPackage,
      });
      updateStartupDiagnostics((current) => ({
        mlsJoinPackagePublishSuccessCount: current.mlsJoinPackagePublishSuccessCount + (result.successes > 0 ? 1 : 0),
        mlsJoinPackagePublishFailureCount: current.mlsJoinPackagePublishFailureCount + (result.successes > 0 ? 0 : 1),
        mlsJoinPackageLastRelayResults: result.relayResults.map((entry) => ({
          relay: entry.relay,
          success: entry.success,
          error: entry.error,
        })),
      }));

      setRegistrationStatus(
        result.successes > 0
          ? "Lead coordinator notified. Waiting for share index assignment."
          : "Lead coordinator notification failed.",
      );
    } catch {
      updateStartupDiagnostics((current) => ({
        mlsJoinPackagePublishFailureCount: current.mlsJoinPackagePublishFailureCount + 1,
      }));
      setRegistrationStatus("Lead coordinator notification failed.");
    }
  }

  async function ensureCoordinatorControlGroupReady() {
    const service = coordinatorControlServiceRef.current;
    if (!service) {
      setPublishStatus("Coordinator control engine is not ready.");
      return false;
    }

    const status = service.getEngineStatus();
    if (status.engine_kind !== "open_mls") {
      return true;
    }

    if (status.group_ready && (!isLeadCoordinator || getOutstandingMlsWelcomeAckNpubs().length === 0)) {
      return true;
    }

    if (!isLeadCoordinator) {
      setPublishStatus("Waiting for MLS welcome from the lead coordinator.");
      return false;
    }

    if (mlsBootstrapInFlightRef.current) {
      setPublishStatus("Preparing coordinator MLS group...");
      return false;
    }

    mlsBootstrapInFlightRef.current = true;
    setPublishStatus("Preparing coordinator MLS group...");
    updateStartupDiagnostics((current) => ({
      mlsWelcomePublishAttemptCount: current.mlsWelcomePublishAttemptCount + 1,
      mlsWelcomeLastPublishAt: new Date().toISOString(),
    }));
    try {
      const joinPackages = subCoordinators
        .map((application) => application.mlsJoinPackage?.trim() ?? "")
        .filter((value) => value.length > 0);
      const welcomeBundle = service.bootstrapSupervisoryGroup(joinPackages);
      setCoordinatorControlCache(service.snapshot());
      setCoordinatorControlView(service.getState());
      setCoordinatorControlStateLabel(
        formatCoordinatorControlStateLabel(service.getState(), service.getEngineStatus()),
      );

      if (welcomeBundle) {
        const leadCoordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
        const leadCoordinatorNpub = keypair?.npub ?? "";
        if (!leadCoordinatorSecretKey || !leadCoordinatorNpub) {
          setPublishStatus("Coordinator MLS bootstrap failed.");
          return false;
        }

        for (const application of subCoordinators) {
          const signature = `${coordinatorElectionId}:${application.id}:${welcomeBundle}`;
          if (sentMlsWelcomeStateRef.current[application.coordinatorNpub] === signature) {
            continue;
          }
          sentMlsWelcomeStateRef.current[application.coordinatorNpub] = signature;
          const welcomeResult = await sendSimpleCoordinatorMlsWelcome({
            leadCoordinatorSecretKey,
            leadCoordinatorNpub,
            coordinatorNpub: application.coordinatorNpub,
            electionId: coordinatorElectionId,
            welcomeBundle,
          });
          sentMlsWelcomeEventIdsRef.current[application.coordinatorNpub] = welcomeResult.eventId;
          updateStartupDiagnostics((current) => ({
            mlsWelcomePublishSuccessCount: current.mlsWelcomePublishSuccessCount + (welcomeResult.successes > 0 ? 1 : 0),
            mlsWelcomePublishFailureCount: current.mlsWelcomePublishFailureCount + (welcomeResult.successes > 0 ? 0 : 1),
            mlsWelcomeLastRelayResults: welcomeResult.relayResults.map((entry) => ({
              relay: entry.relay,
              success: entry.success,
              error: entry.error,
            })),
          }));
        }
      }

      const outstandingCoordinatorNpubs = subCoordinators
        .filter((application) => application.mlsJoinPackage?.trim())
        .map((application) => application.coordinatorNpub)
        .filter((coordinatorNpub) => {
          const welcomeEventId = sentMlsWelcomeEventIdsRef.current[coordinatorNpub];
          if (!welcomeEventId) {
            return true;
          }

          return !dmAcknowledgements.some((ack) => (
            ack.actorNpub === coordinatorNpub
            && ack.ackedAction === "simple_mls_welcome"
            && ack.ackedEventId === welcomeEventId
          ));
        });

      if (outstandingCoordinatorNpubs.length > 0) {
        setPublishStatus(
          `Waiting for MLS welcome acknowledgements from ${formatCoordinatorList(outstandingCoordinatorNpubs)}.`,
        );
        return false;
      }

      setPublishStatus(null);
      return service.getEngineStatus().group_ready;
    } catch {
      updateStartupDiagnostics((current) => ({
        mlsWelcomePublishFailureCount: current.mlsWelcomePublishFailureCount + 1,
      }));
      setPublishStatus("Coordinator MLS bootstrap failed.");
      return false;
    } finally {
      mlsBootstrapInFlightRef.current = false;
    }
  }

  async function distributeShareIndexes(options?: {
    automatic?: boolean;
    signature?: string;
  }) {
    const leadCoordinatorSecretKey = decodeNsec(keypair?.nsec ?? '');
    const leadCoordinatorNpub = keypair?.npub ?? '';

    if (
      !isLeadCoordinator ||
      !leadCoordinatorSecretKey ||
      !leadCoordinatorNpub ||
      subCoordinators.length === 0
    ) {
      return;
    }

    setShareAssignmentsInFlight(true);
    setAssignmentStatus(
      options?.automatic
        ? 'Sending share indexes automatically...'
        : 'Sending share indexes...',
    );

    try {
      const thresholdN = Number.parseInt(questionThresholdN, 10) || undefined;
      const sortedApplications = [...subCoordinators].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.coordinatorNpub.localeCompare(right.coordinatorNpub),
      );

      const results = await Promise.all(
        sortedApplications.map(async (application, index) => {
          const shareIndex = index + 2;
          const result = await sendSimpleShareAssignment({
            leadCoordinatorSecretKey,
            leadCoordinatorNpub,
            coordinatorNpub: application.coordinatorNpub,
            shareIndex,
            thresholdN,
          });
          return result.successes > 0;
        }),
      );

      setAssignmentStatus(
        results.every(Boolean)
          ? options?.automatic
            ? 'Share indexes sent automatically.'
            : 'Share indexes sent.'
          : 'Some share index assignments failed.',
      );
      if (results.every(Boolean) && options?.signature) {
        setLastSuccessfulShareAssignmentSignature(options.signature);
      }
    } catch {
      setAssignmentStatus('Share index distribution failed.');
    } finally {
      setShareAssignmentsInFlight(false);
    }
  }

  useEffect(() => {
    const knownFollowerNpubs = new Set(followers.map((follower) => follower.voterNpub));
    setAutoSendFollowers((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([voterNpub]) => {
          const keep = knownFollowerNpubs.has(voterNpub);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });
  }, [followers]);

  const selectedRoundId = selectedSubmittedVote?.votingId ?? "";
  const selectedRoundSummary = useMemo(
    () => derivedProtocolState?.ballot_state.round_summaries.find((summary) => summary.round_id === selectedRoundId) ?? null,
    [derivedProtocolState, selectedRoundId],
  );
  const acceptedVotes = useMemo(
    () => derivedProtocolState?.ballot_state.accepted_ballots.filter((entry) => entry.round_id === selectedRoundId) ?? [],
    [derivedProtocolState, selectedRoundId],
  );
  const rejectedVotes = useMemo(
    () => derivedProtocolState?.ballot_state.rejected_ballots.filter((entry) => entry.round_id === selectedRoundId) ?? [],
    [derivedProtocolState, selectedRoundId],
  );
  const validYesCount = selectedRoundSummary?.yes_count ?? 0;
  const validNoCount = selectedRoundSummary?.no_count ?? 0;
  const yesValidatedVotes = acceptedVotes.filter((entry) => entry.choice === "Yes");
  const noValidatedVotes = acceptedVotes.filter((entry) => entry.choice === "No");
  const yesRejectedVotes = rejectedVotes.filter((entry) => entry.choice === "Yes");
  const noRejectedVotes = rejectedVotes.filter((entry) => entry.choice === "No");
  const activeAcceptedVotes = useMemo(
    () => derivedProtocolState?.ballot_state.accepted_ballots.filter(
      (entry) => entry.round_id === (selectedPublishedVote?.votingId ?? ""),
    ) ?? [],
    [derivedProtocolState, selectedPublishedVote?.votingId],
  );
  const activeRejectedVotes = useMemo(
    () => derivedProtocolState?.ballot_state.rejected_ballots.filter(
      (entry) => entry.round_id === (selectedPublishedVote?.votingId ?? ""),
    ) ?? [],
    [derivedProtocolState, selectedPublishedVote?.votingId],
  );
  const activeAcceptedTicketIds = useMemo(
    () =>
      new Set(
        activeAcceptedVotes
          .map((vote) => vote.ticket_id?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    [activeAcceptedVotes],
  );
  const activeAcceptedRequestIds = useMemo(
    () =>
      new Set(
        activeAcceptedVotes
          .map((vote) => vote.request_id?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    [activeAcceptedVotes],
  );
  const activeAcceptedVoterPubkeys = useMemo(
    () =>
      new Set(
        activeAcceptedVotes
          .map((vote) => vote.voter_pubkey?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    [activeAcceptedVotes],
  );
  const acceptedBallotsByRequestId = useMemo(() => {
    const map = new Map<string, Array<{
      eventId: string;
      requestId?: string;
      ticketId?: string;
      roundId: string;
      voterPubkey: string;
      choice: string;
    }>>();
    for (const ballot of activeAcceptedVotes) {
      const key = ballot.request_id?.trim();
      if (!key) {
        continue;
      }
      const next = map.get(key) ?? [];
      next.push({
        eventId: ballot.event_id,
        requestId: ballot.request_id,
        ticketId: ballot.ticket_id,
        roundId: ballot.round_id,
        voterPubkey: ballot.voter_pubkey,
        choice: ballot.choice,
      });
      map.set(key, next);
    }
    return map;
  }, [activeAcceptedVotes]);
  const acceptedBallotsByTicketId = useMemo(() => {
    const map = new Map<string, Array<{
      eventId: string;
      requestId?: string;
      ticketId?: string;
      roundId: string;
      voterPubkey: string;
      choice: string;
    }>>();
    for (const ballot of activeAcceptedVotes) {
      const key = ballot.ticket_id?.trim();
      if (!key) {
        continue;
      }
      const next = map.get(key) ?? [];
      next.push({
        eventId: ballot.event_id,
        requestId: ballot.request_id,
        ticketId: ballot.ticket_id,
        roundId: ballot.round_id,
        voterPubkey: ballot.voter_pubkey,
        choice: ballot.choice,
      });
      map.set(key, next);
    }
    return map;
  }, [activeAcceptedVotes]);
  const deliveryCompletionAcknowledgements = useMemo(() => {
    if (!selectedPublishedVote?.votingId) {
      return [] as Array<{ actorNpub: string; ackedAction: string; ackedEventId: string; responseId: string }>;
    }
    const synthetic: Array<{ actorNpub: string; ackedAction: string; ackedEventId: string; responseId: string }> = [];
    for (const [key, delivery] of Object.entries(ticketDeliveries)) {
      const [voterNpub, votingId] = key.split(":");
      if (votingId !== selectedPublishedVote.votingId) {
        continue;
      }
      const responseId = delivery.responseId?.trim();
      if (!responseId || !activeAcceptedTicketIds.has(responseId)) {
        continue;
      }
      synthetic.push({
        actorNpub: voterNpub,
        ackedAction: "simple_round_ticket",
        ackedEventId: responseId,
        responseId,
      });
    }
    return synthetic;
  }, [activeAcceptedTicketIds, selectedPublishedVote?.votingId, ticketDeliveries]);
  const submittedVoteNumbers = useMemo(() => {
    const nextNumbers = new Map<string, number>();
    [...acceptedVotes, ...rejectedVotes].forEach((entry, index) => {
      nextNumbers.set(entry.event_id, index + 1);
    });
    return nextNumbers;
  }, [acceptedVotes, rejectedVotes]);
  const visibleFollowers = activeVotingId
    ? followers.filter((follower) => !follower.votingId || follower.votingId === activeVotingId)
    : followers;
  const canIssueTickets = Boolean(
    keypair?.nsec &&
    activeBlindPrivateKey &&
    !isCourseFeedbackMode &&
    (isLeadCoordinator || activeShareIndex > 0),
  );
  const coordinatorFollowerRows = useMemo(() => buildCoordinatorFollowerRowsRust({
    followers,
    selectedPublishedVotingId: selectedPublishedVote?.votingId ?? null,
    pendingRequests: pendingRequests.map((request) => ({
      voterNpub: request.voterNpub,
      votingId: request.votingId,
      createdAt: request.createdAt,
    })),
    ticketDeliveries,
    acknowledgements: [
      ...dmAcknowledgements.map((ack) => ({
        actorNpub: ack.actorNpub,
        ackedAction: ack.ackedAction,
        ackedEventId: ack.ackedEventId,
        responseId: ack.responseId,
      })),
      ...deliveryCompletionAcknowledgements,
    ],
    canIssueTickets,
  }), [
    canIssueTickets,
    dmAcknowledgements,
    deliveryCompletionAcknowledgements,
    followers,
    pendingRequests,
    selectedPublishedVote?.votingId,
    ticketDeliveries,
  ]);
  const enhancedCoordinatorFollowerRows = useMemo(() => coordinatorFollowerRows.map((row) => {
    const selectedVotingId = selectedPublishedVote?.votingId ?? "";
    const ticketStatusKey = selectedVotingId ? `${row.voterNpub}:${selectedVotingId}` : "";
    const delivery = ticketStatusKey ? ticketDeliveries[ticketStatusKey] : undefined;
    const ticketSent = Boolean(delivery?.status?.startsWith("Ticket sent."));
    const ackSeen = Boolean(
      row.receipt?.tone === "ok"
      || (delivery?.responseId
        && dmAcknowledgements.some((ack) => (
          ack.ackedAction === "simple_round_ticket"
          && ack.responseId === delivery.responseId
        ))),
    );
    const requestId = delivery?.requestId?.trim() || pendingRequests.find(
      (request) =>
        request.voterNpub === row.voterNpub
        && request.votingId === selectedVotingId,
    )?.id?.trim();
    const requestMailboxId = (
      requestId
        ? pendingRequests.find((request) => request.id === requestId)?.mailboxId
        : pendingRequests.find(
          (request) =>
            request.voterNpub === row.voterNpub
            && request.votingId === selectedVotingId,
        )?.mailboxId
    )?.trim();
    const ticketPublishMailboxId = Array.isArray(delivery?.ticketPublishEventTags)
      ? delivery.ticketPublishEventTags.find((tag) => tag[0] === "mailbox")?.[1]?.trim()
      : undefined;
    const mailboxIdConsistentPublishRequest = Boolean(
      requestMailboxId
      && ticketPublishMailboxId
      && requestMailboxId === ticketPublishMailboxId,
    );
    const ticketId = delivery?.responseId?.trim();
    const acceptedByTicket = Boolean(ticketId && activeAcceptedTicketIds.has(ticketId));
    const acceptedByRequest = Boolean(requestId && activeAcceptedRequestIds.has(requestId));
    const acceptedByVoterPubkeyFallback = activeAcceptedVoterPubkeys.has(row.voterNpub);
    const ballotAccepted = Boolean(
      acceptedByTicket
      || acceptedByRequest
      || acceptedByVoterPubkeyFallback,
    );
    const ticketDeliveryConfirmed = isDeliveryConfirmed({ ackSeen, ballotAccepted });
    const attempts = Number(delivery?.attempts ?? 0);
    const publishStarted = Boolean(delivery?.ticketPublishStartedAt);
    const publishSucceeded = Boolean(delivery?.ticketPublishSucceededAt);
    const publishSucceededAtMs = Date.parse(delivery?.ticketPublishSucceededAt ?? "");
    const observeRecoveryAgeElapsed = Number.isFinite(publishSucceededAtMs)
      ? nowMs - publishSucceededAtMs >= ticketObserveRecoveryAgeMs
      : false;
    const retryAgeElapsed = Boolean(
      delivery?.lastAttemptAt
      && Number.isFinite(Date.parse(delivery.lastAttemptAt))
      && nowMs - Date.parse(delivery.lastAttemptAt) >= ticketRetryMinAgeMs,
    );
    let resendBlockedReason: string | null = null;
    if (ticketDeliveryConfirmed) {
      resendBlockedReason = "ticket_already_observed";
    } else if (!delivery) {
      resendBlockedReason = "publish_not_started";
    } else if (!publishStarted) {
      resendBlockedReason = "publish_not_started";
    } else if (attempts >= ticketRetryMaxAttempts) {
      resendBlockedReason = "retry_cap_reached";
    } else if (publishSucceeded && !observeRecoveryAgeElapsed) {
      resendBlockedReason = "observe_recovery_age_not_elapsed";
    } else if (publishSucceeded && !delivery?.ticketLastBackfillAttemptAt) {
      resendBlockedReason = "backfill_not_attempted";
    } else if (!retryAgeElapsed) {
      resendBlockedReason = "retry_age_not_elapsed";
    }
    const resendEligible = resendBlockedReason === null;

    const receipt = ballotAccepted
      ? { tone: "ok", text: "Valid ballot accepted." }
      : ticketSent && !ackSeen
        ? { tone: "pending", text: "Ticket issued. Waiting for acknowledgement or valid ballot submission." }
        : row.receipt;
    const ticketStillMissing = Boolean(ticketSent && !ballotAccepted && !ackSeen);
    const rowInFlight = autoSendInFlightRef.current.has(ticketStatusKey);
    const requestCreatedAtMs = requestId
      ? Date.parse(
        pendingRequests.find((request) => request.id === requestId)?.createdAt ?? "",
      )
      : Number.NaN;
    const sendAttempted = Boolean(delivery?.attempts && delivery.attempts > 0);
    const sendStartedAt = delivery?.ticketPublishStartedAt ?? null;
    let sendBlockedReason: string | null = null;
    if (isCourseFeedbackMode) {
      sendBlockedReason = "course_feedback_legacy_round_bypassed";
    } else if (!selectedVotingId) {
      sendBlockedReason = "no_active_round";
    } else if (!autoSendFollowers[row.voterNpub]) {
      sendBlockedReason = "not_selected_for_auto_send";
    } else if (ticketDeliveryConfirmed) {
      sendBlockedReason = "ticket_already_complete";
    } else if (!requestId) {
      sendBlockedReason = "waiting_for_request";
    } else if (!row.canSendTicket) {
      sendBlockedReason = "row_not_sendable";
    } else if (Boolean(delivery?.ticketPublishStartedAt)) {
      sendBlockedReason = "ticket_already_started";
    } else if (rowInFlight) {
      sendBlockedReason = "send_in_flight";
    } else if (autoSendInFlightRef.current.size >= ticketSendMaxConcurrency) {
      sendBlockedReason = "concurrency_limit";
    }
    const sendEligible = sendBlockedReason === null;

    return {
      ...row,
      receipt,
      ackSeen,
      ballotAccepted,
      acceptedByRequest,
      acceptedByTicket,
      acceptedByVoterPubkeyFallback,
      requestId,
      requestMailboxId,
      ticketId,
      ticketPublishMailboxId,
      mailboxIdConsistentPublishRequest,
      ticketDeliveryConfirmed,
      ticketSent,
      ticketPublishEventId: delivery?.eventId ?? null,
      ticketBuiltAt: delivery?.ticketBuiltAt,
      ticketPublishStartedAt: delivery?.ticketPublishStartedAt,
      ticketPublishSucceededAt: delivery?.ticketPublishSucceededAt,
      ticketLastBackfillAttemptAt: delivery?.ticketLastBackfillAttemptAt,
      ticketResentCount: delivery?.resendCount ?? 0,
      ticketRelayTargets: delivery?.ticketRelayTargets ?? [],
      ticketRelaySuccessCount: delivery?.ticketRelaySuccessCount ?? 0,
      ticketRelayResults: delivery?.relayResults ?? [],
      ticketPublishEventKind: delivery?.ticketPublishEventKind ?? null,
      ticketPublishEventCreatedAt: delivery?.ticketPublishEventCreatedAt ?? null,
      ticketPublishEventTags: delivery?.ticketPublishEventTags ?? [],
      ticketPublishEventContent: delivery?.ticketPublishEventContent ?? null,
      ticketStillMissing,
      sendEligible,
      sendBlockedReason,
      sendAttempted,
      sendStartedAt,
      requestCreatedAtMs: Number.isFinite(requestCreatedAtMs) ? requestCreatedAtMs : null,
      resendEligible,
      resendBlockedReason,
    };
  }), [
    activeAcceptedRequestIds,
    activeAcceptedTicketIds,
    activeAcceptedVoterPubkeys,
    autoSendFollowers,
    coordinatorFollowerRows,
    dmAcknowledgements,
    isCourseFeedbackMode,
    ticketSendMaxConcurrency,
    pendingRequests,
    nowMs,
    selectedPublishedVote?.votingId,
    ticketObserveRecoveryAgeMs,
    ticketRetryMaxAttempts,
    ticketRetryMinAgeMs,
    ticketDeliveries,
  ]);
  const visibleFollowersById = useMemo(
    () => new Map(visibleFollowers.map((follower) => [follower.id, follower])),
    [visibleFollowers],
  );
  const normalizedFollowerSearch = followerSearch.trim().toLowerCase();
  const filteredCoordinatorFollowerRows = useMemo(() => (
    enhancedCoordinatorFollowerRows
      .filter((row) => !invitedKnownVoterSet.has(row.voterNpub))
      .filter((row) => (
        !normalizedFollowerSearch
        || row.voterId.toLowerCase().includes(normalizedFollowerSearch)
      ))
  ), [
    enhancedCoordinatorFollowerRows,
    invitedKnownVoterSet,
    normalizedFollowerSearch,
    visibleFollowersById,
  ]);
  const filteredFollowers = useMemo(
    () =>
      filteredCoordinatorFollowerRows
        .map((row) => visibleFollowersById.get(row.id))
        .filter((follower): follower is SimpleCoordinatorFollower => Boolean(follower)),
    [filteredCoordinatorFollowerRows, visibleFollowersById],
  );
  useEffect(() => {
    const waitingForAcknowledgements = enhancedCoordinatorFollowerRows.filter(
      (row) => row.ticketSent && !row.ackSeen,
    ).length;
    const waitingForCompletionConfirmation = enhancedCoordinatorFollowerRows.filter(
      (row) => row.ticketSent && !row.ticketDeliveryConfirmed,
    ).length;
    const sendQueueEligibleCount = enhancedCoordinatorFollowerRows.filter((row) => row.sendEligible).length;
    const sendQueueStartedCount = enhancedCoordinatorFollowerRows.filter((row) => row.sendAttempted).length;
    const sendQueueBlockedRows = enhancedCoordinatorFollowerRows.filter((row) => !row.sendEligible);
    const sendQueueBlockedCount = sendQueueBlockedRows.length;
    const sendQueueBlockedReasons = sendQueueBlockedRows.reduce((acc, row) => {
      const key = String(row.sendBlockedReason ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const sendQueueInFlightCount = autoSendInFlightRef.current.size;
    const sendQueueUnsentCount = enhancedCoordinatorFollowerRows.filter((row) => !row.sendAttempted).length;
    const ticketSendStartedTimestamps = enhancedCoordinatorFollowerRows
      .map((row) => Date.parse(row.sendStartedAt ?? ""))
      .filter((value) => Number.isFinite(value));
    const lastTicketSendStartedAt = ticketSendStartedTimestamps.length > 0
      ? new Date(Math.max(...ticketSendStartedTimestamps)).toISOString()
      : null;
    const roundOpenAt = selectedPublishedVote?.createdAt ?? null;
    const matchedRequestIds = new Set(
      enhancedCoordinatorFollowerRows
        .filter((row) => row.ballotAccepted && row.requestId)
        .map((row) => String(row.requestId)),
    );
    const matchedTicketIds = new Set(
      enhancedCoordinatorFollowerRows
        .filter((row) => row.ballotAccepted && row.ticketId)
        .map((row) => String(row.ticketId)),
    );
    const unmatchedAcceptedBallots = activeAcceptedVotes
      .filter((entry) => {
        const requestId = entry.request_id?.trim();
        const ticketId = entry.ticket_id?.trim();
        if (!requestId && !ticketId) {
          return true;
        }
        return Boolean(
          (requestId && !matchedRequestIds.has(requestId))
          || (ticketId && !matchedTicketIds.has(ticketId)),
        );
      })
      .map((entry) => ({
        eventId: entry.event_id,
        voterPubkey: entry.voter_pubkey,
        requestId: entry.request_id,
        ticketId: entry.ticket_id,
        roundId: entry.round_id,
      }));
    const rowsWithoutAcceptedBallot = enhancedCoordinatorFollowerRows
      .filter((row) => !row.ballotAccepted)
      .map((row) => ({
        voterPubkey: row.voterNpub,
        ticketSent: row.ticketSent,
        requestId: row.requestId ?? null,
        requestMailboxId: row.requestMailboxId ?? null,
        ticketId: row.ticketId ?? null,
      }));
    const ticketPublishStartedCount = enhancedCoordinatorFollowerRows.filter(
      (row) => Boolean(row.ticketPublishStartedAt),
    ).length;
    const ticketPublishSucceededCount = enhancedCoordinatorFollowerRows.filter(
      (row) => Boolean(row.ticketPublishSucceededAt),
    ).length;
    const ticketStillMissingCount = enhancedCoordinatorFollowerRows.filter(
      (row) => row.ticketStillMissing,
    ).length;
    const ticketResentCount = enhancedCoordinatorFollowerRows.reduce(
      (total, row) => total + Number(row.ticketResentCount ?? 0),
      0,
    );
    const owner = globalThis as typeof globalThis & {
      __simpleCoordinatorDebug?: unknown;
    };
    owner.__simpleCoordinatorDebug = {
      engineStatus: coordinatorEngineStatus,
      runtimeReadiness: coordinatorRuntimeReadiness,
      startupDiagnostics: startupDiagnosticsRef.current,
      blindKeyDiagnostics: blindKeyDiagnosticsRef.current,
      controlStateLabel: coordinatorControlStateLabel,
      waitingForAcknowledgements,
      waitingForCompletionConfirmation,
      sendQueueEligibleCount,
      sendQueueStartedCount,
      sendQueueBlockedCount,
      sendQueueBlockedReasons,
      deploymentMode,
      courseFeedbackAcceptanceEnabled: isCourseFeedbackMode,
      legacyRoundGatingBypassed: isCourseFeedbackMode,
      sendQueueInFlightCount,
      sendQueueUnsentCount,
      roundOpenAt,
      lastTicketSendStartedAt,
      ticketPublishStartedCount,
      ticketPublishSucceededCount,
      ticketStillMissingCount,
      ticketResentCount,
      acceptedBallotCount: activeAcceptedVotes.length,
      rejectedBallotCount: activeRejectedVotes.length,
      acceptedBallotsByRequestId: Array.from(acceptedBallotsByRequestId.entries()),
      acceptedBallotsByTicketId: Array.from(acceptedBallotsByTicketId.entries()),
      unmatchedAcceptedBallots,
      rowsWithoutAcceptedBallot,
      acceptedBallots: activeAcceptedVotes.map((entry) => ({
        eventId: entry.event_id,
        voterPubkey: entry.voter_pubkey,
        requestId: entry.request_id,
        ticketId: entry.ticket_id,
        roundId: entry.round_id,
      })),
      rejectedBallots: activeRejectedVotes.map((entry) => ({
        eventId: entry.event_id,
        voterPubkey: entry.voter_pubkey,
        code: entry.reason.code,
        detail: entry.reason.detail,
      })),
      voters: enhancedCoordinatorFollowerRows.map((row) => ({
        voterPubkey: row.voterNpub,
        ticketSent: row.ticketSent,
        ticketAckSeen: row.ackSeen,
        ballotAccepted: row.ballotAccepted,
        acceptedByRequest: row.acceptedByRequest,
        acceptedByTicket: row.acceptedByTicket,
        requestId: row.requestId,
        ticketPublishEventId: row.ticketPublishEventId,
        requestMailboxId: row.requestMailboxId,
        ticketPublishMailboxId: row.ticketPublishMailboxId,
        mailboxIdConsistentPublishRequest: row.mailboxIdConsistentPublishRequest,
        ticketId: row.ticketId,
        ticketBuiltAt: row.ticketBuiltAt,
        ticketPublishStartedAt: row.ticketPublishStartedAt,
        ticketPublishSucceededAt: row.ticketPublishSucceededAt,
        ticketLastBackfillAttemptAt: row.ticketLastBackfillAttemptAt,
        ticketResentCount: row.ticketResentCount,
        ticketRelayTargets: row.ticketRelayTargets,
        ticketRelaySuccessCount: row.ticketRelaySuccessCount,
        ticketRelayResults: row.ticketRelayResults,
        ticketPublishEventKind: row.ticketPublishEventKind,
        ticketPublishEventCreatedAt: row.ticketPublishEventCreatedAt,
        ticketPublishEventTags: row.ticketPublishEventTags,
        ticketPublishEventContent: row.ticketPublishEventContent,
        ticketStillMissing: row.ticketStillMissing,
        sendEligible: row.sendEligible,
        sendBlockedReason: row.sendBlockedReason,
        sendAttempted: row.sendAttempted,
        sendStartedAt: row.sendStartedAt,
        requestCreatedAtMs: row.requestCreatedAtMs,
        resendEligible: row.resendEligible,
        resendBlockedReason: row.resendBlockedReason,
        ticketDeliveryConfirmed: row.ticketDeliveryConfirmed,
      })),
    };
  }, [
    acceptedBallotsByRequestId,
    acceptedBallotsByTicketId,
    blindKeyDiagnosticsVersion,
    deploymentMode,
    isCourseFeedbackMode,
    selectedPublishedVote?.createdAt,
    coordinatorControlStateLabel,
    coordinatorEngineStatus,
    coordinatorRuntimeReadiness,
    activeAcceptedVotes,
    activeRejectedVotes,
    enhancedCoordinatorFollowerRows,
  ]);
  const verifiedVisibleFollowerCount = filteredFollowers.filter(
    (follower) => autoSendFollowers[follower.voterNpub],
  ).length;
  const allVisibleFollowersVerified =
    filteredFollowers.length > 0
    && verifiedVisibleFollowerCount === filteredFollowers.length;
  const someVisibleFollowersVerified =
    verifiedVisibleFollowerCount > 0
    && verifiedVisibleFollowerCount < filteredFollowers.length;
  const expectedSubCoordinatorCount = Math.max(0, (Number.parseInt(questionThresholdN, 10) || 1) - 1);
  const voteBroadcasted = publishStatus?.startsWith("Vote broadcast.") ?? false;
  const desiredShareAssignmentSignature = useMemo(
    () =>
      isLeadCoordinator && subCoordinators.length > 0
        ? buildShareAssignmentSignature(
            subCoordinators,
            Number.parseInt(questionThresholdN, 10) || undefined,
          )
        : '',
    [isLeadCoordinator, questionThresholdN, subCoordinators],
  );
  const shareAssignmentsCurrent = Boolean(
    desiredShareAssignmentSignature &&
    lastSuccessfulShareAssignmentSignature === desiredShareAssignmentSignature,
  );
  const shareAssignmentButtonLabel = !subCoordinators.length
    ? 'No share indexes needed'
    : shareAssignmentsInFlight
      ? 'Sending share indexes...'
      : shareAssignmentsCurrent
        ? 'Resend share indexes'
        : assignmentStatus?.toLowerCase().includes('fail') ||
            assignmentStatus?.toLowerCase().includes('some')
          ? 'Retry share indexes'
          : 'Send share indexes';

  useEffect(() => {
    if (verifyAllVisibleRef.current) {
      verifyAllVisibleRef.current.indeterminate = someVisibleFollowersVerified;
    }
  }, [someVisibleFollowersVerified]);

  useEffect(() => {
    if (!desiredShareAssignmentSignature) {
      autoShareAssignmentAttemptRef.current = '';
      setLastSuccessfulShareAssignmentSignature('');
    }
  }, [desiredShareAssignmentSignature]);

  useEffect(() => {
    if (
      !isLeadCoordinator ||
      !desiredShareAssignmentSignature ||
      shareAssignmentsInFlight ||
      autoShareAssignmentAttemptRef.current === desiredShareAssignmentSignature
    ) {
      return;
    }

    autoShareAssignmentAttemptRef.current = desiredShareAssignmentSignature;
    void distributeShareIndexes({
      automatic: true,
      signature: desiredShareAssignmentSignature,
    });
  }, [
    desiredShareAssignmentSignature,
    isLeadCoordinator,
    shareAssignmentsInFlight,
  ]);

  useEffect(() => {
    if (!selectedPublishedVote || !activeBlindPrivateKey || !keypair?.npub) {
      return;
    }

    const waitingFollowerCount = visibleFollowers.filter((follower) => (
      !findLatestRoundRequest(pendingRequests, follower.voterNpub, selectedPublishedVote.votingId)
    )).length;

    if (waitingFollowerCount === 0 && activeBlindKeyAnnouncement) {
      return;
    }

    let cancelled = false;

    const refreshBlindKeyAnnouncement = () => {
      const now = Date.now();
      const lastRepublishAt = blindKeyRepublishAtRef.current[selectedPublishedVote.votingId] ?? 0;
      if (now - lastRepublishAt < 8000) {
        return;
      }

      blindKeyRepublishAtRef.current[selectedPublishedVote.votingId] = now;
      void ensureBlindKeyAnnouncementForRound({
        votingId: selectedPublishedVote.votingId,
        blindPrivateKey: activeBlindPrivateKey,
        forceRepublish: waitingFollowerCount > 0 || !activeBlindKeyAnnouncement,
      }).catch(() => {
        if (!cancelled) {
          setPublishStatus("Blind signing key announcement failed.");
        }
      });
    };

    refreshBlindKeyAnnouncement();
    const intervalId = window.setInterval(refreshBlindKeyAnnouncement, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeBlindKeyAnnouncement,
    activeBlindPrivateKey,
    keypair?.npub,
    pendingRequests,
    selectedPublishedVote,
    visibleFollowers,
  ]);

  useEffect(() => {
    const knownParticipants = sortCoordinatorRoster([
      leadCoordinatorNpub,
      ...followers.map((follower) => follower.voterNpub),
      ...subCoordinators.map((application) => application.coordinatorNpub),
    ]);
    if (knownParticipants.length === 0) {
      return;
    }

    void primeNip65RelayHints(knownParticipants, SIMPLE_PUBLIC_RELAYS);
  }, [followers, leadCoordinatorNpub, subCoordinators]);

  useEffect(() => {
    if (!activeVotingId) {
      return;
    }

    const enhancedById = new Map(
      enhancedCoordinatorFollowerRows.map((row) => [row.id, row]),
    );
    const firstSendCandidates = visibleFollowers
      .map((follower) => {
        const ticketStatusKey = `${follower.voterNpub}:${activeVotingId}`;
        const row = enhancedById.get(follower.id);
        if (!row?.sendEligible || autoSendInFlightRef.current.has(ticketStatusKey)) {
          return null;
        }
        return {
          follower,
          requestCreatedAtMs: Number.isFinite(Number(row.requestCreatedAtMs))
            ? Number(row.requestCreatedAtMs)
            : Number.MAX_SAFE_INTEGER,
          voterId: follower.voterId,
          ticketStatusKey,
        };
      })
      .filter((value): value is {
        follower: SimpleCoordinatorFollower;
        requestCreatedAtMs: number;
        voterId: string;
        ticketStatusKey: string;
      } => Boolean(value))
      .sort((left, right) => (
        left.requestCreatedAtMs - right.requestCreatedAtMs
        || left.voterId.localeCompare(right.voterId)
      ));

    for (const candidate of firstSendCandidates) {
      if (autoSendInFlightRef.current.size >= ticketSendMaxConcurrency) {
        break;
      }
      autoSendInFlightRef.current.add(candidate.ticketStatusKey);
      void sendTicket(candidate.follower, { preSendDelayMs: randomHumanActionDelayMs() }).finally(() => {
        autoSendInFlightRef.current.delete(candidate.ticketStatusKey);
      });
    }
  }, [
    activeVotingId,
    enhancedCoordinatorFollowerRows,
    nowMs,
    ticketSendMaxConcurrency,
    visibleFollowers,
  ]);

  useEffect(() => {
    if (!activeVotingId) {
      return;
    }

    const retryFollowerIds = new Set(selectTicketRetryTargetsRust({
      followers: visibleFollowers.map((follower) => ({
        id: follower.id,
        voterNpub: follower.voterNpub,
        voterId: follower.voterId,
        votingId: follower.votingId ?? null,
        createdAt: follower.createdAt,
      })),
      selectedPublishedVotingId: activeVotingId,
      ticketDeliveries,
      acknowledgements: [
        ...dmAcknowledgements.map((ack) => ({
          actorNpub: ack.actorNpub,
          ackedAction: ack.ackedAction,
          ackedEventId: ack.ackedEventId,
          responseId: ack.responseId,
        })),
        ...deliveryCompletionAcknowledgements,
      ],
      nowMs,
      minRetryAgeMs: ticketRetryMinAgeMs,
      maxAttempts: ticketRetryMaxAttempts,
    }));
    for (const row of enhancedCoordinatorFollowerRows) {
      if (row.resendEligible && row.ticketSent) {
        retryFollowerIds.add(row.id);
      }
    }
    const unsentEligibleCount = enhancedCoordinatorFollowerRows.filter((row) => row.sendEligible).length;

    if (unsentEligibleCount > 0) {
      return;
    }

    if (retryFollowerIds.size === 0) {
      return;
    }

    const enhancedById = new Map(
      enhancedCoordinatorFollowerRows.map((row) => [row.id, row]),
    );
    const resendCandidates = visibleFollowers
      .map((follower) => {
        const ticketStatusKey = `${follower.voterNpub}:${activeVotingId}`;
        const row = enhancedById.get(follower.id);
        if (!retryFollowerIds.has(follower.id) || !autoSendFollowers[follower.voterNpub] || !row?.resendEligible) {
          return null;
        }
        const lastAttemptMs = Date.parse(row.ticketPublishSucceededAt ?? row.ticketPublishStartedAt ?? "");
        return {
          follower,
          ticketStatusKey,
          lastAttemptMs: Number.isFinite(lastAttemptMs) ? lastAttemptMs : 0,
          voterId: follower.voterId,
        };
      })
      .filter((value): value is {
        follower: SimpleCoordinatorFollower;
        ticketStatusKey: string;
        lastAttemptMs: number;
        voterId: string;
      } => Boolean(value))
      .sort((left, right) => (
        left.lastAttemptMs - right.lastAttemptMs
        || left.voterId.localeCompare(right.voterId)
      ));

    for (const candidate of resendCandidates) {
      if (autoSendInFlightRef.current.size >= ticketSendMaxConcurrency) {
        break;
      }
      const follower = candidate.follower;
      const ticketStatusKey = candidate.ticketStatusKey;
      const existingBeforeResend = ticketDeliveries[ticketStatusKey];
      if (existingBeforeResend?.ticketPublishSucceededAt && !existingBeforeResend.ticketLastBackfillAttemptAt) {
        setTicketDeliveries((current) => {
          const existing = current[ticketStatusKey];
          if (!existing) {
            return current;
          }
          return {
            ...current,
            [ticketStatusKey]: {
              ...existing,
              ticketLastBackfillAttemptAt: new Date().toISOString(),
              ticketStillMissing: true,
            },
          };
        });
        continue;
      }
      setTicketDeliveries((current) => {
        const existing = current[ticketStatusKey];
        if (!existing) {
          return current;
        }
        return {
          ...current,
          [ticketStatusKey]: {
            ...existing,
            ticketLastBackfillAttemptAt: new Date().toISOString(),
            ticketStillMissing: true,
          },
        };
      });
      if (autoSendInFlightRef.current.has(ticketStatusKey)) {
        continue;
      }

      autoSendInFlightRef.current.add(ticketStatusKey);
      void sendTicket(follower, { preSendDelayMs: randomHumanActionDelayMs() }).finally(() => {
        autoSendInFlightRef.current.delete(ticketStatusKey);
      });
    }
  }, [
    activeVotingId,
    autoSendFollowers,
    enhancedCoordinatorFollowerRows,
    deliveryCompletionAcknowledgements,
    dmAcknowledgements,
    nowMs,
    ticketDeliveries,
    ticketRetryMaxAttempts,
    ticketRetryMinAgeMs,
    ticketSendMaxConcurrency,
    visibleFollowers,
  ]);

  if (storageLocked && !identityReady) {
    return (
      <SimpleUnlockGate
        roleLabel="Coordinator"
        status={storageStatus}
        onUnlock={unlockLocalState}
        onReset={async () => {
          await clearSimpleActorState("coordinator");
          setStorageLocked(false);
          setStoragePassphrase("");
          const nextKeypair = createSimpleCoordinatorKeypair();
          await saveSimpleActorState({
            role: "coordinator",
            keypair: nextKeypair,
            updatedAt: new Date().toISOString(),
          });
          setKeypair(nextKeypair);
          setIdentityReady(true);
          setStorageStatus("Locked local coordinator state reset.");
        }}
      />
    );
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>ID {coordinatorId}</h1>
          <div className='simple-coordinator-header-actions'>
            {activeCoordinatorNpub ? (
              <TokenFingerprint
                tokenId={activeCoordinatorNpub}
                compact
                showQr
                hideMetadata
                qrValue={activeCoordinatorNpub}
              />
            ) : null}
            <button
              type='button'
              className='simple-voter-secondary'
              onClick={() => void tryWriteClipboard(activeCoordinatorNpub)}
              disabled={!activeCoordinatorNpub}
            >
              Copy npub
            </button>
          </div>
        </div>
        {signerNpub ? <p className='simple-voter-note simple-signed-in-note'>Signed in as {signerNpub}</p> : null}
        {signerStatus && signerStatus !== `Signed in as ${signerNpub}.` ? <p className='simple-voter-note'>{signerStatus}</p> : null}
        <div
          className='simple-voter-tabs'
          role='tablist'
          aria-label='Coordinator sections'
        >
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'configure'}
            className={`simple-voter-tab${activeTab === 'configure' ? ' is-active' : ''}`}
            onClick={() => selectTab('configure')}
          >
            Build
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'delegate'}
            className={`simple-voter-tab${activeTab === 'delegate' ? ' is-active' : ''}`}
            onClick={() => selectTab('delegate')}
          >
            Delegate
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'participants'}
            className={`simple-voter-tab${activeTab === 'participants' ? ' is-active' : ''}`}
            onClick={() => selectTab('participants')}
          >
            Invite
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'voting'}
            className={`simple-voter-tab${activeTab === 'voting' ? ' is-active' : ''}`}
            onClick={() => selectTab('voting')}
          >
            Results
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'settings'}
            className={`simple-voter-tab${activeTab === 'settings' ? ' is-active' : ''}`}
            onClick={() => selectTab('settings')}
          >
            Settings
          </button>
        </div>

        {activeTab === 'configure' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Build'
          >
            <SimpleCollapsibleSection title='Coordinator management' defaultCollapsed>
              <label
                className='simple-voter-label'
                htmlFor='simple-lead-coordinator-npub'
              >
                Lead coordinator npub
              </label>
              <div className='simple-voter-inline-field'>
                <input
                  id='simple-lead-coordinator-npub'
                  className='simple-voter-input simple-voter-input-inline'
                  value={leadCoordinatorNpub}
                  onChange={(event) => {
                    const nextLeadCoordinatorNpub = event.target.value;
                    setLeadCoordinatorNpub(nextLeadCoordinatorNpub);
                    setLeadScannerStatus(null);
                    if (
                      nextLeadCoordinatorNpub.trim() !== (keypair?.npub ?? '')
                    ) {
                      setQuestionShareIndex('');
                    }
                    setRegistrationStatus(null);
                    setAssignmentStatus(null);
                  }}
                  placeholder='Leave blank if this coordinator is the lead'
                />
                <button
                  type='button'
                  className='simple-voter-secondary simple-voter-scan-button'
                  onClick={() => {
                    setLeadScannerStatus(null);
                    setLeadScannerActive(true);
                  }}
                >
                  Scan
                </button>
                {canShowNotifyLeadButton ? (
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void submitToLeadCoordinator()}
                    disabled={
                      !keypair?.nsec ||
                      !leadCoordinatorNpub.trim() ||
                      leadCoordinatorNpub.trim() === (keypair?.npub ?? '') ||
                      hasAssignedShareIndex
                    }
                  >
                    {hasAssignedShareIndex
                      ? 'Coordinator notified'
                      : 'Notify coordinator'}
                  </button>
                ) : null}
              </div>
              <SimpleQrScanner
                active={leadScannerActive}
                onDetected={handleLeadCoordinatorScanDetected}
                onClose={() => setLeadScannerActive(false)}
                prompt='Point the camera at the lead coordinator npub QR code.'
              />
              {leadScannerStatus ? (
                <p className='simple-voter-note'>{leadScannerStatus}</p>
              ) : null}
              <p className='simple-voter-question'>
                {isLeadCoordinator
                  ? 'This coordinator publishes the live question.'
                  : 'This coordinator follows the lead question and only issues shares.'}
              </p>
              {registrationStatus &&
                !isLeadCoordinator &&
                !hasAssignedShareIndex && (
                  <p className='simple-voter-note'>{registrationStatus}</p>
                )}
              {assignmentStatus && (
                <p className='simple-voter-note'>{assignmentStatus}</p>
              )}
            {isLeadCoordinator && (
              <SimpleCollapsibleSection title='Sub-coordinators'>
                {subCoordinators.length > 0 ? (
                  <>
                    <p className='simple-voter-question'>
                      {subCoordinators.length} sub-coordinator
                      {subCoordinators.length === 1 ? '' : 's'} submitted
                      {expectedSubCoordinatorCount > 0
                        ? ` of ${expectedSubCoordinatorCount} expected`
                        : ''}
                      .
                    </p>
                    <ul className='simple-voter-list'>
                      {subCoordinators.map((application, index) => (
                        <li
                          key={application.id}
                          className='simple-voter-list-item'
                        >
                          <p className='simple-voter-question'>
                            Coordinator {application.coordinatorId} submitted as
                            sub-coordinator #{index + 1}.
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className='simple-voter-empty'>
                    No sub-coordinators have submitted yet.
                  </p>
                )}
              </SimpleCollapsibleSection>
            )}
            </SimpleCollapsibleSection>

            <SimpleCollapsibleSection title='Questionnaire draft'>
              <QuestionnaireCoordinatorPanel
                coordinatorNsec={keypair?.nsec ?? null}
                coordinatorNpub={keypair?.npub ?? null}
                knownVoterCount={optionAKnownVoterCount}
                optionAAcceptedCount={optionAAcceptedCount}
                optionAAcceptedResponses={optionAAcceptedResponses}
                blindSigningPublicKey={optionABlindSigningPublicKey}
                view='build'
                onInviteParticipants={() => selectTab('participants')}
                onConfigureWorker={() => selectTab('delegate')}
                onStatusChange={updateQuestionnaireRosterAnnouncement}
              />
            </SimpleCollapsibleSection>
          </section>
        ) : null}

        {activeTab === 'delegate' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Delegate'
          >
            <QuestionnaireCoordinatorPanel
              coordinatorNsec={keypair?.nsec ?? null}
              coordinatorNpub={keypair?.npub ?? null}
              knownVoterCount={optionAKnownVoterCount}
              optionAAcceptedCount={optionAAcceptedCount}
              optionAAcceptedResponses={optionAAcceptedResponses}
              blindSigningPublicKey={optionABlindSigningPublicKey}
              view='delegate'
              onStatusChange={updateQuestionnaireRosterAnnouncement}
            />
          </section>
        ) : null}


        {activeTab === 'participants' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Participants'
          >
            <SimpleCollapsibleSection title='Vote requests' defaultCollapsed>
              {coordinatorFollowerRows.length > 0 ? (
                <div className='simple-follower-toolbar'>
                  <input
                    id='simple-follower-search'
                    className='simple-voter-input'
                    value={followerSearch}
                    onChange={(event) => setFollowerSearch(event.target.value)}
                    placeholder='Search by voter ID...'
                  />
                  <label className='simple-follower-auto-send simple-follower-auto-send-bulk'>
                    <input
                      ref={verifyAllVisibleRef}
                      type='checkbox'
                      checked={allVisibleFollowersVerified}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setAutoSendFollowers((current) => ({
                          ...current,
                          ...Object.fromEntries(
                            filteredFollowers.map((follower) => [follower.voterNpub, checked]),
                          ),
                        }));
                      }}
                    />
                    <span>Verify all</span>
                  </label>
                </div>
              ) : null}
              {filteredCoordinatorFollowerRows.length > 0 ? (
                <ul className='simple-voter-list'>
                  {filteredCoordinatorFollowerRows.map((row) => {
                    const follower = visibleFollowersById.get(row.id);
                    if (!follower) {
                      return null;
                    }

                    const waitingForBlindedRequest = Boolean(
                      !isCourseFeedbackMode &&
                      selectedPublishedVote &&
                      !findLatestRoundRequest(
                        pendingRequests,
                        follower.voterNpub,
                        selectedPublishedVote.votingId,
                      ),
                    );
                    const ticketStatusKey = selectedPublishedVote
                      ? `${follower.voterNpub}:${selectedPublishedVote.votingId}`
                      : '';
                    const ticketDelivery = ticketStatusKey
                      ? ticketDeliveries[ticketStatusKey]
                      : undefined;
                    const isTicketSending =
                      ticketDelivery?.status === 'Sending ticket...';
                    const ticketDeliveryConfirmed = row.ticketDeliveryConfirmed;
                    const lastAttemptAtMs = ticketDelivery?.lastAttemptAt
                      ? Date.parse(ticketDelivery.lastAttemptAt)
                      : Number.NaN;
                    const showResendTicket = Boolean(
                      selectedPublishedVote &&
                      ticketDelivery &&
                      !ticketDeliveryConfirmed &&
                      Number.isFinite(lastAttemptAtMs) &&
                      nowMs - lastAttemptAtMs >= ticketRetryMinAgeMs,
                    );

                    return (
                      <li key={row.id} className='simple-voter-list-item'>
                        <div className='simple-follower-row'>
                          <label className='simple-follower-auto-send simple-follower-auto-send-inline'>
                            <input
                              type='checkbox'
                              checked={Boolean(
                                autoSendFollowers[follower.voterNpub],
                              )}
                              onChange={(event) => {
                                setAutoSendFollowers((current) => ({
                                  ...current,
                                  [follower.voterNpub]: event.target.checked,
                                }));
                              }}
                            />
                            <span>Verified</span>
                          </label>
                          <div className='simple-follower-row-main'>
                            <p className='simple-voter-question'>
                              {row.followingText}
                            </p>
                            <ul className='simple-delivery-diagnostics'>
                              <li
                                className={deliveryToneClass(row.follow.tone)}
                              >
                                {row.follow.text}
                              </li>
                              {questionnaireFlowActive ? (
                                <li className='simple-delivery-ok'>
                                  Blind ballot requests and responses are synced below.
                                </li>
                              ) : (
                                <>
                                  <li
                                    className={deliveryToneClass(
                                      row.pendingRequest.tone,
                                    )}
                                  >
                                    {row.pendingRequest.text}
                                  </li>
                                  <li
                                    className={deliveryToneClass(row.ticket.tone)}
                                  >
                                    {row.ticket.text}
                                  </li>
                                </>
                              )}
                              {row.receipt && !questionnaireFlowActive ? (
                                <li
                                  className={deliveryToneClass(
                                    row.receipt.tone,
                                  )}
                                >
                                  {row.receipt.text}
                                </li>
                              ) : null}
                            </ul>
                            {ticketDelivery?.relayResults?.length ? (
                              <div className='simple-ticket-relay-results'>
                                <p className='simple-ticket-relay-results-title'>
                                  Ticket relay publish results
                                </p>
                                <ul className='simple-ticket-relay-results-list'>
                                  {ticketDelivery.relayResults.map((result) => (
                                    <li
                                      key={`${ticketStatusKey}:${result.relay}`}
                                      className={result.success ? 'simple-ticket-relay-result-ok' : 'simple-ticket-relay-result-error'}
                                    >
                                      <span className='simple-ticket-relay-result-host'>
                                        {formatRelayHost(result.relay)}
                                      </span>
                                      <span className='simple-ticket-relay-result-status'>
                                        {result.success ? 'sent' : (result.error ?? 'failed')}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            ) : null}
                          </div>
                          <div className='simple-follower-row-controls'>
                            {showResendTicket ? (
                              <button
                                type='button'
                                className='simple-voter-secondary'
                                onClick={() => void sendTicket(follower)}
                                disabled={!row.canSendTicket || isTicketSending}
                              >
                                Resend ticket
                              </button>
                            ) : null}
                            {waitingForBlindedRequest ? (
                              <button
                                type='button'
                                className='simple-voter-secondary'
                                onClick={() => void resendRoundInfo(follower)}
                                disabled={!activeBlindPrivateKey || isCourseFeedbackMode}
                              >
                                Resend round info
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : coordinatorFollowerRows.length > 0 ? (
                <p className='simple-voter-empty'>No matching voters found.</p>
              ) : (
                <p className='simple-voter-empty'>
                  No voters are following this coordinator yet.
                </p>
              )}
            </SimpleCollapsibleSection>

            {optionAElectionId ? (
              <SimpleCollapsibleSection title='Invite voters'>
                <div className='simple-voter-field-stack'>
                  <div className='simple-voter-action-row simple-voter-action-row-inline'>
                    <input
                      className='simple-voter-input simple-voter-input-inline'
                      value={knownVoterDraftNpub}
                      placeholder='npub1... or nostr:nprofile1...'
                      onChange={(event) => setKnownVoterDraftNpub(event.target.value)}
                    />
                    <button
                      type='button'
                      className='simple-voter-secondary'
                      disabled={!knownVoterDraftNpub.trim()}
                      onClick={() => void inviteKnownVoterNpub()}
                    >
                      Invite
                    </button>
                    <button
                      type='button'
                      className='simple-voter-secondary'
                      onClick={() => void importKnownVotersFromContacts()}
                      disabled={knownVoterContactsLoading || !activeCoordinatorNpub}
                    >
                      {knownVoterContactsLoading ? 'Importing...' : 'Import contacts'}
                    </button>
                    <button
                      type='button'
                      className='simple-voter-secondary'
                      onClick={processKnownVoterRequests}
                    >
                      Process requests
                    </button>
                  </div>
                  {importedKnownVoterContacts.length > 0 ? (
                    <div className='simple-voter-field-stack'>
                      <label className='simple-voter-label' htmlFor='known-voter-contact-search'>
                        Imported contacts
                      </label>
                      <input
                        id='known-voter-contact-search'
                        className='simple-voter-input'
                        value={knownVoterContactSearch}
                        onChange={(event) => setKnownVoterContactSearch(event.target.value)}
                        placeholder='Search by name, NIP-05, or npub'
                      />
                      <div className='simple-voter-action-row simple-voter-action-row-inline'>
                        <button
                          type='button'
                          className='simple-voter-secondary'
                          onClick={toggleSelectAllVisibleImportedKnownVoters}
                          disabled={filteredImportedKnownVoterContacts.length === 0}
                        >
                          {filteredImportedKnownVoterContacts.length > 0 && filteredImportedKnownVoterContacts.every((entry) => selectedImportedKnownVoterSet.has(entry.npub))
                            ? 'Clear visible'
                            : 'Select all visible'}
                        </button>
                        <p className='simple-voter-note'>
                          {selectedImportedKnownVoterNpubs.length} selected
                        </p>
                      </div>
                      <div className='simple-imported-contact-list' role='list' aria-label='Imported contact candidates'>
                        {filteredImportedKnownVoterContacts.length > 0 ? filteredImportedKnownVoterContacts.map((contact) => {
                          const label = contact.profileName ?? contact.petname ?? contact.nip05 ?? deriveActorDisplayId(contact.npub);
                          return (
                            <label key={contact.npub} className='simple-imported-contact-row' role='listitem'>
                              <input
                                type='checkbox'
                                checked={selectedImportedKnownVoterSet.has(contact.npub)}
                                onChange={() => toggleImportedKnownVoterSelection(contact.npub)}
                              />
                              <span className='simple-imported-contact-copy'>
                                <span className='simple-imported-contact-primary'>{label}</span>
                                <span className='simple-imported-contact-secondary'>
                                  {contact.nip05 ? `${contact.nip05} · ` : ''}{contact.npub}
                                </span>
                              </span>
                            </label>
                          );
                        }) : (
                          <p className='simple-voter-note'>No contacts match your filter.</p>
                        )}
                      </div>
                      <div className='simple-voter-action-row simple-voter-action-row-inline'>
                        <button
                          type='button'
                          className='simple-voter-secondary'
                          onClick={addSelectedImportedContactsToWhitelist}
                          disabled={selectedImportedKnownVoterNpubs.length === 0}
                        >
                          Add selected to whitelist
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {visibleOptionAKnownVoters.length > 0 ? (
                    <>
                      <ul className='simple-vote-status-list'>
                        {visibleOptionAKnownVoters.map((entry) => (
                          <li key={entry.invitedNpub}>
                            <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
                            {deriveActorDisplayId(entry.invitedNpub)} - {entry.claimState}
                            <button
                              type='button'
                              className='simple-voter-secondary'
                              style={{ marginLeft: 8 }}
                              onClick={() => sendInviteToKnownVoter(entry.invitedNpub)}
                            >
                              {entry.claimState === "invited" ? "Resend invite" : "Send invite"}
                            </button>
                          </li>
                        ))}
                      </ul>
                      <div className='simple-voter-action-row simple-voter-action-row-inline'>
                        <button
                          type='button'
                          className='simple-voter-secondary'
                          onClick={sendInvitesToAllWhitelistedVoters}
                          disabled={visibleOptionAKnownVoters.length === 0}
                        >
                          Invite all whitelisted
                        </button>
                        <button
                          type='button'
                          className='simple-voter-secondary'
                          onClick={processKnownVoterRequests}
                        >
                          Check responses
                        </button>
                      </div>
                    </>
                  ) : optionAHasInviteQueue ? null : (
                    <p className='simple-voter-note'>No known voters added yet for this questionnaire.</p>
                  )}
                  {optionAPendingAuthorizations.length > 0 ? (
                    <>
                      <p className='simple-voter-note'>Pending requester authorisation</p>
                      <ul className='simple-vote-status-list'>
                        {optionAPendingAuthorizations.map((entry) => (
                          <li key={entry.invitedNpub}>
                            <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
                            {deriveActorDisplayId(entry.invitedNpub)} requested a ballot ({entry.requestCount})
                            <button
                              type='button'
                              className='simple-voter-secondary'
                              style={{ marginLeft: 8 }}
                              onClick={() => authorizePendingRequester(entry.invitedNpub)}
                            >
                              Authorise
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <p className='simple-voter-note'>Accepted unique responders: {optionACoordinatorRuntime?.getAcceptedUniqueCount() ?? 0}</p>
                  {knownVoterInviteStatus ? <p className='simple-voter-note'>{knownVoterInviteStatus}</p> : null}
                </div>
              </SimpleCollapsibleSection>
            ) : null}
            <QuestionnaireCoordinatorPanel
              coordinatorNsec={keypair?.nsec ?? null}
              coordinatorNpub={keypair?.npub ?? null}
              knownVoterCount={optionAKnownVoterCount}
              optionAAcceptedCount={optionAAcceptedCount}
              optionAAcceptedResponses={optionAAcceptedResponses}
              blindSigningPublicKey={optionABlindSigningPublicKey}
              view='participants'
              onStatusChange={updateQuestionnaireRosterAnnouncement}
            />
          </section>
        ) : null}
        {activeTab === 'voting' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Responses'
          >
            <div className='simple-voter-action-row simple-voter-action-row-inline'>
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={processKnownVoterRequests}
              >
                Check responses
              </button>
            </div>
            <QuestionnaireCoordinatorPanel
              coordinatorNsec={keypair?.nsec ?? null}
              coordinatorNpub={keypair?.npub ?? null}
              knownVoterCount={optionAKnownVoterCount}
              optionAAcceptedCount={optionAAcceptedCount}
              optionAAcceptedResponses={optionAAcceptedResponses}
              blindSigningPublicKey={optionABlindSigningPublicKey}
              view='responses'
              onStatusChange={updateQuestionnaireRosterAnnouncement}
            />
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Settings'
          >
            <SimpleIdentityPanel
              npub={activeCoordinatorNpub}
              nsec={signerNpub ? '' : (keypair?.nsec ?? '')}
              title='Identity'
              onRestoreNsec={restoreIdentity}
              restoreMessage={identityStatus}
              onDownloadBackup={identityReady ? downloadBackup : undefined}
              onRestoreBackupFile={restoreBackup}
              backupMessage={backupStatus}
              onProtectLocalState={
                identityReady ? protectLocalState : undefined
              }
              onDisableLocalStateProtection={
                identityReady ? disableLocalStateProtection : undefined
              }
              localStateProtected={Boolean(storagePassphrase)}
              localStateMessage={storageStatus}
            />
            <section
              className='simple-settings-card'
              aria-label='Relay hint settings'
            >
              <h3 className='simple-voter-question'>Relay hints</h3>
              <label className='simple-settings-toggle'>
                <input
                  type='checkbox'
                  checked={nip65Enabled}
                  onChange={(event) => setNip65Enabled(event.target.checked)}
                />
                <span>Enable NIP-65 relay hints</span>
              </label>
              <p className='simple-voter-note'>
                Disabled by default. Turn this on only if you want to publish
                and use NIP-65 inbox/outbox relay hints.
              </p>
            </section>
            <SimpleRelayPanel />
          </section>
        ) : null}
      </section>
    </main>
  );
}

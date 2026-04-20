import { useEffect, useMemo, useRef, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec, isValidNpub } from "./nostrIdentity";
import { deriveActorDisplayId } from "./actorDisplay";
import QuestionnaireVoterPanel from "./QuestionnaireVoterPanel";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import SimpleQrScanner from "./SimpleQrScanner";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUnlockGate from "./SimpleUnlockGate";
import TokenFingerprint from "./TokenFingerprint";
import { extractNpubFromScan } from "./npubScan";
import {
  primeNip65RelayHints,
  setNip65EnabledForSession,
} from "./nip65RelayHints";
import { formatRoundOptionLabel } from "./roundLabel";
import {
  deriveTokenIdFromSimplePublicShardProofs,
  createSimpleBlindIssuanceRequest,
  fetchLatestSimpleBlindKeyAnnouncement,
  parseSimpleShardCertificate,
  subscribeLatestSimpleBlindKeyAnnouncement,
  unblindSimpleBlindShare,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindRequestSecret,
} from "./simpleShardCertificate";
import {
  subscribeSimpleCoordinatorRosterAnnouncements,
  fetchSimpleShardResponses,
  recordSimpleTicketLifecycleTrace,
  sendSimpleCoordinatorFollow,
  sendSimpleDmAcknowledgement,
  sendSimpleShardRequest,
  subscribeSimpleDmAcknowledgements,
  subscribeSimpleShardResponses,
  type SimpleDmAcknowledgement,
  type SimpleShardRequest,
  type SimpleShardResponse,
} from "./simpleShardDm";
import {
  fetchLatestSimpleLiveVote,
  publishSimpleSubmittedVote,
  SIMPLE_PUBLIC_RELAYS,
  subscribeLatestSimpleLiveVote,
  type SimpleLiveVoteSession,
} from "./simpleVotingSession";
import {
  fetchQuestionnaireEventsWithFallback,
  parseQuestionnaireDefinitionEvent,
  parseQuestionnaireStateEvent,
  QUESTIONNAIRE_DEFINITION_KIND,
  QUESTIONNAIRE_STATE_KIND,
} from "./questionnaireNostr";
import { fetchOptionAInviteDms, fetchOptionAInviteDmsWithNsec } from "./questionnaireOptionAInviteDm";
import { publishInviteToMailbox } from "./questionnaireOptionAStorage";
import {
  selectLatestQuestionnaireDefinition,
  selectLatestQuestionnaireState,
} from "./questionnaireRuntime";
import { buildSimpleVoteTicketRows } from "./simpleRoundState";
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
  buildVoterCoordinatorDiagnosticsRust,
  normalizeCoordinatorNpubsRust,
  selectFollowRetryTargetsRust,
  selectRequestRetryKeysRust,
} from "./wasm/auditableVotingCore";
import {
  ProtocolStateService,
  SIMPLE_PUBLIC_ELECTION_ID,
  type ProtocolStateCache,
} from "./services/ProtocolStateService";
import { type MailboxReadQueryDebug } from "./simpleMailbox";
import { createSignerService, SignerServiceError } from "./services/signerService";

type LiveVoteChoice = "Yes" | "No" | null;
type VoterTab = "configure" | "vote" | "settings";

type SimpleVoterKeypair = {
  nsec: string;
  npub: string;
};
const GATEWAY_SIGNER_NPUB_STORAGE_KEY = "app:auditable-voting:gateway:signer_npub";

type PendingBlindRequest = {
  coordinatorNpub: string;
  votingId: string;
  replyNpub: string;
  request: SimpleShardRequest["blindRequest"];
  secret: SimpleBlindRequestSecret;
  createdAt: string;
  dmEventId?: string;
  mailboxId?: string;
  mailboxSalt?: string;
  mailboxFrozenAt?: string;
  mailboxFrozenValue?: string;
};

type RoundReplyKeypair = {
  npub: string;
  nsec: string;
};

type TicketBackfillRequestDebug = {
  attemptCount: number;
  lastAttemptAt: string | null;
  lastResultCount: number;
  lastMatchedCount: number;
  requestMailboxId: string | null;
  ticketReadMailboxId: string | null;
  ticketBackfillMailboxId: string | null;
  lastSourceRelays: string[];
};

type TicketMailboxMismatch = {
  requestId: string;
  expectedMailboxId: string;
  observedMailboxId: string;
  observedAt: string;
};

type SimpleVoterCache = {
  manualCoordinators: string[];
  nip65Enabled: boolean;
  questionnaireParticipationHistory: Array<{
    questionnaireId: string;
    title: string;
    coordinatorPubkey: string;
    submissionCount: number;
    lastSubmittedAt: number;
  }>;
  protocolStateCache?: ProtocolStateCache | null;
  requestStatus: string | null;
  receivedShards: SimpleShardResponse[];
  pendingBlindRequests: Record<string, PendingBlindRequest>;
  roundReplyKeypairs: Record<string, RoundReplyKeypair>;
  followDeliveries: Record<string, { status: string; eventId?: string; attempts?: number; lastAttemptAt?: string }>;
  requestDeliveries: Record<string, { status: string; eventId?: string; requestId?: string; attempts?: number; lastAttemptAt?: string }>;
  submitStatus: string | null;
  selectedVotingId: string;
  liveVoteChoice: LiveVoteChoice;
};

function sanitizeCoordinatorNpubs(values: string[]) {
  return normalizeCoordinatorNpubsRust(values).filter((value) => isValidNpub(value));
}

const SIMPLE_PUBLIC_ROUND_BACKFILL_INTERVAL_MS = 4000;
const SIMPLE_HUMAN_ACTION_JITTER_MAX_MS = 30000;
const SIMPLE_FOLLOW_RETRY_MIN_AGE_MS = 30000;
const SIMPLE_FOLLOW_RETRY_INTERVAL_MS = 10000;
const SIMPLE_REQUEST_RETRY_MIN_AGE_MS = 30000;
const SIMPLE_REQUEST_RETRY_INTERVAL_MS = 10000;
const QUESTIONNAIRE_ANNOUNCEMENT_VERIFY_INTERVAL_MS = 7000;

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

function createEmptyVoterCache(): SimpleVoterCache {
  return {
    manualCoordinators: [],
    nip65Enabled: false,
    questionnaireParticipationHistory: [],
    protocolStateCache: null,
    requestStatus: null,
    receivedShards: [],
    pendingBlindRequests: {},
    roundReplyKeypairs: {},
    followDeliveries: {},
    requestDeliveries: {},
    submitStatus: null,
    selectedVotingId: "",
    liveVoteChoice: null,
  };
}

function shortenNpub(value: string) {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function createSimpleVoterKeypair(): SimpleVoterKeypair {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

function equalReceivedShards(
  left: SimpleShardResponse[],
  right: SimpleShardResponse[],
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => {
    const next = right[index];
    return (
      value.id === next?.id
      && value.requestId === next?.requestId
      && value.coordinatorNpub === next?.coordinatorNpub
      && Boolean(value.shardCertificate) === Boolean(next?.shardCertificate)
    );
  });
}

function createRoundTokenMessage(votingId: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${votingId}:${randomPart}`;
}

function makeRoundBlindKeyId(coordinatorNpub: string, votingId: string) {
  return `${coordinatorNpub}:${votingId}`;
}

function formatMissingCoordinatorKeyText(indices: number[]) {
  if (indices.length === 0) {
    return 'Waiting for a coordinator key before preparing ticket request.';
  }
  if (indices.length === 1) {
    return `Waiting for Coordinator ${indices[0]}'s key before preparing ticket request.`;
  }
  if (indices.length === 2) {
    return `Waiting for Coordinators ${indices[0]} and ${indices[1]}' keys before preparing ticket request.`;
  }

  const leading = indices.slice(0, -1).join(', ');
  const trailing = indices[indices.length - 1];
  return `Waiting for Coordinators ${leading}, and ${trailing}' keys before preparing ticket request.`;
}

function readDeploymentModeFromUrl() {
  if (typeof window === "undefined") {
    return "legacy";
  }
  return (new URLSearchParams(window.location.search).get("deployment") ?? "legacy")
    .trim()
    .toLowerCase();
}

function readLinkedQuestionnaireIdFromUrl() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim();
}

async function verifyAnnouncedQuestionnaireIsReady(questionnaireId: string) {
  const [definitionFetch, stateFetch] = await Promise.all([
    fetchQuestionnaireEventsWithFallback({
      questionnaireId,
      kind: QUESTIONNAIRE_DEFINITION_KIND,
      parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
      limit: 50,
    }),
    fetchQuestionnaireEventsWithFallback({
      questionnaireId,
      kind: QUESTIONNAIRE_STATE_KIND,
      parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
      limit: 50,
    }),
  ]);
  const latestDefinition = selectLatestQuestionnaireDefinition(definitionFetch.events);
  const latestState = String(selectLatestQuestionnaireState(stateFetch.events)?.state ?? "");
  if (!latestDefinition) {
    return false;
  }
  return latestState === "open" || latestState === "published";
}

export default function SimpleUiApp() {
  const [voterKeypair, setVoterKeypair] = useState<SimpleVoterKeypair | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [voterId, setVoterId] = useState<string>("pending");
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([]);
  const [nip65Enabled, setNip65Enabled] = useState(false);
  const [questionnaireParticipationHistory, setQuestionnaireParticipationHistory] = useState<
    SimpleVoterCache["questionnaireParticipationHistory"]
  >([]);
  const [coordinatorDraft, setCoordinatorDraft] = useState("");
  const [coordinatorScannerActive, setCoordinatorScannerActive] = useState(false);
  const [coordinatorScannerStatus, setCoordinatorScannerStatus] = useState<string | null>(null);
  const linkedQuestionnaireId = useMemo(() => readLinkedQuestionnaireIdFromUrl(), []);
  const [announcedQuestionnaireIds, setAnnouncedQuestionnaireIds] = useState<string[]>(() => (
    linkedQuestionnaireId ? [linkedQuestionnaireId] : []
  ));
  const [readyAnnouncedQuestionnaireIds, setReadyAnnouncedQuestionnaireIds] = useState<string[]>(() => (
    linkedQuestionnaireId ? [linkedQuestionnaireId] : []
  ));
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);
  const [signerNpub, setSignerNpub] = useState<string>("");
  const [signerStatus, setSignerStatus] = useState<string | null>(null);
  const activeVoterNpub = signerNpub.trim() || voterKeypair?.npub?.trim() || "";
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [storagePassphrase, setStoragePassphrase] = useState("");
  const [storageLocked, setStorageLocked] = useState(false);
  const [storageStatus, setStorageStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [pendingBlindRequests, setPendingBlindRequests] = useState<Record<string, PendingBlindRequest>>({});
  const [roundReplyKeypairs, setRoundReplyKeypairs] = useState<Record<string, RoundReplyKeypair>>({});
  const [followDeliveries, setFollowDeliveries] = useState<Record<string, { status: string; eventId?: string; attempts?: number; lastAttemptAt?: string }>>({});
  const [requestDeliveries, setRequestDeliveries] = useState<Record<string, { status: string; eventId?: string; requestId?: string; attempts?: number; lastAttemptAt?: string }>>({});
  const [dmAcknowledgements, setDmAcknowledgements] = useState<SimpleDmAcknowledgement[]>([]);
  const [discoveredSessions, setDiscoveredSessions] = useState<SimpleLiveVoteSession[]>([]);
  const [protocolStateCache, setProtocolStateCache] = useState<ProtocolStateCache | null>(null);
  const [derivedPublicRounds, setDerivedPublicRounds] = useState<SimpleLiveVoteSession[]>([]);
  const [knownBlindKeys, setKnownBlindKeys] = useState<Record<string, SimpleBlindKeyAnnouncement>>({});
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);
  const [ticketAckSent, setTicketAckSent] = useState(false);
  const [ballotSubmitted, setBallotSubmitted] = useState(false);
  const [ballotAccepted, setBallotAccepted] = useState(false);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [activeTab, setActiveTab] = useState<VoterTab>(() => (linkedQuestionnaireId ? "vote" : "configure"));
  const [optionARequestBlindBallotNonce, setOptionARequestBlindBallotNonce] = useState(0);
  const [showVoteDetails, setShowVoteDetails] = useState(false);
  const [votePaneUnlocked, setVotePaneUnlocked] = useState(false);
  const [questionnaireContext, setQuestionnaireContext] = useState<{ hasDefinition: boolean; state: string | null }>({
    hasDefinition: false,
    state: null,
  });
  const sentTicketReceiptAckIdsRef = useRef<Set<string>>(new Set());
  const ticketObservationMetaRef = useRef<Record<string, { liveAt?: number; backfillAt?: number }>>({});
  const ticketLiveQueryDebugRef = useRef<MailboxReadQueryDebug | null>(null);
  const ticketBackfillQueryDebugRef = useRef<MailboxReadQueryDebug | null>(null);
  const ticketBackfillRequestDebugRef = useRef<Record<string, TicketBackfillRequestDebug>>({});
  const ticketLiveQueryByRequestRef = useRef<Record<string, MailboxReadQueryDebug>>({});

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const persisted = window.localStorage.getItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY)?.trim() ?? "";
    if (persisted) {
      setSignerNpub(persisted);
      setSignerStatus(null);
    }
  }, []);
  const ticketBackfillQueryByRequestRef = useRef<Record<string, MailboxReadQueryDebug>>({});
  const ticketMailboxMismatchRef = useRef<Record<string, TicketMailboxMismatch>>({});
  const lastAutoSelectedVotingIdRef = useRef("");
  const manualRoundSelectionRef = useRef(false);
  const identityHydrationEpochRef = useRef(0);
  const protocolStateServiceRef = useRef<ProtocolStateService | null>(null);
  const saveStateDebounceTimerRef = useRef<number | null>(null);
  const lastSavedStateSignatureRef = useRef<string>("");
  const deploymentMode = useMemo(() => readDeploymentModeFromUrl(), []);
  const isCourseFeedbackMode = deploymentMode === "course_feedback";

  function persistVoterIdentity(nextKeypair: SimpleVoterKeypair, cache?: Partial<SimpleVoterCache>) {
    return saveSimpleActorState({
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
      cache,
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
  }

  async function reconcileIncomingShardResponses(
    nextResponses: SimpleShardResponse[],
    source: "live" | "backfill",
  ) {
    const nextIssuedShares = (await Promise.all(nextResponses.map(async (response) => {
      const existingShare = response.shardCertificate;
      if (existingShare) {
        return [response];
      }

      const pending = Object.values(pendingBlindRequests).find(
        (request) => request.request.requestId === response.requestId,
      );
      if (!pending) {
        return [];
      }

      try {
        const shardCertificate = await unblindSimpleBlindShare({
          response: response.blindShareResponse,
          secret: pending.secret,
        });
        return [{ ...response, shardCertificate }];
      } catch {
        return [];
      }
    }))).flat();

    setReceivedShards((current) => {
      const merged = new Map(current.map((response) => [response.id, response]));
      for (const response of nextIssuedShares) {
        const expectedMailboxId = (
          Object.values(pendingBlindRequests).find((entry) => entry.request.requestId === response.requestId)?.mailboxFrozenValue
          ?? Object.values(pendingBlindRequests).find((entry) => entry.request.requestId === response.requestId)?.mailboxId
          ?? ""
        ).trim();
        const observedMailboxId = (response.mailboxId ?? "").trim();
        if (expectedMailboxId && observedMailboxId && expectedMailboxId !== observedMailboxId) {
          ticketMailboxMismatchRef.current[response.requestId] = {
            requestId: response.requestId,
            expectedMailboxId,
            observedMailboxId,
            observedAt: new Date().toISOString(),
          };
          setRequestStatus("Ticket mailbox mismatch detected. Waiting for aligned mailbox ticket.");
        }
        merged.set(response.id, response);
        const existing = ticketObservationMetaRef.current[response.id] ?? {};
        if (source === "live" && !existing.liveAt) {
          existing.liveAt = Date.now();
        }
        if (source === "backfill" && !existing.backfillAt) {
          existing.backfillAt = Date.now();
        }
        ticketObservationMetaRef.current[response.id] = existing;
      }

      const nextMergedShares = [...merged.values()];
      return equalReceivedShards(current, nextMergedShares) ? current : nextMergedShares;
    });
  }

  const configuredCoordinatorTargets = useMemo(
    () => sanitizeCoordinatorNpubs(manualCoordinators),
    [manualCoordinators],
  );
  const hasConfiguredCoordinators = configuredCoordinatorTargets.length > 0;
  const voteTabActive = activeTab === "vote";
  const questionnaireModeActive = questionnaireContext.hasDefinition;
  const shouldActivateStartupRelayTraffic = (voteTabActive || hasConfiguredCoordinators) && !questionnaireModeActive;
  const knownRoundVotingIds = useMemo(() => {
    const values = new Set<string>();

    for (const session of discoveredSessions) {
      values.add(session.votingId);
    }

    for (const request of Object.values(pendingBlindRequests)) {
      values.add(request.votingId);
    }

    for (const response of receivedShards) {
      const votingId = response.shardCertificate?.votingId;
      if (votingId) {
        values.add(votingId);
      }
    }

    return [...values];
  }, [discoveredSessions, pendingBlindRequests, receivedShards]);
  const activeRoundPendingBlindRequests = useMemo(() => {
    const activeVotingId = selectedVotingId.trim();
    if (!activeVotingId) {
      return [] as PendingBlindRequest[];
    }
    return Object.values(pendingBlindRequests).filter((request) => request.votingId === activeVotingId);
  }, [pendingBlindRequests, selectedVotingId]);
  const unresolvedActiveRoundPendingBlindRequests = useMemo(() => {
    return activeRoundPendingBlindRequests.filter((request) => (
      !receivedShards.some((response) => response.requestId === request.request.requestId)
    ));
  }, [activeRoundPendingBlindRequests, receivedShards]);
  const pendingTicketMailboxIds = useMemo(() => {
    return Array.from(
      new Set(
        unresolvedActiveRoundPendingBlindRequests
          .map((request) => (
            request.mailboxFrozenValue?.trim()
            || request.mailboxId?.trim()
            || ""
          ))
          .filter(Boolean),
      ),
    );
  }, [unresolvedActiveRoundPendingBlindRequests]);

  useEffect(() => {
    const receivedRequestIds = new Set(receivedShards.map((response) => response.requestId));
    if (receivedRequestIds.size === 0) {
      return;
    }

    setPendingBlindRequests((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([, requestEntry]) => {
          const keep = !receivedRequestIds.has(requestEntry.request.requestId);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setRequestDeliveries((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([, delivery]) => {
          const keep = !delivery.requestId || !receivedRequestIds.has(delivery.requestId);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });
  }, [receivedShards]);

  useEffect(() => {
    const pendingKeys = new Set(Object.keys(pendingBlindRequests));
    const activeRoundIds = new Set(knownRoundVotingIds);

    setRequestDeliveries((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => {
          const keep = pendingKeys.has(key);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setRoundReplyKeypairs((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([votingId]) => {
          const keep = activeRoundIds.has(votingId) || votingId === selectedVotingId;
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setKnownBlindKeys((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([key, announcement]) => {
          const keep = activeRoundIds.has(announcement.votingId) || announcement.votingId === selectedVotingId;
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setFollowDeliveries((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([coordinatorNpub]) => {
          const keep = configuredCoordinatorTargets.includes(coordinatorNpub);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });
  }, [configuredCoordinatorTargets, knownRoundVotingIds, pendingBlindRequests, selectedVotingId]);

  useEffect(() => {
    let cancelled = false;
    const hydrationEpoch = identityHydrationEpochRef.current;

    void loadSimpleActorState("voter").then((storedState) => {
      if (cancelled || hydrationEpoch !== identityHydrationEpochRef.current) {
        return;
      }

      if (storedState?.keypair) {
        setVoterKeypair(storedState.keypair);
        const cache = (storedState.cache ?? null) as Partial<SimpleVoterCache> | null;
        setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? sanitizeCoordinatorNpubs(cache.manualCoordinators) : []);
        setNip65Enabled(cache?.nip65Enabled === true);
        setQuestionnaireParticipationHistory(
          Array.isArray(cache?.questionnaireParticipationHistory)
            ? cache.questionnaireParticipationHistory.filter((entry): entry is SimpleVoterCache["questionnaireParticipationHistory"][number] => (
              Boolean(entry)
              && typeof entry === "object"
              && typeof (entry as { questionnaireId?: unknown }).questionnaireId === "string"
              && typeof (entry as { title?: unknown }).title === "string"
              && typeof (entry as { coordinatorPubkey?: unknown }).coordinatorPubkey === "string"
              && typeof (entry as { submissionCount?: unknown }).submissionCount === "number"
              && Number.isFinite((entry as { lastSubmittedAt?: unknown }).lastSubmittedAt)
            ))
            : [],
        );
        setProtocolStateCache(
          cache?.protocolStateCache && typeof cache.protocolStateCache === "object"
            ? cache.protocolStateCache as ProtocolStateCache
            : null,
        );
        setRequestStatus(typeof cache?.requestStatus === "string" ? cache.requestStatus : null);
        setReceivedShards(Array.isArray(cache?.receivedShards) ? cache.receivedShards : []);
        setPendingBlindRequests(
          cache?.pendingBlindRequests && typeof cache.pendingBlindRequests === "object"
            ? cache.pendingBlindRequests
            : {},
        );
        setRoundReplyKeypairs(
          cache?.roundReplyKeypairs && typeof cache.roundReplyKeypairs === "object"
            ? cache.roundReplyKeypairs
            : {},
        );
        setFollowDeliveries(
          cache?.followDeliveries && typeof cache.followDeliveries === "object"
            ? cache.followDeliveries
            : {},
        );
        setRequestDeliveries(
          cache?.requestDeliveries && typeof cache.requestDeliveries === "object"
            ? cache.requestDeliveries
            : {},
        );
        setSubmitStatus(typeof cache?.submitStatus === "string" ? cache.submitStatus : null);
        setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
        setLiveVoteChoice(cache?.liveVoteChoice === "Yes" || cache?.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
        setStorageLocked(false);
        setIdentityReady(true);
        return;
      }

      const nextKeypair = createSimpleVoterKeypair();
      void saveSimpleActorState({
        role: "voter",
        keypair: nextKeypair,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      setVoterKeypair(nextKeypair);
      setStorageLocked(false);
      setIdentityReady(true);
    }).catch(async (error) => {
      if (cancelled || hydrationEpoch !== identityHydrationEpochRef.current) {
        return;
      }

      if (error instanceof SimpleActorStateLockedError || await isSimpleActorStateLocked("voter")) {
        setStorageLocked(true);
        setStorageStatus("Local voter state is locked.");
        return;
      }

      const nextKeypair = createSimpleVoterKeypair();
      setVoterKeypair(nextKeypair);
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
    if (!identityReady || !voterKeypair) {
      return;
    }

    const cache: SimpleVoterCache = {
      manualCoordinators,
      nip65Enabled,
      questionnaireParticipationHistory,
      protocolStateCache,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      roundReplyKeypairs,
      followDeliveries,
      requestDeliveries,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
    };

    const cacheSignature = JSON.stringify({
      manualCoordinators,
      nip65Enabled,
      questionnaireParticipationHistory,
      protocolStateCache,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      roundReplyKeypairs,
      followDeliveries,
      requestDeliveries,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
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
        role: "voter",
        keypair: voterKeypair,
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
    identityReady,
    liveVoteChoice,
    manualCoordinators,
    nip65Enabled,
    questionnaireParticipationHistory,
    protocolStateCache,
    followDeliveries,
    pendingBlindRequests,
    roundReplyKeypairs,
    receivedShards,
    requestStatus,
    requestDeliveries,
    selectedVotingId,
    storagePassphrase,
    submitStatus,
    voterKeypair,
  ]);

  useEffect(() => {
    const actorNsec = voterKeypair?.nsec?.trim() ?? "";
    const replyNsecs = Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec);

    if (!actorNsec || !shouldActivateStartupRelayTraffic) {
      setDmAcknowledgements([]);
      return;
    }

    setDmAcknowledgements([]);

    return subscribeSimpleDmAcknowledgements({
      actorNsec,
      actorNsecs: replyNsecs,
      onAcknowledgements: (nextAcknowledgements) => {
        setDmAcknowledgements(nextAcknowledgements);
      },
    });
  }, [roundReplyKeypairs, shouldActivateStartupRelayTraffic, voterKeypair?.nsec]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec || !shouldActivateStartupRelayTraffic) {
      return;
    }

    return subscribeSimpleCoordinatorRosterAnnouncements({
      voterNsec,
      onAnnouncements: (announcements) => {
        const discoveredCoordinatorNpubs = normalizeCoordinatorNpubsRust(
          announcements.flatMap((announcement) => announcement.coordinatorNpubs),
        );
        const discoveredQuestionnaireIds = [
          ...new Set(
            announcements
              .filter((announcement) => (
                announcement.questionnaireState === "open"
                || announcement.questionnaireState === "published"
              ))
              .map((announcement) => announcement.questionnaireId?.trim() ?? "")
              .filter((value) => value.length > 0),
          ),
        ];

        if (discoveredCoordinatorNpubs.length === 0) {
          if (discoveredQuestionnaireIds.length > 0) {
            setAnnouncedQuestionnaireIds((current) => {
              const next = [...new Set([...current, ...discoveredQuestionnaireIds])].slice(-8);
              return next.length === current.length
                && next.every((value, index) => value === current[index])
                ? current
                : next;
            });
          }
          return;
        }

        setManualCoordinators((current) => {
          const next = normalizeCoordinatorNpubsRust([
            ...current,
            ...discoveredCoordinatorNpubs,
          ]);
          return next.length === current.length
            && next.every((value, index) => value === current[index])
            ? current
            : next;
        });
        if (discoveredQuestionnaireIds.length > 0) {
          setAnnouncedQuestionnaireIds((current) => {
            const next = [...new Set([...current, ...discoveredQuestionnaireIds])].slice(-8);
            return next.length === current.length
              && next.every((value, index) => value === current[index])
              ? current
              : next;
          });
        }
      },
    });
  }, [shouldActivateStartupRelayTraffic, voterKeypair?.nsec]);

  useEffect(() => {
    const announcedIds = [...new Set(
      announcedQuestionnaireIds
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )];
    if (announcedIds.length === 0) {
      setReadyAnnouncedQuestionnaireIds((current) => (current.length === 0 ? current : []));
      return;
    }

    let cancelled = false;
    const runVerification = async () => {
      const checks = await Promise.all(announcedIds.map(async (questionnaireId) => {
        try {
          const ready = await verifyAnnouncedQuestionnaireIsReady(questionnaireId);
          return { questionnaireId, ready };
        } catch {
          return { questionnaireId, ready: null as boolean | null };
        }
      }));
      if (cancelled) {
        return;
      }

      setReadyAnnouncedQuestionnaireIds((current) => {
        const outcomeById = new Map(checks.map((entry) => [entry.questionnaireId, entry.ready]));
        const next = announcedIds.filter((questionnaireId) => {
          const outcome = outcomeById.get(questionnaireId);
          if (outcome === true) {
            return true;
          }
          if (outcome === false) {
            return false;
          }
          return current.includes(questionnaireId);
        });
        return next.length === current.length
          && next.every((value, index) => value === current[index])
          ? current
          : next;
      });
    };

    void runVerification();
    const intervalId = window.setInterval(() => {
      void runVerification();
    }, QUESTIONNAIRE_ANNOUNCEMENT_VERIFY_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [announcedQuestionnaireIds]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec || configuredCoordinatorTargets.length === 0) {
      setReceivedShards([]);
      return;
    }

    if (unresolvedActiveRoundPendingBlindRequests.length === 0) {
      return;
    }

    const cleanups = unresolvedActiveRoundPendingBlindRequests.map((requestEntry) => {
      const requestId = requestEntry.request.requestId;
      const canonicalMailboxId = (
        requestEntry.mailboxFrozenValue?.trim()
        || requestEntry.mailboxId?.trim()
        || ""
      );
      if (!canonicalMailboxId) {
        return () => undefined;
      }
      return subscribeSimpleShardResponses({
        voterNsec,
        voterNsecs: Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec),
        mailboxIds: [canonicalMailboxId],
        onMailboxQueryDebug: (query) => {
          if (query.source !== "subscribe") {
            return;
          }
          ticketLiveQueryDebugRef.current = query;
          ticketLiveQueryByRequestRef.current[requestId] = query;
          const previous = ticketBackfillRequestDebugRef.current[requestId];
          ticketBackfillRequestDebugRef.current[requestId] = {
            attemptCount: previous?.attemptCount ?? 0,
            lastAttemptAt: previous?.lastAttemptAt ?? null,
            lastResultCount: previous?.lastResultCount ?? 0,
            lastMatchedCount: previous?.lastMatchedCount ?? 0,
            requestMailboxId: previous?.requestMailboxId ?? canonicalMailboxId,
            ticketReadMailboxId: canonicalMailboxId,
            ticketBackfillMailboxId: previous?.ticketBackfillMailboxId ?? null,
            lastSourceRelays: previous?.lastSourceRelays ?? [],
          };
        },
        onResponses: (responses) => {
          const filtered = responses.filter((response) => (
            response.requestId === requestId
            || response.mailboxId?.trim() === canonicalMailboxId
          ));
          if (filtered.length > 0) {
            void reconcileIncomingShardResponses(filtered, "live");
          }
        },
      });
    });

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [
    configuredCoordinatorTargets.length,
    unresolvedActiveRoundPendingBlindRequests,
    roundReplyKeypairs,
    voterKeypair?.nsec,
  ]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec || configuredCoordinatorTargets.length === 0) {
      return;
    }

    if (unresolvedActiveRoundPendingBlindRequests.length === 0) {
      return;
    }

    let cancelled = false;

    const refresh = () => {
      const pendingEntries = [...unresolvedActiveRoundPendingBlindRequests];
      const nowIso = new Date().toISOString();
      for (const requestEntry of pendingEntries) {
        const requestId = requestEntry.request.requestId;
        const canonicalMailboxId = (
          requestEntry.mailboxFrozenValue?.trim()
          || requestEntry.mailboxId?.trim()
          || ""
        );
        if (!canonicalMailboxId) {
          continue;
        }
        const previous = ticketBackfillRequestDebugRef.current[requestId];
        ticketBackfillRequestDebugRef.current[requestId] = {
          attemptCount: (previous?.attemptCount ?? 0) + 1,
          lastAttemptAt: nowIso,
          lastResultCount: previous?.lastResultCount ?? 0,
          lastMatchedCount: previous?.lastMatchedCount ?? 0,
          requestMailboxId: canonicalMailboxId,
          ticketReadMailboxId: previous?.ticketReadMailboxId ?? null,
          ticketBackfillMailboxId: canonicalMailboxId,
          lastSourceRelays: previous?.lastSourceRelays ?? [],
        };
      }

      void Promise.all(pendingEntries.map(async (requestEntry) => {
        const requestId = requestEntry.request.requestId;
        const canonicalMailboxId = (
          requestEntry.mailboxFrozenValue?.trim()
          || requestEntry.mailboxId?.trim()
          || ""
        );
        if (!canonicalMailboxId) {
          return;
        }
        const nextResponses = await fetchSimpleShardResponses({
          voterNsec,
          voterNsecs: Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec),
          mailboxIds: [canonicalMailboxId],
          onMailboxQueryDebug: (query) => {
            ticketBackfillQueryDebugRef.current = query;
            ticketBackfillQueryByRequestRef.current[requestId] = query;
          },
        });
        if (cancelled) {
          return;
        }
        const filtered = nextResponses.filter((response) => (
          response.requestId === requestId
          || response.mailboxId?.trim() === canonicalMailboxId
        ));
        const previous = ticketBackfillRequestDebugRef.current[requestId];
        const requestQuery = ticketBackfillQueryByRequestRef.current[requestId];
        ticketBackfillRequestDebugRef.current[requestId] = {
          attemptCount: previous?.attemptCount ?? 1,
          lastAttemptAt: previous?.lastAttemptAt ?? nowIso,
          lastResultCount: Number(requestQuery?.resultCount ?? nextResponses.length),
          lastMatchedCount: filtered.length,
          requestMailboxId: canonicalMailboxId,
          ticketReadMailboxId: previous?.ticketReadMailboxId ?? null,
          ticketBackfillMailboxId: canonicalMailboxId,
          lastSourceRelays: Array.isArray(requestQuery?.relays)
            ? [...requestQuery.relays]
            : [],
        };
        if (filtered.length > 0) {
          await reconcileIncomingShardResponses(filtered, "backfill");
        }
      })).catch(() => undefined);
    };

    refresh();
    const intervalId = window.setInterval(refresh, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    configuredCoordinatorTargets.length,
    unresolvedActiveRoundPendingBlindRequests,
    roundReplyKeypairs,
    voterKeypair?.nsec,
  ]);

  useEffect(() => {
    if (!voteTabActive || questionnaireModeActive || configuredCoordinatorTargets.length === 0) {
      return;
    }

    const sessions = new Map<string, SimpleLiveVoteSession>();
    let cancelled = false;

    const syncSession = (session: SimpleLiveVoteSession | null) => {
      if (!session) {
        return;
      }

      sessions.set(`${session.coordinatorNpub}:${session.votingId}`, session);
      setDiscoveredSessions(
        [...sessions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      );
    };

    const cleanups = configuredCoordinatorTargets.map((coordinatorNpub) => subscribeLatestSimpleLiveVote({
      coordinatorNpub,
      onSession: (session: SimpleLiveVoteSession | null) => {
        syncSession(session);
      },
    }));

    const refreshSessions = async () => {
      const nextSessions = await Promise.all(
        configuredCoordinatorTargets.map((coordinatorNpub) => fetchLatestSimpleLiveVote({ coordinatorNpub })),
      );

      if (cancelled) {
        return;
      }

      for (const session of nextSessions) {
        syncSession(session);
      }
    };

    void refreshSessions();
    const refreshHandle = window.setInterval(() => {
      void refreshSessions();
    }, SIMPLE_PUBLIC_ROUND_BACKFILL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(refreshHandle);
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [configuredCoordinatorTargets, questionnaireModeActive, voteTabActive]);

  useEffect(() => {
    if (!shouldActivateStartupRelayTraffic) {
      return;
    }
    const knownParticipants = [
      ...configuredCoordinatorTargets,
      ...Object.values(roundReplyKeypairs).map((keypair) => keypair.npub),
    ];
    if (knownParticipants.length === 0) {
      return;
    }

    void primeNip65RelayHints(knownParticipants, SIMPLE_PUBLIC_RELAYS);
  }, [configuredCoordinatorTargets, roundReplyKeypairs, shouldActivateStartupRelayTraffic]);

  useEffect(() => {
    let cancelled = false;

    async function replayProtocolState() {
      const authorPubkey = voterKeypair?.npub ?? configuredCoordinatorTargets[0] ?? "voter";
      const service = protocolStateServiceRef.current ?? await ProtocolStateService.create({
        electionId: SIMPLE_PUBLIC_ELECTION_ID,
        snapshot: protocolStateCache,
      });
      protocolStateServiceRef.current = service;

      const replay = service.replayPublicState({
        electionId: SIMPLE_PUBLIC_ELECTION_ID,
        authorPubkey,
        rounds: discoveredSessions,
      });
      const nextCache = service.snapshot();

      if (cancelled) {
        return;
      }

      setDerivedPublicRounds(replay.roundSessions);
      setProtocolStateCache(nextCache);
    }

    void replayProtocolState();

    return () => {
      cancelled = true;
    };
  }, [configuredCoordinatorTargets, discoveredSessions, voterKeypair?.npub]);

  useEffect(() => {
    if (!voteTabActive || questionnaireModeActive || configuredCoordinatorTargets.length === 0 || knownRoundVotingIds.length === 0) {
      setKnownBlindKeys({});
      return;
    }

    const cleanups = configuredCoordinatorTargets.flatMap((coordinatorNpub) => (
      knownRoundVotingIds.map((votingId) => subscribeLatestSimpleBlindKeyAnnouncement({
        coordinatorNpub,
        votingId,
        onAnnouncement: (announcement) => {
          if (!announcement) {
            return;
          }

          setKnownBlindKeys((current) => ({
            ...current,
            [makeRoundBlindKeyId(coordinatorNpub, votingId)]: announcement,
          }));
        },
      }))
    ));

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [configuredCoordinatorTargets, knownRoundVotingIds, questionnaireModeActive, voteTabActive]);

  useEffect(() => {
    if (!voteTabActive || questionnaireModeActive) {
      return;
    }
    const roundsMissingBlindKeys = configuredCoordinatorTargets.flatMap((coordinatorNpub) => {
      return knownRoundVotingIds.flatMap((votingId) => (
        knownBlindKeys[makeRoundBlindKeyId(coordinatorNpub, votingId)]
          ? []
          : [{ coordinatorNpub, votingId }]
      ));
    });

    if (roundsMissingBlindKeys.length === 0) {
      return;
    }

    let cancelled = false;

    const refreshMissingBlindKeys = () => {
      void Promise.all(roundsMissingBlindKeys.map(async ({ coordinatorNpub, votingId }) => {
        const announcement = await fetchLatestSimpleBlindKeyAnnouncement({
          coordinatorNpub,
          votingId,
        });
        return announcement ? { coordinatorNpub, votingId, announcement } : null;
      })).then((results) => {
        if (cancelled) {
          return;
        }

        const foundAnnouncements = results.filter((value): value is NonNullable<typeof value> => value !== null);
        if (foundAnnouncements.length === 0) {
          return;
        }

        setKnownBlindKeys((current) => {
          const next = { ...current };
          for (const result of foundAnnouncements) {
            next[makeRoundBlindKeyId(result.coordinatorNpub, result.votingId)] = result.announcement;
          }
          return next;
        });
      }).catch(() => undefined);
    };

    refreshMissingBlindKeys();
    const intervalId = window.setInterval(refreshMissingBlindKeys, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [configuredCoordinatorTargets, knownBlindKeys, knownRoundVotingIds, questionnaireModeActive, voteTabActive]);

  useEffect(() => {
    const npub = activeVoterNpub;
    if (!npub) {
      setVoterId("pending");
      return;
    }

    setVoterId(deriveActorDisplayId(npub));
  }, [activeVoterNpub]);

  useEffect(() => {
    setLiveVoteChoice(null);
    setSubmitStatus(null);
  }, [selectedVotingId]);

  function clearVoterSessionState(options?: { clearManualCoordinators?: boolean }) {
    if (options?.clearManualCoordinators ?? false) {
      setManualCoordinators([]);
      setCoordinatorDraft("");
    }
    protocolStateServiceRef.current = null;
    setProtocolStateCache(null);
    setDerivedPublicRounds([]);
    setLiveVoteChoice(null);
    setRequestStatus(null);
    setSubmitStatus(null);
    setBallotTokenId(null);
    setReceivedShards([]);
    setPendingBlindRequests({});
    setRoundReplyKeypairs({});
    setFollowDeliveries({});
    setRequestDeliveries({});
    setDmAcknowledgements([]);
    setDiscoveredSessions([]);
    setKnownBlindKeys({});
    setSelectedVotingId("");
    setActiveTab("configure");
    setShowVoteDetails(false);
    setVotePaneUnlocked(false);
    lastAutoSelectedVotingIdRef.current = "";
    manualRoundSelectionRef.current = false;
    sentTicketReceiptAckIdsRef.current.clear();
  }

  function refreshIdentity() {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(GATEWAY_SIGNER_NPUB_STORAGE_KEY);
    }
    setSignerNpub("");
    setSignerStatus(null);
    identityHydrationEpochRef.current += 1;
    const nextKeypair = createSimpleVoterKeypair();
    void saveSimpleActorState({
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setVoterKeypair(nextKeypair);
    setIdentityStatus(null);
    setBackupStatus(null);
    clearVoterSessionState({ clearManualCoordinators: true });
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
    window.addEventListener("auditable-voting:voter-login", handleLogin);
    window.addEventListener("auditable-voting:voter-signout", handleSignOut);
    window.addEventListener("auditable-voting:voter-new", handleNewIdentity);
    return () => {
      window.removeEventListener("auditable-voting:voter-login", handleLogin);
      window.removeEventListener("auditable-voting:voter-signout", handleSignOut);
      window.removeEventListener("auditable-voting:voter-new", handleNewIdentity);
    };
  }, [loginWithSigner, refreshIdentity, signOutSignerSession]);

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
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setVoterKeypair(nextKeypair);
    setIdentityStatus("Identity restored from nsec.");
    setBackupStatus(null);
    clearVoterSessionState({ clearManualCoordinators: true });
  }

  function downloadBackup(passphrase?: string) {
    if (!voterKeypair) {
      return;
    }

    void downloadSimpleActorBackup("voter", voterKeypair as SimpleActorKeypair, {
      manualCoordinators,
      nip65Enabled,
      questionnaireParticipationHistory,
      protocolStateCache,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      roundReplyKeypairs,
      followDeliveries,
      requestDeliveries,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
    } satisfies SimpleVoterCache, { passphrase });
    setBackupStatus(passphrase?.trim() ? "Encrypted identity backup downloaded." : "Identity backup downloaded.");
  }

  async function restoreBackup(file: File, passphrase?: string) {
    try {
      const text = await file.text();
      const bundle = parseSimpleActorBackupBundle(text)
        ?? (passphrase?.trim() ? await parseEncryptedSimpleActorBackupBundle(text, passphrase.trim()) : null);
      if (!bundle || bundle.role !== "voter") {
        setBackupStatus("Backup file is not a voter backup.");
        return;
      }

      await saveSimpleActorState({
        role: "voter",
        keypair: bundle.keypair,
        updatedAt: new Date().toISOString(),
        cache: bundle.cache,
      }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
      identityHydrationEpochRef.current += 1;
      setVoterKeypair(bundle.keypair);
      setIdentityStatus("Identity restored from backup.");
      setBackupStatus(`Backup restored from ${bundle.exportedAt}.`);
      const cache = (bundle.cache ?? null) as Partial<SimpleVoterCache> | null;
      protocolStateServiceRef.current = null;
      setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? sanitizeCoordinatorNpubs(cache.manualCoordinators) : []);
      setNip65Enabled(cache?.nip65Enabled === true);
      setQuestionnaireParticipationHistory(
        Array.isArray(cache?.questionnaireParticipationHistory)
          ? cache.questionnaireParticipationHistory.filter((entry): entry is SimpleVoterCache["questionnaireParticipationHistory"][number] => (
            Boolean(entry)
            && typeof entry === "object"
            && typeof (entry as { questionnaireId?: unknown }).questionnaireId === "string"
            && typeof (entry as { title?: unknown }).title === "string"
            && typeof (entry as { coordinatorPubkey?: unknown }).coordinatorPubkey === "string"
            && typeof (entry as { submissionCount?: unknown }).submissionCount === "number"
            && Number.isFinite((entry as { lastSubmittedAt?: unknown }).lastSubmittedAt)
          ))
          : [],
      );
      setProtocolStateCache(
        cache?.protocolStateCache && typeof cache.protocolStateCache === "object"
          ? cache.protocolStateCache as ProtocolStateCache
          : null,
      );
      setDerivedPublicRounds([]);
      setLiveVoteChoice(cache?.liveVoteChoice === "Yes" || cache?.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
      setRequestStatus(typeof cache?.requestStatus === "string" ? cache.requestStatus : null);
      setSubmitStatus(typeof cache?.submitStatus === "string" ? cache.submitStatus : null);
      setBallotTokenId(null);
      setReceivedShards(Array.isArray(cache?.receivedShards) ? cache.receivedShards : []);
      setPendingBlindRequests(
        cache?.pendingBlindRequests && typeof cache.pendingBlindRequests === "object"
          ? cache.pendingBlindRequests
          : {},
      );
      setRoundReplyKeypairs(
        cache?.roundReplyKeypairs && typeof cache.roundReplyKeypairs === "object"
          ? cache.roundReplyKeypairs
          : {},
      );
      setFollowDeliveries(
        cache?.followDeliveries && typeof cache.followDeliveries === "object"
          ? cache.followDeliveries
          : {},
      );
      setRequestDeliveries(
        cache?.requestDeliveries && typeof cache.requestDeliveries === "object"
          ? cache.requestDeliveries
          : {},
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setDmAcknowledgements([]);
      sentTicketReceiptAckIdsRef.current.clear();
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
      const storedState = await loadSimpleActorStateWithOptions("voter", { passphrase: trimmed });
      if (!storedState?.keypair) {
        setStorageStatus("No voter state was found.");
        return;
      }

      const cache = (storedState.cache ?? null) as Partial<SimpleVoterCache> | null;
      setStoragePassphrase(trimmed);
      identityHydrationEpochRef.current += 1;
      setVoterKeypair(storedState.keypair);
      protocolStateServiceRef.current = null;
      setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? sanitizeCoordinatorNpubs(cache.manualCoordinators) : []);
      setQuestionnaireParticipationHistory(
        Array.isArray(cache?.questionnaireParticipationHistory)
          ? cache.questionnaireParticipationHistory.filter((entry): entry is SimpleVoterCache["questionnaireParticipationHistory"][number] => (
            Boolean(entry)
            && typeof entry === "object"
            && typeof (entry as { questionnaireId?: unknown }).questionnaireId === "string"
            && typeof (entry as { title?: unknown }).title === "string"
            && typeof (entry as { coordinatorPubkey?: unknown }).coordinatorPubkey === "string"
            && typeof (entry as { submissionCount?: unknown }).submissionCount === "number"
            && Number.isFinite((entry as { lastSubmittedAt?: unknown }).lastSubmittedAt)
          ))
          : [],
      );
      setProtocolStateCache(
        cache?.protocolStateCache && typeof cache.protocolStateCache === "object"
          ? cache.protocolStateCache as ProtocolStateCache
          : null,
      );
      setDerivedPublicRounds([]);
      setRequestStatus(typeof cache?.requestStatus === "string" ? cache.requestStatus : null);
      setReceivedShards(Array.isArray(cache?.receivedShards) ? cache.receivedShards : []);
      setPendingBlindRequests(cache?.pendingBlindRequests && typeof cache.pendingBlindRequests === "object" ? cache.pendingBlindRequests : {});
      setRoundReplyKeypairs(cache?.roundReplyKeypairs && typeof cache.roundReplyKeypairs === "object" ? cache.roundReplyKeypairs : {});
      setFollowDeliveries(cache?.followDeliveries && typeof cache.followDeliveries === "object" ? cache.followDeliveries : {});
      setRequestDeliveries(cache?.requestDeliveries && typeof cache.requestDeliveries === "object" ? cache.requestDeliveries : {});
      setSubmitStatus(typeof cache?.submitStatus === "string" ? cache.submitStatus : null);
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setLiveVoteChoice(cache?.liveVoteChoice === "Yes" || cache?.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
      setStorageLocked(false);
      setStorageStatus("Local voter state unlocked.");
      setIdentityReady(true);
    } catch {
      setStorageStatus("Unlock failed.");
    }
  }

  async function protectLocalState(passphrase: string) {
    const trimmed = passphrase.trim();
    if (!trimmed || !voterKeypair) {
      setStorageStatus("Enter a passphrase first.");
      return;
    }
    setStoragePassphrase(trimmed);
    setStorageStatus("Local voter state will be stored encrypted.");
  }

  async function disableLocalStateProtection(currentPassphrase?: string) {
    if (!voterKeypair) {
      return;
    }
    if (!storagePassphrase && !currentPassphrase?.trim()) {
      setStorageStatus("Enter the current passphrase to remove protection.");
      return;
    }
    setStoragePassphrase("");
    setStorageStatus("Local voter state protection removed.");
  }

  function addCoordinatorInput() {
    const nextCoordinator = coordinatorDraft.trim();
    if (!nextCoordinator) {
      return;
    }

    if (!isValidNpub(nextCoordinator)) {
      setRequestStatus("Coordinator key must be a valid npub.");
      return;
    }

    const alreadyAdded = configuredCoordinatorTargets.includes(nextCoordinator);
    setManualCoordinators((current) => sanitizeCoordinatorNpubs([...current, nextCoordinator]));
    setCoordinatorDraft("");
    if (alreadyAdded) {
      setRequestStatus("Coordinator already added.");
      return;
    }
    if (questionnaireModeActive) {
      setRequestStatus("Coordinator added. Click Vote to request a blind signature.");
      return;
    }
    void sendFollowRequests([nextCoordinator], {
      pending: "Sending follow request...",
      success: questionnaireModeActive
        ? "Coordinator notified. Waiting for questionnaire updates."
        : "Coordinator notified. Waiting for round tickets.",
      failure: "Coordinator follow request failed.",
    });
  }

  function handleCoordinatorScanDetected(rawValue: string) {
    const scannedNpub = extractNpubFromScan(rawValue);
    if (!scannedNpub) {
      setCoordinatorScannerStatus("QR did not contain a valid npub.");
      return false;
    }

    const alreadyAdded = configuredCoordinatorTargets.includes(scannedNpub);
    setManualCoordinators((current) => sanitizeCoordinatorNpubs([...current, scannedNpub]));
    setCoordinatorDraft("");
    if (alreadyAdded) {
      setRequestStatus("Coordinator already added.");
    } else {
      if (questionnaireModeActive) {
        setRequestStatus("Coordinator added. Click Vote to request a blind signature.");
        setCoordinatorScannerStatus(`Scanned ${shortenNpub(scannedNpub)}.`);
        return true;
      }
      void sendFollowRequests([scannedNpub], {
        pending: "Sending follow request...",
        success: questionnaireModeActive
          ? "Coordinator notified. Waiting for questionnaire updates."
          : "Coordinator notified. Waiting for round tickets.",
        failure: "Coordinator follow request failed.",
      });
    }
    setCoordinatorScannerStatus(`Scanned ${shortenNpub(scannedNpub)}.`);
    return true;
  }

  function removeCoordinatorInput(index: number) {
    setManualCoordinators((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  function applyDiscoveredQuestionnaireInvites(invites: Array<{ coordinatorNpub: string; electionId: string; invitedNpub: string; type: string; schemaVersion: number; title: string; description: string; voteUrl: string; expiresAt?: string | null }>) {
    for (const invite of invites) {
      publishInviteToMailbox(invite);
    }
    const discoveredCoordinatorNpubs = sanitizeCoordinatorNpubs(invites.map((invite) => invite.coordinatorNpub));
    const discoveredQuestionnaireIds = [...new Set(
      invites
        .map((invite) => invite.electionId?.trim() ?? "")
        .filter((value) => value.length > 0),
    )];
    if (discoveredCoordinatorNpubs.length > 0) {
      setManualCoordinators((current) => sanitizeCoordinatorNpubs([...current, ...discoveredCoordinatorNpubs]));
    }
    if (discoveredQuestionnaireIds.length > 0) {
      setAnnouncedQuestionnaireIds((current) => {
        const next = [...new Set([...current, ...discoveredQuestionnaireIds])].slice(-8);
        return next.length === current.length
          && next.every((value, index) => value === current[index])
          ? current
          : next;
      });
    }
  }

  async function checkQuestionnaireInvitesWithLocalKey(options?: { silent?: boolean }) {
    const localNsec = voterKeypair?.nsec?.trim() ?? "";
    const localNpub = voterKeypair?.npub?.trim() ?? "";
    if (!localNsec || !localNpub) {
      if (!options?.silent) {
        setRequestStatus("Login with a signer or nsec before checking encrypted invite DMs.");
      }
      return;
    }
    try {
      const invites = await fetchOptionAInviteDmsWithNsec({
        nsec: localNsec,
        limit: 40,
      });
      applyDiscoveredQuestionnaireInvites(invites);
      if (!options?.silent) {
        setRequestStatus(
          invites.length === 0
            ? `Checked invites for ${shortenNpub(localNpub)} (local key). No questionnaire invites found.`
            : `Checked invites for ${shortenNpub(localNpub)} (local key). Found ${invites.length} questionnaire invite${invites.length === 1 ? "" : "s"}.`,
        );
      }
    } catch {
      if (!options?.silent) {
        setRequestStatus("Could not check questionnaire invites with local key.");
      }
    }
  }

  async function checkQuestionnaireInvites(options?: { silent?: boolean }) {
    if (linkedQuestionnaireId) {
      setAnnouncedQuestionnaireIds((current) => {
        const next = [...new Set([...current, linkedQuestionnaireId])].slice(-8);
        return next.length === current.length
          && next.every((value, index) => value === current[index])
          ? current
          : next;
      });
      setReadyAnnouncedQuestionnaireIds((current) => {
        const next = [...new Set([...current, linkedQuestionnaireId])].slice(-8);
        return next.length === current.length
          && next.every((value, index) => value === current[index])
          ? current
          : next;
      });
      setVotePaneUnlocked(true);
      setActiveTab("vote");
      if (!options?.silent) {
        setRequestStatus(`Opened linked questionnaire ${linkedQuestionnaireId}.`);
      }
      return;
    }

    const signerSessionNpub = signerNpub.trim();
    if (!signerSessionNpub) {
      await checkQuestionnaireInvitesWithLocalKey({ silent: options?.silent });
      return;
    }

    try {
      const signer = createSignerService();
      const rawPubkey = await signer.getPublicKey();
      const signerNpub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);
      const invites = await fetchOptionAInviteDms({ signer, limit: 40 });
      applyDiscoveredQuestionnaireInvites(invites);

      if (!options?.silent) {
        setRequestStatus(
          invites.length === 0
            ? `Checked invites for ${shortenNpub(signerNpub)}. No questionnaire invites found.`
            : `Checked invites for ${shortenNpub(signerNpub)}. Found ${invites.length} questionnaire invite${invites.length === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      if (options?.silent) {
        return;
      }
      if (error instanceof SignerServiceError) {
        setRequestStatus(error.message);
        return;
      }
      setRequestStatus("Could not check questionnaire invites.");
    }
  }

  useEffect(() => {
    const signerSessionNpub = signerNpub.trim();
    const localNsec = voterKeypair?.nsec?.trim() ?? "";
    if (!signerSessionNpub && !localNsec) {
      return;
    }
    const aggressiveInvitePoll = configuredCoordinatorTargets.length > 0
      && !questionnaireContext.hasDefinition
      && announcedQuestionnaireIds.length === 0;
    const pollIntervalMs = aggressiveInvitePoll ? 2500 : 7000;

    void checkQuestionnaireInvites({ silent: true });
    const intervalId = window.setInterval(() => {
      void checkQuestionnaireInvites({ silent: true });
    }, pollIntervalMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    announcedQuestionnaireIds.length,
    configuredCoordinatorTargets.length,
    questionnaireContext.hasDefinition,
    linkedQuestionnaireId,
    signerNpub,
    voterKeypair?.nsec,
  ]);

  async function sendFollowRequests(
    targetCoordinatorNpubs: string[],
    messages?: {
      pending?: string;
      success?: string;
      failure?: string;
    },
  ) {
    const voterNpub = voterKeypair?.npub ?? "";
    const voterNsec = voterKeypair?.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);

    if (
      !voterNpub
      || voterId === "pending"
      || !voterSecretKey
      || targetCoordinatorNpubs.length === 0
    ) {
      return;
    }

    setRequestStatus(messages?.pending ?? "Contacting coordinators...");

    try {
      const followResults = await Promise.all(targetCoordinatorNpubs.map(async (coordinatorNpub) => {
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
        });
        return {
          coordinatorNpub,
          success: result.successes > 0,
          eventId: result.eventId,
        };
      }));
      const nextDeliveries = Object.fromEntries(followResults.map((result) => [
        result.coordinatorNpub,
        {
          status: result.success ? "Follow request sent." : "Follow request failed.",
          eventId: result.eventId,
          attempts: (followDeliveries[result.coordinatorNpub]?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
      ]));
      setFollowDeliveries((current) => ({ ...current, ...nextDeliveries }));
      const followSuccesses = followResults.filter((result) => result.success).length;

      setRequestStatus(
        followSuccesses > 0
          ? (
              messages?.success
              ?? (
                questionnaireModeActive
                  ? "Coordinators notified. Waiting for questionnaire updates."
                  : "Coordinators notified. Waiting for round tickets."
              )
            )
          : (messages?.failure ?? "Coordinator notification failed."),
      );
    } catch {
      setRequestStatus(messages?.failure ?? "Coordinator notification failed.");
    }
  }

  async function retryUnresponsiveCoordinators() {
    if (questionnaireModeActive) {
      selectTab("vote");
      setRequestStatus("Opening Vote and requesting a blind signature.");
      return;
    }
    const retryTargets = configuredCoordinatorTargets.filter(
      (coordinatorNpub) => coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone !== "ok",
    );
    await sendFollowRequests(retryTargets, {
      pending: "Retrying unresponsive coordinators...",
      success: questionnaireModeActive
        ? "Retry sent. Waiting for questionnaire updates."
        : "Retry sent. Waiting for round tickets.",
      failure: "Coordinator retry failed.",
    });
  }

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";

    if (questionnaireModeActive || !voterSecretKey || !voterNpub || configuredCoordinatorTargets.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const retryTargets = selectFollowRetryTargetsRust({
        configuredCoordinatorTargets,
        followDeliveries,
        acknowledgements: dmAcknowledgements.map((ack) => ({
          actorNpub: ack.actorNpub,
          ackedAction: ack.ackedAction,
          ackedEventId: ack.ackedEventId,
        })),
        nowMs: now,
        minRetryAgeMs: SIMPLE_FOLLOW_RETRY_MIN_AGE_MS,
        maxAttempts: 3,
      });

      if (!retryTargets.length) {
        return;
      }

      void Promise.all(retryTargets.map(async (coordinatorNpub) => {
        await wait(randomHumanActionDelayMs());
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
        });
        return { coordinatorNpub, result };
      })).then((results) => {
        setFollowDeliveries((current) => {
          const next = { ...current };
          for (const { coordinatorNpub, result } of results) {
            const previous = current[coordinatorNpub];
            next[coordinatorNpub] = {
              status: result.successes > 0 ? "Follow request resent." : "Follow request retry failed.",
              eventId: result.eventId,
              attempts: (previous?.attempts ?? 0) + 1,
              lastAttemptAt: new Date().toISOString(),
            };
          }
          return next;
        });
      }).catch(() => undefined);
    }, SIMPLE_FOLLOW_RETRY_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [configuredCoordinatorTargets, dmAcknowledgements, followDeliveries, questionnaireModeActive, voterKeypair?.npub, voterKeypair?.nsec]);

  const uniqueShardResponses = Array.from(
    new Map(
      receivedShards.flatMap((shard) => {
        const parsed = shard.shardCertificate ? parseSimpleShardCertificate(shard.shardCertificate) : null;
        const activeVotingId = selectedVotingId.trim();

        if (
          !parsed
          || !activeVotingId
          || parsed.votingId !== activeVotingId
          || !configuredCoordinatorTargets.includes(shard.coordinatorNpub)
        ) {
          return [];
        }

        return [[shard.coordinatorNpub, shard] as const];
      }),
    ).values(),
  );

  useEffect(() => {
    let cancelled = false;

    void deriveTokenIdFromSimplePublicShardProofs(
      uniqueShardResponses
        .map((shard) => shard.shardCertificate)
        .filter((certificate): certificate is NonNullable<typeof certificate> => certificate !== undefined)
        .map((certificate) => ({
          coordinatorNpub: certificate.coordinatorNpub,
          votingId: certificate.votingId,
          tokenCommitment: certificate.tokenMessage,
          unblindedSignature: certificate.unblindedSignature,
          shareIndex: certificate.shareIndex,
          keyAnnouncementEvent: certificate.keyAnnouncementEvent,
        })),
    ).then((tokenId) => {
      if (!cancelled) {
        setBallotTokenId(tokenId);
      }
    }).catch(() => {
      if (!cancelled) {
        setBallotTokenId(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [uniqueShardResponses]);

  const voteTicketRows = useMemo(
    () => buildSimpleVoteTicketRows(receivedShards, configuredCoordinatorTargets),
    [configuredCoordinatorTargets, receivedShards],
  );
  const knownRounds = useMemo(() => {
    const sessionsByVotingId = new Map(
      derivedPublicRounds.map((round) => [round.votingId, round] as const),
    );

    for (const row of voteTicketRows) {
      if (sessionsByVotingId.has(row.votingId)) {
        continue;
      }

      const sourceShard = receivedShards.find((response) => {
        const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
        return parsed?.votingId === row.votingId && configuredCoordinatorTargets.includes(response.coordinatorNpub);
      });

      sessionsByVotingId.set(row.votingId, {
        votingId: row.votingId,
        prompt: row.prompt,
        coordinatorNpub: sourceShard?.coordinatorNpub ?? "",
        createdAt: row.createdAt,
        thresholdT: row.thresholdT,
        thresholdN: row.thresholdN,
        authorizedCoordinatorNpubs: [...configuredCoordinatorTargets],
        eventId: `ticket-row:${row.votingId}`,
      });
    }

    return Array.from(sessionsByVotingId.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [configuredCoordinatorTargets, derivedPublicRounds, receivedShards, voteTicketRows]);

  useEffect(() => {
    if (!knownRounds.length) {
      setSelectedVotingId("");
      lastAutoSelectedVotingIdRef.current = "";
      manualRoundSelectionRef.current = false;
      return;
    }

    const latestVotingId = knownRounds[0].votingId;
    setSelectedVotingId((current) => {
      const canAutoAdvance =
        !manualRoundSelectionRef.current
        || !current
        || current === lastAutoSelectedVotingIdRef.current;

      if (lastAutoSelectedVotingIdRef.current !== latestVotingId && canAutoAdvance) {
        lastAutoSelectedVotingIdRef.current = latestVotingId;
        return latestVotingId;
      }

      return knownRounds.some((round) => round.votingId === current)
        ? current
        : latestVotingId;
    });
  }, [knownRounds]);

  const effectiveLiveVoteSession = useMemo<SimpleLiveVoteSession | null>(() => {
    return knownRounds.find((round) => round.votingId === selectedVotingId)
      ?? knownRounds[0]
      ?? null;
  }, [knownRounds, selectedVotingId]);

  const coordinatorDiagnostics = useMemo(() => buildVoterCoordinatorDiagnosticsRust({
    configuredCoordinatorTargets,
    activeVotingId: effectiveLiveVoteSession?.votingId ?? null,
    discoveredRoundSources: discoveredSessions.map((session) => ({
      coordinatorNpub: session.coordinatorNpub,
      votingId: session.votingId,
    })),
    knownBlindKeyIds: Object.keys(knownBlindKeys),
    followDeliveries,
    requestDeliveries,
    acknowledgements: dmAcknowledgements.map((ack) => ({
      actorNpub: ack.actorNpub,
      ackedAction: ack.ackedAction,
      ackedEventId: ack.ackedEventId,
    })),
    ticketReceivedCoordinatorNpubs: uniqueShardResponses.map((response) => response.coordinatorNpub),
  }), [
    configuredCoordinatorTargets,
    discoveredSessions,
    dmAcknowledgements,
    effectiveLiveVoteSession?.votingId,
    followDeliveries,
    knownBlindKeys,
    requestDeliveries,
    uniqueShardResponses,
  ]);
  const coordinatorDiagnosticsByNpub = useMemo(
    () => new Map(coordinatorDiagnostics.map((entry) => [entry.coordinatorNpub, entry])),
    [coordinatorDiagnostics],
  );
  const followAcknowledgedByAllConfiguredCoordinators =
    configuredCoordinatorTargets.length > 0 &&
    configuredCoordinatorTargets.every(
      (coordinatorNpub) =>
        coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone === 'ok',
    );
  const coordinatorsHaveBeenNotified =
    followAcknowledgedByAllConfiguredCoordinators ||
    configuredCoordinatorTargets.some(
      (coordinatorNpub) =>
        followDeliveries[coordinatorNpub]?.eventId ||
        followDeliveries[coordinatorNpub]?.status?.startsWith('Follow request'),
    );
  const hasUnresponsiveCoordinators =
    configuredCoordinatorTargets.length > 0
    && configuredCoordinatorTargets.some(
      (coordinatorNpub) => coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone !== 'ok',
    );

  useEffect(() => {
    const discoveredCoordinatorNpubs = normalizeCoordinatorNpubsRust(
      dmAcknowledgements.flatMap((ack) => (
        ack.ackedAction === 'simple_coordinator_follow'
          ? ack.coordinatorNpubs ?? []
          : []
      )),
    );

    if (discoveredCoordinatorNpubs.length === 0) {
      return;
    }

    setManualCoordinators((current) => {
      const next = normalizeCoordinatorNpubsRust([
        ...current,
        ...discoveredCoordinatorNpubs,
      ]);
      return next.length === current.length
        && next.every((value, index) => value === current[index])
        ? current
        : next;
    });
  }, [dmAcknowledgements]);

  useEffect(() => {
    const roundCoordinatorNpubs = normalizeCoordinatorNpubsRust(
      knownRounds.flatMap((round) => round.authorizedCoordinatorNpubs),
    );

    if (roundCoordinatorNpubs.length === 0) {
      return;
    }

    setManualCoordinators((current) => {
      const next = normalizeCoordinatorNpubsRust([
        ...current,
        ...roundCoordinatorNpubs,
      ]);
      return next.length === current.length
        && next.every((value, index) => value === current[index])
        ? current
        : next;
    });
  }, [knownRounds]);

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";

    if (!voterSecretKey || !voterNpub) {
      return;
    }

    const undispatchedCoordinators = configuredCoordinatorTargets.filter(
      (coordinatorNpub) =>
        !followDeliveries[coordinatorNpub]?.eventId
        && coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone !== 'ok',
    );

    if (undispatchedCoordinators.length === 0) {
      return;
    }

    void Promise.all(
      undispatchedCoordinators.map(async (coordinatorNpub) => {
        await wait(randomHumanActionDelayMs());
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
        });
        return {
          coordinatorNpub,
          success: result.successes > 0,
          eventId: result.eventId,
        };
      }),
    ).then((results) => {
      setFollowDeliveries((current) => ({
        ...current,
        ...Object.fromEntries(
          results.map((result) => [
            result.coordinatorNpub,
            {
              status: result.success
                ? 'Follow request sent.'
                : 'Follow request failed.',
              eventId: result.eventId,
              attempts: (current[result.coordinatorNpub]?.attempts ?? 0) + 1,
              lastAttemptAt: new Date().toISOString(),
            },
          ]),
        ),
      }));
      if (results.some((result) => result.success)) {
        setRequestStatus(
          configuredCoordinatorTargets.length === results.length
            ? (
                questionnaireModeActive
                  ? 'Coordinators notified. Waiting for questionnaire updates.'
                  : 'Coordinators notified. Waiting for round tickets.'
              )
            : (
                questionnaireModeActive
                  ? 'Additional coordinators received. Waiting for questionnaire updates.'
                  : 'Additional coordinators received. Waiting for round tickets.'
              ),
        );
      }
    }).catch(() => undefined);
  }, [
    configuredCoordinatorTargets,
    coordinatorDiagnosticsByNpub,
    followDeliveries,
    questionnaireModeActive,
    voterKeypair?.npub,
    voterKeypair?.nsec,
  ]);

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";
    const round = effectiveLiveVoteSession;

    if (!voterSecretKey || !voterNpub || voterId === "pending" || !round) {
      return;
    }

    const coordinatorsToRequest = configuredCoordinatorTargets.filter((coordinatorNpub) => {
      if (!round.authorizedCoordinatorNpubs.includes(coordinatorNpub)) {
        return false;
      }

      if (!knownBlindKeys[makeRoundBlindKeyId(coordinatorNpub, round.votingId)]) {
        return false;
      }

      if (pendingBlindRequests[`${coordinatorNpub}:${round.votingId}`]) {
        return false;
      }

      return !receivedShards.some((response) => {
        const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
        return parsed?.votingId === round.votingId && response.coordinatorNpub === coordinatorNpub;
      });
    });

    if (coordinatorsToRequest.length === 0) {
      return;
    }

    void (async () => {
      const existingRoundTokenMessage = Object.values(pendingBlindRequests).find((entry) => entry.votingId === round.votingId)?.secret.tokenMessage
        ?? receivedShards.find((response) => {
          const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
          return parsed?.votingId === round.votingId;
        })?.shardCertificate?.tokenMessage
        ?? createRoundTokenMessage(round.votingId);
      const replyKeypair = roundReplyKeypairs[round.votingId] ?? createSimpleVoterKeypair();

      // Register the per-round reply identity before requests go out so ticket responses cannot
      // beat the voter subscription setup on the first round.
      setRoundReplyKeypairs((current) => ({
        ...current,
        [round.votingId]: current[round.votingId] ?? replyKeypair,
      }));

      const createdEntries = await Promise.all(coordinatorsToRequest.map(async (coordinatorNpub) => {
        const announcement = knownBlindKeys[makeRoundBlindKeyId(coordinatorNpub, round.votingId)];
        const created = await createSimpleBlindIssuanceRequest({
          publicKey: announcement.publicKey,
          votingId: round.votingId,
          tokenMessage: existingRoundTokenMessage,
        });
        return {
          coordinatorNpub,
          votingId: round.votingId,
          replyNpub: replyKeypair.npub,
          request: created.request,
          secret: created.secret,
          createdAt: created.request.createdAt,
        } satisfies PendingBlindRequest;
      }));

      const results = await Promise.all(createdEntries.map(async (entry) => {
        await wait(randomHumanActionDelayMs());
        return sendSimpleShardRequest({
          voterSecretKey: decodeNsec(replyKeypair.nsec) ?? voterSecretKey,
          coordinatorNpub: entry.coordinatorNpub,
          voterNpub,
          replyNpub: entry.replyNpub,
          votingId: round.votingId,
          blindRequest: entry.request,
        });
      }));

      const nextRequests = Object.fromEntries(
        createdEntries.map((entry, index) => [
          `${entry.coordinatorNpub}:${entry.votingId}`,
          results[index].successes > 0
            ? {
                ...entry,
                dmEventId: results[index].eventId,
                mailboxId: results[index].mailboxId,
                mailboxSalt: results[index].mailboxSalt,
                mailboxFrozenAt: results[index].mailboxId ? new Date().toISOString() : undefined,
                mailboxFrozenValue: results[index].mailboxId,
              }
            : entry,
        ]),
      );
      setPendingBlindRequests((current) => ({ ...current, ...nextRequests }));
      const nextRequestDeliveries = Object.fromEntries(createdEntries.map((entry, index) => [
        `${entry.coordinatorNpub}:${entry.votingId}`,
        {
          status: results[index].successes > 0 ? "Blinded ticket request sent." : "Blinded ticket request failed.",
          eventId: results[index].eventId,
          requestId: entry.request.requestId,
          attempts: 1,
          lastAttemptAt: new Date().toISOString(),
        },
      ]));
      setRequestDeliveries((current) => ({ ...current, ...nextRequestDeliveries }));

      setRequestStatus(
        results.some((result) => result.successes > 0)
          ? "Coordinators notified. Waiting for round tickets."
          : "Blinded ticket requests failed.",
      );
    })();
  }, [
    configuredCoordinatorTargets,
    effectiveLiveVoteSession,
    knownBlindKeys,
    pendingBlindRequests,
    receivedShards,
    roundReplyKeypairs,
    voterId,
    voterKeypair?.npub,
    voterKeypair?.nsec,
  ]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const retryKeys = new Set(selectRequestRetryKeysRust({
        pendingRequests: Object.entries(pendingBlindRequests).map(([key, requestEntry]) => ({
          key,
          requestId: requestEntry.request.requestId,
        })),
        requestDeliveries,
        acknowledgements: dmAcknowledgements.map((ack) => ({
          actorNpub: ack.actorNpub,
          ackedAction: ack.ackedAction,
          ackedEventId: ack.ackedEventId,
        })),
        receivedRequestIds: receivedShards.map((response) => response.requestId),
        nowMs: now,
        minRetryAgeMs: SIMPLE_REQUEST_RETRY_MIN_AGE_MS,
        maxAttempts: 8,
      }));
      const retryEntries = Object.entries(pendingBlindRequests).filter(([key]) => retryKeys.has(key));

      if (!retryEntries.length) {
        return;
      }

      void Promise.all(retryEntries.map(async ([key, requestEntry]) => {
        const replyKeypair = roundReplyKeypairs[requestEntry.votingId];
        const senderSecretKey = decodeNsec(replyKeypair?.nsec ?? "");
        const voterNpub = voterKeypair?.npub ?? "";
        if (!senderSecretKey || !voterNpub) {
          return null;
        }
        await wait(randomHumanActionDelayMs());
        const result = await sendSimpleShardRequest({
          voterSecretKey: senderSecretKey,
          coordinatorNpub: requestEntry.coordinatorNpub,
          voterNpub,
          replyNpub: requestEntry.replyNpub,
          votingId: requestEntry.votingId,
          blindRequest: requestEntry.request,
          mailboxSalt: requestEntry.mailboxSalt,
          attemptNo: (requestDeliveries[key]?.attempts ?? 0) + 1,
          supersedesEventId: requestDeliveries[key]?.eventId,
        });
        return { key, result, requestId: requestEntry.request.requestId };
      })).then((results) => {
        const completed = results.filter((value): value is NonNullable<typeof value> => value !== null);
        if (!completed.length) {
          return;
        }
        setPendingBlindRequests((current) => {
          const next = { ...current };
          for (const { key, result } of completed) {
            if (!result.successes) {
              continue;
            }
            const previous = next[key];
            if (!previous) {
              continue;
            }
            const resolvedMailboxId = result.mailboxId?.trim() || previous.mailboxId?.trim();
            next[key] = {
              ...previous,
              dmEventId: result.eventId,
              mailboxId: resolvedMailboxId,
              mailboxSalt: result.mailboxSalt ?? previous.mailboxSalt,
              mailboxFrozenValue: previous.mailboxFrozenValue ?? resolvedMailboxId,
              mailboxFrozenAt: previous.mailboxFrozenAt ?? (resolvedMailboxId ? new Date().toISOString() : undefined),
            };
          }
          return next;
        });
        setRequestDeliveries((current) => {
          const next = { ...current };
          for (const { key, result, requestId } of completed) {
            const previous = current[key];
            next[key] = {
              status: result.successes > 0 ? "Blinded ticket request resent." : "Blinded ticket request retry failed.",
              eventId: result.eventId,
              requestId,
              attempts: (previous?.attempts ?? 0) + 1,
              lastAttemptAt: new Date().toISOString(),
            };
          }
          return next;
        });
      }).catch(() => undefined);
    }, SIMPLE_REQUEST_RETRY_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [dmAcknowledgements, pendingBlindRequests, receivedShards, requestDeliveries, roundReplyKeypairs, voterKeypair?.npub]);

  useEffect(() => {
    if (!voterKeypair?.npub) {
      return;
    }

    for (const response of receivedShards) {
      if (!response.dmEventId || sentTicketReceiptAckIdsRef.current.has(response.dmEventId)) {
        continue;
      }

      const responseVotingId = response.shardCertificate?.votingId
        ?? Object.values(pendingBlindRequests).find((request) => request.request.requestId === response.requestId)?.votingId;
      const replyKeypair = responseVotingId ? roundReplyKeypairs[responseVotingId] : null;
      const senderSecretKey = decodeNsec(replyKeypair?.nsec ?? "");
      const actorNpub = replyKeypair?.npub ?? "";
      if (!senderSecretKey || !actorNpub) {
        continue;
      }

      recordSimpleTicketLifecycleTrace({
        votingId: responseVotingId,
        coordinatorNpub: response.coordinatorNpub,
        voterNpub: voterKeypair.npub,
        requestId: response.requestId,
        responseId: response.id,
        updates: {
          ticketObservedByVoterAt: Date.now(),
        },
      });
      sentTicketReceiptAckIdsRef.current.add(response.dmEventId);
      void (async () => {
        await wait(randomHumanActionDelayMs());
        await sendSimpleDmAcknowledgement({
          senderSecretKey,
          recipientNpub: response.coordinatorNpub,
          actorNpub,
          ackedAction: "simple_round_ticket",
          ackedEventId: response.dmEventId,
          votingId: responseVotingId,
          requestId: response.requestId,
          responseId: response.id,
          mailboxId: response.mailboxId,
        });
        setTicketAckSent(true);
      })().catch(() => {
        sentTicketReceiptAckIdsRef.current.delete(response.dmEventId);
      });
    }
  }, [pendingBlindRequests, receivedShards, roundReplyKeypairs, voterKeypair?.npub]);

  const requiredShardCount = Math.max(1, effectiveLiveVoteSession?.thresholdT ?? 1);
  const voteSubmittedSuccessfully = submitStatus?.startsWith("Vote submitted:") ?? false;
  const voteSubmitting = submitStatus === "Submitting vote...";
  const voteTicketReady = uniqueShardResponses.length >= requiredShardCount && requiredShardCount > 0;
  const ticketObserved = uniqueShardResponses.length > 0;
  const ticketObservedLiveCount = uniqueShardResponses.filter((response) => (
    Boolean(ticketObservationMetaRef.current[response.id]?.liveAt)
  )).length;
  const ticketObservedBackfillCount = uniqueShardResponses.filter((response) => (
    Boolean(ticketObservationMetaRef.current[response.id]?.backfillAt)
  )).length;
  const ticketObservedLiveAt = uniqueShardResponses
    .map((response) => ticketObservationMetaRef.current[response.id]?.liveAt)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right)[0];
  const ticketObservedBackfillAt = uniqueShardResponses
    .map((response) => ticketObservationMetaRef.current[response.id]?.backfillAt)
    .filter((value): value is number => typeof value === "number")
    .sort((left, right) => left - right)[0];
  const hasCoordinatorConnection = coordinatorDiagnostics.some((entry) => (
    entry.follow.tone === "ok"
    || entry.round.tone === "ok"
    || entry.request.tone === "ok"
    || entry.ticket.tone === "ok"
  ));
  const missingActiveVoteCoordinatorIndices = effectiveLiveVoteSession
    ? configuredCoordinatorTargets
      .map((value, index) => (
        effectiveLiveVoteSession.authorizedCoordinatorNpubs.includes(value)
        && !knownBlindKeys[makeRoundBlindKeyId(value, effectiveLiveVoteSession.votingId)]
          ? index + 1
          : null
      ))
      .filter((value): value is number => value !== null)
    : [];
  const waitingForCoordinatorKeyText = formatMissingCoordinatorKeyText(
    missingActiveVoteCoordinatorIndices,
  );
  const hideLegacyLiveVotePanel = questionnaireContext.hasDefinition;
  const questionnaireVoteReady =
    votePaneUnlocked
    || questionnaireContext.hasDefinition
    || readyAnnouncedQuestionnaireIds.length > 0;
  const waitingForQuestionnaireData =
    !questionnaireContext.hasDefinition
    && announcedQuestionnaireIds.length > 0
    && readyAnnouncedQuestionnaireIds.length === 0;

  useEffect(() => {
    setTicketAckSent(false);
    setBallotSubmitted(false);
    setBallotAccepted(false);
    ticketObservationMetaRef.current = {};
    ticketLiveQueryDebugRef.current = null;
    ticketBackfillQueryDebugRef.current = null;
    ticketBackfillRequestDebugRef.current = {};
    ticketLiveQueryByRequestRef.current = {};
    ticketBackfillQueryByRequestRef.current = {};
    ticketMailboxMismatchRef.current = {};
  }, [effectiveLiveVoteSession?.votingId]);

  useEffect(() => {
    const owner = globalThis as typeof globalThis & {
      __simpleVoterDebug?: unknown;
    };
    const roundSeen = coordinatorDiagnostics.some((entry) => entry.round.tone === "ok");
    const blindKeySeen = coordinatorDiagnostics.some((entry) => entry.blindKey.tone === "ok");
    const ticketBackfillByRequestId = Object.fromEntries(
      Object.entries(ticketBackfillRequestDebugRef.current).map(([requestId, value]) => {
        const observedByRequest = uniqueShardResponses.find((response) => response.requestId === requestId);
        const mismatch = ticketMailboxMismatchRef.current[requestId];
        const requestMailboxId = value.requestMailboxId ?? null;
        const liveQuery = ticketLiveQueryByRequestRef.current[requestId];
        const backfillQuery = ticketBackfillQueryByRequestRef.current[requestId];
        const ticketReadMailboxId = observedByRequest?.mailboxId?.trim()
          || liveQuery?.mailboxIds?.[0]
          || value.ticketReadMailboxId
          || mismatch?.observedMailboxId
          || null;
        const ticketBackfillMailboxId = backfillQuery?.mailboxIds?.[0]
          || value.ticketBackfillMailboxId
          || null;
        const mailboxIdConsistent = Boolean(
          requestMailboxId
          && (ticketBackfillMailboxId ? requestMailboxId === ticketBackfillMailboxId : true)
          && (!ticketReadMailboxId || ticketReadMailboxId === requestMailboxId),
        );
        const observed = uniqueShardResponses.some((response) => (
          response.requestId === requestId
          || (value.requestMailboxId && response.mailboxId?.trim() === value.requestMailboxId)
        ));
        const backfillClass = value.attemptCount <= 0
          ? "backfill_not_triggered"
          : value.lastResultCount <= 0
            ? "backfill_no_events_returned"
            : value.lastMatchedCount <= 0
              ? "backfill_events_returned_no_match"
              : observed
                ? "backfill_match_found_observed"
                : "backfill_match_found_not_reconciled";
        return [requestId, {
          ...value,
          ticketReadMailboxId,
          ticketBackfillMailboxId,
          mailboxIdConsistent,
          observed,
          backfillClass,
        }];
      }),
    );
    const backfillRequestDebugRows = Object.values(ticketBackfillByRequestId);
    const ticketBackfillAttemptCount = backfillRequestDebugRows.reduce(
      (total, entry) => total + Number(entry.attemptCount ?? 0),
      0,
    );
    const ticketBackfillLastAttemptAt = backfillRequestDebugRows
      .map((entry) => Date.parse(entry.lastAttemptAt ?? ""))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)[0];
    const ticketBackfillLastResultCount = backfillRequestDebugRows
      .map((entry) => Number(entry.lastResultCount ?? 0))
      .sort((left, right) => right - left)[0] ?? 0;
    const ticketBackfillLastMatchedCount = backfillRequestDebugRows
      .map((entry) => Number(entry.lastMatchedCount ?? 0))
      .sort((left, right) => right - left)[0] ?? 0;
    const ticketBackfillLastSourceRelays = Array.from(
      new Set(backfillRequestDebugRows.flatMap((entry) => entry.lastSourceRelays ?? [])),
    );
    const ticketBackfillFailureClass = ticketBackfillAttemptCount <= 0
      ? "backfill_not_triggered"
      : ticketBackfillLastResultCount <= 0
        ? "backfill_no_events_returned"
        : ticketBackfillLastMatchedCount <= 0
          ? "backfill_events_returned_no_match"
          : ticketObserved
            ? "backfill_match_found_observed"
            : "backfill_match_found_not_reconciled";
    const ticketMailboxMismatches = Object.values(ticketMailboxMismatchRef.current);
    owner.__simpleVoterDebug = {
      deploymentMode,
      voterNpub: voterKeypair?.npub ?? null,
      hasLiveRound: Boolean(effectiveLiveVoteSession),
      selectedVotingId: effectiveLiveVoteSession?.votingId ?? null,
      knownRoundCount: knownRounds.length,
      roundSeen,
      blindKeySeen,
      ticketObserved,
      ticketObservedLiveCount,
      ticketObservedBackfillCount,
      ticketObservedLiveAt: ticketObservedLiveAt ? new Date(ticketObservedLiveAt).toISOString() : null,
      ticketObservedBackfillAt: ticketObservedBackfillAt ? new Date(ticketObservedBackfillAt).toISOString() : null,
      ticketPendingMailboxIds: pendingTicketMailboxIds,
      ticketLiveQuery: ticketLiveQueryDebugRef.current,
      ticketBackfillQuery: ticketBackfillQueryDebugRef.current,
      ticketBackfillAttemptCount,
      ticketBackfillLastAttemptAt: Number.isFinite(ticketBackfillLastAttemptAt)
        ? new Date(ticketBackfillLastAttemptAt).toISOString()
        : null,
      ticketBackfillLastResultCount,
      ticketBackfillLastMatchedCount,
      ticketBackfillLastSourceRelays,
      ticketBackfillFailureClass,
      ticketBackfillByRequestId,
      ticketLiveMailboxIds: Array.isArray(ticketLiveQueryDebugRef.current?.mailboxIds)
        ? ticketLiveQueryDebugRef.current.mailboxIds
        : [],
      ticketBackfillMailboxIds: Array.isArray(ticketBackfillQueryDebugRef.current?.mailboxIds)
        ? ticketBackfillQueryDebugRef.current.mailboxIds
        : [],
      ticketMailboxMismatchCount: ticketMailboxMismatches.length,
      ticketMailboxMismatches,
      ticketAckSent,
      ballotSubmitted,
      ballotAccepted,
      ticketReady: {
        ready: uniqueShardResponses.length,
        required: requiredShardCount,
      },
      requestStatus,
    };
  }, [
    deploymentMode,
    effectiveLiveVoteSession,
    knownRounds.length,
    requestStatus,
    requiredShardCount,
    ticketObserved,
    ticketObservedLiveCount,
    ticketObservedBackfillCount,
    ticketObservedLiveAt,
    ticketObservedBackfillAt,
    pendingTicketMailboxIds,
    ticketAckSent,
    ballotSubmitted,
    ballotAccepted,
    voterKeypair?.npub,
    coordinatorDiagnostics,
    uniqueShardResponses,
  ]);

  function selectTab(nextTab: VoterTab) {
    if (nextTab === "vote" && !questionnaireVoteReady) {
      setRequestStatus(waitingForQuestionnaireData
        ? "Waiting for questionnaire data from coordinator."
        : "Waiting for questions to be published.");
      setActiveTab("configure");
      return;
    }
    if (nextTab === "vote" && questionnaireModeActive) {
      setVotePaneUnlocked(true);
      setOptionARequestBlindBallotNonce((value) => value + 1);
    }
    setActiveTab(nextTab);
  }

  async function submitVote() {
    if (!effectiveLiveVoteSession || !liveVoteChoice || uniqueShardResponses.length < requiredShardCount) {
      return;
    }

    const primaryResponse = uniqueShardResponses[0];
    const ballotId = crypto.randomUUID();
    setBallotSubmitted(true);
    setSubmitStatus("Submitting vote...");

    try {
      const ballotSecretKey = generateSecretKey();
      const ballotNsec = nip19.nsecEncode(ballotSecretKey);
      const result = await publishSimpleSubmittedVote({
        ballotNsec,
        ballotId,
        votingId: effectiveLiveVoteSession.votingId,
        requestId: primaryResponse?.requestId,
        ticketId: primaryResponse?.id,
        choice: liveVoteChoice,
        shardCertificates: uniqueShardResponses
          .map((shard) => shard.shardCertificate)
          .filter((certificate): certificate is NonNullable<typeof certificate> => certificate !== undefined),
      });

      if (result.successes > 0) {
        setBallotAccepted(true);
      }
      setSubmitStatus(result.successes > 0 ? `Vote submitted: ${liveVoteChoice}.` : "Vote submission failed.");
    } catch {
      setSubmitStatus("Vote submission failed.");
    }
  }

  if (storageLocked && !identityReady) {
    return (
      <SimpleUnlockGate
        roleLabel="Voter"
        status={storageStatus}
        onUnlock={unlockLocalState}
        onReset={async () => {
          await clearSimpleActorState("voter");
          setStorageLocked(false);
          setStoragePassphrase("");
          const nextKeypair = createSimpleVoterKeypair();
          await saveSimpleActorState({
            role: "voter",
            keypair: nextKeypair,
            updatedAt: new Date().toISOString(),
          });
          setVoterKeypair(nextKeypair);
          setIdentityReady(true);
          setStorageStatus("Locked local voter state reset.");
        }}
      />
    );
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>Voter ID {voterId}</h1>
        </div>
        {signerNpub ? <p className='simple-voter-note'>Signed in as {signerNpub}</p> : null}
        {signerStatus && signerStatus !== `Signed in as ${signerNpub}.` ? <p className='simple-voter-note'>{signerStatus}</p> : null}
        <div
          className='simple-voter-tabs'
          role='tablist'
          aria-label='Voter sections'
        >
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'configure'}
            className={`simple-voter-tab${activeTab === 'configure' ? ' is-active' : ''}`}
            onClick={() => selectTab('configure')}
          >
            Configure
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'vote'}
            className={`simple-voter-tab${activeTab === 'vote' ? ' is-active' : ''}`}
            onClick={() => selectTab('vote')}
            disabled={!questionnaireVoteReady}
          >
            Vote
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
            aria-label='Configure'
          >
            <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
              <h4 className='simple-voter-section-title'>Request invite from coordinator</h4>
              <div className='simple-voter-add-row simple-voter-add-row-with-scan'>
                <input
                  id='simple-coordinator-draft'
                  className='simple-voter-input simple-voter-input-inline'
                  value={coordinatorDraft}
                  onChange={(event) => {
                    setCoordinatorDraft(event.target.value);
                    setCoordinatorScannerStatus(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addCoordinatorInput();
                    }
                  }}
                  placeholder='Enter coordinator npub...'
                />
                <button
                  type='button'
                  className='simple-voter-add-button'
                  onClick={addCoordinatorInput}
                  aria-label='Add coordinator'
                >
                  +
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary simple-voter-scan-button'
                  onClick={() => {
                    setCoordinatorScannerStatus(null);
                    setCoordinatorScannerActive(true);
                  }}
                >
                  Scan QR of npub
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => void checkQuestionnaireInvites()}
                >
                  Check invites
                </button>
              </div>
              <SimpleQrScanner
                active={coordinatorScannerActive}
                onDetected={handleCoordinatorScanDetected}
                onClose={() => setCoordinatorScannerActive(false)}
                prompt='Point the camera at a coordinator npub QR code.'
              />
              {coordinatorScannerStatus ? (
                <p className='simple-voter-note'>{coordinatorScannerStatus}</p>
              ) : null}
              {configuredCoordinatorTargets.length > 0 ? (
                <ul className='simple-coordinator-card-list'>
                  {configuredCoordinatorTargets.map((value, index) => (
                    <li key={value} className='simple-coordinator-card'>
                      <TokenFingerprint tokenId={value} compact showQr={false} hideMetadata />
                      <div className='simple-coordinator-card-copy'>
                        <p className='simple-coordinator-card-title'>
                          Coordinator {index + 1}
                        </p>
                        <p
                          className='simple-coordinator-card-meta'
                          title={value}
                        >
                          {shortenNpub(value)}
                        </p>
                      </div>
                      <button
                        type='button'
                        className='simple-coordinator-card-remove'
                        onClick={() => removeCoordinatorInput(index)}
                        aria-label={`Remove coordinator ${index + 1}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='simple-voter-empty'>No coordinators added yet.</p>
              )}
            </div>
            {questionnaireModeActive ? (
              <div className='simple-voter-action-row simple-voter-action-row-tight'>
                <button
                  type='button'
                  className='simple-voter-primary simple-voter-primary-wide'
                  onClick={() => selectTab('vote')}
                  disabled={
                    !voterKeypair?.npub ||
                    configuredCoordinatorTargets.length === 0 ||
                    !questionnaireVoteReady
                  }
                >
                  Vote
                </button>
              </div>
            ) : coordinatorsHaveBeenNotified ? (
              <div className='simple-voter-action-row simple-voter-action-row-tight'>
                <button
                  type='button'
                  className='simple-voter-primary simple-voter-primary-wide'
                  onClick={() => selectTab('vote')}
                  disabled={
                    !voterKeypair?.npub ||
                    configuredCoordinatorTargets.length === 0 ||
                    !questionnaireVoteReady
                  }
                >
                  Vote
                </button>
              </div>
            ) : hasUnresponsiveCoordinators ? (
              <div className='simple-voter-action-row simple-voter-action-row-tight'>
                <button
                  type='button'
                  className='simple-voter-secondary simple-voter-primary-wide'
                  onClick={() => void retryUnresponsiveCoordinators()}
                  disabled={
                    !voterKeypair?.npub ||
                    configuredCoordinatorTargets.length === 0
                  }
                >
                  Retry
                </button>
              </div>
            ) : null}
            {requestStatus ? (
              <p className='simple-voter-note'>{requestStatus}</p>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'vote' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Vote'
          >
            <QuestionnaireVoterPanel
              onContextChange={(nextContext) => {
                setQuestionnaireContext(nextContext);
                if (nextContext.hasDefinition) {
                  setVotePaneUnlocked(true);
                }
              }}
              participationHistory={questionnaireParticipationHistory}
              onParticipationHistoryChange={setQuestionnaireParticipationHistory}
              announcedQuestionnaireIds={readyAnnouncedQuestionnaireIds}
              optionAAnnouncedQuestionnaireIds={announcedQuestionnaireIds}
              localVoterNpub={activeVoterNpub}
              localVoterNsec={signerNpub ? "" : (voterKeypair?.nsec ?? "")}
              autoSignerLogin={Boolean(signerNpub.trim())}
              optionARequestBlindBallotNonce={optionARequestBlindBallotNonce}
            />
            {isCourseFeedbackMode || hideLegacyLiveVotePanel || questionnaireModeActive ? null : (
            effectiveLiveVoteSession ? (
              <>
                {knownRounds.length > 1 ? (
                  <div className='simple-voter-round-picker'>
                    <label
                      className='simple-voter-label'
                      htmlFor='simple-live-round'
                    >
                      Round
                    </label>
                    <select
                      id='simple-live-round'
                      className='simple-voter-input'
                      value={effectiveLiveVoteSession.votingId}
                      onChange={(event) => {
                        manualRoundSelectionRef.current = true;
                        setSelectedVotingId(event.target.value);
                      }}
                    >
                      {knownRounds.map((round) => (
                        <option key={round.votingId} value={round.votingId}>
                          {formatRoundOptionLabel(round)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div className='simple-vote-card'>
                  <h2 className='simple-vote-card-title'>
                    {effectiveLiveVoteSession.prompt}
                  </h2>
                  <p className='simple-vote-card-meta'>
                    Tickets ready: {uniqueShardResponses.length} of{' '}
                    {requiredShardCount}
                  </p>
                </div>

                <div className='simple-vote-button-grid'>
                  <button
                    type='button'
                    className={`simple-voter-choice simple-voter-choice-yes${liveVoteChoice === 'Yes' ? ' is-active' : ''}${liveVoteChoice === 'No' ? ' is-dimmed' : ''}${voteTicketReady && !liveVoteChoice ? ' is-awaiting-choice' : ''}`}
                    onClick={() => setLiveVoteChoice('Yes')}
                  >
                    Yes
                  </button>
                  <button
                    type='button'
                    className={`simple-voter-choice simple-voter-choice-no${liveVoteChoice === 'No' ? ' is-active' : ''}${liveVoteChoice === 'Yes' ? ' is-dimmed' : ''}${voteTicketReady && !liveVoteChoice ? ' is-awaiting-choice' : ''}`}
                    onClick={() => setLiveVoteChoice('No')}
                  >
                    No
                  </button>
                </div>

                <button
                  type='button'
                  className={`simple-voter-primary simple-voter-primary-wide simple-vote-submit${voteSubmittedSuccessfully ? ' is-success' : ''}`}
                  onClick={() => void submitVote()}
                  disabled={
                    voteSubmitting ||
                    voteSubmittedSuccessfully ||
                    !liveVoteChoice ||
                    uniqueShardResponses.length < requiredShardCount
                  }
                >
                  {voteSubmitting
                    ? 'Submitting vote...'
                    : voteSubmittedSuccessfully
                      ? 'Vote submitted'
                      : !liveVoteChoice || uniqueShardResponses.length < requiredShardCount
                        ? 'Preparing vote'
                        : 'Submit vote'}
                </button>

                <section
                  className='simple-vote-status-card'
                  aria-label='Vote status'
                >
                  <h3 className='simple-vote-status-title'>Status</h3>
                  <ul className='simple-vote-status-list'>
                    <li
                      className={
                        hasCoordinatorConnection ? 'is-complete' : 'is-pending'
                      }
                    >
                      <span
                        className='simple-vote-status-icon'
                        aria-hidden='true'
                      >
                        {hasCoordinatorConnection ? '✓' : '○'}
                      </span>
                      <span>
                        {hasCoordinatorConnection
                          ? 'Connected to voting network'
                          : 'Waiting to connect to coordinators'}
                      </span>
                    </li>
                    <li
                      className={voteTicketReady ? 'is-complete' : 'is-pending'}
                    >
                      <span
                        className='simple-vote-status-icon'
                        aria-hidden='true'
                      >
                        {voteTicketReady ? '✓' : '○'}
                      </span>
                      <span>
                        {voteTicketReady
                          ? 'Ticket received. You can now submit your ballot.'
                          : waitingForCoordinatorKeyText}
                      </span>
                    </li>
                    <li
                      className={
                        voteSubmittedSuccessfully ? 'is-complete' : 'is-pending'
                      }
                    >
                      <span
                        className='simple-vote-status-icon'
                        aria-hidden='true'
                      >
                        {voteSubmittedSuccessfully ? '✓' : '○'}
                      </span>
                      <span>
                        {voteSubmittedSuccessfully
                          ? 'Vote submitted successfully'
                          : 'Vote not submitted yet'}
                      </span>
                    </li>
                  </ul>
                  {submitStatus && !voteSubmittedSuccessfully ? (
                    <p className='simple-voter-note'>{submitStatus}</p>
                  ) : null}
                  <button
                    type='button'
                    className='simple-vote-details-toggle'
                    onClick={() => setShowVoteDetails((current) => !current)}
                    aria-expanded={showVoteDetails}
                  >
                    {showVoteDetails ? 'Hide details' : 'Show details'}
                  </button>
                  {showVoteDetails ? (
                    <div className='simple-vote-details'>
                      {ballotTokenId ? (
                        <div className='simple-vote-entry simple-vote-entry-ballot'>
                          <div className='simple-vote-entry-copy'>
                            <h3 className='simple-voter-question'>
                              Ballot footprint
                            </h3>
                          </div>
                          <div className='simple-vote-entry-media'>
                            <TokenFingerprint tokenId={ballotTokenId} large />
                          </div>
                        </div>
                      ) : null}
                      <div className='simple-voter-ticket-area'>
                        <h3 className='simple-voter-question'>
                          Live Vote Tickets Received
                        </h3>
                        {voteTicketRows.length > 0 &&
                        configuredCoordinatorTargets.length > 0 ? (
                          <div className='simple-voter-table-wrap'>
                            <table className='simple-voter-table'>
                              <thead>
                                <tr>
                                  <th scope='col'>Vote</th>
                                  {configuredCoordinatorTargets.map(
                                    (coordinatorNpub, index) => (
                                      <th key={coordinatorNpub} scope='col'>
                                        Coord {index + 1}
                                      </th>
                                    ),
                                  )}
                                </tr>
                              </thead>
                              <tbody>
                                {voteTicketRows.map((row) => (
                                  <tr key={row.votingId}>
                                    <th scope='row'>
                                      {shortVotingId(row.votingId)}
                                    </th>
                                    {configuredCoordinatorTargets.map(
                                      (coordinatorNpub) => (
                                        <td
                                          key={`${row.votingId}:${coordinatorNpub}`}
                                        >
                                          {row.countsByCoordinator[
                                            coordinatorNpub
                                          ] ?? 0}
                                        </td>
                                      ),
                                    )}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className='simple-voter-empty'>
                            No vote tickets received yet.
                          </p>
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            ) : (
              <div className='simple-vote-empty-state'>
                <p className='simple-voter-question'>
                  No live vote ticket yet.
                </p>
                <p className='simple-voter-note'>
                  {coordinatorsHaveBeenNotified
                    ? 'Waiting for the next live round and ticket.'
                    : 'Add coordinators in Configure, then wait for the next live round and ticket.'}
                </p>
              </div>
            )
            )}
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Settings'
          >
            <SimpleIdentityPanel
              npub={activeVoterNpub}
              nsec={signerNpub ? '' : (voterKeypair?.nsec ?? '')}
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
            <section className='simple-settings-card' aria-label='Relay hint settings'>
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
                Disabled by default. Turn this on only if you want to publish and use NIP-65 inbox/outbox relay hints.
              </p>
            </section>
            <SimpleRelayPanel />
          </section>
        ) : null}
      </section>
    </main>
  );
}

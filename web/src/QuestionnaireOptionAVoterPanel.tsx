import { useEffect, useMemo, useRef, useState } from "react";
import { finalizeEvent, getPublicKey, nip19, nip44 } from "nostr-tools";
import {
  fetchQuestionnaireActiveWorkerDelegationForCapability,
  fetchQuestionnaireDefinitions,
} from "./questionnaireTransport";
import { parseInviteFromUrl } from "./questionnaireInvite";
import { createSignerService, SignerServiceError, type SignerService } from "./services/signerService";
import {
  QuestionnaireOptionAVoterRuntime,
  OptionARuntimeError,
} from "./questionnaireOptionARuntime";
import type { ElectionInviteMessage, QuestionnaireAnswer, VoterElectionLocalState } from "./questionnaireOptionA";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  loadElectionSummary,
  listInvitesFromMailbox,
  publishInviteToMailbox,
  upsertElectionSummary,
} from "./questionnaireOptionAStorage";
import { fetchOptionAInviteDms, fetchOptionAInviteDmsWithNsec } from "./questionnaireOptionAInviteDm";
import { readCachedQuestionnaireDefinition, storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { mergeQuestionnaireRelayHints } from "./questionnaireRelays";
import TokenFingerprint from "./TokenFingerprint";
import { decodeNsec } from "./nostrIdentity";
import { buildIssueBlindTokensWorkerRouting } from "./questionnaireWorkerRouting";

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

function createLocalNsecSignerService(nsec: string): SignerService {
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

function createVoterSignerService(localVoterNsec?: string): SignerService {
  const trimmed = localVoterNsec?.trim() ?? "";
  if (trimmed) {
    return createLocalNsecSignerService(trimmed);
  }
  return createSignerService();
}

function deriveElectionId() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("q") ?? params.get("election_id") ?? params.get("questionnaire") ?? "").trim();
}

function answerToOptionA(
  question: { questionId: string; type: "yes_no" | "multiple_choice" | "rank" | "free_text" },
  value: unknown,
  encryptForCoordinator = false,
): QuestionnaireAnswer | null {
  if (question.type === "yes_no") {
    if (value !== "yes" && value !== "no") {
      return null;
    }
    return { questionId: question.questionId, type: "yes_no", answer: value };
  }
  if (question.type === "multiple_choice") {
    const answers = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    if (answers.length === 0) {
      return null;
    }
    return { questionId: question.questionId, type: "multiple_choice", answer: answers };
  }
  if (question.type === "rank") {
    const answers = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
    if (answers.length === 0) {
      return null;
    }
    return { questionId: question.questionId, type: "rank", answer: answers };
  }
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  return { questionId: question.questionId, type: "text", answer: text, encryptForCoordinator };
}

function mapDefinitionQuestions(definition: QuestionnaireDefinition) {
  return definition.questions.map((question) => ({
    questionId: question.questionId,
    required: question.required,
    prompt: question.prompt,
    type: question.type,
    options: question.type === "multiple_choice" || question.type === "rank" ? question.options : undefined,
    multiSelect: question.type === "multiple_choice" ? question.multiSelect : undefined,
    minimumRanked: question.type === "rank" ? question.minimumRanked : undefined,
    maxLength: question.type === "free_text" ? question.maxLength : undefined,
  }));
}

function latestDefinitionFromEntries(entries: Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>) {
  return [...entries].sort((a, b) => (b.event.created_at ?? 0) - (a.event.created_at ?? 0))[0]?.definition ?? null;
}

function cacheDefinitionForVoting(
  definition: QuestionnaireDefinition,
  issueBlindTokensWorker?: ElectionInviteMessage["issueBlindTokensWorker"],
) {
  storeCachedQuestionnaireDefinition(definition);
  const electionId = definition.questionnaireId.trim();
  const coordinatorNpub = definition.coordinatorPubkey.trim();
  if (!electionId || !coordinatorNpub) {
    return;
  }
  const existing = loadElectionSummary(electionId);
  const closed = Number.isFinite(definition.closeAt) && definition.closeAt <= Math.floor(Date.now() / 1000);
  upsertElectionSummary({
    electionId,
    title: definition.title || existing?.title || "Questionnaire",
    description: definition.description ?? existing?.description ?? "",
    state: existing?.state ?? (closed ? "closed" : "open"),
    openedAt: Number.isFinite(definition.openAt) ? new Date(definition.openAt * 1000).toISOString() : existing?.openedAt ?? null,
    closedAt: Number.isFinite(definition.closeAt) ? new Date(definition.closeAt * 1000).toISOString() : existing?.closedAt ?? null,
    coordinatorNpub,
    blindSigningPublicKey: definition.blindSigningPublicKey ?? existing?.blindSigningPublicKey ?? null,
    questionnaireRelays: definition.questionnaireRelays,
    issueBlindTokensWorker: issueBlindTokensWorker === undefined
      ? existing?.issueBlindTokensWorker ?? null
      : issueBlindTokensWorker,
    protocolVersion: definition.protocolVersion ?? existing?.protocolVersion,
    flowMode: definition.flowMode ?? existing?.flowMode,
    responseMode: definition.responseMode ?? existing?.responseMode,
  });
}

function buildInviteFromPublicDefinition(
  definition: QuestionnaireDefinition,
  invitedNpub: string,
  issueBlindTokensWorker?: ElectionInviteMessage["issueBlindTokensWorker"],
): ElectionInviteMessage | null {
  const electionId = definition.questionnaireId.trim();
  const coordinatorNpub = definition.coordinatorPubkey.trim();
  if (!electionId || !coordinatorNpub || !invitedNpub.trim()) {
    return null;
  }
  return {
    type: "election_invite",
    schemaVersion: 1,
    electionId,
    title: definition.title || "Questionnaire",
    description: definition.description ?? "",
    voteUrl: typeof window === "undefined" ? "" : window.location.href,
    invitedNpub: invitedNpub.trim(),
    coordinatorNpub,
    blindSigningPublicKey: definition.blindSigningPublicKey ?? null,
    issueBlindTokensWorker: issueBlindTokensWorker ?? null,
    definition,
    expiresAt: null,
  };
}

const LEGACY_INVITE_TITLE = "Should the proposal pass?";
const AUTO_BALLOT_REQUEST_MIN_INTERVAL_MS = 15_000;
const AUTO_BALLOT_PAGE_LOAD_REQUEST_DELAY_MS = 1_000;
const AUTO_BALLOT_RETRY_POLL_MS = 20_000;
const AUTO_BALLOT_RETRY_RESEND_MS = 8 * 60_000;
const AUTO_BALLOT_SIGNER_REFRESH_SCHEDULE_MS = [15_000, 45_000, 120_000] as const;
const AUTO_BALLOT_SIGNER_KEEPALIVE_REFRESH_MS = 75_000;
const AUTO_BALLOT_MOBILE_RECOVERY_PULL_MS = 45_000;
const AUTO_BALLOT_WAIT_FOREGROUND_REFRESH_MS = 8_000;
const AUTO_BALLOT_SIGNER_SUBSCRIPTION_REARM_MIN_INTERVAL_MS = 15_000;
const AUTO_BALLOT_SIGNER_BACKGROUND_FETCH_MIN_INTERVAL_MS = 90_000;
const AUTO_BALLOT_SIGNER_LIFECYCLE_FETCH_MIN_INTERVAL_MS = 45_000;
const AUTO_BALLOT_SIGNER_INITIAL_PULL_DELAY_MS = 8_000;
type BallotWaitRefreshMode = "manual" | "lifecycle" | "background" | "restart_only";

function isLikelyMobileClient() {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const coarsePointer = typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches
    : false;
  if (coarsePointer) {
    return true;
  }
  const userAgent = navigator.userAgent || "";
  return /android|iphone|ipad|ipod|mobile/i.test(userAgent);
}
const AUTO_INVITE_REFRESH_INTERVAL_MS = 45_000;

function resolveInviteDisplayTitle(invite: ElectionInviteMessage) {
  const fromDefinition = invite.definition?.title?.trim() ?? "";
  if (fromDefinition) {
    return fromDefinition;
  }
  const fromCache = readCachedQuestionnaireDefinition(invite.electionId)?.title?.trim() ?? "";
  if (fromCache) {
    return fromCache;
  }
  const fromSummary = loadElectionSummary(invite.electionId)?.title?.trim() ?? "";
  if (fromSummary) {
    return fromSummary;
  }
  const fromInvite = invite.title?.trim() ?? "";
  if (fromInvite && fromInvite !== LEGACY_INVITE_TITLE) {
    return fromInvite;
  }
  return invite.electionId;
}

type QuestionnaireOptionAVoterPanelProps = {
  announcedQuestionnaireIds?: string[];
  localVoterNpub?: string;
  localVoterNsec?: string;
  autoSignerLogin?: boolean;
  requestBlindBallotNonce?: number;
  displayMode?: "vote" | "settings";
  showLoginAction?: boolean;
};

function getRankRequirementState(optionCount: number, minimumRanked: number, selectedCount: number) {
  const minimum = Math.max(0, Math.min(optionCount, Math.floor(minimumRanked)));
  const missing = Math.max(0, minimum - selectedCount);
  return {
    minimum,
    missing,
    label: minimum > 0
      ? missing > 0
        ? `Choose ${missing} more`
        : `${selectedCount}/${minimum} selected`
      : "Optional",
  };
}

export default function QuestionnaireOptionAVoterPanel(props: QuestionnaireOptionAVoterPanelProps) {
  const displayMode = props.displayMode ?? "vote";
  const settingsMode = displayMode === "settings";
  const [runtime, setRuntime] = useState<QuestionnaireOptionAVoterRuntime | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [signedInNpub, setSignedInNpub] = useState<string>("");
  const [pendingInvites, setPendingInvites] = useState<ElectionInviteMessage[]>([]);
  const [activeInvite, setActiveInvite] = useState<ElectionInviteMessage | null>(null);
  const [selectedInviteKey, setSelectedInviteKey] = useState<string>("");
  const [questionnaireTitle, setQuestionnaireTitle] = useState<string>("Questionnaire");
  const [questionnaireDescription, setQuestionnaireDescription] = useState<string>("");
  const [questionnaireDefinition, setQuestionnaireDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [questions, setQuestions] = useState<Array<{
    questionId: string;
    required: boolean;
    prompt: string;
    type: "yes_no" | "multiple_choice" | "rank" | "free_text";
    options?: Array<{ optionId: string; label: string }>;
    multiSelect?: boolean;
    minimumRanked?: number;
    maxLength?: number;
  }>>([]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [encryptFreeTextByQuestionId, setEncryptFreeTextByQuestionId] = useState<Record<string, boolean>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [privateInviteBootstrapRetryNonce, setPrivateInviteBootstrapRetryNonce] = useState(0);
  const autoRequestSentForRef = useRef<Record<string, true>>({});
  const autoRequestInFlightForRef = useRef<Record<string, true>>({});
  const autoRequestLastAttemptAtRef = useRef<Record<string, number>>({});
  const autoRequestDelayedForRef = useRef<Record<string, true>>({});
  const requestRetryAtRef = useRef<Record<string, number>>({});
  const autoSignerLoginForRef = useRef<Record<string, true>>({});
  const bearerInviteBootstrapForRef = useRef<Record<string, true>>({});
  const lifecycleRefreshAtRef = useRef(0);
  const inviteRefreshAtRef = useRef(0);
  const signerWaitRestartAtRef = useRef(0);
  const signerWaitFetchAtRef = useRef(0);
  const ballotWaitLifecycleTriggerAtRef = useRef(0);
  const signerInitialPullTimeoutIdsRef = useRef<number[]>([]);
  const ballotWaitQueueRef = useRef<{
    inFlight: boolean;
    pending: boolean;
    pendingRestartSubscriptions: boolean;
    pendingForceWhenHidden: boolean;
    mode: BallotWaitRefreshMode;
  }>({
    inFlight: false,
    pending: false,
    pendingRestartSubscriptions: false,
    pendingForceWhenHidden: false,
    mode: "lifecycle",
  });

  const inviteContext = useMemo(() => parseInviteFromUrl(), []);
  const [electionId, setElectionId] = useState(inviteContext.electionId ?? deriveElectionId());
  const previousElectionIdRef = useRef(electionId);
  const latestAnnouncedQuestionnaireId = useMemo(() => {
    const ids = (props.announcedQuestionnaireIds ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    return ids.at(-1) ?? "";
  }, [props.announcedQuestionnaireIds]);

  const snapshot = runtime?.getSnapshot() ?? null;
  const flags = runtime?.getFlags() ?? {
    canLogin: true,
    canRequestBallot: false,
    canSubmitVote: false,
    alreadySubmitted: false,
    resumeAvailable: false,
  };
  const linkedContextElectionId = inviteContext.electionId?.trim() ?? "";
  const currentQuestionnaireId = linkedContextElectionId || snapshot?.electionId?.trim() || electionId.trim() || latestAnnouncedQuestionnaireId.trim();
  const contextPendingInvites = useMemo(() => (
    linkedContextElectionId
      ? pendingInvites.filter((invite) => invite.electionId === linkedContextElectionId)
      : pendingInvites
  ), [linkedContextElectionId, pendingInvites]);
  const autoRequestDefinition = currentQuestionnaireId
    ? (
        activeInvite?.electionId === currentQuestionnaireId ? activeInvite.definition : null
      )
      ?? (snapshot?.blindIssuance?.definition?.questionnaireId === currentQuestionnaireId ? snapshot.blindIssuance.definition : null)
      ?? (snapshot?.inviteMessage?.electionId === currentQuestionnaireId ? snapshot.inviteMessage.definition : null)
      ?? contextPendingInvites.find((invite) => invite.electionId === currentQuestionnaireId)?.definition
      ?? (inviteContext.invite?.electionId === currentQuestionnaireId ? inviteContext.invite.definition : null)
      ?? (questionnaireDefinition?.questionnaireId === currentQuestionnaireId ? questionnaireDefinition : null)
      ?? readCachedQuestionnaireDefinition(currentQuestionnaireId)
    : null;
  const autoRequestBlindSigningKeyReady = Boolean(
    (activeInvite?.electionId === currentQuestionnaireId ? activeInvite.blindSigningPublicKey : null)
    ?? (snapshot?.inviteMessage?.electionId === currentQuestionnaireId ? snapshot.inviteMessage.blindSigningPublicKey : null)
    ?? contextPendingInvites.find((invite) => invite.electionId === currentQuestionnaireId)?.blindSigningPublicKey
    ?? (inviteContext.invite?.electionId === currentQuestionnaireId ? inviteContext.invite.blindSigningPublicKey : null)
    ?? autoRequestDefinition?.blindSigningPublicKey
    ?? (currentQuestionnaireId ? loadElectionSummary(currentQuestionnaireId)?.blindSigningPublicKey : null),
  );

  function markSignerWaitRecoveryBaseline() {
    if (props.localVoterNsec?.trim()) {
      return;
    }
    const now = Date.now();
    signerWaitRestartAtRef.current = now;
    // Allow a near-immediate first pull while still rate-limiting subsequent background recovery.
    signerWaitFetchAtRef.current = now - AUTO_BALLOT_SIGNER_LIFECYCLE_FETCH_MIN_INTERVAL_MS;
  }

  function recoverSignerBackedBallotWait(mode: BallotWaitRefreshMode) {
    if (!runtime) {
      return;
    }
    const now = Date.now();
    if (now - signerWaitRestartAtRef.current >= AUTO_BALLOT_SIGNER_SUBSCRIPTION_REARM_MIN_INTERVAL_MS) {
      runtime.restartVoterDmSubscriptions();
      signerWaitRestartAtRef.current = now;
    }
    let shouldFetch = false;
    if (mode === "manual") {
      shouldFetch = true;
    } else if (mode === "lifecycle") {
      shouldFetch = now - signerWaitFetchAtRef.current >= AUTO_BALLOT_SIGNER_LIFECYCLE_FETCH_MIN_INTERVAL_MS;
    } else if (mode === "background") {
      shouldFetch = now - signerWaitFetchAtRef.current >= AUTO_BALLOT_SIGNER_BACKGROUND_FETCH_MIN_INTERVAL_MS;
    }
    if (!shouldFetch) {
      return;
    }
    runtime.refreshIssuanceAndAcceptance();
    signerWaitFetchAtRef.current = now;
  }

  function mergeBallotWaitRefreshMode(
    current: BallotWaitRefreshMode,
    next: BallotWaitRefreshMode,
  ): BallotWaitRefreshMode {
    const rank: Record<BallotWaitRefreshMode, number> = {
      restart_only: 0,
      background: 1,
      lifecycle: 2,
      manual: 3,
    };
    return rank[next] > rank[current] ? next : current;
  }

  function queueBallotWaitRefresh(input?: {
    restartSubscriptions?: boolean;
    forceWhenHidden?: boolean;
    mode?: BallotWaitRefreshMode;
  }) {
    if (!runtime) {
      return;
    }
    const pendingMode = input?.mode ?? "lifecycle";
    const queue = ballotWaitQueueRef.current;
    queue.pending = true;
    queue.pendingRestartSubscriptions = queue.pendingRestartSubscriptions || Boolean(input?.restartSubscriptions);
    queue.pendingForceWhenHidden = queue.pendingForceWhenHidden || Boolean(input?.forceWhenHidden);
    queue.mode = mergeBallotWaitRefreshMode(queue.mode, pendingMode);
    if (queue.inFlight) {
      return;
    }
    queue.inFlight = true;
    void (async () => {
      try {
        while (queue.pending) {
          const restartSubscriptions = queue.pendingRestartSubscriptions;
          const forceWhenHidden = queue.pendingForceWhenHidden;
          const mode = queue.mode;
          queue.pending = false;
          queue.pendingRestartSubscriptions = false;
          queue.pendingForceWhenHidden = false;
          queue.mode = "lifecycle";

          if (!forceWhenHidden && typeof document !== "undefined" && document.visibilityState === "hidden") {
            continue;
          }

          if (props.localVoterNsec?.trim()) {
            // Automatic long-polling must not churn Firefox's relay subscriptions.
            // Explicit refresh/resend actions pass forceWhenHidden and can still re-arm them.
            const shouldRestartLocalSubscriptions = restartSubscriptions && forceWhenHidden;
            runtime.refreshIssuanceAndAcceptance(shouldRestartLocalSubscriptions ? { restartSubscriptions: true } : undefined);
          } else {
            if (restartSubscriptions && mode === "restart_only") {
              recoverSignerBackedBallotWait("restart_only");
            } else if (restartSubscriptions && mode === "background") {
              recoverSignerBackedBallotWait("background");
            } else if (restartSubscriptions && mode === "manual") {
              recoverSignerBackedBallotWait("manual");
            } else {
              recoverSignerBackedBallotWait(mode);
            }
          }
          setRefreshNonce((value) => value + 1);
        }
      } finally {
        queue.inFlight = false;
      }
    })();
  }

  function scheduleSignerInitialPull() {
    if (props.localVoterNsec?.trim()) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      queueBallotWaitRefresh({ mode: "manual", forceWhenHidden: true });
    }, AUTO_BALLOT_SIGNER_INITIAL_PULL_DELAY_MS);
    signerInitialPullTimeoutIdsRef.current.push(timeoutId);
  }

  function isPageVisible() {
    return typeof document === "undefined" || document.visibilityState === "visible";
  }

  useEffect(() => {
    if (previousElectionIdRef.current === electionId) {
      return;
    }
    previousElectionIdRef.current = electionId;
    setAnswers({});
    setEncryptFreeTextByQuestionId({});
  }, [electionId]);

  useEffect(() => {
    if (!electionId) {
      setRuntime(null);
      return;
    }
    const signer = createVoterSignerService(props.localVoterNsec);
    setRuntime(new QuestionnaireOptionAVoterRuntime(signer, electionId, props.localVoterNsec));
  }, [electionId, props.localVoterNsec]);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    runtime.setBearerInviteCode(inviteContext.inviteCode);
  }, [runtime, inviteContext.inviteCode]);

  useEffect(() => {
    return () => {
      runtime?.dispose();
    };
  }, [runtime]);

  useEffect(() => {
    return () => {
      for (const timeoutId of signerInitialPullTimeoutIdsRef.current) {
        window.clearTimeout(timeoutId);
      }
      signerInitialPullTimeoutIdsRef.current = [];
    };
  }, []);

  useEffect(() => {
    if (!runtime) {
      return;
    }
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (props.autoSignerLogin && !hasLocalSecretKey) {
      return;
    }
    if (!localVoterNpub) {
      return;
    }
    const signedIn = signedInNpub.trim();
    if (signedIn && signedIn !== localVoterNpub) {
      return;
    }
    const currentSnapshot = runtime.getSnapshot();
    if (currentSnapshot?.invitedNpub === localVoterNpub) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true });
    } catch {
      // Keep explicit login available.
    }
  }, [runtime, signedInNpub, props.autoSignerLogin, props.localVoterNpub, props.localVoterNsec, electionId, latestAnnouncedQuestionnaireId]);

  useEffect(() => {
    if (!runtime || !inviteContext.inviteCode) {
      return;
    }
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    if (!localVoterNpub) {
      return;
    }
    const targetElectionId = electionId.trim() || inviteContext.electionId?.trim();
    if (!targetElectionId) {
      return;
    }
    const key = `${targetElectionId}:${localVoterNpub}:${inviteContext.inviteCode}`;
    if (bearerInviteBootstrapForRef.current[key]) {
      return;
    }
    bearerInviteBootstrapForRef.current[key] = true;
    let cancelled = false;
    let retryTimeoutId: number | null = null;
    const schedulePrivateInviteRetry = (message: string) => {
      delete bearerInviteBootstrapForRef.current[key];
      if (cancelled) {
        return;
      }
      setStatus(message);
      retryTimeoutId = window.setTimeout(() => {
        setPrivateInviteBootstrapRetryNonce((value) => value + 1);
      }, 3000);
    };
    void (async () => {
      try {
        const publicInvite = await buildPublicQuestionnaireInvite(localVoterNpub);
        const coordinatorNpub = publicInvite?.coordinatorNpub?.trim()
          || inviteContext.coordinatorNpub?.trim()
          || "";
        if (cancelled || !coordinatorNpub) {
          if (!cancelled) {
            schedulePrivateInviteRetry("Looking up questionnaire metadata before requesting a ballot...");
          }
          return;
        }
        if (publicInvite) {
          publishInviteToMailbox(publicInvite);
        }
        let next: VoterElectionLocalState;
        try {
          next = runtime.bootstrapWithLocalIdentity({
            invitedNpub: localVoterNpub,
            coordinatorNpub,
            invite: publicInvite,
            allowInviteRecipientMismatch: true,
            allowInviteMissing: true,
          });
        } catch (error) {
          if (!(error instanceof OptionARuntimeError && error.code === "invite_mismatch")) {
            throw error;
          }
          next = runtime.bootstrapWithLocalIdentity({
            invitedNpub: localVoterNpub,
            coordinatorNpub,
            invite: null,
            allowInviteMissing: true,
          });
        }
        if (cancelled) {
          return;
        }
        const requestKey = `${next.electionId}:${next.invitedNpub}`;
        setSignedInNpub(next.invitedNpub);
        setActiveInvite(!next.blindRequestSent && !next.credentialReady ? publicInvite : null);
        setPendingInvites(publicInvite ? [publicInvite] : []);
        const title = publicInvite?.title || targetElectionId;
        if (next.blindRequestSent || next.credentialReady || next.submission) {
          setStatus("Opened " + title + " from private invite code.");
          setRefreshNonce((value) => value + 1);
          return;
        }
        setStatus("Opened " + title + " from private invite code. Requesting ballot...");
        setRefreshNonce((value) => value + 1);
        if (autoRequestInFlightForRef.current[requestKey]) {
          schedulePrivateInviteRetry("Opened " + title + " from private invite code. Waiting to request ballot...");
          return;
        }
        autoRequestInFlightForRef.current[requestKey] = true;
        autoRequestLastAttemptAtRef.current[requestKey] = Date.now();
        try {
          await runtime.requestBlindBallot({ forceResend: true });
          if (cancelled) {
            return;
          }
          autoRequestSentForRef.current[requestKey] = true;
          markSignerWaitRecoveryBaseline();
          scheduleSignerInitialPull();
          setActiveInvite(null);
          setStatus(`Blind ballot request sent. Waiting for ${getCredentialIssuerDisplayName()} issuance.`);
          setRefreshNonce((value) => value + 1);
        } finally {
          delete autoRequestInFlightForRef.current[requestKey];
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "Could not open private invite code.";
          schedulePrivateInviteRetry(message);
        }
      }
    })();
    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [
    runtime,
    inviteContext.inviteCode,
    inviteContext.electionId,
    inviteContext.coordinatorNpub,
    privateInviteBootstrapRetryNonce,
    props.localVoterNpub,
    props.autoSignerLogin,
    electionId,
    latestAnnouncedQuestionnaireId,
  ]);

  useEffect(() => {
    if (!runtime || snapshot?.loginVerified) {
      return;
    }
    const signerNpub = props.localVoterNpub?.trim() ?? "";
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    const targetElectionId = electionId.trim();
    if (!props.autoSignerLogin || !signerNpub || hasLocalSecretKey || !targetElectionId) {
      return;
    }
    const key = `${targetElectionId}:${signerNpub}`;
    if (autoSignerLoginForRef.current[key]) {
      return;
    }
    autoSignerLoginForRef.current[key] = true;
    void login();
  }, [runtime, snapshot?.loginVerified, props.autoSignerLogin, props.localVoterNpub, props.localVoterNsec, electionId]);

  useEffect(() => {
    if (!runtime || !signedInNpub.trim()) {
      return;
    }
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (!hasLocalSecretKey) {
      return;
    }
    const needsStatusRefresh = Boolean(
      (snapshot?.blindRequestSent && !snapshot.credentialReady)
      || (snapshot?.submission && snapshot.submissionAccepted == null),
    );
    if (!needsStatusRefresh) {
      return;
    }
    let cancelled = false;
    let timeoutId: number | null = null;
    const poll = () => {
      timeoutId = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        try {
          queueBallotWaitRefresh({ mode: "lifecycle" });
        } catch {
          // Keep polling best-effort; explicit actions surface errors.
        } finally {
          if (!cancelled) {
            poll();
          }
        }
      }, 60000);
    };
    poll();
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [runtime, signedInNpub, props.localVoterNsec, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission, snapshot?.submissionAccepted]);

  useEffect(() => {
    if (!runtime || !snapshot?.loginVerified) {
      return;
    }
    const needsStatusRefresh = Boolean(
      (snapshot.blindRequestSent && !snapshot.credentialReady)
      || (snapshot.submission && snapshot.submissionAccepted == null),
    );
    if (!needsStatusRefresh) {
      return;
    }
    const triggerRefresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      const now = Date.now();
      if (now - lifecycleRefreshAtRef.current < 1_500) {
        return;
      }
      lifecycleRefreshAtRef.current = now;
      try {
        ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true });
      } catch {
        // Best-effort; refresh below still uses the active runtime snapshot.
      }
      try {
        queueBallotWaitRefresh({ mode: "lifecycle" });
      } catch {
        // Keep lifecycle refresh best-effort; explicit actions surface errors.
      }
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
  }, [runtime, props.localVoterNsec, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission, snapshot?.submissionAccepted]);

  useEffect(() => {
    if (!runtime || !snapshot?.loginVerified || !snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    if (props.localVoterNsec?.trim()) {
      return;
    }
    let cancelled = false;
    let timeoutId: number | null = null;
    const tick = () => {
      timeoutId = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (isPageVisible()) {
          try {
            ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true });
          } catch {
            // The active runtime snapshot is still enough for a best-effort pull.
          }
          try {
            queueBallotWaitRefresh({
              restartSubscriptions: true,
              mode: "manual",
            });
          } catch {
            // Keep the automatic refresh best-effort; the button still surfaces errors.
          }
        }
        if (!cancelled) {
          tick();
        }
      }, AUTO_BALLOT_WAIT_FOREGROUND_REFRESH_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [runtime, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

  useEffect(() => {
    setQuestionnaireTitle("Questionnaire");
    setQuestionnaireDescription("");
    setQuestionnaireDefinition(null);
    setQuestions([]);
    if (!electionId) {
      return;
    }
    const localDefinition =
      (activeInvite?.electionId === electionId ? activeInvite.definition : null)
      ?? (snapshot?.blindIssuance?.definition?.questionnaireId === electionId ? snapshot.blindIssuance.definition : null)
      ?? (snapshot?.inviteMessage?.electionId === electionId ? snapshot.inviteMessage.definition : null)
      ?? contextPendingInvites.find((invite) => invite.electionId === electionId)?.definition
      ?? (inviteContext.invite?.electionId === electionId ? inviteContext.invite.definition : null)
      ?? readCachedQuestionnaireDefinition(electionId);
    if (localDefinition) {
      cacheDefinitionForVoting(localDefinition);
      setQuestionnaireTitle(localDefinition.title || "Questionnaire");
      setQuestionnaireDescription(localDefinition.description || "");
      setQuestionnaireDefinition(localDefinition);
      setQuestions(mapDefinitionQuestions(localDefinition));
    }
    let cancelled = false;
    const definitionRelays = mergeQuestionnaireRelayHints(
      localDefinition?.questionnaireRelays,
      loadElectionSummary(electionId)?.questionnaireRelays,
    );
    void fetchQuestionnaireDefinitions({
      questionnaireId: electionId,
      limit: 20,
      relays: definitionRelays.length > 0 ? definitionRelays : undefined,
    })
      .then((entries) => {
        if (cancelled) {
          return;
        }
        const latest = latestDefinitionFromEntries(entries);
        if (!latest) {
          return;
        }
        cacheDefinitionForVoting(latest);
        setQuestionnaireTitle(latest.title || "Questionnaire");
        setQuestionnaireDescription(latest.description || "");
        setQuestionnaireDefinition(latest);
        setQuestions(mapDefinitionQuestions(latest));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeInvite, contextPendingInvites, electionId, inviteContext.invite, snapshot?.blindIssuance, snapshot?.inviteMessage]);

  useEffect(() => {
    const currentId = electionId.trim();
    if (!linkedContextElectionId && latestAnnouncedQuestionnaireId && (!currentId || (!hasInFlightState() && currentId !== latestAnnouncedQuestionnaireId))) {
      setElectionId(latestAnnouncedQuestionnaireId);
      return;
    }
    if (currentId) {
      return;
    }
    const localNpub = props.localVoterNpub?.trim() ?? "";
    if (!localNpub) {
      return;
    }
    const localInvite = findBestLocalInvite(localNpub, currentId);
    if (localInvite?.electionId?.trim()) {
      setElectionId(localInvite.electionId.trim());
    }
  }, [electionId, latestAnnouncedQuestionnaireId, linkedContextElectionId, props.localVoterNpub, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  useEffect(() => {
    if (contextPendingInvites.length === 0 || hasInFlightState()) {
      return;
    }
    const preferredInvite = (latestAnnouncedQuestionnaireId
      ? contextPendingInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId)
      : null)
      ?? (linkedContextElectionId ? null : contextPendingInvites.at(-1))
      ?? null;
    const nextElectionId = preferredInvite?.electionId?.trim() ?? "";
    if (nextElectionId && electionId.trim() !== nextElectionId) {
      setElectionId(nextElectionId);
    }
  }, [contextPendingInvites, electionId, latestAnnouncedQuestionnaireId, linkedContextElectionId, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  useEffect(() => {
    const voterNpub = signedInNpub.trim();
    if (!voterNpub || hasInFlightState() || inviteContext.invite) {
      return;
    }
    if (pendingInvites.length > 0 || activeInvite) {
      return;
    }

    const triggerRefresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      const now = Date.now();
      if (now - inviteRefreshAtRef.current < 10_000) {
        return;
      }
      inviteRefreshAtRef.current = now;
      void loadPendingInvites({ voterNpub, allowRelayFetch: true }).then((invites) => {
        setPendingInvites(invites);
        const usableInvites = linkedContextElectionId
          ? invites.filter((invite) => invite.electionId === linkedContextElectionId)
          : invites;
        const preferredInvite = (latestAnnouncedQuestionnaireId
          ? usableInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId)
          : null)
          ?? (linkedContextElectionId ? null : usableInvites.at(-1))
          ?? null;
        if (preferredInvite && !hasInFlightState()) {
          setActiveInvite(preferredInvite);
          if (electionId.trim() !== preferredInvite.electionId) {
            setElectionId(preferredInvite.electionId);
          }
        }
      }).catch(() => undefined);
    };

    triggerRefresh();
    const intervalId = window.setInterval(triggerRefresh, AUTO_INVITE_REFRESH_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        triggerRefresh();
      }
    };
    window.addEventListener("focus", triggerRefresh);
    window.addEventListener("online", triggerRefresh);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", triggerRefresh);
      window.removeEventListener("online", triggerRefresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeInvite, electionId, inviteContext.invite, latestAnnouncedQuestionnaireId, linkedContextElectionId, pendingInvites.length, signedInNpub, snapshot?.blindRequest?.requestId, snapshot?.blindIssuance?.issuanceId, snapshot?.submission?.submissionId]);

  const requiredQuestions = useMemo(
    () => questions.filter((question) => question.required || (question.type === "rank" && (question.minimumRanked ?? 0) > 0)),
    [questions],
  );
  const requiredQuestionIds = useMemo(
    () => requiredQuestions.map((question) => question.questionId),
    [requiredQuestions],
  );

  function hasInFlightState(state = snapshot) {
    return Boolean(state?.blindRequest || state?.blindIssuance || state?.submission);
  }

  function findBestLocalInvite(voterNpub: string, preferredElectionId = linkedContextElectionId || electionId) {
    const localInvites = [...listInvitesFromMailbox(voterNpub)];
    const preferredId = preferredElectionId.trim();
    if (preferredId) {
      return localInvites.find((invite) => invite.electionId === preferredId) ?? null;
    }
    if (latestAnnouncedQuestionnaireId) {
      return localInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) ?? null;
    }
    return localInvites.at(-1) ?? null;
  }

  function ensureLocalSession(options?: { allowInviteMissing?: boolean; allowRelayInviteFetch?: boolean }) {
    if (!runtime) {
      return null;
    }
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (!localVoterNpub || (props.autoSignerLogin && !hasLocalSecretKey)) {
      return runtime.getSnapshot();
    }
    const currentSnapshot = runtime.getSnapshot();
    const fallbackInvite = findBestLocalInvite(localVoterNpub);
    const targetQuestionnaireId = linkedContextElectionId
      || fallbackInvite?.electionId?.trim()
      || electionId.trim()
      || latestAnnouncedQuestionnaireId.trim();
    const publicDefinition = targetQuestionnaireId
      ? (questionnaireDefinition?.questionnaireId === targetQuestionnaireId ? questionnaireDefinition : null)
        ?? readCachedQuestionnaireDefinition(targetQuestionnaireId)
      : null;
    const publicSummary = targetQuestionnaireId ? loadElectionSummary(targetQuestionnaireId) : null;
    const publicCoordinatorNpub = publicDefinition?.coordinatorPubkey?.trim()
      || publicSummary?.coordinatorNpub?.trim()
      || "";
    if (currentSnapshot?.invitedNpub === localVoterNpub) {
      const knownCoordinator = currentSnapshot.coordinatorNpub?.trim() ?? "";
      if (knownCoordinator) {
        return currentSnapshot;
      }
      if (!fallbackInvite?.coordinatorNpub?.trim() && !inviteContext.coordinatorNpub?.trim() && !publicCoordinatorNpub) {
        return currentSnapshot;
      }
    }
    const fallbackCoordinatorNpub = fallbackInvite?.coordinatorNpub?.trim()
      || inviteContext.coordinatorNpub?.trim()
      || publicCoordinatorNpub
      || undefined;
    const bootstrapNpub = fallbackInvite?.invitedNpub?.trim() || localVoterNpub;
    const next = runtime.bootstrapWithLocalIdentity({
      invitedNpub: bootstrapNpub,
      coordinatorNpub: fallbackCoordinatorNpub,
      invite: fallbackInvite,
      allowInviteRecipientMismatch: Boolean(fallbackInvite && bootstrapNpub !== (fallbackInvite.invitedNpub ?? "").trim()),
      allowInviteMissing: options?.allowInviteMissing ?? Boolean(latestAnnouncedQuestionnaireId || electionId.trim() || linkedContextElectionId),
    });
    setSignedInNpub(next.invitedNpub);
    void loadPendingInvites({
      voterNpub: next.invitedNpub,
      allowRelayFetch: Boolean(options?.allowRelayInviteFetch),
    }).then((invites) => {
      setPendingInvites(invites);
      const usableInvites = linkedContextElectionId
        ? invites.filter((invite) => invite.electionId === linkedContextElectionId)
        : invites;
      const preferredInvite = usableInvites.find((invite) => invite.electionId === next.electionId)
        ?? (latestAnnouncedQuestionnaireId ? usableInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) : null)
        ?? (linkedContextElectionId ? null : usableInvites.at(-1))
        ?? null;
      setActiveInvite(next.inviteMessage && !next.blindRequestSent && !next.credentialReady
        ? next.inviteMessage
        : preferredInvite);
    });
    setRefreshNonce((value) => value + 1);
    return next;
  }

  async function loadPendingInvites(input: { voterNpub: string; allowRelayFetch: boolean }) {
    const voterNpub = input.voterNpub.trim();
    if (!voterNpub) {
      return [];
    }

    const fromMailbox = [...listInvitesFromMailbox(voterNpub)];

    const mergeByKey = (invites: ElectionInviteMessage[]) => {
      const byKey = new Map<string, ElectionInviteMessage>();
      for (const invite of invites) {
        byKey.set(invite.electionId + ":" + invite.coordinatorNpub, invite);
      }
      return [...byKey.values()];
    };

    if (!input.allowRelayFetch) {
      return mergeByKey(fromMailbox);
    }

    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (hasLocalSecretKey && localVoterNpub && voterNpub === localVoterNpub) {
      try {
        const dmInvites = await fetchOptionAInviteDmsWithNsec({
          nsec: props.localVoterNsec ?? "",
          limit: 40,
        });
        for (const invite of dmInvites) {
          publishInviteToMailbox(invite);
        }
        return mergeByKey([...dmInvites, ...fromMailbox]);
      } catch {
        return mergeByKey(fromMailbox);
      }
    }

    try {
      const signer = createVoterSignerService(props.localVoterNsec);
      const dmInvites = await fetchOptionAInviteDms({ signer, limit: 40 });
      for (const invite of dmInvites) {
        publishInviteToMailbox(invite);
      }
      return mergeByKey([...dmInvites, ...fromMailbox]);
    } catch {
      return mergeByKey(fromMailbox);
    }
  }

  async function buildPublicQuestionnaireInvite(voterNpub: string) {
    const targetElectionId = linkedContextElectionId || electionId.trim() || latestAnnouncedQuestionnaireId.trim();
    if (!targetElectionId) {
      return null;
    }

    const existingSummary = loadElectionSummary(targetElectionId);
    let definition = readCachedQuestionnaireDefinition(targetElectionId);
    const knownQuestionnaireRelays = mergeQuestionnaireRelayHints(
      definition?.questionnaireRelays,
      existingSummary?.questionnaireRelays,
    );
    try {
      const latest = latestDefinitionFromEntries(await fetchQuestionnaireDefinitions({
        questionnaireId: targetElectionId,
        limit: 20,
        relays: knownQuestionnaireRelays.length > 0 ? knownQuestionnaireRelays : undefined,
      }));
      if (latest) {
        definition = latest;
      }
    } catch {
      // The cached public definition is enough when a fresh relay read fails.
    }

    let issueBlindTokensWorker = existingSummary?.issueBlindTokensWorker ?? null;
    try {
      const delegation = await fetchQuestionnaireActiveWorkerDelegationForCapability({
        questionnaireId: targetElectionId,
        capability: "issue_blind_tokens",
        relays: mergeQuestionnaireRelayHints(definition?.questionnaireRelays, knownQuestionnaireRelays),
      });
      issueBlindTokensWorker = delegation?.workerNpub?.trim()
        ? buildIssueBlindTokensWorkerRouting({
          delegationId: delegation.delegationId,
          workerNpub: delegation.workerNpub,
          controlRelays: delegation.controlRelays,
          expiresAt: delegation.expiresAt,
        })
        : null;
    } catch {
      // Keep cached worker routing when a fresh public delegation lookup fails.
    }
    if (!definition) {
      const coordinatorNpub = inviteContext.coordinatorNpub?.trim()
        || existingSummary?.coordinatorNpub?.trim()
        || "";
      if (!coordinatorNpub || !voterNpub.trim()) {
        return null;
      }
      return {
        type: "election_invite",
        schemaVersion: 1,
        electionId: targetElectionId,
        title: existingSummary?.title || "Questionnaire",
        description: existingSummary?.description ?? "",
        voteUrl: typeof window === "undefined" ? "" : window.location.href,
        invitedNpub: voterNpub.trim(),
        coordinatorNpub,
        blindSigningPublicKey: existingSummary?.blindSigningPublicKey ?? null,
        issueBlindTokensWorker,
        definition: null,
        expiresAt: null,
      };
    }
    cacheDefinitionForVoting(definition, issueBlindTokensWorker);
    return buildInviteFromPublicDefinition(definition, voterNpub, issueBlindTokensWorker);
  }

  async function loginWithLocalIdentity(voterNpub: string) {
    if (!runtime) {
      return false;
    }
    const fallbackInvite = findBestLocalInvite(voterNpub);
    const bootstrapNpub = fallbackInvite?.invitedNpub?.trim() || voterNpub;
    const bootstrapped = runtime.bootstrapWithLocalIdentity({
      invitedNpub: bootstrapNpub,
      coordinatorNpub: fallbackInvite?.coordinatorNpub ?? undefined,
      invite: fallbackInvite,
      allowInviteRecipientMismatch: Boolean(fallbackInvite && bootstrapNpub !== (fallbackInvite.invitedNpub ?? "").trim()),
      allowInviteMissing: true,
    });
    const next = await runtime.recoverSubmittedBallotFromSelfDm().catch(() => bootstrapped);
    setSignedInNpub(next.invitedNpub);
    const invites = await loadPendingInvites({ voterNpub: next.invitedNpub, allowRelayFetch: true });
    setPendingInvites(invites);
    const usableInvites = linkedContextElectionId
      ? invites.filter((invite) => invite.electionId === linkedContextElectionId)
      : invites;
    const preferredInvite = usableInvites.find((invite) => invite.electionId === electionId) ?? usableInvites[0] ?? null;
    if (!inviteContext.electionId?.trim() && preferredInvite && electionId.trim() !== preferredInvite.electionId) {
      setElectionId(preferredInvite.electionId);
    }
    setActiveInvite(next.inviteMessage && !next.blindRequestSent && !next.credentialReady
      ? next.inviteMessage
      : preferredInvite);
    setStatus("Using local voter identity " + deriveActorDisplayId(next.invitedNpub) + ".");
    setRefreshNonce((value) => value + 1);
    return true;
  }

  async function login() {
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    const signedInTrimmed = signedInNpub.trim();

    if (hasLocalSecretKey && localVoterNpub && (!signedInTrimmed || signedInTrimmed === localVoterNpub)) {
      try {
        const usedLocal = await loginWithLocalIdentity(localVoterNpub);
        if (usedLocal) {
          return;
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Local identity login failed.");
        return;
      }
    }

    try {
      const signer = createVoterSignerService(props.localVoterNsec);
      const rawPubkey = await signer.getPublicKey();
      const signerNpub = rawPubkey.startsWith("npub1") ? rawPubkey : nip19.npubEncode(rawPubkey);
      const publicQuestionnaireInvite = await buildPublicQuestionnaireInvite(signerNpub);

      if (!runtime) {
        const invites = publicQuestionnaireInvite
          ? []
          : await loadPendingInvites({ voterNpub: signerNpub, allowRelayFetch: true });
        setPendingInvites(invites);
        const usableInvites = linkedContextElectionId
          ? invites.filter((invite) => invite.electionId === linkedContextElectionId)
          : invites;
        const preferredInvite = publicQuestionnaireInvite ?? usableInvites[0] ?? null;
        if (!preferredInvite) {
          setSignedInNpub(signerNpub);
          setStatus(
            inviteContext.electionId?.trim()
              ? "Signed in. No invite DM was readable for this questionnaire. Check signer DM permissions (NIP-44 decrypt)."
              : "Signed in. No pending questionnaire invites were found.",
          );
          return;
        }

        const voterRuntime = new QuestionnaireOptionAVoterRuntime(createVoterSignerService(props.localVoterNsec), preferredInvite.electionId, props.localVoterNsec);
        let next: VoterElectionLocalState;
        try {
          next = await voterRuntime.loginWithSigner(preferredInvite);
        } catch (error) {
          if (!(inviteContext.inviteCode && publicQuestionnaireInvite && error instanceof OptionARuntimeError && error.code === "invite_mismatch")) {
            throw error;
          }
          next = voterRuntime.bootstrapWithLocalIdentity({
            invitedNpub: signerNpub,
            coordinatorNpub: publicQuestionnaireInvite.coordinatorNpub,
            invite: null,
            allowInviteMissing: true,
          });
        }
        setElectionId(preferredInvite.electionId);
        setRuntime(voterRuntime);
        setSignedInNpub(next.invitedNpub);
        setActiveInvite(next.inviteMessage && !next.blindRequestSent && !next.credentialReady
          ? next.inviteMessage
          : preferredInvite);
        setStatus(
          publicQuestionnaireInvite && invites.length === 0
            ? "Signed in as " + deriveActorDisplayId(next.invitedNpub) + ". Opened questionnaire from link."
            : "Signed in as " + deriveActorDisplayId(next.invitedNpub) + ". " + invites.length + " pending invite" + (invites.length === 1 ? "" : "s") + " found.",
        );
        setRefreshNonce((value) => value + 1);
        return;
      }

      let next: VoterElectionLocalState;
      try {
        next = await runtime.loginWithSigner(inviteContext.invite ?? publicQuestionnaireInvite);
      } catch (error) {
        if (!(inviteContext.inviteCode && publicQuestionnaireInvite && error instanceof OptionARuntimeError && error.code === "invite_mismatch")) {
          throw error;
        }
        next = runtime.bootstrapWithLocalIdentity({
          invitedNpub: signerNpub,
          coordinatorNpub: publicQuestionnaireInvite.coordinatorNpub,
          invite: null,
          allowInviteMissing: true,
        });
      }
      setSignedInNpub(next.invitedNpub);
      const invites = publicQuestionnaireInvite
        ? []
        : await loadPendingInvites({ voterNpub: next.invitedNpub, allowRelayFetch: true });
      setPendingInvites(invites);
      const usableInvites = linkedContextElectionId
        ? invites.filter((invite) => invite.electionId === linkedContextElectionId)
        : invites;
      const preferredInvite = publicQuestionnaireInvite ?? usableInvites[0] ?? null;
      if (!inviteContext.electionId?.trim() && preferredInvite && electionId.trim() !== preferredInvite.electionId) {
        setElectionId(preferredInvite.electionId);
      }
      const pendingInvite = next.inviteMessage && !next.blindRequestSent && !next.credentialReady
        ? next.inviteMessage
        : preferredInvite;
      setActiveInvite(pendingInvite);
      setStatus(
        publicQuestionnaireInvite && invites.length === 0
          ? "Signed in as " + deriveActorDisplayId(next.invitedNpub) + ". Opened questionnaire from link."
          : pendingInvite
          ? "Signed in as " + deriveActorDisplayId(next.invitedNpub) + "."
          : inviteContext.electionId?.trim()
            ? "Signed in. No invite DM was readable for this questionnaire. Check signer DM permissions (NIP-44 decrypt)."
            : "Signed in as " + deriveActorDisplayId(next.invitedNpub) + ".",
      );
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      if (error instanceof OptionARuntimeError || error instanceof SignerServiceError) {
        setStatus(error.message);
        return;
      }
      setStatus(error instanceof Error ? error.message : "Login failed.");
    }
  }

  async function openInvite(invite: ElectionInviteMessage, requestAfterLogin = false) {
    try {
      const voterRuntime = new QuestionnaireOptionAVoterRuntime(createVoterSignerService(props.localVoterNsec), invite.electionId, props.localVoterNsec);
      const localVoterNpub = props.localVoterNpub?.trim() ?? "";
      const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
      const signedInTrimmed = signedInNpub.trim();
      const preferLocalIdentity = Boolean(!props.autoSignerLogin && localVoterNpub && (!signedInTrimmed || signedInTrimmed === localVoterNpub));

      let next: VoterElectionLocalState;
      let needsSubmissionSelfCopyRecovery = false;
      if (preferLocalIdentity) {
        next = voterRuntime.bootstrapWithLocalIdentity({
          invitedNpub: invite.invitedNpub?.trim() || localVoterNpub,
          coordinatorNpub: invite.coordinatorNpub,
          invite,
          allowInviteRecipientMismatch: true,
          allowInviteMissing: true,
        });
        needsSubmissionSelfCopyRecovery = hasLocalSecretKey;
      } else {
        try {
          next = await voterRuntime.loginWithSigner(invite);
        } catch (error) {
          if (!(error instanceof SignerServiceError) && !(error instanceof OptionARuntimeError && error.code === "invite_mismatch")) {
            throw error;
          }
          next = voterRuntime.bootstrapWithLocalIdentity({
            invitedNpub: invite.invitedNpub?.trim() || props.localVoterNpub?.trim() || "",
            coordinatorNpub: invite.coordinatorNpub,
            invite,
            allowInviteRecipientMismatch: true,
            allowInviteMissing: true,
          });
          needsSubmissionSelfCopyRecovery = hasLocalSecretKey;
        }
      }
      if (needsSubmissionSelfCopyRecovery) {
        next = await voterRuntime.recoverSubmittedBallotFromSelfDm().catch(() => next);
      }

      setElectionId(invite.electionId);
      setRuntime(voterRuntime);
      setSignedInNpub(next.invitedNpub);
      const refreshedInvites = await loadPendingInvites({
        voterNpub: next.invitedNpub,
        allowRelayFetch: false,
      });
      const allowLocalRecipientMismatch = Boolean(props.localVoterNpub?.trim());
      setPendingInvites(refreshedInvites.filter((entry) => allowLocalRecipientMismatch || entry.invitedNpub === next.invitedNpub));
      setActiveInvite(!next.blindRequestSent && !next.credentialReady ? invite : null);
      if (requestAfterLogin && !next.blindRequestSent && !next.credentialReady) {
        await voterRuntime.requestBlindBallot();
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setStatus("Opened " + (invite.title || invite.electionId) + ". Blind ballot request sent.");
      } else {
        setStatus("Opened " + (invite.title || invite.electionId) + ".");
      }
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open invite.");
    }
  }

  function pushAnswers() {
    if (!runtime) {
      return;
    }
    const next = questions
      .map((question) => answerToOptionA(
        question,
        answers[question.questionId],
        question.type === "free_text" ? Boolean(encryptFreeTextByQuestionId[question.questionId]) : false,
      ))
      .filter((value): value is QuestionnaireAnswer => Boolean(value));
    runtime.updateDraftResponses(next);
    setRefreshNonce((value) => value + 1);
  }

  function addRankedAnswer(questionId: string, optionId: string) {
    setAnswers((current) => {
      const existing = Array.isArray(current[questionId])
        ? (current[questionId] as string[])
        : [];
      if (existing.includes(optionId)) {
        return current;
      }
      return { ...current, [questionId]: [...existing, optionId] };
    });
  }

  function moveRankedAnswer(questionId: string, optionId: string, direction: -1 | 1) {
    setAnswers((current) => {
      const existing = Array.isArray(current[questionId])
        ? [...(current[questionId] as string[])]
        : [];
      const index = existing.indexOf(optionId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= existing.length) {
        return current;
      }
      const swap = existing[index];
      existing[index] = existing[target];
      existing[target] = swap;
      return { ...current, [questionId]: existing };
    });
  }

  function removeRankedAnswer(questionId: string, optionId: string) {
    setAnswers((current) => {
      const existing = Array.isArray(current[questionId])
        ? (current[questionId] as string[])
        : [];
      return { ...current, [questionId]: existing.filter((entry) => entry !== optionId) };
    });
  }

  function getCredentialIssuerDisplayName() {
    const targetElectionId = currentQuestionnaireId;
    const invite = (snapshot?.inviteMessage?.electionId === targetElectionId ? snapshot.inviteMessage : null)
      ?? (activeInvite?.electionId === targetElectionId ? activeInvite : null)
      ?? contextPendingInvites.find((entry) => entry.electionId === targetElectionId)
      ?? null;
    const summary = targetElectionId ? loadElectionSummary(targetElectionId) : null;
    const issueBlindTokensWorker = invite?.issueBlindTokensWorker ?? summary?.issueBlindTokensWorker ?? null;
    return issueBlindTokensWorker?.workerNpub?.trim() ? "audit proxy" : "organiser";
  }

  async function requestBallot() {
    if (!runtime) {
      return;
    }
    try {
      if (!autoRequestBlindSigningKeyReady) {
        setStatus("Loading questionnaire ballot key before requesting a ballot...");
        return;
      }
      ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true });
      const wasAlreadyWaiting = Boolean(runtime.getSnapshot()?.blindRequestSent && !runtime.getSnapshot()?.credentialReady);
      await runtime.requestBlindBallot({ forceResend: true });
      markSignerWaitRecoveryBaseline();
      scheduleSignerInitialPull();
      if (snapshot?.electionId && snapshot?.invitedNpub) {
        const requestKey = `${snapshot.electionId}:${snapshot.invitedNpub}`;
        autoRequestSentForRef.current[requestKey] = true;
      }
      setActiveInvite(null);
      const credentialIssuerName = getCredentialIssuerDisplayName();
      setStatus(wasAlreadyWaiting
        ? `Blind ballot request resent. Waiting for ${credentialIssuerName} issuance.`
        : `Blind ballot request sent. Waiting for ${credentialIssuerName} issuance.`
      );
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed.");
    }
  }

  useEffect(() => {
    if (settingsMode || !runtime || !snapshot?.loginVerified) {
      return;
    }
    if (snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const targetElectionId = snapshot.electionId?.trim();
    const targetInvitedNpub = snapshot.invitedNpub?.trim();
    if (!targetElectionId || !targetInvitedNpub) {
      return;
    }
    if (targetElectionId !== currentQuestionnaireId || !autoRequestBlindSigningKeyReady) {
      return;
    }
    const hasQuestionnaireContext = Boolean(
      questions.length > 0
      || snapshot.inviteMessage
      || activeInvite
      || inviteContext.inviteCode
      || inviteContext.electionId === targetElectionId
      || latestAnnouncedQuestionnaireId === targetElectionId
      || contextPendingInvites.some((invite) => invite.electionId === targetElectionId)
      || readCachedQuestionnaireDefinition(targetElectionId),
    );
    if (!hasQuestionnaireContext) {
      return;
    }
    const key = `${targetElectionId}:${targetInvitedNpub}:page-load`;
    if (autoRequestDelayedForRef.current[key]) {
      return;
    }
    autoRequestDelayedForRef.current[key] = true;
    let fired = false;
    const timeoutId = window.setTimeout(() => {
      fired = true;
      const current = runtime.getSnapshot();
      if (
        !current?.loginVerified
        || current.electionId !== targetElectionId
        || current.invitedNpub !== targetInvitedNpub
        || current.blindRequestSent
        || current.credentialReady
        || current.submission
      ) {
        return;
      }
      void requestBallot();
    }, AUTO_BALLOT_PAGE_LOAD_REQUEST_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
      if (!fired) {
        delete autoRequestDelayedForRef.current[key];
      }
    };
  }, [
    activeInvite,
    autoRequestBlindSigningKeyReady,
    contextPendingInvites,
    currentQuestionnaireId,
    inviteContext.electionId,
    inviteContext.inviteCode,
    latestAnnouncedQuestionnaireId,
    questions.length,
    runtime,
    snapshot?.blindRequestSent,
    snapshot?.credentialReady,
    snapshot?.electionId,
    snapshot?.invitedNpub,
    snapshot?.loginVerified,
    snapshot?.submission,
    settingsMode,
  ]);

  function refreshStatus() {
    if (!runtime) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true });
      queueBallotWaitRefresh({
        restartSubscriptions: true,
        mode: "manual",
        forceWhenHidden: true,
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Refresh failed.");
    }
  }

  async function submit() {
    if (!runtime) {
      return;
    }
    try {
      pushAnswers();
      await runtime.submitVote(requiredQuestionIds);
      setStatus(null);
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Submit failed.");
    }
  }

  function viewResults() {
    if (typeof window === "undefined") {
      return;
    }
    const targetQuestionnaireId = snapshot?.electionId?.trim() || electionId.trim();
    if (!targetQuestionnaireId) {
      return;
    }
    const url = new URL(window.location.href);
    url.searchParams.set("role", "auditor");
    url.searchParams.set("questionnaire", targetQuestionnaireId);
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  }

  useEffect(() => {
    if (settingsMode || !runtime || !snapshot || !snapshot.loginVerified) {
      return;
    }
    if (inviteContext.inviteCode) {
      return;
    }
    if (snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    if (snapshot.electionId !== currentQuestionnaireId || !autoRequestBlindSigningKeyReady) {
      return;
    }
    let requestSnapshot: VoterElectionLocalState;
    try {
      requestSnapshot = ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true }) ?? runtime.getSnapshot() ?? snapshot;
    } catch {
      return;
    }
    if (!requestSnapshot.loginVerified || requestSnapshot.electionId !== currentQuestionnaireId) {
      return;
    }
    const hasInviteContext = Boolean(
      requestSnapshot.inviteMessage
      || activeInvite
      || inviteContext.inviteCode
      || inviteContext.electionId === requestSnapshot.electionId
      || latestAnnouncedQuestionnaireId === requestSnapshot.electionId
      || contextPendingInvites.some((invite) => invite.electionId === requestSnapshot.electionId)
      || readCachedQuestionnaireDefinition(requestSnapshot.electionId),
    );
    if (!hasInviteContext) {
      return;
    }
    const key = requestSnapshot.electionId + ":" + requestSnapshot.invitedNpub;
    if (autoRequestSentForRef.current[key]) {
      return;
    }
    if (autoRequestInFlightForRef.current[key]) {
      return;
    }
    const lastAttemptAt = autoRequestLastAttemptAtRef.current[key] ?? 0;
    if (Date.now() - lastAttemptAt < AUTO_BALLOT_REQUEST_MIN_INTERVAL_MS) {
      return;
    }
    try {
      autoRequestInFlightForRef.current[key] = true;
      autoRequestLastAttemptAtRef.current[key] = Date.now();
      void runtime.requestBlindBallot().then(() => {
        autoRequestSentForRef.current[key] = true;
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setActiveInvite(null);
        setStatus(`Blind ballot request sent. Waiting for ${getCredentialIssuerDisplayName()} issuance.`);
        setRefreshNonce((value) => value + 1);
      }).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Request failed.");
      }).finally(() => {
        delete autoRequestInFlightForRef.current[key];
      });
    } catch {
      delete autoRequestInFlightForRef.current[key];
      // Keep manual request available if automatic send cannot proceed yet.
    }
  }, [activeInvite, autoRequestBlindSigningKeyReady, contextPendingInvites, currentQuestionnaireId, inviteContext.electionId, inviteContext.inviteCode, latestAnnouncedQuestionnaireId, runtime, settingsMode, snapshot]);

  useEffect(() => {
    if (!runtime || !snapshot?.loginVerified || !snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (!hasLocalSecretKey) {
      return;
    }
    const pollMs = AUTO_BALLOT_RETRY_POLL_MS;
    const resendMs = AUTO_BALLOT_RETRY_RESEND_MS;
    const key = snapshot.electionId + ":" + snapshot.invitedNpub;
    let cancelled = false;
    let retryInFlight = false;
    let timeoutId: number | null = null;
    const retry = async () => {
      if (retryInFlight) {
        return;
      }
      retryInFlight = true;
      try {
        if (cancelled || !isPageVisible()) {
          return;
        }
        queueBallotWaitRefresh({ mode: "lifecycle" });
        const now = Date.now();
        const lastAttemptAt = requestRetryAtRef.current[key] ?? 0;
        if (now - lastAttemptAt < resendMs) {
          return;
        }
        requestRetryAtRef.current[key] = now;
        try {
          await runtime.requestBlindBallot({ minRetryMs: resendMs });
          markSignerWaitRecoveryBaseline();
          scheduleSignerInitialPull();
          queueBallotWaitRefresh({
            restartSubscriptions: true,
            mode: "manual",
            forceWhenHidden: true,
          });
        } catch {
          // Retry is best-effort; explicit controls surface errors.
        }
      } finally {
        retryInFlight = false;
      }
    };
    const onVisible = () => {
      if (!isPageVisible()) {
        return;
      }
      void retry();
    };
    const loop = () => {
      timeoutId = window.setTimeout(async () => {
        await retry();
        if (!cancelled) {
          loop();
        }
      }, pollMs);
    };
    loop();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [runtime, props.localVoterNsec, snapshot?.electionId, snapshot?.invitedNpub, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

  useEffect(() => {
    if (!runtime || !snapshot?.loginVerified || !snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (hasLocalSecretKey) {
      return;
    }
    const pollMs = isLikelyMobileClient()
      ? AUTO_BALLOT_MOBILE_RECOVERY_PULL_MS
      : AUTO_BALLOT_SIGNER_KEEPALIVE_REFRESH_MS;
    let cancelled = false;
    let timeoutId: number | null = null;
    const triggerForegroundRefresh = (mode: BallotWaitRefreshMode) => {
      if (!isPageVisible()) {
        return;
      }
      const now = Date.now();
      if (now - ballotWaitLifecycleTriggerAtRef.current < 1_500) {
        return;
      }
      ballotWaitLifecycleTriggerAtRef.current = now;
      queueBallotWaitRefresh({ mode });
    };
    const loop = () => {
      timeoutId = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (isPageVisible()) {
          const mode: BallotWaitRefreshMode = isLikelyMobileClient() ? "background" : "lifecycle";
          queueBallotWaitRefresh({ mode });
        }
        if (!cancelled) {
          loop();
        }
      }, pollMs);
    };
    const onVisible = () => {
      triggerForegroundRefresh(isLikelyMobileClient() ? "background" : "lifecycle");
    };
    loop();
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runtime, props.localVoterNsec, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

  useEffect(() => {
    if (!runtime || !snapshot?.loginVerified || !snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const hasLocalSecretKey = Boolean(props.localVoterNsec?.trim());
    if (hasLocalSecretKey) {
      return;
    }
    const timeoutIds = AUTO_BALLOT_SIGNER_REFRESH_SCHEDULE_MS.map((delayMs, index) => window.setTimeout(() => {
      const mode: BallotWaitRefreshMode =
        index === 0
          ? "manual"
          : index === AUTO_BALLOT_SIGNER_REFRESH_SCHEDULE_MS.length - 1
            ? "background"
            : "restart_only";
      queueBallotWaitRefresh({ mode });
    }, delayMs));
    return () => {
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [runtime, props.localVoterNsec, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

  useEffect(() => {
    if (!runtime || !props.requestBlindBallotNonce || props.requestBlindBallotNonce <= 0) {
      return;
    }
    try {
      const current = ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true }) ?? runtime.getSnapshot();
      if (!current?.loginVerified) {
        setStatus("Open Vote and login, then the blind-signature request will send automatically.");
        return;
      }
      if (current.electionId !== currentQuestionnaireId || !autoRequestBlindSigningKeyReady) {
        setStatus("Loading questionnaire ballot key before requesting a ballot...");
        return;
      }
      if (current.submission || current.credentialReady || current.blindRequestSent) {
        setRefreshNonce((value) => value + 1);
        return;
      }
      const requestKey = `${current.electionId}:${current.invitedNpub}`;
      if (autoRequestInFlightForRef.current[requestKey]) {
        return;
      }
      const lastAttemptAt = autoRequestLastAttemptAtRef.current[requestKey] ?? 0;
      if (Date.now() - lastAttemptAt < AUTO_BALLOT_REQUEST_MIN_INTERVAL_MS) {
        return;
      }
      autoRequestInFlightForRef.current[requestKey] = true;
      autoRequestLastAttemptAtRef.current[requestKey] = Date.now();
      void runtime.requestBlindBallot().then(() => {
        autoRequestSentForRef.current[requestKey] = true;
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setActiveInvite(null);
        setStatus(`Blind ballot request sent. Waiting for ${getCredentialIssuerDisplayName()} issuance.`);
        setRefreshNonce((value) => value + 1);
      }).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Could not send blind ballot request.");
      }).finally(() => {
        delete autoRequestInFlightForRef.current[requestKey];
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start blind ballot request.");
    }
  }, [
    props.autoSignerLogin,
    props.localVoterNpub,
    props.localVoterNsec,
    props.requestBlindBallotNonce,
    runtime,
    currentQuestionnaireId,
    autoRequestBlindSigningKeyReady,
    snapshot?.loginVerified,
  ]);

  const canShowInviteForCurrentIdentity = (invite: ElectionInviteMessage) => {
    const signedIn = signedInNpub.trim();
    return !signedIn || invite.invitedNpub === signedIn || Boolean(props.localVoterNpub?.trim());
  };
  const visiblePendingInvites = snapshot?.loginVerified && snapshot.electionId === electionId.trim()
    ? []
    : contextPendingInvites.filter(canShowInviteForCurrentIdentity);
  const inviteDropdownOptions = useMemo(() => {
    const map = new Map<string, ElectionInviteMessage>();
    for (const invite of contextPendingInvites) {
      if (!canShowInviteForCurrentIdentity(invite)) {
        continue;
      }
      const key = `${invite.electionId}:${invite.coordinatorNpub}`;
      map.set(key, invite);
    }
    const currentInvite = snapshot?.inviteMessage ?? activeInvite ?? null;
    if (currentInvite) {
      const currentInviteIsInContext = !linkedContextElectionId || currentInvite.electionId === linkedContextElectionId;
      if (currentInviteIsInContext) {
        const key = `${currentInvite.electionId}:${currentInvite.coordinatorNpub}`;
        map.set(key, currentInvite);
      }
    }
    return [...map.values()];
  }, [activeInvite, contextPendingInvites, linkedContextElectionId, signedInNpub, props.localVoterNpub, snapshot?.inviteMessage]);

  useEffect(() => {
    const selectedQuestionnaireId = currentQuestionnaireId;
    if (!selectedQuestionnaireId) {
      return;
    }
    const matched = inviteDropdownOptions.find((invite) => invite.electionId === selectedQuestionnaireId);
    if (matched) {
      const key = `${matched.electionId}:${matched.coordinatorNpub}`;
      if (selectedInviteKey !== key) {
        setSelectedInviteKey(key);
      }
      return;
    }
    if (!selectedInviteKey && inviteDropdownOptions.length > 0) {
      const first = inviteDropdownOptions[0];
      setSelectedInviteKey(`${first.electionId}:${first.coordinatorNpub}`);
    }
  }, [currentQuestionnaireId, inviteDropdownOptions, selectedInviteKey]);
  const waitingForCredential = Boolean(snapshot?.blindRequestSent && !snapshot?.credentialReady && !snapshot?.submission);
  const canRequestOrResendBallot = flags.canRequestBallot || waitingForCredential;

  const requiredQuestionsAnswered = questions.length > 0 && requiredQuestions.every((question) => {
    const value = answers[question.questionId];
    if (Array.isArray(value)) {
      if (question.type === "rank") {
        return value.length >= Math.max(1, question.minimumRanked ?? 1);
      }
      return value.length > 0;
    }
    return value !== undefined && value !== null && String(value).trim().length > 0;
  });
  const canSubmitNow = flags.canSubmitVote && requiredQuestionsAnswered;
  useEffect(() => {
    const owner = globalThis as typeof globalThis & {
      __questionnaireVoterDebug?: unknown;
    };
    const targetQuestionnaireId = currentQuestionnaireId || electionId.trim();
    const snapshotForTarget = snapshot?.electionId === targetQuestionnaireId ? snapshot : null;
    const questionnaireSeen = questions.length > 0 || Boolean(autoRequestDefinition);
    owner.__questionnaireVoterDebug = {
      mode: "option_a",
      questionnaireId: targetQuestionnaireId,
      linkedQuestionnaireId: linkedContextElectionId || null,
      loadedQuestionnaireId: autoRequestDefinition?.questionnaireId ?? null,
      loadedQuestionCount: questions.length,
      questionnaireSeen,
      questionnaireOpen: questionnaireSeen,
      tokenRequested: Boolean(snapshotForTarget?.blindRequestSent),
      tokenReceived: Boolean(snapshotForTarget?.credentialReady),
      responseReady: canSubmitNow,
      responsePublished: Boolean(snapshotForTarget?.submission),
      responseSubmittedCount: snapshotForTarget?.submission ? 1 : 0,
      submitButtonPresent: true,
      submitButtonVisible: !settingsMode,
      submitButtonDisabled: !(canSubmitNow || Boolean(snapshotForTarget?.submission)),
      submitButtonText: snapshotForTarget?.submission
        ? "View results"
        : !requiredQuestionsAnswered
          ? "Please answer all required questions"
          : canSubmitNow
            ? "Submit response"
            : "Verifying vote request",
      submitButtonReasonBlocked: snapshotForTarget?.submission
        ? null
        : !requiredQuestionsAnswered
          ? "required_questions_unanswered"
          : !snapshotForTarget?.loginVerified
            ? "not_logged_in"
            : !autoRequestBlindSigningKeyReady
              ? "blind_signing_key_not_ready"
              : !snapshotForTarget?.coordinatorNpub?.trim()
                ? "coordinator_missing"
                : snapshotForTarget?.blindRequestSent && !snapshotForTarget?.credentialReady
                  ? "waiting_for_credential"
                  : !snapshotForTarget?.credentialReady
                    ? "credential_missing"
                    : !flags.canSubmitVote
                      ? "runtime_submit_not_ready"
                      : null,
      status,
      signedInNpub: signedInNpub || null,
      localVoterNpub: props.localVoterNpub?.trim() || null,
      localVoterNsecPresent: Boolean(props.localVoterNsec?.trim()),
      autoSignerLogin: Boolean(props.autoSignerLogin),
      runtimePresent: Boolean(runtime),
      snapshotElectionId: snapshot?.electionId ?? null,
      snapshotInvitedNpub: snapshot?.invitedNpub ?? null,
      snapshotCoordinatorNpub: snapshot?.coordinatorNpub ?? null,
      snapshotLoginVerified: Boolean(snapshot?.loginVerified),
      snapshotBlindRequestSent: Boolean(snapshot?.blindRequestSent),
      snapshotBlindRequestId: snapshot?.blindRequest?.requestId ?? null,
      snapshotCredentialReady: Boolean(snapshot?.credentialReady),
      snapshotSubmissionId: snapshot?.submission?.submissionId ?? null,
      autoRequestBlindSigningKeyReady,
      autoRequestDefinitionPresent: Boolean(autoRequestDefinition),
      autoRequestDefinitionHasBlindKey: Boolean(autoRequestDefinition?.blindSigningPublicKey),
      activeInviteElectionId: activeInvite?.electionId ?? null,
      pendingInviteCount: contextPendingInvites.length,
      latestAnnouncedQuestionnaireId: latestAnnouncedQuestionnaireId || null,
    };
    return () => {
      const current = owner.__questionnaireVoterDebug as { mode?: unknown } | null | undefined;
      if (current?.mode === "option_a") {
        delete owner.__questionnaireVoterDebug;
      }
    };
  }, [
    activeInvite?.electionId,
    autoRequestBlindSigningKeyReady,
    autoRequestDefinition,
    canSubmitNow,
    contextPendingInvites.length,
    currentQuestionnaireId,
    electionId,
    flags.canSubmitVote,
    latestAnnouncedQuestionnaireId,
    linkedContextElectionId,
    props.autoSignerLogin,
    props.localVoterNpub,
    props.localVoterNsec,
    questions.length,
    requiredQuestionsAnswered,
    runtime,
    settingsMode,
    signedInNpub,
    snapshot,
    status,
  ]);
  const statusQuestionnaireId = currentQuestionnaireId || electionId.trim();
  const coordinatorNpub = (snapshot?.electionId === statusQuestionnaireId ? snapshot.coordinatorNpub?.trim() : "")
    || (activeInvite?.electionId === statusQuestionnaireId ? activeInvite.coordinatorNpub?.trim() : "")
    || inviteDropdownOptions.find((invite) => invite.electionId === statusQuestionnaireId)?.coordinatorNpub?.trim()
    || "";
  const selectedInviteForElection = inviteDropdownOptions.find((invite) => invite.electionId === statusQuestionnaireId) ?? null;
  const electionSummary = statusQuestionnaireId
    ? loadElectionSummary(statusQuestionnaireId)
    : null;
  const issueBlindTokensWorker = (snapshot?.inviteMessage?.electionId === statusQuestionnaireId ? snapshot.inviteMessage.issueBlindTokensWorker : null)
    ?? (activeInvite?.electionId === statusQuestionnaireId ? activeInvite.issueBlindTokensWorker : null)
    ?? selectedInviteForElection?.issueBlindTokensWorker
    ?? electionSummary?.issueBlindTokensWorker
    ?? null;
  const credentialIssuerNpub = issueBlindTokensWorker?.workerNpub?.trim() || coordinatorNpub;
  const credentialIssuerIsProxy = Boolean(issueBlindTokensWorker?.workerNpub?.trim());
  const credentialIssuerName = credentialIssuerIsProxy ? "audit proxy" : "organiser";
  const credentialIssuerLabel = credentialIssuerNpub ? deriveActorDisplayId(credentialIssuerNpub) : "Unknown";
  const decisionActorName = credentialIssuerIsProxy ? "audit proxy" : "organiser";
  const coordinatorLabel = coordinatorNpub ? deriveActorDisplayId(coordinatorNpub) : "Unknown";
  const submittedQuestionnaireId = snapshot?.submission?.payload?.electionId
    || snapshot?.submission?.electionId
    || statusQuestionnaireId;
  const requestStateText = snapshot?.blindRequestSent ? "Sent" : "Not sent";
  const credentialStateText = snapshot?.credentialReady
    ? "Received"
    : snapshot?.blindRequestSent
      ? `Waiting for ${credentialIssuerName}`
      : "Not requested";
  const submissionStateText = snapshot?.submissionAccepted === true
    ? "Accepted"
    : snapshot?.submissionAccepted === false
      ? "Rejected"
      : snapshot?.submission
        ? `Waiting for ${decisionActorName}`
        : "Not submitted";
  const submittedMarkerNpub = snapshot?.responseNpub ?? snapshot?.submission?.responseNpub ?? snapshot?.submission?.invitedNpub ?? "";
  const submittedMarkerLabel = submittedMarkerNpub ? deriveActorDisplayId(submittedMarkerNpub) : "Unknown";
  const questionnaireHeadingText = questionnaireTitle.trim() || questionnaireDescription.trim() || "Questionnaire";
  const questionnaireDescriptionText = questionnaireDescription.trim();
  const showQuestionnaireDescription = Boolean(
    questionnaireDescriptionText && questionnaireDescriptionText !== questionnaireHeadingText,
  );
  const questionnaireDisplayId = statusQuestionnaireId;
  const ballotStatusSection = (
    <section id='questionnaire-ballot-status' className='simple-settings-card' aria-label='Ballot status'>
      <h4 className='simple-voter-section-title'>Ballot status</h4>
      <div className='simple-voter-action-row simple-voter-action-row-inline simple-optiona-voter-controls'>
        <button type='button' className='simple-voter-secondary' disabled={!canRequestOrResendBallot} onClick={requestBallot}>
          {waitingForCredential ? "Resend request" : "Request ballot"}
        </button>
        <button type='button' className='simple-voter-secondary' onClick={refreshStatus}>Refresh status</button>
      </div>
      <p className='simple-voter-note'>Organiser: {coordinatorLabel}</p>
      {credentialIssuerIsProxy ? (
        <p className='simple-voter-note'>Ballot credential issuer: audit proxy {credentialIssuerLabel}</p>
      ) : null}
      {coordinatorNpub ? (
        <TokenFingerprint
          tokenId={coordinatorNpub}
          label='Organiser marker'
          showQr
          compact
          hideMetadata
        />
      ) : null}
      {credentialIssuerIsProxy && credentialIssuerNpub ? (
        <TokenFingerprint
          tokenId={credentialIssuerNpub}
          label='Audit proxy marker'
          showQr
          compact
          hideMetadata
        />
      ) : null}
      <p className='simple-voter-note'>Questionnaire ID: {electionId || "Missing"}</p>
      <ul className='simple-vote-status-list'>
        <li className={snapshot?.loginVerified ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Identity confirmed: {snapshot?.loginVerified ? "Yes" : "No"}</li>
        <li className={snapshot?.blindRequestSent ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Ballot request: {requestStateText}</li>
        <li className={snapshot?.credentialReady ? "is-complete" : waitingForCredential ? "is-pending" : ""}><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Ballot credential: {credentialStateText}</li>
        <li className={snapshot?.submissionAccepted === true ? "is-complete" : snapshot?.submission ? "is-pending" : ""}><span className='simple-vote-status-icon' aria-hidden='true'>•</span> Response: {submissionStateText}</li>
      </ul>
      {waitingForCredential ? (
        <p className='simple-voter-note'>
          {credentialIssuerIsProxy
            ? "Waiting for the audit proxy to issue your ballot credential. This page checks automatically; the organiser does not need to stay online once the proxy has received its delegation."
            : "Waiting for the organiser to issue your ballot credential. This page checks automatically; the organiser must be online and can press Process requests."}
        </p>
      ) : null}
    </section>
  );

  if (settingsMode) {
    return (
      <div className='simple-optiona-voter-settings'>
        {ballotStatusSection}
        <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
      </div>
    );
  }

  return (
    <div className='simple-voter-card simple-optiona-voter-page'>
      {props.showLoginAction !== false && !snapshot?.loginVerified ? (
        <div className='simple-questionnaire-header'>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <button type='button' className='simple-voter-secondary' onClick={() => void login()}>Login</button>
          </div>
        </div>
      ) : null}

      {inviteDropdownOptions.length > 0 ? (
        <>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <select
              id='questionnaire-invite-select'
              className='simple-voter-input'
              value={selectedInviteKey}
              onChange={(event) => {
                const key = event.target.value;
                setSelectedInviteKey(key);
                const selected = inviteDropdownOptions.find((invite) => `${invite.electionId}:${invite.coordinatorNpub}` === key);
                if (selected) {
                  void openInvite(selected);
                }
              }}
            >
              {inviteDropdownOptions.map((invite) => {
                const key = `${invite.electionId}:${invite.coordinatorNpub}`;
                return (
                  <option key={key} value={key}>
                    {resolveInviteDisplayTitle(invite) + " · " + invite.electionId}
                  </option>
                );
              })}
            </select>
          </div>
        </>
      ) : null}
      {visiblePendingInvites.length > 0 ? (
        <section className='simple-settings-card' aria-label='Pending questionnaire invites'>
          <h4 className='simple-voter-section-title'>Pending invites</h4>
          <ul className='simple-vote-status-list'>
            {visiblePendingInvites.map((invite) => (
              <li key={`${invite.electionId}:${invite.coordinatorNpub}`}>
                <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
                {invite.title || invite.electionId}
                <button
                  type='button'
                  className='simple-voter-secondary'
                  style={{ marginLeft: 8 }}
                  onClick={() => void openInvite(invite)}
                >
                  Open
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  style={{ marginLeft: 8 }}
                  onClick={() => void openInvite(invite, true)}
                >
                  Open + request ballot
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className='simple-questionnaire-voter-overview' aria-label='Questionnaire summary'>
        <div className='simple-questionnaire-voter-title-block'>
          <p className='simple-questionnaire-voter-number'>
            Questionnaire
            <span className='simple-questionnaire-voter-number-id'>{questionnaireDisplayId || "Missing"}</span>
          </p>
          <h4 className='simple-questionnaire-voter-prompt'>{questionnaireHeadingText}</h4>
          {showQuestionnaireDescription ? (
            <p className='simple-questionnaire-voter-description'>{questionnaireDescriptionText}</p>
          ) : null}
        </div>
      </section>

      {questions.length === 0 ? (
        <p className='simple-voter-note'>
          {snapshot?.submissionAccepted === true
            ? "Response accepted. Questionnaire details are not loaded in this browser."
            : "Waiting for questions to be published."}
        </p>
      ) : (
        <div className='simple-questionnaire-voter-list'>
          {questions.map((question, index) => {
            const ranked = question.type === "rank" && Array.isArray(answers[question.questionId])
              ? (answers[question.questionId] as string[])
              : [];
            const rankRequirement = question.type === "rank"
              ? getRankRequirementState(question.options?.length ?? 0, question.minimumRanked ?? 0, ranked.length)
              : null;
            const requirementClass = rankRequirement
              ? rankRequirement.missing > 0
                ? " is-needed"
                : question.required
                  ? ""
                  : " is-optional"
              : question.required ? "" : " is-optional";
            return (
            <article key={question.questionId} className='simple-questionnaire-voter-card'>
              <div className='simple-questionnaire-voter-heading'>
                <h4 className='simple-questionnaire-voter-prompt'>Q{index + 1}: {question.prompt || "Untitled question"}</h4>
                <p className={`simple-questionnaire-voter-requirement${requirementClass}`}>
                  {rankRequirement?.label ?? (question.required ? "Required" : "Optional")}
                </p>
              </div>
              {rankRequirement && rankRequirement.missing > 0 ? (
                <p className='simple-questionnaire-rank-needed'>
                  Choose at least {rankRequirement.minimum} ranked choices. {rankRequirement.missing} more needed.
                </p>
              ) : null}
              {question.type === "yes_no" ? (
                <div className='simple-vote-button-grid simple-questionnaire-yes-no-grid'>
                  <button
                    type='button'
                    className={`simple-voter-choice simple-voter-choice-yes${answers[question.questionId] === "yes" ? " is-active" : answers[question.questionId] === "no" ? " is-dimmed" : ""}`}
                    aria-pressed={answers[question.questionId] === "yes"}
                    onClick={() => setAnswers((current) => ({ ...current, [question.questionId]: "yes" }))}
                  >
                    Yes
                  </button>
                  <button
                    type='button'
                    className={`simple-voter-choice simple-voter-choice-no${answers[question.questionId] === "no" ? " is-active" : answers[question.questionId] === "yes" ? " is-dimmed" : ""}`}
                    aria-pressed={answers[question.questionId] === "no"}
                    onClick={() => setAnswers((current) => ({ ...current, [question.questionId]: "no" }))}
                  >
                    No
                  </button>
                </div>
              ) : null}
              {question.type === "multiple_choice" ? (
                <div className='simple-questionnaire-choice-list'>
                  {(question.options ?? []).map((option) => {
                    const selected = Array.isArray(answers[question.questionId])
                      ? (answers[question.questionId] as string[])
                      : [];
                    const checked = selected.includes(option.optionId);
                    return (
                      <label key={option.optionId} className='simple-questionnaire-choice-row'>
                        <input
                          type={question.multiSelect ? "checkbox" : "radio"}
                          checked={checked}
                          onChange={() => {
                            setAnswers((current) => {
                              const existing = Array.isArray(current[question.questionId])
                                ? (current[question.questionId] as string[])
                                : [];
                              if (!question.multiSelect) {
                                return { ...current, [question.questionId]: [option.optionId] };
                              }
                              return checked
                                ? { ...current, [question.questionId]: existing.filter((entry) => entry !== option.optionId) }
                                : { ...current, [question.questionId]: [...existing, option.optionId] };
                            });
                          }}
                        />
                        <span>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
              {question.type === "rank" ? (
                <div className='simple-questionnaire-rank-voter-grid'>
                  {(() => {
                    const rankedSet = new Set(ranked);
                    const unrankedOptions = (question.options ?? []).filter((option) => !rankedSet.has(option.optionId));
                    return (
                      <>
                        <div className='simple-questionnaire-choice-list'>
                          {ranked.length > 0 ? ranked.map((optionId, rankedIndex) => {
                            const option = (question.options ?? []).find((entry) => entry.optionId === optionId);
                            if (!option) {
                              return null;
                            }
                            return (
                              <div key={option.optionId} className='simple-questionnaire-rank-row'>
                                <span className='simple-questionnaire-rank-number'>{rankedIndex + 1}</span>
                                <span>{option.label}</span>
                                <div className='simple-questionnaire-rank-actions'>
                                  <button
                                    type='button'
                                    className='simple-voter-secondary simple-questionnaire-rank-action'
                                    onClick={() => moveRankedAnswer(question.questionId, option.optionId, -1)}
                                    disabled={rankedIndex === 0}
                                  >
                                    Up
                                  </button>
                                  <button
                                    type='button'
                                    className='simple-voter-secondary simple-questionnaire-rank-action'
                                    onClick={() => moveRankedAnswer(question.questionId, option.optionId, 1)}
                                    disabled={rankedIndex === ranked.length - 1}
                                  >
                                    Down
                                  </button>
                                  <button
                                    type='button'
                                    className='simple-voter-secondary simple-questionnaire-rank-action'
                                    onClick={() => removeRankedAnswer(question.questionId, option.optionId)}
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            );
                          }) : null}
                        </div>
                        {unrankedOptions.length > 0 ? (
                          <div className='simple-questionnaire-choice-list'>
                            {unrankedOptions.map((option) => (
                              <button
                                key={option.optionId}
                                type='button'
                                className='simple-voter-secondary simple-questionnaire-rank-add'
                                onClick={() => addRankedAnswer(question.questionId, option.optionId)}
                              >
                                <span className='simple-questionnaire-rank-add-option'>{option.label}</span>
                                <span className='simple-questionnaire-rank-add-prefix'>Add as #{ranked.length + 1}</span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              ) : null}
              {question.type === "free_text" ? (
                <>
                  <textarea
                    className='simple-voter-input simple-questionnaire-free-text'
                    rows={3}
                    maxLength={question.maxLength ?? 500}
                    value={typeof answers[question.questionId] === "string" ? (answers[question.questionId] as string) : ""}
                    onChange={(event) => setAnswers((current) => ({ ...current, [question.questionId]: event.target.value }))}
                  />
                  <label className='simple-questionnaire-choice-row'>
                    <input
                      type='checkbox'
                      checked={Boolean(encryptFreeTextByQuestionId[question.questionId])}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setEncryptFreeTextByQuestionId((current) => ({
                          ...current,
                          [question.questionId]: checked,
                        }));
                      }}
                    />
                    <span>Encrypt for organiser</span>
                  </label>
                </>
              ) : null}
            </article>
            );
          })}
        </div>
      )}

      <div className='simple-voter-action-row simple-voter-action-row-inline simple-optiona-voter-controls'>
        <button
          type='button'
          className='simple-voter-primary'
          disabled={!(canSubmitNow || Boolean(snapshot?.submission))}
          onClick={() => {
            if (snapshot?.submission) {
              viewResults();
              return;
            }
            void submit();
          }}
        >
          {snapshot?.submission
            ? "View results"
            : !requiredQuestionsAnswered
              ? "Please answer all required questions"
              : canSubmitNow
                ? "Submit response"
                : waitingForCredential
                  ? "Verifying vote request"
                  : "Verifying vote request"}
        </button>
      </div>
      {snapshot?.submission ? (
        <section className='simple-settings-card simple-submission-identity-card' aria-label='Voter ID used for private submission'>
          <div className='simple-submission-identity-header'>
            <div>
              <p className='simple-questionnaire-voter-number'>Private submission identity</p>
              <h4 className='simple-voter-section-title'>Voter ID used for private submission</h4>
            </div>
          </div>
          <div className='simple-submission-identity-body'>
            <div className='simple-submission-identity-visuals'>
              <TokenFingerprint
                tokenId={submittedMarkerNpub}
                label='Voter ID used for private submission'
                large
                showQr
                hideMetadata
                fingerprintTitle='Colour ID: a visual fingerprint for checking this private submission identity at a glance.'
                qrTitle='QR code: scan this to copy the full private submission identity.'
              />
              <div className='simple-submission-identity-visual-labels'>
                <span data-tooltip='Colour ID: a visual fingerprint for checking this private submission identity at a glance.'>Colour ID</span>
                <span data-tooltip='QR code: scan this to copy the full private submission identity.'>QR code</span>
              </div>
            </div>
            <dl className='simple-submission-identity-details'>
              <div>
                <dt>Questionnaire ID</dt>
                <dd>{submittedQuestionnaireId}</dd>
              </div>
              <div>
                <dt>Submission ID</dt>
                <dd>{snapshot.submission.submissionId}</dd>
              </div>
              {submittedMarkerNpub ? (
                <>
                  <div>
                    <dt>Submittor identity - short</dt>
                    <dd>{submittedMarkerLabel}</dd>
                  </div>
                  <div>
                    <dt>Submittor identity - full</dt>
                    <dd>{submittedMarkerNpub}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </div>
        </section>
      ) : null}
      <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
    </div>
  );
}

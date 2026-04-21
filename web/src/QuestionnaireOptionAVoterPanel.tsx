import { useEffect, useMemo, useRef, useState } from "react";
import { finalizeEvent, getPublicKey, nip19, nip44 } from "nostr-tools";
import { fetchQuestionnaireDefinitions } from "./questionnaireTransport";
import { parseInviteFromUrl } from "./questionnaireInvite";
import { createSignerService, SignerServiceError, type SignerService } from "./services/signerService";
import {
  QuestionnaireOptionAVoterRuntime,
  OptionARuntimeError,
} from "./questionnaireOptionARuntime";
import type { ElectionInviteMessage, QuestionnaireAnswer } from "./questionnaireOptionA";
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
import TokenFingerprint from "./TokenFingerprint";
import { decodeNsec } from "./nostrIdentity";

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
  question: { questionId: string; type: "yes_no" | "multiple_choice" | "free_text" },
  value: unknown,
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
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return null;
  }
  return { questionId: question.questionId, type: "text", answer: text };
}

function mapDefinitionQuestions(definition: QuestionnaireDefinition) {
  return definition.questions.map((question) => ({
    questionId: question.questionId,
    required: question.required,
    prompt: question.prompt,
    type: question.type,
    options: question.type === "multiple_choice" ? question.options : undefined,
    multiSelect: question.type === "multiple_choice" ? question.multiSelect : undefined,
    maxLength: question.type === "free_text" ? question.maxLength : undefined,
  }));
}

function latestDefinitionFromEntries(entries: Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>) {
  return [...entries].sort((a, b) => (b.event.created_at ?? 0) - (a.event.created_at ?? 0))[0]?.definition ?? null;
}

function cacheDefinitionForVoting(definition: QuestionnaireDefinition) {
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
  });
}

function buildInviteFromPublicDefinition(definition: QuestionnaireDefinition, invitedNpub: string): ElectionInviteMessage | null {
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
    definition,
    expiresAt: null,
  };
}

const LEGACY_INVITE_TITLE = "Should the proposal pass?";
const AUTO_BALLOT_REQUEST_MIN_INTERVAL_MS = 15_000;
const AUTO_BALLOT_RETRY_POLL_MS = 10_000;
const AUTO_BALLOT_RETRY_RESEND_MS = 60_000;

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
};

export default function QuestionnaireOptionAVoterPanel(props: QuestionnaireOptionAVoterPanelProps) {
  const [runtime, setRuntime] = useState<QuestionnaireOptionAVoterRuntime | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [signedInNpub, setSignedInNpub] = useState<string>("");
  const [pendingInvites, setPendingInvites] = useState<ElectionInviteMessage[]>([]);
  const [activeInvite, setActiveInvite] = useState<ElectionInviteMessage | null>(null);
  const [selectedInviteKey, setSelectedInviteKey] = useState<string>("");
  const [questionnaireTitle, setQuestionnaireTitle] = useState<string>("Questionnaire");
  const [questionnaireDescription, setQuestionnaireDescription] = useState<string>("");
  const [questions, setQuestions] = useState<Array<{
    questionId: string;
    required: boolean;
    prompt: string;
    type: "yes_no" | "multiple_choice" | "free_text";
    options?: Array<{ optionId: string; label: string }>;
    multiSelect?: boolean;
    maxLength?: number;
  }>>([]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [refreshNonce, setRefreshNonce] = useState(0);
  const autoRequestSentForRef = useRef<Record<string, true>>({});
  const autoRequestInFlightForRef = useRef<Record<string, true>>({});
  const autoRequestLastAttemptAtRef = useRef<Record<string, number>>({});
  const requestRetryAtRef = useRef<Record<string, number>>({});
  const autoSignerLoginForRef = useRef<Record<string, true>>({});

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

  useEffect(() => {
    if (previousElectionIdRef.current === electionId) {
      return;
    }
    previousElectionIdRef.current = electionId;
    setAnswers({});
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
    return () => {
      runtime?.dispose();
    };
  }, [runtime]);

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
    const intervalId = window.setInterval(() => {
      try {
        runtime.refreshIssuanceAndAcceptance();
        setRefreshNonce((value) => value + 1);
      } catch {
        // Keep polling best-effort; explicit actions surface errors.
      }
    }, 60000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runtime, signedInNpub, props.localVoterNsec, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission, snapshot?.submissionAccepted]);

  useEffect(() => {
    setQuestionnaireTitle("Questionnaire");
    setQuestionnaireDescription("");
    setQuestions([]);
    if (!electionId) {
      return;
    }
    const localDefinition =
      activeInvite?.definition
      ?? snapshot?.blindIssuance?.definition
      ?? snapshot?.inviteMessage?.definition
      ?? pendingInvites.find((invite) => invite.electionId === electionId)?.definition
      ?? inviteContext.invite?.definition
      ?? readCachedQuestionnaireDefinition(electionId);
    if (localDefinition) {
      cacheDefinitionForVoting(localDefinition);
      setQuestionnaireTitle(localDefinition.title || "Questionnaire");
      setQuestionnaireDescription(localDefinition.description || "");
      setQuestions(mapDefinitionQuestions(localDefinition));
    }
    let cancelled = false;
    void fetchQuestionnaireDefinitions({ questionnaireId: electionId, limit: 20 })
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
        setQuestions(mapDefinitionQuestions(latest));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeInvite, electionId, inviteContext.invite, pendingInvites, snapshot?.blindIssuance, snapshot?.inviteMessage]);

  useEffect(() => {
    const currentId = electionId.trim();
    if (latestAnnouncedQuestionnaireId && (!currentId || (!hasInFlightState() && currentId !== latestAnnouncedQuestionnaireId))) {
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
  }, [electionId, latestAnnouncedQuestionnaireId, props.localVoterNpub, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  useEffect(() => {
    if (pendingInvites.length === 0 || hasInFlightState()) {
      return;
    }
    const preferredInvite = (latestAnnouncedQuestionnaireId
      ? pendingInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId)
      : null)
      ?? pendingInvites.at(-1)
      ?? null;
    const nextElectionId = preferredInvite?.electionId?.trim() ?? "";
    if (nextElectionId && electionId.trim() !== nextElectionId) {
      setElectionId(nextElectionId);
    }
  }, [electionId, pendingInvites, latestAnnouncedQuestionnaireId, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  const requiredQuestionIds = useMemo(
    () => questions.filter((question) => question.required).map((question) => question.questionId),
    [questions],
  );

  function hasInFlightState(state = snapshot) {
    return Boolean(state?.blindRequest || state?.blindIssuance || state?.submission);
  }

  function findBestLocalInvite(voterNpub: string, preferredElectionId = electionId) {
    const localInvites = [...listInvitesFromMailbox(voterNpub)];
    const preferredId = preferredElectionId.trim();
    return (preferredId ? localInvites.find((invite) => invite.electionId === preferredId) : null)
      ?? (latestAnnouncedQuestionnaireId ? localInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) : null)
      ?? localInvites.at(-1)
      ?? null;
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
    if (currentSnapshot?.invitedNpub === localVoterNpub) {
      const knownCoordinator = currentSnapshot.coordinatorNpub?.trim() ?? "";
      if (knownCoordinator) {
        return currentSnapshot;
      }
      const localInvite = findBestLocalInvite(localVoterNpub);
      if (!localInvite?.coordinatorNpub?.trim()) {
        return currentSnapshot;
      }
    }
    const fallbackInvite = findBestLocalInvite(localVoterNpub);
    const bootstrapNpub = fallbackInvite?.invitedNpub?.trim() || localVoterNpub;
    const next = runtime.bootstrapWithLocalIdentity({
      invitedNpub: bootstrapNpub,
      coordinatorNpub: fallbackInvite?.coordinatorNpub ?? undefined,
      invite: fallbackInvite,
      allowInviteRecipientMismatch: Boolean(fallbackInvite && bootstrapNpub !== (fallbackInvite.invitedNpub ?? "").trim()),
      allowInviteMissing: options?.allowInviteMissing ?? Boolean(latestAnnouncedQuestionnaireId || electionId.trim()),
    });
    setSignedInNpub(next.invitedNpub);
    void loadPendingInvites({
      voterNpub: next.invitedNpub,
      allowRelayFetch: Boolean(options?.allowRelayInviteFetch),
    }).then((invites) => {
      setPendingInvites(invites);
      const preferredInvite = invites.find((invite) => invite.electionId === next.electionId)
        ?? (latestAnnouncedQuestionnaireId ? invites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) : null)
        ?? invites.at(-1)
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
    const targetElectionId = electionId.trim() || inviteContext.electionId?.trim() || latestAnnouncedQuestionnaireId.trim();
    if (!targetElectionId) {
      return null;
    }

    let definition = readCachedQuestionnaireDefinition(targetElectionId);
    try {
      const latest = latestDefinitionFromEntries(await fetchQuestionnaireDefinitions({
        questionnaireId: targetElectionId,
        limit: 20,
      }));
      if (latest) {
        definition = latest;
      }
    } catch {
      // The cached public definition is enough when a fresh relay read fails.
    }

    if (!definition) {
      return null;
    }
    cacheDefinitionForVoting(definition);
    return buildInviteFromPublicDefinition(definition, voterNpub);
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
    const preferredInvite = invites.find((invite) => invite.electionId === electionId) ?? invites[0] ?? null;
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
        const preferredInvite = publicQuestionnaireInvite ?? invites[0] ?? null;
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
        const next = await voterRuntime.loginWithSigner(preferredInvite);
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

      const next = await runtime.loginWithSigner(inviteContext.invite ?? publicQuestionnaireInvite);
      setSignedInNpub(next.invitedNpub);
      const invites = publicQuestionnaireInvite
        ? []
        : await loadPendingInvites({ voterNpub: next.invitedNpub, allowRelayFetch: true });
      setPendingInvites(invites);
      const preferredInvite = publicQuestionnaireInvite ?? invites[0] ?? null;
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

      let next;
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
      .map((question) => answerToOptionA(question, answers[question.questionId]))
      .filter((value): value is QuestionnaireAnswer => Boolean(value));
    runtime.updateDraftResponses(next);
    setRefreshNonce((value) => value + 1);
  }

  async function requestBallot() {
    if (!runtime) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true });
      const wasAlreadyWaiting = Boolean(runtime.getSnapshot()?.blindRequestSent && !runtime.getSnapshot()?.credentialReady);
      await runtime.requestBlindBallot({ forceResend: true });
      if (snapshot?.electionId && snapshot?.invitedNpub) {
        const requestKey = `${snapshot.electionId}:${snapshot.invitedNpub}`;
        autoRequestSentForRef.current[requestKey] = true;
      }
      setActiveInvite(null);
      setStatus(wasAlreadyWaiting
        ? "Blind ballot request resent. Waiting for coordinator issuance."
        : "Blind ballot request sent. Waiting for coordinator issuance."
      );
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Request failed.");
    }
  }

  function refreshStatus() {
    if (!runtime) {
      return;
    }
    try {
      ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true });
      runtime.refreshIssuanceAndAcceptance();
      setRefreshNonce((value) => value + 1);
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
    window.location.href = url.toString();
  }

  useEffect(() => {
    if (!runtime || !snapshot || !snapshot.loginVerified) {
      return;
    }
    if (snapshot.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
      return;
    }
    const hasInviteContext = Boolean(
      snapshot.inviteMessage
      || activeInvite
      || inviteContext.electionId === snapshot.electionId
      || latestAnnouncedQuestionnaireId === snapshot.electionId
      || pendingInvites.some((invite) => invite.electionId === snapshot.electionId),
    );
    if (!hasInviteContext) {
      return;
    }
    const key = snapshot.electionId + ":" + snapshot.invitedNpub;
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
        setActiveInvite(null);
        setStatus("Blind ballot request sent. Waiting for coordinator issuance.");
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
  }, [activeInvite, latestAnnouncedQuestionnaireId, pendingInvites, runtime, snapshot]);

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
    const retry = () => {
      runtime.refreshIssuanceAndAcceptance();
      setRefreshNonce((value) => value + 1);
      const now = Date.now();
      const lastAttemptAt = requestRetryAtRef.current[key] ?? 0;
      if (now - lastAttemptAt < resendMs) {
        return;
      }
      requestRetryAtRef.current[key] = now;
      try {
        void runtime.requestBlindBallot({ minRetryMs: resendMs }).then(() => {
          runtime.refreshIssuanceAndAcceptance();
          setRefreshNonce((value) => value + 1);
        }).catch(() => undefined);
      } catch {
        // Retry is best-effort; explicit controls surface errors.
      }
    };
    const intervalId = window.setInterval(retry, pollMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [runtime, props.localVoterNsec, snapshot?.electionId, snapshot?.invitedNpub, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

  useEffect(() => {
    if (!runtime || !props.requestBlindBallotNonce || props.requestBlindBallotNonce <= 0) {
      return;
    }
    try {
      const current = ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true }) ?? runtime.getSnapshot();
      if (!current?.loginVerified) {
        setStatus("Open the Vote tab and login, then the blind-signature request will send automatically.");
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
        setActiveInvite(null);
        setStatus("Blind ballot request sent. Waiting for coordinator issuance.");
        setRefreshNonce((value) => value + 1);
      }).catch((error) => {
        setStatus(error instanceof Error ? error.message : "Could not send blind ballot request.");
      }).finally(() => {
        delete autoRequestInFlightForRef.current[requestKey];
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start blind ballot request.");
    }
  }, [props.requestBlindBallotNonce, runtime]);

  const canShowInviteForCurrentIdentity = (invite: ElectionInviteMessage) => {
    const signedIn = signedInNpub.trim();
    return !signedIn || invite.invitedNpub === signedIn || Boolean(props.localVoterNpub?.trim());
  };
  const visiblePendingInvites = snapshot?.loginVerified && snapshot.electionId === electionId.trim()
    ? []
    : pendingInvites.filter(canShowInviteForCurrentIdentity);
  const inviteDropdownOptions = useMemo(() => {
    const map = new Map<string, ElectionInviteMessage>();
    for (const invite of pendingInvites) {
      if (!canShowInviteForCurrentIdentity(invite)) {
        continue;
      }
      const key = `${invite.electionId}:${invite.coordinatorNpub}`;
      map.set(key, invite);
    }
    const currentInvite = snapshot?.inviteMessage ?? activeInvite ?? null;
    if (currentInvite) {
      const key = `${currentInvite.electionId}:${currentInvite.coordinatorNpub}`;
      map.set(key, currentInvite);
    }
    return [...map.values()];
  }, [activeInvite, pendingInvites, signedInNpub, props.localVoterNpub, snapshot?.inviteMessage]);

  useEffect(() => {
    if (!snapshot?.electionId?.trim()) {
      return;
    }
    const matched = inviteDropdownOptions.find((invite) => invite.electionId === snapshot.electionId);
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
  }, [inviteDropdownOptions, selectedInviteKey, snapshot?.electionId]);
  const waitingForCredential = Boolean(snapshot?.blindRequestSent && !snapshot?.credentialReady && !snapshot?.submission);
  const canRequestOrResendBallot = flags.canRequestBallot || waitingForCredential;

  const canSubmitNow = flags.canSubmitVote && questions.length > 0 && requiredQuestionIds.every((questionId) => {
    const value = answers[questionId];
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== undefined && value !== null && String(value).trim().length > 0;
  });
  const displayStatus = snapshot?.credentialReady && status === "Blind ballot request sent. Waiting for coordinator issuance."
    ? "Ballot credential ready."
    : status;
  const coordinatorNpub = snapshot?.coordinatorNpub?.trim()
    || activeInvite?.coordinatorNpub?.trim()
    || inviteDropdownOptions.find((invite) => invite.electionId === electionId.trim())?.coordinatorNpub?.trim()
    || "";
  const coordinatorLabel = coordinatorNpub ? deriveActorDisplayId(coordinatorNpub) : "Unknown";
  const requestStateText = snapshot?.blindRequestSent ? "Sent" : "Not sent";
  const credentialStateText = snapshot?.credentialReady
    ? "Received"
    : snapshot?.blindRequestSent
      ? "Waiting for coordinator"
      : "Not requested";
  const submissionStateText = snapshot?.submissionAccepted === true
    ? "Accepted"
    : snapshot?.submissionAccepted === false
      ? "Rejected"
      : snapshot?.submission
        ? "Waiting for coordinator"
        : "Not submitted";

  return (
    <div className='simple-voter-card simple-optiona-voter-page'>
      <div className='simple-questionnaire-header'>
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          {!snapshot?.loginVerified ? (
            <button type='button' className='simple-voter-secondary' onClick={() => void login()}>Login</button>
          ) : null}
        </div>
      </div>

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
      <h4 className='simple-voter-section-title'>{questionnaireDescription || questionnaireTitle}</h4>

      {questions.length === 0 ? (
        <p className='simple-voter-note'>
          {snapshot?.submissionAccepted === true
            ? "Response accepted. Questionnaire details are not loaded in this browser."
            : "Waiting for questions to be published."}
        </p>
      ) : (
        <div className='simple-questionnaire-voter-list'>
          {questions.map((question, index) => (
            <article key={question.questionId} className='simple-questionnaire-voter-card'>
              <p className='simple-questionnaire-voter-number'>Question {index + 1}</p>
              <h4 className='simple-questionnaire-voter-prompt'>{question.prompt || "Untitled question"}</h4>
              <p className='simple-questionnaire-voter-helper'>{question.required ? "Required" : "Optional"}</p>
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
              {question.type === "free_text" ? (
                <textarea
                  className='simple-voter-input simple-questionnaire-free-text'
                  rows={3}
                  maxLength={question.maxLength ?? 500}
                  value={typeof answers[question.questionId] === "string" ? (answers[question.questionId] as string) : ""}
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.questionId]: event.target.value }))}
                />
              ) : null}
            </article>
          ))}
        </div>
      )}

      <div className='simple-voter-action-row simple-voter-action-row-inline simple-optiona-voter-controls'>
        <button type='button' className='simple-voter-secondary' disabled={!canRequestOrResendBallot} onClick={requestBallot}>
          {waitingForCredential ? "Resend request" : "Request ballot"}
        </button>
        <button type='button' className='simple-voter-secondary' onClick={refreshStatus}>Refresh status</button>
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
          {snapshot?.submission ? "View results" : canSubmitNow ? "Submit response" : "Waiting for coordinator..."}
        </button>
      </div>
      {snapshot?.submission ? (
        <section className='simple-settings-card' aria-label='Submitted responder marker'>
          <h4 className='simple-voter-section-title'>Submitted responder marker</h4>
          <TokenFingerprint
            tokenId={snapshot.responseNpub ?? snapshot.submission.responseNpub ?? snapshot.submission.invitedNpub}
            label='Submitted responder marker'
            large
            showQr
            hideMetadata
          />
        </section>
      ) : null}
      <section className='simple-settings-card' aria-label='Ballot progress'>
        <h4 className='simple-voter-section-title'>Ballot progress</h4>
        <p className='simple-voter-note'>Coordinator: {coordinatorLabel}</p>
        {coordinatorNpub ? (
          <TokenFingerprint
            tokenId={coordinatorNpub}
            label='Coordinator marker'
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
          <p className='simple-voter-note'>Waiting for the coordinator to issue your ballot credential. This page checks automatically; the coordinator can press Process requests.</p>
        ) : null}
      </section>
      {displayStatus ? <p className='simple-voter-note'>{displayStatus}</p> : null}
      <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
    </div>
  );
}

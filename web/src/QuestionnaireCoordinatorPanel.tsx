import { useCallback, useEffect, useMemo, useState } from "react";
import { nip19, nip44, type NostrEvent } from "nostr-tools";
import { fetchQuestionnaireEventsWithFallback, getQuestionnaireReadRelays, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishQuestionnaireDefinition, publishQuestionnaireResultSummary, publishQuestionnaireState, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESPONSE_PRIVATE_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND, subscribeQuestionnaireEvents } from "./questionnaireNostr";
import { buildQuestionnaireResultSummary, deriveEffectiveQuestionnaireState, processQuestionnaireResponses, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireResultSummary, selectLatestQuestionnaireState, type QuestionnaireAcceptedResponse } from "./questionnaireRuntime";
import { buildSimpleNamespacedLocalStorageKey, loadSimpleActorState } from "./simpleLocalState";
import {
  validateQuestionnaireDefinition,
  type QuestionnaireDefinition,
  type QuestionnaireQuestion,
  type QuestionnaireResponseAnswer,
  type QuestionnaireResultSummary,
  type QuestionnaireStateValue,
} from "./questionnaireProtocol";
import type { QuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_PROTOCOL_VERSION_V2,
} from "./questionnaireProtocolConstants";
import SimpleQrPanel from "./SimpleQrPanel";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";
import { getSharedNostrPool } from "./sharedNostrPool";
import { storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { tryWriteClipboard } from "./clipboard";
import { fetchQuestionnaireBlindResponses } from "./questionnaireTransport";
import { evaluateQuestionnaireBlindAdmissions, fetchQuestionnaireSubmissionDecisions } from "./questionnaireTransport";
import { publishQuestionnaireBlindResponsePublicByCoordinator } from "./questionnaireResponsePublish";
import { decodeNsec } from "./nostrIdentity";

const DEFAULT_QUESTIONNAIRE_ID_PREFIX = "q";
const QUESTIONNAIRE_DRAFT_ID_STORAGE_KEY = "coordinator.questionnaire-draft-id.v1";
const IDENTITY_REFRESH_INTERVAL_MS = 10000;
const QUESTIONNAIRE_TIMER_FALLBACK_MINUTES = "60";
const QUESTIONNAIRE_TIMER_DISABLED_CLOSE_MINUTES = 5_256_000; // 10 years

function readDeploymentModeFromUrl() {
  if (typeof window === "undefined") {
    return "legacy";
  }
  return (new URLSearchParams(window.location.search).get("deployment") ?? "legacy")
    .trim()
    .toLowerCase();
}

type QuestionnairePublishDiagnostic = {
  attempted: boolean;
  succeeded: boolean;
  eventId: string | null;
  kind: number | null;
  tags: string[][];
  relayTargets: string[];
  relaySuccessCount: number;
};

type QuestionnaireCoordinatorPanelProps = {
  coordinatorNsec?: string | null;
  coordinatorNpub?: string | null;
  knownVoterCount?: number;
  optionAAcceptedCount?: number;
  optionAAcceptedResponses?: QuestionnaireAcceptedResponse[];
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
  view?: "build" | "responses" | "participants";
  onInviteParticipants?: () => void;
  onStatusChange?: (status: {
    questionnaireId: string;
    state: QuestionnaireStateValue | null;
    acceptedCount: number;
    rejectedCount: number;
    payloadMode: "Encrypted" | "Public";
  }) => void;
};

type QuestionnaireQuestionDraft = QuestionnaireQuestion;
type QuestionCardTypeLabel = "Yes / No" | "Multiple choice" | "Free text";

function questionTypeLabel(type: QuestionnaireQuestionDraft["type"]): QuestionCardTypeLabel {
  if (type === "multiple_choice") {
    return "Multiple choice";
  }
  if (type === "free_text") {
    return "Free text";
  }
  return "Yes / No";
}

function createYesNoQuestion(questionId: string, prompt = "", required = true): QuestionnaireQuestionDraft {
  return {
    questionId,
    type: "yes_no",
    prompt,
    required,
  };
}

function createMultipleChoiceQuestion(questionId: string, prompt = "", required = true): QuestionnaireQuestionDraft {
  return {
    questionId,
    type: "multiple_choice",
    prompt,
    required,
    multiSelect: false,
    options: [
      { optionId: "option_1", label: "Option 1" },
      { optionId: "option_2", label: "Option 2" },
    ],
  };
}

function createFreeTextQuestion(questionId: string, prompt = "", required = false): QuestionnaireQuestionDraft {
  return {
    questionId,
    type: "free_text",
    prompt,
    required,
    maxLength: 500,
  };
}

function clearQuestionDraft(question: QuestionnaireQuestionDraft): QuestionnaireQuestionDraft {
  if (question.type === "multiple_choice") {
    return createMultipleChoiceQuestion(question.questionId, "", true);
  }
  if (question.type === "free_text") {
    return createFreeTextQuestion(question.questionId, "", true);
  }
  return createYesNoQuestion(question.questionId, "", true);
}

function deriveNextQuestionId(current: QuestionnaireQuestionDraft[]) {
  let maxIndex = 0;
  for (const entry of current) {
    const match = /^q(\d+)$/.exec(entry.questionId.trim());
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > maxIndex) {
      maxIndex = parsed;
    }
  }
  return `q${maxIndex + 1}`;
}

function isQuestionDraftValid(question: QuestionnaireQuestionDraft): boolean {
  if (!question.prompt.trim()) {
    return false;
  }
  if (question.type === "multiple_choice") {
    if (question.options.length < 2) {
      return false;
    }
    return question.options.every((option) => option.label.trim().length > 0);
  }
  if (question.type === "free_text") {
    return Number.isFinite(question.maxLength) && question.maxLength > 0;
  }
  return true;
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function generateQuestionnaireId() {
  const randomPart = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random().toString(16).slice(2)}`)
    .replace(/-/g, "")
    .slice(0, 12);
  return `${DEFAULT_QUESTIONNAIRE_ID_PREFIX}_${randomPart}`;
}

function readStoredQuestionnaireDraftId() {
  if (typeof window === "undefined") {
    return generateQuestionnaireId();
  }
  const stored = window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_ID_STORAGE_KEY))?.trim() ?? "";
  return stored || generateQuestionnaireId();
}

const QUESTIONNAIRE_DRAFT_DATA_STORAGE_KEY = "coordinator.questionnaire-draft-data.v1";

type StoredQuestionnaireDraft = {
  questionnaireId: string;
  title: string;
  description: string;
  closeTimerEnabled: boolean;
  closeAfterMinutes: string;
  questions: QuestionnaireQuestionDraft[];
};

function normaliseStoredQuestions(input: unknown): QuestionnaireQuestionDraft[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [createYesNoQuestion("q1")];
  }
  const entries = input.filter((entry): entry is QuestionnaireQuestionDraft => (
    Boolean(entry)
    && typeof entry === "object"
    && typeof (entry as { questionId?: unknown }).questionId === "string"
    && typeof (entry as { type?: unknown }).type === "string"
    && typeof (entry as { prompt?: unknown }).prompt === "string"
  ));
  return entries.length > 0 ? entries : [createYesNoQuestion("q1")];
}

function readStoredQuestionnaireDraft(): StoredQuestionnaireDraft {
  const fallbackId = readStoredQuestionnaireDraftId();
  if (typeof window === "undefined") {
    return {
      questionnaireId: fallbackId,
      title: "",
      description: "",
      closeTimerEnabled: false,
      closeAfterMinutes: QUESTIONNAIRE_TIMER_FALLBACK_MINUTES,
      questions: [createYesNoQuestion("q1")],
    };
  }
  try {
    const raw = window.localStorage.getItem(buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_DATA_STORAGE_KEY));
    if (!raw) {
      return {
        questionnaireId: fallbackId,
        title: "",
        description: "",
        closeTimerEnabled: false,
        closeAfterMinutes: QUESTIONNAIRE_TIMER_FALLBACK_MINUTES,
        questions: [createYesNoQuestion("q1")],
      };
    }
    const parsed = JSON.parse(raw) as Partial<StoredQuestionnaireDraft>;
    return {
      questionnaireId: typeof parsed.questionnaireId === "string" && parsed.questionnaireId.trim()
        ? parsed.questionnaireId.trim()
        : fallbackId,
      title: typeof parsed.title === "string" ? parsed.title : "",
      description: typeof parsed.description === "string" ? parsed.description : "",
      closeTimerEnabled: parsed.closeTimerEnabled === true,
      closeAfterMinutes: typeof parsed.closeAfterMinutes === "string" && parsed.closeAfterMinutes.trim()
        ? parsed.closeAfterMinutes
        : QUESTIONNAIRE_TIMER_FALLBACK_MINUTES,
      questions: normaliseStoredQuestions(parsed.questions),
    };
  } catch {
    return {
      questionnaireId: fallbackId,
      title: "",
      description: "",
      closeTimerEnabled: false,
      closeAfterMinutes: QUESTIONNAIRE_TIMER_FALLBACK_MINUTES,
      questions: [createYesNoQuestion("q1")],
    };
  }
}

function formatUnixTimestamp(timestampSeconds?: number | null) {
  if (!timestampSeconds || !Number.isFinite(timestampSeconds)) {
    return "Not set";
  }
  return new Date(timestampSeconds * 1000).toLocaleString();
}

function formatQuestionnaireMetadataState(state: QuestionnaireStateValue | null, hasDefinition: boolean) {
  if (!hasDefinition || state === "draft") {
    return "Draft";
  }
  if (state === "open") {
    return "Open";
  }
  if (state === "closed") {
    return "Closed";
  }
  if (state === "results_published") {
    return "Counted";
  }
  return "Published";
}

function formatClosingClosedLabel(input: {
  latestDefinition: QuestionnaireDefinition | null;
  latestState: QuestionnaireStateValue | null;
  latestStateCreatedAt: number | null;
}) {
  if (!input.latestDefinition?.closeAt || !Number.isFinite(input.latestDefinition.closeAt)) {
    return "Not scheduled";
  }
  const scheduledCloseAtLabel = formatUnixTimestamp(input.latestDefinition.closeAt);
  if (input.latestState === "closed" || input.latestState === "results_published") {
    if (input.latestStateCreatedAt && Number.isFinite(input.latestStateCreatedAt)) {
      return formatUnixTimestamp(input.latestStateCreatedAt);
    }
    return scheduledCloseAtLabel;
  }
  const nowUnix = Math.floor(Date.now() / 1000);
  if (input.latestState === "open" && input.latestDefinition.closeAt <= nowUnix) {
    return `Past due (${scheduledCloseAtLabel})`;
  }
  return scheduledCloseAtLabel;
}

function downloadJsonFile(filename: string, payload: unknown) {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = window.URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

function percentageLabel(count: number, total: number) {
  if (total <= 0) {
    return "0%";
  }
  return `${Math.round((count / total) * 100)}%`;
}

function parseQuestionnaireIdFromResponseEvent(event: Pick<NostrEvent, "content" | "tags" | "kind">): string | null {
  const tagMatch = Array.isArray(event.tags)
    ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === "questionnaire-id" && typeof tag[1] === "string")
    : null;
  if (tagMatch?.[1]?.trim()) {
    return tagMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(event.content) as { questionnaireId?: string };
    return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
  } catch {
    return null;
  }
}

function toRejectedReasonFromDecision(reason: string) {
  if (reason === "questionnaire_closed") {
    return "questionnaire_closed" as const;
  }
  if (reason === "invalid_token_proof") {
    return "invalid_payload_shape" as const;
  }
  if (reason === "invalid_payload_shape") {
    return "invalid_payload_shape" as const;
  }
  if (reason === "duplicate_nullifier") {
    return "duplicate_response" as const;
  }
  return "invalid_payload_shape" as const;
}

function toHexPubkey(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "npub") {
      return decoded.data as string;
    }
  }
  return trimmed;
}

function decryptCoordinatorFreeText(input: {
  text: string;
  authorPubkey: string;
  coordinatorNsec: string;
}) {
  const trimmed = input.text.trim();
  if (!trimmed.startsWith("enc:nip44v2:")) {
    return trimmed;
  }
  const ciphertext = trimmed.slice("enc:nip44v2:".length);
  if (!ciphertext) {
    return "(encrypted text unavailable)";
  }
  const coordinatorSecretKey = decodeNsec(input.coordinatorNsec);
  if (!coordinatorSecretKey) {
    return "(encrypted text unavailable)";
  }
  try {
    const authorHex = toHexPubkey(input.authorPubkey);
    const conversationKey = nip44.v2.utils.getConversationKey(coordinatorSecretKey, authorHex);
    const plaintext = nip44.v2.decrypt(ciphertext, conversationKey);
    return plaintext.trim() || "(empty)";
  } catch {
    return "(encrypted text unavailable)";
  }
}

function buildDefinition(input: {
  questionnaireId: string;
  coordinatorPubkey: string;
  title: string;
  description: string;
  closeAfterMinutes?: number;
  questions: QuestionnaireQuestionDraft[];
  blindSigningPublicKey?: QuestionnaireBlindPublicKey | null;
}): QuestionnaireDefinition {
  const createdAt = nowUnix();
  const closeAfterMinutes = Number.isFinite(input.closeAfterMinutes)
    ? Math.max(1, Math.floor(input.closeAfterMinutes as number))
    : QUESTIONNAIRE_TIMER_DISABLED_CLOSE_MINUTES;
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    protocolVersion: QUESTIONNAIRE_PROTOCOL_VERSION_V2,
    flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: input.questionnaireId,
    title: input.title,
    description: input.description,
    createdAt,
    openAt: createdAt,
    closeAt: createdAt + (closeAfterMinutes * 60),
    coordinatorPubkey: input.coordinatorPubkey,
    coordinatorEncryptionPubkey: input.coordinatorPubkey,
    responseVisibility: "private",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    blindSigningPublicKey: input.blindSigningPublicKey ?? null,
    questions: input.questions,
  };
}

export default function QuestionnaireCoordinatorPanel(props: QuestionnaireCoordinatorPanelProps) {
  const deploymentMode = useMemo(() => readDeploymentModeFromUrl(), []);
  const isCourseFeedbackMode = deploymentMode === "course_feedback";
  const storedDraft = useMemo(() => readStoredQuestionnaireDraft(), []);
  const [questionnaireId, setQuestionnaireId] = useState(storedDraft.questionnaireId);
  const [title, setTitle] = useState(storedDraft.title);
  const [description, setDescription] = useState(storedDraft.description);
  const [closeTimerEnabled, setCloseTimerEnabled] = useState(storedDraft.closeTimerEnabled);
  const [closeAfterMinutes, setCloseAfterMinutes] = useState(storedDraft.closeAfterMinutes);
  const [questions, setQuestions] = useState<QuestionnaireQuestionDraft[]>(storedDraft.questions);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [coordinatorNsec, setCoordinatorNsec] = useState("");
  const [coordinatorNpub, setCoordinatorNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isCloseAndPublishInFlight, setIsCloseAndPublishInFlight] = useState(false);
  const [latestDefinition, setLatestDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [latestState, setLatestState] = useState<QuestionnaireStateValue | null>(null);
  const [latestStateCreatedAt, setLatestStateCreatedAt] = useState<number | null>(null);
  const [latestAcceptedCount, setLatestAcceptedCount] = useState(0);
  const [latestRejectedCount, setLatestRejectedCount] = useState(0);
  const [latestAcceptedResponses, setLatestAcceptedResponses] = useState<QuestionnaireAcceptedResponse[]>([]);
  const [lastResponseSeenEventId, setLastResponseSeenEventId] = useState<string | null>(null);
  const [lastResponseRejectReason, setLastResponseRejectReason] = useState<string | null>(null);
  const [latestResultAcceptedCount, setLatestResultAcceptedCount] = useState<number | null>(null);
  const [availableQuestionnaireIds, setAvailableQuestionnaireIds] = useState<string[]>([]);
  const [expandedTextQuestionIds, setExpandedTextQuestionIds] = useState<Record<string, boolean>>({});
  const [definitionEventCount, setDefinitionEventCount] = useState(0);
  const [stateEventCount, setStateEventCount] = useState(0);
  const [responseEventCount, setResponseEventCount] = useState(0);
  const [resultEventCount, setResultEventCount] = useState(0);
  const [definitionPublishDiagnostic, setDefinitionPublishDiagnostic] = useState<QuestionnairePublishDiagnostic>({
    attempted: false,
    succeeded: false,
    eventId: null,
    kind: null,
    tags: [],
    relayTargets: [],
    relaySuccessCount: 0,
  });
  const [definitionPublishStartedAt, setDefinitionPublishStartedAt] = useState<string | null>(null);
  const [definitionPublishSucceededAt, setDefinitionPublishSucceededAt] = useState<string | null>(null);
  const [statePublishDiagnostic, setStatePublishDiagnostic] = useState<QuestionnairePublishDiagnostic>({
    attempted: false,
    succeeded: false,
    eventId: null,
    kind: null,
    tags: [],
    relayTargets: [],
    relaySuccessCount: 0,
  });
  const [statePublishStartedAt, setStatePublishStartedAt] = useState<string | null>(null);
  const [statePublishSucceededAt, setStatePublishSucceededAt] = useState<string | null>(null);
  const [resultPublishDiagnostic, setResultPublishDiagnostic] = useState<QuestionnairePublishDiagnostic>({
    attempted: false,
    succeeded: false,
    eventId: null,
    kind: null,
    tags: [],
    relayTargets: [],
    relaySuccessCount: 0,
  });
  const [definitionReadDiagnostics, setDefinitionReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });
  const [stateReadDiagnostics, setStateReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });
  const [resultReadDiagnostics, setResultReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });
  const [responseReadDiagnostics, setResponseReadDiagnostics] = useState({
    mode: "filtered",
    filteredCount: 0,
    kindOnlyCount: 0,
  });

  useEffect(() => {
    const nextNsec = typeof props.coordinatorNsec === "string" ? props.coordinatorNsec.trim() : "";
    const nextNpub = typeof props.coordinatorNpub === "string" ? props.coordinatorNpub.trim() : "";
    if (nextNsec) {
      setCoordinatorNsec((current) => (current === nextNsec ? current : nextNsec));
    }
    if (nextNpub) {
      setCoordinatorNpub((current) => (current === nextNpub ? current : nextNpub));
    }
  }, [props.coordinatorNsec, props.coordinatorNpub]);

  useEffect(() => {
    let cancelled = false;
    const refreshIdentity = () => {
      if (coordinatorNsec.trim() && coordinatorNpub.trim()) {
        return;
      }
      void loadSimpleActorState("coordinator").then((state) => {
        if (cancelled || !state?.keypair) {
          return;
        }
        if (props.coordinatorNsec?.trim() && props.coordinatorNpub?.trim()) {
          return;
        }
        setCoordinatorNsec((current) => (current === state.keypair.nsec ? current : state.keypair.nsec));
        setCoordinatorNpub((current) => (current === state.keypair.npub ? current : state.keypair.npub));
      }).catch(() => undefined);
    };
    refreshIdentity();
    const intervalId = window.setInterval(refreshIdentity, IDENTITY_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [coordinatorNpub, coordinatorNsec, props.coordinatorNpub, props.coordinatorNsec]);

  const applyQuestionnaireSnapshot = useCallback((input: {
    definitionEvents: NostrEvent[];
    stateEvents: NostrEvent[];
    responseEvents: NostrEvent[];
    resultEvents: NostrEvent[];
    diagnostics?: {
      definition: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
      state: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
      response: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
      result: { mode: "filtered" | "kind_only_fallback"; filteredCount: number; kindOnlyCount: number };
    };
  }) => {
    if (input.diagnostics) {
      setDefinitionReadDiagnostics(input.diagnostics.definition);
      setStateReadDiagnostics(input.diagnostics.state);
      setResponseReadDiagnostics(input.diagnostics.response);
      setResultReadDiagnostics(input.diagnostics.result);
    }

    const definition = selectLatestQuestionnaireDefinition(input.definitionEvents);
    const state = selectLatestQuestionnaireState(input.stateEvents);
    const resultSummary = selectLatestQuestionnaireResultSummary(input.resultEvents);
    setDefinitionEventCount(input.definitionEvents.length);
    setStateEventCount(input.stateEvents.length);
    setResponseEventCount(input.responseEvents.length);
    setResultEventCount(input.resultEvents.length);
    const latestResponseEvent = [...input.responseEvents]
      .sort((left, right) => right.created_at - left.created_at)[0] ?? null;
    setLastResponseSeenEventId(latestResponseEvent?.id ?? null);

    setLatestDefinition(definition);
    setLatestStateCreatedAt(state?.createdAt ?? null);
    setLatestState(deriveEffectiveQuestionnaireState({
      definition,
      latestState: state,
    }));
    setLatestResultAcceptedCount(resultSummary?.acceptedResponseCount ?? null);

    if (definition && coordinatorNsec.trim()) {
      const processed = processQuestionnaireResponses({
        definition,
        responseEvents: input.responseEvents,
        coordinatorNsec,
      });
      setLatestAcceptedCount(processed.accepted.length);
      setLatestRejectedCount(processed.rejected.length);
      setLatestAcceptedResponses(processed.accepted);
      setLastResponseRejectReason(processed.rejected.at(-1)?.reason ?? null);
    } else {
      setLatestAcceptedCount(0);
      setLatestRejectedCount(0);
      setLatestAcceptedResponses([]);
      setLastResponseRejectReason(null);
    }
  }, [coordinatorNsec]);

  const refresh = useCallback(async () => {
    const id = questionnaireId.trim();
    if (!id) {
      return;
    }

    try {
      const [definitionFetch, stateFetch, responseFetch, resultFetch] = await Promise.all([
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_DEFINITION_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_STATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
          preferKindOnly: true,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
          parseQuestionnaireIdFromEvent: (event) => {
            try {
              const parsed = JSON.parse(event.content) as { questionnaireId?: string };
              return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
            } catch {
              return null;
            }
          },
        }),
      ]);
      applyQuestionnaireSnapshot({
        definitionEvents: definitionFetch.events,
        stateEvents: stateFetch.events,
        responseEvents: responseFetch.events,
        resultEvents: resultFetch.events,
        diagnostics: {
          definition: definitionFetch.diagnostics,
          state: stateFetch.diagnostics,
          response: responseFetch.diagnostics,
          result: resultFetch.diagnostics,
        },
      });
    } catch {
      setStatus("Questionnaire refresh failed.");
    }
  }, [applyQuestionnaireSnapshot, questionnaireId]);

  useEffect(() => {
    let cancelled = false;
    const loadQuestionnaireOptions = async () => {
      try {
        const relays = getQuestionnaireReadRelays();
        const pool = getSharedNostrPool();
        const events = await pool.querySync(relays, {
          kinds: [QUESTIONNAIRE_DEFINITION_KIND],
          limit: 400,
        });
        if (cancelled) {
          return;
        }

        const coordinatorFilter = coordinatorNpub.trim();
        const ids = new Set<string>();
        for (const event of events) {
          const parsed = parseQuestionnaireDefinitionEvent(event);
          if (!parsed) {
            continue;
          }
          if (coordinatorFilter && parsed.coordinatorPubkey !== coordinatorFilter) {
            continue;
          }
          if (parsed.questionnaireId.trim()) {
            ids.add(parsed.questionnaireId.trim());
          }
        }
        const selectedId = questionnaireId.trim();
        if (selectedId) {
          ids.add(selectedId);
        }
        setAvailableQuestionnaireIds([...ids].sort((left, right) => left.localeCompare(right)));
      } catch {
        const selectedId = questionnaireId.trim();
        setAvailableQuestionnaireIds(selectedId ? [selectedId] : []);
      }
    };
    void loadQuestionnaireOptions();
    return () => {
      cancelled = true;
    };
  }, [coordinatorNpub, questionnaireId]);

  useEffect(() => {
    const id = questionnaireId.trim();
    if (!id) {
      return undefined;
    }

    let cancelled = false;
    const definitionById = new Map<string, NostrEvent>();
    const stateById = new Map<string, NostrEvent>();
    const responseById = new Map<string, NostrEvent>();
    const resultById = new Map<string, NostrEvent>();
    const applyFromMaps = () => {
      if (cancelled) {
        return;
      }
      applyQuestionnaireSnapshot({
        definitionEvents: [...definitionById.values()],
        stateEvents: [...stateById.values()],
        responseEvents: [...responseById.values()],
        resultEvents: [...resultById.values()],
      });
    };

    const loadInitialBackfill = async () => {
      const [definitionFetch, stateFetch, responseFetch, resultFetch] = await Promise.all([
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_DEFINITION_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_STATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
          preferKindOnly: true,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
          parseQuestionnaireIdFromEvent: (event) => {
            try {
              const parsed = JSON.parse(event.content) as { questionnaireId?: string };
              return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
            } catch {
              return null;
            }
          },
        }),
      ]);
      if (cancelled) {
        return;
      }
      definitionById.clear();
      stateById.clear();
      responseById.clear();
      resultById.clear();
      for (const event of definitionFetch.events) {
        definitionById.set(event.id, event);
      }
      for (const event of stateFetch.events) {
        stateById.set(event.id, event);
      }
      for (const event of responseFetch.events) {
        responseById.set(event.id, event);
      }
      for (const event of resultFetch.events) {
        resultById.set(event.id, event);
      }
      applyQuestionnaireSnapshot({
        definitionEvents: definitionFetch.events,
        stateEvents: stateFetch.events,
        responseEvents: responseFetch.events,
        resultEvents: resultFetch.events,
        diagnostics: {
          definition: definitionFetch.diagnostics,
          state: stateFetch.diagnostics,
          response: responseFetch.diagnostics,
          result: resultFetch.diagnostics,
        },
      });
    };

    void loadInitialBackfill().catch(() => {
      if (!cancelled) {
        setStatus("Questionnaire refresh failed.");
      }
    });

    const unsubscribers = [
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_DEFINITION_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
        useQuestionnaireIdTagFilter: false,
        readRelayLimit: 8,
        onEvent: (event) => {
          definitionById.set(event.id, event);
          applyFromMaps();
        },
        onError: () => undefined,
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_STATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
        useQuestionnaireIdTagFilter: false,
        readRelayLimit: 8,
        onEvent: (event) => {
          stateById.set(event.id, event);
          applyFromMaps();
        },
        onError: () => undefined,
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
        parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
        useQuestionnaireIdTagFilter: false,
        readRelayLimit: 8,
        onEvent: (event) => {
          responseById.set(event.id, event);
          applyFromMaps();
        },
        onError: () => undefined,
      }),
      subscribeQuestionnaireEvents({
        questionnaireId: id,
        kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
        parseQuestionnaireIdFromEvent: (event) => {
          try {
            const parsed = JSON.parse(event.content) as { questionnaireId?: string };
            return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
          } catch {
            return null;
          }
        },
        onEvent: (event) => {
          resultById.set(event.id, event);
          applyFromMaps();
        },
        onError: () => undefined,
      }),
    ];

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [applyQuestionnaireSnapshot, questionnaireId]);

  useEffect(() => {
    const draftQuestionnaireId = questionnaireId.trim();
    const stagedQuestionnaireId = draftQuestionnaireId || null;
    const definitionPublishQuestionnaireIdTag = definitionPublishDiagnostic.tags.find((tag) => tag[0] === "questionnaire-id")?.[1] ?? null;
    const statePublishQuestionnaireIdTag = statePublishDiagnostic.tags.find((tag) => tag[0] === "questionnaire-id")?.[1] ?? null;
    const statePublishStateTag = statePublishDiagnostic.tags.find((tag) => tag[0] === "state")?.[1] ?? null;
    const idsForContinuity = [
      draftQuestionnaireId || null,
      stagedQuestionnaireId,
      definitionPublishQuestionnaireIdTag,
      statePublishQuestionnaireIdTag,
      latestDefinition?.questionnaireId ?? null,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const uniqueContinuityIds = [...new Set(idsForContinuity)];
    const owner = globalThis as typeof globalThis & {
      __questionnaireCoordinatorDebug?: unknown;
    };
    owner.__questionnaireCoordinatorDebug = {
      questionnaireId: draftQuestionnaireId,
      draftQuestionnaireId,
      stagedQuestionnaireId,
      definitionPublishQuestionnaireIdTag,
      statePublishQuestionnaireIdTag,
      statePublishStateTag,
      continuityIds: uniqueContinuityIds,
      questionnaireIdentityContinuityOk: uniqueContinuityIds.length <= 1,
      coordinatorNpubLoaded: Boolean(coordinatorNpub),
      latestState,
      latestAcceptedCount,
      latestRejectedCount,
      responseEventsSeen: responseEventCount,
      acceptedResponseCount: latestAcceptedCount,
      rejectedResponseCount: latestRejectedCount,
      lastResponseSeenEventId,
      lastResponseRejectReason,
      latestResultAcceptedCount,
      definitionEventCount,
      stateEventCount,
      responseEventCount,
      resultEventCount,
      definitionReadDiagnostics,
      stateReadDiagnostics,
      responseReadDiagnostics,
      resultReadDiagnostics,
      definitionPublishDiagnostic,
      definitionPublishStartedAt,
      definitionPublishSucceededAt,
      statePublishDiagnostic,
      statePublishStartedAt,
      statePublishSucceededAt,
      resultPublishDiagnostic,
      deploymentMode,
      courseFeedbackAcceptanceEnabled: isCourseFeedbackMode,
      legacyRoundGatingBypassed: isCourseFeedbackMode,
      responseAcceptedViaQuestionnairePlane: latestAcceptedCount > 0,
      responseRejectedBecauseLegacyRoundRequired:
        isCourseFeedbackMode && responseEventCount > 0 && latestAcceptedCount <= 0,
      latestDefinitionQuestionCount: latestDefinition?.questions.length ?? 0,
      latestDefinitionId: latestDefinition?.questionnaireId ?? null,
      localSummaryMatchesPublished: latestResultAcceptedCount === null
        ? null
        : latestResultAcceptedCount === latestAcceptedCount,
      hasDefinition: Boolean(latestDefinition),
      status,
    };
  }, [
    coordinatorNpub,
    deploymentMode,
    definitionEventCount,
    definitionPublishDiagnostic,
    definitionPublishStartedAt,
    definitionPublishSucceededAt,
    definitionReadDiagnostics,
    latestAcceptedCount,
    latestDefinition,
    latestRejectedCount,
    lastResponseSeenEventId,
    lastResponseRejectReason,
    latestResultAcceptedCount,
    latestState,
    questionnaireId,
    responseReadDiagnostics,
    resultReadDiagnostics,
    resultPublishDiagnostic,
    responseEventCount,
    statePublishDiagnostic,
    statePublishStartedAt,
    statePublishSucceededAt,
    stateReadDiagnostics,
    resultEventCount,
    stateEventCount,
    status,
    isCourseFeedbackMode,
  ]);

  useEffect(() => {
    props.onStatusChange?.({
      questionnaireId: questionnaireId.trim(),
      state: latestState,
      acceptedCount: latestAcceptedCount,
      rejectedCount: latestRejectedCount,
      payloadMode: "Encrypted",
    });
  }, [latestAcceptedCount, latestRejectedCount, latestState, props, questionnaireId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const nextId = questionnaireId.trim();
    if (!nextId) {
      return;
    }
    window.localStorage.setItem(buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_ID_STORAGE_KEY), nextId);
    const snapshot: StoredQuestionnaireDraft = {
      questionnaireId: nextId,
      title,
      description,
      closeTimerEnabled,
      closeAfterMinutes,
      questions,
    };
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_DATA_STORAGE_KEY),
      JSON.stringify(snapshot),
    );
  }, [closeAfterMinutes, closeTimerEnabled, description, questionnaireId, questions, title]);

  function updateQuestion(index: number, updater: (question: QuestionnaireQuestionDraft) => QuestionnaireQuestionDraft) {
    setQuestions((current) => current.map((entry, entryIndex) => (
      entryIndex === index ? updater(entry) : entry
    )));
  }

  function setQuestionType(index: number, type: QuestionnaireQuestionDraft["type"]) {
    updateQuestion(index, (entry) => {
      if (entry.type === type) {
        return entry;
      }
      const questionId = entry.questionId;
      const prompt = entry.prompt;
      const required = entry.required;
      if (type === "multiple_choice") {
        return createMultipleChoiceQuestion(questionId, prompt, required);
      }
      if (type === "free_text") {
        return createFreeTextQuestion(questionId, prompt, required);
      }
      return createYesNoQuestion(questionId, prompt, required);
    });
  }

  function addQuestionBelow(index: number) {
    setQuestions((current) => {
      const nextQuestion = createYesNoQuestion(deriveNextQuestionId(current));
      return [
        ...current.slice(0, index + 1),
        nextQuestion,
        ...current.slice(index + 1),
      ];
    });
  }

  function duplicateQuestion(index: number) {
    setQuestions((current) => {
      const source = current[index];
      if (!source) {
        return current;
      }
      const duplicateId = deriveNextQuestionId(current);
      const duplicated = {
        ...source,
        questionId: duplicateId,
      };
      return [...current.slice(0, index + 1), duplicated, ...current.slice(index + 1)];
    });
  }

  function moveQuestion(index: number, direction: -1 | 1) {
    setQuestions((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      const temp = next[index];
      next[index] = next[target];
      next[target] = temp;
      return next;
    });
  }

  function deleteQuestion(index: number) {
    setQuestions((current) => {
      if (current.length <= 1) {
        const existing = current[index] ?? current[0] ?? createYesNoQuestion("q1");
        return [clearQuestionDraft(existing)];
      }
      return current.filter((_, currentIndex) => currentIndex !== index);
    });
  }
  const builtDefinition = useMemo(() => {
    if (!coordinatorNpub.trim() || !questionnaireId.trim()) {
      return null;
    }
    let closeMinutes: number | undefined;
    if (closeTimerEnabled) {
      closeMinutes = Number.parseInt(closeAfterMinutes, 10);
      if (!Number.isFinite(closeMinutes) || closeMinutes <= 0) {
        return null;
      }
    }
    return buildDefinition({
      questionnaireId: questionnaireId.trim(),
      coordinatorPubkey: coordinatorNpub,
      title: title.trim(),
      description: description.trim(),
      closeAfterMinutes: closeMinutes,
      questions,
      blindSigningPublicKey: props.blindSigningPublicKey ?? null,
    });
  }, [closeAfterMinutes, closeTimerEnabled, coordinatorNpub, description, props.blindSigningPublicKey, questionnaireId, questions, title]);

  const inviteLink = useMemo(() => {
    const id = questionnaireId.trim();
    if (!id) {
      return "";
    }
    if (typeof window === "undefined") {
      return "";
    }
    try {
      const next = new URL("vote.html", window.location.href);
      next.searchParams.set("questionnaire", id);
      return next.toString();
    } catch {
      return "";
    }
  }, [questionnaireId]);

  const titleReady = title.trim().length > 0;
  const hasQuestion = questions.length > 0;
  const hasKnownVoter = (props.knownVoterCount ?? 0) > 0;
  const questionsValid = questions.length > 0 && questions.every((question) => isQuestionDraftValid(question));
  const publishPreconditionsReady = titleReady && hasQuestion && questionsValid;
  const publishValidation = useMemo(
    () => (builtDefinition ? validateQuestionnaireDefinition(builtDefinition) : null),
    [builtDefinition],
  );
  useEffect(() => {
    if (builtDefinition && publishValidation?.valid) {
      storeCachedQuestionnaireDefinition(builtDefinition);
    }
  }, [builtDefinition, publishValidation?.valid]);
  const canPublishDraft = Boolean(
    builtDefinition
    && coordinatorNsec.trim()
    && publishValidation?.valid
    && publishPreconditionsReady,
  );
  const canOpenQuestionnaire = latestState !== "open" && Boolean(latestDefinition) && coordinatorNsec.trim() && coordinatorNpub.trim();
  const canCloseQuestionnaire = latestState === "open" && Boolean(latestDefinition) && coordinatorNsec.trim() && coordinatorNpub.trim();
  const canPublishResults = Boolean(
    latestDefinition
    && coordinatorNsec.trim()
    && coordinatorNpub.trim()
    && (latestState === "closed" || latestState === "results_published"),
  );
  const publishedDefinition = Boolean(latestDefinition);
  const currentState: QuestionnaireStateValue = latestState ?? "draft";
  const acceptedResponsesForDisplay = useMemo(() => {
    const byKey = new Map<string, QuestionnaireAcceptedResponse>();
    for (const response of latestAcceptedResponses) {
      byKey.set(response.payload.responseId || response.eventId, response);
    }
    for (const response of props.optionAAcceptedResponses ?? []) {
      byKey.set(response.payload.responseId || response.eventId, response);
    }
    return [...byKey.values()].sort((left, right) => left.payload.submittedAt - right.payload.submittedAt);
  }, [latestAcceptedResponses, props.optionAAcceptedResponses]);
  const displayAcceptedCount = Math.max(acceptedResponsesForDisplay.length, props.optionAAcceptedCount ?? 0);
  const knownVoterCount = props.knownVoterCount ?? 0;
  const responseCompletionPercent = knownVoterCount > 0
    ? Math.round((displayAcceptedCount / knownVoterCount) * 100)
    : 0;
  const responseCompletionRatio = knownVoterCount > 0
    ? Math.min(100, Math.max(0, (displayAcceptedCount / knownVoterCount) * 100))
    : 0;
  const buildStateLabel = !publishedDefinition
    ? "Draft"
    : currentState === "results_published"
      ? "Counted"
      : currentState === "closed"
        ? "Ended"
        : currentState === "open"
          ? "Open"
          : "Draft";
  const checklistDescriptionAdded = description.trim().length > 0;
  const checklistNotPublished = !publishedDefinition;
  const metadataStateLabel = formatQuestionnaireMetadataState(latestState, Boolean(latestDefinition));
  const metadataClosingClosedLabel = formatClosingClosedLabel({
    latestDefinition,
    latestState,
    latestStateCreatedAt,
  });
  const selectedQuestionnaireOptions = availableQuestionnaireIds.length > 0
    ? availableQuestionnaireIds
    : (questionnaireId.trim() ? [questionnaireId.trim()] : []);
  const questionResultCards = useMemo(() => {
    if (!latestDefinition) {
      return [];
    }
    const acceptedTotal = acceptedResponsesForDisplay.length;
    return latestDefinition.questions.map((question, index) => {
      if (question.type === "yes_no") {
        let yesCount = 0;
        let noCount = 0;
        for (const response of acceptedResponsesForDisplay) {
          const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
          if (answer?.answerType === "yes_no") {
            if (answer.value) {
              yesCount += 1;
            } else {
              noCount += 1;
            }
          }
        }
        return {
          questionId: question.questionId,
          index,
          prompt: question.prompt,
          typeBadge: "Yes / No",
          kind: "yes_no" as const,
          yesCount,
          noCount,
          acceptedTotal,
        };
      }
      if (question.type === "multiple_choice") {
        const optionCounts = new Map(question.options.map((option) => [option.optionId, 0]));
        for (const response of acceptedResponsesForDisplay) {
          const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
          if (answer?.answerType === "multiple_choice") {
            for (const optionId of answer.selectedOptionIds) {
              optionCounts.set(optionId, (optionCounts.get(optionId) ?? 0) + 1);
            }
          }
        }
        return {
          questionId: question.questionId,
          index,
          prompt: question.prompt,
          typeBadge: "Multiple choice",
          kind: "multiple_choice" as const,
          rows: question.options.map((option) => ({
            optionId: option.optionId,
            label: option.label,
            count: optionCounts.get(option.optionId) ?? 0,
          })),
          acceptedTotal,
        };
      }

      const responses = acceptedResponsesForDisplay
        .map((entry) => {
          const answer = entry.payload.answers.find((answerEntry) => answerEntry.questionId === question.questionId);
          if (answer?.answerType !== "free_text") {
            return null;
          }
          const text = decryptCoordinatorFreeText({
            text: answer.text,
            authorPubkey: entry.authorPubkey,
            coordinatorNsec,
          });
          if (!text.trim()) {
            return null;
          }
          return {
            responderId: deriveActorDisplayId(entry.authorPubkey),
            text,
            submittedAt: entry.payload.submittedAt,
          };
        })
        .filter((entry): entry is { responderId: string; text: string; submittedAt: number } => Boolean(entry));

      return {
        questionId: question.questionId,
        index,
        prompt: question.prompt,
        typeBadge: "Text",
        kind: "text" as const,
        responses,
      };
    });
  }, [acceptedResponsesForDisplay, coordinatorNsec, latestDefinition]);
  const responders = useMemo(() => (
    acceptedResponsesForDisplay
      .map((response) => ({
        markerToken: response.authorPubkey,
        responderId: deriveActorDisplayId(response.authorPubkey),
        submittedAt: response.payload.submittedAt,
      }))
      .sort((left, right) => left.responderId.localeCompare(right.responderId))
  ), [acceptedResponsesForDisplay]);
  const closeAndPublishButtonDisabled = (currentState === "open"
    ? !canCloseQuestionnaire
    : !canPublishResults) || displayAcceptedCount <= 0 || isCloseAndPublishInFlight;
  const hasIncompleteResponses = knownVoterCount > 0 && displayAcceptedCount < knownVoterCount;
  const canExportResults = currentState === "results_published" && Boolean(latestDefinition);
  const publishStatusText = useMemo(() => {
    if (isCloseAndPublishInFlight) {
      return currentState === "open" ? "Closing and publishing..." : "Publishing...";
    }
    if (status === "Computing and publishing questionnaire results...") {
      return "Publishing...";
    }
    if (status === "Result publishing failed." || status === "Result publish partially failed.") {
      return "Publish failed";
    }
    if (latestState === "results_published") {
      if (latestResultAcceptedCount !== null && latestResultAcceptedCount !== displayAcceptedCount) {
        return "Summary needs update";
      }
      return "Already published";
    }
    if (displayAcceptedCount > 0 && latestState === "open") {
      return "Ready to close and publish";
    }
    if (displayAcceptedCount <= 0) {
      return "Nothing to publish yet";
    }
    if (canPublishResults) {
      return "Ready to publish";
    }
    return "Nothing to publish yet";
  }, [canPublishResults, currentState, displayAcceptedCount, isCloseAndPublishInFlight, latestResultAcceptedCount, latestState, status]);

  function exportResults() {
    const id = questionnaireId.trim();
    if (!id || !latestDefinition || currentState !== "results_published") {
      setStatus("Results export is available once results are published.");
      return;
    }
    const exportedAt = nowUnix();
    const payload = {
      schemaVersion: 1,
      exportType: "questionnaire_results_export",
      exportedAt,
      questionnaire: {
        questionnaireId: id,
        title: latestDefinition.title,
        description: latestDefinition.description,
        state: currentState,
        coordinatorNpub,
      },
      counts: {
        accepted: displayAcceptedCount,
        rejected: latestRejectedCount,
        publishedAccepted: latestResultAcceptedCount,
      },
      summary: {
        questionResultCards,
        responders,
      },
      acceptedResponses: acceptedResponsesForDisplay.map((response) => ({
        eventId: response.eventId,
        authorPubkey: response.authorPubkey,
        submittedAt: response.payload.submittedAt,
        responseId: response.payload.responseId,
        answers: response.payload.answers,
      })),
    };
    downloadJsonFile(`questionnaire-results-${id}.json`, payload);
    setStatus(`Exported results for ${id}.`);
  }

  async function publishDefinition() {
    if (!coordinatorNsec.trim() || !builtDefinition) {
      setStatus("Coordinator key or questionnaire definition is missing.");
      return;
    }

    if (!publishPreconditionsReady) {
      setStatus("Publish draft is blocked until all readiness checks are complete.");
      return;
    }

    if (!builtDefinition.blindSigningPublicKey) {
      setStatus("Blind-signing key is still initialising. Try publishing again in a moment.");
      return;
    }

    const validation = validateQuestionnaireDefinition(builtDefinition);
    if (!validation.valid) {
      setStatus(`Definition invalid: ${validation.errors[0] ?? "unknown_error"}.`);
      return;
    }

    setStatus("Publishing questionnaire definition...");
    setDefinitionPublishStartedAt(new Date().toISOString());
    setDefinitionPublishSucceededAt(null);
    setDefinitionPublishDiagnostic((current) => ({
      ...current,
      attempted: true,
      succeeded: false,
      eventId: null,
      kind: null,
      tags: [],
      relayTargets: [],
      relaySuccessCount: 0,
    }));
    try {
      const result = await publishQuestionnaireDefinition({
        coordinatorNsec,
        definition: builtDefinition,
      });
      setDefinitionPublishDiagnostic({
        attempted: true,
        succeeded: result.successes > 0,
        eventId: result.eventId,
        kind: result.event.kind,
        tags: result.event.tags,
        relayTargets: result.relayResults.map((entry) => entry.relay),
        relaySuccessCount: result.successes,
      });
      if (result.successes > 0) {
        storeCachedQuestionnaireDefinition(builtDefinition);
        setDefinitionPublishSucceededAt(new Date().toISOString());
        setStatus(`Questionnaire draft published (${result.successes}/${result.relayResults.length} relays).`);
        await publishState("open");
      } else {
        setStatus("Questionnaire draft publish failed.");
        await refresh();
      }
    } catch {
      setDefinitionPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus("Questionnaire draft publish failed.");
    }
  }

  async function publishState(state: QuestionnaireStateValue) {
    const id = questionnaireId.trim();
    if (!coordinatorNsec.trim() || !coordinatorNpub.trim() || !id) {
      setStatus("Coordinator key or questionnaire id is missing.");
      return false;
    }

    setStatus(`Publishing questionnaire state (${state})...`);
    setStatePublishStartedAt(new Date().toISOString());
    setStatePublishSucceededAt(null);
    setStatePublishDiagnostic((current) => ({
      ...current,
      attempted: true,
      succeeded: false,
      eventId: null,
      kind: null,
      tags: [],
      relayTargets: [],
      relaySuccessCount: 0,
    }));
    try {
      const result = await publishQuestionnaireState({
        coordinatorNsec,
        stateEvent: {
          schemaVersion: 1,
          eventType: "questionnaire_state",
          questionnaireId: id,
          state,
          createdAt: nowUnix(),
          coordinatorPubkey: coordinatorNpub,
        },
      });
      setStatePublishDiagnostic({
        attempted: true,
        succeeded: result.successes > 0,
        eventId: result.eventId,
        kind: result.event.kind,
        tags: result.event.tags,
        relayTargets: result.relayResults.map((entry) => entry.relay),
        relaySuccessCount: result.successes,
      });
      if (result.successes > 0) {
        setStatePublishSucceededAt(new Date().toISOString());
      }
      setStatus(
        result.successes > 0
          ? `Questionnaire state '${state}' published (${result.successes}/${result.relayResults.length} relays).`
          : `Questionnaire state '${state}' publish failed.`,
      );
      await refresh();
      return result.successes > 0;
    } catch {
      setStatePublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus(`Questionnaire state '${state}' publish failed.`);
      return false;
    }
  }

  async function publishResults() {
    if (!latestDefinition || !coordinatorNsec.trim() || !coordinatorNpub.trim()) {
      setStatus("Load the questionnaire definition before publishing results.");
      return;
    }

    setStatus("Computing and publishing questionnaire results...");
    setResultPublishDiagnostic((current) => ({
      ...current,
      attempted: true,
      succeeded: false,
      eventId: null,
      kind: null,
      tags: [],
      relayTargets: [],
      relaySuccessCount: 0,
    }));
    try {
      const usePublicSubmissionFlow = latestDefinition.flowMode === QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1;
      let summary: QuestionnaireResultSummary;
      let responsePublishSuccessCount = 0;
      let responsePublishAttemptCount = 0;

      if (usePublicSubmissionFlow) {
        const [publicResponses, decisionEntries] = await Promise.all([
          fetchQuestionnaireBlindResponses({
            questionnaireId: latestDefinition.questionnaireId,
            limit: 500,
          }).catch(() => []),
          fetchQuestionnaireSubmissionDecisions({
            questionnaireId: latestDefinition.questionnaireId,
            limit: 500,
          }).catch(() => []),
        ]);
        const admissions = evaluateQuestionnaireBlindAdmissions({
          entries: publicResponses,
          decisionEntries,
        });
        const acceptedResponses = admissions.accepted.map((entry) => ({
          eventId: entry.event.id,
          authorPubkey: entry.response.authorPubkey,
          envelope: {
            schemaVersion: 1 as const,
            eventType: "questionnaire_response_private" as const,
            questionnaireId: entry.response.questionnaireId,
            responseId: entry.response.responseId,
            createdAt: entry.response.submittedAt ?? entry.event.created_at ?? nowUnix(),
            authorPubkey: entry.response.authorPubkey,
            ciphertextScheme: "nip44v2" as const,
            ciphertextRecipient: coordinatorNpub,
            ciphertext: "",
            payloadHash: entry.response.payloadHash ?? entry.response.tokenProof.tokenCommitment,
          },
          payload: {
            schemaVersion: 1 as const,
            kind: "questionnaire_response_payload" as const,
            questionnaireId: entry.response.questionnaireId,
            responseId: entry.response.responseId,
            submittedAt: entry.response.submittedAt ?? entry.event.created_at ?? nowUnix(),
            answers: entry.response.answers ?? ([] as QuestionnaireResponseAnswer[]),
          },
        }));
        const rejectedResponses = admissions.rejected.map((entry) => ({
          eventId: entry.event.id,
          authorPubkey: entry.response.authorPubkey,
          responseId: entry.response.responseId,
          reason: toRejectedReasonFromDecision(entry.rejectionReason ?? "invalid_payload_shape"),
          detail: entry.rejectionReason ?? undefined,
        }));
        summary = buildQuestionnaireResultSummary({
          definition: latestDefinition,
          coordinatorPubkey: coordinatorNpub,
          acceptedResponses,
          rejectedResponses,
        });
        summary.acceptedNullifierCount = new Set(
          admissions.accepted
            .map((entry) => entry.response.tokenNullifier.trim())
            .filter((value) => value.length > 0),
        ).size;
        summary.publishedResponseRefs = admissions.decisions
          .map((entry) => ({
            responseId: entry.response.responseId,
            authorPubkey: entry.response.authorPubkey,
            submittedAt: entry.response.submittedAt ?? entry.event.created_at ?? nowUnix(),
            accepted: entry.accepted,
            answers: entry.response.answers,
          }))
          .filter((entry) => entry.responseId.trim().length > 0);
      } else {
        const responseEvents = (await fetchQuestionnaireEventsWithFallback({
          questionnaireId: latestDefinition.questionnaireId,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
          preferKindOnly: true,
          readRelayLimit: 8,
        })).events;
        const processed = processQuestionnaireResponses({
          definition: latestDefinition,
          responseEvents,
          coordinatorNsec,
        });
        const acceptedByKey = new Map<string, QuestionnaireAcceptedResponse>();
        // Prefer the coordinator's merged local accepted state, then fill any gaps from relay-fetched envelopes.
        for (const response of acceptedResponsesForDisplay) {
          acceptedByKey.set(response.payload.responseId || response.eventId, response);
        }
        for (const response of processed.accepted) {
          const key = response.payload.responseId || response.eventId;
          if (!acceptedByKey.has(key)) {
            acceptedByKey.set(key, response);
          }
        }
        const acceptedResponses = [...acceptedByKey.values()];
        const existingPublicResponses = await fetchQuestionnaireBlindResponses({
          questionnaireId: latestDefinition.questionnaireId,
          limit: 500,
        }).catch(() => []);
        const existingResponseIds = new Set(
          existingPublicResponses
            .map((entry) => entry.response.responseId.trim())
            .filter((value) => value.length > 0),
        );
        const responsesToPublish = acceptedResponses.filter((response) => {
          const responseId = (response.payload.responseId || response.eventId).trim();
          return responseId.length > 0 && !existingResponseIds.has(responseId);
        });
        responsePublishAttemptCount = responsesToPublish.length;

        for (const response of responsesToPublish) {
          const responseId = (response.payload.responseId || response.eventId).trim();
          const tokenCommitment = response.envelope.payloadHash.trim() || response.eventId;
          const tokenNullifier = `legacy_${tokenCommitment}`;
          const publishedResponse = await publishQuestionnaireBlindResponsePublicByCoordinator({
            coordinatorNsec,
            questionnaireId: latestDefinition.questionnaireId,
            responseId,
            submittedAt: response.payload.submittedAt,
            authorPubkey: response.authorPubkey,
            tokenNullifier,
            tokenCommitment,
            answers: response.payload.answers,
            questionnaireDefinitionEventId: null,
          });
          if (publishedResponse.successes > 0) {
            responsePublishSuccessCount += 1;
          }
        }

        summary = buildQuestionnaireResultSummary({
          definition: latestDefinition,
          coordinatorPubkey: coordinatorNpub,
          acceptedResponses,
          rejectedResponses: processed.rejected,
        });
        summary.publishedResponseRefs = acceptedResponses
          .map((response) => {
            const responseId = (response.payload.responseId || response.eventId).trim();
            if (!responseId) {
              return null;
            }
            return {
              responseId,
              authorPubkey: response.authorPubkey,
              submittedAt: response.payload.submittedAt,
              accepted: true,
              answers: response.payload.answers,
            };
          })
          .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
      }

      const publishSummary = await publishQuestionnaireResultSummary({
        coordinatorNsec,
        resultSummary: summary,
      });
      const publishStateResult = await publishQuestionnaireState({
        coordinatorNsec,
        stateEvent: {
          schemaVersion: 1,
          eventType: "questionnaire_state",
          questionnaireId: latestDefinition.questionnaireId,
          state: "results_published",
          createdAt: nowUnix(),
          coordinatorPubkey: coordinatorNpub,
        },
      });

      if (publishSummary.successes > 0 && publishStateResult.successes > 0) {
        setResultPublishDiagnostic({
          attempted: true,
          succeeded: true,
          eventId: publishSummary.eventId,
          kind: publishSummary.event.kind,
          tags: publishSummary.event.tags,
          relayTargets: publishSummary.relayResults.map((entry) => entry.relay),
          relaySuccessCount: publishSummary.successes,
        });
        setStatus(
          usePublicSubmissionFlow
            ? `Results published. Accepted=${summary.acceptedResponseCount}, Rejected=${summary.rejectedResponseCount}, Public responses=${summary.publishedResponseRefs?.length ?? 0}.`
            : `Results published. Accepted=${summary.acceptedResponseCount}, Rejected=${summary.rejectedResponseCount}, Public responses=${responsePublishSuccessCount}/${responsePublishAttemptCount}.`,
        );
      } else {
        setResultPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
        setStatus("Result publish partially failed.");
      }
      await refresh();
    } catch {
      setResultPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus("Result publishing failed.");
    }
  }

  async function closeAndPublishResults() {
    if (isCloseAndPublishInFlight) {
      return;
    }
    if (!latestDefinition) {
      setStatus("Load the questionnaire definition before publishing results.");
      return;
    }
    setIsCloseAndPublishInFlight(true);
    try {
      if (hasIncompleteResponses && typeof window !== "undefined") {
        const confirmed = window.confirm(
          `Only ${displayAcceptedCount} of ${knownVoterCount} responses have been received. Close and publish results anyway?`,
        );
        if (!confirmed) {
          return;
        }
      }
      if (currentState === "open") {
        const closed = await publishState("closed");
        if (!closed) {
          setStatus("Could not close questionnaire, so results were not published.");
          return;
        }
      }
      await publishResults();
    } finally {
      setIsCloseAndPublishInFlight(false);
    }
  }

  const view = props.view ?? "build";

  if (view === "participants") {
    return (
      <div className='simple-voter-card simple-questionnaire-panel'>
        <h3 className='simple-voter-question'>Publish questionnaire</h3>
        <p className='simple-voter-note'>Questionnaire ID: {questionnaireId.trim() || "Not set"}</p>
        <p className='simple-voter-note'>State: {buildStateLabel}</p>
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
          {!publishedDefinition ? (
            <button type='button' className='simple-voter-primary' disabled={!canPublishDraft} onClick={() => void publishDefinition()}>
              Publish Questionnaire
            </button>
          ) : currentState === "open" || currentState === "closed" ? (
            <button type='button' className='simple-voter-primary' disabled={closeAndPublishButtonDisabled} onClick={() => void closeAndPublishResults()}>
              {currentState === "open" ? "Close + Publish Results" : "Publish Results"}
            </button>
          ) : currentState === "results_published" ? (
            <button type='button' className='simple-voter-primary' disabled>
              Counted
            </button>
          ) : (
            <button type='button' className='simple-voter-primary' disabled={!canOpenQuestionnaire} onClick={() => void publishState("open")}>
              Open Questionnaire
            </button>
          )}
          <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
            Refresh
          </button>
          {canExportResults ? (
            <button type='button' className='simple-voter-secondary' onClick={exportResults}>
              Export results
            </button>
          ) : null}
        </div>
        {publishValidation && !publishValidation.valid ? (
          <p className='simple-voter-note'>Validation: {publishValidation.errors[0] ?? "unknown_error"}.</p>
        ) : null}
        {status ? <p className='simple-voter-note'>{status}</p> : null}
      </div>
    );
  }

  if (view === "responses") {
    return (
      <div className='simple-voter-card simple-questionnaire-panel'>
        <h3 className='simple-voter-question'>Responses</h3>
        <p className='simple-voter-note'>View submitted responses and publish the response summary.</p>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Questionnaire</h4>
          <label className='simple-voter-label' htmlFor='questionnaire-select'>Questionnaire</label>
          <select
            id='questionnaire-select'
            className='simple-voter-input'
            value={questionnaireId}
            onChange={(event) => setQuestionnaireId(event.target.value)}
          >
            {selectedQuestionnaireOptions.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Metadata</h4>
          <dl className='simple-questionnaire-metadata-grid'>
            <div className='simple-questionnaire-metadata-item'>
              <dt>Questionnaire ID</dt>
              <dd>{questionnaireId.trim() || "Not set"}</dd>
            </div>
            <div className='simple-questionnaire-metadata-item'>
              <dt>State</dt>
              <dd>{metadataStateLabel}</dd>
            </div>
            <div className='simple-questionnaire-metadata-item'>
              <dt>Opened</dt>
              <dd>{latestDefinition?.openAt ? formatUnixTimestamp(latestDefinition.openAt) : "Not opened"}</dd>
            </div>
            <div className='simple-questionnaire-metadata-item'>
              <dt>Closing / Closed</dt>
              <dd>{metadataClosingClosedLabel}</dd>
            </div>
          </dl>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Responses</h4>
          <div className='simple-questionnaire-summary-card' aria-live='polite'>
            <p className='simple-questionnaire-summary-label'>Responses</p>
            <p className='simple-questionnaire-summary-value'>{displayAcceptedCount} / {knownVoterCount}</p>
            <p className='simple-questionnaire-summary-label'>Completion</p>
            <p className='simple-questionnaire-summary-value'>{responseCompletionPercent}%</p>
            <div className='simple-questionnaire-progress' aria-hidden='true'>
              <span style={{ width: `${responseCompletionRatio}%` }} />
            </div>
          </div>
        </div>

        <div className='simple-questionnaire-responses-section'>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <button
              type='button'
              className='simple-voter-primary'
              disabled={closeAndPublishButtonDisabled}
              onClick={() => void closeAndPublishResults()}
            >
              {currentState === "open" ? "Close + publish results" : "Publish results"}
            </button>
            {canExportResults ? (
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={exportResults}
              >
                Export results
              </button>
            ) : null}
            <button type='button' className='simple-voter-secondary' onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
          <p className='simple-voter-note'>{publishStatusText}</p>
          {currentState === "results_published" ? (
            <p className='simple-voter-note'>
              Published results are available in this coordinator&apos;s <strong>Results</strong> tab and in <strong>Auditor</strong> under the selected coordinator filters.
            </p>
          ) : null}
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Question results</h4>
          {questionResultCards.length === 0 ? (
            <p className='simple-voter-empty'>No question results yet.</p>
          ) : (
            <div className='simple-questionnaire-question-list'>
              {questionResultCards.map((card) => (
                <article key={card.questionId} className='simple-questionnaire-question-card'>
                  <div className='simple-questionnaire-question-head'>
                    <p className='simple-voter-question'>Question {card.index + 1}</p>
                    <span className='simple-questionnaire-question-type'>{card.typeBadge}</span>
                  </div>
                  <p className='simple-voter-note'>{card.prompt || "Untitled question"}</p>
                  {card.kind === "yes_no" ? (
                    <div className='simple-questionnaire-results-stack'>
                      <div className='simple-questionnaire-progress' aria-hidden='true'>
                        <span style={{ width: percentageLabel(card.yesCount, card.acceptedTotal) }} />
                      </div>
                      <p className='simple-voter-note'>
                        Yes - {percentageLabel(card.yesCount, card.acceptedTotal)} ({card.yesCount})
                      </p>
                      <p className='simple-voter-note'>
                        No - {percentageLabel(card.noCount, card.acceptedTotal)} ({card.noCount})
                      </p>
                    </div>
                  ) : null}
                  {card.kind === "multiple_choice" ? (
                    <div className='simple-questionnaire-results-stack'>
                      {card.rows.map((row) => (
                        <div key={row.optionId} className='simple-questionnaire-option-row'>
                          <div className='simple-questionnaire-progress' aria-hidden='true'>
                            <span style={{ width: percentageLabel(row.count, card.acceptedTotal) }} />
                          </div>
                          <p className='simple-voter-note'>
                            {row.label} - {percentageLabel(row.count, card.acceptedTotal)} ({row.count})
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {card.kind === "text" ? (
                    <div className='simple-questionnaire-results-stack'>
                      <p className='simple-voter-note'>Responses: {card.responses.length}</p>
                      <button
                        type='button'
                        className='simple-voter-secondary'
                        onClick={() => setExpandedTextQuestionIds((current) => ({
                          ...current,
                          [card.questionId]: !current[card.questionId],
                        }))}
                      >
                        {expandedTextQuestionIds[card.questionId] ? "Hide responses" : "Show responses"}
                      </button>
                      {expandedTextQuestionIds[card.questionId] ? (
                        card.responses.length > 0 ? (
                          <ul className='simple-voter-list'>
                            {card.responses.map((entry, index) => (
                              <li key={`${card.questionId}-${index}`} className='simple-voter-list-item'>
                                {entry.text}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className='simple-voter-empty'>No text responses yet.</p>
                        )
                      ) : null}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </div>

        <div className='simple-questionnaire-responses-section'>
          <h4 className='simple-voter-section-title'>Responders</h4>
          {responders.length === 0 ? (
            <p className='simple-voter-empty'>No responders yet. Responders will appear here after submitting a response.</p>
          ) : (
            <ul className='simple-questionnaire-responder-list'>
              {responders.map((responder) => (
                <li key={responder.markerToken} className='simple-questionnaire-responder-row'>
                  <TokenFingerprint tokenId={responder.markerToken} compact showQr={false} hideMetadata />
                  <p className='simple-voter-question'>{responder.responderId}</p>
                  <p className='simple-voter-note'>Submitted {formatUnixTimestamp(responder.submittedAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>

        {status ? <p className='simple-voter-note'>{status}</p> : null}
      </div>
    );
  }

  return (
    <div className='simple-voter-card simple-questionnaire-panel'>
      <div className='simple-questionnaire-header'>
        <div>
          <h3 className='simple-voter-question'>{title.trim() || "Untitled questionnaire"}</h3>
          <p className='simple-voter-note'>State: {buildStateLabel}</p>
        </div>
      </div>

      <h4 className='simple-voter-section-title'>Questionnaire identity</h4>
      <label className='simple-voter-label' htmlFor='questionnaire-id'>Questionnaire ID</label>
      <input
        id='questionnaire-id'
        className='simple-voter-input'
        value={questionnaireId}
        onChange={(event) => setQuestionnaireId(event.target.value)}
      />
      <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
        <button type='button' className='simple-voter-secondary' onClick={() => setQuestionnaireId(generateQuestionnaireId())}>
          Generate ID
        </button>
        <button type='button' className='simple-voter-secondary' onClick={() => void tryWriteClipboard(questionnaireId)}>
          Copy ID
        </button>
        <button type='button' className='simple-voter-secondary' onClick={() => setShowInviteQr((current) => !current)}>
          Show QR
        </button>
      </div>
      {showInviteQr && questionnaireId.trim() ? (
        <SimpleQrPanel
          value={inviteLink || questionnaireId.trim()}
          title='Voter link'
          copyLabel='Copy link'
          downloadLabel='Download QR'
          downloadFilename='questionnaire-voter-link-qr.png'
        />
      ) : null}
      <label className='simple-voter-label' htmlFor='questionnaire-title'>Name</label>
      <input
        id='questionnaire-title'
        className='simple-voter-input'
        value={title}
        placeholder='Enter questionnaire name'
        onChange={(event) => setTitle(event.target.value)}
      />
      <label className='simple-voter-label' htmlFor='questionnaire-description'>Description</label>
      <textarea
        id='questionnaire-description'
        className='simple-voter-input'
        rows={3}
        value={description}
        placeholder='Describe what this questionnaire is for'
        onChange={(event) => setDescription(event.target.value)}
      />
      <div className='simple-questionnaire-close-timer-row'>
        <label className='simple-questionnaire-close-timer-toggle' htmlFor='questionnaire-close-timer-enabled'>
          <input
            id='questionnaire-close-timer-enabled'
            type='checkbox'
            checked={closeTimerEnabled}
            onChange={(event) => setCloseTimerEnabled(event.target.checked)}
          />
          <span>Enable close timer</span>
        </label>
        <div className='simple-questionnaire-close-timer-minutes'>
          <label className='simple-voter-label simple-voter-label-tight' htmlFor='questionnaire-close-minutes'>
            Close after (minutes)
          </label>
          <input
            id='questionnaire-close-minutes'
            className='simple-voter-input simple-voter-input-inline'
            value={closeAfterMinutes}
            disabled={!closeTimerEnabled}
            onChange={(event) => setCloseAfterMinutes(event.target.value)}
          />
        </div>
      </div>

      <h4 className='simple-voter-section-title'>Questions</h4>
      <div className='simple-questionnaire-question-list'>
        {questions.map((question, index) => {
          const canMoveUp = index > 0;
          const canMoveDown = index < questions.length - 1;

          return (
            <div key={`${question.questionId}-${index}`} className='simple-questionnaire-question-card'>
              <div className='simple-questionnaire-question-head'>
                <p className='simple-voter-question'>Question {index + 1}</p>
                <span className='simple-questionnaire-question-type'>{questionTypeLabel(question.type)}</span>
              </div>
              <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                <button
                  type='button'
                  className={`simple-voter-secondary${question.type === "yes_no" ? " is-active" : ""}`}
                  onClick={() => setQuestionType(index, "yes_no")}
                >
                  Yes/No
                </button>
                <button
                  type='button'
                  className={`simple-voter-secondary${question.type === "multiple_choice" ? " is-active" : ""}`}
                  onClick={() => setQuestionType(index, "multiple_choice")}
                >
                  Multiple choice
                </button>
                <button
                  type='button'
                  className={`simple-voter-secondary${question.type === "free_text" ? " is-active" : ""}`}
                  onClick={() => setQuestionType(index, "free_text")}
                >
                  Free text
                </button>
              </div>
              <input
                id={`question-prompt-${index}`}
                className='simple-voter-input'
                value={question.prompt}
                placeholder='Question prompt'
                onChange={(event) => {
                  const nextValue = event.target.value;
                  updateQuestion(index, (entry) => ({ ...entry, prompt: nextValue }));
                }}
              />
              <label className='simple-voter-note'>
                <input
                  type='checkbox'
                  checked={question.required}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    updateQuestion(index, (entry) => ({ ...entry, required: checked }));
                  }}
                />
                {" "}
                Required
              </label>
              {question.type === "multiple_choice" ? (
                <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
                  <p className='simple-voter-note'>Options</p>
                  {question.options.map((option, optionIndex) => (
                    <input
                      key={`${question.questionId}-option-${optionIndex}`}
                      className='simple-voter-input'
                      value={option.label}
                      onChange={(event) => {
                        const nextLabel = event.target.value;
                        updateQuestion(index, (entry) => {
                          if (entry.type !== "multiple_choice") {
                            return entry;
                          }
                          return {
                            ...entry,
                            options: entry.options.map((entryOption, entryOptionIndex) => (
                              entryOptionIndex === optionIndex ? { ...entryOption, label: nextLabel } : entryOption
                            )),
                          };
                        });
                      }}
                    />
                  ))}
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => {
                      updateQuestion(index, (entry) => {
                        if (entry.type !== "multiple_choice") {
                          return entry;
                        }
                        const nextIndex = entry.options.length + 1;
                        return {
                          ...entry,
                          options: [...entry.options, { optionId: `option_${nextIndex}`, label: `Option ${nextIndex}` }],
                        };
                      });
                    }}
                  >
                    Add option
                  </button>
                  <label className='simple-voter-note'>
                    <input
                      type='checkbox'
                      checked={question.multiSelect}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        updateQuestion(index, (entry) => (
                          entry.type === "multiple_choice"
                            ? { ...entry, multiSelect: checked }
                            : entry
                        ));
                      }}
                    />
                    {" "}
                    Allow multiple selections
                  </label>
                </div>
              ) : null}
              {question.type === "free_text" ? (
                <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
                  <label className='simple-voter-label' htmlFor={`question-max-${index}`}>Maximum length</label>
                  <input
                    id={`question-max-${index}`}
                    className='simple-voter-input'
                    value={String(question.maxLength)}
                    onChange={(event) => {
                      const parsed = Number.parseInt(event.target.value, 10);
                      updateQuestion(index, (entry) => (
                        entry.type === "free_text"
                          ? { ...entry, maxLength: Number.isFinite(parsed) && parsed > 0 ? parsed : entry.maxLength }
                          : entry
                      ));
                    }}
                  />
                </div>
              ) : null}
              <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                <button type='button' className='simple-voter-secondary' onClick={() => duplicateQuestion(index)}>Duplicate</button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => moveQuestion(index, -1)}
                  disabled={!canMoveUp}
                >
                  Move up
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => moveQuestion(index, 1)}
                  disabled={!canMoveDown}
                >
                  Move down
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => addQuestionBelow(index)}
                >
                  +
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => deleteQuestion(index)}
                >
                  -
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <h4 className='simple-voter-section-title'>Readiness checklist</h4>
      <ul className='simple-vote-status-list'>
        <li className={titleReady ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{titleReady ? "✓" : "•"}</span> Title added</li>
        <li className={checklistDescriptionAdded ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{checklistDescriptionAdded ? "✓" : "•"}</span> Description added</li>
        <li className={hasQuestion ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{hasQuestion ? "✓" : "•"}</span> At least one question added</li>
        <li className={questionsValid ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{questionsValid ? "✓" : "•"}</span> All question prompts and options complete</li>
        <li className={checklistNotPublished ? "is-pending" : "is-complete"}><span className='simple-vote-status-icon' aria-hidden='true'>{checklistNotPublished ? "•" : "✓"}</span> Questionnaire not yet published</li>
      </ul>

      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <button type='button' className='simple-voter-secondary' onClick={() => setShowPreview((current) => !current)}>
          Preview questionnaire
        </button>
        <button type='button' className='simple-voter-secondary' disabled={!inviteLink} onClick={() => {
          if (!inviteLink) {
            return;
          }
          void tryWriteClipboard(inviteLink);
        }}
        >
          Copy invite link
        </button>
        {!publishedDefinition ? (
          <button type='button' className='simple-voter-primary' disabled={!canPublishDraft} onClick={() => void publishDefinition()}>
            Publish Questionnaire
          </button>
        ) : currentState === "open" || currentState === "closed" ? (
          <button type='button' className='simple-voter-primary' disabled={closeAndPublishButtonDisabled} onClick={() => void closeAndPublishResults()}>
            {currentState === "open" ? "Close + Publish Results" : "Publish Results"}
          </button>
        ) : currentState === "results_published" ? (
          <button type='button' className='simple-voter-primary' disabled>
            Counted
          </button>
        ) : (
          <button type='button' className='simple-voter-primary' disabled={!canOpenQuestionnaire} onClick={() => void publishState("open")}>
            Open Questionnaire
          </button>
        )}
        {publishedDefinition ? (
          <button
            type='button'
            className='simple-voter-secondary'
            onClick={props.onInviteParticipants}
            disabled={!props.onInviteParticipants}
          >
            Invite participants
          </button>
        ) : null}
      </div>
      {!coordinatorNsec.trim() ? (
        <p className='simple-voter-note'>Coordinator key is not loaded yet.</p>
      ) : null}
      {publishValidation && !publishValidation.valid ? (
        <p className='simple-voter-note'>Validation: {publishValidation.errors[0] ?? "unknown_error"}.</p>
      ) : null}
      {showPreview ? (
        <div className='simple-questionnaire-preview'>
          <h4 className='simple-voter-section-title'>Draft preview</h4>
          <pre>{JSON.stringify(builtDefinition, null, 2)}</pre>
        </div>
      ) : null}
      {status ? <p className='simple-voter-note'>{status}</p> : null}
      {!latestDefinition ? <p className='simple-voter-note'>No questionnaire definition found for this id yet.</p> : null}
    </div>
  );
}

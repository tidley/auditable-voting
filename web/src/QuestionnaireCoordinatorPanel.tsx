import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPublicKey, generateSecretKey, nip19, nip44, type NostrEvent } from "nostr-tools";
import { fetchQuestionnaireEventsWithFallback, getQuestionnaireReadRelays, parseQuestionnaireDefinitionEvent, parseQuestionnaireStateEvent, publishQuestionnaireDefinition, publishQuestionnaireParticipantCount, publishQuestionnaireResultSummary, publishQuestionnaireState, queryQuestionnaireEvents, QUESTIONNAIRE_DEFINITION_KIND, QUESTIONNAIRE_RESPONSE_PRIVATE_KIND, QUESTIONNAIRE_RESULT_SUMMARY_KIND, QUESTIONNAIRE_STATE_KIND, subscribeQuestionnaireEventKinds } from "./questionnaireNostr";
import { buildQuestionnaireResultSummary, deriveEffectiveQuestionnaireState, parseQuestionnaireResultSummaryEvent, processQuestionnaireResponses, selectLatestQuestionnaireDefinition, selectLatestQuestionnaireResultSummary, selectLatestQuestionnaireState, type QuestionnaireAcceptedResponse } from "./questionnaireRuntime";
import { buildSimpleNamespacedLocalStorageKey, loadSimpleActorState } from "./simpleLocalState";
import {
  calculateRankQuestionScores,
  normaliseRankedOptionIds,
  validateQuestionnaireDefinition,
  type QuestionnaireDefinition,
  type QuestionnairePublishedResponseRef,
  type QuestionnaireQuestion,
  type QuestionnaireResponseAnswer,
  type QuestionnaireResultSummary,
  type QuestionnaireStateEvent,
  type QuestionnaireStateValue,
} from "./questionnaireProtocol";
import { toQuestionnaireBlindPublicKey, type QuestionnaireBlindPublicKey } from "./questionnaireBlindSignature";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_PROTOCOL_VERSION_V2,
} from "./questionnaireProtocolConstants";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import { deriveActorDisplayId } from "./actorDisplay";
import QuestionnaireResultsDashboard, { type QuestionnaireResultsDashboardResponseDetail } from "./QuestionnaireResultsDashboard";
import { readCachedQuestionnaireDefinition, storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { tryWriteClipboard } from "./clipboard";
import { fetchQuestionnaireBlindResponses } from "./questionnaireTransport";
import { evaluateQuestionnaireBlindAdmissions, fetchQuestionnaireSubmissionDecisions, verifyQuestionnaireBlindResponseProofs } from "./questionnaireTransport";
import {
  decryptQuestionnaireBlindResponseAnswers,
  parseQuestionnaireBlindResponseEvent,
  parseQuestionnaireSubmissionDecisionEvent,
  publishQuestionnaireBlindResponsePublicByCoordinator,
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
  type QuestionnaireBlindResponseEvent,
  type QuestionnaireSubmissionDecisionEvent,
} from "./questionnaireResponsePublish";
import { decodeNsec } from "./nostrIdentity";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";
import {
  normalizeQuestionnaireRelays,
  questionnaireRelaysForMetadata,
} from "./questionnaireRelays";
import { createSignerService } from "./services/signerService";
import { listElectionSummaries, loadCoordinatorState, loadElectionSummary, upsertElectionSummary } from "./questionnaireOptionAStorage";
import {
  type WorkerElectionConfigSnapshot,
  fetchOptionAWorkerStatusDmsWithNsec,
  publishOptionAWorkerDelegationDm,
  publishOptionAWorkerElectionConfigDm,
  publishOptionAWorkerDelegationRevocationDm,
} from "./questionnaireOptionABlindDm";
import {
  createWorkerDelegationCertificate,
  createWorkerDelegationRevocation,
  loadStoredWorkerDelegation,
  normaliseWorkerNpub,
  publishWorkerDelegationCertificate,
  publishWorkerDelegationRevocation,
  upsertStoredWorkerDelegation,
  type WorkerCapability,
  type WorkerDelegationCertificate,
  type WorkerDelegationState,
  type WorkerStatusSnapshot,
} from "./questionnaireWorkerDelegation";
import { buildIssueBlindTokensWorkerRouting } from "./questionnaireWorkerRouting";

const DEFAULT_QUESTIONNAIRE_ID_PREFIX = "q";
const QUESTIONNAIRE_DRAFT_ID_STORAGE_KEY = "coordinator.questionnaire-draft-id.v1";
export const QUESTIONNAIRE_ID_RESET_EVENT = "auditable-voting:coordinator-questionnaire-id-reset";
const IDENTITY_REFRESH_INTERVAL_MS = 10000;
const QUESTIONNAIRE_TIMER_FALLBACK_MINUTES = "60";
const QUESTIONNAIRE_TIMER_DISABLED_CLOSE_MINUTES = 5_256_000; // 10 years
const QUESTIONNAIRE_TIMER_DISABLED_CLOSE_SECONDS = QUESTIONNAIRE_TIMER_DISABLED_CLOSE_MINUTES * 60;
const BLIND_SIGNING_KEY_RELOAD_STATUS = "Blind-signing key is still initialising in this tab. Please wait a moment, then try publishing again.";

type CloseTimerUnit = "minutes" | "hours" | "days" | "weeks";

const CLOSE_TIMER_UNITS: Array<{ value: CloseTimerUnit; label: string; minutes: number }> = [
  { value: "minutes", label: "minutes", minutes: 1 },
  { value: "hours", label: "hours", minutes: 60 },
  { value: "days", label: "days", minutes: 60 * 24 },
  { value: "weeks", label: "weeks", minutes: 60 * 24 * 7 },
];

function normaliseCloseTimerUnit(value: unknown): CloseTimerUnit {
  return CLOSE_TIMER_UNITS.some((entry) => entry.value === value)
    ? value as CloseTimerUnit
    : "minutes";
}

function closeTimerUnitToMinutes(unit: CloseTimerUnit) {
  return CLOSE_TIMER_UNITS.find((entry) => entry.value === unit)?.minutes ?? 1;
}

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
  questionnaireRelaysInput?: string;
  onQuestionnaireRelaysInputChange?: (value: string) => void;
  onConfigureQuestionnaireRelays?: () => void;
  onConfigureWorker?: () => void;
  newRoundMode?: boolean;
  canApplyAdmissionsOnPublish?: boolean;
  onAfterPublishQuestionnaire?: (questionnaireId: string) => void | Promise<void>;
  onStatusChange?: (status: {
    questionnaireId: string;
    state: QuestionnaireStateValue | null;
    acceptedCount: number;
    rejectedCount: number;
    payloadMode: "Encrypted" | "Public";
  }) => void;
};

type QuestionnaireBlindResponseEntry = {
  event: NostrEvent;
  response: QuestionnaireBlindResponseEvent;
};

type QuestionnaireSubmissionDecisionEntry = {
  event: NostrEvent;
  decision: QuestionnaireSubmissionDecisionEvent;
};

type QuestionnaireQuestionDraft = QuestionnaireQuestion;

const QUESTION_TYPE_OPTIONS: Array<{ value: QuestionnaireQuestionDraft["type"]; label: string }> = [
  { value: "yes_no", label: "Yes / No" },
  { value: "multiple_choice", label: "Multiple choice" },
  { value: "rank", label: "Ranked" },
  { value: "free_text", label: "Free text" },
];

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

function createRankQuestion(questionId: string, prompt = "", minimumRanked = 0): QuestionnaireQuestionDraft {
  return {
    questionId,
    type: "rank",
    prompt,
    required: minimumRanked > 0,
    minimumRanked,
    options: [
      { optionId: "option_1", label: "Option 1" },
      { optionId: "option_2", label: "Option 2" },
    ],
  };
}

function createNextOption(options: Array<{ optionId: string }>) {
  const usedOptionIds = new Set(options.map((option) => option.optionId));
  let nextIndex = options.length + 1;
  while (usedOptionIds.has(`option_${nextIndex}`)) {
    nextIndex += 1;
  }
  return { optionId: `option_${nextIndex}`, label: `Option ${nextIndex}` };
}

function createFreeTextQuestion(questionId: string, prompt = "", required = false): QuestionnaireQuestionDraft {
  return {
    questionId,
    type: "free_text",
    prompt,
    required,
    maxLength: 500,
    encryptResponses: false,
  };
}

function clearQuestionDraft(question: QuestionnaireQuestionDraft): QuestionnaireQuestionDraft {
  if (question.type === "multiple_choice") {
    return createMultipleChoiceQuestion(question.questionId, "", true);
  }
  if (question.type === "rank") {
    return createRankQuestion(question.questionId, "", 0);
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
  if (question.type === "rank") {
    if (question.options.length < 2) {
      return false;
    }
    if (!Number.isFinite(question.minimumRanked) || question.minimumRanked < 0 || question.minimumRanked > question.options.length) {
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

function normaliseCoordinatorIdentifier(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("npub1")) {
    return trimmed;
  }
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    try {
      return nip19.npubEncode(trimmed.toLowerCase());
    } catch {
      return "";
    }
  }
  return trimmed;
}

function questionnaireDefinitionEventIsSignedByCoordinator(
  event: Pick<NostrEvent, "pubkey">,
  definition: QuestionnaireDefinition,
  coordinatorNpub: string,
) {
  const authorNpub = normaliseCoordinatorIdentifier(event.pubkey);
  const declaredCoordinatorNpub = normaliseCoordinatorIdentifier(definition.coordinatorPubkey);
  const expectedCoordinatorNpub = normaliseCoordinatorIdentifier(coordinatorNpub);
  if (!authorNpub || !declaredCoordinatorNpub || authorNpub !== declaredCoordinatorNpub) {
    return false;
  }
  return !expectedCoordinatorNpub || authorNpub === expectedCoordinatorNpub;
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
  closeTimerUnit?: CloseTimerUnit;
  questionnaireRelays?: string;
  questions: QuestionnaireQuestionDraft[];
  delegationMode?: "browser_only" | "delegated_worker";
  delegatedWorkerNpub?: string;
  delegatedWorkerControlRelays?: string;
  delegatedWorkerExpiryEnabled?: boolean;
  delegatedWorkerExpiryMinutes?: string;
  delegatedWorkerCapabilities?: WorkerCapability[];
};

const DEFAULT_WORKER_CONTROL_RELAYS = normalizeRelaysRust([
  "wss://relay.nostr.net",
  "wss://nos.lol",
  "wss://relay.nostr.info",
]);
const DEPRECATED_WORKER_RELAY_REPLACEMENTS = new Map<string, string>([
  [`wss://strfry.${"bitsbytom.com"}`, "wss://relay.nostr.net"],
  [`wss://nip17.${"tomdwyer.uk"}`, "wss://nos.lol"],
  [`wss://offchain.${"pub"}`, "wss://relay.nostr.net"],
  ["wss://relay.nostr.band", "wss://relay.nostr.info"],
  ["wss://relay.damus.io", "wss://relay.nostr.net"],
  ["wss://relay.primal.net", "wss://nos.lol"],
  ["wss://nostr.mom", "wss://relay.nostr.net"],
  ["wss://nostr.wine", "wss://nos.lol"],
  ["wss://eden.nostr.land", "wss://relay.nostr.net"],
  ["wss://purplepag.es", "wss://relay.nostr.info"],
  ["wss://nip17.com", "wss://relay.nostr.info"],
  ["wss://relay.layer.systems", "wss://relay.nostr.net"],
  ["wss://nostr.bond", "wss://nos.lol"],
  ["wss://auth.nostr1.com", "wss://relay.nostr.info"],
  ["wss://inbox.nostr.wine", "wss://relay.nostr.info"],
  ["wss://nostr-pub.wellorder.net", "wss://relay.nostr.net"],
  ["wss://relay.0xchat.com", "wss://nos.lol"],
]);
const CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES: WorkerCapability[] = [
  "issue_blind_tokens",
  "verify_public_submissions",
  "publish_submission_decisions",
  "close_questionnaire",
  "publish_result_summary",
];

function normaliseStoredQuestions(input: unknown): QuestionnaireQuestionDraft[] {
  if (!Array.isArray(input) || input.length === 0) {
    return [createYesNoQuestion("q1")];
  }
  const entries = input
    .filter((entry): entry is QuestionnaireQuestionDraft => (
      Boolean(entry)
      && typeof entry === "object"
      && typeof (entry as { questionId?: unknown }).questionId === "string"
      && typeof (entry as { type?: unknown }).type === "string"
      && typeof (entry as { prompt?: unknown }).prompt === "string"
    ))
    .map((entry) => {
      if (entry.type === "free_text") {
        return {
          ...entry,
          maxLength: Number.isFinite(entry.maxLength) && entry.maxLength > 0
            ? Math.floor(entry.maxLength)
            : 500,
          encryptResponses: Boolean(entry.encryptResponses),
        };
      }
      if (entry.type !== "rank") {
        return entry;
      }
      if (!Array.isArray(entry.options) || entry.options.length < 2) {
        return createRankQuestion(entry.questionId, entry.prompt, 0);
      }
      const minimumRanked = Number.isFinite(entry.minimumRanked)
        ? Math.min(entry.options.length, Math.max(0, Math.floor(entry.minimumRanked)))
        : 0;
      return {
        ...entry,
        minimumRanked,
        required: minimumRanked > 0,
      };
    });
  return entries.length > 0 ? entries : [createYesNoQuestion("q1")];
}

function sanitizeWorkerRelays(value: string) {
  const relays = value
    .split(/[\n,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => DEPRECATED_WORKER_RELAY_REPLACEMENTS.get(entry) ?? entry);
  return normalizeRelaysRust(relays);
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
      closeTimerUnit: normaliseCloseTimerUnit(parsed.closeTimerUnit),
      questionnaireRelays: typeof parsed.questionnaireRelays === "string" ? parsed.questionnaireRelays : "",
      questions: normaliseStoredQuestions(parsed.questions),
      delegationMode: parsed.delegationMode === "delegated_worker" ? "delegated_worker" : "browser_only",
      delegatedWorkerNpub: typeof parsed.delegatedWorkerNpub === "string" ? parsed.delegatedWorkerNpub : "",
      delegatedWorkerControlRelays: typeof parsed.delegatedWorkerControlRelays === "string" ? parsed.delegatedWorkerControlRelays : "",
      delegatedWorkerExpiryEnabled: parsed.delegatedWorkerExpiryEnabled === true,
      delegatedWorkerExpiryMinutes: typeof parsed.delegatedWorkerExpiryMinutes === "string" ? parsed.delegatedWorkerExpiryMinutes : "",
      delegatedWorkerCapabilities: Array.isArray(parsed.delegatedWorkerCapabilities)
        ? parsed.delegatedWorkerCapabilities.filter((entry): entry is WorkerCapability => (
          CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES.includes(entry as WorkerCapability)
        ))
        : [...CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES],
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

export function readStoredQuestionnaireRelayInput() {
  return readStoredQuestionnaireDraft().questionnaireRelays ?? "";
}

export function writeStoredQuestionnaireRelayInput(value: string) {
  if (typeof window === "undefined") {
    return;
  }
  const snapshot: StoredQuestionnaireDraft = {
    ...readStoredQuestionnaireDraft(),
    questionnaireRelays: value,
  };
  window.localStorage.setItem(
    buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_DATA_STORAGE_KEY),
    JSON.stringify(snapshot),
  );
}

export function resetStoredQuestionnaireDraftId() {
  const nextId = generateQuestionnaireId();
  if (typeof window === "undefined") {
    return nextId;
  }
  window.localStorage.setItem(buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_ID_STORAGE_KEY), nextId);
  const snapshot: StoredQuestionnaireDraft = {
    ...readStoredQuestionnaireDraft(),
    questionnaireId: nextId,
  };
  window.localStorage.setItem(
    buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_DATA_STORAGE_KEY),
    JSON.stringify(snapshot),
  );
  return nextId;
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
  const isClosed = input.latestState === "closed" || input.latestState === "results_published";
  if (!input.latestDefinition?.closeAt || !Number.isFinite(input.latestDefinition.closeAt)) {
    return isClosed ? "Closed" : "No closing time";
  }
  const closeDurationSeconds = definitionCloseDurationSeconds(input.latestDefinition);
  const hasScheduledClose = closeDurationSeconds < QUESTIONNAIRE_TIMER_DISABLED_CLOSE_SECONDS;
  if (!hasScheduledClose) {
    if (!isClosed) {
      return "No closing time";
    }
    if (input.latestStateCreatedAt && Number.isFinite(input.latestStateCreatedAt)) {
      return formatUnixTimestamp(input.latestStateCreatedAt);
    }
    return "Closed";
  }
  const scheduledCloseAtLabel = formatUnixTimestamp(input.latestDefinition.closeAt);
  if (isClosed) {
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

function downloadTextFile(filename: string, contents: string, type = "text/plain;charset=utf-8") {
  if (typeof window === "undefined") {
    return;
  }
  const blob = new Blob([contents], { type });
  const url = window.URL.createObjectURL(blob);
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  window.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}

function escapeForDoubleQuotedBash(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

function escapeForPowerShellSingleQuotedString(value: string) {
  return value.replace(/'/g, "''");
}

type WorkerLauncherTarget = {
  assetFilename: string;
  assetUrl: string;
  checksumUrl: string;
  binaryFilename: string;
  legacyBinaryFilename?: string;
  launcherFilename: string;
  shell: "bash" | "powershell";
};

type WorkerLauncherTargetKey = "linuxX64" | "linuxArm64" | "linuxArmv7" | "windowsX64" | "macosArm64";

const WORKER_LAUNCHER_TARGET_OPTIONS: Array<{ key: WorkerLauncherTargetKey; label: string }> = [
  { key: "linuxX64", label: "Linux x64" },
  { key: "linuxArm64", label: "Linux arm64" },
  { key: "linuxArmv7", label: "Linux armv7" },
  { key: "windowsX64", label: "Windows x64" },
  { key: "macosArm64", label: "macOS Apple Silicon" },
];

function buildWorkerLauncherContents(input: {
  target: WorkerLauncherTarget;
  coordinatorNpub: string;
  workerNsec: string;
  workerNpub: string;
  workerRelays: string;
}) {
  const coordinatorNpub = input.coordinatorNpub.trim() || "npub1...";
  const workerNsec = input.workerNsec.trim() || "nsec1...";
  const workerNpub = input.workerNpub.trim();
  const workerRelays = sanitizeWorkerRelays(input.workerRelays).join(",");

  if (input.target.shell === "powershell") {
    const coordinator = escapeForPowerShellSingleQuotedString(coordinatorNpub);
    const nsec = escapeForPowerShellSingleQuotedString(workerNsec);
    const npubLine = workerNpub
      ? `Write-Host 'Expected audit proxy npub: ${escapeForPowerShellSingleQuotedString(workerNpub)}'\n`
      : "";
    const relays = escapeForPowerShellSingleQuotedString(workerRelays);
    const legacyBinaryFilename = input.target.legacyBinaryFilename?.trim();
    return [
      "$ErrorActionPreference = 'Stop'",
      "",
      "# Generated from the organiser Build page.",
      "# Treat this file as sensitive if WORKER_NSEC is populated with a real secret.",
      npubLine.trimEnd(),
      "$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path",
      `$AssetUrl = '${escapeForPowerShellSingleQuotedString(input.target.assetUrl)}'`,
      `$ArchivePath = Join-Path $ScriptDir '${escapeForPowerShellSingleQuotedString(input.target.assetFilename)}'`,
      `$BinaryPath = Join-Path $ScriptDir '${escapeForPowerShellSingleQuotedString(input.target.binaryFilename)}'`,
      legacyBinaryFilename
        ? `$LegacyBinaryPath = Join-Path $ScriptDir '${escapeForPowerShellSingleQuotedString(legacyBinaryFilename)}'`
        : "$LegacyBinaryPath = $null",
      "",
      "Write-Host \"Refreshing audit proxy binary...\"",
      "Invoke-WebRequest -Uri $AssetUrl -OutFile $ArchivePath",
      "Expand-Archive -Path $ArchivePath -DestinationPath $ScriptDir -Force",
      "",
      `if (-not $env:RUST_LOG) { $env:RUST_LOG = 'debug' }`,
      `if (-not $env:WORKER_NSEC) { $env:WORKER_NSEC = '${nsec}' }`,
      `if (-not $env:COORDINATOR_NPUB) { $env:COORDINATOR_NPUB = '${coordinator}' }`,
      `if (-not $env:WORKER_RELAYS) { $env:WORKER_RELAYS = '${relays}' }`,
      "if (-not $env:WORKER_STATE_DIR) { $env:WORKER_STATE_DIR = (Join-Path $ScriptDir '.worker-state') }",
      "New-Item -ItemType Directory -Force -Path $env:WORKER_STATE_DIR | Out-Null",
      "",
      "if (Test-Path $BinaryPath) {",
      "  $ExecutablePath = $BinaryPath",
      "} elseif ($LegacyBinaryPath -and (Test-Path $LegacyBinaryPath)) {",
      "  $ExecutablePath = $LegacyBinaryPath",
      "} else {",
      "  throw 'Audit proxy executable not found after extraction.'",
      "}",
      "",
      "try { & $ExecutablePath --version } catch { Write-Host 'Audit proxy version check unavailable.' }",
      "Write-Host \"Starting audit proxy...\"",
      "& $ExecutablePath",
      "",
    ].filter(Boolean).join("\n");
  }

  const coordinator = escapeForDoubleQuotedBash(coordinatorNpub);
  const nsec = escapeForDoubleQuotedBash(workerNsec);
  const relays = escapeForDoubleQuotedBash(workerRelays);
  const legacyBinaryFilename = input.target.legacyBinaryFilename?.trim() ?? "";
  const expectedNpubComment = workerNpub
    ? `# Expected audit proxy npub: ${escapeForDoubleQuotedBash(workerNpub)}\n`
    : "";
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Generated from the organiser Build page.",
    "# Treat this file as sensitive if WORKER_NSEC is populated with a real secret.",
    expectedNpubComment.trimEnd(),
    'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    `ASSET_URL="${escapeForDoubleQuotedBash(input.target.assetUrl)}"`,
    `ASSET_NAME="${escapeForDoubleQuotedBash(input.target.assetFilename)}"`,
    `BINARY_NAME="${escapeForDoubleQuotedBash(input.target.binaryFilename)}"`,
    `LEGACY_BINARY_NAME="${escapeForDoubleQuotedBash(legacyBinaryFilename)}"`,
    "",
    "download_asset() {",
    "  if command -v curl >/dev/null 2>&1; then",
    '    curl -L --fail "$ASSET_URL" -o "$SCRIPT_DIR/$ASSET_NAME"',
    "    return",
    "  fi",
    "  if command -v wget >/dev/null 2>&1; then",
    '    wget -O "$SCRIPT_DIR/$ASSET_NAME" "$ASSET_URL"',
    "    return",
    "  fi",
    '  echo "Need curl or wget to download $ASSET_NAME" >&2',
    "  exit 1",
    "}",
    "",
    'echo "Refreshing audit proxy binary..."',
    "  download_asset",
    '  tar -xzf "$SCRIPT_DIR/$ASSET_NAME" -C "$SCRIPT_DIR"',
    '  chmod +x "$SCRIPT_DIR/$BINARY_NAME" || true',
    '  if [ -n "$LEGACY_BINARY_NAME" ]; then',
    '    chmod +x "$SCRIPT_DIR/$LEGACY_BINARY_NAME" || true',
    "  fi",
    "",
    'export RUST_LOG="${RUST_LOG:-debug}"',
    `export WORKER_NSEC="\${WORKER_NSEC:-${nsec}}"`,
    `export COORDINATOR_NPUB="\${COORDINATOR_NPUB:-${coordinator}}"`,
    `export WORKER_RELAYS="\${WORKER_RELAYS:-${relays}}"`,
    'export WORKER_STATE_DIR="${WORKER_STATE_DIR:-$SCRIPT_DIR/.worker-state}"',
    'mkdir -p "$WORKER_STATE_DIR"',
    "",
    'if [ -x "$SCRIPT_DIR/$BINARY_NAME" ]; then',
    '  EXECUTABLE_PATH="$SCRIPT_DIR/$BINARY_NAME"',
    'elif [ -n "$LEGACY_BINARY_NAME" ] && [ -x "$SCRIPT_DIR/$LEGACY_BINARY_NAME" ]; then',
    '  EXECUTABLE_PATH="$SCRIPT_DIR/$LEGACY_BINARY_NAME"',
    "else",
    '  echo "Audit proxy executable not found after extraction." >&2',
    "  exit 1",
    "fi",
    "",
    '"$EXECUTABLE_PATH" --version || true',
    'echo "Starting audit proxy..."',
    'exec "$EXECUTABLE_PATH"',
    "",
  ].filter(Boolean).join("\n");
}

function buildWorkerDirectCommand(input: {
  target: WorkerLauncherTarget;
  coordinatorNpub: string;
  workerNsec: string;
  workerRelays: string;
}) {
  const coordinatorNpub = input.coordinatorNpub.trim() || "npub1...";
  const workerNsec = input.workerNsec.trim() || "nsec1...";
  const workerRelays = sanitizeWorkerRelays(input.workerRelays).join(",");

  if (input.target.shell === "powershell") {
    const legacyBinaryFilename = input.target.legacyBinaryFilename?.trim();
    return [
      `Invoke-WebRequest -Uri '${escapeForPowerShellSingleQuotedString(input.target.assetUrl)}' -OutFile '${escapeForPowerShellSingleQuotedString(input.target.assetFilename)}'`,
      `Expand-Archive -Path '${escapeForPowerShellSingleQuotedString(input.target.assetFilename)}' -DestinationPath '.' -Force`,
      "$env:RUST_LOG='debug'",
      `$env:WORKER_NSEC='${escapeForPowerShellSingleQuotedString(workerNsec)}'`,
      `$env:COORDINATOR_NPUB='${escapeForPowerShellSingleQuotedString(coordinatorNpub)}'`,
      `$env:WORKER_RELAYS='${escapeForPowerShellSingleQuotedString(workerRelays)}'`,
      `if (Test-Path '.\\${escapeForPowerShellSingleQuotedString(input.target.binaryFilename)}') {`,
      `  .\\${input.target.binaryFilename}`,
      ...(legacyBinaryFilename
        ? [
            `} elseif (Test-Path '.\\${escapeForPowerShellSingleQuotedString(legacyBinaryFilename)}') {`,
            `  .\\${legacyBinaryFilename}`,
          ]
        : []),
      "} else {",
      "  throw 'Audit proxy executable not found after extraction.'",
      "}",
    ].join("\n");
  }

  const legacyBinaryFilename = input.target.legacyBinaryFilename?.trim() ?? "";
  return [
    `curl -L "${escapeForDoubleQuotedBash(input.target.assetUrl)}" -o "${escapeForDoubleQuotedBash(input.target.assetFilename)}"`,
    `tar -xzf "${escapeForDoubleQuotedBash(input.target.assetFilename)}"`,
    `chmod +x "./${escapeForDoubleQuotedBash(input.target.binaryFilename)}" || true`,
    legacyBinaryFilename
      ? `chmod +x "./${escapeForDoubleQuotedBash(legacyBinaryFilename)}" || true`
      : "",
    `if [ -x "./${escapeForDoubleQuotedBash(input.target.binaryFilename)}" ]; then`,
      '  RUST_LOG="debug" \\',
      `  WORKER_NSEC="${escapeForDoubleQuotedBash(workerNsec)}" \\`,
    `  COORDINATOR_NPUB="${escapeForDoubleQuotedBash(coordinatorNpub)}" \\`,
    `  WORKER_RELAYS="${escapeForDoubleQuotedBash(workerRelays)}" \\`,
    `  ./${escapeForDoubleQuotedBash(input.target.binaryFilename)}`,
    legacyBinaryFilename ? `elif [ -x "./${escapeForDoubleQuotedBash(legacyBinaryFilename)}" ]; then` : "else",
    ...(legacyBinaryFilename
      ? [
          '  RUST_LOG="debug" \\',
          `  WORKER_NSEC="${escapeForDoubleQuotedBash(workerNsec)}" \\`,
          `  COORDINATOR_NPUB="${escapeForDoubleQuotedBash(coordinatorNpub)}" \\`,
          `  WORKER_RELAYS="${escapeForDoubleQuotedBash(workerRelays)}" \\`,
          `  ./${escapeForDoubleQuotedBash(legacyBinaryFilename)}`,
        ]
      : []),
    "else",
    "  echo 'Audit proxy executable not found after extraction.' >&2",
    "  exit 1",
    "fi",
  ].join("\n");
}

function buildAutoconfiguredWorkerLauncherHref(input: {
  baseUrl: string;
  targetKey: WorkerLauncherTargetKey;
  coordinatorNpub: string;
  workerNpub?: string;
  workerRelays: string;
}) {
  const params = new URLSearchParams({
    target: input.targetKey,
    coordinator_npub: input.coordinatorNpub.trim() || "npub1...",
    worker_relays: sanitizeWorkerRelays(input.workerRelays).join(","),
  });
  if (input.workerNpub?.trim()) {
    params.set("worker_npub", input.workerNpub.trim());
  }
  return `${input.baseUrl}?${params.toString()}`;
}

function parseQuestionnaireIdFromResponseEvent(event: Pick<NostrEvent, "content" | "kind"> & { tags?: string[][] }): string | null {
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

function hasEncryptedFreeTextAnswer(answers: QuestionnaireResponseAnswer[] | undefined) {
  return (answers ?? []).some((answer) => (
    answer.answerType === "free_text"
    && answer.text.trim().startsWith("enc:nip44v2:")
  ));
}

function resolveBlindResponseAnswersForCoordinator(input: {
  entry: QuestionnaireBlindResponseEntry;
  coordinatorNsec: string;
}) {
  const rawAnswers = input.entry.response.answers;
  const needsDecrypt = Boolean(input.entry.response.encryptedPayload) || hasEncryptedFreeTextAnswer(rawAnswers);
  if (input.coordinatorNsec.trim() && needsDecrypt) {
    try {
      const decrypted = decryptQuestionnaireBlindResponseAnswers({
        coordinatorNsec: input.coordinatorNsec,
        eventPubkey: input.entry.event.pubkey,
        response: input.entry.response,
      });
      return {
        answers: decrypted.answers,
        decryptedAnswerQuestionIds: deriveCoordinatorDecryptedAnswerQuestionIds({
          encryptedPayloadDecrypted: decrypted.encryptedPayloadDecrypted,
          decryptedAnswers: decrypted.answers,
          originalAnswers: rawAnswers,
        }),
      };
    } catch {
      return {
        answers: rawAnswers ?? [],
        decryptedAnswerQuestionIds: [],
      };
    }
  }
  return {
    answers: rawAnswers ?? [],
    decryptedAnswerQuestionIds: [],
  };
}

function deriveCoordinatorDecryptedAnswerQuestionIds(input: {
  encryptedPayloadDecrypted: boolean;
  decryptedAnswers: QuestionnaireResponseAnswer[];
  originalAnswers: QuestionnaireResponseAnswer[] | undefined;
}) {
  const questionIds = new Set<string>();
  if (input.encryptedPayloadDecrypted) {
    for (const answer of input.decryptedAnswers) {
      questionIds.add(answer.questionId);
    }
  }
  for (const answer of input.originalAnswers ?? []) {
    if (
      answer.answerType === "free_text"
      && answer.text.trim().startsWith("enc:nip44v2:")
    ) {
      questionIds.add(answer.questionId);
    }
  }
  return [...questionIds];
}

function publicBlindResponseToAcceptedResponse(input: {
  entry: QuestionnaireBlindResponseEntry;
  coordinatorNsec: string;
  coordinatorNpub: string;
}): QuestionnaireAcceptedResponse {
  const submittedAt = Number.isFinite(input.entry.response.submittedAt)
    ? input.entry.response.submittedAt
    : input.entry.event.created_at ?? nowUnix();
  const resolvedAnswers = resolveBlindResponseAnswersForCoordinator({
    entry: input.entry,
    coordinatorNsec: input.coordinatorNsec,
  });
  return {
    eventId: input.entry.event.id,
    authorPubkey: input.entry.response.authorPubkey,
    envelope: {
      schemaVersion: 1,
      eventType: "questionnaire_response_private",
      questionnaireId: input.entry.response.questionnaireId,
      responseId: input.entry.response.responseId,
      createdAt: submittedAt,
      authorPubkey: input.entry.response.authorPubkey,
      ciphertextScheme: "nip44v2",
      ciphertextRecipient: input.coordinatorNpub.trim() || "public_blind_response",
      ciphertext: input.entry.response.encryptedPayload ?? "public_blind_response",
      payloadHash: input.entry.response.payloadHash ?? input.entry.response.tokenProof.tokenCommitment,
    },
    payload: {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: input.entry.response.questionnaireId,
      responseId: input.entry.response.responseId,
      submittedAt,
      answers: resolvedAnswers.answers,
    },
    decryptedAnswerQuestionIds: resolvedAnswers.decryptedAnswerQuestionIds,
  };
}

function publishedResponseRefToAcceptedResponse(input: {
  questionnaireId: string;
  ref: QuestionnairePublishedResponseRef;
  coordinatorNpub: string;
}): QuestionnaireAcceptedResponse | null {
  const responseId = input.ref.responseId.trim();
  if (!input.ref.accepted || !responseId) {
    return null;
  }
  const submittedAt = Number.isFinite(input.ref.submittedAt)
    ? Number(input.ref.submittedAt)
    : nowUnix();
  return {
    eventId: `summary:${input.questionnaireId}:${responseId}`,
    authorPubkey: input.ref.authorPubkey,
    envelope: {
      schemaVersion: 1,
      eventType: "questionnaire_response_private",
      questionnaireId: input.questionnaireId,
      responseId,
      createdAt: submittedAt,
      authorPubkey: input.ref.authorPubkey,
      ciphertextScheme: "nip44v2",
      ciphertextRecipient: input.coordinatorNpub.trim() || "summary_reference",
      ciphertext: "summary_reference",
      payloadHash: `summary:${responseId}`,
    },
    payload: {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: input.questionnaireId,
      responseId,
      submittedAt,
      answers: input.ref.answers ?? [],
    },
  };
}

function mergeAcceptedResponsesForCoordinator(responses: QuestionnaireAcceptedResponse[]) {
  const byKey = new Map<string, QuestionnaireAcceptedResponse>();
  for (const response of responses) {
    const key = response.payload.responseId.trim() || response.eventId;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, response);
      continue;
    }
    const existingAnswerCount = existing.payload.answers.length;
    const nextAnswerCount = response.payload.answers.length;
    if (nextAnswerCount > existingAnswerCount) {
      byKey.set(key, response);
      continue;
    }
    const existingEncryptedAnswerCount = countEncryptedFreeTextAnswers(existing);
    const nextEncryptedAnswerCount = countEncryptedFreeTextAnswers(response);
    if (
      nextAnswerCount === existingAnswerCount
      && nextEncryptedAnswerCount < existingEncryptedAnswerCount
    ) {
      byKey.set(key, response);
      continue;
    }
    const existingSynthetic = existing.eventId.startsWith("summary:");
    const nextSynthetic = response.eventId.startsWith("summary:");
    if (existingSynthetic && !nextSynthetic) {
      byKey.set(key, response);
    }
  }
  return [...byKey.values()].sort((left, right) => left.payload.submittedAt - right.payload.submittedAt);
}

function countEncryptedFreeTextAnswers(response: QuestionnaireAcceptedResponse) {
  return response.payload.answers.filter((answer) => (
    answer.answerType === "free_text"
    && answer.text.trim().startsWith("enc:nip44v2:")
  )).length;
}

function deriveAcceptedResponseDecryptedAnswerQuestionIds(response: QuestionnaireAcceptedResponse) {
  if (response.decryptedAnswerQuestionIds?.length) {
    return response.decryptedAnswerQuestionIds;
  }
  const ciphertext = response.envelope.ciphertext.trim();
  const isSyntheticPublicReference = ciphertext === "public_blind_response" || ciphertext === "summary_reference";
  if (!isSyntheticPublicReference && response.payload.answers.length > 0) {
    return response.payload.answers.map((answer) => answer.questionId);
  }
  return [];
}

function buildDefinition(input: {
  questionnaireId: string;
  coordinatorPubkey: string;
  title: string;
  description: string;
  closeAfterMinutes?: number;
  questionnaireRelays?: string[];
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
    ...(input.questionnaireRelays?.length ? { questionnaireRelays: input.questionnaireRelays } : {}),
    questions: input.questions,
  };
}

function comparableDefinitionRelaySet(definition: QuestionnaireDefinition) {
  return questionnaireRelaysForMetadata(normalizeQuestionnaireRelays(definition.questionnaireRelays ?? [])) ?? [];
}

function definitionCloseDurationSeconds(definition: QuestionnaireDefinition) {
  return Math.max(0, Math.floor(definition.closeAt - definition.openAt));
}

function comparableDefinitionDraftShape(definition: QuestionnaireDefinition) {
  return {
    schemaVersion: definition.schemaVersion,
    eventType: definition.eventType,
    protocolVersion: definition.protocolVersion ?? null,
    flowMode: definition.flowMode ?? null,
    responseMode: definition.responseMode,
    questionnaireId: definition.questionnaireId,
    title: definition.title,
    description: definition.description ?? "",
    coordinatorPubkey: definition.coordinatorPubkey,
    coordinatorEncryptionPubkey: definition.coordinatorEncryptionPubkey,
    responseVisibility: definition.responseVisibility,
    eligibilityMode: definition.eligibilityMode,
    allowMultipleResponsesPerPubkey: definition.allowMultipleResponsesPerPubkey,
    blindSigningPublicKey: definition.blindSigningPublicKey ?? null,
    closeDurationSeconds: definitionCloseDurationSeconds(definition),
    questionnaireRelays: comparableDefinitionRelaySet(definition),
    questions: definition.questions,
  };
}

function publishedDefinitionMatchesDraft(
  publishedDefinition: QuestionnaireDefinition | null,
  draftDefinition: QuestionnaireDefinition | null,
) {
  if (!publishedDefinition || !draftDefinition) {
    return false;
  }
  return JSON.stringify(comparableDefinitionDraftShape(publishedDefinition))
    === JSON.stringify(comparableDefinitionDraftShape(draftDefinition));
}

export default function QuestionnaireCoordinatorPanel(props: QuestionnaireCoordinatorPanelProps) {
  const deploymentMode = useMemo(() => readDeploymentModeFromUrl(), []);
  const isCourseFeedbackMode = deploymentMode === "course_feedback";
  const isNewRoundMode = props.newRoundMode === true;
  const view = props.view ?? "build";
  const storedDraft = useMemo(() => readStoredQuestionnaireDraft(), []);
  const [questionnaireId, setQuestionnaireId] = useState(storedDraft.questionnaireId);
  const [title, setTitle] = useState(storedDraft.title);
  const [description, setDescription] = useState(storedDraft.description);
  const [closeTimerEnabled, setCloseTimerEnabled] = useState(storedDraft.closeTimerEnabled);
  const [closeAfterMinutes, setCloseAfterMinutes] = useState(storedDraft.closeAfterMinutes);
  const [closeTimerUnit, setCloseTimerUnit] = useState<CloseTimerUnit>(normaliseCloseTimerUnit(storedDraft.closeTimerUnit));
  const questionnaireRelaysInput = props.questionnaireRelaysInput ?? storedDraft.questionnaireRelays ?? "";
  const [useDefaultSetupRelays, setUseDefaultSetupRelays] = useState(() => normalizeQuestionnaireRelays(questionnaireRelaysInput).length === 0);
  const [questions, setQuestions] = useState<QuestionnaireQuestionDraft[]>(storedDraft.questions);
  const [delegationMode, setDelegationMode] = useState<"browser_only" | "delegated_worker">(storedDraft.delegationMode ?? "browser_only");
  const [delegatedWorkerNpub, setDelegatedWorkerNpub] = useState(storedDraft.delegatedWorkerNpub ?? "");
  const [delegatedWorkerControlRelays, setDelegatedWorkerControlRelays] = useState(storedDraft.delegatedWorkerControlRelays ?? "");
  const [delegatedWorkerExpiryEnabled, setDelegatedWorkerExpiryEnabled] = useState(storedDraft.delegatedWorkerExpiryEnabled ?? false);
  const [delegatedWorkerExpiryMinutes, setDelegatedWorkerExpiryMinutes] = useState(storedDraft.delegatedWorkerExpiryMinutes ?? "");
  const [delegatedWorkerCapabilities, setDelegatedWorkerCapabilities] = useState<WorkerCapability[]>(
    (() => {
      const filtered = (storedDraft.delegatedWorkerCapabilities ?? [...CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES])
        .filter((entry): entry is WorkerCapability => CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES.includes(entry));
      return filtered.length > 0 ? filtered : [...CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES];
    })(),
  );
  const [workerMoreOptionsCollapsed, setWorkerMoreOptionsCollapsed] = useState(true);
  const [auditProxyExpandSignal, setAuditProxyExpandSignal] = useState(0);
  const [selectedWorkerDownloadTarget, setSelectedWorkerDownloadTarget] = useState<WorkerLauncherTargetKey>("linuxX64");
  const [generatedWorkerNsec, setGeneratedWorkerNsec] = useState("");
  const [generatedWorkerNpub, setGeneratedWorkerNpub] = useState("");
  const [activeWorkerDelegation, setActiveWorkerDelegation] = useState<WorkerDelegationCertificate | null>(null);
  const [lastWorkerRevocationState, setLastWorkerRevocationState] = useState<WorkerDelegationState | null>(null);
  const [availableWorkerStatuses, setAvailableWorkerStatuses] = useState<WorkerStatusSnapshot[]>([]);
  const [coordinatorNsec, setCoordinatorNsec] = useState("");
  const [coordinatorNpub, setCoordinatorNpub] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [isCloseAndPublishInFlight, setIsCloseAndPublishInFlight] = useState(false);
  const [recoveredBlindSigningPublicKey, setRecoveredBlindSigningPublicKey] = useState<QuestionnaireBlindPublicKey | null>(null);
  const regenerateQuestionnaireId = useCallback(() => {
    setQuestionnaireId(generateQuestionnaireId());
  }, []);
  const [latestDefinition, setLatestDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [latestState, setLatestState] = useState<QuestionnaireStateValue | null>(null);
  const [latestStateEvent, setLatestStateEvent] = useState<QuestionnaireStateEvent | null>(null);
  const [latestStateCreatedAt, setLatestStateCreatedAt] = useState<number | null>(null);
  const [latestAcceptedCount, setLatestAcceptedCount] = useState(0);
  const [latestRejectedCount, setLatestRejectedCount] = useState(0);
  const [latestAcceptedResponses, setLatestAcceptedResponses] = useState<QuestionnaireAcceptedResponse[]>([]);
  const [lastResponseSeenEventId, setLastResponseSeenEventId] = useState<string | null>(null);
  const [lastResponseRejectReason, setLastResponseRejectReason] = useState<string | null>(null);
  const [latestResultAcceptedCount, setLatestResultAcceptedCount] = useState<number | null>(null);
  const [availableQuestionnaireIds, setAvailableQuestionnaireIds] = useState<string[]>([]);
  const [availableQuestionnaireTitles, setAvailableQuestionnaireTitles] = useState<Record<string, string>>({});
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
  const statusNotice = status ? (
    <div className='simple-status-row'>
      <p className='simple-voter-note'>{status}</p>
    </div>
  ) : null;
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
  const parsedQuestionnaireRelays = useMemo(
    () => normalizeQuestionnaireRelays(questionnaireRelaysInput),
    [questionnaireRelaysInput],
  );
  const questionnaireRelayMetadata = useMemo(
    () => questionnaireRelaysForMetadata(parsedQuestionnaireRelays) ?? [],
    [parsedQuestionnaireRelays],
  );
  const previousQuestionnaireRelayMetadataCountRef = useRef(questionnaireRelayMetadata.length);
  useEffect(() => {
    const previousCount = previousQuestionnaireRelayMetadataCountRef.current;
    if (questionnaireRelayMetadata.length > 0) {
      setUseDefaultSetupRelays(false);
    } else if (previousCount > 0) {
      setUseDefaultSetupRelays(true);
    }
    previousQuestionnaireRelayMetadataCountRef.current = questionnaireRelayMetadata.length;
  }, [questionnaireRelayMetadata.length]);
  const questionnaireRelayPublishHints = useMemo(
    () => (questionnaireRelayMetadata.length > 0 ? questionnaireRelayMetadata : undefined),
    [questionnaireRelayMetadata],
  );
  const setupRelaySettingsEnabled = !useDefaultSetupRelays;
  const questionnaireRelayStatus = setupRelaySettingsEnabled && questionnaireRelayMetadata.length > 0
    ? `${questionnaireRelayMetadata.length} custom relay${questionnaireRelayMetadata.length === 1 ? "" : "s"} set.`
    : "";

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

  useEffect(() => {
    const electionId = questionnaireId.trim();
    if (!electionId) {
      setActiveWorkerDelegation(null);
      setLastWorkerRevocationState(null);
      return;
    }
    const stored = loadStoredWorkerDelegation(electionId);
    setActiveWorkerDelegation(stored?.activeDelegation ?? null);
    if (stored?.lastRevocation?.delegationId) {
      setLastWorkerRevocationState("revoked");
    } else {
      const expiresAtMs = Date.parse(stored?.activeDelegation?.expiresAt ?? "");
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        setLastWorkerRevocationState("expired");
      } else if (stored?.activeDelegation) {
        setLastWorkerRevocationState("active");
      } else {
        setLastWorkerRevocationState(null);
      }
    }
  }, [questionnaireId]);

  useEffect(() => {
    const electionId = questionnaireId.trim();
    if (!electionId) {
      return;
    }
    if (delegationMode === "browser_only" && !activeWorkerDelegation) {
      upsertStoredWorkerDelegation({
        electionId,
        mode: "browser_only",
        activeDelegation: null,
        lastRevocation: null,
        lastUpdatedAt: new Date().toISOString(),
      });
    }
  }, [activeWorkerDelegation, delegationMode, questionnaireId]);

  useEffect(() => {
    const nsec = coordinatorNsec.trim();
    const coordinatorNpubTrimmed = coordinatorNpub.trim();
    if (!nsec || !coordinatorNpubTrimmed) {
      setAvailableWorkerStatuses([]);
      return;
    }
    let cancelled = false;
    const refreshStatuses = async () => {
      try {
        const snapshots = await fetchOptionAWorkerStatusDmsWithNsec({
          nsec,
          coordinatorNpub: coordinatorNpubTrimmed,
          limit: 150,
          since: Math.floor(Date.now() / 1000) - (24 * 60 * 60),
        });
        if (cancelled) {
          return;
        }
        const latestByWorker = new Map<string, WorkerStatusSnapshot>();
        for (const snapshot of snapshots) {
          const existing = latestByWorker.get(snapshot.workerNpub);
          if (!existing) {
            latestByWorker.set(snapshot.workerNpub, snapshot);
            continue;
          }
          if (Date.parse(snapshot.heartbeatAt) > Date.parse(existing.heartbeatAt)) {
            latestByWorker.set(snapshot.workerNpub, snapshot);
          }
        }
        setAvailableWorkerStatuses(
          [...latestByWorker.values()].sort((left, right) => Date.parse(right.heartbeatAt) - Date.parse(left.heartbeatAt)),
        );
      } catch {
        if (!cancelled) {
          setAvailableWorkerStatuses((current) => current);
        }
      }
    };
    void refreshStatuses();
    const intervalId = window.setInterval(() => {
      void refreshStatuses();
    }, 25_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [coordinatorNpub, coordinatorNsec]);

  function parseDelegatedControlRelays(value: string) {
    const parsed = sanitizeWorkerRelays(value);
    return parsed.length > 0 ? parsed : DEFAULT_WORKER_CONTROL_RELAYS;
  }

  function toggleWorkerCapability(capability: WorkerCapability) {
    if (!CURRENTLY_IMPLEMENTED_WORKER_CAPABILITIES.includes(capability)) {
      return;
    }
    setDelegatedWorkerCapabilities((current) => (
      current.includes(capability)
        ? current.filter((entry) => entry !== capability)
        : [...current, capability]
    ));
  }

  const applyQuestionnaireSnapshot = useCallback((input: {
    definitionEvents: NostrEvent[];
    stateEvents: NostrEvent[];
    responseEvents: NostrEvent[];
    publicResponseEntries?: QuestionnaireBlindResponseEntry[];
    publicDecisionEntries?: QuestionnaireSubmissionDecisionEntry[];
    verifiedResponseIds?: Iterable<string>;
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

    const activeQuestionnaireId = questionnaireId.trim();
    const activeCoordinatorNpub = coordinatorNpub.trim();
    const definitionEvents = input.definitionEvents.filter((event) => {
      const parsed = parseQuestionnaireDefinitionEvent(event);
      return Boolean(
        parsed
        && parsed.questionnaireId === activeQuestionnaireId
        && (!activeCoordinatorNpub || parsed.coordinatorPubkey === activeCoordinatorNpub),
      );
    });
    const stateEvents = input.stateEvents.filter((event) => {
      const parsed = parseQuestionnaireStateEvent(event);
      return Boolean(
        parsed
        && parsed.questionnaireId === activeQuestionnaireId
        && (!activeCoordinatorNpub || parsed.coordinatorPubkey === activeCoordinatorNpub),
      );
    });
    const resultEvents = input.resultEvents.filter((event) => {
      const parsed = parseQuestionnaireResultSummaryEvent(event);
      return Boolean(
        parsed
        && parsed.questionnaireId === activeQuestionnaireId
        && (!activeCoordinatorNpub || parsed.coordinatorPubkey === activeCoordinatorNpub),
      );
    });

    const definition = selectLatestQuestionnaireDefinition(definitionEvents);
    const state = selectLatestQuestionnaireState(stateEvents);
    const resultSummary = selectLatestQuestionnaireResultSummary(resultEvents);
    const publicResponseEntries = (input.publicResponseEntries ?? [])
      .filter((entry) => entry.response.questionnaireId === activeQuestionnaireId);
    const publicDecisionEntries = (input.publicDecisionEntries ?? [])
      .filter((entry) => entry.decision.questionnaireId === activeQuestionnaireId);
    setDefinitionEventCount(definitionEvents.length);
    setStateEventCount(stateEvents.length);
    setResponseEventCount(input.responseEvents.length + publicResponseEntries.length);
    setResultEventCount(resultEvents.length);
    const latestResponseEvent = [
      ...input.responseEvents,
      ...publicResponseEntries.map((entry) => entry.event),
    ]
      .sort((left, right) => right.created_at - left.created_at)[0] ?? null;
    setLastResponseSeenEventId(latestResponseEvent?.id ?? null);

    setLatestDefinition(definition);
    setLatestStateEvent(state);
    setLatestStateCreatedAt(state?.createdAt ?? null);
    setLatestState(deriveEffectiveQuestionnaireState({
      definition,
      latestState: state,
    }));
    setLatestResultAcceptedCount(resultSummary?.acceptedResponseCount ?? null);

    if (definition?.flowMode === QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1) {
      const admissions = evaluateQuestionnaireBlindAdmissions({
        entries: publicResponseEntries,
        decisionEntries: publicDecisionEntries,
        verifiedResponseIds: input.verifiedResponseIds,
      });
      const acceptedFromSubmissions = admissions.accepted.map((entry) => publicBlindResponseToAcceptedResponse({
        entry,
        coordinatorNsec,
        coordinatorNpub,
      }));
      const acceptedFromSummary = (resultSummary?.publishedResponseRefs ?? [])
        .map((ref) => publishedResponseRefToAcceptedResponse({
          questionnaireId: definition.questionnaireId,
          ref,
          coordinatorNpub,
        }))
        .filter((entry): entry is QuestionnaireAcceptedResponse => Boolean(entry));
      const accepted = mergeAcceptedResponsesForCoordinator([...acceptedFromSubmissions, ...acceptedFromSummary]);
      setLatestAcceptedCount(Math.max(
        admissions.accepted.length,
        accepted.length,
        resultSummary?.acceptedResponseCount ?? 0,
      ));
      setLatestRejectedCount(Math.max(
        admissions.rejected.length,
        resultSummary?.rejectedResponseCount ?? 0,
      ));
      setLatestAcceptedResponses(accepted);
      setLastResponseRejectReason(admissions.rejected.at(-1)?.rejectionReason ?? null);
    } else if (definition && coordinatorNsec.trim()) {
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
  }, [coordinatorNpub, coordinatorNsec, questionnaireId]);

  const refresh = useCallback(async () => {
    const id = questionnaireId.trim();
    if (!id) {
      return;
    }

    try {
      const [definitionFetch, stateFetch, responseFetch, publicResponseFetch, publicDecisionFetch, resultFetch] = await Promise.all([
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_DEFINITION_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_STATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireBlindResponses({
          questionnaireId: id,
          limit: 500,
          readRelayLimit: 8,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
        }).catch(() => []),
        fetchQuestionnaireSubmissionDecisions({
          questionnaireId: id,
          limit: 500,
          readRelayLimit: 8,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
        }).catch(() => []),
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
          relays: questionnaireRelayPublishHints,
        }),
      ]);
      const latestDefinitionForVerification = [...definitionFetch.events]
        .map((event) => ({ event, definition: parseQuestionnaireDefinitionEvent(event) }))
        .filter((entry) => entry.definition?.questionnaireId === id)
        .sort((left, right) => Number(right.event.created_at ?? right.definition?.createdAt ?? 0) - Number(left.event.created_at ?? left.definition?.createdAt ?? 0))[0]
        ?.definition ?? null;
      const verifiedResponseIds = await verifyQuestionnaireBlindResponseProofs({
        entries: publicResponseFetch,
        publicKey: latestDefinitionForVerification?.blindSigningPublicKey ?? null,
      });
      applyQuestionnaireSnapshot({
        definitionEvents: definitionFetch.events,
        stateEvents: stateFetch.events,
        responseEvents: responseFetch.events,
        publicResponseEntries: publicResponseFetch,
        publicDecisionEntries: publicDecisionFetch,
        verifiedResponseIds,
        resultEvents: resultFetch.events,
        diagnostics: {
          definition: definitionFetch.diagnostics,
          state: stateFetch.diagnostics,
          response: responseFetch.diagnostics,
          result: resultFetch.diagnostics,
        },
      });
    } catch {
      setStatus("Refresh failed.");
    }
  }, [applyQuestionnaireSnapshot, questionnaireId, questionnaireRelayPublishHints]);

  useEffect(() => {
    let cancelled = false;
    const loadQuestionnaireOptions = async () => {
      try {
        const relays = getQuestionnaireReadRelays(questionnaireRelayPublishHints);
        const events = await queryQuestionnaireEvents(relays, {
          kinds: [QUESTIONNAIRE_DEFINITION_KIND],
          limit: 400,
        });
        if (cancelled) {
          return;
        }

        const ids = new Set<string>();
        const titlesById: Record<string, string> = {};
        const coordinatorFilter = normaliseCoordinatorIdentifier(coordinatorNpub);
        if (!coordinatorFilter) {
          setAvailableQuestionnaireIds([]);
          setAvailableQuestionnaireTitles({});
          return;
        }
        for (const summary of listElectionSummaries()) {
          const summaryCoordinatorNpub = normaliseCoordinatorIdentifier(summary.coordinatorNpub);
          if (summaryCoordinatorNpub !== coordinatorFilter) {
            continue;
          }
          const summaryId = summary.electionId.trim();
          if (!summaryId) {
            continue;
          }
          ids.add(summaryId);
          const cachedDefinition = readCachedQuestionnaireDefinition(summaryId);
          const cachedDefinitionTitle = cachedDefinition
            && normaliseCoordinatorIdentifier(cachedDefinition.coordinatorPubkey) === summaryCoordinatorNpub
            ? cachedDefinition.title?.trim() ?? ""
            : "";
          const summaryTitle = summary.title?.trim() || cachedDefinitionTitle;
          if (summaryTitle) {
            titlesById[summaryId] = summaryTitle;
          }
        }
        const eventTitleCandidatesById = new Map<string, { title: string; createdAt: number }>();
        for (const event of events) {
          const parsed = parseQuestionnaireDefinitionEvent(event);
          if (!parsed) {
            continue;
          }
          if (!questionnaireDefinitionEventIsSignedByCoordinator(event, parsed, coordinatorFilter)) {
            continue;
          }
          if (parsed.questionnaireId.trim()) {
            const parsedId = parsed.questionnaireId.trim();
            ids.add(parsedId);
            const eventTitle = parsed.title.trim();
            if (eventTitle) {
              const createdAt = Number(event.created_at ?? parsed.createdAt ?? 0);
              const existing = eventTitleCandidatesById.get(parsedId);
              if (!existing || createdAt >= existing.createdAt) {
                eventTitleCandidatesById.set(parsedId, {
                  title: eventTitle,
                  createdAt,
                });
              }
            }
          }
        }
        for (const [id, candidate] of eventTitleCandidatesById) {
          titlesById[id] = candidate.title;
        }
        const selectedId = questionnaireId.trim();
        if (selectedId && view !== "responses" && ids.size === 0) {
          ids.add(selectedId);
        }
        setAvailableQuestionnaireIds([...ids].sort((left, right) => {
          const leftSummary = loadElectionSummary(left);
          const rightSummary = loadElectionSummary(right);
          const leftTime = Date.parse(leftSummary?.openedAt ?? leftSummary?.closedAt ?? "");
          const rightTime = Date.parse(rightSummary?.openedAt ?? rightSummary?.closedAt ?? "");
          if (Number.isFinite(leftTime) || Number.isFinite(rightTime)) {
            return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
          }
          return left.localeCompare(right);
        }));
        setAvailableQuestionnaireTitles(titlesById);
      } catch {
        const selectedId = questionnaireId.trim();
        const ids = new Set<string>();
        const titlesById: Record<string, string> = {};
        const coordinatorFilter = normaliseCoordinatorIdentifier(coordinatorNpub);
        if (!coordinatorFilter) {
          setAvailableQuestionnaireIds([]);
          setAvailableQuestionnaireTitles({});
          return;
        }
        for (const summary of listElectionSummaries()) {
          const summaryCoordinatorNpub = normaliseCoordinatorIdentifier(summary.coordinatorNpub);
          if (summaryCoordinatorNpub !== coordinatorFilter) {
            continue;
          }
          const summaryId = summary.electionId.trim();
          if (!summaryId) {
            continue;
          }
          ids.add(summaryId);
          if (summary.title?.trim()) {
            titlesById[summaryId] = summary.title.trim();
          }
        }
        if (selectedId && view !== "responses" && ids.size === 0) {
          ids.add(selectedId);
        }
        setAvailableQuestionnaireIds([...ids]);
        setAvailableQuestionnaireTitles(titlesById);
      }
    };
    void loadQuestionnaireOptions();
    return () => {
      cancelled = true;
    };
  }, [coordinatorNpub, questionnaireId, questionnaireRelayPublishHints, view]);

  useEffect(() => {
    if (view !== "responses" || availableQuestionnaireIds.length === 0) {
      return;
    }
    const selectedId = questionnaireId.trim();
    if (selectedId && availableQuestionnaireIds.includes(selectedId)) {
      return;
    }
    setQuestionnaireId(availableQuestionnaireIds[0]);
  }, [availableQuestionnaireIds, questionnaireId, view]);

  useEffect(() => {
    const id = questionnaireId.trim();
    if (!id) {
      return undefined;
    }

    let cancelled = false;
    const definitionById = new Map<string, NostrEvent>();
    const stateById = new Map<string, NostrEvent>();
    const responseById = new Map<string, NostrEvent>();
    const publicResponseById = new Map<string, QuestionnaireBlindResponseEntry>();
    const publicDecisionById = new Map<string, QuestionnaireSubmissionDecisionEntry>();
    const resultById = new Map<string, NostrEvent>();
    const applyFromMaps = () => {
      if (cancelled) {
        return;
      }
      applyQuestionnaireSnapshot({
        definitionEvents: [...definitionById.values()],
        stateEvents: [...stateById.values()],
        responseEvents: [...responseById.values()],
        publicResponseEntries: [...publicResponseById.values()],
        publicDecisionEntries: [...publicDecisionById.values()],
        resultEvents: [...resultById.values()],
      });
    };

    const loadInitialBackfill = async () => {
      const [definitionFetch, stateFetch, responseFetch, publicResponseFetch, publicDecisionFetch, resultFetch] = await Promise.all([
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_DEFINITION_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_STATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireStateEvent(event)?.questionnaireId ?? null,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireEventsWithFallback({
          questionnaireId: id,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
          readRelayLimit: 8,
        }),
        fetchQuestionnaireBlindResponses({
          questionnaireId: id,
          limit: 500,
          readRelayLimit: 8,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
        }).catch(() => []),
        fetchQuestionnaireSubmissionDecisions({
          questionnaireId: id,
          limit: 500,
          readRelayLimit: 8,
          preferKindOnly: true,
          relays: questionnaireRelayPublishHints,
        }).catch(() => []),
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
          relays: questionnaireRelayPublishHints,
        }),
      ]);
      if (cancelled) {
        return;
      }
      definitionById.clear();
      stateById.clear();
      responseById.clear();
      publicResponseById.clear();
      publicDecisionById.clear();
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
      for (const entry of publicResponseFetch) {
        publicResponseById.set(entry.event.id, entry);
      }
      for (const entry of publicDecisionFetch) {
        publicDecisionById.set(entry.event.id, entry);
      }
      for (const event of resultFetch.events) {
        resultById.set(event.id, event);
      }
      const latestDefinitionForVerification = [...definitionFetch.events]
        .map((event) => ({ event, definition: parseQuestionnaireDefinitionEvent(event) }))
        .filter((entry) => entry.definition?.questionnaireId === id)
        .sort((left, right) => Number(right.event.created_at ?? right.definition?.createdAt ?? 0) - Number(left.event.created_at ?? left.definition?.createdAt ?? 0))[0]
        ?.definition ?? null;
      const verifiedResponseIds = await verifyQuestionnaireBlindResponseProofs({
        entries: publicResponseFetch,
        publicKey: latestDefinitionForVerification?.blindSigningPublicKey ?? null,
      });
      applyQuestionnaireSnapshot({
        definitionEvents: definitionFetch.events,
        stateEvents: stateFetch.events,
        responseEvents: responseFetch.events,
        publicResponseEntries: publicResponseFetch,
        publicDecisionEntries: publicDecisionFetch,
        verifiedResponseIds,
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
        setStatus("Refresh failed.");
      }
    });

    const unsubscribe = subscribeQuestionnaireEventKinds({
      questionnaireId: id,
      kinds: [
        QUESTIONNAIRE_DEFINITION_KIND,
        QUESTIONNAIRE_STATE_KIND,
        QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
        QUESTIONNAIRE_RESPONSE_BLIND_KIND,
        QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
        QUESTIONNAIRE_RESULT_SUMMARY_KIND,
      ],
      parseQuestionnaireIdFromEvent: (event) => {
        if (event.kind === QUESTIONNAIRE_DEFINITION_KIND) {
          return parseQuestionnaireDefinitionEvent(event)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_STATE_KIND) {
          return parseQuestionnaireStateEvent(event)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_RESPONSE_PRIVATE_KIND) {
          return parseQuestionnaireIdFromResponseEvent(event);
        }
        if (event.kind === QUESTIONNAIRE_RESPONSE_BLIND_KIND) {
          return parseQuestionnaireBlindResponseEvent(event.content)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_SUBMISSION_DECISION_KIND) {
          return parseQuestionnaireSubmissionDecisionEvent(event.content)?.questionnaireId ?? null;
        }
        if (event.kind === QUESTIONNAIRE_RESULT_SUMMARY_KIND) {
          try {
            const parsed = JSON.parse(event.content) as { questionnaireId?: string };
            return typeof parsed.questionnaireId === "string" ? parsed.questionnaireId : null;
          } catch {
            return null;
          }
        }
        return null;
      },
      relays: questionnaireRelayPublishHints,
      readRelayLimit: 8,
      limit: 500,
      onEvent: (event) => {
        if (event.kind === QUESTIONNAIRE_DEFINITION_KIND) {
          definitionById.set(event.id, event);
          applyFromMaps();
          return;
        }
        if (event.kind === QUESTIONNAIRE_STATE_KIND) {
          stateById.set(event.id, event);
          applyFromMaps();
          return;
        }
        if (event.kind === QUESTIONNAIRE_RESPONSE_PRIVATE_KIND) {
          responseById.set(event.id, event);
          applyFromMaps();
          return;
        }
        if (event.kind === QUESTIONNAIRE_RESPONSE_BLIND_KIND) {
          const response = parseQuestionnaireBlindResponseEvent(event.content);
          if (response) {
            publicResponseById.set(event.id, { event, response });
            applyFromMaps();
          }
          return;
        }
        if (event.kind === QUESTIONNAIRE_SUBMISSION_DECISION_KIND) {
          const decision = parseQuestionnaireSubmissionDecisionEvent(event.content);
          if (decision) {
            publicDecisionById.set(event.id, { event, decision });
            applyFromMaps();
          }
          return;
        }
        if (event.kind === QUESTIONNAIRE_RESULT_SUMMARY_KIND) {
          resultById.set(event.id, event);
          applyFromMaps();
        }
      },
      onError: () => undefined,
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applyQuestionnaireSnapshot, questionnaireId, questionnaireRelayPublishHints]);

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
    if (typeof window === "undefined") {
      return;
    }
    const parentOwnsIdentityReset = props.coordinatorNsec !== undefined || props.coordinatorNpub !== undefined;
    const handleQuestionnaireIdReset = (event: Event) => {
      const nextId = (event as CustomEvent<{ questionnaireId?: string }>).detail?.questionnaireId?.trim();
      setQuestionnaireId(nextId || generateQuestionnaireId());
    };
    const handleCoordinatorNewIdentity = () => {
      if (parentOwnsIdentityReset) {
        return;
      }
      setQuestionnaireId(resetStoredQuestionnaireDraftId());
    };
    window.addEventListener(QUESTIONNAIRE_ID_RESET_EVENT, handleQuestionnaireIdReset);
    window.addEventListener("auditable-voting:coordinator-new", handleCoordinatorNewIdentity);
    return () => {
      window.removeEventListener(QUESTIONNAIRE_ID_RESET_EVENT, handleQuestionnaireIdReset);
      window.removeEventListener("auditable-voting:coordinator-new", handleCoordinatorNewIdentity);
    };
  }, [props.coordinatorNpub, props.coordinatorNsec]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (view !== "build") {
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
      closeTimerUnit,
      questions,
      delegationMode,
      delegatedWorkerNpub,
      delegatedWorkerControlRelays,
      delegatedWorkerExpiryEnabled,
      delegatedWorkerExpiryMinutes,
      delegatedWorkerCapabilities,
      questionnaireRelays: questionnaireRelaysInput,
    };
    window.localStorage.setItem(
      buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DRAFT_DATA_STORAGE_KEY),
      JSON.stringify(snapshot),
    );
  }, [
    closeAfterMinutes,
    closeTimerEnabled,
    closeTimerUnit,
    delegatedWorkerCapabilities,
    delegatedWorkerControlRelays,
    delegatedWorkerExpiryEnabled,
    delegatedWorkerExpiryMinutes,
    delegatedWorkerNpub,
    delegationMode,
    description,
    questionnaireRelaysInput,
    questionnaireId,
    questions,
    title,
    view,
  ]);

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
      if (type === "rank") {
        return createRankQuestion(questionId, prompt, required ? 1 : 0);
      }
      if (type === "free_text") {
        return createFreeTextQuestion(questionId, prompt, required);
      }
      return createYesNoQuestion(questionId, prompt, required);
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

  function addQuestion() {
    setQuestions((current) => [...current, createYesNoQuestion(deriveNextQuestionId(current), "", true)]);
  }

  const resolveBlindSigningPublicKey = useCallback(() => {
    const fromProps = props.blindSigningPublicKey ?? null;
    if (fromProps) {
      return fromProps;
    }
    const electionId = questionnaireId.trim();
    const coordinator = coordinatorNpub.trim();
    if (!electionId || !coordinator) {
      return null;
    }
    const localState = loadCoordinatorState({
      coordinatorNpub: coordinator,
      electionId,
    });
    const fromPrivateKey = localState?.blindSigningPrivateKey
      ? toQuestionnaireBlindPublicKey(localState.blindSigningPrivateKey)
      : null;
    const resolved = fromPrivateKey
      ?? localState?.election.blindSigningPublicKey
      ?? loadElectionSummary(electionId)?.blindSigningPublicKey
      ?? null;
    if (resolved) {
      setRecoveredBlindSigningPublicKey(resolved);
    }
    return resolved;
  }, [coordinatorNpub, props.blindSigningPublicKey, questionnaireId]);

  useEffect(() => {
    setRecoveredBlindSigningPublicKey(props.blindSigningPublicKey ?? null);
    if (!props.blindSigningPublicKey) {
      resolveBlindSigningPublicKey();
    }
  }, [props.blindSigningPublicKey, resolveBlindSigningPublicKey]);

  const effectiveBlindSigningPublicKey = props.blindSigningPublicKey ?? recoveredBlindSigningPublicKey;

  const builtDefinition = useMemo(() => {
    if (!coordinatorNpub.trim() || !questionnaireId.trim()) {
      return null;
    }
    let closeMinutes: number | undefined;
    if (closeTimerEnabled) {
      const closeAmount = Number.parseFloat(closeAfterMinutes);
      if (!Number.isFinite(closeAmount) || closeAmount <= 0) {
        return null;
      }
      closeMinutes = closeAmount * closeTimerUnitToMinutes(closeTimerUnit);
    }
    return buildDefinition({
      questionnaireId: questionnaireId.trim(),
      coordinatorPubkey: coordinatorNpub,
      title: title.trim(),
      description: description.trim(),
      closeAfterMinutes: closeMinutes,
      questionnaireRelays: questionnaireRelayMetadata,
      questions,
      blindSigningPublicKey: effectiveBlindSigningPublicKey ?? null,
    });
  }, [closeAfterMinutes, closeTimerEnabled, closeTimerUnit, coordinatorNpub, description, effectiveBlindSigningPublicKey, questionnaireId, questionnaireRelayMetadata, questions, title]);

  const selectedWorkerStatus = useMemo(() => {
    const workerNpub = normaliseWorkerNpub(delegatedWorkerNpub);
    if (!workerNpub) {
      return null;
    }
    return availableWorkerStatuses.find((entry) => entry.workerNpub === workerNpub) ?? null;
  }, [availableWorkerStatuses, delegatedWorkerNpub]);

  const delegationStatusLabel = useMemo(() => {
    if (lastWorkerRevocationState === "revoked") {
      return "Revoked";
    }
    const active = activeWorkerDelegation;
    if (!active) {
      return "None";
    }
    const expiresAtMs = Date.parse(active.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      return "Expired";
    }
    if (selectedWorkerStatus?.delegationId === active.delegationId && selectedWorkerStatus.delegationState === "active") {
      return "Active";
    }
    return "Pending activation";
  }, [activeWorkerDelegation, lastWorkerRevocationState, selectedWorkerStatus]);
  const dashboardCoordinatorIdentity = useMemo(() => {
    const active = activeWorkerDelegation;
    if (active && lastWorkerRevocationState !== "revoked") {
      const expiresAtMs = Date.parse(active.expiresAt);
      const expired = Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
      if (!expired) {
        const workerNpub = selectedWorkerStatus?.delegationId === active.delegationId
          ? selectedWorkerStatus.workerNpub
          : active.workerNpub;
        return {
          label: "Proxy",
          text: normaliseWorkerNpub(workerNpub),
        };
      }
    }
    return {
      label: "Organiser",
      text: coordinatorNpub.trim() || "Unknown",
    };
  }, [activeWorkerDelegation, coordinatorNpub, lastWorkerRevocationState, selectedWorkerStatus]);
  const workerReleaseBaseUrl = "https://github.com/tidley/auditable-voting/releases/latest/download";
  const workerHelperDownloadUrl = `${workerReleaseBaseUrl}/auditable-voting-worker-linux-x64.tar.gz`;
  const workerHelperChecksumUrl = `${workerHelperDownloadUrl}.sha256`;
  const workerHelperReadmeUrl = useMemo(() => {
    const basePath = import.meta.env.BASE_URL || "/";
    const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
    return `${prefix}worker-helper/README.txt`;
  }, []);
  const workerAutoconfiguredLauncherPageUrl = useMemo(() => {
    const basePath = import.meta.env.BASE_URL || "/";
    const prefix = basePath.endsWith("/") ? basePath : `${basePath}/`;
    return `${prefix}worker-helper/autoconfigured.html`;
  }, []);
  const workerLinuxArm64DownloadUrl = `${workerReleaseBaseUrl}/auditable-voting-worker-linux-arm64.tar.gz`;
  const workerLinuxArm64ChecksumUrl = `${workerLinuxArm64DownloadUrl}.sha256`;
  const workerLinuxArmv7DownloadUrl = `${workerReleaseBaseUrl}/auditable-voting-worker-linux-armv7.tar.gz`;
  const workerLinuxArmv7ChecksumUrl = `${workerLinuxArmv7DownloadUrl}.sha256`;
  const workerWindowsDownloadUrl = `${workerReleaseBaseUrl}/auditable-voting-worker-windows-x64.zip`;
  const workerWindowsChecksumUrl = `${workerWindowsDownloadUrl}.sha256`;
  const workerMacOsArm64DownloadUrl = `${workerReleaseBaseUrl}/auditable-voting-worker-macos-arm64.tar.gz`;
  const workerMacOsArm64ChecksumUrl = `${workerMacOsArm64DownloadUrl}.sha256`;
  const helperRelayList = useMemo(
    () => parseDelegatedControlRelays(delegatedWorkerControlRelays).join(","),
    [delegatedWorkerControlRelays],
  );
  const workerLauncherTargets = useMemo<Record<string, WorkerLauncherTarget>>(() => ({
    linuxX64: {
      assetFilename: "auditable-voting-worker-linux-x64.tar.gz",
      assetUrl: workerHelperDownloadUrl,
      checksumUrl: workerHelperChecksumUrl,
      binaryFilename: "auditable-voting-worker-linux-x64",
      legacyBinaryFilename: "auditable-voting-worker",
      launcherFilename: "start-auditable-voting-worker-linux-x64.sh",
      shell: "bash",
    },
    linuxArm64: {
      assetFilename: "auditable-voting-worker-linux-arm64.tar.gz",
      assetUrl: workerLinuxArm64DownloadUrl,
      checksumUrl: workerLinuxArm64ChecksumUrl,
      binaryFilename: "auditable-voting-worker-linux-arm64",
      legacyBinaryFilename: "auditable-voting-worker",
      launcherFilename: "start-auditable-voting-worker-linux-arm64.sh",
      shell: "bash",
    },
    linuxArmv7: {
      assetFilename: "auditable-voting-worker-linux-armv7.tar.gz",
      assetUrl: workerLinuxArmv7DownloadUrl,
      checksumUrl: workerLinuxArmv7ChecksumUrl,
      binaryFilename: "auditable-voting-worker-linux-armv7",
      legacyBinaryFilename: "auditable-voting-worker",
      launcherFilename: "start-auditable-voting-worker-linux-armv7.sh",
      shell: "bash",
    },
    windowsX64: {
      assetFilename: "auditable-voting-worker-windows-x64.zip",
      assetUrl: workerWindowsDownloadUrl,
      checksumUrl: workerWindowsChecksumUrl,
      binaryFilename: "auditable-voting-worker-windows-x64.exe",
      legacyBinaryFilename: "auditable-voting-worker.exe",
      launcherFilename: "start-auditable-voting-worker-windows-x64.ps1",
      shell: "powershell",
    },
    macosArm64: {
      assetFilename: "auditable-voting-worker-macos-arm64.tar.gz",
      assetUrl: workerMacOsArm64DownloadUrl,
      checksumUrl: workerMacOsArm64ChecksumUrl,
      binaryFilename: "auditable-voting-worker-macos-arm64",
      legacyBinaryFilename: "auditable-voting-worker",
      launcherFilename: "start-auditable-voting-worker-macos-arm64.sh",
      shell: "bash",
    },
  }), [
    workerHelperDownloadUrl,
    workerHelperChecksumUrl,
    workerLinuxArm64DownloadUrl,
    workerLinuxArm64ChecksumUrl,
    workerLinuxArmv7DownloadUrl,
    workerLinuxArmv7ChecksumUrl,
    workerMacOsArm64DownloadUrl,
    workerMacOsArm64ChecksumUrl,
    workerWindowsDownloadUrl,
    workerWindowsChecksumUrl,
  ]);
  const downloadConfiguredWorkerLauncher = useCallback((target: WorkerLauncherTarget) => {
    const contents = buildWorkerLauncherContents({
      target,
      coordinatorNpub,
      workerNsec: generatedWorkerNsec,
      workerNpub: delegatedWorkerNpub,
      workerRelays: helperRelayList,
    });
    downloadTextFile(target.launcherFilename, contents, "text/plain;charset=utf-8");
  }, [coordinatorNpub, delegatedWorkerNpub, generatedWorkerNsec, helperRelayList]);
  const autoconfiguredWorkerLauncherHrefs = useMemo<Record<WorkerLauncherTargetKey, string>>(() => ({
    linuxX64: buildAutoconfiguredWorkerLauncherHref({
      baseUrl: workerAutoconfiguredLauncherPageUrl,
      targetKey: "linuxX64",
      coordinatorNpub,
      workerNpub: delegatedWorkerNpub,
      workerRelays: helperRelayList,
    }),
    linuxArm64: buildAutoconfiguredWorkerLauncherHref({
      baseUrl: workerAutoconfiguredLauncherPageUrl,
      targetKey: "linuxArm64",
      coordinatorNpub,
      workerNpub: delegatedWorkerNpub,
      workerRelays: helperRelayList,
    }),
    linuxArmv7: buildAutoconfiguredWorkerLauncherHref({
      baseUrl: workerAutoconfiguredLauncherPageUrl,
      targetKey: "linuxArmv7",
      coordinatorNpub,
      workerNpub: delegatedWorkerNpub,
      workerRelays: helperRelayList,
    }),
    windowsX64: buildAutoconfiguredWorkerLauncherHref({
      baseUrl: workerAutoconfiguredLauncherPageUrl,
      targetKey: "windowsX64",
      coordinatorNpub,
      workerNpub: delegatedWorkerNpub,
      workerRelays: helperRelayList,
    }),
    macosArm64: buildAutoconfiguredWorkerLauncherHref({
      baseUrl: workerAutoconfiguredLauncherPageUrl,
      targetKey: "macosArm64",
      coordinatorNpub,
      workerNpub: delegatedWorkerNpub,
      workerRelays: helperRelayList,
    }),
  }), [coordinatorNpub, delegatedWorkerNpub, helperRelayList, workerAutoconfiguredLauncherPageUrl]);
  const selectedWorkerLauncherTarget = workerLauncherTargets[selectedWorkerDownloadTarget];
  const workerDirectCommand = useMemo(() => buildWorkerDirectCommand({
    target: selectedWorkerLauncherTarget,
    coordinatorNpub,
    workerNsec: generatedWorkerNsec,
    workerRelays: helperRelayList,
  }), [coordinatorNpub, generatedWorkerNsec, helperRelayList, selectedWorkerLauncherTarget]);
  const workerStartupCommand = useMemo(() => {
    const coordinator = coordinatorNpub.trim() || "npub1...";
    const workerNsec = generatedWorkerNsec.trim() || "nsec1...";
    const relayOverride = delegatedWorkerControlRelays.trim();
    const lines = [
      "RUST_LOG=debug \\",
      `WORKER_NSEC=${workerNsec} \\`,
      `  COORDINATOR_NPUB=${coordinator} \\`,
    ];
    if (relayOverride) {
      lines.push(`  WORKER_RELAYS=${helperRelayList} \\`);
    }
    lines.push("  ./auditable-voting-worker-linux-x64");
    return lines.join("\n");
  }, [coordinatorNpub, delegatedWorkerControlRelays, generatedWorkerNsec, helperRelayList]);
  const lastParticipantCountPublishKeyRef = useRef("");

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
    if (view === "build" && builtDefinition && publishValidation?.valid) {
      storeCachedQuestionnaireDefinition(builtDefinition);
    }
  }, [builtDefinition, publishValidation?.valid, view]);
  const canPublishDraft = Boolean(
    builtDefinition
    && coordinatorNsec.trim()
    && publishValidation?.valid
    && publishPreconditionsReady,
  );
  const latestDefinitionMatchesDraft = publishedDefinitionMatchesDraft(latestDefinition, builtDefinition);
  const publishedDefinition = latestDefinitionMatchesDraft;
  const activePublishedDefinition = publishedDefinition ? latestDefinition : null;
  const currentState: QuestionnaireStateValue = activePublishedDefinition ? (latestState ?? "draft") : "draft";
  const activeStateEvent = activePublishedDefinition ? latestStateEvent : null;
  const canOpenQuestionnaire = currentState !== "open" && Boolean(activePublishedDefinition) && coordinatorNsec.trim() && coordinatorNpub.trim();
  const canCloseQuestionnaire = currentState === "open" && Boolean(activePublishedDefinition) && coordinatorNsec.trim() && coordinatorNpub.trim();
  const canPublishResults = Boolean(
    activePublishedDefinition
    && coordinatorNsec.trim()
    && coordinatorNpub.trim()
    && (currentState === "closed" || currentState === "results_published"),
  );
  useEffect(() => {
    if (!publishedDefinition || !coordinatorNsec.trim() || !coordinatorNpub.trim() || !questionnaireId.trim()) {
      return;
    }
    void publishParticipantCountSnapshot({ silent: true });
  }, [coordinatorNsec, coordinatorNpub, publishedDefinition, props.knownVoterCount, questionnaireId]);
  useEffect(() => {
    props.onStatusChange?.({
      questionnaireId: questionnaireId.trim(),
      state: currentState,
      acceptedCount: latestAcceptedCount,
      rejectedCount: latestRejectedCount,
      payloadMode: "Encrypted",
    });
  }, [currentState, latestAcceptedCount, latestRejectedCount, props.onStatusChange, questionnaireId]);
  const acceptedResponsesForDisplay = useMemo(() => (
    mergeAcceptedResponsesForCoordinator([
      ...latestAcceptedResponses,
      ...(props.optionAAcceptedResponses ?? []),
    ])
  ), [latestAcceptedResponses, props.optionAAcceptedResponses]);
  const displayAcceptedCount = Math.max(acceptedResponsesForDisplay.length, props.optionAAcceptedCount ?? 0);
  const knownVoterCount = props.knownVoterCount ?? 0;
  const buildStateLabel = !publishedDefinition
    ? "Draft"
    : activeStateEvent?.state === "closed" && activeStateEvent.closedBy === "audit_proxy"
      ? "Closed by audit proxy"
      : currentState === "results_published"
        ? "Counted"
        : currentState === "closed"
          ? "Ended"
          : currentState === "open"
          ? "Open"
          : "Draft";
  const setupHeadingStateLabel = isNewRoundMode && !publishedDefinition
    ? "New round"
    : buildStateLabel === "Open" ? "Active" : buildStateLabel;
  const checklistDescriptionAdded = description.trim().length > 0;
  const selectedQuestionnaireOptions = availableQuestionnaireIds.length > 0
    ? availableQuestionnaireIds
    : (questionnaireId.trim() ? [questionnaireId.trim()] : []);
  const questionnaireOptionLabel = (id: string) => {
    const selectedId = questionnaireId.trim();
    const selectedPublishedTitle = activePublishedDefinition?.questionnaireId === selectedId
      ? activePublishedDefinition.title.trim()
      : "";
    const selectedDraftTitle = view === "build" && id === selectedId
      ? title.trim()
      : "";
    const labelTitle = availableQuestionnaireTitles[id]?.trim()
      || (id === selectedId ? selectedPublishedTitle || selectedDraftTitle : "");
    return labelTitle ? `${labelTitle} - ${id}` : id;
  };
  const coordinatorQuestionSummaries = useMemo(() => {
    if (!activePublishedDefinition) {
      return [];
    }
    return buildQuestionnaireResultSummary({
      definition: activePublishedDefinition,
      coordinatorPubkey: coordinatorNpub.trim(),
      acceptedResponses: acceptedResponsesForDisplay,
      rejectedResponses: [],
    }).questionSummaries;
  }, [acceptedResponsesForDisplay, activePublishedDefinition, coordinatorNpub]);
  const coordinatorResponseDetails = useMemo<QuestionnaireResultsDashboardResponseDetail[]>(() => (
    acceptedResponsesForDisplay.map((response) => ({
      event: {
        id: response.eventId,
        created_at: response.payload.submittedAt,
      },
      accepted: true,
      includedInLatestPublish: currentState === "results_published",
      decryptedAnswerQuestionIds: deriveAcceptedResponseDecryptedAnswerQuestionIds(response),
      response: {
        responseId: response.payload.responseId,
        authorPubkey: response.authorPubkey,
        submittedAt: response.payload.submittedAt,
        answers: response.payload.answers,
      },
    }))
  ), [acceptedResponsesForDisplay, currentState]);
  const questionResultCards = useMemo(() => {
    if (!activePublishedDefinition) {
      return [];
    }
    const acceptedTotal = acceptedResponsesForDisplay.length;
    return activePublishedDefinition.questions.map((question, index) => {
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

      if (question.type === "rank") {
        const optionScores = new Map(question.options.map((option) => [option.optionId, 0]));
        const rankCounts = new Map(question.options.map((option) => [option.optionId, new Map<number, number>()]));
        let blankResponseCount = 0;
        for (const response of acceptedResponsesForDisplay) {
          const answer = response.payload.answers.find((entry) => entry.questionId === question.questionId);
          const rankedOptionIds = answer?.answerType === "rank"
            ? normaliseRankedOptionIds(question, answer.rankedOptionIds)
            : [];
          if (rankedOptionIds.length === 0) {
            blankResponseCount += 1;
          }
          const scores = calculateRankQuestionScores(question, rankedOptionIds);
          for (const [optionId, score] of Object.entries(scores)) {
            optionScores.set(optionId, (optionScores.get(optionId) ?? 0) + score);
            const counts = rankCounts.get(optionId);
            if (counts) {
              counts.set(score, (counts.get(score) ?? 0) + 1);
            }
          }
        }
        const rows = question.options
          .map((option) => ({
            optionId: option.optionId,
            label: option.label,
            score: optionScores.get(option.optionId) ?? 0,
            firstChoiceCount: rankCounts.get(option.optionId)?.get(question.options.length) ?? 0,
          }))
          .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));
        return {
          questionId: question.questionId,
          index,
          prompt: question.prompt,
          typeBadge: "Ranked",
          kind: "rank" as const,
          rows,
          acceptedTotal,
          blankResponseCount,
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
  }, [acceptedResponsesForDisplay, activePublishedDefinition, coordinatorNsec]);
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
  const canExportResults = currentState === "results_published" && Boolean(activePublishedDefinition);
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
    if (currentState === "results_published") {
      if (latestResultAcceptedCount !== null && latestResultAcceptedCount !== displayAcceptedCount) {
        return "Summary needs update";
      }
      return null;
    }
    if (displayAcceptedCount > 0 && currentState === "open") {
      return null;
    }
    if (displayAcceptedCount <= 0) {
      return null;
    }
    if (canPublishResults) {
      return "Ready to publish";
    }
    return null;
  }, [canPublishResults, currentState, displayAcceptedCount, isCloseAndPublishInFlight, latestResultAcceptedCount, status]);

  function exportResults() {
    const id = questionnaireId.trim();
    const definition = activePublishedDefinition;
    if (!id || !definition || currentState !== "results_published") {
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
        title: definition.title,
        description: definition.description,
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

  async function publishDefinition(options?: { applyAdmissions?: boolean }) {
    let definitionToPublish = builtDefinition;
    if (!coordinatorNsec.trim() || !definitionToPublish) {
      setStatus("Organiser key or vote setup is missing.");
      return;
    }

    if (!publishPreconditionsReady) {
      setStatus("Publish draft is blocked until all readiness checks are complete.");
      return;
    }

    if (!definitionToPublish.blindSigningPublicKey) {
      const recoveredKey = resolveBlindSigningPublicKey();
      if (recoveredKey) {
        definitionToPublish = {
          ...definitionToPublish,
          blindSigningPublicKey: recoveredKey,
        };
      }
    }

    if (!definitionToPublish.blindSigningPublicKey) {
      setStatus(BLIND_SIGNING_KEY_RELOAD_STATUS);
      return;
    }

    const validation = validateQuestionnaireDefinition(definitionToPublish);
    if (!validation.valid) {
      setStatus(`Definition invalid: ${validation.errors[0] ?? "unknown_error"}.`);
      return;
    }

    setStatus("Publishing vote...");
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
        definition: definitionToPublish,
        relays: questionnaireRelayPublishHints,
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
        storeCachedQuestionnaireDefinition(definitionToPublish);
        upsertElectionSummary({
          electionId: definitionToPublish.questionnaireId,
          title: definitionToPublish.title,
          description: definitionToPublish.description ?? "",
          state: "open",
          openedAt: new Date(definitionToPublish.openAt * 1000).toISOString(),
          closedAt: new Date(definitionToPublish.closeAt * 1000).toISOString(),
          coordinatorNpub: definitionToPublish.coordinatorPubkey,
          blindSigningPublicKey: definitionToPublish.blindSigningPublicKey ?? null,
          questionnaireRelays: definitionToPublish.questionnaireRelays,
          issueBlindTokensWorker: loadElectionSummary(definitionToPublish.questionnaireId)?.issueBlindTokensWorker ?? null,
          protocolVersion: definitionToPublish.protocolVersion,
          flowMode: definitionToPublish.flowMode,
          responseMode: definitionToPublish.responseMode,
        });
        setDefinitionPublishSucceededAt(new Date().toISOString());
        setStatus(`Vote published (${result.successes}/${result.relayResults.length} relays).`);
        await publishParticipantCountSnapshot({ silent: true });
        await publishState("open");
        const shouldConfigureWorker = delegationMode === "delegated_worker"
          && Boolean(normaliseWorkerNpub(delegatedWorkerNpub));
        if (shouldConfigureWorker) {
          setStatus("Vote published. Configuring audit proxy...");
          await delegateToWorker({ statusPrefix: "Vote published." });
        }
        let admissionsApplied = true;
        if (options?.applyAdmissions) {
          try {
            await props.onAfterPublishQuestionnaire?.(definitionToPublish.questionnaireId);
          } catch (error) {
            admissionsApplied = false;
            setStatus(
              `Vote published, but invited voters could not be applied: ${error instanceof Error ? error.message : "unknown error"}.`,
            );
          }
        }
        if (!admissionsApplied) {
          return;
        }
      } else {
        setStatus("Vote publish failed.");
        await refresh();
      }
    } catch {
      setDefinitionPublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus("Vote publish failed.");
    }
  }

  async function publishParticipantCountSnapshot(input?: { silent?: boolean }) {
    const id = questionnaireId.trim();
    const coordinatorNsecTrimmed = coordinatorNsec.trim();
    const coordinatorNpubTrimmed = coordinatorNpub.trim();
    if (!id || !coordinatorNsecTrimmed || !coordinatorNpubTrimmed) {
      return false;
    }
    const expectedInviteeCount = Math.max(0, Math.floor(props.knownVoterCount ?? 0));
    const dedupeKey = `${id}:${expectedInviteeCount}:${(questionnaireRelayPublishHints ?? []).join(",")}`;
    if (input?.silent && lastParticipantCountPublishKeyRef.current === dedupeKey) {
      return true;
    }

    try {
      const result = await publishQuestionnaireParticipantCount({
        coordinatorNsec: coordinatorNsecTrimmed,
        participantCount: {
          schemaVersion: 1,
          eventType: "questionnaire_participant_count",
          questionnaireId: id,
          expectedInviteeCount,
          createdAt: nowUnix(),
          coordinatorPubkey: coordinatorNpubTrimmed,
        },
        relays: questionnaireRelayPublishHints,
      });
      if (result.successes > 0) {
        lastParticipantCountPublishKeyRef.current = dedupeKey;
      }
      if (!input?.silent) {
        setStatus(
          result.successes > 0
            ? `Expected participant count published (${expectedInviteeCount}).`
            : "Expected participant count publish failed.",
        );
      }
      return result.successes > 0;
    } catch {
      if (!input?.silent) {
        setStatus("Expected participant count publish failed.");
      }
      return false;
    }
  }

  async function publishState(state: QuestionnaireStateValue) {
    const id = questionnaireId.trim();
    if (!coordinatorNsec.trim() || !coordinatorNpub.trim() || !id) {
      setStatus("Organiser key or vote ID is missing.");
      return false;
    }

    setStatus(`Publishing vote state (${state})...`);
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
        relays: questionnaireRelayPublishHints,
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
          ? `Vote state '${state}' published (${result.successes}/${result.relayResults.length} relays).`
          : `Vote state '${state}' publish failed.`,
      );
      await refresh();
      return result.successes > 0;
    } catch {
      setStatePublishDiagnostic((current) => ({ ...current, attempted: true, succeeded: false }));
      setStatus(`Vote state '${state}' publish failed.`);
      return false;
    }
  }

  async function publishResults() {
    const definition = activePublishedDefinition;
    if (!definition || !coordinatorNsec.trim() || !coordinatorNpub.trim()) {
      setStatus("Load the vote before publishing results.");
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
      const usePublicSubmissionFlow = definition.flowMode === QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1;
      let summary: QuestionnaireResultSummary;
      let responsePublishSuccessCount = 0;
      let responsePublishAttemptCount = 0;

      if (usePublicSubmissionFlow) {
        const [publicResponses, decisionEntries] = await Promise.all([
          fetchQuestionnaireBlindResponses({
            questionnaireId: definition.questionnaireId,
            limit: 500,
            relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
          }).catch(() => []),
          fetchQuestionnaireSubmissionDecisions({
            questionnaireId: definition.questionnaireId,
            limit: 500,
            relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
          }).catch(() => []),
        ]);
        const verifiedResponseIds = await verifyQuestionnaireBlindResponseProofs({
          entries: publicResponses,
          publicKey: definition.blindSigningPublicKey ?? effectiveBlindSigningPublicKey ?? null,
        });
        const admissions = evaluateQuestionnaireBlindAdmissions({
          entries: publicResponses,
          decisionEntries,
          verifiedResponseIds,
        });
        const acceptedResponses = admissions.accepted.map((entry) => publicBlindResponseToAcceptedResponse({
          entry,
          coordinatorNsec,
          coordinatorNpub,
        }));
        const acceptedResponseById = new Map(
          acceptedResponses.map((response) => [response.payload.responseId, response]),
        );
        const rejectedResponses = admissions.rejected.map((entry) => ({
          eventId: entry.event.id,
          authorPubkey: entry.response.authorPubkey,
          responseId: entry.response.responseId,
          reason: toRejectedReasonFromDecision(entry.rejectionReason ?? "invalid_payload_shape"),
          detail: entry.rejectionReason ?? undefined,
        }));
        summary = buildQuestionnaireResultSummary({
          definition,
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
            answers: entry.accepted
              ? acceptedResponseById.get(entry.response.responseId)?.payload.answers
              : entry.response.answers,
          }))
          .filter((entry) => entry.responseId.trim().length > 0);
      } else {
        const responseEvents = (await fetchQuestionnaireEventsWithFallback({
          questionnaireId: definition.questionnaireId,
          kind: QUESTIONNAIRE_RESPONSE_PRIVATE_KIND,
          parseQuestionnaireIdFromEvent: (event) => parseQuestionnaireIdFromResponseEvent(event),
          preferKindOnly: true,
          relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
          readRelayLimit: 8,
        })).events;
        const processed = processQuestionnaireResponses({
          definition,
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
          questionnaireId: definition.questionnaireId,
          limit: 500,
          relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
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
            questionnaireId: definition.questionnaireId,
            responseId,
            submittedAt: response.payload.submittedAt,
            authorPubkey: response.authorPubkey,
            tokenNullifier,
            tokenCommitment,
            answers: response.payload.answers,
            questionnaireDefinitionEventId: null,
            relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
          });
          if (publishedResponse.successes > 0) {
            responsePublishSuccessCount += 1;
          }
        }

        summary = buildQuestionnaireResultSummary({
          definition,
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
        relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
      });
      const publishStateResult = await publishQuestionnaireState({
        coordinatorNsec,
        stateEvent: {
          schemaVersion: 1,
          eventType: "questionnaire_state",
          questionnaireId: definition.questionnaireId,
          state: "results_published",
          createdAt: nowUnix(),
          coordinatorPubkey: coordinatorNpub,
        },
        relays: definition.questionnaireRelays ?? questionnaireRelayPublishHints,
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
    if (!activePublishedDefinition) {
      setStatus("Load the vote before publishing results.");
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
          setStatus("Could not close vote, so results were not published.");
          return;
        }
      }
      await publishResults();
    } finally {
      setIsCloseAndPublishInFlight(false);
    }
  }

  async function delegateToWorker(options?: { statusPrefix?: string }) {
    const electionId = questionnaireId.trim();
    const coordinatorNsecTrimmed = coordinatorNsec.trim();
    const coordinatorNpubTrimmed = coordinatorNpub.trim();
    const workerNpub = normaliseWorkerNpub(delegatedWorkerNpub);
    const expiryMinutes = delegatedWorkerExpiryEnabled
      ? Number.parseInt(delegatedWorkerExpiryMinutes, 10)
      : Number.NaN;
    if (!electionId || !coordinatorNsecTrimmed || !coordinatorNpubTrimmed) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Organiser identity and questionnaire ID are required before delegation.`);
      return;
    }
    if (!workerNpub) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Enter a valid audit proxy npub.`);
      return;
    }
    if (delegatedWorkerExpiryEnabled && (!Number.isFinite(expiryMinutes) || expiryMinutes <= 0)) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Delegation expiry must be a positive number of minutes.`);
      return;
    }
    if (delegatedWorkerCapabilities.length === 0) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Select at least one audit proxy capability.`);
      return;
    }
    const controlRelays = parseDelegatedControlRelays(delegatedWorkerControlRelays);
    if (controlRelays.length === 0) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Enter at least one audit proxy control relay.`);
      return;
    }
    const delegation = createWorkerDelegationCertificate({
      electionId,
      coordinatorNpub: coordinatorNpubTrimmed,
      workerNpub,
      capabilities: delegatedWorkerCapabilities,
      controlRelays,
      expiresAt: new Date(
        Date.now() + (
          delegatedWorkerExpiryEnabled
            ? expiryMinutes
            : QUESTIONNAIRE_TIMER_DISABLED_CLOSE_MINUTES
        ) * 60 * 1000,
      ).toISOString(),
    });
    const needsElectionConfigDm = delegatedWorkerCapabilities.includes("issue_blind_tokens")
      || delegatedWorkerCapabilities.includes("close_questionnaire")
      || delegatedWorkerCapabilities.includes("publish_result_summary");
    const coordinatorState = needsElectionConfigDm
      ? loadCoordinatorState({
        coordinatorNpub: coordinatorNpubTrimmed,
        electionId,
      })
      : null;
    if (delegatedWorkerCapabilities.includes("issue_blind_tokens") && !coordinatorState?.blindSigningPrivateKey) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Blind-signing private key is not available yet. Publish the vote and try again.`);
      return;
    }
    const whitelistNpubs = Object.keys(coordinatorState?.whitelist ?? {})
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const bearerInviteCodes = Object.values(coordinatorState?.bearerInviteCodes ?? {});
    const unclaimedPrivateInviteCount = bearerInviteCodes
      .filter((entry) => entry.state !== "revoked")
      .filter((entry) => {
        const redeemedNpub = entry.redeemedNpub?.trim() ?? "";
        return !redeemedNpub || !whitelistNpubs.includes(redeemedNpub);
      }).length;
    const expectedInviteeCount = Math.max(0, props.knownVoterCount ?? 0, whitelistNpubs.length) + unclaimedPrivateInviteCount;
    const workerElectionConfigSnapshot: WorkerElectionConfigSnapshot | null = needsElectionConfigDm
      ? {
        type: "worker_election_config",
        schemaVersion: 1,
        electionId,
        delegationId: delegation.delegationId,
        coordinatorNpub: coordinatorNpubTrimmed,
        workerNpub,
        expectedInviteeCount,
        whitelistNpubs,
        bearerInviteCodes,
        eligibilityRequired: delegatedWorkerCapabilities.includes("issue_blind_tokens"),
        blindSigningPrivateKey: delegatedWorkerCapabilities.includes("issue_blind_tokens")
          ? coordinatorState?.blindSigningPrivateKey ?? null
          : null,
        definition: activePublishedDefinition ?? readCachedQuestionnaireDefinition(electionId),
        sentAt: new Date().toISOString(),
      }
      : null;
    setStatus("Publishing audit proxy delegation...");
    try {
      const publicResult = await publishWorkerDelegationCertificate({
        coordinatorNsec: coordinatorNsecTrimmed,
        delegation,
        relays: controlRelays,
      });
      const dmResult = await publishOptionAWorkerDelegationDm({
        signer: createSignerService(),
        recipientNpub: workerNpub,
        delegation,
        fallbackNsec: coordinatorNsecTrimmed,
        relays: controlRelays,
      });
      let configResultSummary = "";
      if (workerElectionConfigSnapshot) {
        const configDmResult = await publishOptionAWorkerElectionConfigDm({
          signer: createSignerService(),
          recipientNpub: workerNpub,
          snapshot: workerElectionConfigSnapshot,
          fallbackNsec: coordinatorNsecTrimmed,
          relays: controlRelays,
        });
        configResultSummary = `, ${configDmResult.successes} config DM relay successes`;
      }
      setActiveWorkerDelegation(delegation);
      setLastWorkerRevocationState("pending_activation");
      upsertStoredWorkerDelegation({
        electionId,
        mode: "delegated_worker",
        activeDelegation: delegation,
        lastRevocation: null,
        lastUpdatedAt: new Date().toISOString(),
      });
      const existingSummary = loadElectionSummary(electionId);
      if (existingSummary) {
        upsertElectionSummary({
          ...existingSummary,
          issueBlindTokensWorker: delegatedWorkerCapabilities.includes("issue_blind_tokens")
            ? buildIssueBlindTokensWorkerRouting({
              delegationId: delegation.delegationId,
              workerNpub: delegation.workerNpub,
              controlRelays: delegation.controlRelays,
              expiresAt: delegation.expiresAt,
            })
            : null,
        });
      }
      setStatus(
        `${options?.statusPrefix ? `${options.statusPrefix} ` : ""}Audit proxy configured (${publicResult.successes} public relay successes, ${dmResult.successes} delegation DM relay successes${configResultSummary}).`,
      );
    } catch (error) {
      setStatus(`${options?.statusPrefix ? `${options.statusPrefix} ` : ""}${error instanceof Error ? error.message : "Audit proxy configuration failed."}`);
    }
  }

  async function revokeWorkerDelegation() {
    const electionId = questionnaireId.trim();
    const coordinatorNsecTrimmed = coordinatorNsec.trim();
    const coordinatorNpubTrimmed = coordinatorNpub.trim();
    const active = activeWorkerDelegation;
    if (!active || !electionId || !coordinatorNsecTrimmed || !coordinatorNpubTrimmed) {
      setStatus("No active audit proxy delegation to revoke.");
      return;
    }
    const revocation = createWorkerDelegationRevocation({
      delegationId: active.delegationId,
      electionId,
      coordinatorNpub: coordinatorNpubTrimmed,
      workerNpub: active.workerNpub,
      reason: "revoked_by_coordinator",
    });
    const controlRelays = active.controlRelays.length > 0
      ? active.controlRelays
      : parseDelegatedControlRelays(delegatedWorkerControlRelays);
    setStatus("Publishing audit proxy revocation...");
    try {
      const publicResult = await publishWorkerDelegationRevocation({
        coordinatorNsec: coordinatorNsecTrimmed,
        revocation,
        relays: controlRelays,
      });
      const dmResult = await publishOptionAWorkerDelegationRevocationDm({
        signer: createSignerService(),
        recipientNpub: active.workerNpub,
        revocation,
        fallbackNsec: coordinatorNsecTrimmed,
        relays: controlRelays,
      });
      setLastWorkerRevocationState("revoked");
      setActiveWorkerDelegation(null);
      upsertStoredWorkerDelegation({
        electionId,
        mode: "browser_only",
        activeDelegation: null,
        lastRevocation: revocation,
        lastUpdatedAt: new Date().toISOString(),
      });
      const existingSummary = loadElectionSummary(electionId);
      if (existingSummary) {
        upsertElectionSummary({
          ...existingSummary,
          issueBlindTokensWorker: null,
        });
      }
      setStatus(
        `Audit proxy revocation published (${publicResult.successes} public relay successes, ${dmResult.successes} DM relay successes).`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Audit proxy revocation failed.");
    }
  }

  function generateWorkerCredentials() {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    const npub = nip19.npubEncode(getPublicKey(secretKey));
    setGeneratedWorkerNsec(nsec);
    setGeneratedWorkerNpub(npub);
    setDelegatedWorkerNpub(npub);
  }

  function setupAuditProxyFromChecklist() {
    setDelegationMode("delegated_worker");
    setAuditProxyExpandSignal((current) => current + 1);
    generateWorkerCredentials();
    props.onConfigureWorker?.();
  }

  const hasAutoGeneratedWorkerCredentials = useRef(false);

  useEffect(() => {
    if (view !== "build" || hasAutoGeneratedWorkerCredentials.current) {
      return;
    }
    if (generatedWorkerNpub.trim() || generatedWorkerNsec.trim() || delegatedWorkerNpub.trim()) {
      return;
    }
    hasAutoGeneratedWorkerCredentials.current = true;
    generateWorkerCredentials();
  }, [delegatedWorkerNpub, generatedWorkerNpub, generatedWorkerNsec, generateWorkerCredentials, view]);

  const hasParticipantsNotice = Boolean((publishValidation && !publishValidation.valid) || statusNotice);
  const showNewRoundPublishOnly = isNewRoundMode && !publishedDefinition;
  if (view === "participants") {
    if (!hasParticipantsNotice) {
      return null;
    }
    return (
      <div className='simple-voter-card simple-questionnaire-panel'>
        {publishValidation && !publishValidation.valid ? (
          <p className='simple-voter-note'>Validation: {publishValidation.errors[0] ?? "unknown_error"}.</p>
        ) : null}
        {statusNotice}
      </div>
    );
  }

  if (view === "responses") {
    const sessionTopControls = (
      <div className='simple-session-controlbar'>
        <select
          id='questionnaire-select'
          className='simple-voter-input simple-session-questionnaire-select'
          value={questionnaireId}
          aria-label='Questionnaire'
          onChange={(event) => setQuestionnaireId(event.target.value)}
        >
          {selectedQuestionnaireOptions.map((id) => (
            <option key={id} value={id}>{questionnaireOptionLabel(id)}</option>
          ))}
        </select>
        <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight simple-session-control-actions'>
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
      </div>
    );

    return (
      <>
        <div className='simple-session-page-toolbar'>
          {sessionTopControls}
        </div>
        <QuestionnaireResultsDashboard
          variant='session'
          questionnaire={activePublishedDefinition ? {
            questionnaireId: activePublishedDefinition.questionnaireId,
            title: activePublishedDefinition.title || "Untitled questionnaire",
            description: activePublishedDefinition.description ?? "",
            createdAt: activePublishedDefinition.createdAt,
            openAt: activePublishedDefinition.openAt,
            closeAt: activePublishedDefinition.closeAt,
            closedAt: currentState === "closed" || currentState === "results_published" ? latestStateCreatedAt : null,
            state: currentState,
            questions: activePublishedDefinition.questions,
          } : null}
          questionSummaries={coordinatorQuestionSummaries}
          responseDetails={coordinatorResponseDetails}
          displayValidCount={displayAcceptedCount}
          displayInvalidCount={latestRejectedCount}
          coordinatorLabel={dashboardCoordinatorIdentity.label}
          coordinatorText={dashboardCoordinatorIdentity.text}
          publishedAtLabel='Published'
          publishedAtTime={activePublishedDefinition?.createdAt ?? null}
          emptyQuestionSummaryText='No question results yet.'
          emptySelectionText='Publish a questionnaire to inspect results.'
          emptyResponsesText='No submitted responses found for this questionnaire yet.'
          emptyResponseSelectionText='Publish a questionnaire to inspect responses.'
        />

        {publishStatusText ? <p className='simple-voter-note'>{publishStatusText}</p> : null}
        {status ? <p className='simple-voter-note'>{status}</p> : null}
      </>
    );
  }

  return (
    <>
      <section className='simple-voter-section simple-questionnaire-build-section'>
        <h2 className='simple-voter-section-title'>
          {setupHeadingStateLabel}{title.trim() ? `: ${title.trim()}` : ""}
        </h2>
        <div className='simple-questionnaire-build-grid'>
          <div className='simple-questionnaire-build-main'>
            <div className='simple-voter-card simple-questionnaire-panel simple-questionnaire-build-card'>
      <section className='simple-questionnaire-build-cardlet'>
        <h3 className='simple-questionnaire-cardlet-title'>Basic information</h3>
      <div className='simple-questionnaire-identity-grid'>
        <div className='simple-questionnaire-form-field'>
          <div className='simple-questionnaire-field-heading'>
            <label className='simple-voter-label' htmlFor='questionnaire-title'>Name</label>
          </div>
          <input
            id='questionnaire-title'
            className='simple-voter-input'
            value={title}
            placeholder='Vote name'
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className='simple-questionnaire-id-panel'>
          <div className='simple-questionnaire-field-heading'>
            <label className='simple-voter-label' htmlFor='questionnaire-id'>Questionnaire ID</label>
          </div>
          <div className='simple-questionnaire-id-row'>
            <input
              id='questionnaire-id'
              className='simple-voter-input simple-voter-input-inline'
              value={questionnaireId}
              readOnly={isNewRoundMode}
              onChange={(event) => setQuestionnaireId(event.target.value)}
            />
            {!isNewRoundMode ? (
              <div className='simple-questionnaire-id-actions'>
                <button type='button' className='simple-voter-secondary simple-questionnaire-copy-id-button' onClick={() => void tryWriteClipboard(questionnaireId)}>
                  Copy ID
                </button>
                <button type='button' className='simple-voter-secondary simple-questionnaire-generate-id-button' onClick={regenerateQuestionnaireId}>
                  Generate ID
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className='simple-questionnaire-form-field'>
        <label className='simple-voter-label' htmlFor='questionnaire-description'>Description</label>
        <textarea
          id='questionnaire-description'
          className='simple-voter-input'
          rows={3}
          value={description}
          placeholder='Short description'
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      </section>

      <section className='simple-questionnaire-build-cardlet'>
        <h3 className='simple-questionnaire-cardlet-title'>Configuration</h3>
      <section className='simple-questionnaire-setup-subsection'>
        <div className='simple-questionnaire-close-timer-row'>
          <label className={`simple-questionnaire-close-timer-toggle${closeTimerEnabled ? " is-on" : ""}`} htmlFor='questionnaire-close-timer-enabled'>
            <span>Enable close timer</span>
            <input
              id='questionnaire-close-timer-enabled'
              type='checkbox'
              role='switch'
              aria-checked={closeTimerEnabled}
              checked={closeTimerEnabled}
              onChange={(event) => setCloseTimerEnabled(event.target.checked)}
            />
            <span className='simple-questionnaire-switch' aria-hidden='true'>
              <span className='simple-questionnaire-switch-knob' />
            </span>
          </label>
          <div className={`simple-questionnaire-close-timer-minutes${closeTimerEnabled ? "" : " is-disabled"}`}>
            <label className='simple-voter-label simple-voter-label-tight' htmlFor='questionnaire-close-minutes'>
              Close after
            </label>
            <input
              id='questionnaire-close-minutes'
              className='simple-voter-input simple-voter-input-inline simple-questionnaire-close-timer-input'
              value={closeAfterMinutes}
              disabled={!closeTimerEnabled}
              inputMode='numeric'
              onChange={(event) => setCloseAfterMinutes(event.target.value)}
            />
            <fieldset className='simple-questionnaire-close-timer-units' disabled={!closeTimerEnabled}>
              <legend>Close timer unit</legend>
              {CLOSE_TIMER_UNITS.map((entry) => (
                <label
                  key={entry.value}
                  className={`simple-questionnaire-close-timer-unit-option${closeTimerUnit === entry.value ? " is-selected" : ""}`}
                >
                  <input
                    type='radio'
                    name='questionnaire-close-timer-unit'
                    value={entry.value}
                    checked={closeTimerUnit === entry.value}
                    onChange={() => setCloseTimerUnit(entry.value)}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </fieldset>
          </div>
        </div>
      </section>

      <section className='simple-questionnaire-setup-subsection'>
        <div className='simple-questionnaire-relay-row'>
          <label className={`simple-relay-default-toggle${setupRelaySettingsEnabled ? " is-on" : ""}`}>
            <span>Use custom relays</span>
            <input
              type='checkbox'
              role='switch'
              aria-checked={setupRelaySettingsEnabled}
              checked={setupRelaySettingsEnabled}
              onChange={(event) => {
                const useCustomRelays = event.target.checked;
                setUseDefaultSetupRelays(!useCustomRelays);
                if (!useCustomRelays) {
                  props.onQuestionnaireRelaysInputChange?.("");
                }
              }}
            />
            <span className='simple-questionnaire-switch' aria-hidden='true'>
              <span className='simple-questionnaire-switch-knob' />
            </span>
          </label>
          {props.onConfigureQuestionnaireRelays ? (
            <button
              type='button'
              className='simple-voter-secondary simple-questionnaire-relay-settings-button'
              onClick={props.onConfigureQuestionnaireRelays}
              disabled={!setupRelaySettingsEnabled}
            >
              Open relay settings
            </button>
          ) : null}
        </div>
        {questionnaireRelayStatus ? (
          <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
            <p className='simple-voter-note'>{questionnaireRelayStatus}</p>
          </div>
        ) : null}
      </section>
      </section>

      <div className='simple-questionnaire-questions-head'>
        <h4 className='simple-voter-section-title simple-questionnaire-questions-title'>Questions</h4>
        <span>{questions.length} {questions.length === 1 ? "question" : "questions"} defined</span>
      </div>
      <div className='simple-questionnaire-question-list'>
        {questions.map((question, index) => {
          const canMoveUp = index > 0;
          const canMoveDown = index < questions.length - 1;

          return (
            <div key={`${question.questionId}-${index}`} className='simple-questionnaire-question-card'>
              <div className='simple-questionnaire-question-head'>
                <div className='simple-questionnaire-question-title-row'>
                  <p className='simple-voter-question simple-questionnaire-question-title'>Question {index + 1}</p>
                  <select
                    className='simple-voter-input simple-questionnaire-type-dropdown'
                    aria-label={`Question ${index + 1} type`}
                    value={question.type}
                    onChange={(event) => setQuestionType(index, event.target.value as QuestionnaireQuestionDraft["type"])}
                  >
                    {QUESTION_TYPE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
                <label className={`simple-questionnaire-required-toggle${question.required ? " is-on" : ""}`}>
                  <span>Required</span>
                  <input
                    type='checkbox'
                    role='switch'
                    aria-checked={question.required}
                    checked={question.required}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      updateQuestion(index, (entry) => {
                        if (entry.type === "rank") {
                          const minimumRanked = checked
                            ? Math.max(1, Math.min(entry.options.length, entry.minimumRanked || 1))
                            : 0;
                          return { ...entry, minimumRanked, required: minimumRanked > 0 };
                        }
                        return { ...entry, required: checked };
                      });
                    }}
                  />
                  <span className='simple-questionnaire-switch' aria-hidden='true'>
                    <span className='simple-questionnaire-switch-knob' />
                  </span>
                </label>
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
              {question.type === "multiple_choice" ? (
                <div className='simple-voter-field-stack simple-voter-field-stack-tight simple-questionnaire-option-stack'>
                  <div className='simple-questionnaire-options-editor'>
                    <div className='simple-questionnaire-options-list'>
                      {question.options.map((option, optionIndex) => (
                        <div key={option.optionId} className='simple-questionnaire-option-row'>
                          <input
                            className='simple-voter-input'
                            value={option.label}
                            aria-label={`Option ${optionIndex + 1}`}
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
                          <button
                            type='button'
                            className='simple-voter-secondary simple-questionnaire-option-delete-button'
                            aria-label={`Delete option ${optionIndex + 1}`}
                            title={`Delete option ${optionIndex + 1}`}
                            onClick={() => {
                              updateQuestion(index, (entry) => (
                                entry.type === "multiple_choice"
                                  ? { ...entry, options: entry.options.filter((_, entryOptionIndex) => entryOptionIndex !== optionIndex) }
                                  : entry
                              ));
                            }}
                          >
                            <span className='simple-questionnaire-button-icon simple-questionnaire-button-icon-trash' aria-hidden='true' />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type='button'
                      className='simple-voter-secondary simple-questionnaire-action-button simple-questionnaire-add-option-button'
                      data-press-feedback-disabled='true'
                      onClick={() => {
                        updateQuestion(index, (entry) => {
                          if (entry.type !== "multiple_choice") {
                            return entry;
                          }
                          return {
                            ...entry,
                            options: [...entry.options, createNextOption(entry.options)],
                          };
                        });
                      }}
                    >
                      <span className='simple-questionnaire-button-icon simple-questionnaire-button-icon-plus' aria-hidden='true' />
                      <span>Add option</span>
                    </button>
                  </div>
                  <label className={`simple-questionnaire-required-toggle${question.multiSelect ? " is-on" : ""}`}>
                    <span>Allow multiple selections</span>
                    <input
                      type='checkbox'
                      role='switch'
                      aria-checked={question.multiSelect}
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
                    <span className='simple-questionnaire-switch' aria-hidden='true'>
                      <span className='simple-questionnaire-switch-knob' />
                    </span>
                  </label>
                </div>
              ) : null}
              {question.type === "rank" ? (
                <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
                  <div className='simple-questionnaire-options-editor'>
                    <div className='simple-questionnaire-options-list'>
                      {question.options.map((option, optionIndex) => (
                        <div key={option.optionId} className='simple-questionnaire-option-row'>
                          <input
                            className='simple-voter-input'
                            value={option.label}
                            aria-label={`Rank option ${optionIndex + 1}`}
                            onChange={(event) => {
                              const nextLabel = event.target.value;
                              updateQuestion(index, (entry) => {
                                if (entry.type !== "rank") {
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
                          <button
                            type='button'
                            className='simple-voter-secondary simple-questionnaire-option-delete-button'
                            aria-label={`Delete rank option ${optionIndex + 1}`}
                            title={`Delete rank option ${optionIndex + 1}`}
                            onClick={() => {
                              updateQuestion(index, (entry) => {
                                if (entry.type !== "rank") {
                                  return entry;
                                }
                                const options = entry.options.filter((_, entryOptionIndex) => entryOptionIndex !== optionIndex);
                                const minimumRanked = Math.min(
                                  options.length,
                                  Math.max(0, Math.floor(Number.isFinite(entry.minimumRanked) ? entry.minimumRanked : 0)),
                                );
                                return {
                                  ...entry,
                                  options,
                                  minimumRanked,
                                  required: minimumRanked > 0,
                                };
                              });
                            }}
                          >
                            <span className='simple-questionnaire-button-icon simple-questionnaire-button-icon-trash' aria-hidden='true' />
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type='button'
                      className='simple-voter-secondary simple-questionnaire-action-button simple-questionnaire-add-option-button'
                      data-press-feedback-disabled='true'
                      onClick={() => {
                        updateQuestion(index, (entry) => {
                          if (entry.type !== "rank") {
                            return entry;
                          }
                          return {
                            ...entry,
                            options: [...entry.options, createNextOption(entry.options)],
                          };
                        });
                      }}
                    >
                      <span className='simple-questionnaire-button-icon simple-questionnaire-button-icon-plus' aria-hidden='true' />
                      <span>Add option</span>
                    </button>
                  </div>
                  <div className='simple-questionnaire-rank-settings'>
                    <label className='simple-voter-label simple-voter-label-tight' htmlFor={`question-rank-minimum-${index}`}>
                      Minimum ranked choices
                    </label>
                    <select
                      id={`question-rank-minimum-${index}`}
                      className='simple-voter-input simple-questionnaire-rank-minimum'
                      value={String(question.minimumRanked)}
                      onChange={(event) => {
                        const parsed = Number.parseInt(event.target.value, 10);
                        updateQuestion(index, (entry) => {
                          if (entry.type !== "rank") {
                            return entry;
                          }
                          const minimumRanked = Number.isFinite(parsed)
                            ? Math.min(entry.options.length, Math.max(0, parsed))
                            : 0;
                          return { ...entry, minimumRanked, required: minimumRanked > 0 };
                        });
                      }}
                    >
                      <option value='0'>None</option>
                      {question.options.map((option, optionIndex) => (
                        <option key={option.optionId} value={String(optionIndex + 1)}>
                          {optionIndex + 1}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ) : null}
              {question.type === "free_text" ? (
                <div className='simple-voter-field-stack simple-voter-field-stack-tight simple-questionnaire-free-text-stack'>
                  <div className='simple-questionnaire-max-length-row'>
                    <label className='simple-voter-label' htmlFor={`question-max-${index}`}>Maximum length</label>
                    <input
                      id={`question-max-${index}`}
                      className='simple-voter-input simple-questionnaire-max-length-input'
                      inputMode='numeric'
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
                  <label className={`simple-questionnaire-required-toggle${question.encryptResponses ? " is-on" : ""}`}>
                    <span>Require encrypted responses</span>
                    <input
                      type='checkbox'
                      role='switch'
                      aria-checked={Boolean(question.encryptResponses)}
                      checked={Boolean(question.encryptResponses)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        updateQuestion(index, (entry) => (
                          entry.type === "free_text"
                            ? { ...entry, encryptResponses: checked }
                            : entry
                        ));
                      }}
                    />
                    <span className='simple-questionnaire-switch' aria-hidden='true'>
                      <span className='simple-questionnaire-switch-knob' />
                    </span>
                  </label>
                </div>
              ) : null}
              <div className='simple-questionnaire-question-actions'>
                <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                  <button
                    type='button'
                    className='simple-voter-secondary simple-questionnaire-action-button'
                    onClick={() => duplicateQuestion(index)}
                  >
                    <span className='simple-copy-icon simple-questionnaire-button-copy-icon' aria-hidden='true' />
                    <span>Duplicate</span>
                  </button>
                  {canMoveUp ? (
                    <button
                      type='button'
                      className='simple-voter-secondary simple-questionnaire-action-button'
                      onClick={() => moveQuestion(index, -1)}
                    >
                      <svg className='simple-questionnaire-svg-icon' viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
                        <path d='M12 19V5' />
                        <path d='M5 12l7-7 7 7' />
                      </svg>
                      <span>Move up</span>
                    </button>
                  ) : null}
                  {canMoveDown ? (
                    <button
                      type='button'
                      className='simple-voter-secondary simple-questionnaire-action-button'
                      onClick={() => moveQuestion(index, 1)}
                    >
                      <svg className='simple-questionnaire-svg-icon' viewBox='0 0 24 24' aria-hidden='true' focusable='false'>
                        <path d='M12 5v14' />
                        <path d='M19 12l-7 7-7-7' />
                      </svg>
                      <span>Move down</span>
                    </button>
                  ) : null}
                </div>
                <button
                  type='button'
                  className='simple-voter-secondary simple-questionnaire-action-button simple-questionnaire-remove-button'
                  onClick={() => deleteQuestion(index)}
                >
                  <span className='simple-questionnaire-button-icon simple-questionnaire-button-icon-trash' aria-hidden='true' />
                  <span>Remove</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button
        type='button'
        className='simple-questionnaire-add-question-button'
        onClick={addQuestion}
      >
        <span className='simple-questionnaire-button-icon simple-questionnaire-button-icon-plus' aria-hidden='true' />
        <span>Add Question</span>
      </button>

            </div>
          </div>
          <aside className='simple-questionnaire-build-aside'>
            <section className='simple-questionnaire-build-side-card'>
              <h4 className='simple-voter-section-title'>Readiness checklist</h4>
              <ul className='simple-vote-status-list simple-questionnaire-readiness-list'>
                <li className={titleReady ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{titleReady ? "✓" : "•"}</span> Title added</li>
                <li className={checklistDescriptionAdded ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{checklistDescriptionAdded ? "✓" : "•"}</span> Description added</li>
                <li className={hasQuestion ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{hasQuestion ? "✓" : "•"}</span> At least one question added</li>
                <li className={questionsValid ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{questionsValid ? "✓" : "•"}</span> Questions complete</li>
                <li className={publishedDefinition ? "is-complete" : "is-pending"}><span className='simple-vote-status-icon' aria-hidden='true'>{publishedDefinition ? "✓" : "•"}</span> {publishedDefinition ? "Questionnaire published" : "Questionnaire not yet published"}</li>
              </ul>
            </section>

            <section className='simple-questionnaire-build-side-card simple-questionnaire-build-actions'>
              {showNewRoundPublishOnly ? (
                <>
                  <button
                    type='button'
                    className='simple-voter-primary'
                    disabled={!canPublishDraft || !props.canApplyAdmissionsOnPublish}
                    onClick={() => void publishDefinition({ applyAdmissions: true })}
                  >
                    Publish to invited voters
                  </button>
                  {!props.canApplyAdmissionsOnPublish ? (
                    <p className='simple-voter-note'>Enable Auto-ballot for at least one voter before publishing this round.</p>
                  ) : null}
                </>
              ) : !publishedDefinition ? (
                <>
                  <button type='button' className='simple-voter-primary' disabled={!canPublishDraft} onClick={() => void publishDefinition()}>
                    Publish questionnaire
                  </button>
                  {props.onAfterPublishQuestionnaire && canPublishDraft && props.canApplyAdmissionsOnPublish ? (
                    <button
                      type='button'
                      className='simple-voter-secondary'
                      onClick={() => void publishDefinition({ applyAdmissions: true })}
                    >
                      Publish + apply invited voters
                    </button>
                  ) : null}
                </>
              ) : currentState === "open" || currentState === "closed" ? (
                <button type='button' className='simple-voter-primary' disabled={closeAndPublishButtonDisabled} onClick={() => void closeAndPublishResults()}>
                  {currentState === "open" ? "Close + publish results" : "Publish results"}
                </button>
              ) : currentState === "results_published" ? (
                <button type='button' className='simple-voter-primary' disabled>
                  Counted
                </button>
              ) : (
                <button type='button' className='simple-voter-primary' disabled={!canOpenQuestionnaire} onClick={() => void publishState("open")}>
                  Open vote
                </button>
              )}
              {!showNewRoundPublishOnly && publishedDefinition ? (
                <button
                  type='button'
                  className='simple-voter-primary'
                  onClick={setupAuditProxyFromChecklist}
                >
                  Set up proxy
                </button>
              ) : null}
              {!showNewRoundPublishOnly && props.onInviteParticipants ? (
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={props.onInviteParticipants}
                >
                  Invite voters
                </button>
              ) : null}
              {!coordinatorNsec.trim() ? (
                <p className='simple-voter-note'>Organiser key is not loaded yet.</p>
              ) : null}
              {publishValidation && !publishValidation.valid ? (
                <p className='simple-voter-note'>Validation: {publishValidation.errors[0] ?? "unknown_error"}.</p>
              ) : null}
              {statusNotice}
            </section>
          </aside>
        </div>
      </section>
      <div id='delegated-worker-section'>
        <SimpleCollapsibleSection title='Audit proxy' titleToggleLabel='Audit proxy' defaultCollapsed expandSignal={auditProxyExpandSignal}>
          <div className='simple-questionnaire-worker-section'>
            <label className='simple-voter-label' htmlFor='delegation-mode'>Mode</label>
            <select
              id='delegation-mode'
              className='simple-voter-input'
              value={delegationMode}
              onChange={(event) => setDelegationMode(event.target.value === "delegated_worker" ? "delegated_worker" : "browser_only")}
            >
              <option value='browser_only'>Browser only</option>
              <option value='delegated_worker'>Audit proxy</option>
            </select>
            <p className='simple-voter-note'>
              Use Audit proxy for larger live sessions or repeated rounds. When selected, publishing with a valid audit proxy npub configures delegation for that questionnaire.
            </p>

            {delegationMode === "delegated_worker" ? (
              <>
                <section className='simple-delegate-section'>
                  <h4 className='simple-delegate-title'>Available audit proxies</h4>
                  {availableWorkerStatuses.length === 0 ? (
                    <div className='simple-delegate-empty'>
                      <p className='simple-voter-empty'>No audit proxy status announcements seen yet.</p>
                      <p className='simple-voter-note'>Start an audit proxy to see it appear here.</p>
                    </div>
                  ) : (
                    <ul className='simple-voter-list simple-delegate-agent-list'>
                      {availableWorkerStatuses.map((snapshot) => (
                        <li key={`${snapshot.workerNpub}:${snapshot.heartbeatAt}`} className='simple-voter-list-item'>
                          <button
                            type='button'
                            className='simple-voter-secondary'
                            onClick={() => {
                              setDelegatedWorkerNpub(snapshot.workerNpub);
                              if (Array.isArray(snapshot.advertisedRelays) && snapshot.advertisedRelays.length > 0) {
                                setDelegatedWorkerControlRelays(snapshot.advertisedRelays.join(", "));
                              }
                            }}
                          >
                            {deriveActorDisplayId(snapshot.workerNpub)} · {snapshot.state} · {new Date(snapshot.heartbeatAt).toLocaleTimeString()}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className='simple-delegate-section'>
                  <h4 className='simple-delegate-title'>Setup</h4>
                  <label className='simple-voter-label' htmlFor='delegated-worker-npub'>Audit proxy npub</label>
                  <input
                    id='delegated-worker-npub'
                    className='simple-voter-input'
                    placeholder='npub1...'
                    value={delegatedWorkerNpub}
                    onChange={(event) => setDelegatedWorkerNpub(event.target.value)}
                  />
                  <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                    <button type='button' className='simple-voter-secondary' onClick={generateWorkerCredentials}>
                      Generate new account
                    </button>
                  </div>
                  {generatedWorkerNsec ? (
                    <div className='simple-voter-field-stack'>
                      <label className='simple-voter-label' htmlFor='generated-worker-nsec'>Generated audit proxy nsec (store securely)</label>
                      <textarea
                        id='generated-worker-nsec'
                        className='simple-voter-input'
                        rows={2}
                        readOnly
                        value={generatedWorkerNsec}
                      />
                    </div>
                  ) : null}
                  <label className='simple-voter-label' htmlFor='worker-startup-command'>Quick start command</label>
                  <textarea
                    id='worker-startup-command'
                    className='simple-voter-input simple-delegate-command'
                    rows={4}
                    readOnly
                    value={workerStartupCommand}
                  />
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void tryWriteClipboard(workerStartupCommand)}
                    disabled={!coordinatorNpub.trim()}
                  >
                    Copy quick start command
                  </button>
                  <a className='simple-voter-secondary simple-delegate-link-readme' href={workerHelperReadmeUrl} target='_blank' rel='noreferrer'>
                    Audit proxy details
                  </a>
                </section>

                <section className='simple-delegate-section'>
                  <h4 className='simple-delegate-title'>Audit proxy downloads</h4>
                  <p className='simple-voter-note'>
                    Autoconfigured saves a platform-specific launcher script with the current organiser `npub`, effective relay list, and generated audit proxy `nsec` when one is present.
                  </p>
                  <p className='simple-voter-note'>
                    Right-click copy link is supported. Shared Autoconfigured links intentionally omit `WORKER_NSEC`, so the receiving operator must supply their own audit proxy secret.
                  </p>
                  <div className='simple-delegate-download-grid'>
                    <div className='simple-delegate-download-row'>
                      <span className='simple-delegate-download-label'>Linux x64</span>
                      <a
                        className='simple-delegate-link simple-delegate-button'
                        href={autoconfiguredWorkerLauncherHrefs.linuxX64}
                        onClick={(event) => {
                          event.preventDefault();
                          downloadConfiguredWorkerLauncher(workerLauncherTargets.linuxX64);
                        }}
                      >
                        Autoconfigured
                      </a>
                    </div>
                    <div className='simple-delegate-download-row'>
                      <span className='simple-delegate-download-label'>Linux arm64</span>
                      <a
                        className='simple-delegate-link simple-delegate-button'
                        href={autoconfiguredWorkerLauncherHrefs.linuxArm64}
                        onClick={(event) => {
                          event.preventDefault();
                          downloadConfiguredWorkerLauncher(workerLauncherTargets.linuxArm64);
                        }}
                      >
                        Autoconfigured
                      </a>
                    </div>
                    <div className='simple-delegate-download-row'>
                      <span className='simple-delegate-download-label'>Linux armv7</span>
                      <a
                        className='simple-delegate-link simple-delegate-button'
                        href={autoconfiguredWorkerLauncherHrefs.linuxArmv7}
                        onClick={(event) => {
                          event.preventDefault();
                          downloadConfiguredWorkerLauncher(workerLauncherTargets.linuxArmv7);
                        }}
                      >
                        Autoconfigured
                      </a>
                    </div>
                    <div className='simple-delegate-download-row'>
                      <span className='simple-delegate-download-label'>Windows</span>
                      <a
                        className='simple-delegate-link simple-delegate-button'
                        href={autoconfiguredWorkerLauncherHrefs.windowsX64}
                        onClick={(event) => {
                          event.preventDefault();
                          downloadConfiguredWorkerLauncher(workerLauncherTargets.windowsX64);
                        }}
                      >
                        Autoconfigured
                      </a>
                    </div>
                    <div className='simple-delegate-download-row'>
                      <span className='simple-delegate-download-label'>macOS</span>
                      <a
                        className='simple-delegate-link simple-delegate-button'
                        href={autoconfiguredWorkerLauncherHrefs.macosArm64}
                        onClick={(event) => {
                          event.preventDefault();
                          downloadConfiguredWorkerLauncher(workerLauncherTargets.macosArm64);
                        }}
                      >
                        Autoconfigured
                      </a>
                    </div>
                  </div>
                </section>

                <section className='simple-delegate-section'>
                  <h4 className='simple-delegate-title'>Helper download and launch command</h4>
                      <label className='simple-voter-label' htmlFor='worker-download-target'>Platform</label>
                      <select
                        id='worker-download-target'
                        className='simple-voter-input'
                        value={selectedWorkerDownloadTarget}
                        onChange={(event) => setSelectedWorkerDownloadTarget(event.target.value as WorkerLauncherTargetKey)}
                      >
                        {WORKER_LAUNCHER_TARGET_OPTIONS.map((option) => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                      </select>
                      <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                        <a className='simple-voter-secondary' href={selectedWorkerLauncherTarget.assetUrl} target='_blank' rel='noreferrer'>
                          Download binary
                        </a>
                        <a className='simple-voter-secondary' href={selectedWorkerLauncherTarget.checksumUrl} target='_blank' rel='noreferrer'>
                          Download checksum
                        </a>
                        <button type='button' className='simple-voter-secondary' onClick={() => void tryWriteClipboard(workerDirectCommand)}>
                          Copy command
                        </button>
                      </div>
                      <label className='simple-voter-label' htmlFor='worker-direct-command'>Direct command-line launch</label>
                      <textarea
                        id='worker-direct-command'
                        className='simple-voter-input simple-delegate-command'
                        rows={selectedWorkerLauncherTarget.shell === "powershell" ? 6 : 7}
                        readOnly
                        value={workerDirectCommand}
                      />
                </section>

                <section className='simple-delegate-section'>
                  <h4 className='simple-delegate-title'>Audit proxy status</h4>
                  <div className='simple-delegate-status-overview'>
                    <span>Status overview</span>
                    <strong className='simple-delegate-status-badge'>
                      {delegationStatusLabel.toLowerCase() === "active" ? "Active" : "Inactive"}
                    </strong>
                  </div>
                  <div className='simple-delegate-status-grid'>
                    <p className='simple-voter-note'>Delegation state <span>{delegationStatusLabel}</span></p>
                    <p className='simple-voter-note'>Audit proxy npub <span>{selectedWorkerStatus?.workerNpub || activeWorkerDelegation?.workerNpub || "Not selected"}</span></p>
                    <p className='simple-voter-note'>Last heartbeat <span>{selectedWorkerStatus?.heartbeatAt ? new Date(selectedWorkerStatus.heartbeatAt).toLocaleString() : "Not seen"}</span></p>
                    <p className='simple-voter-note'>Last blind issuance <span>{selectedWorkerStatus?.lastBlindIssuanceAt ? new Date(selectedWorkerStatus.lastBlindIssuanceAt).toLocaleString() : "Not reported"}</span></p>
                    <p className='simple-voter-note'>Last vote verification <span>{selectedWorkerStatus?.lastVoteVerificationAt ? new Date(selectedWorkerStatus.lastVoteVerificationAt).toLocaleString() : "Not reported"}</span></p>
                    <p className='simple-voter-note'>Last decision publish <span>{selectedWorkerStatus?.lastDecisionPublishAt ? new Date(selectedWorkerStatus.lastDecisionPublishAt).toLocaleString() : "Not reported"}</span></p>
                  </div>
                </section>

                <section className={`simple-delegate-section simple-collapsible-section${workerMoreOptionsCollapsed ? " is-collapsed" : ""}`}>
                  <div className='simple-collapsible-header'>
                    <h4 className='simple-delegate-title simple-collapsible-title'>More options</h4>
                    <button
                      type='button'
                      className='simple-collapsible-toggle'
                      aria-expanded={!workerMoreOptionsCollapsed}
                      aria-controls='worker-more-options'
                      onClick={() => setWorkerMoreOptionsCollapsed((current) => !current)}
                    >
                      {workerMoreOptionsCollapsed ? "Show" : "Hide"}
                    </button>
                  </div>
                  <p className='simple-voter-note'>
                    Delegation defaults to all supported audit proxy responsibilities. Open this section only if you need to narrow capabilities, override relays, or set an expiry.
                  </p>
                  <div id='worker-more-options' className='simple-collapsible-body'>
                    <div className='simple-collapsible-body-inner'>
                      <section className='simple-delegate-section'>
                        <h4 className='simple-delegate-title'>Control relays</h4>
                        <textarea
                          id='delegated-worker-relays'
                          className='simple-voter-input'
                          rows={2}
                          placeholder={DEFAULT_WORKER_CONTROL_RELAYS.join(", ")}
                          value={delegatedWorkerControlRelays}
                          onChange={(event) => setDelegatedWorkerControlRelays(event.target.value)}
                        />
                        <p className='simple-voter-note'>Leave blank to use the default client relay set.</p>
                      </section>

                      <section className='simple-delegate-section'>
                        <h4 className='simple-delegate-title'>Set delegation expiry</h4>
                        <label className='simple-voter-note' htmlFor='delegated-worker-expiry-enabled'>
                          <input
                            id='delegated-worker-expiry-enabled'
                            type='checkbox'
                            checked={delegatedWorkerExpiryEnabled}
                            onChange={(event) => {
                              const enabled = event.target.checked;
                              setDelegatedWorkerExpiryEnabled(enabled);
                              if (!enabled) {
                                setDelegatedWorkerExpiryMinutes("");
                              } else if (!delegatedWorkerExpiryMinutes.trim()) {
                                setDelegatedWorkerExpiryMinutes("120");
                              }
                            }}
                          />
                          Enable expiry
                        </label>
                        <label className='simple-voter-label' htmlFor='delegated-worker-expiry'>Expiry (minutes, optional)</label>
                        <input
                          id='delegated-worker-expiry'
                          className='simple-voter-input'
                          disabled={!delegatedWorkerExpiryEnabled}
                          value={delegatedWorkerExpiryMinutes}
                          onChange={(event) => setDelegatedWorkerExpiryMinutes(event.target.value)}
                        />
                      </section>

                      <section className='simple-delegate-section'>
                        <h4 className='simple-delegate-title'>Capabilities</h4>
                        <div className='simple-delegate-capability-list'>
                          <label className='simple-delegate-capability-row'>
                            <span>Issue blind tokens</span>
                            <input
                              type='checkbox'
                              checked={delegatedWorkerCapabilities.includes("issue_blind_tokens")}
                              onChange={() => toggleWorkerCapability("issue_blind_tokens")}
                            />
                          </label>
                          <label className='simple-delegate-capability-row'>
                            <span>Verify public submissions</span>
                            <input
                              type='checkbox'
                              checked={delegatedWorkerCapabilities.includes("verify_public_submissions")}
                              onChange={() => toggleWorkerCapability("verify_public_submissions")}
                            />
                          </label>
                          <label className='simple-delegate-capability-row'>
                            <span>Publish submission decisions</span>
                            <input
                              type='checkbox'
                              checked={delegatedWorkerCapabilities.includes("publish_submission_decisions")}
                              onChange={() => toggleWorkerCapability("publish_submission_decisions")}
                            />
                          </label>
                          <label className='simple-delegate-capability-row'>
                            <span>Close questionnaire after all valid responses</span>
                            <input
                              type='checkbox'
                              checked={delegatedWorkerCapabilities.includes("close_questionnaire")}
                              onChange={() => toggleWorkerCapability("close_questionnaire")}
                            />
                          </label>
                          <label className='simple-delegate-capability-row'>
                            <span>Publish result summary</span>
                            <input
                              type='checkbox'
                              checked={delegatedWorkerCapabilities.includes("publish_result_summary")}
                              onChange={() => toggleWorkerCapability("publish_result_summary")}
                            />
                          </label>
                        </div>
                      </section>
                    </div>
                  </div>
                </section>

                <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
                  <button type='button' className='simple-voter-primary simple-voter-primary-wide' onClick={() => void delegateToWorker()}>
                    Confirm configuration
                  </button>
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void revokeWorkerDelegation()}
                    disabled={!activeWorkerDelegation}
                  >
                    Revoke delegation
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </SimpleCollapsibleSection>
      </div>
    </>
  );
}

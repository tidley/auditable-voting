import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { finalizeEvent, getPublicKey, nip19, nip44 } from "nostr-tools";
import {
  fetchQuestionnaireActiveWorkerDelegationForCapability,
  fetchQuestionnaireDefinitions,
  fetchQuestionnairePrivateInviteStatus,
} from "./questionnaireTransport";
import { buildQuestionnaireInviteUrl, parseInviteFromUrl } from "./questionnaireInvite";
import { createSignerService, SignerServiceError, type SignerService } from "./services/signerService";
import {
  QuestionnaireOptionAVoterRuntime,
  OptionARuntimeError,
} from "./questionnaireOptionARuntime";
import type { BallotScope, BallotSubmission, ElectionInviteMessage, QuestionnaireAnswer, VoterElectionLocalState } from "./questionnaireOptionA";
import { deriveActorDisplayId } from "./actorDisplay";
import { deriveIdentityWords } from "./identityWords";
import {
  loadElectionSummary,
  loadVoterState,
  listInvitesFromMailbox,
  publishInviteToMailbox,
  upsertElectionSummary,
} from "./questionnaireOptionAStorage";
import { fetchOptionAInviteDms, fetchOptionAInviteDmsWithNsec } from "./questionnaireOptionAInviteDm";
import { readCachedQuestionnaireDefinition, storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { buildQuestionnaireDefinitionReference } from "./questionnaireDefinitionReference";
import {
  allowedScopesForRequiredScope,
  normaliseQuestionnaireAllowedScopes,
  normaliseQuestionnaireBallotGroup,
  normaliseQuestionBallotSlot,
  questionRequiredScope,
  questionBallotCredentialScope,
  questionBallotScopeKey,
  questionnaireCredentialsPerVoter,
  questionnaireUsesPerQuestionCredentials,
  type QuestionnaireDefinition,
} from "./questionnaireProtocol";
import { mergeQuestionnaireRelayHints } from "./questionnaireRelays";
import { SIMPLE_DM_RELAYS } from "./simpleShardDm";
import TokenFingerprint from "./TokenFingerprint";
import { decodeNsec } from "./nostrIdentity";
import { buildIssueBlindTokensWorkerRouting } from "./questionnaireWorkerRouting";
import { tryWriteClipboard } from "./clipboard";
import { useTransientCopiedLabel } from "./useTransientCopiedLabel";
import { UiButton, UiIcon, UiSelect, UiTextArea } from "./ui/DesignLayer";
import {
  hashQuestionnaireInviteCode,
  hashQuestionnairePrivateInviteClaim,
} from "./questionnaireInviteCode";

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
      return signed as unknown as T & { id?: string; sig?: string; pubkey?: string };
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
  question: { questionId: string; type: "yes_no" | "multiple_choice" | "rank" | "free_text"; encryptResponses?: boolean },
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
  return {
    questionId: question.questionId,
    type: "text",
    answer: text,
    encryptForCoordinator: Boolean(encryptForCoordinator || question.encryptResponses),
  };
}

function answersFromOptionADraft(responses: QuestionnaireAnswer[]) {
  const next: Record<string, unknown> = {};
  for (const response of responses) {
    if (response.type === "yes_no") {
      next[response.questionId] = response.answer;
      continue;
    }
    if (response.type === "multiple_choice" || response.type === "rank") {
      next[response.questionId] = [...response.answer];
      continue;
    }
    next[response.questionId] = response.answer;
  }
  return next;
}

function encryptionFlagsFromOptionADraft(responses: QuestionnaireAnswer[]) {
  const next: Record<string, boolean> = {};
  for (const response of responses) {
    if (response.type === "text" && response.encryptForCoordinator) {
      next[response.questionId] = true;
    }
  }
  return next;
}

function answerRecordEquals(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (!Array.isArray(leftValue) || !Array.isArray(rightValue) || leftValue.length !== rightValue.length) {
        return false;
      }
      return leftValue.every((entry, index) => entry === rightValue[index]);
    }
    return leftValue === rightValue;
  });
}

const OPTION_A_VOTER_DRAFT_STORAGE_PREFIX = "optiona:voter-answer-draft:v1";

type PersistedOptionAVoterDraft = {
  answers: Record<string, unknown>;
  encryptFreeTextByQuestionId: Record<string, boolean>;
  activeQuestionIndex: number;
  activeCredentialIndex: number;
  updatedAt: string;
};

function optionAVoterDraftStorageKey(electionId: string, voterNpub: string) {
  const cleanElectionId = electionId.trim();
  const cleanVoterNpub = voterNpub.trim();
  return cleanElectionId && cleanVoterNpub
    ? `${OPTION_A_VOTER_DRAFT_STORAGE_PREFIX}:${cleanElectionId}:${cleanVoterNpub}`
    : "";
}

function sanitisePersistedAnswerRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) {
      continue;
    }
    if (typeof entry === "string") {
      next[key] = entry;
      continue;
    }
    if (Array.isArray(entry)) {
      next[key] = entry.filter((item): item is string => typeof item === "string");
    }
  }
  return next;
}

function sanitisePersistedBooleanRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, entry]) => key.trim() && typeof entry === "boolean"),
  ) as Record<string, boolean>;
}

function readPersistedOptionAVoterDraft(key: string): PersistedOptionAVoterDraft | null {
  if (!key || typeof window === "undefined") {
    return null;
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<PersistedOptionAVoterDraft> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      answers: sanitisePersistedAnswerRecord(parsed.answers),
      encryptFreeTextByQuestionId: sanitisePersistedBooleanRecord(parsed.encryptFreeTextByQuestionId),
      activeQuestionIndex: Number.isFinite(parsed.activeQuestionIndex) ? Math.max(0, Math.floor(parsed.activeQuestionIndex ?? 0)) : 0,
      activeCredentialIndex: Number.isFinite(parsed.activeCredentialIndex) ? Math.max(1, Math.floor(parsed.activeCredentialIndex ?? 1)) : 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writePersistedOptionAVoterDraft(key: string, draft: Omit<PersistedOptionAVoterDraft, "updatedAt">) {
  if (!key || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify({
      ...draft,
      updatedAt: new Date().toISOString(),
    }));
  } catch {
    // Local persistence is best-effort; the runtime state still handles submission.
  }
}

function proxyAnswerKey(questionId: string, credentialIndex: number) {
  return `${questionId}:credential:${credentialIndex}`;
}

function credentialIndexFromBallotScope(scope: BallotScope | null | undefined) {
  return Number.isFinite(scope?.credentialIndex)
    ? Math.max(1, Math.floor(scope?.credentialIndex as number))
    : 1;
}

function credentialIndexFromSubmission(key: string, submission: BallotSubmission) {
  const scopedCredentialIndex = submission.credentialBundle
    ?.map((proof) => credentialIndexFromBallotScope(proof.ballotScope))
    .find((index) => index > 1);
  if (scopedCredentialIndex) {
    return scopedCredentialIndex;
  }
  const keyedCredentialIndex = key.match(/:c(\d+)(?::|$)/)?.[1];
  return keyedCredentialIndex ? Math.max(1, Math.floor(Number(keyedCredentialIndex))) : 1;
}

function mapDefinitionQuestions(definition: QuestionnaireDefinition) {
  return definition.questions.map((question) => ({
    questionId: question.questionId,
    required: question.required,
    prompt: question.prompt,
    requiredScope: questionRequiredScope(question),
    ballotGroup: normaliseQuestionnaireBallotGroup(question.ballotGroup),
    type: question.type,
    options: question.type === "multiple_choice" || question.type === "rank" ? question.options : undefined,
    multiSelect: question.type === "multiple_choice" ? question.multiSelect : undefined,
    minimumRanked: question.type === "rank" ? question.minimumRanked : undefined,
    maxLength: question.type === "free_text" ? question.maxLength : undefined,
    encryptResponses: question.type === "free_text" ? Boolean(question.encryptResponses) : undefined,
  }));
}

function questionVisibleForBallotGroup(question: { requiredScope?: string | null; ballotGroup?: string | null }, activeBallotGroup: string | null) {
  const requiredScope = questionRequiredScope(question);
  return !requiredScope || allowedScopesForRequiredScope(activeBallotGroup).includes(requiredScope);
}

function filterQuestionsForBallotGroup<T extends { requiredScope?: string | null; ballotGroup?: string | null }>(
  questions: T[],
  activeBallotGroup: string | null,
) {
  return questions.filter((question) => questionVisibleForBallotGroup(question, activeBallotGroup));
}

export function ballotGroupFromReceivedCredential(
  state: Pick<VoterElectionLocalState, "blindIssuance" | "blindIssuances"> | null | undefined,
): string | null | undefined {
  const issuances = [
    state?.blindIssuance ?? null,
    ...Object.values(state?.blindIssuances ?? {}),
  ];
  let hasExplicitScope = false;
  for (const issuance of issuances) {
    const scope = issuance?.ballotScope;
    if (!scope) {
      continue;
    }
    if (Array.isArray(scope.allowedScopes) || scope.ballotGroup !== undefined) {
      hasExplicitScope = true;
    }
    const dedicatedScope = normaliseQuestionnaireAllowedScopes(scope.allowedScopes, scope.ballotGroup)
      .find((entry) => entry !== "0");
    if (dedicatedScope) {
      return dedicatedScope;
    }
  }
  return hasExplicitScope ? null : undefined;
}

function latestDefinitionFromEntries(entries: Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>) {
  return [...entries].sort((a, b) => (b.event.created_at ?? 0) - (a.event.created_at ?? 0))[0]?.definition ?? null;
}

function cacheDefinitionForVoting(
  definition: QuestionnaireDefinition,
  issueBlindTokensWorker?: ElectionInviteMessage["issueBlindTokensWorker"],
) {
  const storedDefinition = storeCachedQuestionnaireDefinition(definition) ?? definition;
  const electionId = storedDefinition.questionnaireId.trim();
  const coordinatorNpub = storedDefinition.coordinatorPubkey.trim();
  if (!electionId || !coordinatorNpub) {
    return;
  }
  const existing = loadElectionSummary(electionId);
  const closed = Number.isFinite(storedDefinition.closeAt) && storedDefinition.closeAt <= Math.floor(Date.now() / 1000);
  upsertElectionSummary({
    electionId,
    title: storedDefinition.title || existing?.title || "Questionnaire",
    description: storedDefinition.description ?? existing?.description ?? "",
    state: existing?.state ?? (closed ? "closed" : "open"),
    openedAt: Number.isFinite(storedDefinition.openAt) ? new Date(storedDefinition.openAt * 1000).toISOString() : existing?.openedAt ?? null,
    closedAt: Number.isFinite(storedDefinition.closeAt) ? new Date(storedDefinition.closeAt * 1000).toISOString() : existing?.closedAt ?? null,
    coordinatorNpub,
    blindSigningPublicKey: storedDefinition.blindSigningPublicKey ?? existing?.blindSigningPublicKey ?? null,
    definitionCreatedAt: Number.isFinite(storedDefinition.createdAt) ? storedDefinition.createdAt : existing?.definitionCreatedAt,
    questionnaireRelays: storedDefinition.questionnaireRelays,
    issueBlindTokensWorker: issueBlindTokensWorker === undefined
      ? existing?.issueBlindTokensWorker ?? null
      : issueBlindTokensWorker,
    protocolVersion: storedDefinition.protocolVersion ?? existing?.protocolVersion,
    flowMode: storedDefinition.flowMode ?? existing?.flowMode,
    responseMode: storedDefinition.responseMode ?? existing?.responseMode,
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
    definitionReference: buildQuestionnaireDefinitionReference({ definition }),
    issueBlindTokensWorker: issueBlindTokensWorker ?? null,
    expiresAt: null,
  };
}

const LEGACY_INVITE_TITLE = "Should the proposal pass?";
const AUTO_BALLOT_REQUEST_MIN_INTERVAL_MS = 15_000;
const AUTO_BALLOT_PAGE_LOAD_REQUEST_DELAY_MS = 1_000;
const AUTO_BALLOT_RETRY_POLL_MS = 5_000;
const AUTO_BALLOT_RETRY_RESEND_MS = 10_000;
const MANUAL_BALLOT_RESEND_DELAY_MS = 5_000;
const AUTO_BALLOT_SIGNER_REFRESH_SCHEDULE_MS = [3_000, 8_000, 20_000, 45_000] as const;
const AUTO_BALLOT_SIGNER_KEEPALIVE_REFRESH_MS = 30_000;
const AUTO_BALLOT_MOBILE_RECOVERY_PULL_MS = 20_000;
const AUTO_BALLOT_WAIT_FOREGROUND_REFRESH_MS = 15_000;
const AUTO_BALLOT_SIGNER_SUBSCRIPTION_REARM_MIN_INTERVAL_MS = 5_000;
const AUTO_BALLOT_SIGNER_BACKGROUND_FETCH_MIN_INTERVAL_MS = 30_000;
const AUTO_BALLOT_SIGNER_LIFECYCLE_FETCH_MIN_INTERVAL_MS = 15_000;
const AUTO_BALLOT_SIGNER_INITIAL_PULL_DELAY_MS = 2_500;
const PRIVATE_INVITE_STATUS_QUICK_CHECK_TIME_BUDGET_MS = 1_800;
const PRIVATE_INVITE_STATUS_QUICK_CHECK_MAX_PAGES = 2;
type BallotWaitRefreshMode = "manual" | "lifecycle" | "background";

function SubmittedStateLabel({ children = "Submitted" }: { children?: string }) {
  return (
    <p className='simple-questionnaire-voter-requirement is-submitted'>
      <UiIcon name='check' />
      <span>{children}</span>
    </p>
  );
}

function getManualBallotResendAvailableAtMs(snapshot: VoterElectionLocalState | null | undefined) {
  if (!snapshot?.blindRequestSent || snapshot.credentialReady || snapshot.submission) {
    return null;
  }
  const sentAt = snapshot.blindRequestSentAt ?? snapshot.blindRequest?.lastSentAt ?? "";
  const sentAtMs = Date.parse(sentAt);
  return Number.isFinite(sentAtMs) ? sentAtMs + MANUAL_BALLOT_RESEND_DELAY_MS : 0;
}

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

type QuestionnaireRoundProgress = {
  label: string;
  submitted: boolean;
};

function resolveRoundProgressDefinition(
  state: VoterElectionLocalState | null | undefined,
  fallbackDefinition?: QuestionnaireDefinition | null,
) {
  const electionId = state?.electionId?.trim() ?? fallbackDefinition?.questionnaireId?.trim() ?? "";
  const definitions = [
    fallbackDefinition ?? null,
    state?.inviteMessage?.definition ?? null,
    state?.blindIssuance?.definition ?? null,
    ...Object.values(state?.blindIssuances ?? {}).map((issuance) => issuance.definition ?? null),
    electionId ? readCachedQuestionnaireDefinition(electionId) : null,
  ];
  return definitions.find((definition): definition is QuestionnaireDefinition => (
    Boolean(definition) && (!electionId || definition?.questionnaireId === electionId)
  )) ?? null;
}

function collectSubmittedQuestionGroupKeys(
  state: VoterElectionLocalState | null | undefined,
  definition: QuestionnaireDefinition,
) {
  const questionById = new Map(definition.questions.map((question, index) => [
    question.questionId,
    { question, index },
  ]));
  const keys = new Set<string>();
  const addQuestionId = (questionId: string) => {
    const entry = questionById.get(questionId);
    if (entry) {
      keys.add(questionBallotScopeKey(entry.question, entry.index));
    }
  };
  for (const questionId of Object.keys(state?.submissions ?? {})) {
    addQuestionId(questionId);
  }
  const submissions = [
    state?.submission ?? null,
    ...Object.values(state?.submissions ?? {}),
  ];
  for (const submission of submissions) {
    for (const response of submission?.payload?.responses ?? []) {
      addQuestionId(response.questionId);
    }
  }
  return keys;
}

function perQuestionRoundIsFullySubmitted(
  state: VoterElectionLocalState | null | undefined,
  definition: QuestionnaireDefinition,
) {
  const requiredGroupKeys = new Set(
    definition.questions.map((question, index) => questionBallotScopeKey(question, index)),
  );
  if (requiredGroupKeys.size === 0) {
    return Boolean(state?.submission);
  }
  const submittedGroupKeys = collectSubmittedQuestionGroupKeys(state, definition);
  return [...requiredGroupKeys].every((key) => submittedGroupKeys.has(key));
}

function getQuestionnaireRoundProgress(
  state: VoterElectionLocalState | null | undefined,
  definition?: QuestionnaireDefinition | null,
): QuestionnaireRoundProgress {
  const progressDefinition = resolveRoundProgressDefinition(state, definition);
  if (progressDefinition && questionnaireUsesPerQuestionCredentials(progressDefinition)) {
    if (perQuestionRoundIsFullySubmitted(state, progressDefinition)) {
      return { label: "submitted", submitted: true };
    }
    if (Object.keys(state?.blindIssuances ?? {}).length > 0 || state?.credentialReady) {
      return { label: "ready", submitted: false };
    }
    if (Object.keys(state?.blindRequests ?? {}).length > 0 || state?.blindRequestSent) {
      return { label: "awaiting ballot", submitted: false };
    }
    return { label: "not started", submitted: false };
  }
  if (state?.submissionAccepted === true) {
    return { label: "accepted", submitted: true };
  }
  if (state?.submissionAccepted === false) {
    return { label: "rejected", submitted: true };
  }
  if (state?.submission) {
    return { label: "submitted", submitted: true };
  }
  if (state?.credentialReady) {
    return { label: "ready", submitted: false };
  }
  if (state?.blindRequestSent) {
    return { label: "awaiting ballot", submitted: false };
  }
  return { label: "not started", submitted: false };
}

function formatQuestionnaireRoundOptionLabel(input: {
  invite: ElectionInviteMessage;
  index: number;
  total: number;
  progress: QuestionnaireRoundProgress;
}) {
  const title = resolveInviteDisplayTitle(input.invite);
  const titleWithId = title === input.invite.electionId
    ? input.invite.electionId
    : `${title} - ${input.invite.electionId}`;
  return `${input.index + 1}/${input.total} ${titleWithId} · ${input.progress.label}`;
}

export function formatVoteActionButtonText(input: {
  snapshot: VoterElectionLocalState | null;
  requiredQuestionsAnswered: boolean;
  canSubmitNow: boolean;
  blindSigningKeyReady: boolean;
  ballotRequestSent: boolean;
  credentialReady: boolean;
  coordinatorNpub: string;
  responseSubmitted: boolean;
  perQuestionMode: boolean;
  allQuestionResponsesSubmitted: boolean;
  canAdvanceQuestionBeforeSubmit?: boolean;
  submitInFlight: boolean;
}) {
  const snapshot = input.snapshot;
  if (input.submitInFlight) {
    return "Submitting...";
  }
  if (input.responseSubmitted && input.perQuestionMode && !input.allQuestionResponsesSubmitted) {
    return "Next question";
  }
  if (input.responseSubmitted || (input.perQuestionMode && input.allQuestionResponsesSubmitted)) {
    return "View results";
  }
  if (input.canAdvanceQuestionBeforeSubmit) {
    return "Next";
  }
  if (!input.requiredQuestionsAnswered) {
    return "Answer required questions to continue";
  }
  if (input.canSubmitNow) {
    return "Submit";
  }
  if (!snapshot?.loginVerified) {
    return "1/3 Confirming identity";
  }
  if (!input.coordinatorNpub.trim()) {
    return "1/3 Finding organiser";
  }
  if (!input.blindSigningKeyReady) {
    return "1/3 Loading ballot key";
  }
  if (!input.ballotRequestSent) {
    return "Requesting ballot";
  }
  if (!input.credentialReady) {
    return "Awaiting ballot";
  }
  return "3/3 Preparing response";
}

function inviteMessageKey(invite: ElectionInviteMessage) {
  return `${invite.electionId}:${invite.coordinatorNpub}`;
}

function mergeInvitesByKey(...groups: ElectionInviteMessage[][]) {
  const byKey = new Map<string, ElectionInviteMessage>();
  for (const group of groups) {
    for (const invite of group) {
      byKey.set(inviteMessageKey(invite), invite);
    }
  }
  return [...byKey.values()];
}

function nextPaint() {
  return new Promise<void>((resolve) => {
    if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => resolve());
  });
}

function inviteGrantsProxyCredential(invite: ElectionInviteMessage | null | undefined, questionnaireId: string) {
  return Boolean(invite?.electionId === questionnaireId && invite.credentialsPerVoter === 2);
}

function questionHelperText(question: {
  type: "yes_no" | "multiple_choice" | "rank" | "free_text";
  multiSelect?: boolean;
  minimumRanked?: number;
}) {
  if (question.type === "yes_no") {
    return "";
  }
  if (question.type === "multiple_choice") {
    return question.multiSelect ? "Select all options that apply." : "Select one option.";
  }
  if (question.type === "rank") {
    const minimumRanked = Math.max(1, Math.floor(question.minimumRanked ?? 1));
    return `Rank at least ${minimumRanked} in order of preference.`;
  }
  return "Enter your response.";
}

type QuestionnaireOptionAVoterPanelProps = {
  announcedQuestionnaireIds?: string[];
  localVoterNpub?: string;
  localVoterNsec?: string;
  autoSignerLogin?: boolean;
  requestBlindBallotNonce?: number;
  displayMode?: "vote" | "settings";
  showLoginAction?: boolean;
  onMessageOrganiser?: (coordinatorNpub?: string) => void;
  onBackToJoin?: () => void;
  onActiveQuestionnaireIdChange?: (questionnaireId: string) => void;
  onBallotReceivedChange?: (received: boolean) => void;
};

type PrivateInviteBlockState = {
  questionnaireId: string;
  coordinatorNpub: string | null;
  generalInviteUrl: string | null;
  reason: "redeemed" | "revoked";
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
        : null
      : selectedCount > 0
        ? null
        : "Optional",
  };
}

function formatBallotDetailValue(value: string | number | boolean | null | undefined, fallback = "Not available") {
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  const trimmed = value?.trim() ?? "";
  return trimmed || fallback;
}

function scopedBallotScopeKey(scope: BallotScope | null | undefined) {
  const questionId = scope?.questionId?.trim() ?? "";
  const slotId = scope?.slotId?.trim() ?? "";
  const ballotGroup = normaliseQuestionnaireBallotGroup(scope?.ballotGroup);
  const allowedScopes = normaliseQuestionnaireAllowedScopes(scope?.allowedScopes, ballotGroup)
    .filter((entry) => entry !== "0");
  const slotIndex = Number.isFinite(scope?.slotIndex) ? Math.max(1, Math.floor(scope?.slotIndex as number)) : 0;
  const version = Number.isFinite(scope?.version) ? Math.max(1, Math.floor(scope?.version as number)) : 1;
  const credentialIndex = Number.isFinite(scope?.credentialIndex) ? Math.max(1, Math.floor(scope?.credentialIndex as number)) : 1;
  const credentialSuffix = credentialIndex > 1 ? `:c${credentialIndex}` : "";
  const scopePrefix = allowedScopes.length > 0 ? `scopes:${allowedScopes.join("+")}:` : "";
  if (!questionId && !slotId && !slotIndex && version === 1 && credentialIndex <= 1 && allowedScopes.length === 0) {
    return "__questionnaire__";
  }
  if (!questionId && !slotId && !slotIndex && allowedScopes.length > 0) {
    return `${scopePrefix}questionnaire${credentialSuffix}`;
  }
  if (slotIndex > 0) {
    return `${scopePrefix}slot:${slotIndex}:v${version}${credentialSuffix}`;
  }
  return `${scopePrefix}${questionId || slotId}:${slotId}:${slotIndex}:v${version}${credentialSuffix}`;
}

function withCredentialIndex(scope: BallotScope | null, credentialIndex: number): BallotScope | null {
  const index = Math.max(1, Math.floor(credentialIndex));
  if (index <= 1) {
    return scope;
  }
  return {
    ...(scope ?? {}),
    credentialIndex: index,
  };
}

function scopedBallotScopeForQuestion(
  definition: QuestionnaireDefinition | null | undefined,
  questionId: string,
  credentialIndex = 1,
  ballotGroup?: string | null,
): BallotScope | null {
  if (!definition || !questionnaireUsesPerQuestionCredentials(definition)) {
    const group = normaliseQuestionnaireBallotGroup(ballotGroup);
    return withCredentialIndex(group ? { allowedScopes: allowedScopesForRequiredScope(group) } : null, credentialIndex);
  }
  const index = definition.questions.findIndex((question) => question.questionId === questionId);
  const question = index >= 0 ? definition.questions[index] : null;
  if (!question) {
    return null;
  }
  const targetKey = scopedBallotScopeKey(questionBallotCredentialScope(question, index));
  const canonicalIndex = definition.questions.findIndex((candidate, candidateIndex) => {
    return scopedBallotScopeKey(questionBallotCredentialScope(candidate, candidateIndex)) === targetKey;
  });
  const canonicalQuestion = canonicalIndex >= 0 ? definition.questions[canonicalIndex] : question;
  return questionBallotCredentialScope(canonicalQuestion, canonicalIndex >= 0 ? canonicalIndex : index, credentialIndex);
}

export default function QuestionnaireOptionAVoterPanel(props: QuestionnaireOptionAVoterPanelProps) {
  const displayMode = props.displayMode ?? "vote";
  const settingsMode = displayMode === "settings";
  const [runtime, setRuntime] = useState<QuestionnaireOptionAVoterRuntime | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [privateInviteBlock, setPrivateInviteBlock] = useState<PrivateInviteBlockState | null>(null);
  const [signedInNpub, setSignedInNpub] = useState<string>("");
  const [pendingInvites, setPendingInvites] = useState<ElectionInviteMessage[]>([]);
  const [activeInvite, setActiveInvite] = useState<ElectionInviteMessage | null>(null);
  const [selectedInviteKey, setSelectedInviteKey] = useState<string>("");
  const [answerNextPendingKey, setAnswerNextPendingKey] = useState<string>("");
  const [questionnaireTitle, setQuestionnaireTitle] = useState<string>("Questionnaire");
  const [questionnaireDescription, setQuestionnaireDescription] = useState<string>("");
  const [questionnaireDefinition, setQuestionnaireDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [questions, setQuestions] = useState<Array<{
    questionId: string;
    required: boolean;
    prompt: string;
    requiredScope?: string | null;
    ballotGroup?: string | null;
    type: "yes_no" | "multiple_choice" | "rank" | "free_text";
    options?: Array<{ optionId: string; label: string }>;
    multiSelect?: boolean;
    minimumRanked?: number;
    maxLength?: number;
    encryptResponses?: boolean;
  }>>([]);
  const [questionnaireStarted, setQuestionnaireStarted] = useState(false);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [activeCredentialIndex, setActiveCredentialIndex] = useState(1);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [encryptFreeTextByQuestionId, setEncryptFreeTextByQuestionId] = useState<Record<string, boolean>>({});
  const [submitInFlight, setSubmitInFlight] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [manualResendClockMs, setManualResendClockMs] = useState(() => Date.now());
  const [voterMenuActionsMount, setVoterMenuActionsMount] = useState<HTMLElement | null>(null);
  const [privateInviteBootstrapRetryNonce, setPrivateInviteBootstrapRetryNonce] = useState(0);
  const activeQuestionCardRef = useRef<HTMLElement | null>(null);
  const { isCopied: isReceiptCopyActive, showCopied: showReceiptCopied } = useTransientCopiedLabel();
  const autoRequestSentForRef = useRef<Record<string, true>>({});
  const autoRequestInFlightForRef = useRef<Record<string, true>>({});
  const autoRequestLastAttemptAtRef = useRef<Record<string, number>>({});
  const autoRequestDelayedForRef = useRef<Record<string, true>>({});
  const scopedCredentialRecoveryForRef = useRef<Record<string, true>>({});
  const answerNextPrefetchInFlightForRef = useRef<Record<string, true>>({});
  const answerNextPrefetchSentForRef = useRef<Record<string, true>>({});
  const answerNextPrefetchLastAttemptAtRef = useRef<Record<string, number>>({});
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
  const announcedQuestionnaireIds = useMemo(() => (
    (props.announcedQuestionnaireIds ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  ), [props.announcedQuestionnaireIds]);
  const latestAnnouncedQuestionnaireId = useMemo(() => {
    return announcedQuestionnaireIds.at(-1) ?? "";
  }, [announcedQuestionnaireIds]);
  const announcedQuestionnaireIdKey = useMemo(() => {
    return announcedQuestionnaireIds.join("|");
  }, [announcedQuestionnaireIds]);
  const announcedQuestionnaireIdSet = useMemo(() => {
    return new Set(announcedQuestionnaireIdKey ? announcedQuestionnaireIdKey.split("|") : []);
  }, [announcedQuestionnaireIdKey]);

  const snapshot = runtime?.getSnapshot() ?? null;
  const flags = runtime?.getFlags() ?? {
    canLogin: true,
    canRequestBallot: false,
    canSubmitVote: false,
    alreadySubmitted: false,
    resumeAvailable: false,
  };
  const linkedContextElectionId = inviteContext.electionId?.trim() ?? "";
  const currentQuestionnaireId = snapshot?.electionId?.trim() || electionId.trim() || linkedContextElectionId || latestAnnouncedQuestionnaireId.trim();
  useEffect(() => {
    if (previousElectionIdRef.current !== currentQuestionnaireId) {
      setQuestionnaireStarted(false);
      previousElectionIdRef.current = currentQuestionnaireId;
    }
  }, [currentQuestionnaireId]);
  const draftPersistenceVoterNpub = signedInNpub.trim() || snapshot?.invitedNpub?.trim() || props.localVoterNpub?.trim() || "";
  const draftPersistenceKey = useMemo(
    () => optionAVoterDraftStorageKey(currentQuestionnaireId, draftPersistenceVoterNpub),
    [currentQuestionnaireId, draftPersistenceVoterNpub],
  );
  useEffect(() => {
    props.onActiveQuestionnaireIdChange?.(currentQuestionnaireId);
  }, [currentQuestionnaireId, props.onActiveQuestionnaireIdChange]);
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
    ?? (currentQuestionnaireId ? loadElectionSummary(currentQuestionnaireId)?.blindSigningPublicKey : null)
    ?? snapshot?.credentialReady,
  );
  const currentDefinition = autoRequestDefinition
    ?? (questionnaireDefinition?.questionnaireId === currentQuestionnaireId ? questionnaireDefinition : null)
    ?? (currentQuestionnaireId ? readCachedQuestionnaireDefinition(currentQuestionnaireId) : null);
  const receivedCredentialBallotGroup = ballotGroupFromReceivedCredential(snapshot);
  const activeBallotGroup = receivedCredentialBallotGroup !== undefined
    ? receivedCredentialBallotGroup
    : normaliseQuestionnaireBallotGroup(snapshot?.inviteMessage?.ballotGroup)
      ?? normaliseQuestionnaireBallotGroup(activeInvite?.ballotGroup)
      ?? normaliseQuestionnaireBallotGroup(inviteContext.invite?.ballotGroup)
      ?? normaliseQuestionnaireBallotGroup(inviteContext.ballotGroup)
      ?? normaliseQuestionnaireBallotGroup(snapshot?.privateInviteBallotGroup);
  const perQuestionMode = questionnaireUsesPerQuestionCredentials(currentDefinition);
  const proxyCredentialInvite = [
    snapshot?.inviteMessage,
    activeInvite,
    ...contextPendingInvites,
    inviteContext.invite,
  ].find((invite) => inviteGrantsProxyCredential(invite, currentQuestionnaireId)) ?? null;
  const recoveredProxyCredential = [...Object.values(snapshot?.blindRequests ?? {}), ...Object.values(snapshot?.blindIssuances ?? {})]
    .some((entry) => credentialIndexFromBallotScope(entry.ballotScope) >= 2);
  const persistedProxyCredential = snapshot?.privateInviteCredentialsPerVoter === 2
    || inviteContext.credentialsPerVoter === 2
    || recoveredProxyCredential;
  const credentialCount = proxyCredentialInvite || persistedProxyCredential ? 2 : questionnaireCredentialsPerVoter(currentDefinition);
  const showProxyBallotsTogether = credentialCount > 1;
  const credentialIndexes = useMemo(
    () => Array.from({ length: credentialCount }, (_, index) => index + 1),
    [credentialCount],
  );
  useEffect(() => {
    const invite = proxyCredentialInvite;
    if (
      !runtime
      || !snapshot?.loginVerified
      || !invite
      || snapshot.electionId !== currentQuestionnaireId
      || snapshot.inviteMessage?.credentialsPerVoter === 2
    ) {
      return;
    }

    const next = runtime.bootstrapWithLocalIdentity({
      invitedNpub: snapshot.invitedNpub,
      coordinatorNpub: invite.coordinatorNpub,
      invite,
      allowInviteRecipientMismatch: true,
      allowInviteMissing: true,
    });
    setSignedInNpub(next.invitedNpub);
    setRefreshNonce((value) => value + 1);

    if (next.blindRequestSent && !next.credentialReady && !next.submission) {
      void runtime.requestBlindBallot({ forceResend: true }).then(() => {
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setStatus(formatBlindRequestStatus("sent"));
        setRefreshNonce((value) => value + 1);
      }).catch(() => undefined);
    }
  }, [
    currentQuestionnaireId,
    proxyCredentialInvite,
    runtime,
    snapshot?.electionId,
    snapshot?.invitedNpub,
    snapshot?.inviteMessage?.credentialsPerVoter,
    snapshot?.loginVerified,
    snapshot?.submission,
  ]);

  useEffect(() => {
    if (
      settingsMode
      || !runtime
      || !snapshot?.loginVerified
      || !currentDefinition
      || !snapshot.blindRequestSent
      || snapshot.credentialReady
      || snapshot.submission
      || snapshot.electionId !== currentQuestionnaireId
      || (!perQuestionMode && credentialIndexes.length <= 1 && !activeBallotGroup)
    ) {
      return;
    }
    const scopedRequests = Object.values(snapshot.blindRequests ?? {});
    const scopedIssuances = Object.values(snapshot.blindIssuances ?? {});
    const seenCredentialIndexes = new Set(
      [...scopedRequests, ...scopedIssuances]
        .map((entry) => Math.max(1, Math.floor(entry.ballotScope?.credentialIndex ?? 1))),
    );
    const missingCredentialIndex = credentialIndexes.some((index) => !seenCredentialIndexes.has(index));
    const legacyOnlyRequest = Boolean(snapshot.blindRequest) && scopedRequests.length === 0 && scopedIssuances.length === 0;
    if (!legacyOnlyRequest && !missingCredentialIndex) {
      return;
    }
    const key = [
      currentQuestionnaireId,
      snapshot.invitedNpub,
      currentDefinition.createdAt,
      credentialIndexes.join(","),
      activeBallotGroup ?? "",
      perQuestionMode ? "per_question" : "questionnaire",
    ].join(":");
    if (scopedCredentialRecoveryForRef.current[key]) {
      return;
    }
    scopedCredentialRecoveryForRef.current[key] = true;
    void runtime.requestBlindBallot({ forceResend: true }).then(() => {
      markSignerWaitRecoveryBaseline();
      scheduleSignerInitialPull();
      setRefreshNonce((value) => value + 1);
    }).catch(() => {
      delete scopedCredentialRecoveryForRef.current[key];
    });
  }, [
    credentialIndexes,
    activeBallotGroup,
    currentDefinition,
    currentQuestionnaireId,
    perQuestionMode,
    runtime,
    settingsMode,
    snapshot?.blindIssuances,
    snapshot?.blindRequest,
    snapshot?.blindRequestSent,
    snapshot?.blindRequests,
    snapshot?.credentialReady,
    snapshot?.electionId,
    snapshot?.invitedNpub,
    snapshot?.loginVerified,
    snapshot?.submission,
  ]);
  const submittedQuestionKey = Object.entries(
    snapshot?.electionId === currentQuestionnaireId ? snapshot.submissions ?? {} : {},
  ).map(([key, submission]) => `${key}:${submission.submissionId}`).sort().join("|");
  const acceptedQuestionKey = Object.entries(
    snapshot?.electionId === currentQuestionnaireId ? snapshot.submissionDecisions ?? {} : {},
  )
    .filter(([, decision]) => decision.accepted)
    .map(([key, decision]) => `${key}:${decision.submissionId}`)
    .sort()
    .join("|");
  const acceptedQuestionIds = useMemo(() => new Set(
    acceptedQuestionKey
      ? acceptedQuestionKey.split("|").map((entry) => entry.split(":")[0]).filter(Boolean)
      : [],
  ), [acceptedQuestionKey]);
  const activeQuestion = questions[activeQuestionIndex] ?? null;
  const activeQuestionScope = perQuestionMode && activeQuestion
    ? scopedBallotScopeForQuestion(currentDefinition, activeQuestion.questionId, activeCredentialIndex, activeBallotGroup)
    : null;
  const activeQuestionScopeKey = perQuestionMode && activeQuestion
    ? scopedBallotScopeKey(activeQuestionScope)
    : "";
  const groupKeyForQuestionId = (questionId: string, credentialIndex = activeCredentialIndex) => (
    scopedBallotScopeKey(scopedBallotScopeForQuestion(currentDefinition, questionId, credentialIndex, activeBallotGroup))
  );
  const answerKeyForQuestion = (questionId: string, credentialIndex = activeCredentialIndex) => (
    showProxyBallotsTogether ? proxyAnswerKey(questionId, credentialIndex) : questionId
  );
  const activeQuestionGroupEntries = useMemo(() => (
    activeQuestion
      ? [{ question: activeQuestion, index: activeQuestionIndex }]
      : []
  ), [activeQuestion, activeQuestionIndex]);
  const activeQuestionIds = useMemo(
    () => activeQuestionGroupEntries.map(({ question }) => question.questionId),
    [activeQuestionGroupEntries],
  );
  const submittedQuestionGroupKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!perQuestionMode) {
      return keys;
    }
    const addSubmission = (submission: NonNullable<VoterElectionLocalState["submission"]>) => {
      const proofs = Array.isArray(submission.credentialBundle) ? submission.credentialBundle : [];
      if (proofs.length > 0) {
        for (const proof of proofs) {
          keys.add(scopedBallotScopeKey(proof.ballotScope));
        }
        return;
      }
      for (const response of submission.payload.responses ?? []) {
        keys.add(groupKeyForQuestionId(response.questionId, 1));
      }
    };
    for (const [key, submission] of Object.entries(snapshot?.electionId === currentQuestionnaireId ? snapshot.submissions ?? {} : {})) {
      if (key === "__questionnaire__" || key.startsWith("slot:") || key.includes(":c")) {
        keys.add(key);
      }
      addSubmission(submission);
    }
    return keys;
  }, [currentDefinition, currentQuestionnaireId, perQuestionMode, snapshot?.electionId, snapshot?.submissions, submittedQuestionKey]);
  const acceptedQuestionGroupKeys = useMemo(() => {
    const keys = new Set<string>();
    if (!perQuestionMode) {
      return keys;
    }
    const submissions = snapshot?.electionId === currentQuestionnaireId ? snapshot.submissions ?? {} : {};
    for (const [key, decision] of Object.entries(snapshot?.electionId === currentQuestionnaireId ? snapshot.submissionDecisions ?? {} : {})) {
      if (!decision.accepted) {
        continue;
      }
      if (key === "__questionnaire__" || key.startsWith("slot:") || key.includes(":c")) {
        keys.add(key);
      } else {
        keys.add(groupKeyForQuestionId(key, 1));
      }
      const matchingSubmission = Object.values(submissions).find((submission) => submission.submissionId === decision.submissionId) ?? null;
      for (const proof of matchingSubmission?.credentialBundle ?? []) {
        keys.add(scopedBallotScopeKey(proof.ballotScope));
      }
    }
    return keys;
  }, [acceptedQuestionKey, currentDefinition, currentQuestionnaireId, perQuestionMode, snapshot?.electionId, snapshot?.submissionDecisions, snapshot?.submissions]);
  const activeQuestionSubmittedForCredential = (credentialIndex: number) => (
    activeQuestionIds.length > 0
      && activeQuestionIds.every((questionId) => submittedQuestionGroupKeys.has(groupKeyForQuestionId(questionId, credentialIndex)))
  );
  const activeQuestionSubmitted = showProxyBallotsTogether
    ? credentialIndexes.every(activeQuestionSubmittedForCredential)
    : Boolean(activeQuestionScopeKey && submittedQuestionGroupKeys.has(activeQuestionScopeKey));
  const allQuestionResponsesSubmitted = perQuestionMode
    && questions.length > 0
    && credentialIndexes.every((credentialIndex) => (
      questions.every((question) => submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, credentialIndex)))
    ));
  const responseSubmittedForCurrentQuestionnaire = perQuestionMode
    ? activeQuestionSubmitted
    : Boolean(snapshot?.submission && snapshot.electionId === currentQuestionnaireId);
  const activeQuestionRequest = perQuestionMode && activeQuestionScopeKey
    ? snapshot?.blindRequests?.[activeQuestionScopeKey] ?? null
    : snapshot?.blindRequest ?? null;
  const activeQuestionIssuance = perQuestionMode && activeQuestionScopeKey
    ? snapshot?.blindIssuances?.[activeQuestionScopeKey] ?? null
    : snapshot?.blindIssuance ?? null;
  const activeQuestionCredentialReadyForCredential = (credentialIndex: number) => (
    activeQuestionIds.length > 0
      && activeQuestionIds.every((questionId) => Boolean(snapshot?.blindIssuances?.[groupKeyForQuestionId(questionId, credentialIndex)]))
  );
  const activeQuestionSubmission = perQuestionMode
    ? snapshot?.submissions?.[activeQuestionScopeKey] ?? activeQuestionIds.map((questionId) => snapshot?.submissions?.[questionId] ?? null).find((submission) => {
      if (!submission) {
        return false;
      }
      const proofs = Array.isArray(submission.credentialBundle) ? submission.credentialBundle : [];
      if (proofs.length > 0) {
        return proofs.some((proof) => scopedBallotScopeKey(proof.ballotScope) === activeQuestionScopeKey);
      }
      return submission.payload.responses.some((response) => activeQuestionIds.includes(response.questionId));
    }) ?? null
    : snapshot?.submission ?? null;
  const activeQuestionCredentialReady = perQuestionMode
    ? showProxyBallotsTogether
      ? credentialIndexes.every((credentialIndex) => (
        activeQuestionSubmittedForCredential(credentialIndex) || activeQuestionCredentialReadyForCredential(credentialIndex)
      ))
      : Boolean(activeQuestionIssuance)
    : Boolean(snapshot?.credentialReady);
  const activeQuestionRequestSent = perQuestionMode
    ? Boolean(activeQuestionRequest && (activeQuestionRequest.lastSentAt || snapshot?.blindRequestSent))
    : Boolean(snapshot?.blindRequestSent);

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
            if (restartSubscriptions && mode === "background") {
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
    const persisted = readPersistedOptionAVoterDraft(draftPersistenceKey);
    setAnswers(persisted?.answers ?? {});
    setEncryptFreeTextByQuestionId(persisted?.encryptFreeTextByQuestionId ?? {});
    setActiveQuestionIndex(persisted?.activeQuestionIndex ?? 0);
    setActiveCredentialIndex(persisted?.activeCredentialIndex ?? 1);
  }, [draftPersistenceKey, electionId]);

  useEffect(() => {
    if (!draftPersistenceKey) {
      return;
    }
    const persisted = readPersistedOptionAVoterDraft(draftPersistenceKey);
    if (!persisted) {
      return;
    }
    setAnswers((current) => answerRecordEquals(current, persisted.answers) ? current : persisted.answers);
    setEncryptFreeTextByQuestionId((current) => (
      answerRecordEquals(current, persisted.encryptFreeTextByQuestionId)
        ? current
        : persisted.encryptFreeTextByQuestionId
    ));
    setActiveQuestionIndex(persisted.activeQuestionIndex);
    setActiveCredentialIndex(persisted.activeCredentialIndex);
  }, [draftPersistenceKey]);

  useEffect(() => {
    if (!draftPersistenceKey) {
      return;
    }
    if (Object.keys(answers).length === 0 && Object.keys(encryptFreeTextByQuestionId).length === 0) {
      return;
    }
    writePersistedOptionAVoterDraft(draftPersistenceKey, {
      answers,
      encryptFreeTextByQuestionId,
      activeQuestionIndex,
      activeCredentialIndex,
    });
  }, [
    activeCredentialIndex,
    activeQuestionIndex,
    answers,
    draftPersistenceKey,
    encryptFreeTextByQuestionId,
  ]);

  useEffect(() => {
    setActiveQuestionIndex((current) => {
      if (questions.length === 0) {
        return 0;
      }
      return Math.min(Math.max(current, 0), questions.length - 1);
    });
    setActiveCredentialIndex((current) => Math.min(Math.max(current, 1), credentialCount));
  }, [credentialCount, questions.length]);

  useEffect(() => {
    if (!perQuestionMode || questions.length === 0) {
      return;
    }
    setActiveQuestionIndex((current) => {
      const currentQuestion = questions[current] ?? null;
      if (currentQuestion && !submittedQuestionGroupKeys.has(groupKeyForQuestionId(currentQuestion.questionId, activeCredentialIndex))) {
        return current;
      }
      const firstUnsubmittedIndex = questions.findIndex((question) => (
        !submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, activeCredentialIndex))
      ));
      if (firstUnsubmittedIndex >= 0) {
        return firstUnsubmittedIndex;
      }
      return Math.min(Math.max(current, 0), questions.length - 1);
    });
  }, [activeCredentialIndex, perQuestionMode, questions, submittedQuestionGroupKeys, submittedQuestionKey]);

  useEffect(() => {
    setPrivateInviteBlock(null);
  }, [electionId, inviteContext.inviteCode, props.localVoterNpub]);

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
    runtime.setBearerInviteCode(inviteContext.inviteCode, {
      credentialsPerVoter: inviteContext.credentialsPerVoter,
      ballotGroup: inviteContext.ballotGroup,
    });
  }, [runtime, inviteContext.inviteCode, inviteContext.credentialsPerVoter, inviteContext.ballotGroup]);

  useEffect(() => {
    return () => {
      runtime?.dispose();
    };
  }, [runtime]);

  useEffect(() => {
    if (!runtime) {
      return undefined;
    }
    return runtime.subscribeStateChanges(() => {
      setRefreshNonce((value) => value + 1);
    });
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
    if (!localVoterNpub || !props.localVoterNsec?.trim()) {
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
          setStatus("Invite already claimed by this device/account.");
          setRefreshNonce((value) => value + 1);
          return;
        }
        const inviteStatus = await checkPrivateInviteBeforeBallot({
          questionnaireId: next.electionId,
          voterNpub: next.invitedNpub,
          coordinatorNpub: next.coordinatorNpub || coordinatorNpub,
        });
        if (!inviteStatus.ok) {
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
          setStatus(inviteStatus.claimedByThisDevice
            ? "Invite already claimed by this device/account."
            : formatBlindRequestStatus("sent"));
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
      delete bearerInviteBootstrapForRef.current[key];
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
    props.localVoterNsec,
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
      }, AUTO_BALLOT_WAIT_FOREGROUND_REFRESH_MS);
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
      setQuestions(filterQuestionsForBallotGroup(mapDefinitionQuestions(localDefinition), activeBallotGroup));
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
        setQuestions(filterQuestionsForBallotGroup(mapDefinitionQuestions(latest), activeBallotGroup));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeBallotGroup, activeInvite, contextPendingInvites, electionId, inviteContext.invite, snapshot?.blindIssuance, snapshot?.inviteMessage]);

  useEffect(() => {
    const currentId = electionId.trim();
    const multipleChoicesKnown = announcedQuestionnaireIds.length > 1 || contextPendingInvites.length > 1;
    const preserveCurrentSelection = multipleChoicesKnown && Boolean(props.localVoterNpub?.trim() || signedInNpub.trim());
    if (
      !linkedContextElectionId
      && latestAnnouncedQuestionnaireId
      && (
        !currentId
        || (!preserveCurrentSelection && !hasInFlightState() && currentId !== latestAnnouncedQuestionnaireId)
      )
    ) {
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
  }, [announcedQuestionnaireIds.length, contextPendingInvites.length, electionId, latestAnnouncedQuestionnaireId, linkedContextElectionId, props.localVoterNpub, signedInNpub, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  useEffect(() => {
    if (contextPendingInvites.length === 0 || hasInFlightState()) {
      return;
    }
    const multipleChoicesKnown = announcedQuestionnaireIds.length > 1 || contextPendingInvites.length > 1;
    const preserveCurrentSelection = multipleChoicesKnown && Boolean(props.localVoterNpub?.trim() || signedInNpub.trim());
    const preferredInvite = (latestAnnouncedQuestionnaireId
      ? contextPendingInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId)
      : null)
      ?? (linkedContextElectionId ? null : contextPendingInvites.at(-1))
      ?? null;
    const nextElectionId = preferredInvite?.electionId?.trim() ?? "";
    if (nextElectionId && electionId.trim() !== nextElectionId && (!electionId.trim() || !preserveCurrentSelection)) {
      setElectionId(nextElectionId);
    }
  }, [announcedQuestionnaireIds.length, contextPendingInvites, electionId, latestAnnouncedQuestionnaireId, linkedContextElectionId, props.localVoterNpub, signedInNpub, snapshot?.blindRequest?.requestId, snapshot?.credentialReady, snapshot?.submission?.submissionId]);

  useEffect(() => {
    const voterNpub = signedInNpub.trim();
    const inFlight = hasInFlightState();
    if (!voterNpub || inviteContext.invite) {
      return;
    }
    if (!inFlight && (pendingInvites.length > 0 || activeInvite)) {
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
        if (inFlight && currentQuestionnaireId) {
          const matchingInvites = invites.filter((invite) => invite.electionId === currentQuestionnaireId);
          if (matchingInvites.length > 0) {
            setPendingInvites((current) => mergeInvitesByKey(current, matchingInvites));
          }
          return;
        }
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
  }, [activeInvite, currentQuestionnaireId, electionId, inviteContext.invite, latestAnnouncedQuestionnaireId, linkedContextElectionId, pendingInvites.length, signedInNpub, snapshot?.blindRequest?.requestId, snapshot?.blindIssuance?.issuanceId, snapshot?.submission?.submissionId]);

  useEffect(() => {
    const voterNpub = signedInNpub.trim()
      || snapshot?.invitedNpub?.trim()
      || props.localVoterNpub?.trim()
      || "";
    if (!voterNpub || !announcedQuestionnaireIdKey) {
      return;
    }
    const localInvites = listInvitesFromMailbox(voterNpub)
      .filter((invite) => (
        !linkedContextElectionId
        || invite.electionId === linkedContextElectionId
        || announcedQuestionnaireIdSet.has(invite.electionId)
      ))
      .filter((invite) => {
        if (props.localVoterNpub?.trim()) {
          return true;
        }
        const invitee = invite.invitedNpub?.trim() ?? "";
        return !invitee || invitee === voterNpub;
      });
    if (localInvites.length === 0) {
      return;
    }
    setPendingInvites((current) => {
      const next = mergeInvitesByKey(current, localInvites);
      const changed = next.length !== current.length
        || next.some((invite, index) => current[index] !== invite);
      return changed ? next : current;
    });
  }, [
    announcedQuestionnaireIdKey,
    announcedQuestionnaireIdSet,
    linkedContextElectionId,
    props.localVoterNpub,
    signedInNpub,
    snapshot?.invitedNpub,
  ]);

  const answerableQuestions = useMemo(
    () => activeQuestionGroupEntries.map(({ question }) => question),
    [activeQuestionGroupEntries],
  );
  const visibleQuestionEntries = useMemo(
    () => activeQuestion ? [{ question: activeQuestion, index: activeQuestionIndex }] : [],
    [activeQuestion, activeQuestionIndex],
  );
  const requiredQuestions = useMemo(
    () => answerableQuestions.filter((question) => question.required || (question.type === "rank" && (question.minimumRanked ?? 0) > 0)),
    [answerableQuestions],
  );
  const requiredQuestionIds = useMemo(
    () => requiredQuestions.map((question) => question.questionId),
    [requiredQuestions],
  );
  const requiredQuestionsForQuestionnaire = useMemo(
    () => questions.filter((question) => question.required || (question.type === "rank" && (question.minimumRanked ?? 0) > 0)),
    [questions],
  );
  const requiredQuestionIdsForQuestionnaire = useMemo(
    () => requiredQuestionsForQuestionnaire.map((question) => question.questionId),
    [requiredQuestionsForQuestionnaire],
  );

  function hasInFlightState(state = snapshot) {
    return Boolean(state?.blindRequest || state?.blindIssuance || state?.submission);
  }

  function findBestLocalInvite(voterNpub: string, preferredElectionId = electionId || linkedContextElectionId) {
    const voter = voterNpub.trim();
    const localInvites = [...listInvitesFromMailbox(voter)];
    const urlInvite = inviteContext.invite?.invitedNpub?.trim() === voter ? inviteContext.invite : null;
    const chooseInvite = (
      localInvite: ElectionInviteMessage | null | undefined,
      matchingUrlInvite: ElectionInviteMessage | null | undefined,
    ) => (
      matchingUrlInvite?.credentialsPerVoter === 2 ? matchingUrlInvite : localInvite ?? matchingUrlInvite ?? null
    );
    const preferredId = preferredElectionId.trim();
    if (preferredId) {
      const matchingUrlInvite = urlInvite?.electionId === preferredId ? urlInvite : null;
      const matchingLocalInvite = localInvites.find((invite) => invite.electionId === preferredId) ?? null;
      return chooseInvite(matchingLocalInvite, matchingUrlInvite);
    }
    if (latestAnnouncedQuestionnaireId) {
      const matchingUrlInvite = urlInvite?.electionId === latestAnnouncedQuestionnaireId ? urlInvite : null;
      const matchingLocalInvite = localInvites.find((invite) => invite.electionId === latestAnnouncedQuestionnaireId) ?? null;
      return chooseInvite(matchingLocalInvite, matchingUrlInvite);
    }
    return chooseInvite(localInvites.at(-1), urlInvite);
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
    const activeQuestionnaireId = electionId.trim()
      || currentSnapshot?.electionId?.trim()
      || linkedContextElectionId
      || latestAnnouncedQuestionnaireId.trim();
    const fallbackInvite = findBestLocalInvite(localVoterNpub, activeQuestionnaireId);
    const targetQuestionnaireId = activeQuestionnaireId
      || fallbackInvite?.electionId?.trim();
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

    if (!input.allowRelayFetch) {
      return mergeInvitesByKey(fromMailbox);
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
        return mergeInvitesByKey(dmInvites, fromMailbox);
      } catch {
        return mergeInvitesByKey(fromMailbox);
      }
    }

    try {
      const signer = createVoterSignerService(props.localVoterNsec);
      const dmInvites = await fetchOptionAInviteDms({ signer, limit: 40 });
      for (const invite of dmInvites) {
        publishInviteToMailbox(invite);
      }
      return mergeInvitesByKey(dmInvites, fromMailbox);
    } catch {
      return mergeInvitesByKey(fromMailbox);
    }
  }

  async function buildPublicQuestionnaireInvite(voterNpub: string): Promise<ElectionInviteMessage | null> {
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
        coordinatorNpub: definition?.coordinatorPubkey
          ?? existingSummary?.coordinatorNpub
          ?? inviteContext.coordinatorNpub
          ?? null,
      });
      issueBlindTokensWorker = delegation?.workerNpub?.trim()
        ? buildIssueBlindTokensWorkerRouting({
          delegationId: delegation.delegationId,
          workerNpub: delegation.workerNpub,
          controlRelays: delegation.controlRelays,
          dmRelays: delegation.dmRelays ?? SIMPLE_DM_RELAYS,
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
        definitionReference: {
          questionnaireId: targetElectionId,
          coordinatorNpub,
          relays: existingSummary?.questionnaireRelays,
        },
        issueBlindTokensWorker,
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
    const publicQuestionnaireInvite = await buildPublicQuestionnaireInvite(voterNpub);
    const fallbackInvite = publicQuestionnaireInvite ?? findBestLocalInvite(voterNpub);
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
      setPrivateInviteBlock(null);
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
      const waitingForCredential = Boolean(next.blindRequestSent && !next.credentialReady && !next.submission);
      setActiveInvite(!next.blindRequestSent && !next.credentialReady ? invite : null);
      if (requestAfterLogin && !next.credentialReady && !next.submission) {
        await voterRuntime.requestBlindBallot(waitingForCredential ? { forceResend: true } : undefined);
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setStatus("Opened " + (invite.title || invite.electionId) + (
          waitingForCredential
            ? ". Blind ballot request resent."
            : ". Blind ballot request sent."
        ));
      } else {
        setStatus("Opened " + (invite.title || invite.electionId) + ".");
      }
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not open invite.");
    }
  }

  function buildDraftResponsesForCredential(credentialIndex = activeCredentialIndex, questionIds?: string[]) {
    const targetQuestionIds = questionIds && questionIds.length > 0 ? new Set(questionIds) : null;
    return questions
      .filter((question) => !targetQuestionIds || targetQuestionIds.has(question.questionId))
      .map((question) => {
        const key = answerKeyForQuestion(question.questionId, credentialIndex);
        return answerToOptionA(
          question,
          answers[key],
          question.type === "free_text"
            ? Boolean(question.encryptResponses || encryptFreeTextByQuestionId[key])
            : false,
        );
      })
      .filter((value): value is QuestionnaireAnswer => Boolean(value));
  }

  function pushAnswers(credentialIndex = activeCredentialIndex, questionIds?: string[]) {
    if (!runtime || responseSubmittedForCurrentQuestionnaire) {
      return;
    }
    const next = buildDraftResponsesForCredential(credentialIndex, questionIds);
    runtime.updateDraftResponses(next);
    setRefreshNonce((value) => value + 1);
  }

  async function publishProvisionalAnswers(questionIds: string[], credentialIndex = activeCredentialIndex) {
    if (!runtime || questionIds.length === 0) {
      return false;
    }
    try {
      const published = await runtime.publishProvisionalResponses(questionIds, { credentialIndex });
      return Boolean(published?.successes);
    } catch (error) {
      console.debug("Questionnaire provisional response publish failed", error);
      return false;
    }
  }

  async function publishCurrentProvisionalAnswers(questionIds = activeQuestionIds) {
    if (!runtime || questionIds.length === 0) {
      return false;
    }
    if (showProxyBallotsTogether) {
      let attempted = false;
      for (const credentialIndex of proxyCredentialIndexesToSubmit) {
        const draftResponses = buildDraftResponsesForCredential(credentialIndex, questionIds);
        if (draftResponses.length === 0) {
          continue;
        }
        attempted = true;
        runtime.updateDraftResponses(draftResponses);
        if (!await publishProvisionalAnswers(questionIds, credentialIndex)) {
          return false;
        }
      }
      if (attempted) {
        setRefreshNonce((value) => value + 1);
      }
      return attempted;
    }
    const draftResponses = buildDraftResponsesForCredential(activeCredentialIndex, questionIds);
    if (draftResponses.length === 0) {
      return false;
    }
    runtime.updateDraftResponses(draftResponses);
    setRefreshNonce((value) => value + 1);
    return publishProvisionalAnswers(questionIds, activeCredentialIndex);
  }

  function publishCurrentProvisionalAnswersInBackground(questionIds: string[]) {
    void (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await publishCurrentProvisionalAnswers(questionIds)) {
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1200 * (attempt + 1)));
      }
    })();
  }

  function advanceAfterPublishing(questionIds: string[], nextQuestionIndex: number) {
    if (nextQuestionIndex < 0) {
      return;
    }
    const hasCurrentAnswer = showProxyBallotsTogether ? proxyActiveQuestionHasResponse : activeQuestionHasResponse;
    if (!activeQuestionSubmitted && hasCurrentAnswer) {
      publishCurrentProvisionalAnswersInBackground(questionIds);
    }
    setStatus(null);
    setActiveQuestionIndex(nextQuestionIndex);
  }

  function addRankedAnswer(questionId: string, optionId: string, credentialIndex = activeCredentialIndex) {
    if (responseSubmittedForCurrentQuestionnaire || activeQuestionSubmittedForCredential(credentialIndex)) {
      return;
    }
    const key = answerKeyForQuestion(questionId, credentialIndex);
    setAnswers((current) => {
      const existing = Array.isArray(current[key])
        ? (current[key] as string[])
        : [];
      if (existing.includes(optionId)) {
        return current;
      }
      return { ...current, [key]: [...existing, optionId] };
    });
  }

  function moveRankedAnswer(questionId: string, optionId: string, direction: -1 | 1, credentialIndex = activeCredentialIndex) {
    if (responseSubmittedForCurrentQuestionnaire || activeQuestionSubmittedForCredential(credentialIndex)) {
      return;
    }
    const key = answerKeyForQuestion(questionId, credentialIndex);
    setAnswers((current) => {
      const existing = Array.isArray(current[key])
        ? [...(current[key] as string[])]
        : [];
      const index = existing.indexOf(optionId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= existing.length) {
        return current;
      }
      const swap = existing[index];
      existing[index] = existing[target];
      existing[target] = swap;
      return { ...current, [key]: existing };
    });
  }

  function removeRankedAnswer(questionId: string, optionId: string, credentialIndex = activeCredentialIndex) {
    if (responseSubmittedForCurrentQuestionnaire || activeQuestionSubmittedForCredential(credentialIndex)) {
      return;
    }
    const key = answerKeyForQuestion(questionId, credentialIndex);
    setAnswers((current) => {
      const existing = Array.isArray(current[key])
        ? (current[key] as string[])
        : [];
      return { ...current, [key]: existing.filter((entry) => entry !== optionId) };
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

  function formatBlindRequestStatus(action: "sent" | "resent") {
    const verb = action === "resent" ? "resent" : "sent";
    const issuerName = getCredentialIssuerDisplayName();
    if (issuerName === "audit proxy") {
      return `Blind ballot request ${verb}.`;
    }
    return `Blind ballot request ${verb}. Waiting for ${issuerName} issuance.`;
  }

  function buildGeneralPrivateInviteFallbackUrl(questionnaireId: string, coordinatorNpub?: string | null) {
    const id = questionnaireId.trim();
    if (!id || typeof window === "undefined") {
      return null;
    }
    return buildQuestionnaireInviteUrl({
      baseUrl: window.location.href,
      electionId: id,
      coordinatorNpub: coordinatorNpub?.trim() || undefined,
      relays: readCachedQuestionnaireDefinition(id)?.questionnaireRelays
        ?? loadElectionSummary(id)?.questionnaireRelays
        ?? null,
      login: false,
      autoRequestBallot: true,
    });
  }

  async function checkPrivateInviteBeforeBallot(input: {
    questionnaireId: string;
    voterNpub: string;
    coordinatorNpub?: string | null;
  }): Promise<{ ok: boolean; claimedByThisDevice: boolean; statusKnown: boolean }> {
    const inviteCode = inviteContext.inviteCode?.trim() ?? "";
    if (!inviteCode) {
      setPrivateInviteBlock(null);
      return { ok: true, claimedByThisDevice: false, statusKnown: true };
    }
    const questionnaireId = input.questionnaireId.trim();
    const voterNpub = input.voterNpub.trim();
    if (!questionnaireId || !voterNpub) {
      return { ok: true, claimedByThisDevice: false, statusKnown: false };
    }
    const codeHash = await hashQuestionnaireInviteCode(inviteCode);
    if (!codeHash) {
      return { ok: true, claimedByThisDevice: false, statusKnown: false };
    }
    const definition = readCachedQuestionnaireDefinition(questionnaireId);
    const summary = loadElectionSummary(questionnaireId);
    const relays = mergeQuestionnaireRelayHints(definition?.questionnaireRelays, summary?.questionnaireRelays);
    const latestStatus = await fetchQuestionnairePrivateInviteStatus({
      questionnaireId,
      codeHash,
      relays: relays.length > 0 ? relays : undefined,
      limit: 20,
      maxPages: PRIVATE_INVITE_STATUS_QUICK_CHECK_MAX_PAGES,
      timeBudgetMs: PRIVATE_INVITE_STATUS_QUICK_CHECK_TIME_BUDGET_MS,
    }).catch(() => null);
    const statusEvent = latestStatus?.status ?? null;
    if (!statusEvent) {
      setPrivateInviteBlock(null);
      return { ok: true, claimedByThisDevice: false, statusKnown: false };
    }
    if (statusEvent.state === "available") {
      setPrivateInviteBlock(null);
      return { ok: true, claimedByThisDevice: false, statusKnown: true };
    }
    const coordinatorNpub = statusEvent.coordinatorPubkey?.trim()
      || input.coordinatorNpub?.trim()
      || summary?.coordinatorNpub?.trim()
      || definition?.coordinatorPubkey?.trim()
      || inviteContext.coordinatorNpub?.trim()
      || null;
    const generalInviteUrl = buildGeneralPrivateInviteFallbackUrl(questionnaireId, coordinatorNpub);
    if (statusEvent.state === "redeemed") {
      const ownClaimHash = await hashQuestionnairePrivateInviteClaim({ codeHash, npub: voterNpub });
      if (ownClaimHash && statusEvent.redeemedNpubHash === ownClaimHash) {
        setPrivateInviteBlock(null);
        setStatus("Invite already claimed by this device/account.");
        return { ok: true, claimedByThisDevice: true, statusKnown: true };
      }
      setPrivateInviteBlock({
        questionnaireId,
        coordinatorNpub,
        generalInviteUrl,
        reason: "redeemed",
      });
      setStatus("Private invite already used.");
      return { ok: false, claimedByThisDevice: false, statusKnown: true };
    }
    setPrivateInviteBlock({
      questionnaireId,
      coordinatorNpub,
      generalInviteUrl,
      reason: "revoked",
    });
    setStatus("Private invite is no longer available.");
    return { ok: false, claimedByThisDevice: false, statusKnown: true };
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
      const requestSnapshot = ensureLocalSession({ allowInviteMissing: true, allowRelayInviteFetch: true }) ?? runtime.getSnapshot();
      let claimedByThisDevice = false;
      if (requestSnapshot?.electionId && requestSnapshot.invitedNpub) {
        const inviteStatus = await checkPrivateInviteBeforeBallot({
          questionnaireId: requestSnapshot.electionId,
          voterNpub: requestSnapshot.invitedNpub,
          coordinatorNpub: requestSnapshot.coordinatorNpub,
        });
        if (!inviteStatus.ok) {
          return;
        }
        claimedByThisDevice = inviteStatus.claimedByThisDevice;
      }
      const wasAlreadyWaiting = Boolean(runtime.getSnapshot()?.blindRequestSent && !runtime.getSnapshot()?.credentialReady);
      await runtime.requestBlindBallot({ forceResend: true });
      markSignerWaitRecoveryBaseline();
      scheduleSignerInitialPull();
      if (snapshot?.electionId && snapshot?.invitedNpub) {
        const requestKey = `${snapshot.electionId}:${snapshot.invitedNpub}`;
        autoRequestSentForRef.current[requestKey] = true;
      }
      setActiveInvite(null);
      setStatus(wasAlreadyWaiting
        ? formatBlindRequestStatus("resent")
        : claimedByThisDevice
          ? "Invite already claimed by this device/account."
          : formatBlindRequestStatus("sent")
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
    if (!currentDefinition || currentDefinition.questionnaireId !== targetElectionId) {
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
    currentDefinition,
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

  function findAdjacentQuestionIndex(fromIndex: number, direction: -1 | 1) {
    if (questions.length === 0) {
      return -1;
    }
    const index = fromIndex + direction;
    if (index < 0 || index >= questions.length) {
      return -1;
    }
    return index;
  }

  function findNextUnsubmittedQuestionIndex(fromIndex: number, credentialIndex = activeCredentialIndex, justSubmittedQuestionIds: string[] = [], justSubmittedCredentialIndexes: number[] = [credentialIndex]) {
    if (!perQuestionMode || questions.length === 0) {
      return -1;
    }
    const justSubmittedGroupKeys = new Set(
      justSubmittedCredentialIndexes.flatMap((submittedCredentialIndex) => (
        justSubmittedQuestionIds.map((questionId) => groupKeyForQuestionId(questionId, submittedCredentialIndex))
      )),
    );
    const isSubmitted = (questionId: string) => {
      if (showProxyBallotsTogether) {
        return credentialIndexes.every((candidateCredentialIndex) => {
          const groupKey = groupKeyForQuestionId(questionId, candidateCredentialIndex);
          return submittedQuestionGroupKeys.has(groupKey) || justSubmittedGroupKeys.has(groupKey);
        });
      }
      const groupKey = groupKeyForQuestionId(questionId, credentialIndex);
      return submittedQuestionGroupKeys.has(groupKey) || justSubmittedGroupKeys.has(groupKey);
    };
    for (let offset = 1; offset <= questions.length; offset += 1) {
      const index = (fromIndex + offset) % questions.length;
      if (!isSubmitted(questions[index].questionId)) {
        return index;
      }
    }
    return -1;
  }

  function findNextQuestionIndexInActiveGroup(fromIndex: number) {
    if (questions.length === 0) {
      return -1;
    }
    return findAdjacentQuestionIndex(fromIndex, 1);
  }

  function moveToNextProxyCredentialIfNeeded(justSubmittedQuestionIds: string[]) {
    if (!perQuestionMode || activeCredentialIndex >= credentialCount) {
      return false;
    }
    const justSubmittedGroupKeys = new Set(
      justSubmittedQuestionIds.map((questionId) => groupKeyForQuestionId(questionId, activeCredentialIndex)),
    );
    const currentCredentialComplete = questions.every((question) => {
      const groupKey = groupKeyForQuestionId(question.questionId, activeCredentialIndex);
      return submittedQuestionGroupKeys.has(groupKey) || justSubmittedGroupKeys.has(groupKey);
    });
    if (!currentCredentialComplete) {
      return false;
    }
    const nextCredentialIndex = activeCredentialIndex + 1;
    const firstUnsubmittedIndex = questions.findIndex((question) => (
      !submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, nextCredentialIndex))
    ));
    setActiveCredentialIndex(nextCredentialIndex);
    setActiveQuestionIndex(firstUnsubmittedIndex >= 0 ? firstUnsubmittedIndex : 0);
    setAnswers({});
    setEncryptFreeTextByQuestionId({});
    setStatus(null);
    return true;
  }

  async function submit(options?: { submitAllQuestions?: boolean }) {
    if (!runtime || submitInFlight) {
      return;
    }
    setSubmitInFlight(true);
    try {
      await nextPaint();
      const submitQuestionIds = perQuestionMode
        ? options?.submitAllQuestions
          ? questions.map((question) => question.questionId)
          : activeQuestionIds
        : showProxyBallotsTogether
          ? questions.map((question) => question.questionId)
          : [];
      const submitQuestionIdSet = new Set(submitQuestionIds);
      const submitRequiredQuestionSourceIds = options?.submitAllQuestions
        ? requiredQuestionIdsForQuestionnaire
        : requiredQuestionIds;
      const submitRequiredQuestionIds = submitQuestionIdSet.size > 0
        ? submitRequiredQuestionSourceIds.filter((questionId) => submitQuestionIdSet.has(questionId))
        : submitRequiredQuestionSourceIds;
      if (showProxyBallotsTogether && submitQuestionIds.length > 0) {
        const submittedCredentialIndexes: number[] = [];
        for (const credentialIndex of proxyCredentialIndexesToSubmit) {
          runtime.updateDraftResponses(buildDraftResponsesForCredential(credentialIndex, submitQuestionIds));
          publishProvisionalAnswers(submitQuestionIds, credentialIndex);
          await runtime.submitVote(submitRequiredQuestionIds, {
            questionIds: submitQuestionIds,
            credentialIndex,
          });
          submittedCredentialIndexes.push(credentialIndex);
        }
        const nextQuestionIndex = findNextUnsubmittedQuestionIndex(
          activeQuestionIndex,
          activeCredentialIndex,
          submitQuestionIds,
          submittedCredentialIndexes,
        );
        if (nextQuestionIndex >= 0) {
          setActiveQuestionIndex(nextQuestionIndex);
          setStatus(null);
        } else {
          setStatus("All question responses submitted.");
        }
        setRefreshNonce((value) => value + 1);
        return;
      }
      pushAnswers();
      publishProvisionalAnswers(submitQuestionIds.length > 0 ? submitQuestionIds : requiredQuestionIds, activeCredentialIndex);
      await runtime.submitVote(
        submitRequiredQuestionIds,
        submitQuestionIds.length > 0
          ? { questionIds: submitQuestionIds, credentialIndex: activeCredentialIndex }
          : undefined,
      );
      if (perQuestionMode) {
        if (moveToNextProxyCredentialIfNeeded(submitQuestionIds)) {
          setRefreshNonce((value) => value + 1);
          return;
        }
        const nextQuestionIndex = findNextUnsubmittedQuestionIndex(activeQuestionIndex, activeCredentialIndex, submitQuestionIds);
        if (nextQuestionIndex >= 0) {
          setActiveQuestionIndex(nextQuestionIndex);
          setStatus(null);
        } else {
          setStatus("All question responses submitted.");
        }
      } else {
        setStatus(null);
      }
      setRefreshNonce((value) => value + 1);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Submit failed.");
    } finally {
      setSubmitInFlight(false);
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
        setStatus(formatBlindRequestStatus("sent"));
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
          await runtime.requestBlindBallot({ forceResend: true, minRetryMs: resendMs });
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
    const resendMs = AUTO_BALLOT_RETRY_RESEND_MS;
    const key = snapshot.electionId + ":" + snapshot.invitedNpub;
    let cancelled = false;
    let retryInFlight = false;
    let timeoutId: number | null = null;
    const refreshAndMaybeResend = async (mode: BallotWaitRefreshMode) => {
      if (!isPageVisible()) {
        return;
      }
      queueBallotWaitRefresh({ mode });
      if (retryInFlight) {
        return;
      }
      const now = Date.now();
      const current = runtime.getSnapshot();
      if (!current?.blindRequestSent || current.credentialReady || current.submission) {
        return;
      }
      const lastSentMs = current.blindRequestSentAt ? Date.parse(current.blindRequestSentAt) : Number.NaN;
      if (Number.isFinite(lastSentMs) && now - lastSentMs < resendMs) {
        return;
      }
      const lastAttemptAt = requestRetryAtRef.current[key] ?? 0;
      if (now - lastAttemptAt < resendMs) {
        return;
      }
      requestRetryAtRef.current[key] = now;
      retryInFlight = true;
      try {
        await runtime.requestBlindBallot({ forceResend: true, minRetryMs: resendMs });
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        queueBallotWaitRefresh({
          restartSubscriptions: true,
          mode: "manual",
          forceWhenHidden: true,
        });
      } catch {
        // Retry is best-effort; the visible resend button still surfaces errors.
      } finally {
        retryInFlight = false;
      }
    };
    const triggerForegroundRefresh = (mode: BallotWaitRefreshMode) => {
      if (!isPageVisible()) {
        return;
      }
      const now = Date.now();
      if (now - ballotWaitLifecycleTriggerAtRef.current < 1_500) {
        return;
      }
      ballotWaitLifecycleTriggerAtRef.current = now;
      void refreshAndMaybeResend(mode);
    };
    const loop = () => {
      timeoutId = window.setTimeout(async () => {
        if (cancelled) {
          return;
        }
        if (isPageVisible()) {
          const mode: BallotWaitRefreshMode = isLikelyMobileClient() ? "background" : "lifecycle";
          await refreshAndMaybeResend(mode);
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
  }, [runtime, props.localVoterNsec, snapshot?.electionId, snapshot?.invitedNpub, snapshot?.loginVerified, snapshot?.blindRequestSent, snapshot?.credentialReady, snapshot?.submission]);

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
        index === AUTO_BALLOT_SIGNER_REFRESH_SCHEDULE_MS.length - 1
          ? "manual"
          : "lifecycle";
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
      void (async () => {
        const inviteStatus = await checkPrivateInviteBeforeBallot({
          questionnaireId: current.electionId,
          voterNpub: current.invitedNpub,
          coordinatorNpub: current.coordinatorNpub,
        });
        if (!inviteStatus.ok) {
          return;
        }
        await runtime.requestBlindBallot();
        autoRequestSentForRef.current[requestKey] = true;
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setActiveInvite(null);
        setStatus(formatBlindRequestStatus("sent"));
        setRefreshNonce((value) => value + 1);
      })().catch((error) => {
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
  const linkedDropdownCoordinatorNpub = linkedContextElectionId
    ? inviteContext.coordinatorNpub?.trim()
      || snapshot?.coordinatorNpub?.trim()
      || activeInvite?.coordinatorNpub?.trim()
      || pendingInvites.find((invite) => invite.electionId === linkedContextElectionId)?.coordinatorNpub?.trim()
      || readCachedQuestionnaireDefinition(linkedContextElectionId)?.coordinatorPubkey?.trim()
      || loadElectionSummary(linkedContextElectionId)?.coordinatorNpub?.trim()
      || ""
    : "";
  const inviteDropdownSourceInvites = useMemo(() => {
    if (!linkedContextElectionId) {
      return contextPendingInvites;
    }
    return pendingInvites.filter((invite) => {
      if (invite.electionId === linkedContextElectionId) {
        return true;
      }
      if (!announcedQuestionnaireIdSet.has(invite.electionId)) {
        return false;
      }
      return Boolean(linkedDropdownCoordinatorNpub) && invite.coordinatorNpub === linkedDropdownCoordinatorNpub;
    });
  }, [
    announcedQuestionnaireIdSet,
    contextPendingInvites,
    linkedContextElectionId,
    linkedDropdownCoordinatorNpub,
    pendingInvites,
  ]);
  const syntheticInviteQuestionnaireIds = useMemo(() => {
    const ids = [...announcedQuestionnaireIds];
    const currentId = currentQuestionnaireId.trim();
    if (currentId && !ids.includes(currentId)) {
      ids.unshift(currentId);
    }
    const loadedId = electionId.trim();
    if (loadedId && !ids.includes(loadedId)) {
      ids.unshift(loadedId);
    }
    return ids;
  }, [announcedQuestionnaireIds, currentQuestionnaireId, electionId]);
  const buildSyntheticInviteForQuestionnaireId = (questionnaireId: string): ElectionInviteMessage | null => {
    const id = questionnaireId.trim();
    if (!id) {
      return null;
    }
    const definition = (questionnaireDefinition?.questionnaireId === id ? questionnaireDefinition : null)
      ?? (activeInvite?.definition?.questionnaireId === id ? activeInvite.definition : null)
      ?? (snapshot?.blindIssuance?.definition?.questionnaireId === id ? snapshot.blindIssuance.definition : null)
      ?? (snapshot?.inviteMessage?.definition?.questionnaireId === id ? snapshot.inviteMessage.definition : null)
      ?? (inviteContext.invite?.definition?.questionnaireId === id ? inviteContext.invite.definition : null)
      ?? readCachedQuestionnaireDefinition(id);
    const summary = loadElectionSummary(id);
    const coordinatorNpub = definition?.coordinatorPubkey?.trim()
      || (snapshot?.electionId === id ? snapshot.coordinatorNpub?.trim() : "")
      || (activeInvite?.electionId === id ? activeInvite.coordinatorNpub?.trim() : "")
      || (snapshot?.inviteMessage?.electionId === id ? snapshot.inviteMessage.coordinatorNpub?.trim() : "")
      || (inviteContext.invite?.electionId === id ? inviteContext.invite.coordinatorNpub?.trim() : "")
      || summary?.coordinatorNpub?.trim()
      || linkedDropdownCoordinatorNpub
      || "";
    if (!coordinatorNpub) {
      return null;
    }
    if (linkedDropdownCoordinatorNpub && coordinatorNpub !== linkedDropdownCoordinatorNpub) {
      return null;
    }
    const invitedNpub = props.localVoterNpub?.trim()
      || signedInNpub.trim()
      || (snapshot?.electionId === id ? snapshot.invitedNpub?.trim() : "")
      || "";
    const title = definition?.title?.trim() || summary?.title?.trim() || id;
    return {
      type: "election_invite",
      schemaVersion: 1,
      electionId: id,
      title,
      description: definition?.description ?? summary?.description ?? "",
      voteUrl: typeof window === "undefined" ? "" : window.location.href,
      invitedNpub,
      coordinatorNpub,
      definitionReference: definition
        ? buildQuestionnaireDefinitionReference({ definition })
        : {
          questionnaireId: id,
          coordinatorNpub,
          relays: summary?.questionnaireRelays,
        },
      issueBlindTokensWorker: summary?.issueBlindTokensWorker ?? null,
      expiresAt: null,
    };
  };
  const inviteDropdownOptions = useMemo(() => {
    const map = new Map<string, ElectionInviteMessage>();
    for (const questionnaireId of syntheticInviteQuestionnaireIds) {
      const syntheticInvite = buildSyntheticInviteForQuestionnaireId(questionnaireId);
      if (syntheticInvite && canShowInviteForCurrentIdentity(syntheticInvite)) {
        map.set(inviteMessageKey(syntheticInvite), syntheticInvite);
      }
    }
    for (const invite of inviteDropdownSourceInvites) {
      if (!canShowInviteForCurrentIdentity(invite)) {
        continue;
      }
      map.set(inviteMessageKey(invite), invite);
    }
    const currentInvite = snapshot?.inviteMessage ?? activeInvite ?? null;
    if (currentInvite) {
      const currentInviteIsInContext = !linkedContextElectionId || currentInvite.electionId === linkedContextElectionId;
      if (currentInviteIsInContext) {
        map.set(inviteMessageKey(currentInvite), currentInvite);
      }
    }
    return [...map.values()];
  }, [
    activeInvite,
    inviteDropdownSourceInvites,
    linkedContextElectionId,
    linkedDropdownCoordinatorNpub,
    props.localVoterNpub,
    questionnaireDefinition,
    signedInNpub,
    snapshot,
    syntheticInviteQuestionnaireIds,
  ]);
  const inviteDropdownProgressByKey = useMemo(() => {
    const fallbackVoterNpub = props.localVoterNpub?.trim()
      || signedInNpub.trim()
      || snapshot?.invitedNpub?.trim()
      || "";
    const map = new Map<string, QuestionnaireRoundProgress>();
    for (const invite of inviteDropdownOptions) {
      const key = inviteMessageKey(invite);
      const voterNpub = invite.invitedNpub?.trim() || fallbackVoterNpub;
      const localState = snapshot?.electionId === invite.electionId
        ? snapshot
        : voterNpub
          ? loadVoterState({
            voterNpub,
            electionId: invite.electionId,
            coordinatorNpub: invite.coordinatorNpub,
          })
          : null;
      map.set(key, getQuestionnaireRoundProgress(localState, invite.definition ?? null));
    }
    return map;
  }, [
    inviteDropdownOptions,
    props.localVoterNpub,
    refreshNonce,
    signedInNpub,
    snapshot,
  ]);
  const currentInviteForDropdown = currentQuestionnaireId
    ? inviteDropdownOptions.find((invite) => invite.electionId === currentQuestionnaireId) ?? inviteDropdownOptions[0] ?? null
    : inviteDropdownOptions[0] ?? null;
  const currentInviteDropdownKey = selectedInviteKey || (currentInviteForDropdown ? inviteMessageKey(currentInviteForDropdown) : "");
  const currentInviteDropdownIndex = inviteDropdownOptions.findIndex((invite) => inviteMessageKey(invite) === currentInviteDropdownKey);
  const nextInviteDropdownOption = useMemo(() => {
    if (inviteDropdownOptions.length <= 1) {
      return null;
    }
    const startIndex = currentInviteDropdownIndex >= 0 ? currentInviteDropdownIndex + 1 : 0;
    const isUnanswered = (invite: ElectionInviteMessage) => {
      const key = inviteMessageKey(invite);
      return key !== currentInviteDropdownKey && !(inviteDropdownProgressByKey.get(key)?.submitted ?? false);
    };
    return inviteDropdownOptions.slice(startIndex).find(isUnanswered)
      ?? inviteDropdownOptions.find(isUnanswered)
      ?? null;
  }, [
    currentInviteDropdownIndex,
    currentInviteDropdownKey,
    inviteDropdownOptions,
    inviteDropdownProgressByKey,
  ]);
  const nextInviteDropdownKey = nextInviteDropdownOption ? inviteMessageKey(nextInviteDropdownOption) : "";
  const nextInviteDropdownIndex = nextInviteDropdownOption
    ? inviteDropdownOptions.findIndex((invite) => inviteMessageKey(invite) === nextInviteDropdownKey)
    : -1;
  const answerNextDisabled = !nextInviteDropdownOption || (Boolean(answerNextPendingKey) && answerNextPendingKey === nextInviteDropdownKey);
  const answerNextButtonText = answerNextPendingKey
    ? "Opening..."
    : nextInviteDropdownOption
      ? `Answer next (${nextInviteDropdownIndex + 1}/${inviteDropdownOptions.length})`
      : "Answer next";
  const showAnswerNextButton = responseSubmittedForCurrentQuestionnaire
    && inviteDropdownOptions.length > 1
    && Boolean(nextInviteDropdownOption);

  useEffect(() => {
    if (settingsMode || !showAnswerNextButton || !nextInviteDropdownOption) {
      return;
    }
    const localVoterNpub = props.localVoterNpub?.trim() ?? "";
    const localVoterNsec = props.localVoterNsec?.trim() ?? "";
    if (!localVoterNpub || !localVoterNsec) {
      return;
    }
    const invitedNpub = nextInviteDropdownOption.invitedNpub?.trim() || localVoterNpub;
    if (invitedNpub !== localVoterNpub) {
      return;
    }
    const nextElectionId = nextInviteDropdownOption.electionId.trim();
    if (!nextElectionId || nextElectionId === currentQuestionnaireId) {
      return;
    }
    const requestKey = `${nextElectionId}:${invitedNpub}:answer-next-prefetch`;
    if (answerNextPrefetchSentForRef.current[requestKey] || answerNextPrefetchInFlightForRef.current[requestKey]) {
      return;
    }
    const lastAttemptAt = answerNextPrefetchLastAttemptAtRef.current[requestKey] ?? 0;
    if (Date.now() - lastAttemptAt < AUTO_BALLOT_REQUEST_MIN_INTERVAL_MS) {
      return;
    }
    const existingState = loadVoterState({
      voterNpub: invitedNpub,
      electionId: nextElectionId,
      coordinatorNpub: nextInviteDropdownOption.coordinatorNpub,
    });
    if (existingState?.blindRequestSent || existingState?.credentialReady || existingState?.submission) {
      answerNextPrefetchSentForRef.current[requestKey] = true;
      return;
    }

    answerNextPrefetchInFlightForRef.current[requestKey] = true;
    answerNextPrefetchLastAttemptAtRef.current[requestKey] = Date.now();
    void (async () => {
      const prefetchRuntime = new QuestionnaireOptionAVoterRuntime(createVoterSignerService(localVoterNsec), nextElectionId, localVoterNsec);
      try {
        const next = prefetchRuntime.bootstrapWithLocalIdentity({
          invitedNpub,
          coordinatorNpub: nextInviteDropdownOption.coordinatorNpub,
          invite: nextInviteDropdownOption,
          allowInviteRecipientMismatch: true,
          allowInviteMissing: true,
        });
        if (next.blindRequestSent || next.credentialReady || next.submission) {
          answerNextPrefetchSentForRef.current[requestKey] = true;
          return;
        }
        await prefetchRuntime.requestBlindBallot();
        answerNextPrefetchSentForRef.current[requestKey] = true;
        markSignerWaitRecoveryBaseline();
        scheduleSignerInitialPull();
        setRefreshNonce((value) => value + 1);
      } finally {
        prefetchRuntime.dispose();
      }
    })().catch(() => {
      // Best-effort prefetch. The visible Answer next path still requests explicitly.
    }).finally(() => {
      delete answerNextPrefetchInFlightForRef.current[requestKey];
    });
  }, [
    currentQuestionnaireId,
    nextInviteDropdownOption,
    props.localVoterNpub,
    props.localVoterNsec,
    settingsMode,
    showAnswerNextButton,
  ]);

  useEffect(() => {
    const selectedQuestionnaireId = currentQuestionnaireId;
    if (!selectedQuestionnaireId) {
      return;
    }
    const matched = inviteDropdownOptions.find((invite) => invite.electionId === selectedQuestionnaireId);
    if (matched) {
      const key = inviteMessageKey(matched);
      if (selectedInviteKey !== key) {
        setSelectedInviteKey(key);
      }
      if (answerNextPendingKey && answerNextPendingKey === key) {
        setAnswerNextPendingKey("");
      }
      return;
    }
    if (!selectedInviteKey && inviteDropdownOptions.length > 0) {
      const first = inviteDropdownOptions[0];
      setSelectedInviteKey(inviteMessageKey(first));
    }
  }, [answerNextPendingKey, currentQuestionnaireId, inviteDropdownOptions, selectedInviteKey]);
  const waitingForCredential = Boolean(snapshot?.blindRequestSent && !snapshot?.credentialReady && !snapshot?.submission);
  const manualResendAvailableAtMs = useMemo(
    () => getManualBallotResendAvailableAtMs(snapshot),
    [
      snapshot?.blindRequest?.lastSentAt,
      snapshot?.blindRequestSent,
      snapshot?.blindRequestSentAt,
      snapshot?.credentialReady,
      snapshot?.submission,
    ],
  );
  useEffect(() => {
    if (!waitingForCredential || manualResendAvailableAtMs === null) {
      return;
    }
    const now = Date.now();
    setManualResendClockMs(now);
    if (manualResendAvailableAtMs <= now) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setManualResendClockMs(Date.now());
    }, manualResendAvailableAtMs - now);
    return () => window.clearTimeout(timeoutId);
  }, [manualResendAvailableAtMs, waitingForCredential]);
  const manualResendRequestVisible = waitingForCredential
    && manualResendAvailableAtMs !== null
    && manualResendClockMs >= manualResendAvailableAtMs;
  const canRequestOrResendBallot = !privateInviteBlock && (flags.canRequestBallot || manualResendRequestVisible);
  useLayoutEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    let frameId = 0;
    const syncMount = () => {
      setVoterMenuActionsMount(document.getElementById("simple-voter-menu-actions"));
    };
    syncMount();
    frameId = window.requestAnimationFrame(syncMount);
    return () => window.cancelAnimationFrame(frameId);
  });

  const questionHasResponseForCredential = (question: (typeof questions)[number], credentialIndex = activeCredentialIndex) => {
    const value = answers[answerKeyForQuestion(question.questionId, credentialIndex)];
    if (Array.isArray(value)) {
      if (question.type === "rank") {
        return value.length >= Math.max(1, question.minimumRanked ?? 1);
      }
      return value.length > 0;
    }
    return value !== undefined && value !== null && String(value).trim().length > 0;
  };
  const questionHasResponse = (question: (typeof questions)[number]) => questionHasResponseForCredential(question, activeCredentialIndex);
  const requiredQuestionsAnswered = questions.length > 0 && requiredQuestions.every(questionHasResponse);
  const answerableQuestionsHaveResponse = answerableQuestions.some(questionHasResponse);
  const activeQuestionGroupHasRequiredResponses = requiredQuestions.every(questionHasResponse);
  const activeQuestionGroupHasAnyResponse = answerableQuestions.some(questionHasResponse);
  const activeQuestionHasResponse = Boolean(activeQuestion && questionHasResponse(activeQuestion));
  const proxyCredentialIndexesToSubmit = showProxyBallotsTogether
    ? credentialIndexes.filter((credentialIndex) => !activeQuestionSubmittedForCredential(credentialIndex))
    : [];
  const proxyActiveQuestionGroupHasRequiredResponses = showProxyBallotsTogether
    && proxyCredentialIndexesToSubmit.length > 0
    && proxyCredentialIndexesToSubmit.every((credentialIndex) => (
      requiredQuestions.every((question) => questionHasResponseForCredential(question, credentialIndex))
    ));
  const proxyActiveQuestionGroupHasAnyResponse = showProxyBallotsTogether
    && proxyCredentialIndexesToSubmit.some((credentialIndex) => (
      answerableQuestions.some((question) => questionHasResponseForCredential(question, credentialIndex))
    ));
  const proxyActiveQuestionHasResponse = showProxyBallotsTogether
    && Boolean(activeQuestion)
    && proxyCredentialIndexesToSubmit.some((credentialIndex) => questionHasResponseForCredential(activeQuestion!, credentialIndex));
  const activeQuestionReadyForNavigation = Boolean(activeQuestion) && (
    responseSubmittedForCurrentQuestionnaire
      || (
        showProxyBallotsTogether
          ? proxyCredentialIndexesToSubmit.length > 0
            && proxyCredentialIndexesToSubmit.every((credentialIndex) => questionHasResponseForCredential(activeQuestion!, credentialIndex))
          : activeQuestionHasResponse
      )
  );
  const allQuestionsAnsweredForQuestionnaire = questions.length > 0 && (
    showProxyBallotsTogether
      ? proxyCredentialIndexesToSubmit.length > 0
        && proxyCredentialIndexesToSubmit.every((credentialIndex) => (
          questions.every((question) => questionHasResponseForCredential(question, credentialIndex))
        ))
      : questions.every(questionHasResponse)
  );
  const firstMissingRequiredQuestionIndex = questions.findIndex((question) => {
    if (!question.required && !(question.type === "rank" && (question.minimumRanked ?? 0) > 0)) {
      return false;
    }
    const indexes = showProxyBallotsTogether ? credentialIndexes : [activeCredentialIndex];
    return indexes.some((credentialIndex) => (
      !(perQuestionMode && submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, credentialIndex)))
      && !questionHasResponseForCredential(question, credentialIndex)
    ));
  });
  const returnToFirstMissingRequiredQuestion = () => {
    if (firstMissingRequiredQuestionIndex < 0) {
      return false;
    }
    setActiveQuestionIndex(firstMissingRequiredQuestionIndex);
    setStatus("Answer this required question before submitting.");
    window.requestAnimationFrame(() => {
      activeQuestionCardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      activeQuestionCardRef.current?.focus({ preventScroll: true });
    });
    return true;
  };
  const requiredQuestionsAnsweredForAction = perQuestionMode
    ? showProxyBallotsTogether
      ? proxyActiveQuestionGroupHasRequiredResponses
      : Boolean(activeQuestion && activeQuestionGroupHasRequiredResponses)
    : requiredQuestionsAnswered;
  const answerableQuestionsHaveResponseForAction = perQuestionMode
    ? showProxyBallotsTogether
      ? proxyActiveQuestionGroupHasAnyResponse
      : activeQuestionGroupHasAnyResponse
    : answerableQuestionsHaveResponse;
  const actionQuestionnaireId = currentQuestionnaireId || electionId.trim();
  const snapshotForAction = snapshot?.electionId === actionQuestionnaireId ? snapshot : null;
  const allQuestionCredentialsReadyForQuestionnaire = perQuestionMode && questions.length > 0 && (
    showProxyBallotsTogether
      ? proxyCredentialIndexesToSubmit.length > 0
        && proxyCredentialIndexesToSubmit.every((credentialIndex) => (
          questions.every((question) => Boolean(snapshotForAction?.blindIssuances?.[groupKeyForQuestionId(question.questionId, credentialIndex)]))
        ))
      : questions.every((question) => Boolean(snapshotForAction?.blindIssuances?.[groupKeyForQuestionId(question.questionId, activeCredentialIndex)]))
  );
  const questionnaireCredentialReady = perQuestionMode
    ? allQuestionCredentialsReadyForQuestionnaire
    : Boolean(snapshotForAction?.credentialReady);
  useEffect(() => {
    props.onBallotReceivedChange?.(questionnaireCredentialReady);
  }, [props.onBallotReceivedChange, questionnaireCredentialReady]);
  useEffect(() => () => {
    props.onBallotReceivedChange?.(false);
  }, [props.onBallotReceivedChange]);
  const questionnaireHasAnyResponse = questions.some(questionHasResponse);
  const canSubmitNow = (
    perQuestionMode
      ? Boolean(snapshotForAction?.loginVerified && activeQuestionCredentialReady)
      : flags.canSubmitVote
  )
    && (perQuestionMode ? requiredQuestionsAnsweredForAction : requiredQuestionsAnswered)
    && (perQuestionMode ? answerableQuestionsHaveResponseForAction : questionnaireHasAnyResponse)
    && !responseSubmittedForCurrentQuestionnaire;
  const canAdvanceQuestion = perQuestionMode && responseSubmittedForCurrentQuestionnaire && !allQuestionResponsesSubmitted;
  const nextQuestionIndexInActiveGroup = findNextQuestionIndexInActiveGroup(activeQuestionIndex);
  const canAdvanceQuestionBeforeSubmit = questions.length > 1
    && !responseSubmittedForCurrentQuestionnaire
    && !canSubmitNow
    && (showProxyBallotsTogether ? proxyActiveQuestionHasResponse : activeQuestionHasResponse)
    && nextQuestionIndexInActiveGroup >= 0;
  const canViewResults = perQuestionMode
    ? allQuestionResponsesSubmitted
    : Boolean(snapshot?.submission);
  const previousQuestionIndex = findAdjacentQuestionIndex(activeQuestionIndex, -1);
  const nextQuestionIndex = findAdjacentQuestionIndex(activeQuestionIndex, 1);
  const hasAdjacentQuestion = previousQuestionIndex >= 0 || nextQuestionIndex >= 0;
  const isLastQuestionInQuestionNav = questions.length > 1
    && hasAdjacentQuestion
    && nextQuestionIndex < 0;
  const showSubmitFromQuestionNav = isLastQuestionInQuestionNav
    && !allQuestionResponsesSubmitted;
  const showViewResultsFromQuestionNav = isLastQuestionInQuestionNav && canViewResults;
  const canSubmitFromQuestionNav = showSubmitFromQuestionNav
    && canSubmitNow
    && questionnaireCredentialReady;
  const submitBlockedMessage = showSubmitFromQuestionNav && !showViewResultsFromQuestionNav && !canSubmitFromQuestionNav
    ? !questionnaireCredentialReady
      ? "Your ballot is still being prepared. Keep this page open or resend the ballot request from the menu."
      : !snapshotForAction?.loginVerified
        ? "Log in before submitting your vote."
        : !canSubmitNow
          ? "This vote is not ready to submit yet. Check that every required answer is complete."
          : "This vote cannot be submitted yet."
    : "";
  const hasGroupSpecificQuestions = Boolean(currentDefinition?.questions.some((question) => questionRequiredScope(question)));
  const showMainOnlyScopeWarning = questionnaireCredentialReady
    && (!activeBallotGroup || activeBallotGroup === "0")
    && hasGroupSpecificQuestions
    && !responseSubmittedForCurrentQuestionnaire;
  const questionNavForwardHighlighted = showViewResultsFromQuestionNav || canSubmitFromQuestionNav || (nextQuestionIndex >= 0 && activeQuestionReadyForNavigation);
  const activeQuestionProgressLabel = (() => {
    const questionPosition = Math.min(activeQuestionIndex + 1, Math.max(questions.length, 1));
    const questionCountLabel = questions.length > 0
      ? `Question ${questionPosition} of ${questions.length}`
      : "Question 0/0";
    return questionCountLabel;
  })();
  const activeQuestionProgressPercent = questions.length > 0
    ? `${Math.min(100, Math.max(0, ((activeQuestionIndex + 1) / questions.length) * 100))}%`
    : "0%";
  const combinedProxySubmitLabel = showProxyBallotsTogether && canSubmitNow ? "Submit" : "";
  const actionCoordinatorNpub = snapshotForAction?.coordinatorNpub?.trim()
    || (activeInvite?.electionId === actionQuestionnaireId ? activeInvite.coordinatorNpub?.trim() : "")
    || inviteDropdownOptions.find((invite) => invite.electionId === actionQuestionnaireId)?.coordinatorNpub?.trim()
    || loadElectionSummary(actionQuestionnaireId)?.coordinatorNpub?.trim()
    || "";
  const requiredAnswerPrompt = (() => {
    if (requiredQuestionsAnsweredForAction) {
      return "";
    }
    if (activeQuestion && !showProxyBallotsTogether) {
      if (activeQuestion.type === "rank") {
        const key = answerKeyForQuestion(activeQuestion.questionId);
        const ranked = Array.isArray(answers[key]) ? (answers[key] as string[]) : [];
        const requirement = getRankRequirementState(activeQuestion.options?.length ?? 0, activeQuestion.minimumRanked ?? 0, ranked.length);
        if (requirement.missing > 0) {
          return requirement.missing === 1
            ? "Choose 1 option to continue"
            : `Choose ${requirement.missing} options to continue`;
        }
      }
      return "Answer this question to continue";
    }
    if (showProxyBallotsTogether) {
      return "Answer each separate vote to continue";
    }
    return "Answer required questions to continue";
  })();
  const formattedVoteActionButtonText = formatVoteActionButtonText({
    snapshot: snapshotForAction,
    requiredQuestionsAnswered: requiredQuestionsAnsweredForAction,
    canSubmitNow,
    blindSigningKeyReady: autoRequestBlindSigningKeyReady || questionnaireCredentialReady,
    ballotRequestSent: activeQuestionRequestSent,
    credentialReady: activeQuestionCredentialReady,
    coordinatorNpub: actionCoordinatorNpub,
    responseSubmitted: responseSubmittedForCurrentQuestionnaire,
    perQuestionMode,
    allQuestionResponsesSubmitted,
    canAdvanceQuestionBeforeSubmit,
    submitInFlight,
  });
  const voteActionButtonText = responseSubmittedForCurrentQuestionnaire || (perQuestionMode && allQuestionResponsesSubmitted) || submitInFlight
    ? formattedVoteActionButtonText
    : requiredAnswerPrompt || combinedProxySubmitLabel || formattedVoteActionButtonText;
  const showQuestionNavigation = questions.length > 1;
  const showVoteActionButton = !showQuestionNavigation && (
    !perQuestionMode
    || (submitInFlight && !canSubmitFromQuestionNav)
    || (canSubmitNow && !hasAdjacentQuestion)
    || (canViewResults && !showViewResultsFromQuestionNav)
  );
  useEffect(() => {
    if (showProxyBallotsTogether) {
      return;
    }
    if (!responseSubmittedForCurrentQuestionnaire || !snapshot?.draftResponses?.length) {
      return;
    }
    const nextAnswers = answersFromOptionADraft(snapshot.draftResponses);
    setAnswers((current) => answerRecordEquals(current, nextAnswers) ? current : nextAnswers);
    const nextEncryptionFlags = encryptionFlagsFromOptionADraft(snapshot.draftResponses);
    setEncryptFreeTextByQuestionId((current) => answerRecordEquals(current, nextEncryptionFlags) ? current : nextEncryptionFlags);
  }, [responseSubmittedForCurrentQuestionnaire, showProxyBallotsTogether, snapshot?.draftResponses, snapshot?.submission?.submissionId]);

  useEffect(() => {
    const owner = globalThis as typeof globalThis & {
      __questionnaireVoterDebug?: unknown;
    };
    const targetQuestionnaireId = currentQuestionnaireId || electionId.trim();
    const snapshotForTarget = snapshot?.electionId === targetQuestionnaireId ? snapshot : null;
    const debugSubmitButtonText = voteActionButtonText;
    const questionnaireSeen = questions.length > 0 || Boolean(autoRequestDefinition);
    const submitButtonReasonBlocked = submitInFlight
      ? "submitting"
      : responseSubmittedForCurrentQuestionnaire || allQuestionResponsesSubmitted
        ? null
        : canAdvanceQuestionBeforeSubmit
          ? null
        : !requiredQuestionsAnsweredForAction
          ? "required_questions_unanswered"
          : !answerableQuestionsHaveResponseForAction
            ? "question_unanswered"
            : !snapshotForTarget?.loginVerified
              ? "not_logged_in"
              : !autoRequestBlindSigningKeyReady
                ? "blind_signing_key_not_ready"
                : !snapshotForTarget?.coordinatorNpub?.trim()
                  ? "coordinator_missing"
                  : activeQuestionRequestSent && !activeQuestionCredentialReady
                    ? "waiting_for_credential"
                    : !activeQuestionCredentialReady
                      ? "credential_missing"
                      : !canSubmitNow
                        ? "runtime_submit_not_ready"
                        : null;
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
      responsePublished: perQuestionMode
        ? allQuestionResponsesSubmitted
        : Boolean(snapshotForTarget?.submission),
      responseSubmittedCount: perQuestionMode
        ? Object.keys(snapshotForTarget?.submissions ?? {}).length
        : snapshotForTarget?.submission ? 1 : 0,
      submitButtonPresent: true,
      submitButtonVisible: !settingsMode && showVoteActionButton,
      submitButtonDisabled: submitInFlight || !(canSubmitNow || canAdvanceQuestionBeforeSubmit || responseSubmittedForCurrentQuestionnaire || allQuestionResponsesSubmitted),
      submitButtonText: debugSubmitButtonText,
      perQuestionMode,
      activeQuestionIndex,
      activeQuestionId: activeQuestion?.questionId ?? null,
      activeQuestionIds,
      submittedQuestionIds: [...submittedQuestionGroupKeys],
      acceptedQuestionIds: [...acceptedQuestionGroupKeys],
      submitButtonReasonBlocked,
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
      activeQuestionRequestId: activeQuestionRequest?.requestId ?? null,
      activeQuestionCredentialId: activeQuestionIssuance?.issuanceId ?? null,
      activeQuestionSubmissionId: activeQuestionSubmission?.submissionId ?? null,
      activeQuestionCredentialReady,
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
    activeQuestion?.questionId,
    activeQuestionCredentialReady,
    activeQuestionIndex,
    activeQuestionIssuance?.issuanceId,
    activeQuestionRequest?.requestId,
    activeQuestionRequestSent,
    activeQuestionSubmission?.submissionId,
    activeQuestionIds,
    actionCoordinatorNpub,
    answerableQuestionsHaveResponse,
    answerableQuestionsHaveResponseForAction,
    acceptedQuestionGroupKeys,
    allQuestionResponsesSubmitted,
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
    requiredQuestionsAnsweredForAction,
    runtime,
    settingsMode,
    showVoteActionButton,
    signedInNpub,
    snapshot,
    status,
    perQuestionMode,
    responseSubmittedForCurrentQuestionnaire,
    submittedQuestionGroupKeys,
    submitInFlight,
    voteActionButtonText,
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
  const displaySubmission = activeQuestionSubmission ?? null;
  const displaySubmissionQuestion = perQuestionMode && activeQuestion ? activeQuestion : null;
  const submittedQuestionnaireId = displaySubmission?.payload?.electionId
    || displaySubmission?.electionId
    || statusQuestionnaireId;
  const requestStateText = snapshot?.blindRequestSent ? "Sent" : "Not sent";
  const credentialStateText = snapshot?.credentialReady
    ? "Received"
    : snapshot?.blindRequestSent
      ? credentialIssuerIsProxy ? "Request sent" : `Waiting for ${credentialIssuerName}`
      : "Not requested";
  const submissionStateText = snapshot?.submissionAccepted === true
    ? "Accepted"
    : snapshot?.submissionAccepted === false
      ? "Rejected"
      : snapshot?.submission
        ? `Waiting for ${decisionActorName}`
        : "Not submitted";
  const submittedMarkerNpub = displaySubmission?.responseNpub
    ?? displaySubmission?.invitedNpub
    ?? (!perQuestionMode ? snapshot?.responseNpub ?? "" : "");
  const submittedMarkerLabel = submittedMarkerNpub ? deriveActorDisplayId(submittedMarkerNpub) : "Unknown";
  const submittedMarkerWords = submittedMarkerNpub ? deriveIdentityWords(submittedMarkerNpub) : "";
  const receiptStatusLabel = snapshot?.submissionAccepted === false ? "Rejected" : "";
  const submittedAtLabel = displaySubmission?.submittedAt
    ? new Date(displaySubmission.submittedAt).toLocaleString()
    : "";
  const submittedMarkerWordsLabel = submittedMarkerWords || "Not available";
  const proxyReceiptScopeKeys = new Set(
    perQuestionMode
      ? credentialIndexes.flatMap((credentialIndex) => (
        activeQuestionIds.map((questionId) => groupKeyForQuestionId(questionId, credentialIndex))
      ))
      : [],
  );
  const seenOtherProxyReceiptSubmissionIds = new Set<string>();
  const otherProxyReceiptSubmissions = credentialIndexes.length > 1 && displaySubmission && snapshot?.electionId === currentQuestionnaireId
    ? Object.entries(snapshot.submissions ?? {})
      .filter(([key, submission]) => {
        if (submission.submissionId === displaySubmission.submissionId) {
          return false;
        }
        if (seenOtherProxyReceiptSubmissionIds.has(submission.submissionId)) {
          return false;
        }
        if (proxyReceiptScopeKeys.has(key)) {
          seenOtherProxyReceiptSubmissionIds.add(submission.submissionId);
          return true;
        }
        const proofs = Array.isArray(submission.credentialBundle) ? submission.credentialBundle : [];
        if (proofs.some((proof) => proxyReceiptScopeKeys.has(scopedBallotScopeKey(proof.ballotScope)))) {
          seenOtherProxyReceiptSubmissionIds.add(submission.submissionId);
          return true;
        }
        const matchesActiveQuestion = submission.payload.responses.some((response) => activeQuestionIds.includes(response.questionId));
        if (matchesActiveQuestion) {
          seenOtherProxyReceiptSubmissionIds.add(submission.submissionId);
        }
        return matchesActiveQuestion;
      })
      .map(([key, submission]) => {
        const npub = submission.responseNpub ?? submission.invitedNpub ?? "";
        const credentialIndex = credentialIndexFromSubmission(key, submission);
        return {
          key: submission.submissionId,
          credentialIndex,
          submittedAt: submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : "Recorded locally",
          npub,
          npubLabel: npub ? deriveActorDisplayId(npub) : "Unknown",
          words: npub ? deriveIdentityWords(npub) : "Not available",
        };
      })
      .sort((left, right) => left.credentialIndex - right.credentialIndex)
    : [];
  async function copyReceiptValue(value: string, key: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    if (await tryWriteClipboard(trimmed)) {
      showReceiptCopied(key);
    }
  }
  function renderQuestionControls(
    question: (typeof questions)[number],
    credentialIndex: number,
    questionSubmitted: boolean,
  ) {
    const key = answerKeyForQuestion(question.questionId, credentialIndex);
    const value = answers[key];
    if (question.type === "yes_no") {
      const selectedYes = value === "yes";
      const selectedNo = value === "no";
      return (
        <div className='simple-vote-button-grid simple-questionnaire-yes-no-grid'>
          <UiButton
            icon='check'
            className={[
              "simple-voter-choice simple-voter-choice-yes",
              selectedYes ? "is-active" : selectedNo ? "is-dimmed" : "",
              questionSubmitted && selectedYes ? "is-submitted-selected" : "",
              questionSubmitted && !selectedYes ? "is-submitted-unselected" : "",
            ].filter(Boolean).join(" ")}
            aria-pressed={selectedYes}
            isDisabled={questionSubmitted}
            onPress={() => {
              if (questionSubmitted) {
                return;
              }
              setAnswers((current) => ({ ...current, [key]: "yes" }));
            }}
          >
            Yes
          </UiButton>
          <UiButton
            icon='cancel'
            className={[
              "simple-voter-choice simple-voter-choice-no",
              selectedNo ? "is-active" : selectedYes ? "is-dimmed" : "",
              questionSubmitted && selectedNo ? "is-submitted-selected" : "",
              questionSubmitted && !selectedNo ? "is-submitted-unselected" : "",
            ].filter(Boolean).join(" ")}
            aria-pressed={selectedNo}
            isDisabled={questionSubmitted}
            onPress={() => {
              if (questionSubmitted) {
                return;
              }
              setAnswers((current) => ({ ...current, [key]: "no" }));
            }}
          >
            No
          </UiButton>
        </div>
      );
    }
    if (question.type === "multiple_choice") {
      return (
        <div className='simple-questionnaire-choice-list'>
          {(question.options ?? []).map((option) => {
            const selected = Array.isArray(value) ? (value as string[]) : [];
            const checked = selected.includes(option.optionId);
            return (
              <label
                key={option.optionId}
                className={[
                  "simple-questionnaire-choice-row",
                  checked ? "is-selected" : "",
                  questionSubmitted && checked ? "is-submitted-selected" : "",
                  questionSubmitted && !checked ? "is-submitted-unselected" : "",
                ].filter(Boolean).join(" ")}
              >
                <input
                  type={question.multiSelect ? "checkbox" : "radio"}
                  checked={checked}
                  disabled={questionSubmitted}
                  onChange={() => {
                    if (questionSubmitted) {
                      return;
                    }
                    setAnswers((current) => {
                      const existing = Array.isArray(current[key])
                        ? (current[key] as string[])
                        : [];
                      if (!question.multiSelect) {
                        return { ...current, [key]: [option.optionId] };
                      }
                      return checked
                        ? { ...current, [key]: existing.filter((entry) => entry !== option.optionId) }
                        : { ...current, [key]: [...existing, option.optionId] };
                    });
                  }}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      );
    }
    if (question.type === "rank") {
      const ranked = Array.isArray(value) ? (value as string[]) : [];
      const rankedSet = new Set(ranked);
      const unrankedOptions = (question.options ?? []).filter((option) => !rankedSet.has(option.optionId));
      return (
        <div className='simple-questionnaire-rank-voter-grid'>
          <div className='simple-questionnaire-choice-list'>
            {ranked.length > 0 ? ranked.map((optionId, rankedIndex) => {
              const option = (question.options ?? []).find((entry) => entry.optionId === optionId);
              if (!option) {
                return null;
              }
              return (
                <div
                  key={option.optionId}
                  className={`simple-questionnaire-rank-row${questionSubmitted ? " is-response-locked" : ""}`}
                  role='button'
                  tabIndex={questionSubmitted ? -1 : 0}
                  aria-label={questionSubmitted
                    ? `${option.label} ranked #${rankedIndex + 1}`
                    : `Remove ${option.label} as #${rankedIndex + 1}`}
                  aria-disabled={questionSubmitted}
                  onClick={() => {
                    if (questionSubmitted) {
                      return;
                    }
                    removeRankedAnswer(question.questionId, option.optionId, credentialIndex);
                  }}
                  onKeyDown={(event) => {
                    if (questionSubmitted) {
                      return;
                    }
                    if (event.key !== "Enter" && event.key !== " ") {
                      return;
                    }
                    event.preventDefault();
                    removeRankedAnswer(question.questionId, option.optionId, credentialIndex);
                  }}
                >
                  <span className='simple-questionnaire-rank-selected'>
                    <span className='simple-questionnaire-rank-selected-option'>
                      <span className='simple-questionnaire-rank-inline-number'>{rankedIndex + 1}. </span>
                      <span>{option.label}</span>
                    </span>
                    {questionSubmitted ? null : (
                      <span className='simple-questionnaire-rank-remove-prefix'>Remove as #{rankedIndex + 1}</span>
                    )}
                  </span>
                  {questionSubmitted ? null : (
                    <div
                      className='simple-questionnaire-rank-actions'
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <UiButton
                        icon='uploadLine'
                        iconOnly
                        className='simple-voter-secondary simple-questionnaire-rank-action'
                        onPress={() => {
                          moveRankedAnswer(question.questionId, option.optionId, -1, credentialIndex);
                        }}
                        isDisabled={rankedIndex === 0}
                        aria-label='Move up'
                      />
                      <UiButton
                        icon='downloadLine'
                        iconOnly
                        className='simple-voter-secondary simple-questionnaire-rank-action'
                        onPress={() => {
                          moveRankedAnswer(question.questionId, option.optionId, 1, credentialIndex);
                        }}
                        isDisabled={rankedIndex === ranked.length - 1}
                        aria-label='Move down'
                      />
                    </div>
                  )}
                </div>
              );
            }) : null}
          </div>
          {unrankedOptions.length > 0 ? (
            <div className='simple-questionnaire-choice-list'>
              {unrankedOptions.map((option) => (
                <UiButton
                  key={option.optionId}
                  icon={false}
                  className={`simple-voter-secondary simple-questionnaire-rank-add${questionSubmitted ? " is-response-locked" : ""}`}
                  onPress={() => addRankedAnswer(question.questionId, option.optionId, credentialIndex)}
                  isDisabled={questionSubmitted}
                >
                  <span className='simple-questionnaire-rank-add-option'>{option.label}</span>
                  {questionSubmitted ? null : (
                    <span className='simple-questionnaire-rank-add-prefix'>Add as #{ranked.length + 1}</span>
                  )}
                </UiButton>
              ))}
            </div>
          ) : null}
        </div>
      );
    }
    return (
      <UiTextArea
        textAreaClassName='simple-voter-input simple-questionnaire-free-text'
        isDisabled={questionSubmitted}
        textAreaProps={{
          rows: 3,
          maxLength: question.maxLength ?? 500,
          value: typeof value === "string" ? value : "",
          onChange: (event) => {
            if (questionSubmitted) {
              return;
            }
            setAnswers((current) => ({ ...current, [key]: event.target.value }));
          },
        }}
      />
    );
  }
  const advancedReceiptRows = [
    { label: "Questionnaire ID", value: submittedQuestionnaireId },
    { label: "Submission ID", value: displaySubmission?.submissionId ?? null },
    { label: "Anonymous identity npub", value: submittedMarkerNpub || null },
    { label: "Token commitment", value: displaySubmission?.tokenCommitment ?? null },
    { label: "Response nullifier", value: displaySubmission?.nullifier ?? null },
    { label: "Credential signature", value: displaySubmission?.credential ?? null },
    { label: "Credential bundle size", value: displaySubmission?.credentialBundle?.length ?? null },
    { label: "Blind signing key", value: displaySubmission?.blindSigningKeyId ?? null },
    { label: "Request ID", value: activeQuestionRequest?.requestId ?? snapshot?.blindRequest?.requestId ?? null },
    { label: "Credential ID", value: activeQuestionIssuance?.issuanceId ?? snapshot?.blindIssuance?.issuanceId ?? null },
    { label: "Submitted at", value: displaySubmission?.submittedAt ?? null },
    { label: "Decision time", value: snapshot?.submissionAcceptedAt ?? null },
  ];
  const voterIdentityForDetails = snapshot?.invitedNpub?.trim()
    || signedInNpub.trim()
    || props.localVoterNpub?.trim()
    || "";
  const hasBallotDetailsContext = Boolean(statusQuestionnaireId || snapshot || activeInvite || selectedInviteForElection);
  const ballotDetailRows = [
    { label: "Questionnaire ID", value: statusQuestionnaireId || "Missing" },
    { label: "Questionnaire title", value: questionnaireTitle.trim() || null },
    {
      label: "Organiser identity",
      value: coordinatorNpub ? `${coordinatorLabel} (${coordinatorNpub})` : "Unknown",
    },
    {
      label: "Ballot credential issuer",
      value: credentialIssuerNpub ? `${credentialIssuerName} ${credentialIssuerLabel} (${credentialIssuerNpub})` : "Unknown",
    },
    {
      label: "Voter identity",
      value: voterIdentityForDetails ? `${deriveActorDisplayId(voterIdentityForDetails)} (${voterIdentityForDetails})` : "Not confirmed",
    },
    { label: "Identity confirmed", value: Boolean(snapshot?.loginVerified) },
    { label: "Ballot request", value: requestStateText },
    { label: "Request ID", value: snapshot?.blindRequest?.requestId ?? "Not created" },
    { label: "Request created", value: snapshot?.blindRequest?.createdAt ?? "Not recorded" },
    { label: "Request sent", value: snapshot?.blindRequestSentAt ?? snapshot?.blindRequest?.lastSentAt ?? "Not sent" },
    { label: "Ballot credential", value: credentialStateText },
    { label: "Credential ID", value: snapshot?.blindIssuance?.issuanceId ?? "Not received" },
    { label: "Credential issued", value: snapshot?.blindIssuance?.issuedAt ?? "Not recorded" },
    {
      label: "Blind signing key",
      value: snapshot?.blindIssuance?.blindSigningKeyId ?? snapshot?.blindRequest?.blindSigningKeyId ?? "Unknown",
    },
    {
      label: "Token commitment",
      value: snapshot?.submission?.tokenCommitment ?? "Not created",
    },
    { label: "Response", value: submissionStateText },
    { label: "Submission ID", value: snapshot?.submission?.submissionId ?? "Not submitted" },
    { label: "Submission time", value: snapshot?.submission?.submittedAt ?? "Not submitted" },
    {
      label: "Anonymous voting identity",
      value: submittedMarkerNpub ? `${submittedMarkerLabel} (${submittedMarkerNpub})` : "Not created",
    },
    { label: "Response nullifier", value: snapshot?.submission?.nullifier ?? "Not created" },
    { label: "Decision time", value: snapshot?.submissionAcceptedAt ?? "Not recorded" },
    { label: "Last local update", value: snapshot?.lastUpdatedAt ?? "Not recorded" },
    { label: "Current message", value: status ?? "No status message" },
  ];
  const questionnaireTitleText = questionnaireTitle.trim();
  const questionnaireHeadingText = questionnaireTitleText && questionnaireTitleText !== "Questionnaire"
    ? questionnaireTitleText
    : currentQuestionnaireId || questionnaireDescription.trim() || "Questionnaire";
  const questionnaireDescriptionText = questionnaireDescription.trim();
  const showQuestionnaireDescription = Boolean(
    questionnaireDescriptionText && questionnaireDescriptionText !== questionnaireHeadingText,
  );
  const showQuestionnaireLanding = questions.length > 0
    && !questionnaireStarted
    && !responseSubmittedForCurrentQuestionnaire
    && !allQuestionResponsesSubmitted;
  const ballotStatusSection = (
    <section id='questionnaire-ballot-status' className='simple-settings-card' aria-label='Ballot status'>
      <h4 className='simple-voter-section-title'>Ballot status</h4>
      <div className='simple-voter-action-row simple-voter-action-row-inline simple-optiona-voter-controls'>
        {!waitingForCredential ? (
          <UiButton icon='key' className='simple-voter-secondary' isDisabled={!canRequestOrResendBallot} onPress={requestBallot}>
            Request ballot
          </UiButton>
        ) : null}
        <UiButton icon='refresh' className='simple-voter-secondary' onPress={refreshStatus}>Refresh status</UiButton>
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
      {waitingForCredential && !credentialIssuerIsProxy ? (
        <p className='simple-voter-note'>
          Waiting for the organiser to issue your ballot credential. This page checks automatically; the organiser must be online and can press Process requests.
        </p>
      ) : null}
    </section>
  );
  const ballotDetailsSection = hasBallotDetailsContext ? (
    <section className='simple-settings-card simple-ballot-details-card' aria-label='Ballot details'>
      <div>
        <h4 className='simple-voter-section-title'>Ballot details</h4>
        <p className='simple-voter-note'>Debug information for this questionnaire. It avoids private keys and token secrets.</p>
      </div>
      <dl className='simple-submission-identity-details simple-ballot-details-grid'>
        {ballotDetailRows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{formatBallotDetailValue(row.value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  ) : null;
  const privateInviteBlockCard = privateInviteBlock ? (
    <section className='simple-settings-card simple-private-invite-block' aria-label='Private invite unavailable'>
      <h4 className='simple-voter-section-title'>
        {privateInviteBlock.reason === "redeemed" ? "Private invite already used" : "Private invite unavailable"}
      </h4>
      {privateInviteBlock.reason === "redeemed" ? null : (
        <p className='simple-voter-note'>
          This private invite is no longer available. Ask the organiser for a new invite, or use the general questionnaire link if you were meant to join publicly.
        </p>
      )}
      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        {privateInviteBlock.coordinatorNpub && props.onMessageOrganiser ? (
          <UiButton
            icon='message'
            className='simple-voter-secondary'
            onPress={() => props.onMessageOrganiser?.(privateInviteBlock.coordinatorNpub ?? undefined)}
          >
            Message organiser
          </UiButton>
        ) : null}
        {privateInviteBlock.generalInviteUrl ? (
          <UiButton
            icon='external'
            className='simple-voter-secondary'
            onPress={() => {
              if (privateInviteBlock.generalInviteUrl && typeof window !== "undefined") {
                window.location.assign(privateInviteBlock.generalInviteUrl);
              }
            }}
          >
            Open general invite
          </UiButton>
        ) : null}
        <UiButton
          icon='back'
          className='simple-voter-secondary'
          onPress={() => {
            setPrivateInviteBlock(null);
            props.onBackToJoin?.();
          }}
        >
          Back to Join
        </UiButton>
      </div>
    </section>
  ) : null;
  const resendRequestMenuPortal = voterMenuActionsMount && manualResendRequestVisible && !privateInviteBlock
    ? createPortal((
      <div className='simple-account-menu-section' role='none'>
        <p className='simple-account-menu-kicker'>Ballot</p>
        <UiButton
          icon='key'
          className='simple-account-menu-button simple-account-menu-action'
          role='menuitem'
          onPress={requestBallot}
        >
          <span>Resend request</span>
        </UiButton>
      </div>
    ), voterMenuActionsMount)
    : null;

  if (settingsMode) {
    return (
      <>
        {resendRequestMenuPortal}
        <div className='simple-optiona-voter-settings'>
          {ballotStatusSection}
          {ballotDetailsSection}
          <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
        </div>
      </>
    );
  }

  if (privateInviteBlockCard) {
    return (
      <>
        {resendRequestMenuPortal}
        <div className='simple-voter-card simple-optiona-voter-page'>
          {privateInviteBlockCard}
        </div>
      </>
    );
  }

  return (
    <>
    {resendRequestMenuPortal}
    <div className='simple-voter-card simple-optiona-voter-page'>
      {props.showLoginAction !== false && !snapshot?.loginVerified ? (
        <div className='simple-questionnaire-header'>
          <div className='simple-voter-action-row simple-voter-action-row-inline simple-voter-action-row-tight'>
            <UiButton icon='login' className='simple-voter-secondary' onPress={() => void login()}>Login</UiButton>
          </div>
        </div>
      ) : null}

      {inviteDropdownOptions.length > 1 ? (
        <div className='simple-questionnaire-invite-switcher'>
          <UiSelect
            id='questionnaire-invite-select'
            selectClassName='simple-voter-input'
            aria-label='Questionnaire'
            value={selectedInviteKey}
            onChange={(event) => {
              const key = event.target.value;
              setSelectedInviteKey(key);
              const selected = inviteDropdownOptions.find((invite) => inviteMessageKey(invite) === key);
              if (selected) {
                void openInvite(selected);
              }
            }}
          >
            {inviteDropdownOptions.map((invite, index) => {
              const key = inviteMessageKey(invite);
              const progress = inviteDropdownProgressByKey.get(key) ?? getQuestionnaireRoundProgress(null);
              return (
                <option key={key} value={key}>
                  {formatQuestionnaireRoundOptionLabel({
                    invite,
                    index,
                    total: inviteDropdownOptions.length,
                    progress,
                  })}
                </option>
              );
            })}
          </UiSelect>
        </div>
      ) : null}
      {visiblePendingInvites.length > 0 ? (
        <section className='simple-settings-card' aria-label='Pending questionnaire invites'>
          <h4 className='simple-voter-section-title'>Pending invites</h4>
          <ul className='simple-vote-status-list'>
            {visiblePendingInvites.map((invite) => (
              <li key={`${invite.electionId}:${invite.coordinatorNpub}`}>
                <span className='simple-vote-status-icon' aria-hidden='true'>•</span>
                {invite.title || invite.electionId}
                <UiButton
                  icon='external'
                  className='simple-voter-secondary'
                  style={{ marginLeft: 8 }}
                  onPress={() => void openInvite(invite)}
                >
                  Open
                </UiButton>
                <UiButton
                  icon='key'
                  className='simple-voter-secondary'
                  style={{ marginLeft: 8 }}
                  onPress={() => void openInvite(invite, true)}
                >
                  Open + request ballot
                </UiButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {privateInviteBlockCard}
      {showQuestionnaireLanding ? (
        <section className='simple-questionnaire-voter-overview simple-questionnaire-voter-landing' aria-label='Questionnaire start'>
          <div className='simple-questionnaire-voter-title-block'>
            <p className='simple-account-menu-kicker'>Voter ID</p>
            <p className='simple-questionnaire-voter-id-value'>
              {voterIdentityForDetails ? deriveActorDisplayId(voterIdentityForDetails) : "pending"}
            </p>
          </div>
          <div className='simple-questionnaire-voter-title-block'>
            <p className='simple-account-menu-kicker'>Questionnaire</p>
            <h4 className='simple-questionnaire-voter-prompt'>{questionnaireHeadingText}</h4>
            {showQuestionnaireDescription ? (
              <p className='simple-questionnaire-voter-description'>{questionnaireDescriptionText}</p>
            ) : null}
          </div>
          <div className='simple-questionnaire-voter-landing-action'>
            <UiButton
              icon='chevronRight'
              iconPosition='end'
              variant='primary'
              className='simple-voter-primary simple-questionnaire-answer-next'
              onPress={() => setQuestionnaireStarted(true)}
            >
              Start
            </UiButton>
          </div>
        </section>
      ) : null}

      {questions.length === 0 ? (
        <p className='simple-voter-note'>
          {snapshot?.submissionAccepted === true
            ? "Response accepted. Questionnaire details are not loaded in this browser."
            : "Retrieving questions."}
        </p>
      ) : showQuestionnaireLanding ? null : (
        <div className='simple-questionnaire-voter-list'>
          {showMainOnlyScopeWarning ? (
            <p className='simple-voter-note' role='status'>
              This ballot is assigned to the main questions only. If you expected group-specific questions, contact the organiser before submitting.
            </p>
          ) : null}
          {showQuestionNavigation ? (
            <div className='simple-questionnaire-question-stepper is-single-group' aria-label='Question progress'>
              <div className='simple-questionnaire-question-progress-row'>
                <p className='simple-questionnaire-question-progress'>
                  {activeQuestionProgressLabel}
                </p>
                {activeQuestionSubmitted ? <SubmittedStateLabel /> : null}
              </div>
              <div className='simple-questionnaire-progress-track' aria-hidden='true'>
                <span style={{ width: activeQuestionProgressPercent }} />
              </div>
            </div>
          ) : null}
          {visibleQuestionEntries.map(({ question, index }) => {
            const questionSubmitted = perQuestionMode
              ? showProxyBallotsTogether
                ? credentialIndexes.every((credentialIndex) => submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, credentialIndex)))
                : submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId))
              : responseSubmittedForCurrentQuestionnaire;
            const ballotCredentialIndexes = showProxyBallotsTogether ? credentialIndexes : [activeCredentialIndex];
            const questionRequirement = question.required ? "Required" : "Optional";
            return (
            <article
              key={question.questionId}
              ref={activeQuestionCardRef}
              tabIndex={-1}
              className={`simple-questionnaire-voter-card${questionSubmitted ? " is-response-locked" : ""}`}
            >
              <div className='simple-questionnaire-voter-heading'>
                <span className='simple-questionnaire-question-badge' aria-hidden='true'>Q{index + 1}</span>
                <div className='simple-questionnaire-voter-heading-copy'>
                  <h4 className='simple-questionnaire-voter-prompt'>{question.prompt || "Untitled question"}</h4>
                  <p className='simple-questionnaire-voter-helper'>{questionHelperText(question)}</p>
                </div>
              </div>
              {showProxyBallotsTogether ? (
                <div className='simple-questionnaire-proxy-vote-grid'>
                  {ballotCredentialIndexes.map((credentialIndex) => {
                    const ballotSubmitted = submittedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, credentialIndex));
                    const ballotAccepted = acceptedQuestionGroupKeys.has(groupKeyForQuestionId(question.questionId, credentialIndex));
                    const key = answerKeyForQuestion(question.questionId, credentialIndex);
                    const ranked = question.type === "rank" && Array.isArray(answers[key])
                      ? (answers[key] as string[])
                      : [];
                    const rankRequirement = question.type === "rank"
                      ? getRankRequirementState(question.options?.length ?? 0, question.minimumRanked ?? 0, ranked.length)
                      : null;
                    const requirementLabel = ballotAccepted
                      ? "Accepted"
                      : ballotSubmitted
                        ? "Submitted"
                        : rankRequirement?.label ?? (questionHasResponseForCredential(question, credentialIndex) ? "Ready" : questionRequirement);
                    const requirementClass = rankRequirement?.missing
                      ? " is-needed"
                      : requirementLabel === "Optional"
                        ? " is-optional"
                        : "";
                    return (
                      <section
                        key={`${question.questionId}:${credentialIndex}`}
                        className={`simple-questionnaire-proxy-vote-card${ballotSubmitted ? " is-response-locked" : ""}`}
                        aria-label={`Separate vote ${credentialIndex} of ${credentialCount}`}
                      >
                        <div className='simple-questionnaire-proxy-vote-heading'>
                          <strong>Separate vote {credentialIndex}</strong>
                          {requirementLabel === "Submitted" || requirementLabel === "Accepted" ? (
                            <SubmittedStateLabel>{requirementLabel}</SubmittedStateLabel>
                          ) : (
                            <span className={`simple-questionnaire-voter-requirement${requirementClass}`}>
                              {requirementLabel}
                            </span>
                          )}
                        </div>
                        {renderQuestionControls(question, credentialIndex, ballotSubmitted)}
                      </section>
                    );
                  })}
                </div>
              ) : renderQuestionControls(question, activeCredentialIndex, questionSubmitted)}
            </article>
            );
          })}
          {showQuestionNavigation ? (
            <div className='simple-questionnaire-question-stepper simple-questionnaire-question-nav' aria-label='Question navigation'>
              <UiButton
                icon='chevronLeft'
                className='simple-voter-secondary simple-questionnaire-stepper-button'
                isDisabled={previousQuestionIndex < 0}
                onPress={() => {
                  if (previousQuestionIndex >= 0) {
                    setActiveQuestionIndex(previousQuestionIndex);
                  }
                }}
              >
                <span className='simple-questionnaire-stepper-copy'>
                  <strong>Previous</strong>
                  <small>{previousQuestionIndex >= 0 ? `Question ${previousQuestionIndex + 1}` : "No previous question"}</small>
                </span>
              </UiButton>
              <UiButton
                icon={showViewResultsFromQuestionNav ? "view" : showSubmitFromQuestionNav ? submitInFlight ? "spinner" : "send" : "chevronRight"}
                iconPosition={showViewResultsFromQuestionNav || showSubmitFromQuestionNav ? "start" : "end"}
                className={`simple-voter-secondary simple-questionnaire-stepper-button simple-questionnaire-stepper-button-next${questionNavForwardHighlighted ? " is-ready" : ""}${showSubmitFromQuestionNav || showViewResultsFromQuestionNav ? " is-submit" : ""}`}
                isDisabled={showViewResultsFromQuestionNav ? false : showSubmitFromQuestionNav ? submitInFlight || (!canSubmitFromQuestionNav && firstMissingRequiredQuestionIndex < 0) : nextQuestionIndex < 0}
                onPress={() => {
                  if (showViewResultsFromQuestionNav) {
                    viewResults();
                    return;
                  }
                  if (showSubmitFromQuestionNav) {
                    if (returnToFirstMissingRequiredQuestion()) {
                      return;
                    }
                    if (!canSubmitFromQuestionNav) {
                      return;
                    }
                    void submit({ submitAllQuestions: true });
                    return;
                  }
                  if (nextQuestionIndex >= 0) {
                    void advanceAfterPublishing(activeQuestionIds, nextQuestionIndex);
                  }
                }}
              >
                <span className='simple-questionnaire-stepper-copy'>
                  <strong>{showViewResultsFromQuestionNav ? "View results" : showSubmitFromQuestionNav ? submitInFlight ? "Submitting..." : "Submit" : "Next"}</strong>
                  {showViewResultsFromQuestionNav || showSubmitFromQuestionNav ? null : (
                    <small>{nextQuestionIndex >= 0 ? `Question ${nextQuestionIndex + 1}` : "No next question"}</small>
                  )}
                </span>
              </UiButton>
            </div>
          ) : null}
          {submitBlockedMessage ? (
            <p className='simple-voter-note' role='status'>{submitBlockedMessage}</p>
          ) : null}
        </div>
      )}

      {!showQuestionnaireLanding && (showVoteActionButton || showAnswerNextButton) ? (
      <div className='simple-voter-action-row simple-voter-action-row-inline simple-optiona-voter-controls'>
        {showVoteActionButton ? (
          <UiButton
            icon={submitInFlight ? "spinner" : canViewResults ? "view" : canAdvanceQuestion || canAdvanceQuestionBeforeSubmit ? "chevronRight" : "send"}
            iconPosition={canAdvanceQuestion || canAdvanceQuestionBeforeSubmit ? "end" : "start"}
            className='simple-voter-primary'
            isDisabled={submitInFlight || !(canSubmitNow || canAdvanceQuestionBeforeSubmit || canAdvanceQuestion || canViewResults)}
            onPress={() => {
              if (submitInFlight) {
                return;
              }
              if (canAdvanceQuestionBeforeSubmit) {
                if (nextQuestionIndexInActiveGroup >= 0) {
                  void advanceAfterPublishing(activeQuestionIds, nextQuestionIndexInActiveGroup);
                }
                return;
              }
              if (canAdvanceQuestion) {
                const nextQuestionIndex = findNextUnsubmittedQuestionIndex(activeQuestionIndex, activeCredentialIndex);
                if (nextQuestionIndex >= 0) {
                  setActiveQuestionIndex(nextQuestionIndex);
                } else {
                  void moveToNextProxyCredentialIfNeeded([]);
                }
                return;
              }
              if (canViewResults) {
                viewResults();
                return;
              }
              void submit();
            }}
          >
            {voteActionButtonText}
          </UiButton>
        ) : null}
        {showAnswerNextButton ? (
          <UiButton
            icon='chevronRight'
            iconPosition='end'
            className='simple-voter-primary simple-questionnaire-answer-next'
            isDisabled={answerNextDisabled}
            onPress={() => {
              if (nextInviteDropdownOption && !answerNextDisabled) {
                const key = inviteMessageKey(nextInviteDropdownOption);
                setAnswerNextPendingKey(key);
                void openInvite(nextInviteDropdownOption, true)
                  .finally(() => {
                    setAnswerNextPendingKey((current) => current === key ? "" : current);
                  });
              }
            }}
          >
            {answerNextButtonText}
          </UiButton>
        ) : null}
      </div>
      ) : null}
      {!showQuestionnaireLanding && status ? (
        <p className='simple-voter-note' role='status' aria-live='polite'>{status}</p>
      ) : null}
      {displaySubmission ? (
        <details className='simple-auditor-dropdown simple-vote-receipt-dropdown'>
          <summary className='simple-auditor-dropdown-head simple-vote-receipt-dropdown-head'>
            <span className='simple-vote-receipt-dropdown-title'>
              <span className='simple-voter-section-title' role='heading' aria-level={2}>Vote receipt</span>
              {receiptStatusLabel ? (
                <span className={snapshot?.submissionAccepted === false ? "simple-vote-receipt-status is-rejected" : "simple-vote-receipt-status"}>
                  {receiptStatusLabel}
                </span>
              ) : null}
            </span>
          </summary>
          <div className='simple-auditor-dropdown-body'>
            <div className='simple-auditor-dropdown-body-inner simple-vote-receipt-dropdown-body-inner'>
              <section className='simple-settings-card simple-submission-identity-card simple-vote-receipt-card' aria-label='Vote receipt details'>
                <div className='simple-submission-identity-body simple-vote-receipt-body'>
            <div className='simple-vote-receipt-finder'>
              <span>Lookup keys</span>
              <span className='simple-vote-receipt-copy-line simple-vote-receipt-copy-line-identity'>
                <strong>{submittedMarkerLabel}</strong>
                {submittedMarkerNpub ? (
                  <UiButton
                    icon={isReceiptCopyActive("receipt-anonymous-identity") ? "check" : "copy"}
                    iconOnly
                    className='simple-vote-receipt-copy-button'
                    onPress={() => void copyReceiptValue(submittedMarkerNpub, "receipt-anonymous-identity")}
                    aria-label={isReceiptCopyActive("receipt-anonymous-identity") ? "Copied anonymous voting identity" : "Copy anonymous voting identity"}
                    title={isReceiptCopyActive("receipt-anonymous-identity") ? "Copied" : "Copy anonymous voting identity"}
                    data-copied={isReceiptCopyActive("receipt-anonymous-identity") ? "true" : undefined}
                  />
                ) : null}
              </span>
              <span className='simple-vote-receipt-copy-line simple-vote-receipt-copy-line-words'>
                <span className='simple-identity-words-badge'>{submittedMarkerWordsLabel}</span>
                {submittedMarkerWords ? (
                  <UiButton
                    icon={isReceiptCopyActive("receipt-identity-words") ? "check" : "copy"}
                    iconOnly
                    className='simple-vote-receipt-copy-button'
                    onPress={() => void copyReceiptValue(submittedMarkerWords, "receipt-identity-words")}
                    aria-label={isReceiptCopyActive("receipt-identity-words") ? "Copied vote finder words" : "Copy vote finder words"}
                    title={isReceiptCopyActive("receipt-identity-words") ? "Copied" : "Copy vote finder words"}
                    data-copied={isReceiptCopyActive("receipt-identity-words") ? "true" : undefined}
                  />
                ) : null}
              </span>
            </div>
            <div className='simple-vote-receipt-identity-panel'>
              <div className='simple-submission-identity-visuals simple-vote-receipt-marker'>
                <TokenFingerprint
                  tokenId={submittedMarkerNpub}
                  label='Anonymous voting identity'
                  large
                  showQr={false}
                  hideMetadata
                />
              </div>
              <dl className='simple-vote-receipt-marker-meta'>
                <div>
                  <dt>Submitted</dt>
                  <dd>{submittedAtLabel || "Recorded locally"}</dd>
                </div>
              </dl>
            </div>
            {otherProxyReceiptSubmissions.length > 0 ? (
              <div className='simple-vote-receipt-proxy-list' aria-label='Other proxy vote receipts'>
                {otherProxyReceiptSubmissions.map((entry) => (
                  <article key={entry.key} className='simple-vote-receipt-proxy-card'>
                    <div className='simple-vote-receipt-proxy-card-heading'>
                      <strong>Separate vote {entry.credentialIndex}</strong>
                      <span>{entry.submittedAt}</span>
                    </div>
                    <div className='simple-vote-receipt-proxy-card-body'>
                      <TokenFingerprint
                        tokenId={entry.npub}
                        label={`Separate vote ${entry.credentialIndex} anonymous identity`}
                        compact
                        showQr={false}
                        hideMetadata
                      />
                      <div className='simple-vote-receipt-proxy-card-copy'>
                        <span className='simple-vote-receipt-copy-line simple-vote-receipt-copy-line-words'>
                          <span className='simple-identity-words-badge'>{entry.words}</span>
                          {entry.words !== "Not available" ? (
                            <UiButton
                              icon={isReceiptCopyActive(`receipt-proxy-words-${entry.key}`) ? "check" : "copy"}
                              iconOnly
                              className='simple-vote-receipt-copy-button'
                              onPress={() => void copyReceiptValue(entry.words, `receipt-proxy-words-${entry.key}`)}
                              aria-label={isReceiptCopyActive(`receipt-proxy-words-${entry.key}`) ? "Copied proxy vote finder words" : "Copy proxy vote finder words"}
                              title={isReceiptCopyActive(`receipt-proxy-words-${entry.key}`) ? "Copied" : "Copy proxy vote finder words"}
                              data-copied={isReceiptCopyActive(`receipt-proxy-words-${entry.key}`) ? "true" : undefined}
                            />
                          ) : null}
                        </span>
                        <span className='simple-vote-receipt-copy-line simple-vote-receipt-copy-line-identity'>
                          <strong>{entry.npubLabel}</strong>
                          {entry.npub ? (
                            <UiButton
                              icon={isReceiptCopyActive(`receipt-proxy-npub-${entry.key}`) ? "check" : "copy"}
                              iconOnly
                              className='simple-vote-receipt-copy-button'
                              onPress={() => void copyReceiptValue(entry.npub, `receipt-proxy-npub-${entry.key}`)}
                              aria-label={isReceiptCopyActive(`receipt-proxy-npub-${entry.key}`) ? "Copied proxy anonymous voting identity" : "Copy proxy anonymous voting identity"}
                              title={isReceiptCopyActive(`receipt-proxy-npub-${entry.key}`) ? "Copied" : "Copy proxy anonymous voting identity"}
                              data-copied={isReceiptCopyActive(`receipt-proxy-npub-${entry.key}`) ? "true" : undefined}
                            />
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
            <details className='simple-vote-receipt-advanced'>
              <summary>Advanced details</summary>
              <dl className='simple-submission-identity-details simple-vote-receipt-advanced-grid'>
                {advancedReceiptRows.map((row) => (
                  <div key={row.label}>
                    <dt>{row.label}</dt>
                    <dd>{formatBallotDetailValue(row.value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
                </div>
              </section>
            </div>
          </div>
        </details>
      ) : null}
      <span style={{ display: "none" }} aria-hidden='true'>{refreshNonce}</span>
    </div>
    </>
  );
}

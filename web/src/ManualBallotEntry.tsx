/**
 * Paper-ballot manual entry (F3-T4).
 *
 * Entering a completed paper ballot into the digital system is deliberately a
 * two-step screen:
 *
 *   1. Ballot identity - the operator types (or pastes) the `nsec` printed on
 *      the ballot, plus the invite code when the ballot carries one.  The
 *      derived `npub` is shown back so the ballot in hand can be confirmed
 *      before anything is entered.
 *   2. Answers - the questionnaire is rendered with the *same* answer controls
 *      the digital voter flow uses (`QuestionnaireAnswerFields`), so a manual
 *      entry looks and validates like a digital vote and F2 conditional
 *      questions behave identically.
 *
 * On submit the answers are converted with the digital flow's own converter
 * (`fromQuestionnaireResponseAnswers`) and wrapped in a `BallotSubmission`
 * that is checked with the digital flow's own `validateBallotSubmission`.  The
 * submission is then handed to `onSubmitBallot`, which publishes it through the
 * same path the digital flow uses.
 *
 * A ballot whose voting credential is not held on this device cannot be
 * submitted here: rather than inventing credential material, the screen offers
 * the documented handoff (`onOpenDigitalFlow`) which signs that ballot into the
 * ordinary digital vote screen using the same `nsec`.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import TokenFingerprint from "./TokenFingerprint";
import QuestionnaireAnswerFields, {
  buildVisibleResponseAnswers,
  visibleQuestions,
  type QuestionnaireAnswerState,
} from "./QuestionnaireAnswerFields";
import { deriveActorDisplayId } from "./actorDisplay";
import { readCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import { deriveNpubFromNsec } from "./nostrIdentity";
import {
  validateBallotSubmission,
  type BallotSubmission,
} from "./questionnaireOptionA";
import { fromQuestionnaireResponseAnswers } from "./questionnaireOptionARuntime";
import type {
  QuestionnaireDefinition,
  QuestionnaireResponseAnswer,
} from "./questionnaireProtocol";
import { useLocaleSafe, useTSafe } from "./i18n/LanguageContext";
import type { UiStringKey } from "./i18n/uiStrings";
import { UiButton, UiTextField } from "./ui/DesignLayer";

/** The blind-credential material a paper ballot votes with. */
export type ManualBallotCredential = {
  tokenCommitment: string;
  blindSigningKeyId: string;
  credential: string;
  nullifier: string;
};

/** A paper ballot identified by the key printed on it. */
export type ManualBallotIdentity = {
  /** The questionnaire the ballot belongs to. */
  questionnaireId: string;
  /** The private key printed on the ballot (the voter identity). */
  nsec: string;
  /** The npub derived from `nsec`. */
  npub: string;
  /** The invite code printed on the ballot, when it has one. */
  inviteCode: string;
};

export type ManualBallotIdentityResult =
  | { ok: true; identity: ManualBallotIdentity }
  | { ok: false; error: "missing_nsec" | "invalid_nsec" | "public_key_only" };

export type ManualBallotEntryProps = {
  /** Questionnaire to enter.  When omitted, `questionnaireId` is read from the local cache. */
  definition?: QuestionnaireDefinition | null;
  /** Published questionnaire id used to read the definition from the local cache. */
  questionnaireId?: string | null;
  /**
   * Voting credential for the ballot.  The screen refuses to submit without
   * one instead of fabricating credential material.
   */
  credential?: ManualBallotCredential | null;
  initialNsec?: string;
  initialInviteCode?: string;
  /** Publish the entered ballot.  Wired to the same publish path the digital flow uses. */
  onSubmitBallot?: (submission: BallotSubmission, identity: ManualBallotIdentity) => Promise<void> | void;
  /** Sign the ballot into the ordinary digital vote screen (same submission flow, provided nsec). */
  onOpenDigitalFlow?: (identity: ManualBallotIdentity) => void;
  /** Called when the operator leaves the screen. */
  onExit?: () => void;
};

const NSEC_PREFIX = "nsec1";
const NPUB_PREFIX = "npub1";

function fillTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}

/**
 * Pull the ballot key out of whatever was typed or scanned: a bare `nsec1...`
 * value, a `nostr:nsec1...` URI, or a ballot/invite URL carrying `nsec=`.
 *
 * A value that only carries the ballot's public key is reported distinctly:
 * the printed QR currently encodes the npub, which is not enough to vote with.
 */
export function extractBallotNsec(value: string): { nsec: string; publicKeyOnly: boolean } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { nsec: "", publicKeyOnly: false };
  }
  const withoutScheme = trimmed.replace(/^nostr:/i, "");
  if (withoutScheme.startsWith(NSEC_PREFIX)) {
    return { nsec: withoutScheme.split(/\s+/)[0], publicKeyOnly: false };
  }
  if (withoutScheme.startsWith(NPUB_PREFIX)) {
    return { nsec: "", publicKeyOnly: true };
  }
  const fromQuery = withoutScheme.match(/[?&#]nsec=([^&\s]+)/i);
  if (fromQuery?.[1]) {
    return { nsec: decodeURIComponent(fromQuery[1]), publicKeyOnly: false };
  }
  const fromNpubQuery = withoutScheme.match(/[?&#]npub=([^&\s]+)/i);
  if (fromNpubQuery?.[1]) {
    return { nsec: "", publicKeyOnly: true };
  }
  return { nsec: trimmed, publicKeyOnly: false };
}

/**
 * Validate the typed ballot key and derive the ballot identity.  Pure so the
 * screen and its tests agree on exactly what counts as a usable ballot.
 */
export function parseManualBallotIdentity(input: {
  value: string;
  inviteCode?: string;
  questionnaireId: string;
}): ManualBallotIdentityResult {
  const extracted = extractBallotNsec(input.value);
  if (extracted.publicKeyOnly) {
    return { ok: false, error: "public_key_only" };
  }
  if (!extracted.nsec.trim()) {
    return { ok: false, error: "missing_nsec" };
  }
  const npub = deriveNpubFromNsec(extracted.nsec);
  if (!npub) {
    return { ok: false, error: "invalid_nsec" };
  }
  return {
    ok: true,
    identity: {
      questionnaireId: input.questionnaireId.trim(),
      nsec: extracted.nsec,
      npub,
      inviteCode: input.inviteCode?.trim() ?? "",
    },
  };
}

function createSubmissionId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `submission_${Date.now().toString(36)}_${hex}`;
}

/**
 * Build the `BallotSubmission` a manually entered paper ballot produces.
 *
 * The answers are converted with the digital flow's converter and the finished
 * submission is checked with the digital flow's validator, so a paper ballot
 * cannot take a shortcut into the tally that a digital ballot could not.
 */
export function buildManualBallotSubmission(input: {
  definition: QuestionnaireDefinition;
  answers: QuestionnaireResponseAnswer[];
  identity: ManualBallotIdentity;
  credential: ManualBallotCredential;
  /** Questions that must be answered; defaults to every required question. */
  requiredQuestionIds?: string[];
  submissionId?: string;
  submittedAt?: string;
}): BallotSubmission {
  const electionId = input.definition.questionnaireId;
  const requiredQuestionIds = input.requiredQuestionIds
    ?? input.definition.questions.filter((question) => question.required).map((question) => question.questionId);

  const submission: BallotSubmission = {
    type: "ballot_submission",
    schemaVersion: 1,
    electionId,
    submissionId: input.submissionId ?? createSubmissionId(),
    invitedNpub: input.identity.npub,
    responseNpub: input.identity.npub,
    tokenCommitment: input.credential.tokenCommitment,
    blindSigningKeyId: input.credential.blindSigningKeyId,
    credential: input.credential.credential,
    nullifier: input.credential.nullifier,
    payload: {
      electionId,
      responses: fromQuestionnaireResponseAnswers(input.answers),
    },
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  };

  const valid = validateBallotSubmission({
    submission,
    electionId,
    electionState: "open",
    requiredQuestionIds,
    definition: input.definition,
  });
  if (!valid) {
    throw new Error("The entered ballot is invalid or incomplete.");
  }

  return submission;
}

export default function ManualBallotEntry({
  definition = null,
  questionnaireId = null,
  credential = null,
  initialNsec = "",
  initialInviteCode = "",
  onSubmitBallot,
  onOpenDigitalFlow,
  onExit,
}: ManualBallotEntryProps) {
  const { locale } = useLocaleSafe();
  const t = useTSafe();
  const translate = useCallback(
    (key: UiStringKey, values?: Record<string, string | number>) => {
      const template = t(key);
      return values ? fillTemplate(template, values) : template;
    },
    [t],
  );

  const [cachedDefinition, setCachedDefinition] = useState<QuestionnaireDefinition | null>(null);
  const [nsecInput, setNsecInput] = useState(initialNsec);
  const [inviteCodeInput, setInviteCodeInput] = useState(initialInviteCode);
  const [identity, setIdentity] = useState<ManualBallotIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [answerState, setAnswerState] = useState<QuestionnaireAnswerState>({});
  const [status, setStatus] = useState<string | null>(null);
  const [submitInFlight, setSubmitInFlight] = useState(false);

  useEffect(() => {
    const id = questionnaireId?.trim() ?? "";
    if (definition || !id) {
      setCachedDefinition(null);
      return;
    }
    setCachedDefinition(readCachedQuestionnaireDefinition(id));
  }, [definition, questionnaireId]);

  const activeDefinition = definition ?? cachedDefinition;
  const activeQuestionnaireId = (activeDefinition?.questionnaireId ?? questionnaireId ?? "").trim();

  const visibleAnswers = useMemo(
    () => (activeDefinition ? buildVisibleResponseAnswers(activeDefinition, answerState) : []),
    [activeDefinition, answerState],
  );
  const visibleQuestionIds = useMemo(
    () => new Set((activeDefinition ? visibleQuestions(activeDefinition, answerState) : []).map((question) => question.questionId)),
    [activeDefinition, answerState],
  );
  const requiredQuestionIds = useMemo(
    () => (activeDefinition?.questions ?? [])
      .filter((question) => question.required && visibleQuestionIds.has(question.questionId))
      .map((question) => question.questionId),
    [activeDefinition, visibleQuestionIds],
  );
  const answeredQuestionIds = useMemo(
    () => new Set(visibleAnswers.map((answer) => answer.questionId)),
    [visibleAnswers],
  );
  const missingRequired = requiredQuestionIds.some((questionId) => !answeredQuestionIds.has(questionId));
  const canSubmit = Boolean(
    activeDefinition && identity && credential && !missingRequired && !submitInFlight,
  );

  function confirmIdentity() {
    const result = parseManualBallotIdentity({
      value: nsecInput,
      inviteCode: inviteCodeInput,
      questionnaireId: activeQuestionnaireId,
    });
    if (!result.ok) {
      if (result.error === "missing_nsec") {
        setIdentityError(translate("paperBallotEntryMissingNsec"));
      } else if (result.error === "public_key_only") {
        setIdentityError(translate("paperBallotEntryPublicKeyOnly"));
      } else {
        setIdentityError(translate("paperBallotEntryInvalidNsec"));
      }
      return;
    }
    setIdentityError(null);
    setStatus(null);
    setIdentity(result.identity);
  }

  function resetIdentity() {
    setIdentity(null);
    setIdentityError(null);
    setStatus(null);
    setAnswerState({});
  }

  function isQuestionVisible(question: { questionId: string }) {
    return visibleQuestionIds.has(question.questionId);
  }

  async function submitBallot() {
    if (!activeDefinition || !identity || !credential || submitInFlight) {
      return;
    }
    setSubmitInFlight(true);
    setStatus(null);
    try {
      const submission = buildManualBallotSubmission({
        definition: activeDefinition,
        answers: visibleAnswers,
        identity,
        credential,
        requiredQuestionIds,
      });
      await onSubmitBallot?.(submission, identity);
      setStatus(translate("paperBallotEntrySubmitted", { id: submission.submissionId }));
    } catch (error) {
      setStatus(translate("paperBallotEntrySubmitFailed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setSubmitInFlight(false);
    }
  }

  return (
    <section className='simple-paper-ballot-entry'>
      <h3 className='simple-voter-section-title'>{t("paperBallotEntryTitle")}</h3>
      <p className='simple-voter-note'>{t("paperBallotEntryIntro")}</p>
      <p className='simple-paper-ballot-entry-warning'>{t("paperBallotEntrySecurityNote")}</p>

      {!activeDefinition ? (
        <p className='simple-voter-note'>{t("paperBallotEntryNoQuestionnaire")}</p>
      ) : null}

      {activeDefinition && !identity ? (
        <div className='simple-paper-ballot-entry-identity'>
          <UiTextField
            label={t("paperBallotEntryNsecLabel")}
            description={t("paperBallotEntryNsecHint")}
            fieldClassName='simple-voter-field'
            inputClassName='simple-voter-input'
            isInvalid={Boolean(identityError)}
            errorMessage={identityError ?? undefined}
            inputProps={{
              id: "paper-ballot-entry-nsec",
              value: nsecInput,
              placeholder: "nsec1...",
              autoComplete: "off",
              spellCheck: false,
              onChange: (event) => setNsecInput(event.target.value),
            }}
          />
          <UiTextField
            label={t("paperBallotEntryInviteCodeLabel")}
            fieldClassName='simple-voter-field'
            inputClassName='simple-voter-input'
            inputProps={{
              id: "paper-ballot-entry-invite-code",
              value: inviteCodeInput,
              placeholder: t("paperBallotEntryInviteCodePlaceholder"),
              autoComplete: "off",
              spellCheck: false,
              onChange: (event) => setInviteCodeInput(event.target.value),
            }}
          />
          <div className='simple-voter-button-row'>
            <UiButton
              icon='check'
              className='simple-voter-primary'
              onPress={confirmIdentity}
              isDisabled={!nsecInput.trim()}
            >
              {t("paperBallotEntryConfirmIdentity")}
            </UiButton>
            {onExit ? (
              <UiButton icon='cancel' className='simple-voter-secondary' onPress={onExit}>
                {t("actionCancel")}
              </UiButton>
            ) : null}
          </div>
        </div>
      ) : null}

      {activeDefinition && identity ? (
        <div className='simple-paper-ballot-entry-answers'>
          <div className='simple-paper-ballot-entry-identity-card'>
            <TokenFingerprint tokenId={identity.npub} showQr={false} size={5} />
            <div className='simple-paper-ballot-entry-identity-details'>
              <p className='simple-paper-ballot-entry-identity-label'>{t("paperBallotEntryIdentityTitle")}</p>
              <p className='simple-paper-ballot-entry-identity-npub'>{deriveActorDisplayId(identity.npub)}</p>
              <p className='simple-voter-note simple-paper-ballot-entry-identity-hint'>
                {t("paperBallotEntryVerifyIdentity")}
              </p>
            </div>
            <UiButton
              icon='reset'
              className='simple-voter-secondary'
              onPress={resetIdentity}
            >
              {t("paperBallotEntryChangeIdentity")}
            </UiButton>
          </div>

          <h4 className='simple-voter-section-title'>{t("paperBallotEntryAnswersTitle")}</h4>
          <div className='simple-questionnaire-voter-list'>
            <QuestionnaireAnswerFields
              definition={activeDefinition}
              answerState={answerState}
              locale={locale}
              isQuestionVisible={isQuestionVisible}
              onYesNoAnswer={(questionId, value) => {
                setAnswerState((current) => ({ ...current, [questionId]: value }));
              }}
              onMultipleChoiceAnswer={(questionId, optionId, multiSelect) => {
                setAnswerState((current) => {
                  const existing = Array.isArray(current[questionId]) ? (current[questionId] as string[]) : [];
                  if (!multiSelect) {
                    return { ...current, [questionId]: [optionId] };
                  }
                  return existing.includes(optionId)
                    ? { ...current, [questionId]: existing.filter((entry) => entry !== optionId) }
                    : { ...current, [questionId]: [...existing, optionId] };
                });
              }}
              onAddRankedAnswer={(questionId, optionId) => {
                setAnswerState((current) => {
                  const existing = Array.isArray(current[questionId]) ? (current[questionId] as string[]) : [];
                  if (existing.includes(optionId)) {
                    return current;
                  }
                  return { ...current, [questionId]: [...existing, optionId] };
                });
              }}
              onRemoveRankedAnswer={(questionId, optionId) => {
                setAnswerState((current) => {
                  const existing = Array.isArray(current[questionId]) ? (current[questionId] as string[]) : [];
                  return { ...current, [questionId]: existing.filter((entry) => entry !== optionId) };
                });
              }}
              onMoveRankedAnswer={(questionId, optionId, direction) => {
                setAnswerState((current) => {
                  const existing = Array.isArray(current[questionId]) ? (current[questionId] as string[]) : [];
                  const index = existing.indexOf(optionId);
                  const target = index + direction;
                  if (index < 0 || target < 0 || target >= existing.length) {
                    return current;
                  }
                  const next = [...existing];
                  next[index] = next[target];
                  next[target] = optionId;
                  return { ...current, [questionId]: next };
                });
              }}
              onFreeTextAnswer={(questionId, value) => {
                setAnswerState((current) => ({ ...current, [questionId]: value }));
              }}
            />
          </div>

          {missingRequired ? (
            <p className='simple-voter-note'>{t("paperBallotEntryMissingAnswers")}</p>
          ) : null}

          {!credential ? (
            <div className='simple-paper-ballot-entry-credential'>
              <p className='simple-voter-note'>{t("paperBallotEntryNoCredential")}</p>
              {onOpenDigitalFlow ? (
                <UiButton
                  icon='send'
                  className='simple-voter-primary'
                  onPress={() => onOpenDigitalFlow(identity)}
                >
                  {t("paperBallotEntryOpenDigitalFlow")}
                </UiButton>
              ) : null}
            </div>
          ) : (
            <UiButton
              icon={submitInFlight ? "spinner" : "send"}
              className='simple-voter-primary simple-voter-primary-wide'
              onPress={() => void submitBallot()}
              isDisabled={!canSubmit}
            >
              {submitInFlight ? t("paperBallotEntrySubmitting") : t("paperBallotEntrySubmit")}
            </UiButton>
          )}
        </div>
      ) : null}

      {status ? <p className='simple-paper-ballot-entry-status'>{status}</p> : null}
    </section>
  );
}

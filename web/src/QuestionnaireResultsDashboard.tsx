import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import {
  Button as AriaButton,
  Disclosure as AriaDisclosure,
} from "react-aria-components";
import {
  CalendarDays,
  CircleCheck,
  CircleHelp,
  Clock3,
  Copy,
  FileText,
  Activity,
  UserRound,
  Users,
} from "lucide-react";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId, formatQuestionnaireDisplayId } from "./actorDisplay";
import { deriveIdentityWords } from "./identityWords";
import { UiButton, UiDataTable, UiSwitch, UiTextField } from "./ui/DesignLayer";
import {
  calculateRankQuestionScores,
  normaliseRankedOptionIds,
} from "./questionnaireProtocol";
import type {
  QuestionnaireQuestion,
  QuestionnaireResponseAnswer,
  QuestionnaireResultPackReference,
  QuestionnaireResultQuestionSummary,
} from "./questionnaireProtocol";

const SUBMITTED_VOTES_PAGE_SIZE = 100;

function AuditorDropdown({
  className = "",
  headClassName = "",
  defaultOpen = false,
  title,
  children,
}: {
  className?: string;
  headClassName?: string;
  defaultOpen?: boolean;
  title: ReactNode;
  children: ReactNode;
}) {
  const bodyId = useId();

  return (
    <AriaDisclosure
      defaultExpanded={defaultOpen}
      className={({ isExpanded }) => `simple-auditor-dropdown ${isExpanded ? "is-open" : "is-closed"} ${className}`.trim()}
    >
      {({ isExpanded }) => {
        const hiddenBodyProps = isExpanded ? {} : ({ inert: "" } as Record<string, string>);
        return (
          <>
            <AriaButton
              slot='trigger'
              type='button'
              className={`simple-auditor-dropdown-head ${headClassName}`.trim()}
              aria-controls={bodyId}
            >
              {title}
            </AriaButton>
            <div
              id={bodyId}
              className='simple-auditor-dropdown-body'
              aria-hidden={!isExpanded}
              {...hiddenBodyProps}
            >
              <div className='simple-auditor-dropdown-body-inner'>
                {children}
              </div>
            </div>
          </>
        );
      }}
    </AriaDisclosure>
  );
}

export type QuestionnaireResultsDashboardQuestionnaire = {
  questionnaireId: string;
  title: string;
  description?: string | null;
  createdAt?: number | null;
  openAt?: number | null;
  closeAt?: number | null;
  closedAt?: number | null;
  resultPublishedAt?: number | null;
  state?: string | null;
  resultPack?: QuestionnaireResultPackReference | null;
  questions: QuestionnaireQuestion[];
};

export type QuestionnaireResultsDashboardResponseDetail = {
  event: {
    id: string;
    created_at?: number | null;
  };
  accepted: boolean;
  rejectionReason?: string | null;
  includedInLatestPublish?: boolean;
  decryptedAnswerQuestionIds?: string[];
  response: {
    responseId: string;
    authorPubkey: string;
    submittedAt?: number | null;
    tokenNullifier?: string | null;
    tokenCommitment?: string | null;
    answers?: QuestionnaireResponseAnswer[];
  };
};

type QuestionnaireResultsDashboardProps = {
  questionnaire: QuestionnaireResultsDashboardQuestionnaire | null;
  questionSummaries: QuestionnaireResultQuestionSummary[];
  responseDetails: QuestionnaireResultsDashboardResponseDetail[];
  provisionalResponseDetails?: QuestionnaireResultsDashboardResponseDetail[];
  displayValidCount: number;
  displayInvalidCount?: number;
  loadedValidCount?: number;
  loadedInvalidCount?: number;
  publishedTotalsAvailable?: boolean;
  showSubmittedVotes?: boolean;
  variant?: "default" | "session";
  topControls?: ReactNode;
  coordinatorLabel?: string;
  coordinatorText: string;
  publishedAtLabel: string;
  publishedAtTime?: number | null;
  canExportResults?: boolean;
  onExportResults?: () => void;
  actions?: ReactNode;
  responseDecryptControls?: ReactNode;
  fallbackQuestionSummaryNote?: string | null;
  emptyQuestionSummaryText?: string;
  emptySelectionText?: string;
  emptyResponsesText?: string;
  emptyResponseSelectionText?: string;
};

export function questionnaireResponseDetailMatchesSearch(
  entry: QuestionnaireResultsDashboardResponseDetail,
  searchQuery: string,
) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const submitterIdentityFull = entry.response.authorPubkey.trim();
  const submitterIdentityShort = deriveActorDisplayId(submitterIdentityFull);
  const submitterIdentityWords = deriveIdentityWords(submitterIdentityFull);
  return (
    entry.response.responseId.toLowerCase().includes(query)
    || submitterIdentityShort.toLowerCase().includes(query)
    || submitterIdentityWords.toLowerCase().includes(query)
    || submitterIdentityFull.toLowerCase().includes(query)
    || (entry.response.tokenNullifier ?? "").toLowerCase().includes(query)
    || (entry.rejectionReason ?? "").toLowerCase().includes(query)
  );
}

function compareResponseDetailsByShortId(
  left: QuestionnaireResultsDashboardResponseDetail,
  right: QuestionnaireResultsDashboardResponseDetail,
) {
  const leftShortId = deriveActorDisplayId(left.response.authorPubkey).toLowerCase();
  const rightShortId = deriveActorDisplayId(right.response.authorPubkey).toLowerCase();
  const shortIdOrder = leftShortId.localeCompare(rightShortId, undefined, { numeric: true });
  if (shortIdOrder !== 0) {
    return shortIdOrder;
  }
  const leftResponseId = left.response.responseId.toLowerCase();
  const rightResponseId = right.response.responseId.toLowerCase();
  const responseIdOrder = leftResponseId.localeCompare(rightResponseId, undefined, { numeric: true });
  if (responseIdOrder !== 0) {
    return responseIdOrder;
  }
  return String(left.event.id).localeCompare(String(right.event.id));
}

export default function QuestionnaireResultsDashboard({
  questionnaire,
  questionSummaries,
  responseDetails,
  provisionalResponseDetails = [],
  displayValidCount,
  displayInvalidCount = responseDetails.filter((entry) => !entry.accepted).length,
  loadedValidCount,
  loadedInvalidCount,
  publishedTotalsAvailable = false,
  showSubmittedVotes = true,
  variant = "default",
  topControls,
  coordinatorLabel = "Organiser",
  coordinatorText,
  publishedAtLabel,
  publishedAtTime,
  canExportResults = false,
  onExportResults,
  actions,
  responseDecryptControls,
  fallbackQuestionSummaryNote = null,
  emptyQuestionSummaryText = "No published result summary or live verified submissions yet for this questionnaire.",
  emptySelectionText = "Choose a questionnaire round to inspect results.",
  emptyResponsesText = "No submitted responses found for this round yet.",
  emptyResponseSelectionText = "Choose a questionnaire round to inspect responses.",
}: QuestionnaireResultsDashboardProps) {
  const [voterSearchQuery, setVoterSearchQuery] = useState("");
  const [resultSearchQuery, setResultSearchQuery] = useState("");
  const [showInvalidVotes, setShowInvalidVotes] = useState(false);
  const [submittedPageIndex, setSubmittedPageIndex] = useState(0);
  const [freeTextViewerQuestionId, setFreeTextViewerQuestionId] = useState<string | null>(null);

  const selectedQuestionById = useMemo(
    () => new Map((questionnaire?.questions ?? []).map((question) => [question.questionId, question])),
    [questionnaire?.questions],
  );
  const selectedQuestionNumberById = useMemo(
    () => new Map((questionnaire?.questions ?? []).map((question, index) => [question.questionId, index + 1])),
    [questionnaire?.questions],
  );
  const acceptedQuestionResponseCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of responseDetails) {
      if (!entry.accepted || !Array.isArray(entry.response.answers)) {
        continue;
      }
      const answeredQuestionIds = new Set<string>();
      for (const answer of entry.response.answers) {
        answeredQuestionIds.add(answer.questionId);
      }
      for (const questionId of answeredQuestionIds) {
        counts.set(questionId, (counts.get(questionId) ?? 0) + 1);
      }
    }
    return counts;
  }, [responseDetails]);
  const acceptedQuestionLatestAtById = useMemo(() => {
    const latestByQuestionId = new Map<string, number>();
    for (const entry of responseDetails) {
      if (!entry.accepted || !Array.isArray(entry.response.answers)) {
        continue;
      }
      const eventTime = Number(entry.event.created_at ?? entry.response.submittedAt ?? 0);
      const submittedAt = Number(entry.response.submittedAt ?? 0);
      const entryTime = Math.max(eventTime, submittedAt);
      const answeredQuestionIds = new Set<string>();
      for (const answer of entry.response.answers) {
        answeredQuestionIds.add(answer.questionId);
      }
      for (const questionId of answeredQuestionIds) {
        latestByQuestionId.set(questionId, Math.max(latestByQuestionId.get(questionId) ?? 0, entryTime));
      }
    }
    return latestByQuestionId;
  }, [responseDetails]);
  const invalidResponseCount = useMemo(
    () => responseDetails.filter((entry) => !entry.accepted).length,
    [responseDetails],
  );
  const hasInvalidResponses = invalidResponseCount > 0;
  const loadedAcceptedCount = loadedValidCount ?? responseDetails.filter((entry) => entry.accepted).length;
  const loadedRejectedCount = loadedInvalidCount ?? invalidResponseCount;
  const loadedTotalCount = loadedAcceptedCount + loadedRejectedCount;
  const acceptedLoadedQuestionSummaryById = useMemo(() => {
    const summaries = buildLoadedQuestionSummaries(
      questionnaire?.questions ?? [],
      responseDetails.filter((entry) => entry.accepted),
    );
    return new Map(summaries.map((summary) => [summary.questionId, summary]));
  }, [questionnaire?.questions, responseDetails]);
  const provisionalDeltaQuestionSummaryById = useMemo(() => {
    return buildPendingProvisionalQuestionSummaries(
      questionnaire?.questions ?? [],
      provisionalResponseDetails,
      acceptedQuestionLatestAtById,
    );
  }, [acceptedQuestionLatestAtById, provisionalResponseDetails, questionnaire?.questions]);
  const provisionalPendingResponseCount = useMemo(
    () => sumQuestionSummaryResponseCounts([...provisionalDeltaQuestionSummaryById.values()]),
    [provisionalDeltaQuestionSummaryById],
  );
  const pendingFinalResponseDetails = useMemo<QuestionnaireResultsDashboardResponseDetail[]>(
    () => [],
    [],
  );
  const pendingFinalAcceptedCount = useMemo(
    () => pendingFinalResponseDetails.filter((entry) => entry.accepted).length,
    [pendingFinalResponseDetails],
  );
  const pendingFinalRejectedCount = useMemo(
    () => pendingFinalResponseDetails.filter((entry) => !entry.accepted).length,
    [pendingFinalResponseDetails],
  );
  const pendingLiveAcceptedCount = pendingFinalAcceptedCount + provisionalPendingResponseCount;
  const pendingLiveRejectedCount = pendingFinalRejectedCount;
  const pendingLiveTotalCount = pendingLiveAcceptedCount + pendingLiveRejectedCount;
  const pendingLiveQuestionSummaryById = useMemo(() => {
    const summaries = buildLoadedQuestionSummaries(
      questionnaire?.questions ?? [],
      pendingFinalResponseDetails.filter((entry) => entry.accepted),
    );
    const merged = new Map(summaries.map((summary) => [summary.questionId, summary]));
    for (const [questionId, provisionalSummary] of provisionalDeltaQuestionSummaryById) {
      merged.set(questionId, addQuestionSummaries(merged.get(questionId), provisionalSummary));
    }
    return merged;
  }, [pendingFinalResponseDetails, provisionalDeltaQuestionSummaryById, questionnaire?.questions]);
  const effectiveQuestionSummaries = useMemo(() => {
    if (publishedTotalsAvailable) {
      return questionSummaries;
    }
    const combined = new Map<string, QuestionnaireResultQuestionSummary>();
    for (const [questionId, summary] of acceptedLoadedQuestionSummaryById) {
      combined.set(questionId, summary);
    }
    for (const [questionId, summary] of provisionalDeltaQuestionSummaryById) {
      combined.set(questionId, addQuestionSummaries(combined.get(questionId), summary));
    }
    return (questionnaire?.questions ?? [])
      .map((question) => combined.get(question.questionId))
      .filter((summary): summary is QuestionnaireResultQuestionSummary => Boolean(summary));
  }, [
    acceptedLoadedQuestionSummaryById,
    provisionalDeltaQuestionSummaryById,
    publishedTotalsAvailable,
    questionSummaries,
    questionnaire?.questions,
  ]);

  useEffect(() => {
    if (!hasInvalidResponses && showInvalidVotes) {
      setShowInvalidVotes(false);
    }
  }, [hasInvalidResponses, showInvalidVotes]);

  const filteredResponseDetails = useMemo(() => {
    const visibilityFiltered = showInvalidVotes
      ? responseDetails.filter((entry) => !entry.accepted)
      : responseDetails.filter((entry) => entry.accepted);
    return visibilityFiltered
      .filter((entry) => questionnaireResponseDetailMatchesSearch(entry, voterSearchQuery))
      .sort(compareResponseDetailsByShortId);
  }, [responseDetails, showInvalidVotes, voterSearchQuery]);
  const filteredQuestionSummaries = useMemo(
    () => effectiveQuestionSummaries.filter((summary) => (
      questionSummaryMatchesSearch(summary, selectedQuestionById.get(summary.questionId), resultSearchQuery)
    )),
    [effectiveQuestionSummaries, resultSearchQuery, selectedQuestionById],
  );
  const submittedPageCount = Math.max(1, Math.ceil(filteredResponseDetails.length / SUBMITTED_VOTES_PAGE_SIZE));
  const clampedSubmittedPageIndex = Math.min(submittedPageIndex, submittedPageCount - 1);
  const visibleResponseDetails = useMemo(() => {
    const pageStart = clampedSubmittedPageIndex * SUBMITTED_VOTES_PAGE_SIZE;
    return filteredResponseDetails.slice(pageStart, pageStart + SUBMITTED_VOTES_PAGE_SIZE);
  }, [clampedSubmittedPageIndex, filteredResponseDetails]);
  const visibleResponseStart = filteredResponseDetails.length > 0
    ? clampedSubmittedPageIndex * SUBMITTED_VOTES_PAGE_SIZE + 1
    : 0;
  const visibleResponseEnd = Math.min(
    filteredResponseDetails.length,
    visibleResponseStart + visibleResponseDetails.length - 1,
  );
  const shouldShowSubmittedPager = filteredResponseDetails.length > SUBMITTED_VOTES_PAGE_SIZE;

  useEffect(() => {
    setSubmittedPageIndex(0);
  }, [showInvalidVotes, voterSearchQuery]);

  useEffect(() => {
    if (submittedPageIndex !== clampedSubmittedPageIndex) {
      setSubmittedPageIndex(clampedSubmittedPageIndex);
    }
  }, [clampedSubmittedPageIndex, submittedPageIndex]);

  const displayTotalCount = Math.max(0, displayValidCount + displayInvalidCount);
  const displayValidityPercent = displayTotalCount > 0
    ? ((displayValidCount / displayTotalCount) * 100).toFixed(1)
    : "0.0";
  const displayValidityPercentNumber = Number(displayValidityPercent);
  const displayValidityPercentLabel = displayTotalCount > 0
    ? `${Math.round(displayValidityPercentNumber)}%`
    : "0%";
  const publishedProgressLabel = `${displayValidCount}/${displayTotalCount || 0} accepted (${displayValidityPercentLabel})`;
  const loadedTotalPercent = displayTotalCount > 0
    ? Math.round((loadedTotalCount / displayTotalCount) * 100)
    : loadedTotalCount > 0 ? 100 : 0;
  const loadedAcceptedPercent = loadedTotalCount > 0
    ? Math.round((loadedAcceptedCount / loadedTotalCount) * 100)
    : 0;
  const loadedProgressLabel = `${loadedAcceptedCount}/${loadedTotalCount || 0} accepted (${loadedAcceptedPercent}%)`;
  const loadedTotalLabel = `Loaded: ${loadedTotalCount} (${loadedTotalPercent}%)`;
  const loadedAcceptedLabel = `Accepted: ${loadedAcceptedCount} (${loadedAcceptedPercent}%)`;
  const loadedResponsesLabel = `${loadedTotalLabel} · ${loadedAcceptedLabel}${loadedRejectedCount > 0 ? ` · Invalid: ${loadedRejectedCount}` : ""}`;
  const visibleAcceptedCount = publishedTotalsAvailable
    ? displayValidCount + pendingLiveAcceptedCount
    : loadedAcceptedCount + provisionalPendingResponseCount;
  const visibleTotalCount = publishedTotalsAvailable
    ? displayTotalCount + pendingLiveTotalCount
    : loadedTotalCount + provisionalPendingResponseCount;
  const visibleAcceptedPercent = visibleTotalCount > 0
    ? Math.round((visibleAcceptedCount / visibleTotalCount) * 100)
    : 0;
  const submittedAcceptedCount = Math.max(0, visibleAcceptedCount - pendingLiveAcceptedCount);
  const visibleProgressLabel = pendingLiveTotalCount > 0
    ? `${visibleAcceptedCount}/${visibleTotalCount || 0} accepted (${visibleAcceptedPercent}%) · ${submittedAcceptedCount} published · ${pendingLiveAcceptedCount} live`
    : publishedTotalsAvailable
      ? publishedProgressLabel
      : loadedProgressLabel;
  const closingStatus = getClosingStatus(questionnaire);
  const questionnaireDescription = questionnaire?.description?.trim() ?? "";
  const isSessionVariant = variant === "session";
  const baseSummaryIncludesPending = !publishedTotalsAvailable;

  const renderAnswerList = (entry: QuestionnaireResultsDashboardResponseDetail) => (
    <ol className='simple-auditor-answer-list'>
      {entry.response.answers?.map((answer) => {
        const question = selectedQuestionById.get(answer.questionId);
        const questionNumber = selectedQuestionNumberById.get(answer.questionId);
        const prompt = `${questionNumber ? `Q${questionNumber}. ` : ""}${question?.prompt || answer.questionId}`;
        const answerWasDecrypted = isAnswerDecrypted(entry, answer);
        if (answer.answerType === "yes_no") {
          return (
            <li key={`${entry.event.id}:${answer.questionId}`}>
              <span className='simple-auditor-answer-prompt'>{prompt}</span>
              <div className='simple-auditor-answer-values'>
                <span className='simple-auditor-answer-chip'>{answer.value ? "Yes" : "No"}</span>
                {answerWasDecrypted ? <DecryptedAnswerBadge /> : null}
              </div>
            </li>
          );
        }
        if (answer.answerType === "multiple_choice") {
          const selectedLabels = answer.selectedOptionIds.map((optionId) => (
            question?.type === "multiple_choice"
              ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
              : optionId
          ));
          return (
            <li key={`${entry.event.id}:${answer.questionId}`}>
              <span className='simple-auditor-answer-prompt'>{prompt}</span>
              <div className='simple-auditor-answer-values'>
                {selectedLabels.length > 0 ? selectedLabels.map((label) => (
                  <span key={label} className='simple-auditor-answer-chip'>{label}</span>
                )) : (
                  <span className='simple-auditor-answer-chip'>No option selected</span>
                )}
                {answerWasDecrypted ? <DecryptedAnswerBadge /> : null}
              </div>
            </li>
          );
        }
        if (answer.answerType === "rank") {
          const rankedLabels = answer.rankedOptionIds.map((optionId) => (
            question?.type === "rank"
              ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
              : optionId
          ));
          return (
            <li key={`${entry.event.id}:${answer.questionId}`}>
              <span className='simple-auditor-answer-prompt'>{prompt}</span>
              <div className='simple-auditor-answer-values'>
                {rankedLabels.length > 0 ? rankedLabels.map((label, labelIndex) => (
                  <span key={`${label}:${labelIndex}`} className='simple-auditor-answer-chip'>{labelIndex + 1}. {label}</span>
                )) : (
                  <span className='simple-auditor-answer-chip'>No ranked choices selected</span>
                )}
                {answerWasDecrypted ? <DecryptedAnswerBadge /> : null}
              </div>
            </li>
          );
        }
        return (
          <li key={`${entry.event.id}:${answer.questionId}`} className='simple-auditor-answer-item-free-text'>
            <span className='simple-auditor-answer-prompt'>{prompt}</span>
            <div className='simple-auditor-answer-free-text-row'>
              <div className='simple-auditor-answer-free-text'>{formatFreeTextAnswer(answer.text)}</div>
              {answerWasDecrypted ? <DecryptedAnswerBadge /> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );

  const renderResponseDisclosure = (entry: QuestionnaireResultsDashboardResponseDetail) => (
    Array.isArray(entry.response.answers) && entry.response.answers.length > 0 ? (
      <details className='simple-auditor-response-disclosure'>
        <summary>
          <span>Responses ({entry.response.answers.length})</span>
        </summary>
        <div className='simple-auditor-response-set'>
          {renderAnswerList(entry)}
        </div>
      </details>
    ) : (
      <p className='simple-voter-note'>Answer payload is encrypted or unavailable in public events.</p>
    )
  );

  const renderResponseIdentityWords = (identity: string) => {
    const words = deriveIdentityWords(identity);
    return words ? (
      <span className='simple-identity-words-badge'>
        {words}
      </span>
    ) : null;
  };

  const sessionResponseColumns: ColumnDef<QuestionnaireResultsDashboardResponseDetail>[] = [
    {
      id: "marker",
      header: "Identity marker",
      meta: { className: "is-marker", label: "Identity marker" },
      cell: ({ row }) => {
        const entry = row.original;
        return (
          <div className='simple-session-response-marker-cell'>
            <span className='simple-response-short-id'>{deriveActorDisplayId(entry.response.authorPubkey)}</span>
            <TokenFingerprint
              tokenId={entry.response.authorPubkey}
              compact
              hideMetadata
              fingerprintTitle='Colour ID: a visual fingerprint for checking this submission identity at a glance.'
            />
          </div>
        );
      },
    },
    {
      id: "identity",
      header: "Submitter identity",
      meta: { className: "is-identity", label: "Submitter identity" },
      cell: ({ row }) => (
        <div className='simple-response-identity-cell' title={row.original.response.authorPubkey}>
          {renderResponseIdentityWords(row.original.response.authorPubkey)}
        </div>
      ),
    },
    {
      id: "submitted",
      header: "Submission time",
      meta: { className: "is-time", label: "Submission time" },
      cell: ({ row }) => formatQuestionnaireTime(row.original.response.submittedAt ?? row.original.event.created_at ?? 0),
    },
    {
      id: "responseId",
      header: "Response ID",
      meta: { className: "is-response-id", label: "Response ID" },
      cell: ({ row }) => <span className='simple-session-response-id'>{row.original.response.responseId}</span>,
    },
    {
      id: "answers",
      header: "Answers",
      meta: { className: "is-answers", label: "Answers" },
      cell: ({ row }) => renderResponseDisclosure(row.original),
    },
    {
      id: "status",
      header: "Status",
      meta: { className: "is-status", label: "Status" },
      cell: ({ row }) => {
        const entry = row.original;
        return (
          <>
            <span className={`simple-auditor-status-chip${entry.accepted ? " simple-auditor-status-chip-accepted" : " simple-auditor-status-chip-invalid"}`}>
              {entry.accepted ? "Accepted" : "Invalid"}
            </span>
            {!entry.accepted ? (
              <p className='simple-auditor-invalid-reason'>
                Invalid reason: {formatInvalidReason(entry.rejectionReason)}
              </p>
            ) : null}
          </>
        );
      },
    },
  ];
  const sessionResponseTable = useReactTable({
    data: visibleResponseDetails,
    columns: sessionResponseColumns,
    getCoreRowModel: getCoreRowModel(),
  });
  const questionSummaryContent = filteredQuestionSummaries.length > 0 ? (
    <>
      <div className='simple-auditor-question-grid simple-session-question-grid'>
        {filteredQuestionSummaries.map((summary) => {
          const questionNumber = selectedQuestionNumberById.get(summary.questionId);
          const questionTitle = selectedQuestionById.get(summary.questionId)?.prompt || `Question ${summary.questionId}`;
          const questionResponseCount = acceptedQuestionResponseCountById.get(summary.questionId)
            ?? (publishedTotalsAvailable
              ? getSummaryResponseCount(summary, displayValidCount)
              : getSummaryVisibleResponseCount(summary));
          const pendingSummary = getCompatiblePendingSummary(
            summary,
            pendingLiveQuestionSummaryById.get(summary.questionId) ?? (!publishedTotalsAvailable ? summary : undefined),
          );
          return (
            <article key={`${summary.questionId}:${summary.answerType}`} className='simple-auditor-question-card simple-session-question-card'>
              <div className='simple-auditor-question-card-head'>
                <p className='simple-session-question-number'>Q{questionNumber ?? "?"}</p>
                <p className='simple-auditor-question-response-count'>
                  <span>{formatResponseCount(questionResponseCount)}</span>
                </p>
              </div>
              <div className='simple-auditor-question-card-content'>
                <h3 className='simple-voter-question'>{questionTitle}</h3>
                {summary.answerType === "yes_no" ? (
                  <YesNoSummaryCard
                    summary={summary}
                    pendingSummary={pendingSummary}
                    baseSummaryIncludesPending={baseSummaryIncludesPending}
                  />
                ) : summary.answerType === "multiple_choice" ? (
                  <MultipleChoiceSummaryCard
                    summary={summary}
                    question={selectedQuestionById.get(summary.questionId)}
                    responseCount={questionResponseCount}
                    pendingSummary={pendingSummary}
                    baseSummaryIncludesPending={baseSummaryIncludesPending}
                  />
                ) : summary.answerType === "rank" ? (
                  <RankSummaryCard
                    summary={summary}
                    question={selectedQuestionById.get(summary.questionId)}
                    pendingSummary={pendingSummary}
                    baseSummaryIncludesPending={baseSummaryIncludesPending}
                  />
                ) : (
                  <div className='simple-auditor-free-text-cardlet'>
                    <UiButton
                      icon='view'
                      className='simple-auditor-text-button'
                      onPress={() => setFreeTextViewerQuestionId(summary.questionId)}
                    >
                      View answers
                    </UiButton>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {fallbackQuestionSummaryNote ? (
        <p className='simple-voter-note'>{fallbackQuestionSummaryNote}</p>
      ) : null}
    </>
  ) : effectiveQuestionSummaries.length > 0 && resultSearchQuery.trim() ? (
    <p className='simple-voter-empty'>No result cards match this filter.</p>
  ) : (
    <p className='simple-voter-empty'>{emptyQuestionSummaryText}</p>
  );
  const resultSummary = (
    <div className='simple-session-results-summary' aria-label='Questionnaire result summary'>
      <span><Users aria-hidden='true' /><strong>{loadedTotalCount}</strong><small>Responses</small></span>
      <span><CircleCheck aria-hidden='true' /><strong>{loadedAcceptedCount}</strong><small>Published votes</small></span>
      <span><Activity aria-hidden='true' /><strong>{pendingLiveAcceptedCount}</strong><small>Live votes</small></span>
    </div>
  );
  const submittedVotesContent = questionnaire ? (
    responseDetails.length > 0 ? (
      <>
        <div className={`simple-auditor-submitted-toolbar${isSessionVariant ? " simple-session-submitted-toolbar" : ""}`}>
          {!isSessionVariant ? (
            <div className='simple-auditor-submitted-stat'>
              <p className='simple-auditor-summary-label'>Loaded Responses</p>
              <p className='simple-auditor-score'>{responseDetails.length}</p>
            </div>
          ) : null}
          <div className='simple-auditor-submitted-filter'>
            <UiTextField
              label='Filter submitted votes'
              fieldClassName='simple-auditor-submitted-search-field'
              inputProps={{
                id: "simple-auditor-submitted-search",
                value: voterSearchQuery,
                onChange: (event) => setVoterSearchQuery(event.target.value),
                placeholder: "Search by Submission ID, identity words, full identity, or token...",
              }}
            />
            {hasInvalidResponses ? (
              <UiSwitch
                className='simple-auditor-invalid-toggle'
                isSelected={showInvalidVotes}
                onChange={setShowInvalidVotes}
                label={`Show ${invalidResponseCount} invalid ${invalidResponseCount === 1 ? "vote" : "votes"} only`}
              />
            ) : null}
          </div>
          {responseDecryptControls ? (
            <div className='simple-auditor-submitted-decrypt'>
              {responseDecryptControls}
            </div>
          ) : null}
        </div>
        {filteredResponseDetails.length > 0 ? (
          <div className='simple-auditor-submitted-pager' aria-label='Submitted vote page controls'>
            <p>
              Showing {visibleResponseStart}-{visibleResponseEnd} of {filteredResponseDetails.length}
              {" "}
              <span>Sorted by short ID</span>
            </p>
            {shouldShowSubmittedPager ? (
              <div className='simple-auditor-submitted-pager-actions'>
                <UiButton
                  icon='chevronLeft'
                  className='simple-auditor-pager-button'
                  onPress={() => setSubmittedPageIndex((previous) => Math.max(0, previous - 1))}
                  isDisabled={clampedSubmittedPageIndex <= 0}
                  aria-label='Previous submitted votes'
                >
                  Previous
                </UiButton>
                <UiButton
                  icon='chevronRight'
                  iconPosition='end'
                  className='simple-auditor-pager-button'
                  onPress={() => setSubmittedPageIndex((previous) => Math.min(submittedPageCount - 1, previous + 1))}
                  isDisabled={clampedSubmittedPageIndex >= submittedPageCount - 1}
                  aria-label='Next submitted votes'
                >
                  Next
                </UiButton>
              </div>
            ) : null}
          </div>
        ) : null}
        {isSessionVariant ? (
          <div className='simple-session-table-wrap simple-session-submissions-table'>
            <UiDataTable
              table={sessionResponseTable}
              ariaLabel='Submitted votes'
            />
          </div>
        ) : (
          <ul className='simple-voter-list simple-auditor-result-list'>
            {visibleResponseDetails.map((entry) => (
              <li key={entry.event.id} className='simple-voter-list-item'>
                <div className='simple-auditor-result-row'>
                  <div className='simple-auditor-result-marker'>
                    <div className='simple-auditor-result-marker-label'>
                      <span>{deriveActorDisplayId(entry.response.authorPubkey)}</span>
                    </div>
                    <TokenFingerprint
                      tokenId={entry.response.authorPubkey}
                      compact
                      large
                      hideMetadata
                      fingerprintTitle='Colour ID: a visual fingerprint for checking this submission identity at a glance.'
                    />
                    {!entry.accepted ? (
                      <p className='simple-auditor-status-chip simple-auditor-status-chip-invalid'>
                        Invalid
                      </p>
                    ) : null}
                  </div>
                  <div className='simple-auditor-result-body'>
                    <dl className='simple-auditor-submission-meta'>
                      <div className='simple-auditor-submission-meta-identity'>
                        <dd title={entry.response.authorPubkey}>
                          {renderResponseIdentityWords(entry.response.authorPubkey)}
                        </dd>
                      </div>
                      <div className='simple-auditor-submission-meta-time'>
                        <dt>Submission time</dt>
                        <dd>{formatQuestionnaireTime(entry.response.submittedAt ?? entry.event.created_at ?? 0)}</dd>
                      </div>
                      <div className='simple-auditor-submission-meta-response'>
                        <dt>Response ID</dt>
                        <dd>{entry.response.responseId}</dd>
                      </div>
                    </dl>
                    {!entry.accepted ? (
                      <p className='simple-auditor-invalid-reason'>
                        Invalid reason: {formatInvalidReason(entry.rejectionReason)}
                      </p>
                    ) : null}
                    {renderResponseDisclosure(entry)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {filteredResponseDetails.length === 0 ? (
          <p className='simple-voter-empty'>No voter responses match the current filter.</p>
        ) : null}
      </>
    ) : (
      <p className='simple-voter-empty'>{emptyResponsesText}</p>
    )
  ) : (
    <p className='simple-voter-empty'>{emptyResponseSelectionText}</p>
  );

  return (
    <>
      <section className={`simple-voter-section simple-auditor-panel simple-auditor-results-dashboard${isSessionVariant ? " simple-session-results-dashboard" : ""}`}>
        {isSessionVariant && topControls ? (
          <div className='simple-session-toolbar'>
            {topControls}
          </div>
        ) : null}
        {isSessionVariant ? (
          <div className='simple-session-results-heading'>
          <h2 className='simple-voter-section-title'>{publishedTotalsAvailable ? "Published Results" : "Live Results"}</h2>
            {actions ? <div className='simple-session-results-actions'>{actions}</div> : null}
            <div className='simple-session-live-status' aria-label='Live status'>
              <span className='simple-session-live-status-value'>
                {pendingLiveTotalCount > 0 ? visibleProgressLabel : publishedTotalsAvailable ? publishedProgressLabel : loadedResponsesLabel}
              </span>
              <StackedResultBar
                finalValue={publishedTotalsAvailable ? displayValidCount : 0}
                pendingValue={pendingLiveAcceptedCount}
                maxValue={Math.max(visibleTotalCount, 1)}
              />
            </div>
          </div>
        ) : null}
        {questionnaire ? (
          <>
            {isSessionVariant && questionnaireDescription ? (
              <p className='simple-session-questionnaire-description'>{questionnaireDescription}</p>
            ) : null}
            {isSessionVariant ? resultSummary : null}
            {isSessionVariant ? (
              <div className='simple-session-result-legend' aria-label='Vote status legend'>
                <span><i className='is-submitted' aria-hidden='true' />Published results</span>
                {!publishedTotalsAvailable ? <span><i className='is-live' aria-hidden='true' />Live accepted votes</span> : null}
              </div>
            ) : null}
            {!isSessionVariant && (actions || (canExportResults && onExportResults)) ? (
              <div className='simple-auditor-results-hero'>
                {actions ?? (canExportResults && onExportResults ? (
                  <UiButton
                    icon='export'
                    className='simple-auditor-export-button'
                    onPress={onExportResults}
                  >
                    Export results
                  </UiButton>
                ) : null)}
              </div>
            ) : null}

            {!isSessionVariant ? (
              <AuditorDropdown
                className='simple-auditor-status-grid simple-auditor-summary-island'
                headClassName='simple-auditor-summary-island-head'
                title={(
                  <span className='simple-voter-section-title' role='heading' aria-level={2}>
                    {formatQuestionnaireDisplayId(questionnaire.questionnaireId)}
                  </span>
                )}
              >
                <section className='simple-auditor-status-card'>
                  <dl className='simple-auditor-status-details'>
                    <div className='simple-auditor-status-detail-row'>
                      <span className='simple-auditor-status-icon' aria-hidden='true'><CircleHelp /></span>
                      <div>
                        <dt>Question</dt>
                        <dd>{questionnaire.title}</dd>
                      </div>
                    </div>
                    {questionnaireDescription ? (
                      <div className='simple-auditor-status-detail-row'>
                        <span className='simple-auditor-status-icon' aria-hidden='true'><FileText /></span>
                        <div>
                          <dt>Description</dt>
                          <dd>{questionnaireDescription}</dd>
                        </div>
                      </div>
                    ) : null}
                    <div className='simple-auditor-status-detail-row'>
                      <span className='simple-auditor-status-icon' aria-hidden='true'><CalendarDays /></span>
                      <div>
                        <dt>{publishedAtLabel}</dt>
                        <dd>{formatQuestionnaireTime(publishedAtTime)}</dd>
                      </div>
                    </div>
                    {closingStatus ? (
                      <div className='simple-auditor-status-detail-row'>
                        <span className='simple-auditor-status-icon' aria-hidden='true'><Clock3 /></span>
                        <div>
                          <dt>{closingStatus.heading}</dt>
                          <dd>{closingStatus.label}</dd>
                        </div>
                      </div>
                    ) : null}
                  </dl>
                </section>
                <section className='simple-auditor-status-card simple-auditor-total-card'>
                  <span className='simple-auditor-status-icon' aria-hidden='true'><Users /></span>
                  <p className='simple-auditor-summary-label'>Responses</p>
                  <StackedResultBar
                    finalValue={publishedTotalsAvailable ? displayValidCount : 0}
                    pendingValue={pendingLiveAcceptedCount}
                    maxValue={Math.max(visibleTotalCount, 1)}
                  />
                  <p className='simple-auditor-status-value'>
                    {visibleProgressLabel}
                  </p>
                </section>
                <section className='simple-auditor-status-card simple-auditor-status-card-wide'>
                  <div className='simple-auditor-status-detail-row'>
                    <span className='simple-auditor-status-icon' aria-hidden='true'><UserRound /></span>
                    <div>
                      <p className='simple-auditor-summary-label'>{coordinatorLabel}</p>
                      <div className='simple-auditor-status-value simple-auditor-copy-value'>
                        <span className='simple-auditor-copy-value-text'>{coordinatorText}</span>
                        <button
                          type='button'
                          className='simple-auditor-copy-value-button'
                          aria-label={`Copy ${coordinatorLabel.toLowerCase()}`}
                          onClick={() => {
                            if (typeof navigator !== "undefined" && navigator.clipboard) {
                              void navigator.clipboard.writeText(coordinatorText);
                            }
                          }}
                        >
                          <Copy aria-hidden='true' />
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
                {questionnaire.resultPack?.url ? (
                  <section className='simple-auditor-status-card simple-auditor-status-card-wide'>
                    <div className='simple-auditor-status-detail-row'>
                      <span className='simple-auditor-status-icon' aria-hidden='true'><FileText /></span>
                      <div>
                        <p className='simple-auditor-summary-label'>Result pack</p>
                        <div className='simple-auditor-result-pack-links'>
                          <a href={questionnaire.resultPack.url} target='_blank' rel='noreferrer'>Download</a>
                          {(questionnaire.resultPack.mirrors ?? []).slice(0, 3).map((mirror, index) => (
                            <a key={mirror.url} href={mirror.url} target='_blank' rel='noreferrer'>
                              Mirror {index + 1}
                            </a>
                          ))}
                        </div>
                      </div>
                    </div>
                  </section>
                ) : null}
              </AuditorDropdown>
            ) : null}

            {!isSessionVariant ? (
              <AuditorDropdown
                className='simple-auditor-results-dropdown'
                headClassName='simple-auditor-results-dropdown-head'
                defaultOpen
                title={<span className='simple-voter-section-title simple-auditor-results-subtitle' role='heading' aria-level={2}>Results</span>}
              >
                {resultSummary}
                {effectiveQuestionSummaries.length > 0 ? (
                  <UiTextField
                    label='Filter results'
                    fieldClassName='simple-auditor-results-filter'
                    inputProps={{
                      id: 'simple-auditor-results-search',
                      value: resultSearchQuery,
                      onChange: (event) => setResultSearchQuery(event.target.value),
                      placeholder: 'Search by question, type, or option...',
                    }}
                  />
                ) : null}
                {questionSummaryContent}
              </AuditorDropdown>
            ) : questionSummaryContent}
          </>
        ) : emptySelectionText ? (
          <p className='simple-voter-empty simple-auditor-empty-panel'>{emptySelectionText}</p>
        ) : null}
      </section>

      {showSubmittedVotes ? (
        isSessionVariant ? (
          <section className='simple-voter-section simple-auditor-submissions-section simple-session-submissions-section'>
            <div className='simple-auditor-submissions-header'>
              <h2 className='simple-voter-section-title'>Submitted Votes</h2>
            </div>
            {submittedVotesContent}
          </section>
        ) : (
          <AuditorDropdown
            className='simple-auditor-submissions-section simple-auditor-submissions-dropdown'
            headClassName='simple-auditor-submissions-dropdown-head'
            defaultOpen
            title={<span className='simple-voter-section-title' role='heading' aria-level={2}>Submitted Votes</span>}
          >
            <div className='simple-auditor-submissions-dropdown-body'>
              {submittedVotesContent}
            </div>
          </AuditorDropdown>
        )
      ) : null}

      {freeTextViewerQuestionId && questionnaire ? (
        <section
          className='token-fingerprint-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='Free-text responses'
          onClick={() => setFreeTextViewerQuestionId(null)}
        >
          <UiButton
            icon='cancel'
            className='token-fingerprint-overlay-close'
            onPress={() => setFreeTextViewerQuestionId(null)}
          >
            Close
          </UiButton>
          <div className='token-fingerprint-overlay-card simple-auditor-full-results-card' onClick={(event) => event.stopPropagation()}>
            <h3 className='simple-voter-question'>
              {selectedQuestionById.get(freeTextViewerQuestionId)?.prompt || freeTextViewerQuestionId}
            </h3>
            <ul className='simple-voter-list'>
              {responseDetails
                .filter((entry) => Array.isArray(entry.response.answers))
                .map((entry) => {
                  const freeText = entry.response.answers?.find((answer) => (
                    answer.questionId === freeTextViewerQuestionId && answer.answerType === "free_text"
                  ));
                  if (!freeText || freeText.answerType !== "free_text") {
                    return null;
                  }
                  return (
                    <li key={`${entry.event.id}:free-text`} className='simple-voter-list-item'>
                      <p className='simple-voter-note'>{entry.response.authorPubkey}</p>
                      <div className='simple-auditor-answer-free-text-row'>
                        <p className='simple-voter-question'>{formatFreeTextAnswer(freeText.text)}</p>
                        {isAnswerDecrypted(entry, freeText) ? <DecryptedAnswerBadge /> : null}
                      </div>
                    </li>
                  );
                })
                .filter(Boolean)}
            </ul>
            {!responseDetails.some((entry) => (
              Array.isArray(entry.response.answers)
              && entry.response.answers.some((answer) => answer.questionId === freeTextViewerQuestionId && answer.answerType === "free_text")
            )) ? (
              <p className='simple-voter-empty'>No free-text payloads are publicly available for this question.</p>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}

function isAnswerDecrypted(
  entry: QuestionnaireResultsDashboardResponseDetail,
  answer: QuestionnaireResponseAnswer,
) {
  return (entry.decryptedAnswerQuestionIds ?? []).includes(answer.questionId);
}

function DecryptedAnswerBadge() {
  return (
    <span
      className='simple-auditor-answer-decrypted-badge'
      title='This answer was decrypted locally in this browser.'
    >
      Decrypted
    </span>
  );
}

function PeopleIcon() {
  return (
    <svg
      className='simple-auditor-question-response-icon'
      viewBox='0 0 24 24'
      aria-hidden='true'
      focusable='false'
    >
      <path
        d='M8.5 11.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm7 0a3 3 0 1 1 0-6 3 3 0 0 1 0 6ZM2.75 19c.55-3.08 2.66-5 5.75-5s5.2 1.92 5.75 5H2.75Zm10.85 0a7.33 7.33 0 0 0-1.32-2.95A5.2 5.2 0 0 1 15.5 15c2.65 0 4.46 1.52 4.95 4H13.6Z'
        fill='currentColor'
      />
    </svg>
  );
}

function YesNoSummaryCard({
  summary,
  pendingSummary,
  baseSummaryIncludesPending,
}: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "yes_no" }>;
  pendingSummary: QuestionnaireResultQuestionSummary | null;
  baseSummaryIncludesPending: boolean;
}) {
  const pendingYesNo = pendingSummary?.answerType === "yes_no" ? pendingSummary : null;
  const rows = [
    {
      label: "Yes",
      baseCount: summary.yesCount,
      pendingCount: pendingYesNo?.yesCount ?? 0,
      className: "is-yes",
    },
    {
      label: "No",
      baseCount: summary.noCount,
      pendingCount: pendingYesNo?.noCount ?? 0,
      className: "is-no",
    },
  ].map((row) => ({
    ...row,
    layers: splitLayerValue(row.baseCount, row.pendingCount, baseSummaryIncludesPending),
  }));
  const total = rows.reduce((sum, row) => sum + row.layers.totalValue, 0);
  const sortedRows = [...rows].sort((left, right) => {
    if (right.layers.finalValue !== left.layers.finalValue) {
      return right.layers.finalValue - left.layers.finalValue;
    }
    if (right.layers.pendingValue !== left.layers.pendingValue) {
      return right.layers.pendingValue - left.layers.pendingValue;
    }
    return left.label === "Yes" ? -1 : 1;
  });
  const leadingValue = Math.max(...sortedRows.map((row) => row.layers.totalValue));
  return (
    <div className='simple-auditor-option-bars simple-auditor-boolean-bars'>
      {sortedRows.map((row) => {
        const percent = total > 0 ? (row.layers.totalValue / total) * 100 : 0;
        return (
          <div key={row.label} className={`simple-auditor-option-bar-row simple-auditor-boolean-bar-row ${row.className}${row.layers.totalValue > 0 && row.layers.totalValue === leadingValue ? " is-leading" : ""}`}>
            <div className='simple-auditor-option-bar-label'>
              <span>{row.label}</span>
              <strong>{formatBooleanVoteShare(row.layers.finalValue, row.layers.pendingValue, percent)}</strong>
            </div>
            <StackedResultBar
              finalValue={row.layers.finalValue}
              pendingValue={row.layers.pendingValue}
              maxValue={total}
            />
          </div>
        );
      })}
    </div>
  );
}

function MultipleChoiceSummaryCard({
  summary,
  question,
  responseCount,
  pendingSummary,
  baseSummaryIncludesPending,
}: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "multiple_choice" }>;
  question: QuestionnaireQuestion | undefined;
  responseCount: number;
  pendingSummary: QuestionnaireResultQuestionSummary | null;
  baseSummaryIncludesPending: boolean;
}) {
  const pendingMultipleChoice = pendingSummary?.answerType === "multiple_choice" ? pendingSummary : null;
  const rows = getMultipleChoiceSummaryEntries(summary, question)
    .map(([optionId, baseCount]) => {
      const layers = splitLayerValue(
        baseCount,
        pendingMultipleChoice?.optionCounts[optionId] ?? 0,
        baseSummaryIncludesPending,
      );
      return { optionId, baseCount, layers };
    });
  const maxCount = Math.max(1, ...rows.map((row) => row.layers.totalValue));
  const totalResponses = Math.max(responseCount, ...rows.map((row) => row.layers.totalValue));
  return (
    <div className='simple-auditor-option-bars'>
      {rows
        .map((row) => {
          const label = question?.type === "multiple_choice"
            ? question.options.find((option) => option.optionId === row.optionId)?.label ?? row.optionId
            : row.optionId;
          const percentOfResponses = totalResponses > 0 ? (row.layers.totalValue / totalResponses) * 100 : 0;
          return { label, percentOfResponses, row };
        })
        .sort((left, right) => (
          right.row.layers.finalValue - left.row.layers.finalValue
          || right.row.layers.pendingValue - left.row.layers.pendingValue
          || left.label.localeCompare(right.label)
        ))
        .map(({ label, percentOfResponses, row }) => (
            <div key={row.optionId} className='simple-auditor-option-bar-row'>
              <div className='simple-auditor-option-bar-label'>
                <span>{label}</span>
                <strong>{formatVoteShare(row.layers.finalValue, row.layers.pendingValue, percentOfResponses)}</strong>
              </div>
              <StackedResultBar
                finalValue={row.layers.finalValue}
                pendingValue={row.layers.pendingValue}
                maxValue={maxCount}
              />
            </div>
        ))}
    </div>
  );
}

function RankSummaryCard({
  summary,
  question,
  pendingSummary,
  baseSummaryIncludesPending,
}: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "rank" }>;
  question: QuestionnaireQuestion | undefined;
  pendingSummary: QuestionnaireResultQuestionSummary | null;
  baseSummaryIncludesPending: boolean;
}) {
  const pendingRank = pendingSummary?.answerType === "rank" ? pendingSummary : null;
  const firstChoiceScore = question?.type === "rank" ? String(question.options.length) : "1";
  const rows = getRankSummaryEntries(summary, question)
    .map(([optionId, baseScore]) => {
      const layers = splitLayerValue(
        baseScore,
        pendingRank?.optionScores[optionId] ?? 0,
        baseSummaryIncludesPending,
      );
      const firstChoiceLayers = splitLayerValue(
        summary.rankCounts[optionId]?.[firstChoiceScore] ?? 0,
        pendingRank?.rankCounts[optionId]?.[firstChoiceScore] ?? 0,
        baseSummaryIncludesPending,
      );
      return { optionId, layers, firstChoiceLayers };
    })
    .sort((left, right) => (
      right.layers.finalValue - left.layers.finalValue
      || right.layers.pendingValue - left.layers.pendingValue
      || left.optionId.localeCompare(right.optionId)
    ));
  const bestScore = Math.max(1, ...rows.map((row) => row.layers.totalValue));
  return (
    <div className='simple-auditor-option-bars'>
      {rows
        .map((row, index) => {
          const label = question?.type === "rank"
            ? question.options.find((option) => option.optionId === row.optionId)?.label ?? row.optionId
            : row.optionId;
          return (
            <div key={row.optionId} className='simple-auditor-option-bar-row'>
              <div className='simple-auditor-option-bar-label'>
                <span>{index + 1}. {label}</span>
                <strong>
                  {formatRankShare(
                    row.layers.totalValue,
                    row.firstChoiceLayers.totalValue,
                    row.layers.pendingValue,
                  )}
                </strong>
              </div>
              <StackedResultBar
                finalValue={row.layers.finalValue}
                pendingValue={row.layers.pendingValue}
                maxValue={bestScore}
                minimumPercent={8}
              />
            </div>
          );
        })}
    </div>
  );
}

function splitLayerValue(baseValue: number, pendingValue: number, baseIncludesPending: boolean) {
  const normalisedBaseValue = Math.max(0, Number(baseValue) || 0);
  const normalisedPendingValue = Math.max(0, Number(pendingValue) || 0);
  const finalValue = baseIncludesPending
    ? Math.max(0, normalisedBaseValue - normalisedPendingValue)
    : normalisedBaseValue;
  const livePendingValue = baseIncludesPending
    ? Math.min(normalisedBaseValue, normalisedPendingValue)
    : normalisedPendingValue;
  return {
    finalValue,
    pendingValue: livePendingValue,
    totalValue: finalValue + livePendingValue,
  };
}

function StackedResultBar({
  finalValue,
  pendingValue,
  maxValue,
  minimumPercent = 4,
}: {
  finalValue: number;
  pendingValue: number;
  maxValue: number;
  minimumPercent?: number;
}) {
  const final = Math.max(0, finalValue);
  const pending = Math.max(0, pendingValue);
  const total = final + pending;
  const totalWidth = total > 0 && maxValue > 0
    ? Math.min(100, Math.max(minimumPercent, (total / maxValue) * 100))
    : 0;
  const finalWidth = total > 0 ? (totalWidth * final) / total : 0;
  const pendingWidth = total > 0 ? totalWidth - finalWidth : 0;
  return (
    <div
      className={`simple-auditor-results-progress simple-auditor-results-progress-stacked${pending > 0 ? " has-live-pending" : ""}`}
      aria-hidden='true'
    >
      {finalWidth > 0 ? (
        <span className='simple-auditor-results-progress-final' style={{ width: `${finalWidth}%` }} />
      ) : null}
      {pendingWidth > 0 ? (
        <span className='simple-auditor-results-progress-live' style={{ width: `${pendingWidth}%` }} />
      ) : null}
    </div>
  );
}

function formatQuestionnaireTime(unix: number | null | undefined) {
  if (!unix) {
    return "Not set";
  }
  return new Date(unix * 1000).toLocaleString();
}

function formatFreeTextAnswer(text: string) {
  return text || "(empty)";
}

function formatVoteShare(finalCount: number, liveCount: number, percent: number) {
  const total = finalCount + liveCount;
  return `${percent.toFixed(0)}% (${total})${liveCount > 0 ? ` · ${liveCount} live` : ""}`;
}

function formatBooleanVoteShare(finalCount: number, liveCount: number, percent: number) {
  return formatVoteShare(finalCount, liveCount, percent);
}

function formatRankShare(score: number, firstChoices: number, livePendingScore: number) {
  return `${score} points · ${firstChoices} first${livePendingScore > 0 ? ` · ${livePendingScore} live` : ""}`;
}

function formatResponseCount(count: number) {
  return `${count} response${count === 1 ? "" : "s"}`;
}

function questionSummaryMatchesSearch(
  summary: QuestionnaireResultQuestionSummary,
  question: QuestionnaireQuestion | undefined,
  searchQuery: string,
) {
  const query = searchQuery.trim().toLowerCase();
  if (!query) {
    return true;
  }
  const values = [
    summary.questionId,
    summary.answerType,
    summary.answerType.replaceAll("_", " "),
    question?.prompt,
    question?.type,
    ...(question && "options" in question ? question.options.flatMap((option) => [option.optionId, option.label]) : []),
  ];
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function buildLoadedQuestionSummaries(
  questions: QuestionnaireQuestion[],
  acceptedResponses: QuestionnaireResultsDashboardResponseDetail[],
): QuestionnaireResultQuestionSummary[] {
  return questions.map((question): QuestionnaireResultQuestionSummary => {
    if (question.type === "yes_no") {
      let yesCount = 0;
      let noCount = 0;
      for (const entry of acceptedResponses) {
        const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
        if (answer?.answerType !== "yes_no") {
          continue;
        }
        if (answer.value) {
          yesCount += 1;
        } else {
          noCount += 1;
        }
      }
      return {
        questionId: question.questionId,
        answerType: "yes_no",
        yesCount,
        noCount,
      };
    }

    if (question.type === "multiple_choice") {
      const optionCounts = Object.fromEntries(question.options.map((option) => [option.optionId, 0]));
      for (const entry of acceptedResponses) {
        const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
        if (answer?.answerType !== "multiple_choice") {
          continue;
        }
        for (const optionId of answer.selectedOptionIds) {
          if (Object.prototype.hasOwnProperty.call(optionCounts, optionId)) {
            optionCounts[optionId] += 1;
          }
        }
      }
      return {
        questionId: question.questionId,
        answerType: "multiple_choice",
        optionCounts,
      };
    }

    if (question.type === "rank") {
      const optionScores = Object.fromEntries(question.options.map((option) => [option.optionId, 0]));
      const rankCounts: Record<string, Record<string, number>> = Object.fromEntries(
        question.options.map((option) => [option.optionId, {}]),
      );
      let blankResponseCount = 0;
      for (const entry of acceptedResponses) {
        const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
        const rankedOptionIds = answer?.answerType === "rank"
          ? normaliseRankedOptionIds(question, answer.rankedOptionIds)
          : [];
        if (rankedOptionIds.length === 0) {
          blankResponseCount += 1;
        }
        const responseScores = calculateRankQuestionScores(question, rankedOptionIds);
        for (const [optionId, score] of Object.entries(responseScores)) {
          optionScores[optionId] = (optionScores[optionId] ?? 0) + score;
          const scoreKey = String(score);
          rankCounts[optionId][scoreKey] = (rankCounts[optionId][scoreKey] ?? 0) + 1;
        }
      }
      return {
        questionId: question.questionId,
        answerType: "rank",
        optionScores,
        rankCounts,
        responseCount: acceptedResponses.length,
        blankResponseCount,
      };
    }

    let freeTextCount = 0;
    for (const entry of acceptedResponses) {
      const answer = entry.response.answers?.find((candidate) => candidate.questionId === question.questionId);
      if (answer?.answerType === "free_text" && answer.text.trim()) {
        freeTextCount += 1;
      }
    }
    return {
      questionId: question.questionId,
      answerType: "free_text",
      freeTextCount,
    };
  });
}

function buildPendingProvisionalQuestionSummaries(
  questions: QuestionnaireQuestion[],
  provisionalResponses: QuestionnaireResultsDashboardResponseDetail[],
  acceptedLatestAtByQuestionId: Map<string, number>,
) {
  const summaries = new Map<string, QuestionnaireResultQuestionSummary>();
  for (const question of questions) {
    const latestAcceptedAt = acceptedLatestAtByQuestionId.get(question.questionId) ?? 0;
    const candidateResponses = provisionalResponses
      .filter((entry) => (
        entry.accepted
        && Array.isArray(entry.response.answers)
        && entry.response.answers.some((answer) => answer.questionId === question.questionId)
      ))
      .filter((entry) => {
        if (latestAcceptedAt <= 0) {
          return true;
        }
        const eventTime = Number(entry.event.created_at ?? entry.response.submittedAt ?? 0);
        const submittedAt = Number(entry.response.submittedAt ?? 0);
        return Math.max(eventTime, submittedAt) > latestAcceptedAt;
      });
    const latestByAnonymousAuthor = new Map<string, QuestionnaireResultsDashboardResponseDetail>();
    for (const entry of candidateResponses) {
      const key = entry.response.authorPubkey.trim() || entry.response.responseId;
      const existing = latestByAnonymousAuthor.get(key);
      const entryTime = Number(entry.event.created_at ?? entry.response.submittedAt ?? 0);
      const existingTime = existing ? Number(existing.event.created_at ?? existing.response.submittedAt ?? 0) : -1;
      if (!existing || entryTime >= existingTime) {
        latestByAnonymousAuthor.set(key, entry);
      }
    }
    const latestCandidateResponses = [...latestByAnonymousAuthor.values()]
      .sort((left, right) => (
        Number(right.event.created_at ?? right.response.submittedAt ?? 0)
        - Number(left.event.created_at ?? left.response.submittedAt ?? 0)
      ));
    const pendingCount = latestCandidateResponses.length;
    if (pendingCount <= 0) {
      continue;
    }
    const pendingResponses = latestCandidateResponses.slice(0, pendingCount).map((entry) => ({
      ...entry,
      response: {
        ...entry.response,
        answers: entry.response.answers?.filter((answer) => answer.questionId === question.questionId) ?? [],
      },
    }));
    const summary = buildLoadedQuestionSummaries([question], pendingResponses)[0];
    if (summary && questionSummaryHasVisibleValue(summary)) {
      summaries.set(question.questionId, summary);
    }
  }
  return summaries;
}

function getCompatiblePendingSummary(
  summary: QuestionnaireResultQuestionSummary,
  pendingSummary: QuestionnaireResultQuestionSummary | undefined,
): QuestionnaireResultQuestionSummary | null {
  if (!pendingSummary || pendingSummary.answerType !== summary.answerType) {
    return null;
  }
  return pendingSummary;
}

function addQuestionSummaries(
  left: QuestionnaireResultQuestionSummary | undefined,
  right: QuestionnaireResultQuestionSummary,
): QuestionnaireResultQuestionSummary {
  if (!left || left.answerType !== right.answerType || left.questionId !== right.questionId) {
    return right;
  }
  if (left.answerType === "yes_no" && right.answerType === "yes_no") {
    return {
      questionId: left.questionId,
      answerType: "yes_no",
      yesCount: left.yesCount + right.yesCount,
      noCount: left.noCount + right.noCount,
    };
  }
  if (left.answerType === "multiple_choice" && right.answerType === "multiple_choice") {
    const optionIds = new Set([...Object.keys(left.optionCounts), ...Object.keys(right.optionCounts)]);
    return {
      questionId: left.questionId,
      answerType: "multiple_choice",
      optionCounts: Object.fromEntries([...optionIds].map((optionId) => [
        optionId,
        (left.optionCounts[optionId] ?? 0) + (right.optionCounts[optionId] ?? 0),
      ])),
    };
  }
  if (left.answerType === "rank" && right.answerType === "rank") {
    const optionIds = new Set([...Object.keys(left.optionScores), ...Object.keys(right.optionScores)]);
    return {
      questionId: left.questionId,
      answerType: "rank",
      optionScores: Object.fromEntries([...optionIds].map((optionId) => [
        optionId,
        (left.optionScores[optionId] ?? 0) + (right.optionScores[optionId] ?? 0),
      ])),
      rankCounts: mergeRankCounts(left.rankCounts, right.rankCounts, (a, b) => a + b),
      responseCount: left.responseCount + right.responseCount,
      blankResponseCount: left.blankResponseCount + right.blankResponseCount,
    };
  }
  if (left.answerType === "free_text" && right.answerType === "free_text") {
    return {
      questionId: left.questionId,
      answerType: "free_text",
      freeTextCount: left.freeTextCount + right.freeTextCount,
    };
  }
  return right;
}

function mergeRankCounts(
  left: Record<string, Record<string, number>>,
  right: Record<string, Record<string, number>>,
  merge: (left: number, right: number) => number,
) {
  const optionIds = new Set([...Object.keys(left), ...Object.keys(right)]);
  return Object.fromEntries([...optionIds].map((optionId) => {
    const scoreIds = new Set([
      ...Object.keys(left[optionId] ?? {}),
      ...Object.keys(right[optionId] ?? {}),
    ]);
    return [
      optionId,
      Object.fromEntries([...scoreIds].map((scoreId) => [
        scoreId,
        merge(left[optionId]?.[scoreId] ?? 0, right[optionId]?.[scoreId] ?? 0),
      ])),
    ];
  }));
}

function questionSummaryHasVisibleValue(summary: QuestionnaireResultQuestionSummary) {
  return getSummaryVisibleResponseCount(summary) > 0
    || (summary.answerType === "rank" && Object.values(summary.optionScores).some((score) => score > 0));
}

function sumQuestionSummaryResponseCounts(summaries: QuestionnaireResultQuestionSummary[]) {
  return summaries.reduce((sum, summary) => sum + getSummaryVisibleResponseCount(summary), 0);
}

function getSummaryVisibleResponseCount(summary: QuestionnaireResultQuestionSummary) {
  if (summary.answerType === "yes_no") {
    return summary.yesCount + summary.noCount;
  }
  if (summary.answerType === "multiple_choice") {
    return Math.max(0, ...Object.values(summary.optionCounts));
  }
  if (summary.answerType === "rank") {
    return summary.responseCount;
  }
  return summary.freeTextCount;
}

function getSummaryResponseCount(summary: QuestionnaireResultQuestionSummary, displayValidCount: number) {
  if (summary.answerType === "yes_no") {
    return summary.yesCount + summary.noCount;
  }
  if (summary.answerType === "multiple_choice") {
    return displayValidCount;
  }
  if (summary.answerType === "rank") {
    return summary.responseCount;
  }
  return summary.freeTextCount;
}

function formatInvalidReason(reason: string | null | undefined) {
  const normalised = reason?.trim() ?? "";
  if (!normalised) {
    return "No reason published";
  }
  const labels: Record<string, string> = {
    duplicate_nullifier: "Duplicate token spend",
    duplicate_response: "Duplicate response",
    invalid_token_proof: "Invalid token proof",
    invalid_payload_shape: "Invalid response payload",
    questionnaire_closed: "Questionnaire closed",
  };
  return labels[normalised] ?? normalised.replaceAll("_", " ");
}

const QUESTIONNAIRE_TIMER_DISABLED_CLOSE_SECONDS = 5_256_000 * 60;

function hasScheduledClose(questionnaire: QuestionnaireResultsDashboardQuestionnaire | null) {
  const closeAt = questionnaire?.closeAt ?? null;
  if (!closeAt || !Number.isFinite(closeAt)) {
    return false;
  }
  const startsAt = questionnaire?.openAt ?? questionnaire?.createdAt ?? null;
  if (startsAt && Number.isFinite(startsAt)) {
    return closeAt - startsAt < QUESTIONNAIRE_TIMER_DISABLED_CLOSE_SECONDS;
  }
  return true;
}

function getClosingStatus(questionnaire: QuestionnaireResultsDashboardQuestionnaire | null) {
  const isClosed = questionnaire?.state === "closed" || questionnaire?.state === "results_published";
  const heading = isClosed ? "Closed" : "Closing";
  if (!questionnaire) {
    return null;
  }
  if (isClosed) {
    const closedAt = questionnaire.closedAt ?? questionnaire.resultPublishedAt ?? questionnaire.closeAt ?? null;
    return { heading, label: closedAt ? formatQuestionnaireTime(closedAt) : "Closed" };
  }
  if (!hasScheduledClose(questionnaire)) {
    return null;
  }
  return { heading, label: formatQuestionnaireTime(questionnaire.closeAt) };
}

function getMultipleChoiceSummaryEntries(
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "multiple_choice" }>,
  question: QuestionnaireQuestion | undefined,
) {
  if (question?.type === "multiple_choice") {
    return question.options.map((option) => [option.optionId, summary.optionCounts[option.optionId] ?? 0] as const);
  }
  return Object.entries(summary.optionCounts);
}

function getRankSummaryEntries(
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "rank" }>,
  question: QuestionnaireQuestion | undefined,
) {
  const entries = question?.type === "rank"
    ? question.options.map((option) => [option.optionId, summary.optionScores[option.optionId] ?? 0] as const)
    : Object.entries(summary.optionScores);
  return [...entries].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

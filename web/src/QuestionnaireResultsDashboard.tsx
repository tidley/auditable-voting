import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";
import { deriveIdentityWords } from "./identityWords";
import { UiButton, UiDataTable, UiSwitch, UiTextField } from "./ui/DesignLayer";
import type {
  QuestionnaireQuestion,
  QuestionnaireResponseAnswer,
  QuestionnaireResultQuestionSummary,
} from "./questionnaireProtocol";

const SUBMITTED_VOTES_PAGE_SIZE = 100;

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
  const invalidResponseCount = useMemo(
    () => responseDetails.filter((entry) => !entry.accepted).length,
    [responseDetails],
  );
  const hasInvalidResponses = invalidResponseCount > 0;
  const loadedAcceptedCount = loadedValidCount ?? responseDetails.filter((entry) => entry.accepted).length;
  const loadedRejectedCount = loadedInvalidCount ?? invalidResponseCount;
  const loadedTotalCount = loadedAcceptedCount + loadedRejectedCount;

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
  const loadedTotalLabel = `Loaded: ${loadedTotalCount} (${loadedTotalPercent}%)`;
  const loadedAcceptedLabel = `Accepted: ${loadedAcceptedCount} (${loadedAcceptedPercent}%)`;
  const loadedResponsesLabel = `${loadedTotalLabel} · ${loadedAcceptedLabel}${loadedRejectedCount > 0 ? ` · Invalid: ${loadedRejectedCount}` : ""}`;
  const closingStatus = getClosingStatus(questionnaire);
  const questionnaireDescription = questionnaire?.description?.trim() ?? "";
  const isSessionVariant = variant === "session";

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
            <h2 className='simple-voter-section-title'>Live Results</h2>
            <div className='simple-session-live-status' aria-label='Live status'>
              <span className='simple-session-live-status-value'>
                {publishedTotalsAvailable ? publishedProgressLabel : loadedResponsesLabel}
              </span>
              {publishedTotalsAvailable ? (
                <div className='simple-auditor-results-progress' aria-hidden='true'>
                  <span style={{ width: `${Math.min(100, Math.max(0, displayValidityPercentNumber))}%` }} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
        {questionnaire ? (
          <>
            {isSessionVariant && questionnaireDescription ? (
              <p className='simple-session-questionnaire-description'>{questionnaireDescription}</p>
            ) : null}
            {!isSessionVariant ? (
              <div className='simple-auditor-results-hero'>
                <div className='simple-auditor-results-title-block'>
                  <p className='simple-auditor-breadcrumb'>Questionnaires / {questionnaire.questionnaireId}</p>
                  <h2 className='simple-voter-section-title'>Questionnaire Results</h2>
                </div>
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
              <div className='simple-auditor-status-grid'>
                <article className='simple-auditor-status-card'>
                  <p className='simple-auditor-summary-label'>Questionnaire</p>
                  <dl className='simple-auditor-status-details'>
                    <div>
                      <dt>ID</dt>
                      <dd>{questionnaire.questionnaireId}</dd>
                    </div>
                    <div>
                      <dt>Question</dt>
                      <dd>{questionnaire.title}</dd>
                    </div>
                  </dl>
                </article>
                <article className='simple-auditor-status-card'>
                  <p className='simple-auditor-summary-label'>{publishedTotalsAvailable ? "Published total" : "Loaded responses"}</p>
                  <p className='simple-auditor-status-value'>
                    {publishedTotalsAvailable ? publishedProgressLabel : `${loadedTotalCount} loaded`}
                  </p>
                  {publishedTotalsAvailable ? (
                    <div className='simple-auditor-results-progress' aria-hidden='true'>
                      <span style={{ width: `${Math.min(100, Math.max(0, displayValidityPercentNumber))}%` }} />
                    </div>
                  ) : null}
                  <p className='simple-voter-note'>
                    {publishedTotalsAvailable
                      ? (
                        <>
                          {loadedTotalLabel}
                          <br />
                          {loadedAcceptedLabel}
                          {loadedRejectedCount > 0 ? (
                            <>
                              <br />
                              Invalid: {loadedRejectedCount}
                            </>
                          ) : null}
                        </>
                      )
                      : `${loadedAcceptedLabel}${loadedRejectedCount > 0 ? `; Invalid: ${loadedRejectedCount}` : ""}.`}
                  </p>
                </article>
                <article className='simple-auditor-status-card'>
                  <p className='simple-auditor-summary-label'>Published / Closed</p>
                  <dl className='simple-auditor-status-details'>
                    <div>
                      <dt>{publishedAtLabel}</dt>
                      <dd>{formatQuestionnaireTime(publishedAtTime)}</dd>
                    </div>
                    <div>
                      <dt>{closingStatus.heading}</dt>
                      <dd>{closingStatus.label}</dd>
                    </div>
                  </dl>
                </article>
                {questionnaireDescription ? (
                  <article className='simple-auditor-status-card simple-auditor-status-card-wide simple-auditor-description-card'>
                    <p className='simple-auditor-summary-label'>Description</p>
                    <p className='simple-auditor-description-text'>{questionnaireDescription}</p>
                  </article>
                ) : null}
                <article className='simple-auditor-status-card simple-auditor-status-card-wide'>
                  <p className='simple-auditor-summary-label'>{coordinatorLabel}</p>
                  <p className='simple-auditor-status-value'>{coordinatorText}</p>
                </article>
              </div>
            ) : null}

            {questionSummaries.length > 0 ? (
              <>
                <div className={`simple-auditor-question-grid${isSessionVariant ? " simple-session-question-grid" : ""}`}>
                  {questionSummaries.map((summary) => {
                    const questionNumber = selectedQuestionNumberById.get(summary.questionId);
                    const questionTitle = selectedQuestionById.get(summary.questionId)?.prompt || `Question ${summary.questionId}`;
                    const questionResponseCount = acceptedQuestionResponseCountById.get(summary.questionId)
                      ?? getSummaryResponseCount(summary, displayValidCount);
                    return (
                      <article key={`${summary.questionId}:${summary.answerType}`} className='simple-auditor-question-card'>
                        <div className='simple-auditor-question-card-head'>
                          <div>
                            <h3 className='simple-voter-question'>
                              {questionNumber ? `Q${questionNumber}. ` : ""}
                              {questionTitle}
                            </h3>
                            <p className='simple-auditor-question-response-count'>
                              <PeopleIcon />
                              <span>{formatResponseCount(questionResponseCount)}</span>
                            </p>
                          </div>
                        </div>
                        {summary.answerType === "yes_no" ? (
                          <YesNoSummaryCard summary={summary} />
                        ) : summary.answerType === "multiple_choice" ? (
                          <MultipleChoiceSummaryCard
                            summary={summary}
                            question={selectedQuestionById.get(summary.questionId)}
                            responseCount={questionResponseCount}
                          />
                        ) : summary.answerType === "rank" ? (
                          <RankSummaryCard
                            summary={summary}
                            question={selectedQuestionById.get(summary.questionId)}
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
                      </article>
                    );
                  })}
                </div>
                {fallbackQuestionSummaryNote ? (
                  <p className='simple-voter-note'>{fallbackQuestionSummaryNote}</p>
                ) : null}
              </>
            ) : (
              <p className='simple-voter-empty'>{emptyQuestionSummaryText}</p>
            )}
          </>
        ) : emptySelectionText ? (
          <p className='simple-voter-empty'>{emptySelectionText}</p>
        ) : null}
      </section>

      {showSubmittedVotes ? (
        <section className={`simple-voter-section simple-auditor-submissions-section${isSessionVariant ? " simple-session-submissions-section" : ""}`}>
          <div className='simple-auditor-submissions-header'>
            <h2 className='simple-voter-section-title'>Submitted Votes</h2>
          </div>
          {questionnaire ? (
            responseDetails.length > 0 ? (
              <>
                <div className={`simple-auditor-submitted-toolbar${isSessionVariant ? " simple-session-submitted-toolbar" : ""}`}>
                  {!isSessionVariant ? (
                    <div className='simple-auditor-submitted-stat'>
                      <p className='simple-auditor-summary-label'>Loaded responses</p>
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
          )}
        </section>
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

function YesNoSummaryCard({ summary }: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "yes_no" }>;
}) {
  const total = summary.yesCount + summary.noCount;
  const rows = [
    {
      label: "Yes",
      count: summary.yesCount,
      className: "is-yes",
    },
    {
      label: "No",
      count: summary.noCount,
      className: "is-no",
    },
  ].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return left.label === "Yes" ? -1 : 1;
  });
  return (
    <div className='simple-auditor-option-bars simple-auditor-boolean-bars'>
      {rows.map((row) => {
        const percent = total > 0 ? (row.count / total) * 100 : 0;
        return (
          <div key={row.label} className={`simple-auditor-option-bar-row simple-auditor-boolean-bar-row ${row.className}`}>
            <div className='simple-auditor-option-bar-label'>
              <span>{row.label}</span>
              <strong>{formatBooleanVoteShare(row.count, percent)}</strong>
            </div>
            <div className='simple-auditor-results-progress' aria-hidden='true'>
              <span style={{ width: row.count > 0 ? `${Math.max(4, percent)}%` : "0%" }} />
            </div>
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
}: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "multiple_choice" }>;
  question: QuestionnaireQuestion | undefined;
  responseCount: number;
}) {
  return (
    <div className='simple-auditor-option-bars'>
      {getMultipleChoiceSummaryEntries(summary, question)
        .map(([optionId, count]) => {
          const label = question?.type === "multiple_choice"
            ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
            : optionId;
          const maxCount = Math.max(1, ...Object.values(summary.optionCounts));
          const percentOfResponses = responseCount > 0 ? (count / responseCount) * 100 : 0;
          return (
            <div key={optionId} className='simple-auditor-option-bar-row'>
              <div className='simple-auditor-option-bar-label'>
                <span>{label}</span>
                <strong>{formatVoteShare(count, percentOfResponses)}</strong>
              </div>
              <div className='simple-auditor-results-progress' aria-hidden='true'>
                <span style={{ width: count > 0 ? `${Math.max(4, (count / maxCount) * 100)}%` : "0%" }} />
              </div>
            </div>
          );
        })}
    </div>
  );
}

function RankSummaryCard({
  summary,
  question,
}: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "rank" }>;
  question: QuestionnaireQuestion | undefined;
}) {
  return (
    <div className='simple-auditor-option-bars'>
      {getRankSummaryEntries(summary, question)
        .map(([optionId, score], index, rows) => {
          const label = question?.type === "rank"
            ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
            : optionId;
          const bestScore = Math.max(0, ...rows.map(([, entryScore]) => entryScore));
          const width = score > 0 && bestScore > 0 ? `${Math.max(8, (score / bestScore) * 100)}%` : "0%";
          const firstChoiceScore = question?.type === "rank" ? String(question.options.length) : "1";
          const firstChoices = summary.rankCounts[optionId]?.[firstChoiceScore] ?? 0;
          return (
            <div key={optionId} className='simple-auditor-option-bar-row'>
              <div className='simple-auditor-option-bar-label'>
                <span>{index + 1}. {label}</span>
                <strong>{score} points · {firstChoices} first</strong>
              </div>
              <div className='simple-auditor-results-progress' aria-hidden='true'>
                <span style={{ width }} />
              </div>
            </div>
          );
        })}
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

function formatVoteShare(count: number, percent: number) {
  return `${percent.toFixed(0)}% ${count} ${count === 1 ? "VOTE" : "VOTES"}`;
}

function formatBooleanVoteShare(count: number, percent: number) {
  return formatVoteShare(count, percent);
}

function formatResponseCount(count: number) {
  return `${count} response${count === 1 ? "" : "s"}`;
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
    return { heading, label: "Not set" };
  }
  if (isClosed) {
    const closedAt = questionnaire.closedAt ?? questionnaire.resultPublishedAt ?? questionnaire.closeAt ?? null;
    return { heading, label: closedAt ? formatQuestionnaireTime(closedAt) : "Closed" };
  }
  if (!hasScheduledClose(questionnaire)) {
    return { heading, label: "No closing time" };
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

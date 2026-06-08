import { useEffect, useMemo, useState, type ReactNode } from "react";
import TokenFingerprint from "./TokenFingerprint";
import { deriveActorDisplayId } from "./actorDisplay";
import type {
  QuestionnaireQuestion,
  QuestionnaireResponseAnswer,
  QuestionnaireResultQuestionSummary,
} from "./questionnaireProtocol";

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
  response: {
    responseId: string;
    authorPubkey: string;
    submittedAt?: number | null;
    tokenNullifier?: string | null;
    answers?: QuestionnaireResponseAnswer[];
  };
};

type QuestionnaireResultsDashboardProps = {
  questionnaire: QuestionnaireResultsDashboardQuestionnaire | null;
  questionSummaries: QuestionnaireResultQuestionSummary[];
  responseDetails: QuestionnaireResultsDashboardResponseDetail[];
  displayValidCount: number;
  displayInvalidCount?: number;
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

export default function QuestionnaireResultsDashboard({
  questionnaire,
  questionSummaries,
  responseDetails,
  displayValidCount,
  displayInvalidCount = responseDetails.filter((entry) => !entry.accepted).length,
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
  const [freeTextViewerQuestionId, setFreeTextViewerQuestionId] = useState<string | null>(null);

  const selectedQuestionById = useMemo(
    () => new Map((questionnaire?.questions ?? []).map((question) => [question.questionId, question])),
    [questionnaire?.questions],
  );
  const selectedQuestionNumberById = useMemo(
    () => new Map((questionnaire?.questions ?? []).map((question, index) => [question.questionId, index + 1])),
    [questionnaire?.questions],
  );
  const invalidResponseCount = useMemo(
    () => responseDetails.filter((entry) => !entry.accepted).length,
    [responseDetails],
  );
  const hasInvalidResponses = invalidResponseCount > 0;

  useEffect(() => {
    if (!hasInvalidResponses && showInvalidVotes) {
      setShowInvalidVotes(false);
    }
  }, [hasInvalidResponses, showInvalidVotes]);

  const filteredResponseDetails = useMemo(() => {
    const visibilityFiltered = showInvalidVotes
      ? responseDetails.filter((entry) => !entry.accepted)
      : responseDetails.filter((entry) => entry.accepted);
    const query = voterSearchQuery.trim().toLowerCase();
    if (!query) {
      return visibilityFiltered;
    }
    return visibilityFiltered.filter((entry) => (
      entry.response.authorPubkey.toLowerCase().includes(query)
      || entry.response.responseId.toLowerCase().includes(query)
      || (entry.response.tokenNullifier ?? "").toLowerCase().includes(query)
      || (entry.rejectionReason ?? "").toLowerCase().includes(query)
    ));
  }, [responseDetails, showInvalidVotes, voterSearchQuery]);

  const displayTotalCount = Math.max(0, displayValidCount + displayInvalidCount);
  const displayValidityPercent = displayTotalCount > 0
    ? ((displayValidCount / displayTotalCount) * 100).toFixed(1)
    : "0.0";
  const displayValidityPercentNumber = Number(displayValidityPercent);
  const displayValidityPercentLabel = displayTotalCount > 0
    ? `${Math.round(displayValidityPercentNumber)}%`
    : "0%";
  const closingStatus = getClosingStatus(questionnaire);
  const questionnaireDescription = questionnaire?.description?.trim() ?? "";

  return (
    <>
      <section className='simple-voter-section simple-auditor-panel simple-auditor-results-dashboard'>
        {questionnaire ? (
          <>
            <div className='simple-auditor-results-hero'>
              <div className='simple-auditor-results-title-block'>
                <p className='simple-auditor-breadcrumb'>Questionnaires / {questionnaire.questionnaireId}</p>
                <h2 className='simple-voter-section-title'>Questionnaire Results</h2>
              </div>
              {actions ?? (canExportResults && onExportResults ? (
                <button
                  type='button'
                  className='simple-voter-secondary simple-auditor-export-button'
                  onClick={onExportResults}
                >
                  Export results
                </button>
              ) : null)}
            </div>

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
                <p className='simple-auditor-summary-label'>Progress</p>
                <p className='simple-auditor-status-value'>{displayValidCount}/{displayTotalCount || 0} accepted ({displayValidityPercentLabel})</p>
                <div className='simple-auditor-results-progress' aria-hidden='true'>
                  <span style={{ width: `${Math.min(100, Math.max(0, displayValidityPercentNumber))}%` }} />
                </div>
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
                <p className='simple-auditor-summary-label'>Organiser</p>
                <p className='simple-auditor-status-value'>{coordinatorText}</p>
              </article>
            </div>

            {questionSummaries.length > 0 ? (
              <>
                <div className='simple-auditor-question-grid'>
                  {questionSummaries.map((summary) => {
                    const questionNumber = selectedQuestionNumberById.get(summary.questionId);
                    const questionTitle = selectedQuestionById.get(summary.questionId)?.prompt || `Question ${summary.questionId}`;
                    return (
                      <article key={`${summary.questionId}:${summary.answerType}`} className='simple-auditor-question-card'>
                        <div className='simple-auditor-question-card-head'>
                          <div>
                            <h3 className='simple-voter-question'>
                              {questionNumber ? `Q${questionNumber}. ` : ""}
                              {questionTitle}
                            </h3>
                          </div>
                        </div>
                        {summary.answerType === "yes_no" ? (
                          <YesNoSummaryCard summary={summary} />
                        ) : summary.answerType === "multiple_choice" ? (
                          <MultipleChoiceSummaryCard
                            summary={summary}
                            question={selectedQuestionById.get(summary.questionId)}
                            displayValidCount={displayValidCount}
                          />
                        ) : summary.answerType === "rank" ? (
                          <RankSummaryCard
                            summary={summary}
                            question={selectedQuestionById.get(summary.questionId)}
                          />
                        ) : (
                          <div className='simple-auditor-free-text-cardlet'>
                            <div>
                              <p className='simple-voter-question'>{summary.freeTextCount} response{summary.freeTextCount === 1 ? "" : "s"} collected</p>
                            </div>
                            <button
                              type='button'
                              className='simple-voter-secondary simple-auditor-text-button'
                              onClick={() => setFreeTextViewerQuestionId(summary.questionId)}
                            >
                              View answers
                            </button>
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
        ) : (
          <p className='simple-voter-empty'>{emptySelectionText}</p>
        )}
      </section>

      <section className='simple-voter-section simple-auditor-submissions-section'>
        <div className='simple-auditor-submissions-header'>
          <h2 className='simple-voter-section-title'>Submitted Votes</h2>
        </div>
        {questionnaire ? (
          responseDetails.length > 0 ? (
            <>
              <div className='simple-auditor-submitted-toolbar'>
                <div className='simple-auditor-submitted-stat'>
                  <p className='simple-auditor-summary-label'>Total responses</p>
                  <p className='simple-auditor-score'>{responseDetails.length}</p>
                </div>
                <div className='simple-auditor-submitted-filter'>
                  <label className='simple-voter-label' htmlFor='simple-auditor-submitted-search'>Filter by voter ID</label>
                  <input
                    id='simple-auditor-submitted-search'
                    className='simple-voter-input'
                    value={voterSearchQuery}
                    onChange={(event) => setVoterSearchQuery(event.target.value)}
                    placeholder='Search by voter npub, response ID, or token...'
                  />
                  {hasInvalidResponses ? (
                    <label className='simple-voter-note simple-auditor-invalid-toggle'>
                      <input
                        type='checkbox'
                        checked={showInvalidVotes}
                        onChange={(event) => setShowInvalidVotes(event.target.checked)}
                      />
                      {" "}
                      Show {invalidResponseCount} invalid {invalidResponseCount === 1 ? "vote" : "votes"} only
                    </label>
                  ) : null}
                </div>
                {responseDecryptControls ? (
                  <div className='simple-auditor-submitted-decrypt'>
                    {responseDecryptControls}
                  </div>
                ) : null}
              </div>
              <ul className='simple-voter-list simple-auditor-result-list'>
                {filteredResponseDetails.map((entry) => (
                  <li key={entry.event.id} className='simple-voter-list-item'>
                    <div className='simple-auditor-result-row'>
                      <div className='simple-auditor-result-marker'>
                        <TokenFingerprint
                          tokenId={entry.response.authorPubkey}
                          compact
                          large
                          hideMetadata
                          fingerprintTitle='Colour ID: a visual fingerprint for checking this submission identity at a glance.'
                        />
                        <div className='simple-auditor-result-marker-label'>
                          <span data-tooltip='Colour ID: a visual fingerprint for checking this submission identity at a glance.'>Colour ID</span>
                        </div>
                        {!entry.accepted ? (
                          <p className='simple-auditor-status-chip simple-auditor-status-chip-invalid'>
                            Invalid
                          </p>
                        ) : null}
                      </div>
                      <div className='simple-auditor-result-body'>
                        <dl className='simple-auditor-submission-meta'>
                          <div className='simple-auditor-submission-meta-identity'>
                            <dt>Submittor identity</dt>
                            <dd title={entry.response.authorPubkey}>{deriveActorDisplayId(entry.response.authorPubkey)}</dd>
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
                        {Array.isArray(entry.response.answers) && entry.response.answers.length > 0 ? (
                          <details className='simple-auditor-response-disclosure'>
                            <summary>
                              <span>Responses</span>
                              <span>{entry.response.answers.length}</span>
                            </summary>
                            <div className='simple-auditor-response-set'>
                              <ol className='simple-auditor-answer-list'>
                                {entry.response.answers.map((answer) => {
                                  const question = selectedQuestionById.get(answer.questionId);
                                  const questionNumber = selectedQuestionNumberById.get(answer.questionId);
                                  const prompt = `${questionNumber ? `Q${questionNumber}. ` : ""}${question?.prompt || answer.questionId}`;
                                  if (answer.answerType === "yes_no") {
                                    return (
                                      <li key={`${entry.event.id}:${answer.questionId}`}>
                                        <span className='simple-auditor-answer-prompt'>{prompt}</span>
                                        <div className='simple-auditor-answer-values'>
                                          <span className='simple-auditor-answer-chip'>{answer.value ? "Yes" : "No"}</span>
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
                                        </div>
                                      </li>
                                    );
                                  }
                                  return (
                                    <li key={`${entry.event.id}:${answer.questionId}`} className='simple-auditor-answer-item-free-text'>
                                      <span className='simple-auditor-answer-prompt'>{prompt}</span>
                                      <div className='simple-auditor-answer-free-text'>{formatFreeTextAnswer(answer.text)}</div>
                                    </li>
                                  );
                                })}
                              </ol>
                            </div>
                          </details>
                        ) : (
                          <p className='simple-voter-note'>Answer payload is encrypted or unavailable in public events.</p>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
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

      {freeTextViewerQuestionId && questionnaire ? (
        <section
          className='token-fingerprint-overlay'
          role='dialog'
          aria-modal='true'
          aria-label='Free-text responses'
          onClick={() => setFreeTextViewerQuestionId(null)}
        >
          <button type='button' className='token-fingerprint-overlay-close' onClick={() => setFreeTextViewerQuestionId(null)}>Close</button>
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
                      <p className='simple-voter-question'>{formatFreeTextAnswer(freeText.text)}</p>
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

function YesNoSummaryCard({ summary }: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "yes_no" }>;
}) {
  const total = summary.yesCount + summary.noCount;
  const hasResults = total > 0;
  const yesPercent = total > 0 ? (summary.yesCount / total) * 100 : 0;
  return (
    <div className='simple-auditor-donut-layout'>
      <div
        className={`simple-auditor-donut${hasResults ? "" : " is-empty"}`}
        style={{
          background: hasResults
            ? `conic-gradient(from 180deg, var(--simple-green) 0 ${yesPercent}%, var(--simple-coral) ${yesPercent}% 100%)`
            : undefined,
        }}
        aria-hidden='true'
      >
        <div className='simple-auditor-donut-core'>
          <strong>{total}</strong>
          <span>Total</span>
        </div>
      </div>
      <div className='simple-auditor-donut-legend'>
        <span>
          <i className='simple-auditor-dot simple-auditor-dot-yes' />
          Yes
          <strong>{summary.yesCount} ({total > 0 ? ((summary.yesCount / total) * 100).toFixed(0) : "0"}%)</strong>
        </span>
        <span>
          <i className='simple-auditor-dot simple-auditor-dot-no' />
          No
          <strong>{summary.noCount} ({total > 0 ? ((summary.noCount / total) * 100).toFixed(0) : "0"}%)</strong>
        </span>
      </div>
    </div>
  );
}

function MultipleChoiceSummaryCard({
  summary,
  question,
  displayValidCount,
}: {
  summary: Extract<QuestionnaireResultQuestionSummary, { answerType: "multiple_choice" }>;
  question: QuestionnaireQuestion | undefined;
  displayValidCount: number;
}) {
  return (
    <div className='simple-auditor-option-bars'>
      {getMultipleChoiceSummaryEntries(summary, question)
        .map(([optionId, count]) => {
          const label = question?.type === "multiple_choice"
            ? question.options.find((option) => option.optionId === optionId)?.label ?? optionId
            : optionId;
          const maxCount = Math.max(1, ...Object.values(summary.optionCounts));
          const percentOfAccepted = displayValidCount > 0 ? (count / displayValidCount) * 100 : 0;
          return (
            <div key={optionId} className='simple-auditor-option-bar-row'>
              <div className='simple-auditor-option-bar-label'>
                <span>{label}</span>
                <strong>{count} ({percentOfAccepted.toFixed(0)}%)</strong>
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

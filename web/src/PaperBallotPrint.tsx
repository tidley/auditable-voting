import type { PaperBallot } from "./paperBallot";
import { resolveLocalised } from "./i18n/resolveLocale";
import { buildQuestionLabelMap } from './questionnaireEditorTree';
import { formatPaperBallotCode } from './paperBallotAdmission';

export default function PaperBallotPrint({ ballot }: { ballot: PaperBallot }) {
  const questionLabels = buildQuestionLabelMap(ballot.questions);
  return <article className="ballot-print">
    <header className="ballot-header">
      <h1 className="ballot-title">{ballot.questionnaireTitle}</h1>
      <p className="ballot-id">Ballot ID: {ballot.questionnaireId}</p>
    </header>
    <section className="ballot-info">
      <h2 className="ballot-section-title">Paper ballot access</h2>
      <p>Master-list number: <strong>{ballot.masterlistNumber}</strong></p>
      <p>Paper code: <code>{formatPaperBallotCode(ballot.code)}</code></p>
      <p>Code expiry (UTC): {ballot.expiresAt}</p>
      <p>Open the questionnaire link from your organiser. Enter your master-list number and code to receive an anonymous ballot credential.</p>
      <p>Each code admits one request. Keep the same browser to recover or retry that request.</p>
      <p>Answer every applicable question. Leave conditional questions blank unless their condition applies. A required question is required only when applicable.</p>
    </section>
    <section className="ballot-questions">
      {ballot.questions.map((question) => <div key={question.questionId} className="ballot-question">
        {question.conditionInstruction ? <p className="ballot-condition">{question.conditionInstruction}</p> : null}
        <p className="ballot-question-prompt">{questionLabels.get(question.questionId)}. {resolveLocalised(question.prompt, "en")}{question.required ? " *" : ""}</p>
        {question.type === "yes_no" ? <p>☐ Yes　 ☐ No</p> : null}
        {question.type === "free_text" ? <div className="ballot-blank-lines">{[0, 1, 2, 3].map((line) => <div key={line} className="ballot-blank-line" />)}</div> : null}
        {question.type === "multiple_choice" || question.type === "rank" ? question.options.map((option) => <p className="ballot-option" key={option.optionId}>{question.type === "rank" ? "___" : "☐"} {resolveLocalised(option.label, "en")}</p>) : null}
      </div>)}
    </section>
  </article>;
}

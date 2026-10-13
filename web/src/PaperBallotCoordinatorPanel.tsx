import { useState } from "react";
import type { QuestionnaireOptionACoordinatorRuntime } from "./questionnaireOptionARuntime";
import { createPaperBallotAdmissionSheet, paperBallotExpiryToIsoUtc, type PrintablePaperBallotAdmission } from "./paperBallotAdmission";
import { UiButton, UiTextArea } from "./ui/DesignLayer";

export default function PaperBallotCoordinatorPanel(props: {
  electionId: string;
  runtime: QuestionnaireOptionACoordinatorRuntime | null;
  onAdmissionsChanged?: () => void;
}) {
  const [masterlistNumbers, setMasterlistNumbers] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [sheet, setSheet] = useState<PrintablePaperBallotAdmission[]>([]);
  const [status, setStatus] = useState("");

  async function generate() {
    if (!props.runtime) {
      setStatus("Open the questionnaire before generating paper ballots.");
      return;
    }
    const expiry = paperBallotExpiryToIsoUtc(expiresAt);
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      setStatus("Code expiry must be in the future.");
      return;
    }
    const next = await createPaperBallotAdmissionSheet({
      electionId: props.electionId,
      masterlistNumbers: masterlistNumbers.split(/[\n,]+/),
      expiresAt: expiry,
    });
    if (!next.length) {
      setStatus("Enter one or more master-list numbers and a valid future expiry time.");
      return;
    }
    next.forEach((entry) => props.runtime?.addPaperBallotAdmission(entry.admission));
    props.onAdmissionsChanged?.();
    setSheet(next);
    setStatus(`${next.length} paper ballot code${next.length === 1 ? "" : "s"} saved. Print this page now; codes are not retained here after reload.`);
  }

  return <section className='simple-settings-card' aria-label='Paper ballot access'>
    <h3 className='simple-voter-question'>Paper ballot access</h3>
    <p className='simple-voter-note'>Generate one code for each master-list record. The organiser stores only an opaque admission key; print the codes before leaving this page.</p>
    <UiTextArea
      label='Master-list numbers'
      textAreaClassName='simple-voter-input'
      textAreaProps={{ value: masterlistNumbers, rows: 3, placeholder: "ML-001\nML-002", onChange: (event) => setMasterlistNumbers(event.target.value) }}
    />
    <label className='simple-voter-field'>
      <span>Code expiry</span>
      <input className='simple-voter-input' type='datetime-local' value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
    </label>
    <div className='simple-voter-action-row simple-voter-action-row-inline'>
      <UiButton icon='key' className='simple-voter-secondary' onPress={() => void generate()} isDisabled={!props.electionId}>Generate printable codes</UiButton>
      {sheet.length ? <UiButton icon='export' className='simple-voter-secondary' onPress={() => window.print()}>Print ballot instructions</UiButton> : null}
    </div>
    {status ? <p className='simple-voter-note'>{status}</p> : null}
    {sheet.length ? <div className='simple-paper-ballot-sheet' aria-label='Printable paper ballot instructions'>
      <h4>Paper ballot instructions</h4>
      <p>Enter your master-list number and code to receive an anonymous ballot credential. Answer every applicable question. If a question says it depends on an earlier answer, leave it blank unless that answer applies.</p>
      {sheet.map((entry) => <p key={entry.admission.registryKey}><strong>Master-list number:</strong> {entry.masterlistNumber} <strong>Paper code:</strong> {entry.code}</p>)}
    </div> : null}
  </section>;
}

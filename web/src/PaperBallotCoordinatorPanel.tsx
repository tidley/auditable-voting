import { useEffect, useRef, useState } from "react";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { buildPaperBallotDocument } from './paperBallotDocument';
import { generatePaperBallot } from "./paperBallot";
import type { QuestionnaireOptionACoordinatorRuntime } from "./questionnaireOptionARuntime";
import { createPaperBallotAdmissionSheet, normalisePaperBallotMasterlistNumber, paperBallotExpiryToIsoUtc, type PrintablePaperBallotAdmission } from "./paperBallotAdmission";
import { UiButton, UiTextArea } from "./ui/DesignLayer";
import UiDateTimeField from './ui/UiDateTimeField';

export default function PaperBallotCoordinatorPanel(props: {
  electionId: string;
  definition: QuestionnaireDefinition | null;
  runtime: QuestionnaireOptionACoordinatorRuntime | null;
  onAdmissionsChanged?: () => void;
}) {
  const [masterlistNumbers, setMasterlistNumbers] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [sheet, setSheet] = useState<PrintablePaperBallotAdmission[]>([]);
  const [status, setStatus] = useState("");
  const [printDocumentUrl, setPrintDocumentUrl] = useState('');
  const generating = useRef(false);

  useEffect(() => {
    if (!sheet.length || !props.definition || props.definition.questionnaireId !== props.electionId) {
      setPrintDocumentUrl('');
      return;
    }
    const html = buildPaperBallotDocument(sheet.map(entry => generatePaperBallot({ definition: props.definition!, masterlistNumber: entry.masterlistNumber, code: entry.code, expiresAt: entry.admission.expiresAt })));
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    setPrintDocumentUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [sheet, props.definition, props.electionId]);

  async function generate() {
    if (generating.current) return;
    if (!props.runtime || !props.definition || props.definition.questionnaireId !== props.electionId) {
      setStatus("Open the questionnaire before generating paper ballots.");
      return;
    }
    const expiry = paperBallotExpiryToIsoUtc(expiresAt);
    const expiryMs = Date.parse(expiry);
    if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
      setStatus("Code expiry must be in the future.");
      return;
    }
    const numbers = masterlistNumbers.split(/[\n,]+/).map(normalisePaperBallotMasterlistNumber).filter(Boolean);
    if (numbers.length && numbers.every((number) => sheet.some((entry) => entry.masterlistNumber === number))) {
      setStatus("Codes already generated for these numbers in this print batch. Print the existing ballots.");
      return;
    }
    generating.current = true;
    try {
      const next = await createPaperBallotAdmissionSheet({
        electionId: props.electionId,
        masterlistNumbers: numbers.filter((number) => !sheet.some((entry) => entry.masterlistNumber === number)),
        expiresAt: expiry,
      });
      if (!next.length) {
        setStatus("Enter one or more master-list numbers and a valid future expiry time.");
        return;
      }
      next.forEach((entry) => props.runtime?.addPaperBallotAdmission(entry.admission));
      props.onAdmissionsChanged?.();
      setSheet([...sheet, ...next]);
      setStatus(`${next.length} paper ballot code${next.length === 1 ? "" : "s"} saved. Open or download the printable document now; codes are not retained here after reload.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not generate paper ballot codes.");
    } finally {
      generating.current = false;
    }
  }

  return <section className='simple-settings-card' aria-label='Paper ballot access'>
    <h3 className='simple-voter-question'>Paper ballot access</h3>
    <p className='simple-voter-note'>Save or print codes before leaving. Do not generate another batch for the same roster.</p>
    <details className='simple-organiser-disclosure'>
      <summary>Code storage and expiry</summary>
      <p className='simple-voter-note'>Only admission hashes are stored. Duplicate numbers are checked in this batch only. Reloading loses the printable codes, not their validity: they remain usable until redeemed, expired or explicitly revoked. New codes do not replace old codes.</p>
    </details>
    <UiTextArea
      label='Master-list numbers'
      textAreaClassName='simple-voter-input'
      textAreaProps={{ value: masterlistNumbers, rows: 3, placeholder: "ML-001\nML-002", onChange: (event) => setMasterlistNumbers(event.target.value) }}
    />
    <UiDateTimeField label='Code expiry' value={expiresAt} onChange={setExpiresAt} />
    <p className='simple-voter-note'>Local time; printed in UTC.</p>
    <div className='simple-voter-action-row simple-voter-action-row-inline'>
      <UiButton icon='key' className='simple-voter-secondary' onPress={() => void generate()} isDisabled={!props.electionId}>Generate printable codes</UiButton>
      {printDocumentUrl ? <>
        <a className='av-ui-button av-ui-button-secondary' href={printDocumentUrl} target='_blank' rel='noopener noreferrer'>Open printable ballots</a>
        <a className='av-ui-button av-ui-button-secondary' href={printDocumentUrl} download={`paper-ballots-${props.electionId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 100)}.html`}>Download HTML</a>
      </> : null}
    </div>
    {status ? <p className='simple-voter-note' role='status'>{status}</p> : null}
    {printDocumentUrl ? <p className='simple-voter-note'>Keep printed and downloaded codes private.</p> : null}
  </section>;
}

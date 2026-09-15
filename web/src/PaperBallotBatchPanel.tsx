import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { UiButton } from "./ui/DesignLayer";
import { useLocaleSafe, useTSafe } from "./i18n/LanguageContext";
import type { UiStringKey } from "./i18n/uiStrings";
import { readCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import PaperBallotPrint from "./PaperBallotPrint";
import type { PaperBallot } from "./paperBallot";
import {
  MAX_PAPER_BALLOT_BATCH,
  generatePaperBallotBatch,
  type PaperBallotBatchResult,
} from "./paperBallotBatch";

/**
 * How long to wait for the print-only copy of a batch to finish rendering its
 * `npub` QR codes before handing the document to the print dialog.  Printing
 * blank QR boxes is worse than a short pause, but a stuck QR must not hang the
 * coordinator either, so the wait is bounded.
 */
const PRINT_READY_TIMEOUT_MS = 8000;
const PRINT_READY_POLL_MS = 50;

interface PaperBallotBatchPanelProps {
  /** Questionnaire to print. When omitted the panel loads it from the local cache. */
  definition?: QuestionnaireDefinition | null;
  /** Published questionnaire id, used to read the definition from the local cache. */
  questionnaireId?: string | null;
  /** Number of voters already admitted; used as the default ballot count. */
  admittedVoterCount?: number;
  /** Called with each successfully generated batch. */
  onGenerated?: (result: PaperBallotBatchResult) => void;
}

function fillTemplate(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(String(value)),
    template,
  );
}

/**
 * Coordinator panel for F3-T3 batch paper ballot generation.
 *
 * One ballot is produced per voter, each with a fresh nsec/npub pair, so the
 * printed ballot is the voter's only copy of their key. Every ballot can be
 * previewed on screen and printed; "Print all" hands the whole batch to the
 * browser print dialog with the A4 @media print layout.
 */
export default function PaperBallotBatchPanel({
  definition = null,
  questionnaireId = null,
  admittedVoterCount = 0,
  onGenerated,
}: PaperBallotBatchPanelProps) {
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
  const [count, setCount] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<PaperBallotBatchResult | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [printBallots, setPrintBallots] = useState<PaperBallot[] | null>(null);
  const printRootRef = useRef<HTMLDivElement | null>(null);
  const printStartedRef = useRef(false);
  const countTouchedRef = useRef(false);

  const activeDefinition = definition ?? cachedDefinition;

  useEffect(() => {
    if (definition) {
      return;
    }
    setCachedDefinition(
      questionnaireId ? readCachedQuestionnaireDefinition(questionnaireId) : null,
    );
  }, [definition, questionnaireId]);

  useEffect(() => {
    if (countTouchedRef.current) {
      return;
    }
    if (admittedVoterCount > 0) {
      setCount(Math.min(MAX_PAPER_BALLOT_BATCH, admittedVoterCount));
    }
  }, [admittedVoterCount]);

  /**
   * Printing cannot use the on-screen preview: the app hides `#root` in the
   * print media query, and the preview lives inside it.  So the batch is copied
   * into a print-only root that is portalled to `<body>` (matching the
   * `body > *:not(.ballot-print)` rule that hides the app) and hidden again on
   * screen.
   */
  function handlePrintAll() {
    if (!result || result.ballots.length === 0) {
      return;
    }
    printStartedRef.current = false;
    setPrintBallots(result.ballots);
  }

  useEffect(() => {
    if (!printBallots || printBallots.length === 0 || printStartedRef.current) {
      return;
    }

    const expected = printBallots.length;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (printStartedRef.current) {
        return;
      }
      const readyCount = printRootRef.current?.querySelectorAll("img.ballot-qr-image").length ?? 0;
      if (readyCount < expected && Date.now() - startedAt < PRINT_READY_TIMEOUT_MS) {
        return;
      }
      printStartedRef.current = true;
      window.clearInterval(timer);
      window.print();
      setPrintBallots(null);
    }, PRINT_READY_POLL_MS);

    return () => window.clearInterval(timer);
  }, [printBallots]);

  useEffect(() => {
    function clearPrintRoot() {
      printStartedRef.current = false;
      setPrintBallots(null);
    }
    window.addEventListener("afterprint", clearPrintRoot);
    return () => window.removeEventListener("afterprint", clearPrintRoot);
  }, []);

  function normaliseCount(next: number): number {
    if (!Number.isFinite(next)) {
      return 1;
    }
    return Math.max(1, Math.min(MAX_PAPER_BALLOT_BATCH, Math.trunc(next)));
  }

  function handleGenerate() {
    if (!activeDefinition) {
      setStatus(t("paperBallotsNoDefinition"));
      return;
    }
    if (!Number.isInteger(count) || count <= 0 || count > MAX_PAPER_BALLOT_BATCH) {
      setStatus(t("paperBallotsInvalidCount"));
      return;
    }

    setInFlight(true);
    setStatus(null);
    setPreviewIndex(null);

    try {
      const batch = generatePaperBallotBatch({
        definition: activeDefinition,
        voterCount: count,
        locale,
      });
      setResult(batch);
      onGenerated?.(batch);
      setStatus(
        batch.errors.length > 0
          ? translate("paperBallotsPartial", {
            count: batch.ballots.length,
            errors: batch.errors.length,
          })
          : translate("paperBallotsReady", { count: batch.ballots.length }),
      );
    } catch (err) {
      setResult(null);
      setStatus(
        translate("paperBallotsFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    } finally {
      setInFlight(false);
    }
  }

  return (
    <div className="simple-paper-ballot-section" aria-label={t("paperBallotsTitle")}>
      <p className="simple-voter-note">{t("paperBallotsIntro")}</p>
      <p className="simple-voter-note simple-paper-ballot-warning">
        {t("paperBallotsSecurityNote")}
      </p>
      <div className="simple-voter-action-row simple-voter-action-row-inline">
        <label className="simple-voter-label" htmlFor="paper-ballot-count">
          {t("paperBallotsCountLabel")}
        </label>
        <input
          id="paper-ballot-count"
          className="simple-voter-input simple-paper-ballot-count-input"
          type="number"
          min={1}
          max={MAX_PAPER_BALLOT_BATCH}
          value={count}
          aria-label={t("paperBallotsCountLabel")}
          onChange={(event) => {
            countTouchedRef.current = true;
            setCount(normaliseCount(Number(event.target.value)));
          }}
        />
        <UiButton
          icon={inFlight ? "spinner" : "book"}
          className="simple-voter-secondary"
          onPress={handleGenerate}
          isDisabled={inFlight || !activeDefinition}
        >
          <span>{inFlight ? t("paperBallotsGenerating") : t("paperBallotsGenerate")}</span>
        </UiButton>
      </div>
      {admittedVoterCount > 0 ? (
        <p className="simple-voter-note simple-paper-ballot-admitted-hint">
          {translate("paperBallotsAdmittedHint", { count: admittedVoterCount })}
        </p>
      ) : null}
      {!activeDefinition ? (
        <p className="simple-voter-note simple-paper-ballot-hint">
          {t("paperBallotsNoQuestionnaire")}
        </p>
      ) : null}
      {status ? (
        <p className="simple-voter-note simple-paper-ballot-status" role="status">
          {status}
        </p>
      ) : null}
      {result && result.ballots.length > 0 ? (
        <div className="simple-paper-ballot-results">
          <div className="simple-voter-action-row simple-voter-action-row-inline">
            <span className="simple-voter-note">{t("paperBallotsResultsTitle")}</span>
            <UiButton
              icon="download"
              className="simple-voter-secondary"
              onPress={handlePrintAll}
            >
              <span>{t("paperBallotsPrintAll")}</span>
            </UiButton>
          </div>
          <div className="simple-paper-ballot-list">
            {result.ballots.map((ballot, index) => {
              const isPreviewing = previewIndex === index;
              return (
                <div key={ballot.voterNpub} className="simple-paper-ballot-item">
                  <div className="simple-paper-ballot-item-header">
                    <span className="simple-voter-note simple-paper-ballot-item-title">
                      {`${index + 1}. ${ballot.voterNpub.slice(0, 24)}…`}
                    </span>
                    <UiButton
                      icon={isPreviewing ? "cancel" : "view"}
                      iconOnly
                      className="simple-voter-secondary"
                      aria-label={
                        isPreviewing
                          ? translate("paperBallotsHideBallot", { index: index + 1 })
                          : translate("paperBallotsViewBallot", { index: index + 1 })
                      }
                      onPress={() => setPreviewIndex(isPreviewing ? null : index)}
                    />
                  </div>
                  {isPreviewing ? (
                    <div className="simple-paper-ballot-preview">
                      <PaperBallotPrint ballot={ballot} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
      {printBallots
        ? createPortal(
          <div
            ref={printRootRef}
            className="ballot-print simple-paper-ballot-print-only"
            aria-hidden="true"
          >
            {printBallots.map((ballot) => (
              <PaperBallotPrint key={ballot.voterNpub} ballot={ballot} />
            ))}
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}

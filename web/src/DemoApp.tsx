import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  discoverCoordinators,
  fetchElection,
  fetchIssuanceStatus,
  fetchPerCoordinatorTallies,
  fetchResult,
  fetchTally,
  runAudit,
  type AuditResult,
  type CoordinatorDiscovery,
  type CoordinatorInfo,
  type ElectionInfo,
  type FinalResultInfo,
  type IssuanceStatusResponse,
  type PerCoordinatorTally,
  type TallyInfo,
} from "./coordinatorApi";
import { createMintQuote, checkQuoteStatus, type MintQuoteResponse } from "./mintApi";
import { requestQuoteAndMint, type CashuProof } from "./cashuBlind";
import {
  checkEligibility,
  fetchEligibility as fetchVoterEligibility,
  seedEligibility,
  type EligibilityCheckResponse,
  type EligibilityResponse,
} from "./voterManagementApi";
import { DEMO_MODE, USE_MOCK, MINT_URL, COORDINATOR_URL } from "./config";
import { decodeNsec, deriveNpubFromNsec, formatDateTime } from "./nostrIdentity";
import { createDemoIdentity, type DemoIdentity } from "./demoIdentity";
import { fetchCoordinatorInfo } from "./coordinatorApi";
import PageNav from "./PageNav";
import { publishBallotEvent } from "./ballot";
import { submitProofsToAllCoordinators, type MultiCoordinatorDmResult } from "./proofSubmission";

type StepState = {
  title: string;
  detail: string;
  status: "done" | "current" | "waiting";
};

const EMPTY_ELIGIBILITY: EligibilityResponse = {
  eligibleNpubs: [],
  eligibleCount: 0,
  verifiedNpubs: [],
  verifiedCount: 0,
};

function PanelTitle({ kicker, title, right }: { kicker: string; title: string; right?: ReactNode }) {
  return (
    <div className="demo-panel-title">
      <div>
        <div className="demo-kicker">{kicker}</div>
        <h2>{title}</h2>
      </div>
      {right}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="demo-metric">
      <div className="demo-kicker">{label}</div>
      <div className="demo-metric-value">{value}</div>
      <div className="demo-note">{hint}</div>
    </div>
  );
}

function CopyField({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={`copy-field${compact ? " copy-field-compact" : ""}`}>
      <div className="copy-field-label">{label}</div>
      <code className="copy-field-value">{value}</code>
      <button className="copy-field-button" onClick={handleCopy} type="button">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function DemoApp() {
  const [identity, setIdentity] = useState<DemoIdentity>(() => createDemoIdentity());
  const [nsecInput, setNsecInput] = useState<string>("");
  const [coordinatorInfo, setCoordinatorInfo] = useState<CoordinatorInfo | null>(null);
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityResponse>(EMPTY_ELIGIBILITY);
  const [issuanceStatus, setIssuanceStatus] = useState<IssuanceStatusResponse | null>(null);
  const [tally, setTally] = useState<TallyInfo | null>(null);
  const [finalResult, setFinalResult] = useState<FinalResultInfo | null>(null);
  const [discoveredCoordinators, setDiscoveredCoordinators] = useState<CoordinatorDiscovery[]>([]);
  const [perCoordinatorTallies, setPerCoordinatorTallies] = useState<PerCoordinatorTally[]>([]);
  const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
  const [selectedNpub, setSelectedNpub] = useState(identity.npub);
  const [voterCheck, setVoterCheck] = useState<EligibilityCheckResponse | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [mintingProof, setMintingProof] = useState(false);
  const [publishingBallot, setPublishingBallot] = useState(false);
  const [submittingProof, setSubmittingProof] = useState(false);
  const [checkingVoter, setCheckingVoter] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [runningDemo, setRunningDemo] = useState(false);
  const [status, setStatus] = useState<string>("Loading live demo state...");
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [mintQuote, setMintQuote] = useState<MintQuoteResponse | null>(null);
  const [proof, setProof] = useState<CashuProof | null>(null);
  const [dmResults, setDmResults] = useState<MultiCoordinatorDmResult[] | null>(null);
  const [ballotEventId, setBallotEventId] = useState<string>("");
  const [ballotAnswers, setBallotAnswers] = useState<Record<string, string | string[] | number>>({});
  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);

  useEffect(() => {
    if (!nsecInput) {
      setNsecInput(identity.nsec);
    }
  }, [identity.nsec, nsecInput]);

  const eligibleNpubs = eligibility.eligibleNpubs;
  const issuedCount = Object.values(issuanceStatus?.voters ?? {}).filter((entry) => entry.issued).length;
  const publishedVotes = tally?.total_published_votes ?? finalResult?.total_votes ?? 0;
  const acceptedVotes = tally?.total_accepted_votes ?? finalResult?.total_votes ?? 0;
  const confirmationCount = auditResults.length > 0 ? auditResults[0].confirmations : 0;
  const coordinatorCount = discoveredCoordinators.length || election?.coordinator_npubs.length || 0;
  const issuanceForSelected = selectedNpub ? issuanceStatus?.voters[selectedNpub] : undefined;

  const timelinePhases: StepState[] = useMemo(() => {
    const spentRoot = tally?.spent_commitment_root ?? finalResult?.spent_commitment_root ?? "";
    const spentRootShort = spentRoot ? `${spentRoot.slice(0, 24)}...` : "";
    const confirmationDetail = auditResults.length > 0
      ? `${confirmationCount} canonical confirmation(s) counted from real npubs.`
      : "After the voting window, voters publish kind 38013 from their real npub.";

    return [
      {
        title: "1. Election announced",
        detail: election
          ? `Election ${election.election_id} is live and visible to the demo.`
          : "Waiting for the coordinator to publish the election announcement.",
        status: election ? "done" : "current",
      },
      {
        title: "2. Proof minted",
        detail: proof
          ? `Minted proof for ${selectedNpub.slice(0, 18)}... is stored locally.`
          : voterCheck?.allowed
            ? `${voterCheck.npub} is eligible and can mint the proof.`
            : "Paste the nsec and mint the proof on this page.",
        status: proof ? "done" : election ? "current" : "waiting",
      },
      {
        title: "3. Ballot published",
        detail: ballotEventId
          ? `Ballot event ${ballotEventId.slice(0, 16)}... was published publicly.`
          : publishedVotes > 0
            ? `${publishedVotes} ballot event(s) are visible on the relay.`
            : "The ephemeral ballot key publishes kind 38000 on the relay.",
        status: ballotEventId || publishedVotes > 0 ? "done" : proof ? "current" : "waiting",
      },
      {
        title: "4. Proof delivered",
        detail: dmResults && dmResults.length > 0
          ? `${dmResults.length} coordinator(s) received the proof gift wrap.`
          : issuedCount > 0
            ? `${issuedCount} proof(s) are ready to submit.`
            : "The proof is sent privately to the coordinator via gift wrap.",
        status: dmResults && dmResults.length > 0 ? "done" : ballotEventId ? "current" : "waiting",
      },
      {
        title: "5. 38002 receipt published",
        detail: acceptedVotes > 0
          ? `Coordinator receipt seen. Auditors can reconstruct the spent commitment tree from those receipts.`
          : "Waiting for the coordinator to publish kind 38002 after burning the proof.",
        status: acceptedVotes > 0 ? "done" : dmResults && dmResults.length > 0 ? "current" : "waiting",
      },
      {
        title: "6. Spent tree rebuilt",
        detail: spentRoot
          ? `Spent commitment root: ${spentRootShort}`
          : "Auditors rebuild the spent commitment tree from 38002 receipts as they appear.",
        status: spentRoot ? "done" : acceptedVotes > 0 ? "current" : "waiting",
      },
      {
        title: "7. 38013 confirmations",
        detail: confirmationDetail,
        status: auditResults.length > 0 ? "done" : spentRoot ? "current" : "waiting",
      },
      {
        title: "8. Audit comparison",
        detail: auditResults.length > 0
          ? `Audit ran across ${auditResults.length} coordinator(s).`
          : "The verifier compares tally, confirmations, and the spent root.",
        status: auditResults.length > 0 ? "done" : confirmationCount > 0 ? "current" : "waiting",
      },
    ];
  }, [acceptedVotes, auditResults.length, ballotEventId, confirmationCount, dmResults, election, finalResult?.spent_commitment_root, issuedCount, proof, publishedVotes, selectedNpub, tally?.spent_commitment_root, voterCheck]);

  const refreshSnapshot = useCallback(async (showSpinner = true) => {
    if (showSpinner) setRefreshing(true);

    try {
      const [info, elig, electionResult, tallyResult, resultResult, issuanceResult] = await Promise.all([
        fetchCoordinatorInfo(),
        fetchVoterEligibility(),
        fetchElection(),
        fetchTally(),
        fetchResult(),
        fetchIssuanceStatus(),
      ]);

      setCoordinatorInfo(info);
      setEligibility(elig);
      setElection(electionResult);
      setTally(tallyResult);
      setFinalResult(resultResult);
      setIssuanceStatus(issuanceResult);

      let coordinators: CoordinatorDiscovery[] = [];
      if (electionResult?.event_id) {
        coordinators = await discoverCoordinators(electionResult.event_id, info.relays);
      }
      setDiscoveredCoordinators(coordinators);
      if (coordinators.length > 0) {
        setPerCoordinatorTallies(await fetchPerCoordinatorTallies(coordinators));
      } else {
        setPerCoordinatorTallies([]);
      }

      setLastRefresh(Date.now());
      setStatus(`Synced live state for ${electionResult?.title ?? "the current election"}.`);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach demo services");
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, []);

  const seedDemoVoter = useCallback(async () => {
    setSeeding(true);
    setError(null);

    try {
      const nextIdentity = createDemoIdentity();
      setIdentity(nextIdentity);
      setNsecInput(nextIdentity.nsec);
      setMintQuote(null);
      setProof(null);
      setDmResults(null);
      setBallotEventId("");
      setBallotAnswers({});
      setAuditResults([]);
      setVoterCheck(null);
      if (USE_MOCK) {
        await seedEligibility(nextIdentity.npub);
      }
      setSelectedNpub(nextIdentity.npub);
      setStatus(`Generated voter identity: ${nextIdentity.npub}`);
      await refreshSnapshot(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to seed demo voter");
    } finally {
      setSeeding(false);
    }
  }, [refreshSnapshot]);

  useEffect(() => {
    void refreshSnapshot();
    void seedDemoVoter();
  }, [refreshSnapshot, seedDemoVoter]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshSnapshot(false);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [refreshSnapshot]);

  const checkSelectedVoter = useCallback(async () => {
    if (!selectedNpub.trim()) {
      setError("Paste an npub first.");
      return;
    }

    setCheckingVoter(true);
    setError(null);

    try {
      const result = await checkEligibility(selectedNpub.trim());
      setVoterCheck(result);
      setStatus(result.message);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : "Eligibility check failed");
    } finally {
      setCheckingVoter(false);
    }
  }, [selectedNpub]);

  const saveDemoIdentity = useCallback(async () => {
    const npub = derivedNpub;
    if (!npub) {
      setError("Paste a valid nsec first.");
      return;
    }

    setSeeding(true);
    setError(null);

    try {
      if (USE_MOCK) {
        await seedEligibility(npub);
      }
      setMintQuote(null);
      setProof(null);
      setDmResults(null);
      setBallotEventId("");
      setBallotAnswers({});
      setAuditResults([]);
      setSelectedNpub(npub);
      setVoterCheck({
        npub,
        allowed: true,
        canProceed: true,
        message: "npub is allowed and has not voted yet",
      });
      setStatus(`Saved voter identity for ${npub}.`);
      await refreshSnapshot(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save identity");
    } finally {
      setSeeding(false);
    }
  }, [derivedNpub, refreshSnapshot]);

  const fillDemoBallot = useCallback(() => {
    if (!election?.questions) return {};

    const filled: Record<string, string | string[] | number> = {};
    for (const question of election.questions) {
      if (question.type === "choice") {
        filled[question.id] = question.options?.[0] ?? "";
      } else if (question.type === "scale") {
        filled[question.id] = question.min ?? 1;
      } else {
        filled[question.id] = "demo answer";
      }
    }

    setBallotAnswers(filled);
    return filled;
  }, [election]);

  const mintDemoProof = useCallback(async () => {
    if (!derivedNpub) {
      setError("Paste a valid nsec first.");
      return;
    }

    setMintingProof(true);
    setError(null);

    try {
      if (USE_MOCK) {
        await seedEligibility(derivedNpub);
      }

      const eligibilityCheck = await checkEligibility(derivedNpub);
      setSelectedNpub(derivedNpub);
      setVoterCheck(eligibilityCheck);
      setStatus(eligibilityCheck.message);

      if (!eligibilityCheck.canProceed) {
        throw new Error(eligibilityCheck.message);
      }

      const quote = await createMintQuote();
      setMintQuote(quote);

      for (let i = 0; i < 20; i++) {
        const quoteStatus = await checkQuoteStatus(quote.quote);
        if (quoteStatus.state === "PAID") {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      const mintResult = await requestQuoteAndMint(MINT_URL.replace(/\/$/, ""), quote.quote);
      const mintedProof = mintResult.proofs[0] ?? null;
      if (!mintedProof) {
        throw new Error("Mint did not return a proof.");
      }

      setProof(mintedProof);
      setStatus("Proof minted and ready for the ballot step.");
      await refreshSnapshot(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to mint proof");
    } finally {
      setMintingProof(false);
    }
  }, [derivedNpub, refreshSnapshot]);

  const publishDemoBallot = useCallback(async () => {
    if (!election || !proof || !derivedNpub) {
      setError("Mint a proof before publishing the ballot.");
      return;
    }

    const answers = Object.keys(ballotAnswers).length > 0 ? ballotAnswers : fillDemoBallot();
    const coordinatorNpub = election.coordinator_npubs[0] ?? coordinatorInfo?.coordinatorNpub ?? "";
    const relays = coordinatorInfo?.relays ?? [];

    setPublishingBallot(true);
    setSubmittingProof(true);
    setError(null);

    try {
      const publishResult = await publishBallotEvent({
        electionId: election.electionId,
        answers,
        questions: election.questions,
        relays,
        coordinatorProofs: [{
          coordinatorNpub,
          mintUrl: election.mint_urls[0] ?? MINT_URL,
          proof,
          proofSecret: proof.secret,
        }],
      });

      setBallotEventId(publishResult.eventId);
      setStatus(`Ballot published: ${publishResult.successes} relay confirmation(s).`);
      setIssuanceStatus((prev) => prev);

      const voterSecretKey = decodeNsec(nsecInput);
      if (!voterSecretKey) {
        throw new Error("Could not decode the saved nsec.");
      }

      const dmOutcome = await submitProofsToAllCoordinators({
        voterSecretKey,
        voteEventId: publishResult.eventId,
        coordinatorProofs: [{
          coordinatorNpub,
          proof,
        }],
        relays,
        retries: DEMO_MODE ? 1 : 0,
      });

      setDmResults(dmOutcome);
      setStatus(`Proof sent to ${dmOutcome.length} coordinator(s).`);

      await refreshSnapshot(false);
      await runVerifierAudit();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to publish ballot");
    } finally {
      setPublishingBallot(false);
      setSubmittingProof(false);
    }
  }, [ballotAnswers, coordinatorInfo?.coordinatorNpub, coordinatorInfo?.relays, derivedNpub, election, fillDemoBallot, nsecInput, proof, refreshSnapshot]);

  const runVerifierAudit = useCallback(async () => {
    if (!election?.event_id) {
      setError("Need a discovered election before running an audit.");
      return;
    }

    setRunningAudit(true);
    setError(null);

    try {
      const coordinatorsToAudit = discoveredCoordinators.length > 0
        ? discoveredCoordinators
        : coordinatorInfo
          ? [{
              npub: coordinatorInfo.coordinatorNpub,
              httpApi: COORDINATOR_URL,
              mintUrl: coordinatorInfo.relays[0] ?? MINT_URL,
              relays: coordinatorInfo.relays,
            }]
          : [];

      if (coordinatorsToAudit.length === 0) {
        throw new Error("Need coordinator details before running an audit.");
      }

      const audit = await runAudit(
        election.event_id,
        coordinatorsToAudit,
        eligibility.eligibleNpubs,
        election.vote_start,
        election.confirm_end ?? election.vote_end + 86400,
        coordinatorInfo?.relays ?? [],
      );

      setAuditResults(audit);
      setStatus(`Audit complete for ${audit.length} coordinator(s).`);
    } catch (auditError) {
      setError(auditError instanceof Error ? auditError.message : "Audit failed");
    } finally {
      setRunningAudit(false);
    }
  }, [coordinatorInfo, discoveredCoordinators, election, eligibility.eligibleNpubs]);

  const runDemoSequence = useCallback(async () => {
    if (runningDemo) return;

    setRunningDemo(true);
    setError(null);

    try {
      if (!nsecInput.trim()) {
        throw new Error("Paste a nsec first.");
      }

      const sequenceNpub = deriveNpubFromNsec(nsecInput.trim());
      if (!sequenceNpub) {
        throw new Error("That nsec is not valid.");
      }

      setStatus("Step 1: seeding voter identity...");
      if (USE_MOCK) {
        await seedEligibility(sequenceNpub);
      }
      setSelectedNpub(sequenceNpub);
      setVoterCheck({
        npub: sequenceNpub,
        allowed: true,
        canProceed: true,
        message: "npub is allowed and has not voted yet",
      });

      setStatus("Step 2: minting proof...");
      const eligibilityCheck = await checkEligibility(sequenceNpub);
      if (!eligibilityCheck.canProceed) {
        throw new Error(eligibilityCheck.message);
      }
      const quote = await createMintQuote();
      setMintQuote(quote);
      for (let i = 0; i < 20; i++) {
        const quoteStatus = await checkQuoteStatus(quote.quote);
        if (quoteStatus.state === "PAID") {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      const minted = await requestQuoteAndMint(MINT_URL.replace(/\/$/, ""), quote.quote);
      const mintedProof = minted.proofs[0] ?? null;
      if (!mintedProof) {
        throw new Error("Mint did not return a proof.");
      }
      setProof(mintedProof);
      await refreshSnapshot(false);

      setStatus("Step 3: casting ballot...");
      if (!election) {
        throw new Error("No election loaded.");
      }
      const answers = fillDemoBallot();
      const coordinatorNpub = election.coordinator_npubs[0] ?? coordinatorInfo?.coordinatorNpub ?? "";
      const relays = coordinatorInfo?.relays ?? [];
      const publishResult = await publishBallotEvent({
        electionId: election.electionId,
        answers,
        questions: election.questions,
        relays,
        coordinatorProofs: [{
          coordinatorNpub,
          mintUrl: election.mint_urls[0] ?? MINT_URL,
          proof: mintedProof,
          proofSecret: mintedProof.secret,
        }],
      });
      setBallotEventId(publishResult.eventId);
      setStatus(`Step 3 worked: ballot published to ${publishResult.successes} relay(s).`);

      setStatus("Step 4: sending proof to coordinator(s)...");
      const voterSecretKey = decodeNsec(nsecInput.trim());
      if (!voterSecretKey) {
        throw new Error("Could not decode the saved nsec.");
      }
      const dmOutcome = await submitProofsToAllCoordinators({
        voterSecretKey,
        voteEventId: publishResult.eventId,
        coordinatorProofs: [{
          coordinatorNpub,
          proof: mintedProof,
        }],
        relays,
        retries: DEMO_MODE ? 1 : 0,
      });
      setDmResults(dmOutcome);
      setStatus(`Step 4 worked: proof sent to ${dmOutcome.length} coordinator(s).`);

      setStatus("Step 5: refreshing verifier view...");
      await refreshSnapshot(false);
      await runVerifierAudit();
      setStatus("Demo complete. Every step on this page has run in order.");
    } catch (sequenceError) {
      setError(sequenceError instanceof Error ? sequenceError.message : "Demo sequence failed");
    } finally {
      setRunningDemo(false);
    }
  }, [coordinatorInfo?.coordinatorNpub, coordinatorInfo?.relays, election, fillDemoBallot, nsecInput, refreshSnapshot, runningDemo, runVerifierAudit]);

  return (
    <main className="page-shell page-shell-demo">
      <header className="demo-header">
        <div>
          <div className="demo-kicker">Live Demo</div>
          <h1>Voting control room</h1>
          <p className="demo-lead">
            Simple, flat status view for coordinators, voters, and verifiers.
          </p>
        </div>
        <PageNav current="home" />
        <div className="demo-header-meta">
          <div className="demo-meta-row">
            <span>Mode</span>
            <strong>{DEMO_MODE ? "Demo" : "Live"}</strong>
          </div>
          <div className="demo-meta-row">
            <span>Backend</span>
            <strong>{USE_MOCK ? "Mock server" : "Coordinator API"}</strong>
          </div>
          <button className="ghost-button" onClick={() => void refreshSnapshot()} disabled={refreshing}>
            {refreshing ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </header>

      <section className="demo-grid demo-grid-4">
        <Metric label="Coordinators" value={coordinatorCount} hint="Discovered for the election." />
        <Metric label="Eligible voters" value={eligibility.eligibleCount} hint="Canonical voter list." />
        <Metric label="Issued passes" value={issuedCount} hint="Proofs stored locally." />
        <Metric label="Accepted ballots" value={acceptedVotes} hint="Vote results visible on the verifier." />
      </section>

      {error && <section className="demo-banner demo-banner-error">{error}</section>}
      {status && <section className="demo-banner">{status}</section>}

      <section className="demo-grid demo-grid-2">
        <article className="demo-card" id="demo-identity">
          <PanelTitle
            kicker="Identity"
            title="Ephemeral voter keypair"
            right={<button className="secondary-button" onClick={() => void seedDemoVoter()} disabled={seeding}>{seeding ? "Seeding..." : "Generate again"}</button>}
          />
          <div className="demo-note">Paste the nsec below. The npub is seeded into the mock eligibility list.</div>
          <div className="demo-copy-stack">
            <CopyField label="nsec" value={identity.nsec} />
            <CopyField label="npub" value={identity.npub} />
          </div>
          <div className="demo-stack">
            <label className="demo-label" htmlFor="demo-nsec">nsec</label>
            <textarea
              id="demo-nsec"
              className="demo-input"
              value={nsecInput}
              onChange={(event) => setNsecInput(event.target.value)}
              rows={3}
              spellCheck={false}
            />
            <div className="demo-note">Paste here to seed the voter and mint the proof on this page.</div>
            <div className="button-row">
              <button className="primary-button" onClick={() => void mintDemoProof()} disabled={mintingProof || !derivedNpub}>
                {mintingProof ? "Minting..." : "Mint proof"}
              </button>
              <button className="secondary-button" onClick={() => void saveDemoIdentity()} disabled={seeding || !derivedNpub}>
                {seeding ? "Seeding..." : "Save identity"}
              </button>
              <button className="ghost-button" onClick={() => void runDemoSequence()} disabled={runningDemo}>
                {runningDemo ? "Running..." : "Run full demo"}
              </button>
            </div>
          </div>
          <div className="demo-note">The next cards show each step as it completes.</div>
        </article>

        <article className="demo-card" id="demo-voter">
          <PanelTitle kicker="Coordinator" title="Current election" right={election?.event_id ? <span className="demo-status demo-status-good">Live</span> : <span className="demo-status">Waiting</span>} />
          {election ? (
            <div className="demo-stack">
              <div><strong>{election.title}</strong></div>
              <div className="demo-note">{election.description || "No description"}</div>
              <div className="demo-kv"><span>ID</span><code>{election.election_id}</code></div>
              <div className="demo-kv"><span>Vote window</span><code>{formatDateTime(election.vote_start)} - {formatDateTime(election.vote_end)}</code></div>
              <div className="demo-kv"><span>Coordinator npub</span><code>{coordinatorInfo?.coordinatorNpub ?? "Loading..."}</code></div>
              <div className="demo-kv"><span>Relays</span><code>{coordinatorInfo?.relays.join(", ") || "None"}</code></div>
            </div>
          ) : (
            <div className="demo-note">Waiting for the coordinator metadata.</div>
          )}
        </article>
      </section>

      <section className="demo-grid demo-grid-3">
        <article className="demo-card" id="demo-verifier">
          <PanelTitle kicker="Voter" title="Eligibility and pass issuance" right={issuanceForSelected?.issued ? <span className="demo-status demo-status-good">Issued</span> : <span className="demo-status">Pending</span>} />
          <div className="demo-stack">
            <label className="demo-label" htmlFor="demo-npub">Voter npub</label>
            <input
              id="demo-npub"
              className="demo-input"
              value={selectedNpub}
              onChange={(event) => setSelectedNpub(event.target.value)}
              spellCheck={false}
            />
            <div className="button-row">
              <button className="primary-button" onClick={() => void checkSelectedVoter()} disabled={checkingVoter}>
                {checkingVoter ? "Checking..." : "Check eligibility"}
              </button>
              <a className="ghost-button link-button" href="#demo-identity">Jump to identity</a>
            </div>
            {voterCheck ? (
              <div className="demo-note">
                {voterCheck.allowed ? "Eligible" : "Not eligible"}: {voterCheck.message}
              </div>
            ) : (
              <div className="demo-note">Run the eligibility check to show the voter path.</div>
            )}
            {issuanceForSelected && (
              <div className="demo-note">
                Issuance status: {issuanceForSelected.issued ? "issued" : "waiting"}.
              </div>
            )}
            <div className="demo-list">
              {eligibleNpubs.slice(0, 4).map((npub) => (
                <div className="demo-list-item" key={npub}>
                  <code>{npub.slice(0, 18)}...</code>
                  <span>{issuanceStatus?.voters[npub]?.issued ? "issued" : "waiting"}</span>
                </div>
              ))}
            </div>
          </div>
        </article>

        <article className="demo-card">
          <PanelTitle kicker="Audit" title="Live timeline" />
          <div className="demo-note">
            Auditors can reconstruct the spent commitment tree from those receipts.
          </div>
          <ol className="demo-timeline-list">
            {timelinePhases.map((phase) => (
              <li className={`demo-timeline-item is-${phase.status}`} key={phase.title}>
                <span className="demo-timeline-rail">
                  <span className="demo-timeline-dot" />
                </span>
                <div className="demo-timeline-body">
                  <div className="demo-timeline-title-row">
                    <strong>{phase.title}</strong>
                    <span className={`status-pill status-pill-${phase.status === "done" ? "good" : phase.status === "current" ? "warn" : "neutral"}`}>
                      {phase.status === "done" ? "Done" : phase.status === "current" ? "Now" : "Waiting"}
                    </span>
                  </div>
                  <div className="demo-note">{phase.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </article>

        <article className="demo-card">
          <PanelTitle kicker="Verifier" title="Tally and audit" right={auditResults.length > 0 ? <span className="demo-status demo-status-good">Audited</span> : <span className="demo-status">Pending</span>} />
          <div className="demo-stack">
            <div className="demo-kv"><span>Published</span><code>{publishedVotes}</code></div>
            <div className="demo-kv"><span>Accepted</span><code>{acceptedVotes}</code></div>
            <div className="demo-kv"><span>Confirmations</span><code>{confirmationCount}</code></div>
            <div className="demo-kv"><span>Final root</span><code>{finalResult?.merkle_root ? `${finalResult.merkle_root.slice(0, 24)}...` : "Unavailable"}</code></div>
            <div className="demo-kv"><span>Spent root</span><code>{tally?.spent_commitment_root ? `${tally.spent_commitment_root.slice(0, 24)}...` : "Unavailable"}</code></div>
            <div className="button-row">
              <button className="secondary-button" onClick={() => void runVerifierAudit()} disabled={runningAudit || discoveredCoordinators.length === 0}>
                {runningAudit ? "Running audit..." : "Run audit"}
              </button>
              <a className="ghost-button link-button" href="#demo-verifier">Jump to verifier</a>
            </div>
            {perCoordinatorTallies.length > 0 && (
              <div className="demo-list">
                {perCoordinatorTallies.map((entry) => (
                  <div className="demo-list-item" key={entry.coordinatorNpub}>
                    <code>{entry.coordinatorNpub.slice(0, 18)}...</code>
                    <span>{entry.tally ? `${entry.tally.total_accepted_votes ?? 0}/${entry.tally.total_published_votes}` : "No tally"}</span>
                  </div>
                ))}
              </div>
            )}
            {auditResults.length > 0 && (
              <div className="demo-list">
                {auditResults.map((result) => (
                  <div className="demo-list-item" key={result.coordinatorNpub}>
                    <code>{result.coordinatorNpub.slice(0, 18)}...</code>
                    <span>{result.flags.length > 0 ? result.flags.join("; ") : "No audit flags"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </article>
      </section>

      <section className="demo-grid demo-grid-2">
        <article className="demo-card">
          <PanelTitle kicker="Guide" title="What to copy where" />
          <div className="demo-list">
            <a className="demo-list-item demo-list-link" href="#demo-nsec">
              <span>Paste here</span>
              <code>{identity.nsec}</code>
            </a>
            <a className="demo-list-item demo-list-link" href="#demo-identity">
              <span>Mint proof</span>
              <code>on this page</code>
            </a>
            <a className="demo-list-item demo-list-link" href="#demo-voter">
              <span>Ballot and vote</span>
              <code>on this page</code>
            </a>
            <a className="demo-list-item demo-list-link" href="#demo-verifier">
              <span>Verify and audit</span>
              <code>on this page</code>
            </a>
          </div>
        </article>

        <article className="demo-card">
          <PanelTitle kicker="Refresh" title="Snapshot details" />
          <div className="demo-stack">
            <div className="demo-note">Last refresh: {lastRefresh ? new Date(lastRefresh).toLocaleString() : "Pending"}</div>
            <div className="demo-note">Issued passes: {issuedCount}</div>
            <div className="demo-note">Coordinator count: {coordinatorCount}</div>
            <div className="demo-note">Eligibility list size: {eligibleNpubs.length}</div>
          </div>
        </article>
      </section>
    </main>
  );
}

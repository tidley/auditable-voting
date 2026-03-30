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
import { checkEligibility, fetchEligibility, type EligibilityCheckResponse, type EligibilityResponse } from "./voterManagementApi";
import { DEMO_MODE, USE_MOCK } from "./config";
import { formatDateTime } from "./nostrIdentity";
import { fetchCoordinatorInfo } from "./coordinatorApi";

type DemoStep = {
  title: string;
  detail: string;
  done: boolean;
};

const EMPTY_ELIGIBILITY: EligibilityResponse = {
  eligibleNpubs: [],
  eligibleCount: 0,
  verifiedNpubs: [],
  verifiedCount: 0,
};

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <article className="panel stat-card demo-stat-card">
      <p className="panel-kicker">{label}</p>
      <h2>{value}</h2>
      <p className="field-hint">{hint}</p>
    </article>
  );
}

function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad";
  children: ReactNode;
}) {
  return <span className={`status-pill status-pill-${tone}`}>{children}</span>;
}

function StepItem({ step }: { step: DemoStep }) {
  return (
    <li className={`demo-step ${step.done ? "demo-step-done" : ""}`}>
      <div className="demo-step-marker" aria-hidden="true" />
      <div className="demo-step-body">
        <div className="demo-step-title-row">
          <strong>{step.title}</strong>
          <span className="field-hint">{step.done ? "Live" : "Waiting"}</span>
        </div>
        <p className="field-hint">{step.detail}</p>
      </div>
    </li>
  );
}

export default function DemoApp() {
  const [coordinatorInfo, setCoordinatorInfo] = useState<CoordinatorInfo | null>(null);
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [eligibility, setEligibility] = useState<EligibilityResponse>(EMPTY_ELIGIBILITY);
  const [issuanceStatus, setIssuanceStatus] = useState<IssuanceStatusResponse | null>(null);
  const [tally, setTally] = useState<TallyInfo | null>(null);
  const [finalResult, setFinalResult] = useState<FinalResultInfo | null>(null);
  const [discoveredCoordinators, setDiscoveredCoordinators] = useState<CoordinatorDiscovery[]>([]);
  const [perCoordinatorTallies, setPerCoordinatorTallies] = useState<PerCoordinatorTally[]>([]);
  const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
  const [selectedNpub, setSelectedNpub] = useState("");
  const [voterCheck, setVoterCheck] = useState<EligibilityCheckResponse | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [checkingVoter, setCheckingVoter] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [status, setStatus] = useState<string>("Loading live demo state...");
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);

  const eligibleNpubs = eligibility.eligibleNpubs;
  const issuanceForSelected = selectedNpub ? issuanceStatus?.voters[selectedNpub] : undefined;
  const issuedCount = Object.values(issuanceStatus?.voters ?? {}).filter((entry) => entry.issued).length;
  const acceptedVotes = tally?.total_accepted_votes ?? finalResult?.total_votes ?? 0;
  const publishedVotes = tally?.total_published_votes ?? finalResult?.total_votes ?? 0;
  const coordinatorCount = discoveredCoordinators.length > 0
    ? discoveredCoordinators.length
    : election?.coordinator_npubs.length ?? 0;
  const liveProofStatus = issuanceForSelected?.issued
    ? "issued"
    : issuanceForSelected?.eligible
      ? "eligible"
      : "unknown";

  useEffect(() => {
    if (!selectedNpub && eligibleNpubs.length > 0) {
      setSelectedNpub(eligibleNpubs[0]);
    }
  }, [eligibleNpubs, selectedNpub]);

  const refreshSnapshot = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setRefreshing(true);
    }

    try {
      const [info, eligibilityResult, electionResult, tallyResult, resultResult, issuanceResult] = await Promise.all([
        fetchCoordinatorInfo(),
        fetchEligibility(),
        fetchElection(),
        fetchTally(),
        fetchResult(),
        fetchIssuanceStatus(),
      ]);

      setCoordinatorInfo(info);
      setEligibility(eligibilityResult);
      setElection(electionResult);
      setTally(tallyResult);
      setFinalResult(resultResult);
      setIssuanceStatus(issuanceResult);

      const voterList = eligibilityResult.eligibleNpubs;
      if (!selectedNpub && voterList.length > 0) {
        setSelectedNpub(voterList[0]);
      }

      let coordinators: CoordinatorDiscovery[] = [];
      if (electionResult?.event_id) {
        coordinators = await discoverCoordinators(electionResult.event_id, info.relays);
      }
      setDiscoveredCoordinators(coordinators);

      if (coordinators.length > 0) {
        const tallyResults = await fetchPerCoordinatorTallies(coordinators);
        setPerCoordinatorTallies(tallyResults);
      } else {
        setPerCoordinatorTallies([]);
      }

      setLastRefresh(Date.now());
      setStatus(`Synced live state for ${electionResult?.title ?? "the current election"}.`);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach demo services");
    } finally {
      if (showSpinner) {
        setRefreshing(false);
      }
    }
  }, [selectedNpub]);

  useEffect(() => {
    void refreshSnapshot();

    const intervalId = window.setInterval(() => {
      void refreshSnapshot(false);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [refreshSnapshot]);

  const runVerifierAudit = useCallback(async () => {
    if (!election?.event_id || discoveredCoordinators.length === 0) {
      setError("Need a discovered election before running an audit.");
      return;
    }

    setRunningAudit(true);
    setError(null);

    try {
      const audit = await runAudit(
        election.event_id,
        discoveredCoordinators,
        eligibility.eligibleNpubs,
        election.vote_end,
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
  }, [coordinatorInfo?.relays, discoveredCoordinators, election, eligibility.eligibleNpubs]);

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

  const steps: DemoStep[] = useMemo(() => [
    {
      title: "Coordinator publishes the election",
      detail: election
        ? `${election.title} is live from ${formatDateTime(election.vote_start)} to ${formatDateTime(election.vote_end)}.`
        : "Waiting for the coordinator to announce the election.",
      done: Boolean(election?.event_id),
    },
    {
      title: "Voter checks eligibility",
      detail: voterCheck
        ? `${voterCheck.npub} is ${voterCheck.allowed ? "eligible" : "not eligible"}.`
        : "Paste a voter npub and run the check.",
      done: Boolean(voterCheck?.allowed),
    },
    {
      title: "Voting pass is issued",
      detail: issuanceForSelected
        ? `${selectedNpub} is ${liveProofStatus}.`
        : "Issuance status appears after eligibility and proof minting.",
      done: Boolean(issuanceForSelected?.issued),
    },
    {
      title: "Ballot is accepted",
      detail: tally
        ? `${acceptedVotes} accepted ballot(s) out of ${publishedVotes} published.`
        : "Acceptance appears once the ballot is published and the coordinator confirms it.",
      done: Boolean(acceptedVotes > 0),
    },
    {
      title: "Verifier compares tallies",
      detail: auditResults.length > 0
        ? `${auditResults.length} coordinator audit result(s) are available.`
        : "Run the verifier audit to compare tallies and confirmations.",
      done: auditResults.length > 0,
    },
  ], [acceptedVotes, auditResults.length, election, issuanceForSelected, liveProofStatus, publishedVotes, selectedNpub, tally, voterCheck]);

  return (
    <main className="page-shell page-shell-demo">
      <section className="hero-card hero-card-demo">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Live Demo</p>
        </div>
        <h1>Watch coordinators, voters, and verifiers in one place.</h1>
        <p className="hero-copy">
          This is the demo control room. It polls the coordinator, eligibility, issuance, tally, and audit surfaces so you can narrate the full voting flow live without jumping between pages.
        </p>
        <div className="hero-metadata">
          <span>Mode</span>
          <Pill tone={DEMO_MODE ? "good" : "neutral"}>{DEMO_MODE ? "Demo enabled" : "Production data"}</Pill>
          <span>Source</span>
          <Pill tone={USE_MOCK ? "warn" : "neutral"}>{USE_MOCK ? "Mock backend" : "Live coordinator"}</Pill>
          <button className="ghost-button" onClick={() => void refreshSnapshot()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh now"}
          </button>
          {status && <span className="field-hint" style={{ margin: 0 }}>{status}</span>}
        </div>
        {error && (
          <div className="warning-box" style={{ marginTop: 16 }}>
            <p>{error}</p>
          </div>
        )}
      </section>

      <section className="demo-stat-grid">
        <StatCard label="Coordinators" value={coordinatorCount || 0} hint="Published coordinator(s) discovered for the election." />
        <StatCard label="Eligible voters" value={eligibility.eligibleCount} hint="Canonical eligible npubs." />
        <StatCard label="Issued passes" value={issuedCount} hint="Voters who already received a proof." />
        <StatCard label="Accepted ballots" value={acceptedVotes} hint="Published votes the coordinator accepted." />
      </section>

      <section className="demo-step-panel panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Live Process</p>
            <h2>What the room should be showing.</h2>
          </div>
          <span className="count-pill">
            {lastRefresh ? `Updated ${formatDateTime(lastRefresh / 1000)}` : "Waiting for data"}
          </span>
        </div>
        <ol className="demo-step-list">
          {steps.map((step) => <StepItem key={step.title} step={step} />)}
        </ol>
      </section>

      <section className="demo-panel-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Coordinator(s)</p>
              <h2>Election and relay status</h2>
            </div>
            {election?.event_id ? <Pill tone="good">Live</Pill> : <Pill tone="warn">Waiting</Pill>}
          </div>

          {election ? (
            <div className="detail-stack">
              <p className="field-hint">Election: <strong>{election.title}</strong></p>
              <p className="field-hint">ID: {election.election_id}</p>
              <p className="field-hint">Window: {formatDateTime(election.vote_start)} to {formatDateTime(election.vote_end)}</p>
              {election.confirm_end && <p className="field-hint">Confirmation window ends: {formatDateTime(election.confirm_end)}</p>}
            </div>
          ) : (
            <p className="empty-copy">No election is currently loaded from the coordinator.</p>
          )}

          {coordinatorInfo && (
            <div className="detail-stack" style={{ marginTop: 16 }}>
              <p className="field-hint">Coordinator npub: <code className="inline-code-badge">{coordinatorInfo.coordinatorNpub}</code></p>
              <p className="field-hint">Mint URL: <code className="inline-code-badge">{coordinatorInfo.mintUrl}</code></p>
              <p className="field-hint">Relays: {coordinatorInfo.relays.length > 0 ? coordinatorInfo.relays.join(", ") : "None"}</p>
            </div>
          )}

          {discoveredCoordinators.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="code-label">Discovered coordinators</p>
              <div className="demo-list">
                {discoveredCoordinators.map((coord) => (
                  <div key={coord.npub} className="demo-list-item">
                    <code>{coord.npub.slice(0, 18)}...</code>
                    <span className="field-hint">{coord.httpApi || "No HTTP API published"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="button-row" style={{ marginTop: 16 }}>
            <a className="secondary-button link-button" href="/dashboard.html">Open verifier dashboard</a>
            <a className="ghost-button link-button" href="/vote.html">Open voter portal</a>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Voter</p>
              <h2>Eligibility and voting pass</h2>
            </div>
            {issuanceForSelected?.issued ? <Pill tone="good">Issued</Pill> : <Pill tone="neutral">Pending</Pill>}
          </div>

          <label className="field-label" htmlFor="npub-input">Voter npub</label>
          <input
            id="npub-input"
            className="mint-input"
            value={selectedNpub}
            onChange={(event) => setSelectedNpub(event.target.value)}
            placeholder="npub1..."
            autoComplete="off"
            spellCheck={false}
          />
          <div className="button-row" style={{ marginTop: 12 }}>
            <button className="primary-button" onClick={() => void checkSelectedVoter()} disabled={checkingVoter}>
              {checkingVoter ? "Checking..." : "Check eligibility"}
            </button>
            <button className="secondary-button" onClick={() => void refreshSnapshot(false)} disabled={refreshing}>
              Sync status
            </button>
          </div>

          <div className="detail-stack" style={{ marginTop: 16 }}>
            {voterCheck ? (
              <>
                <p className="field-hint">Eligibility: <strong>{voterCheck.allowed ? "Eligible" : "Not eligible"}</strong></p>
                <p className="field-hint">Message: {voterCheck.message}</p>
              </>
            ) : (
              <p className="empty-copy">Run the eligibility check to show the voter path live.</p>
            )}
            {selectedNpub && issuanceForSelected && (
              <>
                <p className="field-hint">Issuance: <strong>{issuanceForSelected.issued ? "Issued" : "Not yet issued"}</strong></p>
                <p className="field-hint">Eligible: {String(issuanceForSelected.eligible)}</p>
              </>
            )}
          </div>

          {eligibleNpubs.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="code-label">Eligible npubs</p>
              <div className="demo-list">
                {eligibleNpubs.slice(0, 4).map((npub) => (
                  <div key={npub} className="demo-list-item">
                    <code>{npub.slice(0, 18)}...</code>
                    <span className="field-hint">{issuanceStatus?.voters[npub]?.issued ? "issued" : "waiting"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Verifier(s)</p>
              <h2>Acceptance and audit view</h2>
            </div>
            {auditResults.length > 0 ? <Pill tone="good">Audited</Pill> : <Pill tone="warn">Pending</Pill>}
          </div>

          <div className="detail-stack">
            <p className="field-hint">Published ballots: <strong>{publishedVotes}</strong></p>
            <p className="field-hint">Accepted ballots: <strong>{acceptedVotes}</strong></p>
            <p className="field-hint">Final result root: {finalResult ? <code className="inline-code-badge">{finalResult.merkle_root.slice(0, 24)}...</code> : "Unavailable yet"}</p>
            <p className="field-hint">Spent root: {tally?.spent_commitment_root ? <code className="inline-code-badge">{tally.spent_commitment_root.slice(0, 24)}...</code> : "Unavailable yet"}</p>
          </div>

          <div className="button-row" style={{ marginTop: 16 }}>
            <button className="secondary-button" onClick={() => void runVerifierAudit()} disabled={runningAudit || discoveredCoordinators.length === 0}>
              {runningAudit ? "Running audit..." : "Run audit"}
            </button>
          </div>

          {perCoordinatorTallies.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="code-label">Per-coordinator tallies</p>
              <div className="demo-list">
                {perCoordinatorTallies.map((entry) => (
                  <div key={entry.coordinatorNpub} className="demo-list-item">
                    <code>{entry.coordinatorNpub.slice(0, 18)}...</code>
                    <span className="field-hint">
                      {entry.tally
                        ? `${entry.tally.total_accepted_votes ?? 0} accepted / ${entry.tally.total_published_votes} published`
                        : "No tally yet"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {auditResults.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <p className="code-label">Audit findings</p>
              <div className="demo-list">
                {auditResults.map((entry) => (
                  <div key={entry.coordinatorNpub} className="demo-list-item">
                    <code>{entry.coordinatorNpub.slice(0, 18)}...</code>
                    <span className="field-hint">
                      {entry.flags.length > 0 ? entry.flags.join("; ") : "No audit flags"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}

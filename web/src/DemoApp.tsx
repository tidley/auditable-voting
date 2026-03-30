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
import {
  checkEligibility,
  fetchEligibility as fetchVoterEligibility,
  seedEligibility,
  type EligibilityCheckResponse,
  type EligibilityResponse,
} from "./voterManagementApi";
import { DEMO_MODE, USE_MOCK } from "./config";
import { formatDateTime } from "./nostrIdentity";
import { createDemoIdentity, type DemoIdentity } from "./demoIdentity";
import { fetchCoordinatorInfo } from "./coordinatorApi";
import PageNav from "./PageNav";

type StepState = {
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
  const [identity] = useState<DemoIdentity>(() => createDemoIdentity());
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
  const [checkingVoter, setCheckingVoter] = useState(false);
  const [runningAudit, setRunningAudit] = useState(false);
  const [status, setStatus] = useState<string>("Loading live demo state...");
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [seeded, setSeeded] = useState(false);

  const eligibleNpubs = eligibility.eligibleNpubs;
  const issuedCount = Object.values(issuanceStatus?.voters ?? {}).filter((entry) => entry.issued).length;
  const publishedVotes = tally?.total_published_votes ?? finalResult?.total_votes ?? 0;
  const acceptedVotes = tally?.total_accepted_votes ?? finalResult?.total_votes ?? 0;
  const confirmationCount = auditResults.length > 0 ? auditResults[0].confirmations : 0;
  const coordinatorCount = discoveredCoordinators.length || election?.coordinator_npubs.length || 0;
  const issuanceForSelected = selectedNpub ? issuanceStatus?.voters[selectedNpub] : undefined;

  const steps: StepState[] = useMemo(() => [
    {
      title: "Seed voter identity",
      detail: seeded
        ? "The generated npub has been added to the mock eligibility list."
        : "Generate an npub/nsec pair and seed it into the mock backend.",
      done: seeded,
    },
    {
      title: "Request voting pass",
      detail: voterCheck?.allowed
        ? `${voterCheck.npub} is eligible and can request the pass.`
        : "Open the voter portal, paste the nsec, and request approval.",
      done: Boolean(voterCheck?.allowed),
    },
    {
      title: "Publish ballot",
      detail: publishedVotes > 0
        ? `${publishedVotes} ballot event(s) are visible to the verifier view.`
        : "Submit the ballot from the voting page after the proof is minted.",
      done: publishedVotes > 0,
    },
    {
      title: "Send proof and confirmation",
      detail: issuedCount > 0
        ? `${issuedCount} proof(s) are stored and ready for confirmation.`
        : "The voter proof shows up once the mint step completes.",
      done: issuedCount > 0,
    },
    {
      title: "Verify tally",
      detail: auditResults.length > 0
        ? `Audit ran across ${auditResults.length} coordinator(s).`
        : "Use the verifier panel to compare tally and confirmation counts.",
      done: auditResults.length > 0 || acceptedVotes > 0,
    },
  ], [acceptedVotes, auditResults.length, issuedCount, publishedVotes, seeded, voterCheck]);

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
      if (USE_MOCK) {
        await seedEligibility(identity.npub);
      }
      setSelectedNpub(identity.npub);
      setSeeded(true);
      setStatus(`Generated voter identity: ${identity.npub}`);
      await refreshSnapshot(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to seed demo voter");
    } finally {
      setSeeding(false);
    }
  }, [identity.npub, refreshSnapshot]);

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
  }, [coordinatorInfo?.relays, discoveredCoordinators, election, eligibility.eligibleNpubs]);

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
        <article className="demo-card">
          <PanelTitle kicker="Identity" title="Ephemeral voter keypair" right={<button className="secondary-button" onClick={() => void seedDemoVoter()} disabled={seeding}>{seeding ? "Seeding..." : "Generate again"}</button>} />
          <div className="demo-note">Use this nsec in the voter portal. The npub is seeded into the mock eligibility list.</div>
          <div className="demo-copy-stack">
            <CopyField label="nsec" value={identity.nsec} />
            <CopyField label="npub" value={identity.npub} />
          </div>
          <div className="demo-note">Paste the nsec on the voter page. The voter page stores the keypair so the ballot page can publish the confirmation later.</div>
        </article>

        <article className="demo-card">
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
        <article className="demo-card">
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
              <a className="ghost-button link-button" href="/vote.html">Open voter portal</a>
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
          <PanelTitle kicker="Process" title="Live voting steps" />
          <ol className="demo-step-list">
            {steps.map((step) => (
              <li className={`demo-step ${step.done ? "is-done" : ""}`} key={step.title}>
                <span className="demo-step-dot" />
                <div>
                  <strong>{step.title}</strong>
                  <div className="demo-note">{step.detail}</div>
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
              <a className="ghost-button link-button" href="/dashboard.html">Open dashboard</a>
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
            <div className="demo-list-item"><span>Voter portal</span><code>/</code></div>
            <div className="demo-list-item"><span>Voting page</span><code>/vote.html</code></div>
            <div className="demo-list-item"><span>Verifier dashboard</span><code>/dashboard.html</code></div>
            <div className="demo-list-item"><span>Paste here</span><code>{identity.nsec}</code></div>
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

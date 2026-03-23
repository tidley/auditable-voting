import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchEligibility, resetEligibility, type EligibilityResponse } from "./voterManagementApi";
import { SimplePool } from "nostr-tools";
import { fetchCoordinatorInfo, fetchElectionsFromNostr, fetchTally, fetchElection, fetchIssuanceStatus, type TallyInfo, type ElectionInfo, type ElectionQuestion, type ElectionSummary, type IssuanceStatusResponse } from "./coordinatorApi";
import { USE_MOCK } from "./config";

const EMPTY_ELIGIBILITY: EligibilityResponse = {
  eligibleNpubs: [],
  eligibleCount: 0,
  verifiedNpubs: [],
  verifiedCount: 0
};

function QuestionBadge({ type }: { type: string }) {
  const label = type === "choice" ? "Multiple choice" : type === "scale" ? "Scale" : "Free text";
  return <span className="code-label">{label}</span>;
}

function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="detail-stack" style={{ alignItems: "center", gap: "8px" }}>
        <span className="field-hint" style={{ margin: 0 }}>{label}</span>
        <span style={{ fontWeight: 700, fontSize: "1.1rem" }}>{value}</span>
        <span className="field-hint" style={{ margin: 0, opacity: 0.6 }}>/ {max}</span>
      </div>
      <div style={{
        marginTop: 4,
        height: 6,
        borderRadius: 3,
        background: "rgba(88, 59, 39, 0.1)",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width: `${pct}%`,
          borderRadius: 3,
          background: "var(--accent)",
          transition: "width 0.5s ease",
        }} />
      </div>
    </div>
  );
}

export default function DashboardApp() {
  const [eligibility, setEligibility] = useState<EligibilityResponse>(EMPTY_ELIGIBILITY);
  const [tally, setTally] = useState<TallyInfo | null>(null);
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [allElections, setAllElections] = useState<ElectionSummary[]>([]);
  const [selectedElectionId, setSelectedElectionId] = useState<string>("");
  const [coordinatorNpub, setCoordinatorNpub] = useState("");
  const [relayList, setRelayList] = useState<string[]>([]);
  const [issuanceStatus, setIssuanceStatus] = useState<IssuanceStatusResponse | null>(null);
  const eligibleNpubs = useMemo(() => new Set(eligibility.eligibleNpubs), [eligibility]);

  const questions = useMemo(() => election?.questions ?? [], [election]);

  const loadDashboard = useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setRefreshing(true);
    }

    try {
      const [info, eligResult] = await Promise.all([
        fetchCoordinatorInfo(),
        fetchEligibility(),
      ]);
      setCoordinatorNpub(info.coordinatorNpub);
      setRelayList(info.relays);

      const elections = await fetchElectionsFromNostr([info.coordinatorNpub], info.relays);
      setAllElections(elections);

      const [tallyResult, electionResult, issuanceResult] = await Promise.all([
        fetchTally(),
        fetchElection(),
        fetchIssuanceStatus(),
      ]);
      setEligibility(eligResult);
      setTally(tallyResult);
      setElection(electionResult);
      setIssuanceStatus(issuanceResult);
      if (electionResult && !selectedElectionId) {
        setSelectedElectionId(electionResult.election_id);
      }
      setStatus("Dashboard synced.");
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach services");
    } finally {
      if (showSpinner) {
        setRefreshing(false);
      }
    }
  }, [selectedElectionId]);

  useEffect(() => {
    void loadDashboard();

    const intervalId = window.setInterval(() => {
      void loadDashboard(false);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [loadDashboard]);

  useEffect(() => {
    if (!selectedElectionId || !coordinatorNpub || relayList.length === 0) return;
    if (election?.election_id === selectedElectionId) return;

    const summary = allElections.find((e) => e.election_id === selectedElectionId);
    if (!summary) return;

    let cancelled = false;
    const pool = new SimplePool();

    (async () => {
      try {
        const publicRelays = relayList.filter((r) => r.startsWith("wss://"));
        if (publicRelays.length === 0) return;
        const events = await pool.querySync(publicRelays, {
          kinds: [38008],
          ids: [summary.event_id],
          limit: 1,
        });
        if (cancelled || events.length === 0) return;

        const content = JSON.parse(events[0].content);
        if (cancelled) return;

        setElection({
          election_id: selectedElectionId,
          event_id: summary.event_id,
          title: content.title ?? "Untitled",
          description: content.description ?? "",
          questions: content.questions ?? [],
          vote_start: (content as any).vote_start ?? (content as any).start_time ?? 0,
          vote_end: (content as any).vote_end ?? (content as any).end_time ?? 0,
          mint_urls: content.mint_urls ?? [],
          coordinator_npubs: (content as any).coordinator_npubs ?? [],
        });
        setTally(null);
      } catch {
      } finally {
        pool.close(relayList.filter((r) => r.startsWith("wss://")));
      }
    })();

    return () => { cancelled = true; };
  }, [selectedElectionId, coordinatorNpub, relayList, allElections, election?.election_id]);

  async function resetStatuses() {
    setResetting(true);
    setError(null);

    try {
      const payload = await resetEligibility();
      setEligibility(payload);
      setStatus(payload.message);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reset statuses");
    } finally {
      setResetting(false);
    }
  }

  const published = tally?.total_published_votes ?? 0;
  const accepted = tally?.total_accepted_votes ?? 0;
  const eligible = eligibility.eligibleCount;
  const isClosed = election ? Date.now() > election.vote_end * 1000 : false;
  const tallyStatusLabel = tally?.status === "closed"
    ? "Closed"
    : tally?.status === "in_progress"
      ? "In Progress"
      : tally?.status ?? "--";
  const isActiveElection = selectedElectionId && election?.election_id === selectedElectionId;
  const selectedElectionLabel = allElections.find((e) => e.election_id === selectedElectionId);

  return (
    <main className="page-shell page-shell-dashboard">
      <section className="hero-card hero-card-dashboard">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Backend Dashboard</p>
        </div>
        <h1 className="hero-title hero-title-dashboard">Monitor the election.</h1>
        <p className="hero-copy">
          {USE_MOCK
            ? "This page shows eligible npubs from the local voter config."
            : "Election data from the coordinator and Nostr relays."}
        </p>
        {allElections.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <label className="code-label" htmlFor="election-select">Election</label>
            <select
              id="election-select"
              value={selectedElectionId}
              onChange={(e) => setSelectedElectionId(e.target.value)}
              style={{
                marginTop: 4,
                padding: "8px 12px",
                borderRadius: 12,
                border: "1px solid rgba(88,59,39,0.14)",
                background: "rgba(255,255,255,0.64)",
                fontSize: "0.95rem",
                maxWidth: "100%",
                width: 420,
              }}
            >
              {allElections.map((e) => (
                <option key={e.election_id} value={e.election_id}>
                  {e.title} ({new Date(e.start_time * 1000).toLocaleDateString()})
                </option>
              ))}
            </select>
          </div>
        )}
        {allElections.length === 1 && (
          <p className="field-hint" style={{ marginTop: 8, opacity: 0.6 }}>
            1 election found on relays.
          </p>
        )}
        <div className="hero-metadata">
          <span>Source</span>
          <code className="inline-code-badge">{USE_MOCK ? "Mock server" : "Coordinator API"}</code>
          <button className="ghost-button" onClick={() => void loadDashboard()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh now"}
          </button>
          {USE_MOCK && (
            <button className="secondary-button" onClick={() => void resetStatuses()} disabled={resetting}>
              {resetting ? "Resetting..." : "Reset all npubs"}
            </button>
          )}
        </div>
      </section>

      {election && (
        <section className="content-grid">
          <article className="panel panel-wide">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Election</p>
                <h2>{election.title}</h2>
              </div>
              {isClosed && <span className="count-pill">Closed</span>}
            </div>
            {election.description && <p className="field-hint">{election.description}</p>}
            <div className="detail-stack">
              <p className="field-hint">ID: {election.election_id}</p>
              <p className="field-hint">Start: {new Date(election.vote_start * 1000).toLocaleString()}</p>
              <p className="field-hint">End: {new Date(election.vote_end * 1000).toLocaleString()}</p>
            </div>
          </article>
        </section>
      )}

      <section className="dashboard-stats-grid">
        <article className="panel stat-card">
          <p className="panel-kicker">Eligible</p>
          <h2>{eligible}</h2>
          <p className="field-hint">Total eligible npubs.</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Published</p>
          <h2>{published}</h2>
          <p className="field-hint">Ballots submitted (kind 38000).</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Accepted</p>
          <h2>{accepted}</h2>
          <p className="field-hint">Proofs burned (kind 38002).</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Participation</p>
          <h2>{eligible > 0 ? Math.round((accepted / eligible) * 100) : 0}%</h2>
          <p className="field-hint">{accepted} of {eligible} eligible voters.</p>
          <ProgressBar value={accepted} max={eligible} label="Progress" />
        </article>

        {tally && (
          <article className="panel stat-card">
            <p className="panel-kicker">Election status</p>
            <h2>{tallyStatusLabel}</h2>
            <p className="field-hint">{tally.spent_commitment_root ? `Root: ${tally.spent_commitment_root.slice(0, 16)}...` : "No commitment root yet"}</p>
          </article>
        )}

        {!USE_MOCK && !tally && (
          <article className="panel stat-card">
            <p className="panel-kicker">Tally</p>
            <h2>--</h2>
            <p className="field-hint">No tally data available yet.</p>
          </article>
        )}
      </section>

      {tally && tally.results && Object.keys(tally.results).length > 0 && (
        <section className="content-grid">
          <article className="panel panel-wide">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Results</p>
                <h2>{accepted} accepted vote{accepted !== 1 ? "s" : ""}</h2>
              </div>
            </div>
            {questions.map((q) => {
              const counts = tally.results[q.id];
              if (!counts) return null;

              return (
                <div key={q.id} style={{ marginTop: 16, padding: "14px 0", borderTop: "1px solid rgba(88,59,39,0.08)" }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                    <QuestionBadge type={q.type} />
                    <span style={{ fontWeight: 700, fontFamily: "'Iowan Old Style', serif", fontSize: "1.05rem" }}>{q.prompt}</span>
                  </div>

                  {q.type === "choice" && q.options && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {q.options.map((opt) => {
                        const count = (counts as Record<string, number>)[opt] ?? 0;
                        const pct = accepted > 0 ? Math.round((count / accepted) * 100) : 0;
                        return (
                          <div key={opt}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <span className="field-hint" style={{ margin: 0 }}>{opt}</span>
                              <span style={{ fontWeight: 700 }}>{count} ({pct}%)</span>
                            </div>
                            <div style={{
                              marginTop: 2,
                              height: 4,
                              borderRadius: 2,
                              background: "rgba(88, 59, 39, 0.08)",
                              overflow: "hidden",
                            }}>
                              <div style={{
                                height: "100%",
                                width: `${pct}%`,
                                borderRadius: 2,
                                background: "var(--accent)",
                                transition: "width 0.5s ease",
                              }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {q.type === "scale" && (
                    <div className="detail-stack">
                      {Object.entries(counts).map(([key, val]) => (
                        <span key={key} className="field-hint">
                          {key === "mean" ? "Average" : key === "median" ? "Median" : key}: {String(val)}
                          {key === "mean" && q.min != null && q.max != null && ` (scale ${q.min}-${q.max})`}
                        </span>
                      ))}
                      {(counts as Record<string, number>).count != null && (
                        <span className="field-hint" style={{ opacity: 0.6 }}>
                          {(counts as Record<string, number>).count} response{(counts as Record<string, number>).count !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                  )}

                  {q.type === "text" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {Object.entries(counts).map(([response, count]) => (
                        <div key={response} style={{ padding: "8px 12px", borderRadius: 12, background: "rgba(255,250,244,0.7)" }}>
                          <p style={{ margin: 0, fontSize: "0.9rem" }}>{response}</p>
                          <p className="field-hint" style={{ margin: "4px 0 0", opacity: 0.5 }}>{count} vote{count !== 1 ? "s" : ""}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </article>
        </section>
      )}

      <section className="content-grid">
        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Eligibility registry</p>
              <h2>Eligible npubs</h2>
            </div>
            <span className="count-pill">Auto-refresh every 5s</span>
          </div>

          {eligibility.eligibleNpubs.length > 0 ? (
            <ol className="eligible-list eligible-list-dashboard">
              {eligibility.eligibleNpubs.map((npub) => {
                const voterInfo = issuanceStatus?.voters?.[npub];
                const issued = voterInfo?.issued ?? false;
                return (
                  <li key={npub} className="eligible-list-item-dashboard">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        flexShrink: 0,
                        background: issued ? "var(--accent)" : "rgba(88,59,39,0.08)",
                        color: issued ? "#fff" : "var(--muted)",
                      }}>
                        {issued ? "\u2713" : "\u2022"}
                      </span>
                      <code style={{ fontSize: "0.82rem" }}>{npub.slice(0, 20)}...{npub.slice(-8)}</code>
                      <span className="field-hint" style={{ margin: 0, opacity: 0.5, flexShrink: 0 }}>
                        {issued ? "Proof issued" : "Pending"}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="empty-copy">No eligible npubs found.</p>
          )}
        </article>

        {(status || error) && (
          <article className="panel panel-wide">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Dashboard status</p>
                <h2>Connection health</h2>
              </div>
            </div>
            {status && <div className="notice notice-success">{status}</div>}
            {error && <div className="notice notice-error">{error}</div>}
          </article>
        )}
      </section>
    </main>
  );
}

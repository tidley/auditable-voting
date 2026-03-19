import { useEffect, useMemo, useState } from "react";
import { fetchEligibility, resetEligibility, type EligibilityResponse } from "./voterManagementApi";

const EMPTY_ELIGIBILITY: EligibilityResponse = {
  eligibleNpubs: [],
  eligibleCount: 0,
  verifiedNpubs: [],
  verifiedCount: 0
};

export default function DashboardApp() {
  const [eligibility, setEligibility] = useState<EligibilityResponse>(EMPTY_ELIGIBILITY);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const verifiedNpubs = useMemo(() => new Set(eligibility.verifiedNpubs), [eligibility.verifiedNpubs]);

  async function loadEligibility(showSpinner = true) {
    if (showSpinner) {
      setRefreshing(true);
    }

    try {
      const payload = await fetchEligibility();
      setEligibility(payload);
      setStatus("Dashboard synced from the local voter management service.");
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach voter management");
    } finally {
      if (showSpinner) {
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void loadEligibility();

    const intervalId = window.setInterval(() => {
      void loadEligibility(false);
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, []);

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

  return (
    <main className="page-shell page-shell-dashboard">
      <section className="hero-card hero-card-dashboard">
        <p className="eyebrow">Backend Dashboard</p>
        <h1>Monitor the public eligibility set.</h1>
        <p className="hero-copy">
          This page is intended for the operator view. It shows every allowed `npub` from local voter configuration. Cashu proof issuance happens through the separate Mint API flow in the voter portal.
        </p>
        <div className="hero-metadata">
          <span>Voter Management Service</span>
          <code className="inline-code-badge">Same server</code>
          <button className="ghost-button" onClick={() => void loadEligibility()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh now"}
          </button>
          <button className="secondary-button" onClick={() => void resetStatuses()} disabled={resetting}>
            {resetting ? "Resetting..." : "Reset all npubs"}
          </button>
        </div>
      </section>

      <section className="dashboard-stats-grid">
        <article className="panel stat-card">
          <p className="panel-kicker">Allowed</p>
          <h2>{eligibility.eligibleCount}</h2>
          <p className="field-hint">Total allowed npubs currently loaded from the local voter config.</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Verified</p>
          <h2>{eligibility.verifiedCount}</h2>
          <p className="field-hint">Allowed npubs that already received a proof from the mint flow.</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Pending</p>
          <h2>{eligibility.eligibleCount - eligibility.verifiedCount}</h2>
          <p className="field-hint">Allowed npubs still waiting for proof issuance.</p>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Eligibility registry</p>
              <h2>Allowed npubs</h2>
            </div>
            <span className="count-pill">Auto-refresh every 5s</span>
          </div>

          {eligibility.eligibleNpubs.length > 0 ? (
            <ol className="eligible-list eligible-list-dashboard">
              {eligibility.eligibleNpubs.map((npub) => {
                const verified = verifiedNpubs.has(npub);

                return (
                  <li key={npub} className="eligible-list-item-dashboard">
                    <div>
                      <p className="code-label">npub</p>
                      <code>{npub}</code>
                    </div>
                    <span className={verified ? "status-chip status-chip-verified" : "status-chip status-chip-pending"}>
                      {verified ? "Verified" : "Pending"}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="empty-copy">No allowed npubs are loaded in the local voter config.</p>
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

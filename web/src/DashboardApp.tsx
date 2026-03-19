import { useEffect, useMemo, useState } from "react";
import { DEFAULT_MINT_URL, fetchEligibility, normalizeMintUrl, type EligibilityResponse } from "./mintApi";

const EMPTY_ELIGIBILITY: EligibilityResponse = {
  eligibleNpubs: [],
  eligibleCount: 0,
  verifiedNpubs: [],
  verifiedCount: 0
};

export default function DashboardApp() {
  const [mintUrl, setMintUrl] = useState(DEFAULT_MINT_URL);
  const [eligibility, setEligibility] = useState<EligibilityResponse>(EMPTY_ELIGIBILITY);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const apiBaseUrl = useMemo(() => normalizeMintUrl(mintUrl) || DEFAULT_MINT_URL, [mintUrl]);
  const verifiedNpubs = useMemo(() => new Set(eligibility.verifiedNpubs), [eligibility.verifiedNpubs]);

  async function loadEligibility(showSpinner = true) {
    if (showSpinner) {
      setRefreshing(true);
    }

    try {
      const payload = await fetchEligibility(apiBaseUrl);
      setEligibility(payload);
      setStatus(`Dashboard synced from ${apiBaseUrl}.`);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reach the mint");
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
  }, [apiBaseUrl]);

  return (
    <main className="page-shell page-shell-dashboard">
      <section className="hero-card hero-card-dashboard">
        <p className="eyebrow">Backend Dashboard</p>
        <h1>Monitor the public eligibility set.</h1>
        <p className="hero-copy">
          This page is intended for the operator view. It shows every registered `npub`, which voters have completed challenge verification, and the current mint endpoint.
        </p>
        <div className="hero-metadata">
          <span>Mint API</span>
          <input
            className="mint-input"
            value={mintUrl}
            onChange={(event) => setMintUrl(event.target.value)}
            placeholder={DEFAULT_MINT_URL}
          />
          <button className="ghost-button" onClick={() => void loadEligibility()} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh now"}
          </button>
        </div>
      </section>

      <section className="dashboard-stats-grid">
        <article className="panel stat-card">
          <p className="panel-kicker">Eligible</p>
          <h2>{eligibility.eligibleCount}</h2>
          <p className="field-hint">Total registered npubs currently stored by the mint.</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Verified</p>
          <h2>{eligibility.verifiedCount}</h2>
          <p className="field-hint">Eligible npubs that completed the challenge-response flow.</p>
        </article>

        <article className="panel stat-card">
          <p className="panel-kicker">Pending</p>
          <h2>{eligibility.eligibleCount - eligibility.verifiedCount}</h2>
          <p className="field-hint">Registered npubs still waiting for challenge verification.</p>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Eligibility registry</p>
              <h2>Registered npubs</h2>
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
            <p className="empty-copy">No voters have been registered yet for this mint.</p>
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

import PageNav from "./PageNav";
import TokenFingerprint from "./TokenFingerprint";
import { tokenIdLabel } from "./tokenIdentity";

const sampleRequests = [
  { voterId: "d762h1g", shares: "5 of 5 shares requested", motion: "Motion A1", status: "ready" },
  { voterId: "m91q2pk", shares: "3 of 5 shares requested", motion: "Motion A2", status: "pending" },
  { voterId: "x4n8cbe", shares: "4 of 5 shares requested", motion: "Motion A1", status: "pending" },
];

const sampleTokens = [
  { tokenId: "6ab4d7f1c925be102cd3", vote: "YES" },
  { tokenId: "2cf99187ee4ab35190fd", vote: "NO" },
  { tokenId: "a1d93e28c77fb6405e12", vote: "YES" },
];

export default function SimpleUiApp() {
  return (
    <main className="page-shell page-shell-simple">
      <section className="hero-card simple-hero-card">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Simple Threshold UI</p>
        </div>
        <PageNav current="simple" />
        <h1 className="hero-title">Very simple coordinator and voter screens.</h1>
        <p className="hero-copy">
          This page is intentionally plain. It mirrors the paper sketch: the voter sees their anonymous ballot identity and voting action, while the coordinator sees a queue of shard requests and motion controls.
        </p>
      </section>

      <section className="simple-ui-grid">
        <article className="panel simple-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Voter</p>
              <h2>d762h1g</h2>
            </div>
            <span className="count-pill">5 of 5 shares received</span>
          </div>

          <div className="simple-voter-head">
            <TokenFingerprint tokenId="6ab4d7f1c925be102cd3" label="Anonymous ballot token d762h1g" />
            <div className="simple-voter-copy">
              <p className="field-hint">Anonymous ballot fingerprint</p>
              <p className="simple-strong">{tokenIdLabel("6ab4d7f1c925be102cd3")}</p>
              <p className="field-hint">Use this to confirm your vote appears publicly with the intended choice.</p>
            </div>
          </div>

          <div className="simple-question-card">
            <p className="panel-kicker">Vote</p>
            <h3>Do you agree with motion A1?</h3>
            <div className="simple-choice-row">
              <button type="button" className="primary-button">Yes</button>
              <button type="button" className="ghost-button">No</button>
            </div>
          </div>

          <div className="simple-confirm-card">
            <p className="field-hint">Submit vote</p>
            <p>
              You will submit <strong>YES</strong> to <strong>Motion A1</strong> with this anonymous ballot:
            </p>
            <div className="simple-submit-row">
              <TokenFingerprint tokenId="6ab4d7f1c925be102cd3" compact label="Submit ballot fingerprint" />
              <code className="code-block code-block-muted">6ab4d7f1c925be102cd3</code>
            </div>
            <div className="button-row">
              <button type="button" className="primary-button">Submit vote</button>
            </div>
          </div>
        </article>

        <article className="panel simple-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Coordinator #1</p>
              <h2>Incoming shard requests</h2>
            </div>
            <span className="count-pill">{sampleRequests.length} pending</span>
          </div>

          <div className="simple-request-list">
            {sampleRequests.map((request) => (
              <div key={request.voterId} className="simple-request-card">
                <div className="simple-request-head">
                  <div>
                    <p className="field-hint">Voter request</p>
                    <h3>{request.voterId}</h3>
                  </div>
                  <span className={`status-pill ${request.status === "ready" ? "status-pill-good" : "status-pill-neutral"}`}>
                    {request.shares}
                  </span>
                </div>
                <p className="field-hint">{request.motion}</p>
                <div className="button-row">
                  <button type="button" className="primary-button">Submit shard</button>
                  <button type="button" className="ghost-button">Ignore</button>
                </div>
              </div>
            ))}
          </div>

          <div className="simple-motion-list">
            <div className="simple-motion-card">
              <div>
                <p className="field-hint">Motion A1</p>
                <h3>Budget approval</h3>
              </div>
              <button type="button" className="secondary-button">Make live</button>
            </div>
            <div className="simple-motion-card">
              <div>
                <p className="field-hint">Motion A2</p>
                <h3>Roadmap release</h3>
              </div>
              <button type="button" className="ghost-button">Queue next</button>
            </div>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel panel-wide simple-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">TokenFingerprint Demo</p>
              <h2>Sample public ballot identities</h2>
            </div>
          </div>

          <div className="simple-fingerprint-gallery">
            {sampleTokens.map((token) => (
              <div key={token.tokenId} className="simple-fingerprint-card">
                <TokenFingerprint tokenId={token.tokenId} label={`Fingerprint ${token.tokenId}`} />
                <div>
                  <p className="field-hint">Vote</p>
                  <p className="simple-strong">{token.vote}</p>
                  <code className="code-block code-block-muted">{token.tokenId}</code>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

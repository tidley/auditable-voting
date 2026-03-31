import { useEffect, useMemo, useState } from "react";
import PageNav from "./PageNav";
import TokenFingerprint from "./TokenFingerprint";
import { loadStoredWalletBundle, type StoredWalletBundle } from "./cashuWallet";
import {
  fetchElection,
  fetchIssuanceStatus,
  normalizeElectionInfo,
  fetchPublicLedger,
  fetchTally,
  type ElectionInfo,
  type IssuanceStatusResponse,
  type PublicLedgerResponse,
  type TallyInfo,
} from "./coordinatorApi";
import { deriveTokenIdFromProofSecrets, tokenIdLabel } from "./tokenIdentity";

type SimpleChoice = "Yes" | "No";

export default function SimpleUiApp() {
  const [walletBundle, setWalletBundle] = useState<StoredWalletBundle | null>(() => loadStoredWalletBundle());
  const [election, setElection] = useState<ElectionInfo | null>(
    normalizeElectionInfo(walletBundle?.election),
  );
  const [issuanceStatus, setIssuanceStatus] = useState<IssuanceStatusResponse | null>(null);
  const [publicLedger, setPublicLedger] = useState<PublicLedgerResponse | null>(null);
  const [tally, setTally] = useState<TallyInfo | null>(null);
  const [selectedChoice, setSelectedChoice] = useState<SimpleChoice>("Yes");
  const [tokenId, setTokenId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadSnapshot() {
      try {
        const [nextElection, nextIssuance, nextLedger, nextTally] = await Promise.all([
          fetchElection(),
          fetchIssuanceStatus(),
          fetchPublicLedger(),
          fetchTally(),
        ]);

        if (cancelled) {
          return;
        }

        setElection(nextElection ?? normalizeElectionInfo(walletBundle?.election));
        setIssuanceStatus(nextIssuance);
        setPublicLedger(nextLedger);
        setTally(nextTally);
      } catch {
        if (!cancelled) {
          setElection(normalizeElectionInfo(walletBundle?.election));
        }
      }
    }

    void loadSnapshot();

    const handleStorage = () => {
      setWalletBundle(loadStoredWalletBundle());
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      cancelled = true;
      window.removeEventListener("storage", handleStorage);
    };
  }, [walletBundle?.election]);

  useEffect(() => {
    let cancelled = false;

    void deriveTokenIdFromProofSecrets(
      (walletBundle?.coordinatorProofs ?? []).map((proof) => proof.proofSecret ?? proof.proof.secret),
    ).then((nextTokenId) => {
      if (!cancelled) {
        setTokenId(nextTokenId);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [walletBundle?.coordinatorProofs]);

  const proofCount = walletBundle?.coordinatorProofs.length ?? 0;
  const expectedShares = election?.coordinator_npubs.length ?? 0;
  const issuedCount = issuanceStatus
    ? Object.values(issuanceStatus.voters).filter((entry) => entry.issued).length
    : proofCount;
  const eligibleCount = election?.eligible_count
    ?? (issuanceStatus
      ? Object.values(issuanceStatus.voters).filter((entry) => entry.eligible).length
      : 0);
  const revealedCount = publicLedger?.total_entries ?? tally?.total_published_votes ?? 0;
  const acceptedCount = tally?.total_accepted_votes ?? 0;
  const activeQuestion = election?.questions[0] ?? null;
  const choiceCopy = selectedChoice.toUpperCase();
  const voterCode = tokenIdLabel(tokenId ?? walletBundle?.ephemeralKeypair.npub ?? "pending");
  const voterReady = proofCount > 0 && Boolean(activeQuestion);
  const coordinatorCards = useMemo(
    () => [
      {
        label: "Eligible voters",
        value: eligibleCount,
        hint: "Eligibility set published before voting begins.",
      },
      {
        label: "Issued passes",
        value: issuedCount,
        hint: "Blind-signature shares or proofs issued so far.",
      },
      {
        label: "Revealed ballots",
        value: revealedCount,
        hint: "Public ballot identities visible after reveal.",
      },
      {
        label: "Accepted votes",
        value: acceptedCount,
        hint: "Coordinator burn receipts confirmed.",
      },
    ],
    [acceptedCount, eligibleCount, issuedCount, revealedCount],
  );

  return (
    <main className="page-shell page-shell-simple">
      <section className="hero-card simple-hero-card">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Simple Voting Surfaces</p>
        </div>
        <PageNav current="simple" />
        <h1 className="hero-title">Same flow, stripped down for the coordinator and the voter.</h1>
        <p className="hero-copy">
          This screen reuses the live election and wallet state from the real app. The left side is a minimal voter view. The right side is the corresponding coordinator summary.
        </p>
        <div className="hero-metadata">
          <span>Election</span>
          <code className="inline-code-badge">{election?.title ?? "Loading election"}</code>
          <span>Shares</span>
          <code className="inline-code-badge">{proofCount} / {expectedShares || "--"}</code>
          <span>Ballot identity</span>
          <code className="inline-code-badge">{tokenId ? tokenIdLabel(tokenId) : "Not minted yet"}</code>
        </div>
      </section>

      <section className="simple-ui-grid">
        <article className="panel simple-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Voter view</p>
              <h2>{voterCode}</h2>
            </div>
            <span className="count-pill">{proofCount} of {expectedShares || "?"} shares received</span>
          </div>

          <div className="simple-voter-head">
            {tokenId ? (
              <TokenFingerprint tokenId={tokenId} label={`Anonymous ballot token ${tokenIdLabel(tokenId)}`} />
            ) : (
              <div className="simple-placeholder-box">
                <p className="field-hint">No ballot identity yet</p>
                <p className="simple-strong">Mint your pass first</p>
              </div>
            )}
            <div className="simple-voter-copy">
              <p className="field-hint">Anonymous ballot fingerprint</p>
              <p className="simple-strong">{tokenId ? tokenIdLabel(tokenId) : "Unavailable"}</p>
              <p className="field-hint">
                Each voter can match this color fingerprint and QR against the public reveal ledger after the vote is accepted.
              </p>
            </div>
          </div>

          <div className="simple-question-card">
            <p className="panel-kicker">Vote</p>
            <h3>{activeQuestion?.prompt ?? "Waiting for election question..."}</h3>
            {activeQuestion?.description && <p className="field-hint">{activeQuestion.description}</p>}
            <div className="simple-choice-row">
              <button
                type="button"
                className={selectedChoice === "Yes" ? "primary-button" : "ghost-button"}
                onClick={() => setSelectedChoice("Yes")}
              >
                Yes
              </button>
              <button
                type="button"
                className={selectedChoice === "No" ? "primary-button" : "ghost-button"}
                onClick={() => setSelectedChoice("No")}
              >
                No
              </button>
            </div>
          </div>

          <div className="simple-confirm-card">
            <p className="field-hint">Submit vote</p>
            <p>
              {voterReady
                ? <>You are ready to submit <strong>{choiceCopy}</strong> with this anonymous ballot identity.</>
                : "Finish issuance before continuing into the full ballot submission flow."}
            </p>
            <div className="simple-submit-row">
              {tokenId ? (
                <TokenFingerprint tokenId={tokenId} compact showQr={false} label="Submit ballot fingerprint" />
              ) : (
                <div className="simple-placeholder-chip">Pending</div>
              )}
              <code className="code-block code-block-muted">{tokenId ?? "No token_id yet"}</code>
            </div>
            <div className="button-row">
              <a className="primary-button link-button" href="/vote.html">
                Continue to ballot page
              </a>
              <a className="ghost-button link-button" href="/">
                Open control room
              </a>
            </div>
          </div>
        </article>

        <article className="panel simple-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Coordinator view</p>
              <h2>{election?.title ?? "Election snapshot"}</h2>
            </div>
            <span className="count-pill">{revealedCount} visible ballots</span>
          </div>

          <div className="simple-meta-grid">
            {coordinatorCards.map((card) => (
              <div key={card.label} className="simple-data-tile">
                <p className="panel-kicker">{card.label}</p>
                <strong>{card.value}</strong>
                <p className="field-hint">{card.hint}</p>
              </div>
            ))}
          </div>

          <div className="simple-request-list">
            <div className="simple-request-card">
              <div className="simple-request-head">
                <div>
                  <p className="field-hint">Issuance queue</p>
                  <h3>{Math.max((eligibleCount || 0) - issuedCount, 0)} voter requests pending</h3>
                </div>
                <span className="status-pill status-pill-neutral">
                  {issuedCount} issued
                </span>
              </div>
              <p className="field-hint">
                Approvals stay public as counts and receipts. Proof identities only become public after reveal and burn.
              </p>
              <div className="button-row">
                <a className="primary-button link-button" href="/dashboard.html">
                  Open coordinator dashboard
                </a>
                <a className="ghost-button link-button" href="/">
                  Open live control room
                </a>
              </div>
            </div>

            <div className="simple-request-card">
              <div className="simple-request-head">
                <div>
                  <p className="field-hint">Motion status</p>
                  <h3>{activeQuestion?.prompt ?? "Waiting for active motion"}</h3>
                </div>
                <span className="status-pill status-pill-good">
                  {acceptedCount} accepted
                </span>
              </div>
              <p className="field-hint">
                The simple coordinator surface is now tied to the real election, issuance, and tally endpoints rather than static sketch data.
              </p>
            </div>
          </div>
        </article>
      </section>

      <section className="content-grid">
        <article className="panel panel-wide simple-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Public ballot identity</p>
              <h2>Fingerprint and QR demo</h2>
            </div>
          </div>
          <p className="field-hint">
            The colored fingerprint helps visual recognition. The QR beside it carries the same token identifier in a scannable form.
          </p>
          <div className="simple-fingerprint-gallery">
            {tokenId ? (
              <div className="simple-fingerprint-card">
                <TokenFingerprint tokenId={tokenId} label={`Fingerprint ${tokenId}`} />
                <div>
                  <p className="field-hint">Current local ballot identity</p>
                  <p className="simple-strong">{choiceCopy}</p>
                  <code className="code-block code-block-muted">{tokenId}</code>
                </div>
              </div>
            ) : (
              <div className="simple-fingerprint-card">
                <div className="simple-placeholder-box">
                  <p className="field-hint">Mint a token to see the live fingerprint here.</p>
                </div>
              </div>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}

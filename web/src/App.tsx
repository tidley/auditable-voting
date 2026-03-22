import { useCallback, useEffect, useMemo, useState } from "react";
import { logClaimDebug } from "./cashuMintApi";
import { loadStoredWalletBundle, storeWalletBundle, storeProof } from "./cashuWallet";
import { checkEligibility, type EligibilityCheckResponse } from "./voterManagementApi";
import {
  createCashuClaimEvent,
  deriveNpubFromNsec,
  formatDateTime,
  getNostrEventVerificationUrl,
  isValidNpub,
  publishCashuClaim,
  signCashuClaimEvent
} from "./nostrIdentity";
import { fetchCoordinatorInfo, fetchElectionsFromNostr, fetchElection, type CoordinatorInfo, type ElectionInfo, type ElectionQuestion, type ElectionSummary } from "./coordinatorApi";
import { checkQuoteStatus, createMintQuote, type MintQuoteResponse } from "./mintApi";
import { requestQuoteAndMint, type CashuProof } from "./cashuBlind";
import { MINT_URL, USE_MOCK } from "./config";
import {
  createRawSigner,
  createNip07Signer,
  startSignerDetection,
  type NostrSigner,
  type SignerMode
} from "./signer";

type PublishResult = {
  eventId: string;
  successes: number;
  failures: number;
};

export default function App() {
  const [coordinatorInfo, setCoordinatorInfo] = useState<CoordinatorInfo | null>(null);
  const [electionInfo, setElectionInfo] = useState<ElectionInfo | null>(null);
  const [nsecInput, setNsecInput] = useState("");
  const [mintQuote, setMintQuote] = useState<MintQuoteResponse | null>(null);
  const [quoteState, setQuoteState] = useState<"UNPAID" | "PAID" | "ISSUED" | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [currentProof, setCurrentProof] = useState<CashuProof | null>(null);
  const [walletBundle, setWalletBundle] = useState(() => loadStoredWalletBundle());
  const [eligibilityResult, setEligibilityResult] = useState<EligibilityCheckResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [requestingQuote, setRequestingQuote] = useState(false);
  const [publishingClaim, setPublishingClaim] = useState(false);
  const [pollingQuote, setPollingQuote] = useState(false);
  const [mintingTokens, setMintingTokens] = useState(false);
  const [signerMode, setSignerMode] = useState<SignerMode>("raw");
  const [signer, setSigner] = useState<NostrSigner | null>(null);
  const [nip07Pubkey, setNip07Pubkey] = useState<string | null>(null);
  const [nip07Scanning, setNip07Scanning] = useState(false);
  const [allElections, setAllElections] = useState<ElectionSummary[]>([]);
  const [electionsLoading, setElectionsLoading] = useState(false);

  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);
  const activeNpub = signerMode === "nip07" && nip07Pubkey ? nip07Pubkey : derivedNpub;
  const npubIsValid = activeNpub ? isValidNpub(activeNpub) : false;
  const canRequestQuote = Boolean(eligibilityResult?.canProceed && !requestingQuote);

  const coordinatorNpub = coordinatorInfo?.coordinatorNpub ?? "";
  const mintUrl = coordinatorInfo?.mintUrl ?? MINT_URL;
  const relays = coordinatorInfo?.relays ?? [];
  const electionId = electionInfo?.election_id ?? "";
  const questions: ElectionQuestion[] = electionInfo?.questions ?? [];

  const activeMintUrl = useMemo(() => mintUrl.replace(/\/$/, ""), [mintUrl]);

  async function handleElectionSelect(electionId: string) {
    if (electionId === electionInfo?.election_id) return;
    const summary = allElections.find((e) => e.election_id === electionId);
    if (!summary) return;
    const { SimplePool } = await import("nostr-tools");
    const pool = new SimplePool();
    const publicRelays = relays.filter((r) => r.startsWith("wss://"));
    try {
      if (publicRelays.length === 0) return;
      const events = await pool.querySync(publicRelays, { kinds: [38008], ids: [summary.event_id], limit: 1 });
      if (events.length === 0) return;
      const content = JSON.parse(events[0].content);
      setElectionInfo({
        election_id: electionId,
        event_id: summary.event_id,
        title: content.title ?? "Untitled",
        description: content.description ?? "",
        questions: content.questions ?? [],
        start_time: content.start_time ?? 0,
        end_time: content.end_time ?? 0,
        mint_urls: content.mint_urls ?? [],
      });
      setMintQuote(null);
      setQuoteState(null);
      setPublishResult(null);
      setCurrentProof(null);
      setEligibilityResult(null);
      setStatus(`Switched to election: ${content.title ?? electionId}`);
    } catch {
      setError("Failed to load election from Nostr");
    } finally {
      pool.close(publicRelays);
    }
  }

  const claimVerificationUrl = useMemo(() => {
    if (!publishResult || publishResult.successes < 1) {
      return null;
    }

    return getNostrEventVerificationUrl({
      eventId: publishResult.eventId,
      relays
    });
  }, [publishResult, relays]);

  useEffect(() => {
    async function discover() {
      setDiscoveryLoading(true);
      setElectionsLoading(true);
      try {
        const [info, election] = await Promise.all([
          fetchCoordinatorInfo(),
          fetchElection()
        ]);
        setCoordinatorInfo(info);
        setElectionInfo(election);
        setStatus(`Connected to coordinator. Election: ${election?.title ?? "none"}`);

        const elections = await fetchElectionsFromNostr(info.coordinatorNpub, info.relays);
        setAllElections(elections);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reach coordinator");
      } finally {
        setDiscoveryLoading(false);
        setElectionsLoading(false);
      }
    }

    void discover();
  }, []);

  useEffect(() => {
    const stop = startSignerDetection((result) => {
      if (result.mode === "nip07" && result.signer) {
        setSignerMode("nip07");
        setSigner(result.signer);
        setNip07Scanning(false);
        result.signer.getNpub().then((npub) => setNip07Pubkey(npub)).catch(() => {});
      }
    });
    setNip07Scanning(signerMode === "nip07" && !nip07Pubkey);
    return () => { stop(); setNip07Scanning(false); };
  }, []);

  useEffect(() => {
    resetEligibilityFlow();
    if (npubIsValid && activeNpub && coordinatorInfo) {
      void checkNpubAccess();
    }
  }, [activeNpub, npubIsValid, coordinatorInfo]);

  function resetIssuanceFlow() {
    setMintQuote(null);
    setQuoteState(null);
    setPublishResult(null);
    setCurrentProof(null);
    setPollingQuote(false);
  }

  function resetEligibilityFlow() {
    setEligibilityResult(null);
    resetIssuanceFlow();
  }

  const checkNpubAccess = useCallback(async () => {
    if (!npubIsValid || !activeNpub) {
      setError("Connect a signer to derive your npub before checking eligibility.");
      return;
    }

    setLoading(true);
    setStatus(null);
    setError(null);
    resetEligibilityFlow();

    try {
      const payload = await checkEligibility(activeNpub);
      setEligibilityResult(payload);
      setStatus(payload.message);

      if (!payload.allowed) {
        window.alert("This npub is not in the eligible list.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Eligibility check failed");
    } finally {
      setLoading(false);
    }
  }, [npubIsValid, activeNpub]);

  const requestQuote = useCallback(async () => {
    if (!eligibilityResult?.canProceed) {
      setError("Check that your npub is eligible before requesting a quote.");
      return;
    }

    setRequestingQuote(true);
    setStatus(null);
    setError(null);
    resetIssuanceFlow();

    try {
      const quote = await createMintQuote();
      setMintQuote(quote);
      setQuoteState("UNPAID");

      storeWalletBundle({
        proof: null,
        election: electionInfo ? {
          electionId: electionInfo.election_id,
          title: electionInfo.title,
          questions: electionInfo.questions,
          start_time: electionInfo.start_time,
          end_time: electionInfo.end_time,
          mint_urls: electionInfo.mint_urls
        } : null,
        quote: {
          quoteId: quote.quote,
          bolt11: quote.request
        },
        coordinatorNpub,
        mintUrl: activeMintUrl,
        relays
      });
      setWalletBundle(loadStoredWalletBundle());
      setStatus(`Quote ${quote.quote} created. Publish your claim to request approval.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not request quote");
    } finally {
      setRequestingQuote(false);
    }
  }, [eligibilityResult, electionInfo, coordinatorNpub, activeMintUrl, relays]);

  const publishInvoiceClaim = useCallback(async () => {
    if (!mintQuote) {
      setError("Request a quote first.");
      window.alert("Request a quote first.");
      return;
    }

    if (signerMode === "raw" && !derivedNpub) {
      setError("Enter a valid nsec to sign the claim.");
      window.alert("Enter a valid nsec to sign the claim.");
      return;
    }

    setPublishingClaim(true);
    setStatus(null);
    setError(null);

    try {
      let event;

      if (signer && signerMode === "nip07") {
        event = await signCashuClaimEvent(
          signer,
          coordinatorNpub,
          activeMintUrl,
          mintQuote.quote,
          mintQuote.request,
          electionId
        );
      } else {
        event = createCashuClaimEvent(
          nsecInput,
          coordinatorNpub,
          activeMintUrl,
          mintQuote.quote,
          mintQuote.request,
          electionId
        );
      }

      const result = await publishCashuClaim(relays, event);

      try {
        await logClaimDebug({
          npub: activeNpub ?? "",
          coordinatorNpub,
          mintApiUrl: activeMintUrl,
          relays,
          quoteId: mintQuote.quote,
          invoice: mintQuote.request,
          event: {
            id: event.id,
            pubkey: event.pubkey,
            kind: event.kind,
            created_at: event.created_at,
            content: event.content,
            tags: event.tags,
            sig: event.sig
          },
          publishResult: result
        });
      } catch {
        console.warn("[voter] failed to send claim debug log");
      }

      setPublishResult(result);
      setPollingQuote(true);

      if (result.failures > 0) {
        const failedRelayMessage = result.relayResults
          .filter((rr) => !rr.success)
          .map((rr) => `${rr.relay}: ${rr.error ?? "Unknown error"}`)
          .join("\n");
        window.alert(`Some relays rejected the claim publish:\n${failedRelayMessage}`);
      }

      if (result.successes > 0) {
        setStatus(`Claim published to ${result.successes} relay${result.successes === 1 ? "" : "s"}. Waiting for coordinator approval...`);
      } else {
        setStatus("Relay publish did not confirm. The coordinator may not see your claim.");
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Could not publish invoice claim";
      setError(message);
      window.alert(message);
    } finally {
      setPublishingClaim(false);
    }
  }, [mintQuote, derivedNpub, nsecInput, coordinatorNpub, activeMintUrl, electionId, relays, activeNpub, signer, signerMode]);

  const pollQuoteAndMint = useCallback(async () => {
    if (!mintQuote) return;

    try {
      const status = await checkQuoteStatus(mintQuote.quote);
      setQuoteState(status.state);
      console.log("[poll] quote", mintQuote.quote, "state:", status.state);

      if (status.state === "UNPAID") {
        setStatus("Waiting for coordinator to approve quote...");
        return;
      }

      if (status.state === "PAID") {
        setPollingQuote(false);
        console.log("[poll] quote", mintQuote.quote, "approved, minting tokens...");
        setStatus("Quote approved! Minting tokens...");
        setMintingTokens(true);

        try {
          const mintResult = await requestQuoteAndMint(MINT_URL.replace(/\/$/, ""), mintQuote.quote);
          const proof = mintResult.proofs[0];

          if (proof) {
            console.log("[poll] proof received for quote", mintQuote.quote, "keyset:", proof.id);
            setCurrentProof(proof);
            storeProof(proof);
            setWalletBundle(loadStoredWalletBundle());
            setStatus(`Cashu proof received.`);
          } else {
            setError("Mint returned no proofs.");
          }
        } catch (mintError) {
          console.error("[poll] minting failed for quote", mintQuote.quote, mintError);
          setError(mintError instanceof Error ? mintError.message : "Token minting failed");
        } finally {
          setMintingTokens(false);
        }
      }
    } catch (requestError) {
      console.error("[poll] quote status check failed for quote", mintQuote.quote, requestError);
      setPollingQuote(false);
      setError(requestError instanceof Error ? requestError.message : "Quote status check failed");
    }
  }, [mintQuote, activeMintUrl]);

  useEffect(() => {
    if (!pollingQuote || !mintQuote) return;

    let cancelled = false;

    void pollQuoteAndMint();

    const intervalId = window.setInterval(() => {
      if (!cancelled) {
        void pollQuoteAndMint();
      }
    }, USE_MOCK ? 2500 : 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [pollingQuote, mintQuote, pollQuoteAndMint]);

  const quoteStateLabel = quoteState === "UNPAID"
    ? "Waiting for coordinator approval"
    : quoteState === "PAID"
      ? "Approved -- minting tokens"
      : quoteState === "ISSUED"
        ? "Tokens issued"
        : null;

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Voter Portal</p>
        </div>
        <h1 className="hero-title">Check your eligible npub and mint a Cashu voting proof.</h1>
        <p className="hero-copy">
          Enter an eligible `npub`, request a quote from the Mint API, sign that quote claim with your `nsec`, publish it to Nostr relays, then receive a proof into your local wallet.
        </p>

        {discoveryLoading ? (
          <p className="field-hint hero-hint">Discovering coordinator...</p>
        ) : coordinatorInfo ? (
          <div className="hero-metadata">
            <span>Coordinator</span>
            <code className="inline-code-badge">{coordinatorNpub.slice(0, 20)}...</code>
            <span><img className="inline-icon" src="/images/bitcoin-logo.png" alt="" width={18} height={18} />Mint</span>
            <code className="inline-code-badge">{activeMintUrl}</code>
            {allElections.length > 1 && (
              <select
                value={electionInfo?.election_id ?? ""}
                onChange={(e) => void handleElectionSelect(e.target.value)}
                disabled={electionsLoading}
                style={{
                  padding: "4px 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(88,59,39,0.14)",
                  background: "rgba(255,255,255,0.64)",
                  fontSize: "0.85rem",
                  maxWidth: 260,
                }}
              >
                {allElections.map((e) => (
                  <option key={e.election_id} value={e.election_id}>
                    {e.title} ({new Date(e.start_time * 1000).toLocaleDateString()})
                  </option>
                ))}
              </select>
            )}
            {electionInfo && !electionsLoading && allElections.length <= 1 && (
              <>
                <span>Election</span>
                <code className="inline-code-badge">{electionInfo.title}</code>
              </>
            )}
            {electionInfo && electionInfo.start_time > 0 && (
              <span className="field-hint">
                {formatDateTime(electionInfo.start_time)} -- {formatDateTime(electionInfo.end_time)}
              </span>
            )}
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <img className="empty-state-image" src="/images/nostr/underconstruction-dark.png" alt="" width={160} />
            <p className="field-hint hero-hint" style={{ color: "var(--muted)" }}>
              Could not reach coordinator. Mock mode may be active.
            </p>
          </div>
        )}
        <img className="hero-accent-image" src="/images/black-hat.webp" alt="" width={140} />
      </section>

      <section className="content-grid">
        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Signer</p>
              <h2>Choose how to sign</h2>
            </div>
          </div>

          <div className="signer-mode-selector">
            <button
              type="button"
              className={`signer-mode-option${signerMode === "nip07" ? " active" : ""}`}
              onClick={() => {
                setSignerMode("nip07");
                try {
                  const s = createNip07Signer();
                  setSigner(s);
                } catch {
                  setSigner(null);
                }
              }}
            >
              Browser Extension
            </button>
            <button
              type="button"
              className={`signer-mode-option${signerMode === "raw" ? " active" : ""}`}
              onClick={() => {
                setSignerMode("raw");
                setSigner(null);
              }}
            >
              Paste nsec
            </button>
          </div>

          {signerMode === "nip07" && nip07Pubkey ? (
            <div className="signer-status">
              <span style={{ fontWeight: 700 }}>Connected</span>
              <code className="code-block code-block-muted" style={{ fontSize: "0.85rem", padding: "6px 10px" }}>{nip07Pubkey}</code>
              {activeNpub && (
                <div style={{ marginTop: 12 }}>
                  <div className="validation-row">
                    <span className={eligibilityResult?.canProceed ? "validation-ok" : eligibilityResult ? "validation-warn" : "validation-warn"}>
                      {eligibilityResult?.canProceed
                        ? "\u2713 Eligible npub confirmed"
                        : eligibilityResult && !eligibilityResult.canProceed
                          ? "\u2717 Not on the eligibility list"
                          : loading
                            ? "Checking eligibility..."
                            : "Checking whether this npub is on the eligible list"}
                    </span>
                  </div>
                </div>
              )}
            </div>
          ) : signerMode === "nip07" && nip07Scanning ? (
            <p className="empty-copy">Scanning for NIP-07 extension...</p>
          ) : signerMode === "nip07" ? (
            <p className="empty-copy">No NIP-07 extension detected. Install Alby, nos2x, or NostrKey, then reload.</p>
          ) : null}

          {signerMode === "raw" && (
            <>
              <div className="warning-box">
                <strong>Protect the nsec.</strong>
                <p>
                  `nsec` is your private key. Anyone who gets it can act as you. This page signs locally in the browser and never sends `nsec` to the coordinator or the mint API.
                </p>
              </div>

              <label className="field-label" htmlFor="nsec-input">nsec</label>
              <textarea
                id="nsec-input"
                className="text-area text-area-secret"
                value={nsecInput}
                onChange={(event) => setNsecInput(event.target.value)}
                placeholder="nsec1..."
                rows={4}
              />
              <p className="field-hint">
                Paste your `nsec`. The browser derives your `npub` locally.
              </p>

              {derivedNpub && (
                <div className="derived-box">
                  <p className="code-label">Derived npub</p>
                  <code className="code-block code-block-muted">{derivedNpub}</code>
                </div>
              )}

              {activeNpub && (
                <div style={{ marginTop: 16 }}>
                  <div className="validation-row">
                    <span className={eligibilityResult?.canProceed ? "validation-ok" : eligibilityResult ? "validation-warn" : "validation-warn"}>
                      {eligibilityResult?.canProceed
                        ? "\u2713 Eligible npub confirmed"
                        : eligibilityResult && !eligibilityResult.canProceed
                          ? "\u2717 Not on the eligibility list"
                          : loading
                            ? "Checking eligibility..."
                            : "Checking whether this npub is on the eligible list"}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          <img className="panel-accent-image" src="/images/nostr/gmnotes.png" alt="" width={120} />
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 2</p>
              <h2>Get your voter proof</h2>
            </div>
            {currentProof && <span className="count-pill">Proof received</span>}
            {quoteStateLabel && <span className="count-pill">{quoteStateLabel}</span>}
          </div>

          <div className="verification-grid">
            <div>
              <div className="substep-card">
                <p className="code-label">Step 2.1</p>
                <h3 className="substep-title">Request quote from Mint</h3>
                <p className="field-hint substep-copy">
                  Once your npub passes the eligibility check, ask the Mint API for an issuance quote.
                </p>
                <div className="button-row button-row-tight">
                  <button className="secondary-button" onClick={() => void requestQuote()} disabled={!canRequestQuote}>
                    {requestingQuote ? "Requesting..." : "Request quote"}
                  </button>
                </div>
              </div>

              <div className="challenge-card challenge-card-spaced">
                <p className="code-label">Mint quote</p>
                {mintQuote ? (
                  <div className="detail-stack">
                    <code className="code-block code-block-muted">{mintQuote.request}</code>
                    <p className="field-hint">Quote: {mintQuote.quote}</p>
                    <p className="field-hint">Amount: {mintQuote.amount} {mintQuote.unit}</p>
                    <p className="field-hint">State: {quoteState ?? "unknown"}</p>
                  </div>
                ) : (
                  <p className="empty-copy">No quote requested yet.</p>
                )}
              </div>
            </div>

            <div className="challenge-column">
              <div className="substep-card">
                <p className="code-label">Step 2.2</p>
                <h3 className="substep-title">Sign quote and publish</h3>
                <p className="field-hint substep-copy">
                  {signerMode === "nip07"
                    ? "Your browser extension will sign the claim. No private key is exposed to this page."
                    : "Your nsec will sign the claim locally and publish it to Nostr relays."}
                </p>
              </div>

              <div className="button-row">
                <button
                  className="primary-button"
                  onClick={() => void publishInvoiceClaim()}
                  disabled={
                    !mintQuote || publishingClaim ||
                    (signerMode === "raw" && !derivedNpub) ||
                    (signerMode === "nip07" && !signer)
                  }
                >
                  {publishingClaim ? "Publishing..." : "Sign and publish claim"}
                </button>
              </div>

              <div className="validation-row">
                <span className={
                  signerMode === "nip07"
                    ? (signer ? "validation-ok" : "validation-warn")
                    : (derivedNpub ? "validation-ok" : "validation-warn")
                }>
                  {signerMode === "nip07"
                    ? (signer ? "Extension ready to sign" : "No extension connected")
                    : derivedNpub
                      ? "Signer ready"
                      : "Enter a valid nsec in the Signer panel"}
                </span>
              </div>

              {publishResult && (
                <div className="notice notice-success">
                  Claim event `{publishResult.eventId}` attempted on {publishResult.successes + publishResult.failures} relay{publishResult.successes + publishResult.failures === 1 ? "" : "s"}; {publishResult.successes} success, {publishResult.failures} failure.
                  {claimVerificationUrl && (
                    <a className="notice-link" href={claimVerificationUrl} target="_blank" rel="noreferrer">
                      Verify this claim event on njump
                    </a>
                  )}
                </div>
              )}

              {currentProof && (
                <div className="notice notice-success">
                  Proof received and stored as your single voting proof.
                </div>
              )}
            </div>
          </div>
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Wallet</p>
              <h2>Your voting proof</h2>
            </div>
            <span className="count-pill">{walletBundle?.proof ? "1 proof" : "No proof"}</span>
          </div>

          {walletBundle?.proof ? (
            <div className="derived-box">
              <p className="code-label">Proof</p>
              <code className="code-block code-block-muted">{JSON.stringify(walletBundle.proof, null, 2)}</code>
              <p className="field-hint">Election {walletBundle.election?.electionId ?? "unknown"}</p>
              <p className="field-hint">Keyset {walletBundle.proof.id}</p>
              <p className="field-hint">Amount {walletBundle.proof.amount}</p>
            </div>
          ) : (
            <p className="empty-copy">No proof stored yet. Request a quote, publish the signed claim, and wait for the mint proof.</p>
          )}

          {walletBundle?.proof && (
            <div className="button-row">
              <a className="primary-button link-button cta-link-button" href="/vote.html">Go To Voting Page</a>
            </div>
          )}
        </article>

        {(status || error) && (
          <article className="panel panel-wide">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Latest update</p>
                <h2>Status</h2>
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

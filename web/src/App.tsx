import { useEffect, useMemo, useState } from "react";
import { fetchMintProof, logClaimDebug, requestMintInvoice, type CashuProof, type MintInvoiceResponse } from "./cashuMintApi";
import { loadStoredWalletBundle, storeProof, storeWalletBundle } from "./cashuWallet";
import { checkEligibility, type EligibilityCheckResponse } from "./voterManagementApi";
import {
  createCashuClaimEvent,
  deriveNpubFromNsec,
  formatDateTime,
  getNostrEventVerificationUrl,
  isValidNpub,
  publishCashuClaim
} from "./nostrIdentity";

const DEFAULT_MINT_URL = "http://localhost:8787/mock-mint";

function normalizeMintUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

type PublishResult = {
  eventId: string;
  successes: number;
  failures: number;
};

export default function App() {
  const [mintApiUrl, setMintApiUrl] = useState(DEFAULT_MINT_URL);
  const [npubInput, setNpubInput] = useState("");
  const [nsecInput, setNsecInput] = useState("");
  const [invoiceQuote, setInvoiceQuote] = useState<MintInvoiceResponse | null>(null);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [currentProof, setCurrentProof] = useState<CashuProof | null>(null);
  const [walletBundle, setWalletBundle] = useState(() => loadStoredWalletBundle());
  const [eligibilityResult, setEligibilityResult] = useState<EligibilityCheckResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestingInvoice, setRequestingInvoice] = useState(false);
  const [publishingClaim, setPublishingClaim] = useState(false);
  const [checkingProof, setCheckingProof] = useState(false);
  const [proofPollingActive, setProofPollingActive] = useState(false);

  const normalizedMintApiUrl = useMemo(() => normalizeMintUrl(mintApiUrl) || DEFAULT_MINT_URL, [mintApiUrl]);
  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);
  const claimVerificationUrl = useMemo(() => {
    if (!publishResult || !invoiceQuote || publishResult.successes < 1) {
      return null;
    }

    return getNostrEventVerificationUrl({
      eventId: publishResult.eventId,
      relays: invoiceQuote.relays
    });
  }, [invoiceQuote, publishResult]);
  const npubIsValid = isValidNpub(npubInput);
  const nsecMatchesNpub = Boolean(derivedNpub && (invoiceQuote ? invoiceQuote.npub === derivedNpub : npubInput.trim() === derivedNpub));
  const canRequestInvoice = Boolean(eligibilityResult?.canProceed && !requestingInvoice);

  function resetIssuanceFlow() {
    setInvoiceQuote(null);
    setPublishResult(null);
    setCurrentProof(null);
    setProofPollingActive(false);
  }

  function resetEligibilityFlow() {
    setEligibilityResult(null);
    resetIssuanceFlow();
  }

  async function checkNpubAccess() {
    if (!npubIsValid) {
      setError("Enter a valid npub before checking eligibility.");
      return;
    }

    setLoading(true);
    setStatus(null);
    setError(null);
    resetEligibilityFlow();

    try {
      const payload = await checkEligibility(npubInput.trim());
      setEligibilityResult(payload);
      setStatus(payload.message);

      if (!payload.allowed) {
        window.alert("This npub is not in the allowed list.");
      } else if (payload.hasVoted) {
        window.alert("This npub has already voted.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Eligibility check failed");
    } finally {
      setLoading(false);
    }
  }

  async function requestInvoice() {
    if (!eligibilityResult?.canProceed) {
      setError("Check that your npub is allowed and has not voted yet before requesting an invoice.");
      return;
    }

    setRequestingInvoice(true);
    setStatus(null);
    setError(null);
    setPublishResult(null);
    setCurrentProof(null);
    setProofPollingActive(false);

    try {
      const payload = await requestMintInvoice(normalizedMintApiUrl);
      setInvoiceQuote(payload);
      storeWalletBundle({
        proof: null,
        invoice: payload
      });
      setWalletBundle(loadStoredWalletBundle());
      setStatus(`Mint invoice created for ${payload.npub}. Sign and publish the claim before ${formatDateTime(payload.expiresAt)}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not request invoice");
    } finally {
      setRequestingInvoice(false);
    }
  }

  async function publishInvoiceClaim() {
    if (!invoiceQuote) {
      setError("Request an invoice first.");
      window.alert("Request an invoice first.");
      return;
    }

    if (!nsecMatchesNpub) {
      setError("The provided nsec does not match the selected npub.");
      window.alert("The provided nsec does not match the selected npub.");
      return;
    }

    setPublishingClaim(true);
    setStatus(null);
    setError(null);

    try {
      const event = createCashuClaimEvent(
        nsecInput,
        invoiceQuote.npub,
        invoiceQuote,
        normalizedMintApiUrl
      );
      const result = await publishCashuClaim(invoiceQuote.relays, event);

      try {
        await logClaimDebug({
          npub: invoiceQuote.npub,
          coordinatorNpub: invoiceQuote.coordinatorNpub,
          mintApiUrl: normalizedMintApiUrl,
          relays: invoiceQuote.relays,
          quoteId: invoiceQuote.quoteId,
          invoice: invoiceQuote.invoice,
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
      } catch (logError) {
        console.warn("[voter] failed to send claim debug log:", logError);
      }

      setPublishResult(result);
      setProofPollingActive(true);

      if (result.failures > 0) {
        const failedRelayMessage = result.relayResults
          .filter((relayResult) => !relayResult.success)
          .map((relayResult) => `${relayResult.relay}: ${relayResult.error ?? "Unknown error"}`)
          .join("\n");
        window.alert(`Some relays rejected the claim publish:\n${failedRelayMessage}`);
      }

      if (result.successes > 0) {
        setStatus(`Claim published to ${result.successes} relay${result.successes === 1 ? "" : "s"}. Waiting for mint proof.`);
      } else {
        setStatus("Relay publish did not confirm yet. Keep this page open while the app continues checking for your proof.");
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Could not publish invoice claim";
      setError(message);
      window.alert(message);
    } finally {
      setPublishingClaim(false);
    }
  }

  async function checkForProof() {
    if (!invoiceQuote) {
      return;
    }

    setCheckingProof(true);

    try {
      const payload = await fetchMintProof(normalizedMintApiUrl, invoiceQuote.quoteId);

      if (payload.status === "pending") {
        setStatus(`Mint is still preparing the proof. Checking again soon.`);
        return;
      }

      setCurrentProof(payload.proof);
      setProofPollingActive(false);
      storeProof(payload.proof);
      setWalletBundle(loadStoredWalletBundle());
      setStatus(`Cashu proof received from Mint for quote ${payload.quoteId}.`);
    } catch (requestError) {
      setProofPollingActive(false);
      setError(requestError instanceof Error ? requestError.message : "Could not fetch proof");
    } finally {
      setCheckingProof(false);
    }
  }

  useEffect(() => {
    if (!proofPollingActive || !invoiceQuote) {
      return;
    }

    let cancelled = false;

    async function poll() {
      if (cancelled) {
        return;
      }

      await checkForProof();
    }

    void poll();

    const intervalId = window.setInterval(() => {
      void poll();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [proofPollingActive, invoiceQuote, normalizedMintApiUrl]);

  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">Voter Portal</p>
        <h1 className="hero-title">Check your allowed npub and mint a Cashu voting proof.</h1>
        <p className="hero-copy hero-copy-home">
          Start with your approved <code className="inline-code">npub</code>, request an invoice from the Mint API, sign the claim with your <code className="inline-code">nsec</code>, publish it to Nostr relays, and receive your voting proof in your local wallet.
        </p>
        <div className="hero-flow" aria-label="Voter proof flow">
          <span>Verify eligibility</span>
          <span>Request invoice</span>
          <span>Sign claim</span>
          <span>Receive proof</span>
        </div>
        <div className="hero-metadata">
          <span>Mint API</span>
          <input
            className="mint-input"
            value={mintApiUrl}
            onChange={(event) => setMintApiUrl(event.target.value)}
            placeholder={DEFAULT_MINT_URL}
          />
        </div>
        <p className="field-hint hero-hint">
          The default Mint API points to the mint service configured for this environment. You can replace it with another compatible endpoint when needed.
        </p>
      </section>

      <section className="content-grid">
        <article className="panel panel-accent">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 1</p>
              <h2>Check your npub</h2>
            </div>
          </div>

          <label className="field-label" htmlFor="npub-input">Allowed npub</label>
          <textarea
            id="npub-input"
            className="text-area"
            value={npubInput}
            onChange={(event) => {
              setNpubInput(event.target.value);
              setEligibilityResult(null);
              resetIssuanceFlow();
            }}
            placeholder="npub1..."
            rows={4}
          />

          <div className="button-row">
            <button className="primary-button" onClick={() => void checkNpubAccess()} disabled={!npubIsValid || loading}>
              {loading ? "Checking..." : "Check eligibility"}
            </button>
          </div>

          <p className="field-hint">
            Only approved <code className="inline-code">npub</code> values can continue. The server verifies eligibility before you request an invoice.
          </p>

          <div className="validation-row">
            <span className={eligibilityResult?.canProceed ? "validation-ok" : "validation-warn"}>
              {eligibilityResult?.canProceed
                ? "Allowed npub and not voted yet"
                : npubIsValid
                  ? "Check whether this npub is on the allowed list"
                  : "Paste or generate a valid npub"}
            </span>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Signer</p>
              <h2>Use your existing nsec</h2>
            </div>
          </div>

          <div className="warning-box">
            <strong>Protect the nsec.</strong>
            <p>
              <code className="inline-code">nsec</code> is your private key. Anyone who gets it can act as you. This page signs locally in the browser and never sends <code className="inline-code">nsec</code> to voter management or the mint API.
            </p>
          </div>

          <p className="empty-copy">Use an existing Nostr account. Enter the approved <code className="inline-code">npub</code> in Step 1 and the matching <code className="inline-code">nsec</code> in Step 2 when you are ready to sign.</p>
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 2</p>
              <h2>Get your voter proof</h2>
            </div>
            {currentProof && <span className="count-pill">Proof received</span>}
          </div>

          <div className="verification-grid">
            <div>
              <div className="substep-card">
                <p className="code-label">Step 2.1</p>
                <h3 className="substep-title">Request invoice from Mint</h3>
                <p className="field-hint substep-copy">
                  Once your <code className="inline-code">npub</code> passes the eligibility checks, request an issuance quote from the Mint API to begin the proof flow.
                </p>
                <div className="button-row button-row-tight">
                  <button className="secondary-button" onClick={() => void requestInvoice()} disabled={!canRequestInvoice}>
                    {requestingInvoice ? "Requesting..." : "Request invoice"}
                  </button>
                </div>
              </div>

              <div className="challenge-card challenge-card-spaced">
                <p className="code-label">Mint invoice</p>
                {invoiceQuote ? (
                  <div className="detail-stack">
                    <code className="code-block code-block-muted">{invoiceQuote.invoice}</code>
                    <p className="field-hint">Quote: {invoiceQuote.quoteId}</p>
                    <p className="field-hint">Amount: {invoiceQuote.amount}</p>
                    <p className="field-hint">Expires {formatDateTime(invoiceQuote.expiresAt)}</p>
                    <p className="field-hint">Coordinator: {invoiceQuote.coordinatorNpub}</p>
                    <p className="field-hint">Relays: {invoiceQuote.relays.join(", ")}</p>
                  </div>
                ) : (
                  <p className="empty-copy">No invoice requested yet.</p>
                )}
              </div>
            </div>

            <div className="challenge-column">
              <div className="substep-card">
                <p className="code-label">Step 2.2</p>
                <h3 className="substep-title">Sign invoice and publish</h3>
                <p className="field-hint substep-copy">
                  Enter the matching `nsec` so the browser can sign the invoice claim with your `npub` identity and publish it to public Nostr relays.
                </p>
              </div>

              <label className="field-label" htmlFor="nsec-input">nsec used for signing</label>
              <textarea
                id="nsec-input"
                className="text-area text-area-secret"
                value={nsecInput}
                onChange={(event) => setNsecInput(event.target.value)}
                placeholder="nsec1..."
                rows={4}
              />
              <p className="field-hint">
                Paste your `nsec` or use the generated one above. The browser derives the `npub` locally and checks it matches the approved voter identity.
              </p>

              {derivedNpub && (
                <div className="derived-box">
                  <p className="code-label">Derived npub from nsec</p>
                  <code className="code-block code-block-muted">{derivedNpub}</code>
                </div>
              )}

              <div className="button-row">
                <button className="primary-button" onClick={() => void publishInvoiceClaim()} disabled={!invoiceQuote || !nsecMatchesNpub || publishingClaim}>
                  {publishingClaim ? "Publishing..." : "Sign and publish claim"}
                </button>
                <button className="ghost-button" onClick={() => void checkForProof()} disabled={!invoiceQuote || checkingProof}>
                  {checkingProof ? "Checking..." : "Check for proof"}
                </button>
              </div>

              <div className="validation-row">
                <span className={nsecMatchesNpub ? "validation-ok" : "validation-warn"}>
                  {nsecMatchesNpub ? "nsec matches selected npub" : "Enter the nsec for the approved npub before publishing"}
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
                  Proof received at {formatDateTime(currentProof.issuedAt)} and stored as your single voting proof.
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
              <p className="code-label">Quote {walletBundle.proof.quoteId}</p>
              <code className="code-block code-block-muted">{walletBundle.proof.secret}</code>
              <p className="field-hint">Election {walletBundle.invoice.electionId}</p>
              <p className="field-hint">Issued {formatDateTime(walletBundle.proof.issuedAt)}</p>
              <p className="field-hint">Amount {walletBundle.proof.amount}</p>
            </div>
          ) : (
            <p className="empty-copy">No proof stored yet. Request an invoice, publish the signed claim, and wait for the mint proof.</p>
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
                <h2>Wallet and server response</h2>
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

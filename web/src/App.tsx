import { useMemo, useState } from "react";
import {
  registerEligibleNpub,
  requestEligibilityChallenge,
  verifyEligibilityChallenge,
  type ChallengeResponse,
  type VerificationResponse
} from "./voterManagementApi";
import {
  createEligibilityVerificationEvent,
  createGeneratedIdentity,
  deriveNpubFromNsec,
  formatDateTime,
  isValidNpub,
  type GeneratedIdentity
} from "./nostrIdentity";

const DEFAULT_MINT_URL = "https://mint.example.com";

function normalizeMintUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

export default function App() {
  const [mintApiUrl, setMintApiUrl] = useState(DEFAULT_MINT_URL);
  const [npubInput, setNpubInput] = useState("");
  const [nsecInput, setNsecInput] = useState("");
  const [generatedIdentity, setGeneratedIdentity] = useState<GeneratedIdentity | null>(null);
  const [challengeData, setChallengeData] = useState<ChallengeResponse | null>(null);
  const [verificationResult, setVerificationResult] = useState<VerificationResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const normalizedMintApiUrl = useMemo(() => normalizeMintUrl(mintApiUrl) || DEFAULT_MINT_URL, [mintApiUrl]);
  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);
  const npubIsValid = isValidNpub(npubInput);
  const nsecMatchesNpub = Boolean(derivedNpub && npubInput.trim() === derivedNpub);
  const canRegister = npubIsValid && !loading;
  const canVerify = Boolean(challengeData && derivedNpub && nsecMatchesNpub && !verifying);

  function generateIdentity() {
    const nextIdentity = createGeneratedIdentity();

    setGeneratedIdentity(nextIdentity);
    setNpubInput(nextIdentity.npub);
    setNsecInput(nextIdentity.nsec);
    setChallengeData(null);
    setVerificationResult(null);
    setStatus("Fresh Nostr identity generated locally. Save the nsec somewhere private before you continue.");
    setError(null);
  }

  async function registerNpub() {
    if (!npubIsValid) {
      setError("Enter a valid npub before registering.");
      return;
    }

    setLoading(true);
    setStatus(null);
    setError(null);
    setVerificationResult(null);
    setChallengeData(null);

    try {
      const payload = await registerEligibleNpub(npubInput.trim());
      setStatus(payload.added ? `Registered ${payload.npub} in voter management.` : `${payload.npub} was already on the eligible list.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Registration failed");
    } finally {
      setLoading(false);
    }
  }

  async function requestChallenge() {
    if (!npubIsValid) {
      setError("Enter or generate a valid npub first.");
      return;
    }

    setVerifying(true);
    setStatus(null);
    setError(null);
    setVerificationResult(null);

    try {
      const payload = await requestEligibilityChallenge(npubInput.trim());
      setChallengeData(payload);
      setStatus(`Challenge issued for ${payload.npub}. Sign it locally before ${formatDateTime(payload.expiresAt)}.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not request a challenge");
    } finally {
      setVerifying(false);
    }
  }

  async function signAndVerifyChallenge() {
    if (!challengeData) {
      setError("Request a challenge first.");
      return;
    }

    if (!nsecMatchesNpub) {
      setError("The provided nsec does not match the selected npub.");
      return;
    }

    setVerifying(true);
    setStatus(null);
    setError(null);

    try {
      const signedEvent = createEligibilityVerificationEvent(nsecInput, challengeData, normalizedMintApiUrl);
      const payload = await verifyEligibilityChallenge(challengeData.npub, signedEvent);

      setVerificationResult(payload);
      setStatus(payload.message);
      setChallengeData(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Eligibility verification failed");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">Voter Portal</p>
        <h1>Register and prove control of your Nostr key.</h1>
        <p className="hero-copy">
          Add your eligible `npub`, optionally generate a fresh Nostr identity locally, and verify that `npub` in the browser without exposing your `nsec`.
        </p>
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
          This Mint API field is reserved for the remote mint service we will integrate later. The current voter management service runs on the same server as this page.
        </p>
      </section>

      <section className="content-grid">
        <article className="panel panel-accent">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 1</p>
              <h2>Register your npub</h2>
            </div>
          </div>

          <label className="field-label" htmlFor="npub-input">Eligible npub</label>
          <textarea
            id="npub-input"
            className="text-area"
            value={npubInput}
            onChange={(event) => setNpubInput(event.target.value)}
            placeholder="npub1..."
            rows={4}
          />

          <div className="button-row">
              <button className="primary-button" onClick={() => void registerNpub()} disabled={!canRegister}>
              {loading ? "Registering..." : "Register npub"}
              </button>
            <button className="secondary-button" onClick={generateIdentity}>
              Generate npub + nsec
            </button>
          </div>

          <div className="validation-row">
            <span className={npubIsValid ? "validation-ok" : "validation-warn"}>
              {npubIsValid ? "Valid npub ready to register" : "Paste or generate a valid npub"}
            </span>
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Local signer</p>
              <h2>Your private key stays local</h2>
            </div>
          </div>

          <div className="warning-box">
            <strong>Protect the nsec.</strong>
              <p>
              `nsec` is the private key. Anyone who gets it can act as you. This page never sends `nsec` to the voter management service, but you should still treat it like a password.
              </p>
            </div>

          {generatedIdentity ? (
            <div className="generated-grid">
              <div>
                <p className="code-label">npub</p>
                <code className="code-block">{generatedIdentity.npub}</code>
              </div>
              <div>
                <p className="code-label">nsec</p>
                <code className="code-block code-block-secret">{generatedIdentity.nsec}</code>
              </div>
            </div>
          ) : (
            <p className="empty-copy">Generate a fresh identity if you do not already have an `npub` and `nsec`.</p>
          )}
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 2</p>
              <h2>Verify your npub</h2>
            </div>
            {verificationResult?.issuanceReady && <span className="count-pill">Eligibility verified</span>}
          </div>

          <div className="verification-grid">
            <div>
              <div className="substep-card">
                <p className="code-label">Step 2.1</p>
                <h3 className="substep-title">Request challenge from Mint</h3>
                <p className="field-hint substep-copy">
                  Ask Mint for a challenge using the `npub` you already registered in Step 1.
                </p>
                <div className="button-row button-row-tight">
                  <button className="secondary-button" onClick={() => void requestChallenge()} disabled={verifying || !npubIsValid}>
                    {verifying && !challengeData ? "Requesting..." : "Request challenge"}
                  </button>
                </div>
              </div>

              <div className="challenge-card challenge-card-spaced">
                <p className="code-label">Challenge from Mint</p>
                {challengeData ? (
                  <>
                    <code className="code-block code-block-muted">{challengeData.challenge}</code>
                    <p className="field-hint">Expires {formatDateTime(challengeData.expiresAt)}</p>
                  </>
                ) : (
                  <p className="empty-copy">No challenge requested yet.</p>
                )}
              </div>
            </div>

            <div className="challenge-column">
              <div className="substep-card">
                <p className="code-label">Step 2.2</p>
                <h3 className="substep-title">Sign challenge with your nsec</h3>
                <p className="field-hint substep-copy">
                  Enter the matching `nsec` so the browser can sign the challenge locally and send only the signed verification event.
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
                Paste your `nsec` or use the generated one above. The browser derives the `npub` locally and checks it matches the voter you are registering.
              </p>

              {derivedNpub && (
                <div className="derived-box">
                  <p className="code-label">Derived npub from nsec</p>
                  <code className="code-block code-block-muted">{derivedNpub}</code>
                </div>
              )}

              <div className="button-row">
                <button className="primary-button" onClick={() => void signAndVerifyChallenge()} disabled={!canVerify}>
                  {verifying && challengeData ? "Verifying..." : "Sign and verify"}
                </button>
              </div>

              <div className="validation-row">
                <span className={nsecMatchesNpub ? "validation-ok" : "validation-warn"}>
                  {nsecMatchesNpub ? "nsec matches selected npub" : "Enter the nsec for the registered npub before signing"}
                </span>
              </div>

              {verificationResult && (
                <div className="notice notice-success">
                  {verificationResult.message} Verified at {formatDateTime(verificationResult.verifiedAt)}.
                </div>
              )}
            </div>
          </div>
        </article>

        {(status || error) && (
          <article className="panel panel-wide">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Latest update</p>
                <h2>Voter management response</h2>
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

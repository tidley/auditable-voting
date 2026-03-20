import { useState } from "react";
import { BALLOT_EVENT_KIND, DEFAULT_VOTE_RELAYS, publishBallotEvent } from "./ballot";
import { logBallotDebug } from "./cashuMintApi";
import { loadStoredWalletBundle } from "./cashuWallet";
import { formatDateTime, getNostrEventVerificationUrl } from "./nostrIdentity";

type VotePublishResult = {
  eventId: string;
  ballotNpub: string;
  event: {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    content: string;
    tags: string[][];
    sig: string;
  };
  proofHash: string;
  relays: string[];
  successes: number;
  failures: number;
  relayResults: Array<{
    relay: string;
    success: boolean;
    error?: string;
  }>;
};

export default function VotingApp() {
  const [walletBundle] = useState(() => loadStoredWalletBundle());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<VotePublishResult | null>(null);

  const storedProof = walletBundle?.proof ?? null;
  const electionId = walletBundle?.invoice.electionId ?? "";
  const questions = walletBundle?.invoice.questions ?? [];
  const ballotVerificationUrl = publishResult && publishResult.successes > 0
    ? getNostrEventVerificationUrl({
        eventId: publishResult.eventId,
        relays: publishResult.relays,
        author: publishResult.event.pubkey,
        kind: BALLOT_EVENT_KIND
      })
    : null;
  const canSubmit = Boolean(
    storedProof &&
    electionId.trim() &&
    questions.length > 0 &&
    questions.every((question) => Boolean(answers[question.id])) &&
    !publishing
  );

  async function submitBallot() {
    if (!storedProof) {
      const message = "Mint your proof before submitting a ballot.";
      setError(message);
      window.alert(message);
      return;
    }

    if (!electionId.trim()) {
      const message = "No election ID found. Request a fresh invoice first.";
      setError(message);
      window.alert(message);
      return;
    }

    if (questions.some((question) => !answers[question.id])) {
      const message = "Answer all ballot questions before submitting.";
      setError(message);
      window.alert(message);
      return;
    }

    setPublishing(true);
    setStatus(null);
    setError(null);

    try {
      const result = await publishBallotEvent({
        electionId: electionId.trim(),
        proof: storedProof,
        answers
      });

      try {
        await logBallotDebug({
          electionId: electionId.trim(),
          proofHash: result.proofHash,
          relays: result.relays,
          event: result.event,
          publishResult: {
            eventId: result.eventId,
            ballotNpub: result.ballotNpub,
            successes: result.successes,
            failures: result.failures,
            relayResults: result.relayResults
          }
        });
      } catch {
        // ignore debug log failures
      }

      setPublishResult(result);
      setStatus(`Ballot published for election ${electionId.trim()}.`);

      if (result.failures > 0) {
        const failedRelayMessage = result.relayResults
          .filter((relayResult) => !relayResult.success)
          .map((relayResult) => `${relayResult.relay}: ${relayResult.error ?? "Unknown error"}`)
          .join("\n");
        window.alert(`Some relays rejected the ballot publish:\n${failedRelayMessage}`);
      }
    } catch (publishError) {
      const message = publishError instanceof Error ? publishError.message : "Could not publish ballot";
      setError(message);
      window.alert(message);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <p className="eyebrow">Voting Page</p>
        <h1>Cast your ballot with a proof-backed Nostr event.</h1>
        <p className="hero-copy">
          Use your single stored voting proof, answer the election questions returned by the invoice flow, and publish a ballot event that includes the hash of your proof.
        </p>
        <p className="field-hint hero-hint">Ballots publish to: {DEFAULT_VOTE_RELAYS.join(", ")}</p>
        <div className="button-row">
          <a className="ghost-button link-button" href="/">Return to home page</a>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel panel-accent">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 1</p>
              <h2>Confirm election and proof</h2>
            </div>
          </div>

          <label className="field-label">Election ID</label>
          <div className="derived-box derived-box-inline">
            <code className="code-block code-block-muted">{electionId || "No election loaded"}</code>
          </div>

          {storedProof ? (
            <div className="derived-box">
              <p className="code-label">Stored proof</p>
              <code className="code-block code-block-muted">{storedProof.secret}</code>
              <p className="field-hint">Quote {storedProof.quoteId}</p>
              <p className="field-hint">Mint: {storedProof.mintUrl}</p>
              <p className="field-hint">Issued {formatDateTime(storedProof.issuedAt)}</p>
            </div>
          ) : (
            <p className="empty-copy">No voting proof found. Return home and mint your proof first.</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 2</p>
              <h2>Answer the ballot</h2>
            </div>
          </div>

          {questions.length > 0 ? (
            questions.map((question, index) => (
              <div key={question.id} className={index === 0 ? "question-card" : "question-card question-card-spaced"}>
                <p className="question-title">{question.prompt}</p>
                <div className="option-list">
                  {question.options.map((option) => (
                    <label key={option.value} className="option-row">
                      <input
                        type="radio"
                        name={question.id}
                        value={option.value}
                        checked={answers[question.id] === option.value}
                        onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="empty-copy">No ballot questions loaded. Request a fresh invoice from the voter portal first.</p>
          )}

          <div className="button-row">
            <button className="primary-button" onClick={() => void submitBallot()} disabled={!canSubmit}>
              {publishing ? "Publishing ballot..." : "Submit ballot"}
            </button>
          </div>
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Publish result</p>
              <h2>Latest ballot event</h2>
            </div>
          </div>

          {publishResult ? (
            <div className="result-grid">
              <div>
                <p className="code-label">Event ID</p>
                <code className="code-block">{publishResult.eventId}</code>
              </div>
              <div>
                <p className="code-label">Ballot npub</p>
                <code className="code-block code-block-muted">{publishResult.ballotNpub}</code>
              </div>
              <div>
                <p className="code-label">Proof hash</p>
                <code className="code-block code-block-muted">{publishResult.proofHash}</code>
              </div>
              <div>
                <p className="field-hint">Relay attempts: {publishResult.successes + publishResult.failures}</p>
                <p className="field-hint">Successes: {publishResult.successes}</p>
                <p className="field-hint">Failures: {publishResult.failures}</p>
                {ballotVerificationUrl && (
                  <a className="notice-link" href={ballotVerificationUrl} target="_blank" rel="noreferrer">
                    Verify this ballot event on njump
                  </a>
                )}
              </div>
            </div>
          ) : (
            <p className="empty-copy">No ballot published yet.</p>
          )}

          {(status || error) && (
            <div>
              {status && <div className="notice notice-success">{status}</div>}
              {error && <div className="notice notice-error">{error}</div>}
            </div>
          )}
        </article>
      </section>
    </main>
  );
}

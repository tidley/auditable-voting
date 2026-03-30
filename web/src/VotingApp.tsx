import { useState, useEffect, useMemo } from "react";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import { publishBallotEvent, BALLOT_EVENT_KIND, DEFAULT_VOTE_RELAYS, isBallotComplete } from "./ballot";
import { loadStoredWalletBundle, storeBallotEventId, storeEphemeralKeypair } from "./cashuWallet";
import { deriveNpubFromNsec, formatDateTime, getNostrEventVerificationUrl, decodeNsec } from "./nostrIdentity";
import { submitProofViaDm, submitProofsToAllCoordinators, type DmPublishResult, type MultiCoordinatorDmResult } from "./proofSubmission";
import type { CashuProof } from "./cashuBlind";
import { fetchElection, fetchTally, checkVoteAccepted, type ElectionInfo, type TallyInfo } from "./coordinatorApi";
import MerkleTreeViz from "./MerkleTreeViz";
import { DEMO_MODE } from "./config";
import PageNav from "./PageNav";
import { queueNostrPublish } from "./nostrPublishQueue";

type VotePublishResult = {
  eventId: string;
  ballotNpub: string;
  ballotSecretKey: Uint8Array;
  event: {
    id: string;
    pubkey: string;
    kind: number;
    created_at: number;
    content: string;
    tags: string[][];
    sig: string;
  };
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
  useEffect(() => {
    if (typeof document === "undefined") return;

    document.body.classList.add("app-page");
    return () => {
      document.body.classList.remove("app-page");
    };
  }, []);

  const [walletBundle, setWalletBundle] = useState(() => loadStoredWalletBundle());
  const [nsecInput, setNsecInput] = useState(() => loadStoredWalletBundle()?.ephemeralKeypair?.nsec ?? "");
  const [loadedElection, setLoadedElection] = useState<ElectionInfo | null>(walletBundle?.election ?? null);
  const [answers, setAnswers] = useState<Record<string, string | string[] | number>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<VotePublishResult | null>(null);
  const [submittingProof, setSubmittingProof] = useState(false);
  const [dmResult, setDmResult] = useState<MultiCoordinatorDmResult[] | null>(null);
  const [tally, setTally] = useState<TallyInfo | null>(null);
  const [voteAccepted, setVoteAccepted] = useState(false);
  const [checkingVote, setCheckingVote] = useState(false);
  const [confirmingVote, setConfirmingVote] = useState(false);
  const [confirmationResult, setConfirmationResult] = useState<{ eventId: string; successes: number; failures: number } | null>(null);
  const derivedNpub = useMemo(() => deriveNpubFromNsec(nsecInput), [nsecInput]);

  useEffect(() => {
    let cancelled = false;

    async function loadElectionContext() {
      try {
        const election = await fetchElection();
        if (cancelled) return;

        setLoadedElection(election);
        setWalletBundle(loadStoredWalletBundle());
      } catch {
        if (!cancelled) {
          setLoadedElection(walletBundle?.election ?? null);
        }
      }
    }

    void loadElectionContext();

    const handleStorage = () => {
      setWalletBundle(loadStoredWalletBundle());
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      cancelled = true;
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!nsecInput && walletBundle?.ephemeralKeypair?.nsec) {
      setNsecInput(walletBundle.ephemeralKeypair.nsec);
    }
  }, [nsecInput, walletBundle?.ephemeralKeypair?.nsec]);

  const storedProofs = walletBundle?.coordinatorProofs ?? [];
  const storedProof = storedProofs.length > 0 ? storedProofs[0].proof : null;
  const election = walletBundle?.election ?? loadedElection ?? null;
  const electionId = walletBundle?.election?.electionId ?? loadedElection?.election_id ?? "";
  const questions = election?.questions ?? [];
  const coordinatorNpubs = election?.coordinator_npubs ?? (walletBundle?.coordinatorProofs?.map(cp => cp.coordinatorNpub) ?? []);
  const coordinatorNpub = coordinatorNpubs[0] ?? "";
  const relays = (walletBundle?.relays?.length ?? 0) > 0 ? walletBundle!.relays : DEFAULT_VOTE_RELAYS;
  const storedBallotEventId = walletBundle?.ballotEventId ?? "";
  const deliveredCoordinatorCount = dmResult?.filter((result) => result.result.successes > 0).length ?? 0;
  const deliveredRelayCount = dmResult?.reduce((sum, result) => sum + result.result.successes, 0) ?? 0;
  const voteEnd = election?.vote_end ?? 0;
  const confirmEnd = election?.confirm_end ?? 0;
  const now = Math.floor(Date.now() / 1000);
  const isInConfirmationWindow = voteEnd > 0 && now >= voteEnd && (confirmEnd === 0 || now <= confirmEnd);
  const votingWindowNotClosed = voteEnd > 0 && now < voteEnd;
  const hasRealKeypair = Boolean(walletBundle?.ephemeralKeypair?.nsec);

  function tallyStatusLabel(status: string): string {
    if (status === "closed") return "Closed";
    if (status === "in_progress") return "In Progress";
    return status;
  }

  async function refreshVoteAccepted(ballotEventId: string) {
    setCheckingVote(true);
    try {
      const results = await checkVoteAccepted(ballotEventId, coordinatorNpubs, relays);
      setVoteAccepted(results.length > 0 && results.every((r) => r.accepted));
    } finally {
      setCheckingVote(false);
    }
  }

  useEffect(() => {
    if (!storedBallotEventId || !coordinatorNpub) return;
    void refreshVoteAccepted(storedBallotEventId);
  }, [storedBallotEventId, coordinatorNpub]);

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
    !voteAccepted &&
    isBallotComplete(answers, questions) &&
    !publishing
  );

  function setAnswer(questionId: string, value: string | string[] | number) {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
  }

  function toggleMultiChoice(questionId: string, option: string) {
    const current = (answers[questionId] as string[] | undefined) ?? [];
    const next = current.includes(option)
      ? current.filter((v) => v !== option)
      : [...current, option];
    setAnswers((prev) => ({ ...prev, [questionId]: next }));
  }

  function saveIdentity() {
    const trimmed = nsecInput.trim();
    if (!trimmed) {
      setError("Paste an nsec first.");
      return;
    }

    if (!derivedNpub) {
      setError("That nsec is not valid.");
      return;
    }

    storeEphemeralKeypair(trimmed, derivedNpub);
    setWalletBundle(loadStoredWalletBundle());
    setStatus(`Saved voter identity for ${derivedNpub}.`);
  }

  async function submitBallot() {
    if (!storedProof) {
      const message = "Mint your proof before submitting a ballot.";
      setError(message);
      window.alert(message);
      return;
    }

    if (!electionId.trim()) {
      const message = "No election ID found. Request a fresh quote first.";
      setError(message);
      window.alert(message);
      return;
    }

    if (!isBallotComplete(answers, questions)) {
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
        answers,
        questions,
        relays,
        coordinatorProofs: storedProofs
      });

      setPublishResult(result);
      setStatus(`Ballot published for election ${electionId.trim()}.`);

      if (DEMO_MODE) {
        await submitProofAfterPublish(result);
      }

      if (result.failures > 0) {
        const failedRelayMessage = result.relayResults
          .filter((rr) => !rr.success)
          .map((rr) => `${rr.relay}: ${rr.error ?? "Unknown error"}`)
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

  async function submitProofAfterPublish(currentPublishResult: VotePublishResult) {
    setSubmittingProof(true);
    setStatus(null);
    setError(null);

    try {
      const results = await submitProofsToAllCoordinators({
        voterSecretKey: currentPublishResult.ballotSecretKey,
        voteEventId: currentPublishResult.eventId,
        coordinatorProofs: storedProofs.map((cp) => ({
          coordinatorNpub: cp.coordinatorNpub,
          proof: cp.proof as unknown as CashuProof,
        })),
        relays,
        retries: DEMO_MODE ? 1 : 0,
      });

      setDmResult(results);
      storeBallotEventId(currentPublishResult.eventId);
      setVoteAccepted(false);
      const successfulCoordinators = results.filter((result) => result.result.successes > 0).length;
      const totalSuccesses = results.reduce((sum, r) => sum + r.result.successes, 0);
      if (successfulCoordinators === 0) {
        throw new Error("Proof delivery failed. No relay accepted the NIP-17 gift wrap.");
      }
      setStatus(`Proof DM sent to ${successfulCoordinators} coordinator(s). ${totalSuccesses} relay confirmation(s). Waiting for coordinator to process...`);
      if (DEMO_MODE) {
        await refreshVoteAccepted(currentPublishResult.eventId);
      }
    } catch (dmError) {
      setError(dmError instanceof Error ? dmError.message : "Could not send proof DM");
    } finally {
      setSubmittingProof(false);
    }
  }

  async function submitProof() {
    if (storedProofs.length === 0 || !publishResult) {
      setError("Publish ballot and have a proof before submitting.");
      return;
    }
    await submitProofAfterPublish(publishResult);
  }

  async function checkTally() {
    try {
      const result = await fetchTally();
      setTally(result);
      if (result) {
        setStatus(`Tally: ${result.total_accepted_votes ?? 0} accepted votes out of ${result.total_published_votes} published.`);
      }
    } catch {
      setError("Could not fetch tally");
    }
  }

  async function publishVoterConfirmation() {
    if (!hasRealKeypair) {
      setError("Publish your voter confirmation requires a real nsec in the signer panel on the home page.");
      return;
    }

    if (!walletBundle?.ephemeralKeypair?.nsec) {
      setError("No ephemeral keypair found. Cannot sign confirmation.");
      return;
    }

    if (!storedBallotEventId) {
      setError("No ballot event found. Submit your ballot first.");
      return;
    }

    if (votingWindowNotClosed) {
      setError("The voting window is still open. You must wait until it closes to publish your confirmation.");
      return;
    }

    setConfirmingVote(true);
    setStatus(null);
    setError(null);

    try {
      const secretKey = decodeNsec(walletBundle.ephemeralKeypair.nsec);
      if (!secretKey) {
        throw new Error("Invalid ephemeral nsec stored in wallet bundle.");
      }

      const event = finalizeEvent(
        {
          kind: 38013,
          created_at: now,
          tags: [
            ["e", storedBallotEventId],
            ...coordinatorNpubs.map(npub => {
              const decoded = nip19.decode(npub);
              return ["p", decoded.data as string] as string[];
            }),
          ],
          content: JSON.stringify({
            action: "voter_confirmation",
            ballot_event_id: storedBallotEventId,
            election_id: electionId,
          }),
        },
        secretKey,
      );

      const pool = new SimplePool();
      try {
        const results = await queueNostrPublish(() =>
          Promise.allSettled(pool.publish(relays, event, { maxWait: 4000 })),
        );
        const successes = results.filter(r => r.status === "fulfilled").length;
        const failures = results.length - successes;
        setConfirmationResult({ eventId: event.id, successes, failures });
        setStatus(`Voter confirmation (kind 38013) published to ${successes} relay(s).`);
      } finally {
        pool.destroy();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish voter confirmation");
    } finally {
      setConfirmingVote(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-card">
        <div className="hero-brand">
          <img src="/images/logo.png" alt="" width={28} height={28} />
          <p className="eyebrow">Voting Page</p>
        </div>
        <PageNav current="vote" />
        <h1 className="hero-title">Cast your ballot with a proof-backed Nostr event.</h1>
        <p className="hero-copy">
          Use the stored proof from the home page, answer the election questions, publish a ballot event, then submit your proof to the coordinator.
        </p>
        <p className="field-hint hero-hint">
          If you have not pasted your nsec and minted a proof yet, go back to the home page first.
        </p>
        <p className="field-hint hero-hint">
          {election ? `Election loaded: ${election.title}` : "Loading election metadata from the coordinator..."}
        </p>
        <p className="field-hint hero-hint"><img className="inline-icon" src="/images/nostr/relayflasks.png" alt="" width={18} height={18} />Relays: {relays.join(", ")}</p>
        <div className="button-row">
          <a className="ghost-button link-button" href="/">Return to home page</a>
        </div>
      </section>

      {voteAccepted && (
        <section className="content-grid">
          <article className="panel panel-wide">
            <div className="notice notice-success" style={{ fontSize: "1.05rem", padding: "16px" }}>
              Your vote has been accepted by the coordinator. Your proof was burned and your ballot is included in the tally.
              {storedBallotEventId && (
                <span style={{ display: "block", marginTop: 8 }}>
                  Ballot event: <code style={{ fontSize: "0.85rem" }}>{storedBallotEventId}</code>
                </span>
              )}
            </div>
          </article>
        </section>
      )}

      <section className="content-grid">
        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Identity</p>
              <h2>Paste your nsec here</h2>
            </div>
            {derivedNpub && <span className="count-pill">Ready</span>}
          </div>

          <p className="field-hint">
            Paste the voter key here to save it locally. You still mint the proof on the home page, but this keeps the vote flow in one place.
          </p>

          <div className="verification-grid">
            <div>
              <label className="field-label" htmlFor="vote-nsec-input">nsec</label>
              <textarea
                id="vote-nsec-input"
                className="text-area text-area-secret"
                value={nsecInput}
                onChange={(event) => setNsecInput(event.target.value)}
                placeholder="nsec1..."
                rows={4}
              />
            </div>

            <div>
              <label className="field-label">Derived npub</label>
              <div className="derived-box derived-box-inline">
                <code className="code-block code-block-muted">{derivedNpub ?? "Paste an nsec to derive the npub"}</code>
              </div>
              <div className="button-row">
                <button className="secondary-button" onClick={() => void saveIdentity()}>
                  Save identity
                </button>
                <a className="ghost-button link-button" href="/">
                  Mint proof on home page
                </a>
              </div>
            </div>
          </div>
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 1</p>
              <h2>Confirm election and proof</h2>
            </div>
          </div>

          <div className="verification-grid">
            <div>
              <label className="field-label">Election ID</label>
              <div className="derived-box derived-box-inline">
                <code className="code-block code-block-muted">{electionId || "Loading election..."}</code>
              </div>
              {election?.title && (
                <p className="field-hint">{election.title}</p>
              )}
            </div>

            <div>
              {storedProof ? (
                <div className="derived-box">
                  <p className="code-label"><img className="inline-icon" src="/images/bitcoin-logo.png" alt="" width={18} height={18} />Stored proof</p>
                  <code className="code-block code-block-muted">{JSON.stringify(storedProof, null, 2)}</code>
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: "12px 0" }}>
                  <img className="empty-state-image" src="/images/nostr/underconstruction-dark.png" alt="" width={120} />
                  <p className="empty-copy">No voting proof found yet. Paste your nsec above, then mint the proof on the home page.</p>
                </div>
              )}
            </div>
          </div>
        </article>

        <article className="panel panel-wide">
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
                {question.description && (
                  <p className="field-hint">{question.description}</p>
                )}

                {question.type === "choice" && (question.select !== "multiple") && (
                  <div className="option-list">
                    {(question.options ?? []).map((option: string) => {
                      const value = option;
                      const label = option;
                      return (
                        <label key={value} className="option-row">
                          <input
                            type="radio"
                            name={question.id}
                            value={value}
                            checked={answers[question.id] === value}
                            onChange={() => setAnswer(question.id, value)}
                          />
                          <span>{label}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {question.type === "choice" && question.select === "multiple" && (
                  <div className="option-list">
                    {(question.options ?? []).map((option: string) => {
                      const value = option;
                      const selected = Array.isArray(answers[question.id]) && (answers[question.id] as string[]).includes(value);
                      return (
                        <label key={value} className="option-row">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => toggleMultiChoice(question.id, value)}
                          />
                          <span>{value}</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                {question.type === "scale" && (
                  <div className="scale-input">
                    <input
                      type="range"
                      min={question.min ?? 1}
                      max={question.max ?? 10}
                      step={question.step ?? 1}
                      value={Number(answers[question.id] ?? question.min ?? 1)}
                      onChange={(e) => setAnswer(question.id, Number(e.target.value))}
                    />
                    <span className="field-hint">{answers[question.id] ?? "-"}</span>
                  </div>
                )}

                {question.type === "text" && (
                  <textarea
                    className="text-area"
                    maxLength={question.max_length}
                    rows={3}
                    value={String(answers[question.id] ?? "")}
                    onChange={(e) => setAnswer(question.id, e.target.value)}
                    placeholder="Your answer..."
                  />
                )}
              </div>
            ))
          ) : (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <img className="empty-state-image" src="/images/nostr/underconstruction-dark.png" alt="" width={120} />
              <p className="empty-copy">No ballot questions loaded. Request a fresh quote from the voter portal first.</p>
            </div>
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
              <p className="panel-kicker">Step 3</p>
              <h2>{DEMO_MODE ? "Send your voting pass" : "Submit proof to coordinator"}</h2>
            </div>
            {deliveredCoordinatorCount > 0 && <span className="count-pill">Proof sent</span>}
          </div>

          <p className="field-hint">
            After publishing your ballot, send your Cashu proof to the coordinator via encrypted DM so it can be burned and your vote validated.
          </p>

          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => void submitProof()}
              disabled={!publishResult || !storedProof || submittingProof}
            >
              {submittingProof ? "Sending..." : (DEMO_MODE ? "Send voting pass" : "Submit proof")}
            </button>
            {DEMO_MODE && publishResult && (
              <button className="ghost-button" onClick={() => void submitProof()} disabled={submittingProof}>
                Retry send
              </button>
            )}
          </div>

          {deliveredCoordinatorCount > 0 && (
            <div className="notice notice-success">
              Proof DM sent to {deliveredCoordinatorCount} coordinator(s). {deliveredRelayCount} relay confirmation(s).
            </div>
          )}
          {dmResult && dmResult.length > 0 && deliveredCoordinatorCount === 0 && (
            <div className="notice notice-error">
              Proof delivery failed. No relay accepted the NIP-17 gift wrap.
            </div>
          )}
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 4</p>
              <h2>{DEMO_MODE ? "See confirmation" : "Check vote acceptance"}</h2>
            </div>
          </div>

          <p className="field-hint">
            Poll the coordinator tally to see if your vote has been accepted (proof burned).
          </p>

          <div className="button-row">
            <button className="ghost-button" onClick={() => void checkTally()}>
              Check tally
            </button>
            {DEMO_MODE && publishResult && (
              <button className="ghost-button" onClick={() => void refreshVoteAccepted(publishResult.eventId)} disabled={checkingVote}>
                {checkingVote ? "Checking..." : "Retry confirmation"}
              </button>
            )}
          </div>

          {tally && (
            <div className="detail-stack">
              <p className="field-hint">Published votes: {tally.total_published_votes}</p>
              <p className="field-hint">Accepted votes: {tally.total_accepted_votes ?? 0}</p>
              {tally.spent_commitment_root && (
                <p className="field-hint">Merkle root: <code className="code-block code-block-muted">{tally.spent_commitment_root.slice(0, 16)}...</code></p>
              )}
              {tally.status && (
                <p className="field-hint">Election status: {tallyStatusLabel(tally.status)}</p>
              )}
            </div>
          )}
        </article>

        <article className="panel panel-wide">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Step 5</p>
              <h2>Publish voter confirmation (kind 38013)</h2>
            </div>
            {confirmationResult && <span className="count-pill">Confirmed</span>}
          </div>

          <p className="field-hint">
            After the voting window closes, publish a confirmation from your ephemeral key. This allows auditors to detect coordinator inflation or censorship by comparing confirmation counts against tallies.
          </p>
          <p className="field-hint">
            This confirmation proves participation only. It does not reveal your ballot choice or act as a transferable proof of how you voted.
          </p>

          {voteEnd > 0 && (
            <div className="detail-stack" style={{ marginBottom: 12 }}>
              <p className="field-hint">Voting window closes: {formatDateTime(voteEnd)}</p>
              {confirmEnd > 0 && <p className="field-hint">Confirmation window closes: {formatDateTime(confirmEnd)}</p>}
              {isInConfirmationWindow && <span className="validation-ok">Confirmation window is open</span>}
              {votingWindowNotClosed && <span className="validation-warn">Waiting for voting window to close</span>}
            </div>
          )}

          <div className="button-row">
            <button
              className="secondary-button"
              onClick={() => void publishVoterConfirmation()}
              disabled={!isInConfirmationWindow || !storedBallotEventId || !hasRealKeypair || confirmingVote}
            >
              {confirmingVote ? "Publishing confirmation..." : "Publish confirmation"}
            </button>
          </div>

          {confirmationResult && (
            <div className="notice notice-success">
              Confirmation event `{confirmationResult.eventId.slice(0, 16)}...` published to {confirmationResult.successes} relay(s).
              {confirmationResult.failures > 0 && ` ${confirmationResult.failures} failure(s).`}
            </div>
          )}

          {!hasRealKeypair && voteEnd > 0 && (
            <p className="field-hint" style={{ opacity: 0.6 }}>
              Note: Voter confirmation requires a real nsec. Make sure you entered your nsec on the home page before requesting your quote.
            </p>
          )}
        </article>

        <MerkleTreeViz ballotEventId={storedBallotEventId} />

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

import { useEffect, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { fetchElection, type ElectionInfo } from "./coordinatorApi";
import { decodeNsec } from "./nostrIdentity";
import {
  fetchSimpleShardRequests,
  sendSimpleShardResponse,
  type SimpleShardRequest,
} from "./simpleShardDm";
import {
  fetchLatestSimpleLiveVote,
  fetchSimpleSubmittedVotes,
  publishSimpleLiveVote,
  type SimpleLiveVoteSession,
  type SimpleSubmittedVote,
} from "./simpleVotingSession";
import { validateSimpleSubmittedVotes } from "./simpleVoteValidation";
import { sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import SimpleQrPanel from "./SimpleQrPanel";
import TokenFingerprint from "./TokenFingerprint";
import { serializeSimpleVotingPackage } from "./simpleVotingPackage";

const COORDINATOR_STORAGE_KEY = "auditable-voting.simple-coordinator-keypair";

type SimpleCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

function loadStoredCoordinatorKeypair(): SimpleCoordinatorKeypair | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(COORDINATOR_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SimpleCoordinatorKeypair;
  } catch {
    return null;
  }
}

function storeCoordinatorKeypair(keypair: SimpleCoordinatorKeypair) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(COORDINATOR_STORAGE_KEY, JSON.stringify(keypair));
}

export default function SimpleCoordinatorApp() {
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [keypair, setKeypair] = useState<SimpleCoordinatorKeypair | null>(() => loadStoredCoordinatorKeypair());
  const [coordinatorId, setCoordinatorId] = useState("pending");
  const [leadCoordinatorNpub, setLeadCoordinatorNpub] = useState("");
  const [requests, setRequests] = useState<SimpleShardRequest[]>([]);
  const [requestStatuses, setRequestStatuses] = useState<Record<string, string>>({});
  const [questionPrompt, setQuestionPrompt] = useState("Should the proposal pass?");
  const [questionVotingId, setQuestionVotingId] = useState("");
  const [questionThresholdT, setQuestionThresholdT] = useState("1");
  const [questionThresholdN, setQuestionThresholdN] = useState("1");
  const [questionShareIndex, setQuestionShareIndex] = useState("1");
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [publishedVote, setPublishedVote] = useState<SimpleLiveVoteSession | null>(null);
  const [submittedVotes, setSubmittedVotes] = useState<SimpleSubmittedVote[]>([]);

  useEffect(() => {
    void fetchElection().then((nextElection) => {
      setElection(nextElection);
    }).catch(() => {
      setElection(null);
    });
  }, []);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";

    if (!coordinatorNsec) {
      setRequests([]);
      return;
    }

    let cancelled = false;

    async function refreshRequests() {
      try {
        const nextRequests = await fetchSimpleShardRequests({ coordinatorNsec });
        if (!cancelled) {
          setRequests(nextRequests);
        }
      } catch {
        if (!cancelled) {
          setRequests([]);
        }
      }
    }

    void refreshRequests();
    const intervalId = window.setInterval(() => {
      void refreshRequests();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [keypair?.nsec]);

  useEffect(() => {
    let cancelled = false;
    const npub = keypair?.npub ?? "";

    if (!npub) {
      setCoordinatorId("pending");
      return () => {
        cancelled = true;
      };
    }

    void sha256Hex(npub).then((hash) => {
      if (!cancelled) {
        setCoordinatorId(hash.slice(0, 7));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [keypair?.npub]);

  useEffect(() => {
    const selfCoordinatorNpub = keypair?.npub ?? "";
    const activeCoordinatorNpub = leadCoordinatorNpub.trim() || selfCoordinatorNpub;

    if (!activeCoordinatorNpub) {
      setPublishedVote(null);
      return;
    }

    let cancelled = false;

    async function refreshPublishedVote() {
      try {
        const nextVote = await fetchLatestSimpleLiveVote({ coordinatorNpub: activeCoordinatorNpub });
        if (!cancelled) {
          setPublishedVote(nextVote);
        }
      } catch {
        if (!cancelled) {
          setPublishedVote(null);
        }
      }
    }

    void refreshPublishedVote();
    const intervalId = window.setInterval(() => {
      void refreshPublishedVote();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [keypair?.npub, leadCoordinatorNpub]);

  useEffect(() => {
    const votingId = publishedVote?.votingId ?? "";

    if (!votingId) {
      setSubmittedVotes([]);
      return;
    }

    let cancelled = false;

    async function refreshSubmittedVotes() {
      try {
        const nextVotes = await fetchSimpleSubmittedVotes({ votingId });
        if (!cancelled) {
          setSubmittedVotes(nextVotes);
        }
      } catch {
        if (!cancelled) {
          setSubmittedVotes([]);
        }
      }
    }

    void refreshSubmittedVotes();
    const intervalId = window.setInterval(() => {
      void refreshSubmittedVotes();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [publishedVote?.votingId]);

  function createNostrKeypair() {
    const secretKey = generateSecretKey();
    const nextKeypair = {
      nsec: nip19.nsecEncode(secretKey),
      npub: nip19.npubEncode(getPublicKey(secretKey)),
    };
    storeCoordinatorKeypair(nextKeypair);
    setKeypair(nextKeypair);
  }

  const isLeadCoordinator = !leadCoordinatorNpub.trim() || leadCoordinatorNpub.trim() === (keypair?.npub ?? "");
  const activeThresholdT = publishedVote?.thresholdT ?? (Number.parseInt(questionThresholdT, 10) || undefined);
  const activeThresholdN = publishedVote?.thresholdN ?? (Number.parseInt(questionThresholdN, 10) || undefined);

  function getThresholdLabel() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return `${configuredT} of ${configuredN}`;
    }

    const publishedT = election?.threshold_t;
    const publishedN = election?.threshold_n;

    if (publishedT && publishedN) {
      return `${publishedT} of ${publishedN}`;
    }

    const coordinatorCount = election?.coordinator_npubs.length ?? 0;
    if (coordinatorCount === 1) {
      return "1 of 1";
    }

    return coordinatorCount > 1 ? `share of ${coordinatorCount}` : "share";
  }

  function getThresholdNumbers() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return { thresholdT: configuredT, thresholdN: configuredN };
    }

    const publishedT = election?.threshold_t;
    const publishedN = election?.threshold_n;

    if (publishedT && publishedN) {
      return { thresholdT: publishedT, thresholdN: publishedN };
    }

    const coordinatorCount = election?.coordinator_npubs.length ?? 0;
    if (coordinatorCount === 1) {
      return { thresholdT: 1, thresholdN: 1 };
    }

    if (coordinatorCount > 1) {
      return { thresholdN: coordinatorCount };
    }

    return {};
  }

  async function sendShard(request: SimpleShardRequest) {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");

    if (!coordinatorNpub || !coordinatorSecretKey || !coordinatorId || coordinatorId === "pending") {
      return;
    }

    setRequestStatuses((current) => ({ ...current, [request.id]: "Sending shard..." }));

    try {
      const thresholdLabel = activeThresholdT && activeThresholdN
        ? `${activeThresholdT} of ${activeThresholdN}`
        : getThresholdLabel();
      const result = await sendSimpleShardResponse({
        coordinatorSecretKey,
        voterNpub: request.voterNpub,
        requestId: request.id,
        coordinatorNpub,
        coordinatorId,
        thresholdLabel,
        votingId: publishedVote?.votingId ?? request.votingId,
        tokenCommitment: request.tokenCommitment,
        shareIndex: Number.parseInt(questionShareIndex, 10) || 1,
        thresholdT: activeThresholdT,
        thresholdN: activeThresholdN,
      });

      setRequestStatuses((current) => ({
        ...current,
        [request.id]: result.successes > 0 ? "Shard sent." : "Shard send failed.",
      }));
    } catch {
      setRequestStatuses((current) => ({ ...current, [request.id]: "Shard send failed." }));
    }
  }

  async function broadcastQuestion() {
    const coordinatorNsec = keypair?.nsec ?? "";
    const prompt = questionPrompt.trim();

    if (!coordinatorNsec || !prompt || !isLeadCoordinator) {
      return;
    }

    setPublishStatus("Broadcasting vote...");

    try {
      const threshold = getThresholdNumbers();
      const result = await publishSimpleLiveVote({
        coordinatorNsec,
        prompt,
        votingId: questionVotingId.trim() || undefined,
        thresholdT: threshold.thresholdT,
        thresholdN: threshold.thresholdN,
      });

      setPublishedVote({
        votingId: result.votingId,
        prompt,
        coordinatorNpub: result.coordinatorNpub,
        createdAt: result.createdAt,
        thresholdT: threshold.thresholdT,
        thresholdN: threshold.thresholdN,
        eventId: result.eventId,
      });
      setQuestionVotingId(result.votingId);
      setPublishStatus(result.successes > 0 ? "Vote broadcast." : "Vote broadcast failed.");
    } catch {
      setPublishStatus("Vote broadcast failed.");
    }
  }

  const requiredShardCount = Math.max(1, publishedVote?.thresholdT ?? 1);
  const validatedVotes = validateSimpleSubmittedVotes(submittedVotes, requiredShardCount);
  const validYesCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "Yes").length;
  const validNoCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "No").length;
  const votingPackage = publishedVote
    ? serializeSimpleVotingPackage({
        votingId: publishedVote.votingId,
        coordinatorNpub: keypair?.npub ?? undefined,
        coordinators: keypair?.npub ? [keypair.npub] : undefined,
        prompt: publishedVote.prompt,
        thresholdT: publishedVote.thresholdT,
        thresholdN: publishedVote.thresholdN,
      })
    : "";

  return (
    <main className="simple-voter-shell">
      <section className="simple-voter-page">
        <h1 className="simple-voter-title">Coordinator ID {coordinatorId}</h1>

        <div className="simple-voter-action-row">
          <button type="button" className="simple-voter-primary" onClick={createNostrKeypair}>
            Create Nostr keypair
          </button>
        </div>

        <SimpleIdentityPanel
          npub={keypair?.npub ?? ""}
          nsec={keypair?.nsec ?? ""}
        />

        {publishedVote && (
          <section className="simple-voter-section" aria-labelledby="voting-package-title">
            <h2 id="voting-package-title" className="simple-voter-section-title">Voting details</h2>
            <SimpleQrPanel
              value={votingPackage}
              title="Phone scan details"
              description="Show this QR on the coordinator screen. Voters can scan it, or paste the voting ID and coordinator npub details manually."
              copyLabel="Copy voting details"
            />
          </section>
        )}

        <section className="simple-voter-section" aria-labelledby="shard-requests-title">
          <h2 id="shard-requests-title" className="simple-voter-section-title">Received shard requests</h2>
          {requests.length > 0 ? (
            <ul className="simple-voter-list">
              {requests.map((request) => (
                <li key={request.id} className="simple-voter-list-item">
                  <p className="simple-voter-question">Request from voter {request.voterId}</p>
                  <div className="simple-voter-action-row">
                    <button
                      type="button"
                      className="simple-voter-secondary"
                      onClick={() => void sendShard(request)}
                      disabled={!keypair?.nsec}
                    >
                      Send shard
                    </button>
                  </div>
                  {requestStatuses[request.id] && (
                    <p className="simple-voter-note">{requestStatuses[request.id]}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="simple-voter-empty">No shard requests received yet.</p>
          )}
        </section>

        <section className="simple-voter-section" aria-labelledby="question-config-title">
          <h2 id="question-config-title" className="simple-voter-section-title">Question config</h2>
          <label className="simple-voter-label" htmlFor="simple-lead-coordinator-npub">Lead coordinator npub</label>
          <input
            id="simple-lead-coordinator-npub"
            className="simple-voter-input"
            value={leadCoordinatorNpub}
            onChange={(event) => setLeadCoordinatorNpub(event.target.value)}
            placeholder="Leave blank if this coordinator is the lead"
          />
          <p className="simple-voter-question">
            {isLeadCoordinator
              ? "This coordinator publishes the live question."
              : "This coordinator follows the lead question and only issues shares."}
          </p>
          <label className="simple-voter-label" htmlFor="simple-question-prompt">Question</label>
          <textarea
            id="simple-question-prompt"
            className="simple-voter-textarea"
            value={questionPrompt}
            onChange={(event) => setQuestionPrompt(event.target.value)}
            rows={3}
            disabled={!isLeadCoordinator}
          />
          <label className="simple-voter-label" htmlFor="simple-question-voting-id">Voting ID</label>
          <input
            id="simple-question-voting-id"
            className="simple-voter-input"
            value={questionVotingId}
            onChange={(event) => setQuestionVotingId(event.target.value)}
            disabled={!isLeadCoordinator}
          />
          <div className="simple-vote-threshold-grid">
            <div>
              <label className="simple-voter-label" htmlFor="simple-threshold-t">Threshold T</label>
              <input
                id="simple-threshold-t"
                className="simple-voter-input"
                value={questionThresholdT}
                onChange={(event) => setQuestionThresholdT(event.target.value)}
                disabled={!isLeadCoordinator}
              />
            </div>
            <div>
              <label className="simple-voter-label" htmlFor="simple-threshold-n">Threshold N</label>
              <input
                id="simple-threshold-n"
                className="simple-voter-input"
                value={questionThresholdN}
                onChange={(event) => setQuestionThresholdN(event.target.value)}
                disabled={!isLeadCoordinator}
              />
            </div>
            <div>
              <label className="simple-voter-label" htmlFor="simple-share-index">Share Index</label>
              <input
                id="simple-share-index"
                className="simple-voter-input"
                value={questionShareIndex}
                onChange={(event) => setQuestionShareIndex(event.target.value)}
              />
            </div>
          </div>
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => void broadcastQuestion()}
              disabled={!keypair?.nsec || questionPrompt.trim().length === 0 || !isLeadCoordinator}
            >
              Broadcast live vote
            </button>
          </div>
          <p className="simple-voter-question">
            Threshold: {activeThresholdT && activeThresholdN ? `${activeThresholdT} of ${activeThresholdN}` : getThresholdLabel()}
          </p>
          {publishStatus && <p className="simple-voter-note">{publishStatus}</p>}
          {publishedVote && (
            <>
              <p className="simple-voter-question">Voting ID {publishedVote.votingId.slice(0, 12)}</p>
              <p className="simple-voter-question">Live prompt: {publishedVote.prompt}</p>
              <p className="simple-voter-question">
                Question source: {publishedVote.coordinatorNpub === (keypair?.npub ?? "") ? "This coordinator" : "Lead coordinator"}
              </p>
              <p className="simple-voter-question">This coordinator share index: {questionShareIndex}</p>
            </>
          )}
        </section>

        <section className="simple-voter-section" aria-labelledby="submitted-votes-title">
          <h2 id="submitted-votes-title" className="simple-voter-section-title">Submitted votes</h2>
          {publishedVote ? (
            <>
              <p className="simple-voter-question">
                Yes: {validYesCount} | No: {validNoCount}
              </p>
              {validatedVotes.length > 0 ? (
                <ul className="simple-voter-list">
                  {validatedVotes.map(({ vote, valid, reason }) => (
                    <li key={vote.eventId} className="simple-voter-list-item">
                      <div className="simple-vote-entry">
                        <div className="simple-vote-entry-copy">
                          <p className="simple-voter-question">
                            Vote {vote.choice} from {vote.voterNpub.slice(0, 16)}... {valid ? "(Valid)" : `(Invalid: ${reason})`}
                          </p>
                        </div>
                        {vote.tokenId && <TokenFingerprint tokenId={vote.tokenId} />}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="simple-voter-empty">No votes received yet.</p>
              )}
            </>
          ) : (
            <p className="simple-voter-empty">No live vote has been broadcast yet.</p>
          )}
        </section>
      </section>
    </main>
  );
}

import { useEffect, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { fetchElection, type ElectionInfo } from "./coordinatorApi";
import { decodeNsec } from "./nostrIdentity";
import {
  fetchSimpleShardRequests,
  sendSimpleShardResponse,
  type SimpleShardRequest,
} from "./simpleShardDm";
import { sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";

const COORDINATOR_STORAGE_KEY = "auditable-voting.simple-coordinator-keypair";

type SimpleCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

type LiveVoteChoice = "Yes" | "No" | null;

function loadStoredCoordinatorKeypair(): SimpleCoordinatorKeypair | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(COORDINATOR_STORAGE_KEY);
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

  window.localStorage.setItem(COORDINATOR_STORAGE_KEY, JSON.stringify(keypair));
}

export default function SimpleCoordinatorApp() {
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [keypair, setKeypair] = useState<SimpleCoordinatorKeypair | null>(() => loadStoredCoordinatorKeypair());
  const [coordinatorId, setCoordinatorId] = useState("pending");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [requests, setRequests] = useState<SimpleShardRequest[]>([]);
  const [requestStatuses, setRequestStatuses] = useState<Record<string, string>>({});

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

  function createNostrKeypair() {
    const secretKey = generateSecretKey();
    const nextKeypair = {
      nsec: nip19.nsecEncode(secretKey),
      npub: nip19.npubEncode(getPublicKey(secretKey)),
    };
    storeCoordinatorKeypair(nextKeypair);
    setKeypair(nextKeypair);
  }

  function getThresholdLabel() {
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

  async function sendShard(request: SimpleShardRequest) {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");

    if (!coordinatorNpub || !coordinatorSecretKey || !coordinatorId || coordinatorId === "pending") {
      return;
    }

    setRequestStatuses((current) => ({ ...current, [request.id]: "Sending shard..." }));

    try {
      const result = await sendSimpleShardResponse({
        coordinatorSecretKey,
        voterNpub: request.voterNpub,
        requestId: request.id,
        coordinatorNpub,
        coordinatorId,
        thresholdLabel: getThresholdLabel(),
      });

      setRequestStatuses((current) => ({
        ...current,
        [request.id]: result.successes > 0 ? "Shard sent." : "Shard send failed.",
      }));
    } catch {
      setRequestStatuses((current) => ({ ...current, [request.id]: "Shard send failed." }));
    }
  }

  const liveYesNoQuestion = election?.questions.find((question) => {
    const options = (question.options ?? []).map((option) => option.toLowerCase());
    return question.type === "choice" && options.includes("yes") && options.includes("no");
  }) ?? null;

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

        {keypair?.npub && (
          <section className="simple-voter-section" aria-labelledby="voter-link-title">
            <h2 id="voter-link-title" className="simple-voter-section-title">Voter request link</h2>
            <p className="simple-voter-question">
              Open the voter page with this coordinator selected.
            </p>
            <code className="simple-identity-code">
              {`${window.location.origin}/simple.html?coordinator=${encodeURIComponent(keypair.npub)}`}
            </code>
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

        <section className="simple-voter-section" aria-labelledby="coordinator-live-vote-title">
          <h2 id="coordinator-live-vote-title" className="simple-voter-section-title">Live Y/N vote</h2>
          {liveYesNoQuestion ? (
            <>
              <p className="simple-voter-question">{liveYesNoQuestion.prompt}</p>
              <div className="simple-voter-choice-row">
                <button
                  type="button"
                  className={`simple-voter-choice${liveVoteChoice === "Yes" ? " is-active" : ""}`}
                  onClick={() => setLiveVoteChoice("Yes")}
                >
                  Yes
                </button>
                <button
                  type="button"
                  className={`simple-voter-choice${liveVoteChoice === "No" ? " is-active" : ""}`}
                  onClick={() => setLiveVoteChoice("No")}
                >
                  No
                </button>
              </div>
            </>
          ) : (
            <p className="simple-voter-empty">No live Y/N vote.</p>
          )}
        </section>
      </section>
    </main>
  );
}

import { useEffect, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { fetchElection, type ElectionInfo } from "./coordinatorApi";
import { sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";

const COORDINATOR_STORAGE_KEY = "auditable-voting.simple-coordinator-keypair";

type StoredCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

type LiveVoteChoice = "Yes" | "No" | null;

function loadStoredCoordinatorKeypair(): StoredCoordinatorKeypair | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(COORDINATOR_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as StoredCoordinatorKeypair;
  } catch {
    return null;
  }
}

function storeCoordinatorKeypair(keypair: StoredCoordinatorKeypair) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(COORDINATOR_STORAGE_KEY, JSON.stringify(keypair));
}

export default function SimpleCoordinatorApp() {
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [keypair, setKeypair] = useState<StoredCoordinatorKeypair | null>(() => loadStoredCoordinatorKeypair());
  const [coordinatorId, setCoordinatorId] = useState("pending");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);

  useEffect(() => {
    void fetchElection().then((nextElection) => {
      setElection(nextElection);
    }).catch(() => {
      setElection(null);
    });
  }, []);

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

        <section className="simple-voter-section" aria-labelledby="shard-requests-title">
          <h2 id="shard-requests-title" className="simple-voter-section-title">Received shard requests</h2>
          <p className="simple-voter-empty">No shard requests received yet.</p>
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

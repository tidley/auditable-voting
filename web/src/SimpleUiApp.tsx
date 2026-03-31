import { useEffect, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  loadStoredWalletBundle,
  storeEphemeralKeypair,
  type StoredWalletBundle,
} from "./cashuWallet";
import { decodeNsec } from "./nostrIdentity";
import { fetchElection, normalizeElectionInfo, type ElectionInfo } from "./coordinatorApi";
import { sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import {
  fetchSimpleShardResponses,
  sendSimpleShardRequest,
  type SimpleShardResponse,
} from "./simpleShardDm";
import { fetchLatestSimpleLiveVote, type SimpleLiveVoteSession } from "./simpleVotingSession";

type LiveVoteChoice = "Yes" | "No" | null;

export default function SimpleUiApp() {
  const [walletBundle, setWalletBundle] = useState<StoredWalletBundle | null>(() => loadStoredWalletBundle());
  const [election, setElection] = useState<ElectionInfo | null>(
    normalizeElectionInfo(walletBundle?.election),
  );
  const [voterId, setVoterId] = useState<string>("pending");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [coordinatorNpub, setCoordinatorNpub] = useState<string>("");
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [liveVoteSession, setLiveVoteSession] = useState<SimpleLiveVoteSession | null>(null);

  useEffect(() => {
    let cancelled = false;

    void fetchElection().then((nextElection) => {
      if (!cancelled) {
        setElection(nextElection ?? normalizeElectionInfo(walletBundle?.election));
      }
    }).catch(() => {
      if (!cancelled) {
        setElection(normalizeElectionInfo(walletBundle?.election));
      }
    });

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
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    setCoordinatorNpub(params.get("coordinator")?.trim() ?? "");
  }, []);

  useEffect(() => {
    const voterNsec = walletBundle?.ephemeralKeypair.nsec?.trim() ?? "";

    if (!voterNsec) {
      setReceivedShards([]);
      return;
    }

    let cancelled = false;

    async function refreshResponses() {
      try {
        const nextResponses = await fetchSimpleShardResponses({ voterNsec });
        if (!cancelled) {
          setReceivedShards(nextResponses);
        }
      } catch {
        if (!cancelled) {
          setReceivedShards([]);
        }
      }
    }

    void refreshResponses();
    const intervalId = window.setInterval(() => {
      void refreshResponses();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [walletBundle?.ephemeralKeypair.nsec]);

  useEffect(() => {
    const activeCoordinatorNpub = coordinatorNpub || receivedShards[0]?.coordinatorNpub || "";

    if (!activeCoordinatorNpub) {
      setLiveVoteSession(null);
      return;
    }

    let cancelled = false;

    async function refreshLiveVote() {
      try {
        const nextSession = await fetchLatestSimpleLiveVote({ coordinatorNpub: activeCoordinatorNpub });
        if (!cancelled) {
          setLiveVoteSession(nextSession);
        }
      } catch {
        if (!cancelled) {
          setLiveVoteSession(null);
        }
      }
    }

    void refreshLiveVote();
    const intervalId = window.setInterval(() => {
      void refreshLiveVote();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [coordinatorNpub, receivedShards]);

  useEffect(() => {
    let cancelled = false;

    const npub = walletBundle?.ephemeralKeypair.npub?.trim() ?? "";
    if (!npub) {
      setVoterId("pending");
      return () => {
        cancelled = true;
      };
    }

    void sha256Hex(npub).then((hash) => {
      if (!cancelled) {
        setVoterId(hash.slice(0, 7));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [walletBundle?.ephemeralKeypair.npub]);

  function createNostrKeypair() {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    const npub = nip19.npubEncode(getPublicKey(secretKey));
    storeEphemeralKeypair(nsec, npub);
    setWalletBundle(loadStoredWalletBundle());
  }

  async function requestVotingShard() {
    const voterNpub = walletBundle?.ephemeralKeypair.npub ?? "";
    const voterNsec = walletBundle?.ephemeralKeypair.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);

    if (!voterNpub || !coordinatorNpub || voterId === "pending" || !voterSecretKey) {
      return;
    }

    try {
      const result = await sendSimpleShardRequest({
        voterSecretKey,
        coordinatorNpub,
        voterNpub,
        voterId,
      });

      setRequestStatus(
        result.successes > 0
          ? "Voting shard requested."
          : "Shard request failed.",
      );
    } catch {
      setRequestStatus("Shard request failed.");
    }
  }

  return (
    <main className="simple-voter-shell">
      <section className="simple-voter-page">
        <h1 className="simple-voter-title">Voter ID {voterId}</h1>

        <div className="simple-voter-action-row">
          <button type="button" className="simple-voter-primary" onClick={createNostrKeypair}>
            Create Nostr keypair
          </button>
        </div>

        <SimpleIdentityPanel
          npub={walletBundle?.ephemeralKeypair.npub ?? ""}
          nsec={walletBundle?.ephemeralKeypair.nsec ?? ""}
        />

        <section className="simple-voter-section" aria-labelledby="request-shard-title">
          <h2 id="request-shard-title" className="simple-voter-section-title">Request voting shard</h2>
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => void requestVotingShard()}
              disabled={!walletBundle?.ephemeralKeypair.npub || !coordinatorNpub}
            >
              Request voting shard
            </button>
          </div>
          {requestStatus && <p className="simple-voter-note">{requestStatus}</p>}
          {!coordinatorNpub && (
            <p className="simple-voter-empty">Open this page from a coordinator request link first.</p>
          )}
        </section>

        <section className="simple-voter-section" aria-labelledby="received-shards-title">
          <h2 id="received-shards-title" className="simple-voter-section-title">Received vote shards</h2>
          {receivedShards.length > 0 ? (
            <ul className="simple-voter-list">
              {receivedShards.map((shard) => (
                <li key={shard.id} className="simple-voter-list-item">
                  Shard from coordinator {shard.coordinatorId} ({shard.thresholdLabel})
                </li>
              ))}
            </ul>
          ) : (
            <p className="simple-voter-empty">No vote shards received yet.</p>
          )}
        </section>

        <section className="simple-voter-section" aria-labelledby="live-vote-title">
          <h2 id="live-vote-title" className="simple-voter-section-title">Live Y/N vote</h2>
          {liveVoteSession ? (
            <>
              <p className="simple-voter-question">{liveVoteSession.prompt}</p>
              <p className="simple-voter-note">Voting ID {liveVoteSession.votingId.slice(0, 12)}</p>
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

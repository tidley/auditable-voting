import { useEffect, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  loadStoredWalletBundle,
  storeEphemeralKeypair,
  type StoredWalletBundle,
} from "./cashuWallet";
import { fetchElection, normalizeElectionInfo, type ElectionInfo } from "./coordinatorApi";
import { deriveTokenIdFromProofSecrets, sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";

type LiveVoteChoice = "Yes" | "No" | null;

export default function SimpleUiApp() {
  const [walletBundle, setWalletBundle] = useState<StoredWalletBundle | null>(() => loadStoredWalletBundle());
  const [election, setElection] = useState<ElectionInfo | null>(
    normalizeElectionInfo(walletBundle?.election),
  );
  const [tokenId, setTokenId] = useState<string | null>(null);
  const [voterId, setVoterId] = useState<string>("pending");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);

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

  const shards = walletBundle?.coordinatorProofs ?? [];
  const liveYesNoQuestion = election?.questions.find((question) => {
    const options = (question.options ?? []).map((option) => option.toLowerCase());
    return question.type === "choice" && options.includes("yes") && options.includes("no");
  }) ?? null;

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

        <section className="simple-voter-section" aria-labelledby="received-shards-title">
          <h2 id="received-shards-title" className="simple-voter-section-title">Received vote shards</h2>
          {shards.length > 0 ? (
            <ul className="simple-voter-list">
              {shards.map((shard, index) => (
                <li key={`${shard.coordinatorNpub}-${index}`} className="simple-voter-list-item">
                  Shard {index + 1}: {shard.coordinatorNpub.slice(0, 16)}...
                </li>
              ))}
            </ul>
          ) : (
            <p className="simple-voter-empty">No vote shards received yet.</p>
          )}
        </section>

        <section className="simple-voter-section" aria-labelledby="live-vote-title">
          <h2 id="live-vote-title" className="simple-voter-section-title">Live Y/N vote</h2>
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

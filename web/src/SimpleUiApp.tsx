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
import TokenFingerprint from "./TokenFingerprint";
import {
  deriveTokenIdFromSimpleShardCertificates,
  parseSimpleShardCertificate,
} from "./simpleShardCertificate";
import {
  fetchSimpleShardResponses,
  sendSimpleShardRequest,
  type SimpleShardResponse,
} from "./simpleShardDm";
import {
  fetchSimpleLiveVotes,
  publishSimpleSubmittedVote,
  type SimpleLiveVoteSession,
} from "./simpleVotingSession";

type LiveVoteChoice = "Yes" | "No" | null;

export default function SimpleUiApp() {
  const [walletBundle, setWalletBundle] = useState<StoredWalletBundle | null>(() => loadStoredWalletBundle());
  const [election, setElection] = useState<ElectionInfo | null>(
    normalizeElectionInfo(walletBundle?.election),
  );
  const [voterId, setVoterId] = useState<string>("pending");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [coordinatorNpub, setCoordinatorNpub] = useState<string>("");
  const [selectedVotingId, setSelectedVotingId] = useState<string>("");
  const [participatingCoordinators, setParticipatingCoordinators] = useState<string[]>([]);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [liveVoteSession, setLiveVoteSession] = useState<SimpleLiveVoteSession | null>(null);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);

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
    setSelectedVotingId(params.get("voting")?.trim() ?? "");
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
    if (!coordinatorNpub && !selectedVotingId && receivedShards.length === 0) {
      setLiveVoteSession(null);
      setParticipatingCoordinators([]);
      return;
    }

    let cancelled = false;

    async function refreshLiveVote() {
      try {
        const sessions = await fetchSimpleLiveVotes();
        const candidateVotingId = selectedVotingId
          || sessions.find((session) => session.coordinatorNpub === coordinatorNpub)?.votingId
          || "";
        const matchingSessions = candidateVotingId
          ? sessions.filter((session) => session.votingId === candidateVotingId)
          : [];
        const nextSession = matchingSessions[0] ?? null;
        if (!cancelled) {
          setLiveVoteSession(nextSession);
          setParticipatingCoordinators(matchingSessions.map((session) => session.coordinatorNpub));
          if (nextSession?.votingId) {
            setSelectedVotingId(nextSession.votingId);
          }
        }
      } catch {
        if (!cancelled) {
          setLiveVoteSession(null);
          setParticipatingCoordinators([]);
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
  }, [coordinatorNpub, receivedShards, selectedVotingId]);

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
    const votingId = liveVoteSession?.votingId ?? selectedVotingId;

    if (!voterNpub || voterId === "pending" || !voterSecretKey || !votingId) {
      return;
    }

    try {
      const tokenCommitment = await sha256Hex(`${voterNsec}:${votingId}:simple-threshold-token`);
      const targets = Array.from(new Set([
        ...participatingCoordinators,
        ...(coordinatorNpub ? [coordinatorNpub] : []),
      ])).filter((value) => value.trim().length > 0);

      const results = await Promise.all(targets.map((targetCoordinatorNpub) => (
        sendSimpleShardRequest({
          voterSecretKey,
          coordinatorNpub: targetCoordinatorNpub,
          voterNpub,
          voterId,
          votingId,
          tokenCommitment,
        })
      )));
      const successes = results.reduce((sum, result) => sum + result.successes, 0);

      setRequestStatus(
        successes > 0
          ? `Voting share request sent to ${targets.length} coordinator${targets.length === 1 ? "" : "s"}.`
          : "Shard request failed.",
      );
    } catch {
      setRequestStatus("Shard request failed.");
    }
  }

  const tokenCommitmentBasis = walletBundle?.ephemeralKeypair.nsec && (liveVoteSession?.votingId ?? selectedVotingId)
    ? `${walletBundle.ephemeralKeypair.nsec}:${liveVoteSession?.votingId ?? selectedVotingId}:simple-threshold-token`
    : "";
  const [tokenCommitment, setTokenCommitment] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    if (!tokenCommitmentBasis) {
      setTokenCommitment("");
      return () => {
        cancelled = true;
      };
    }
    void sha256Hex(tokenCommitmentBasis).then((value) => {
      if (!cancelled) {
        setTokenCommitment(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [tokenCommitmentBasis]);

  const uniqueShardResponses = Array.from(
    new Map(
      receivedShards.flatMap((shard) => {
        const parsed = parseSimpleShardCertificate(shard.shardCertificate);
        if (!parsed || parsed.votingId !== (liveVoteSession?.votingId ?? selectedVotingId) || parsed.tokenCommitment !== tokenCommitment) {
          return [];
        }
        return [[shard.coordinatorNpub, shard] as const];
      }),
    ).values(),
  );
  const requiredShardCount = Math.max(1, liveVoteSession?.thresholdT ?? 1);

  useEffect(() => {
    let cancelled = false;

    void deriveTokenIdFromSimpleShardCertificates(
      uniqueShardResponses.map((shard) => shard.shardCertificate),
    ).then((tokenId) => {
      if (!cancelled) {
        setBallotTokenId(tokenId);
      }
    }).catch(() => {
      if (!cancelled) {
        setBallotTokenId(null);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [receivedShards]);

  async function submitVote() {
    if (!liveVoteSession || !liveVoteChoice || uniqueShardResponses.length < requiredShardCount) {
      return;
    }

    setSubmitStatus("Submitting vote...");

    try {
      const ballotSecretKey = generateSecretKey();
      const ballotNsec = nip19.nsecEncode(ballotSecretKey);
      const result = await publishSimpleSubmittedVote({
        ballotNsec,
        votingId: liveVoteSession.votingId,
        choice: liveVoteChoice,
        shardCertificates: uniqueShardResponses.map((shard) => shard.shardCertificate),
      });

      setSubmitStatus(result.successes > 0 ? `Vote submitted: ${liveVoteChoice}.` : "Vote submission failed.");
    } catch {
      setSubmitStatus("Vote submission failed.");
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
          <h2 id="request-shard-title" className="simple-voter-section-title">Request voting shares</h2>
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => void requestVotingShard()}
              disabled={!walletBundle?.ephemeralKeypair.npub || !(liveVoteSession?.votingId ?? selectedVotingId)}
            >
              Request voting shares
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
              <p className="simple-voter-question">Coordinators: {participatingCoordinators.length || 1}</p>
              <p className="simple-voter-question">
                Shards ready: {uniqueShardResponses.length} of {requiredShardCount}
              </p>
              {ballotTokenId && (
                <div className="simple-vote-entry">
                  <div className="simple-vote-entry-copy">
                    <p className="simple-voter-question">Ballot fingerprint</p>
                  </div>
                  <TokenFingerprint tokenId={ballotTokenId} />
                </div>
              )}
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
              <div className="simple-voter-action-row simple-voter-action-row-tight">
                <button
                  type="button"
                  className="simple-voter-primary"
                  onClick={() => void submitVote()}
                  disabled={!liveVoteChoice || uniqueShardResponses.length < requiredShardCount}
                >
                  Submit vote
                </button>
              </div>
              {submitStatus && <p className="simple-voter-note">{submitStatus}</p>}
            </>
          ) : (
            <p className="simple-voter-empty">No live Y/N vote.</p>
          )}
        </section>
      </section>
    </main>
  );
}

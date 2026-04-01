import { useEffect, useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec } from "./nostrIdentity";
import { sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import TokenFingerprint from "./TokenFingerprint";
import {
  deriveTokenIdFromSimpleShardCertificates,
  parseSimpleShardCertificate,
} from "./simpleShardCertificate";
import {
  sendSimpleCoordinatorFollow,
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
type SimpleVoterKeypair = {
  nsec: string;
  npub: string;
};

type VoteTicketRow = {
  votingId: string;
  countsByCoordinator: Record<string, number>;
};

const SIMPLE_VOTER_STORAGE_KEY = "auditable-voting.simple-voter-keypair";

function normalizeCoordinatorNpubs(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function getLatestSessionsByCoordinator(sessions: SimpleLiveVoteSession[]) {
  const latestByCoordinator = new Map<string, SimpleLiveVoteSession>();
  for (const session of sessions) {
    const current = latestByCoordinator.get(session.coordinatorNpub);
    if (!current || current.createdAt.localeCompare(session.createdAt) < 0) {
      latestByCoordinator.set(session.coordinatorNpub, session);
    }
  }
  return [...latestByCoordinator.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function loadStoredSimpleVoterKeypair(): SimpleVoterKeypair | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(SIMPLE_VOTER_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as SimpleVoterKeypair;
  } catch {
    return null;
  }
}

function storeSimpleVoterKeypair(keypair: SimpleVoterKeypair) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(SIMPLE_VOTER_STORAGE_KEY, JSON.stringify(keypair));
}

function createSimpleVoterKeypair(): SimpleVoterKeypair {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

export default function SimpleUiApp() {
  const [voterKeypair, setVoterKeypair] = useState<SimpleVoterKeypair | null>(() => loadStoredSimpleVoterKeypair());
  const [voterId, setVoterId] = useState<string>("pending");
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([""]);
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [selectedVotingId, setSelectedVotingId] = useState<string>("");
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [liveVoteSession, setLiveVoteSession] = useState<SimpleLiveVoteSession | null>(null);
  const [participatingCoordinators, setParticipatingCoordinators] = useState<string[]>([]);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);
  const [ticketRequestNonce, setTicketRequestNonce] = useState<string>("");
  const [pendingTicketRequest, setPendingTicketRequest] = useState(false);
  const [lastRequestedVotingId, setLastRequestedVotingId] = useState<string>("");

  const configuredCoordinatorTargets = useMemo(
    () => normalizeCoordinatorNpubs(manualCoordinators),
    [manualCoordinators],
  );
  const configuredCoordinatorTargetsKey = configuredCoordinatorTargets.join("|");

  useEffect(() => {
    if (voterKeypair) {
      return;
    }

    const nextKeypair = createSimpleVoterKeypair();
    storeSimpleVoterKeypair(nextKeypair);
    setVoterKeypair(nextKeypair);
  }, [voterKeypair]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const nextCoordinatorNpub = params.get("coordinator")?.trim() ?? "";
    const nextVotingId = params.get("voting")?.trim() ?? "";

    if (nextCoordinatorNpub) {
      setManualCoordinators([nextCoordinatorNpub]);
    }
    if (nextVotingId) {
      setSelectedVotingId(nextVotingId);
    }
  }, []);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

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
  }, [voterKeypair?.nsec]);

  useEffect(() => {
    if (configuredCoordinatorTargets.length === 0 && receivedShards.length === 0 && !selectedVotingId) {
      setLiveVoteSession(null);
      setParticipatingCoordinators([]);
      return;
    }

    let cancelled = false;

    async function refreshLiveVote() {
      try {
        const sessions = await fetchSimpleLiveVotes();
        const latestSessions = getLatestSessionsByCoordinator(sessions);
        const coordinatorScopedSessions = latestSessions.filter((session) => (
          configuredCoordinatorTargets.includes(session.coordinatorNpub)
        ));
        const currentRoundSessions = selectedVotingId
          ? coordinatorScopedSessions.filter((session) => session.votingId === selectedVotingId)
          : [];
        const nextSession = currentRoundSessions[0] ?? coordinatorScopedSessions[0] ?? null;
        const nextCoordinators = nextSession
          ? coordinatorScopedSessions
            .filter((session) => session.votingId === nextSession.votingId)
            .map((session) => session.coordinatorNpub)
          : configuredCoordinatorTargets;

        if (!cancelled) {
          setLiveVoteSession((current) => {
            if (nextSession) {
              return nextSession;
            }
            if (!current) {
              return null;
            }
            return configuredCoordinatorTargets.includes(current.coordinatorNpub) ? current : null;
          });
          setParticipatingCoordinators(Array.from(new Set(nextCoordinators)));
          if (nextSession?.votingId) {
            setSelectedVotingId(nextSession.votingId);
          }
        }
      } catch {
        // Keep the last known live vote on transient relay failures.
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
  }, [configuredCoordinatorTargetsKey, receivedShards, selectedVotingId]);

  useEffect(() => {
    let cancelled = false;

    const npub = voterKeypair?.npub?.trim() ?? "";
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
  }, [voterKeypair?.npub]);

  useEffect(() => {
    setTicketRequestNonce("");
    setLastRequestedVotingId("");
  }, [liveVoteSession?.votingId]);

  function refreshIdentity() {
    const nextKeypair = createSimpleVoterKeypair();
    storeSimpleVoterKeypair(nextKeypair);
    setVoterKeypair(nextKeypair);
    setLiveVoteChoice(null);
    setRequestStatus(null);
    setSubmitStatus(null);
    setBallotTokenId(null);
    setReceivedShards([]);
  }

  function updateCoordinatorInput(index: number, value: string) {
    setManualCoordinators((current) => current.map((entry, currentIndex) => (
      currentIndex === index ? value : entry
    )));
  }

  function addCoordinatorInput() {
    setManualCoordinators((current) => [...current, ""]);
  }

  function removeCoordinatorInput(index: number) {
    setManualCoordinators((current) => {
      const next = current.filter((_, currentIndex) => currentIndex !== index);
      return next.length > 0 ? next : [""];
    });
  }

  async function requestTicketsForLiveVote(session: SimpleLiveVoteSession) {
    const voterNpub = voterKeypair?.npub ?? "";
    const voterNsec = voterKeypair?.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);

    if (!voterNpub || voterId === "pending" || !voterSecretKey || configuredCoordinatorTargets.length === 0) {
      return false;
    }

    try {
      const nextTicketRequestNonce = crypto.randomUUID();
      const tokenCommitment = await sha256Hex(
        `${voterNsec}:${session.votingId}:${nextTicketRequestNonce}:simple-threshold-token`,
      );
      setTicketRequestNonce(nextTicketRequestNonce);
      const requestResults = await Promise.all(configuredCoordinatorTargets.map((coordinatorNpub) => (
        sendSimpleShardRequest({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
          voterId,
          votingId: session.votingId,
          tokenCommitment,
        })
      )));
      const requestSuccesses = requestResults.reduce((sum, result) => sum + result.successes, 0);

      if (requestSuccesses > 0) {
        setPendingTicketRequest(false);
        setLastRequestedVotingId(session.votingId);
      }
      setRequestStatus(
        requestSuccesses > 0
          ? `Coordinators notified. Vote tickets requested for ${shortVotingId(session.votingId)}.`
          : "Vote ticket request failed.",
      );
      return requestSuccesses > 0;
    } catch {
      setRequestStatus("Vote ticket request failed.");
      return false;
    }
  }

  async function notifyCoordinators() {
    const voterNpub = voterKeypair?.npub ?? "";
    const voterNsec = voterKeypair?.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);

    if (!voterNpub || voterId === "pending" || !voterSecretKey || configuredCoordinatorTargets.length === 0) {
      return;
    }

    setRequestStatus("Notifying coordinators...");

    try {
      const followResults = await Promise.all(configuredCoordinatorTargets.map(async (coordinatorNpub) => {
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
          voterId,
          votingId: liveVoteSession?.votingId || undefined,
        });
        return result.successes > 0;
      }));
      const followSuccesses = followResults.filter(Boolean).length;

      if (!liveVoteSession?.votingId) {
        setPendingTicketRequest(followSuccesses > 0);
        setRequestStatus(
          followSuccesses > 0
            ? "Coordinators notified. Waiting for a live vote before tickets can be issued."
            : "Coordinator notification failed.",
        );
        return;
      }

      await requestTicketsForLiveVote(liveVoteSession);
    } catch {
      setRequestStatus("Coordinator notification failed.");
    }
  }

  useEffect(() => {
    if (!pendingTicketRequest || !liveVoteSession || !voterKeypair?.npub || configuredCoordinatorTargets.length === 0) {
      return;
    }
    if (lastRequestedVotingId === liveVoteSession.votingId) {
      return;
    }

    void requestTicketsForLiveVote(liveVoteSession);
  }, [
    configuredCoordinatorTargets.length,
    lastRequestedVotingId,
    liveVoteSession,
    pendingTicketRequest,
    voterKeypair?.npub,
  ]);

  const tokenCommitmentBasis = voterKeypair?.nsec && liveVoteSession?.votingId && ticketRequestNonce
    ? `${voterKeypair.nsec}:${liveVoteSession.votingId}:${ticketRequestNonce}:simple-threshold-token`
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
        if (!parsed || parsed.votingId !== liveVoteSession?.votingId || parsed.tokenCommitment !== tokenCommitment) {
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
  }, [uniqueShardResponses]);

  const voteTicketRows = useMemo<VoteTicketRow[]>(() => {
    const rows = new Map<string, VoteTicketRow>();

    if (liveVoteSession?.votingId) {
      rows.set(liveVoteSession.votingId, {
        votingId: liveVoteSession.votingId,
        countsByCoordinator: {},
      });
    }

    for (const shard of receivedShards) {
      const parsed = parseSimpleShardCertificate(shard.shardCertificate);
      if (!parsed) {
        continue;
      }
      const current = rows.get(parsed.votingId) ?? {
        votingId: parsed.votingId,
        countsByCoordinator: {},
      };
      current.countsByCoordinator[shard.coordinatorNpub] = (current.countsByCoordinator[shard.coordinatorNpub] ?? 0) + 1;
      rows.set(parsed.votingId, current);
    }

    return [...rows.values()].sort((left, right) => right.votingId.localeCompare(left.votingId));
  }, [liveVoteSession?.votingId, receivedShards]);

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
        <div className="simple-voter-header-row">
          <h1 className="simple-voter-title">Voter ID {voterId}</h1>
          <button type="button" className="simple-voter-primary" onClick={refreshIdentity}>
            Refresh ID
          </button>
        </div>

        <SimpleIdentityPanel
          npub={voterKeypair?.npub ?? ""}
          nsec={voterKeypair?.nsec ?? ""}
          title="Identity"
        />

        <section className="simple-voter-section" aria-labelledby="coordinator-section-title">
          <h2 id="coordinator-section-title" className="simple-voter-section-title">Coordinators</h2>
          <div className="simple-voter-field-stack">
            <div className="simple-voter-field-head">
              <label className="simple-voter-label simple-voter-label-tight">Coordinator npubs</label>
              <button
                type="button"
                className="simple-voter-secondary"
                onClick={addCoordinatorInput}
              >
                Add coordinator
              </button>
            </div>
            {manualCoordinators.map((value, index) => (
              <div key={index} className="simple-voter-inline-field">
                <input
                  className="simple-voter-input simple-voter-input-inline"
                  value={value}
                  onChange={(event) => updateCoordinatorInput(index, event.target.value)}
                  placeholder="npub1..."
                />
                {manualCoordinators.length > 1 && (
                  <button
                    type="button"
                    className="simple-voter-secondary"
                    onClick={() => removeCoordinatorInput(index)}
                  >
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => void notifyCoordinators()}
              disabled={!voterKeypair?.npub || configuredCoordinatorTargets.length === 0}
            >
              Notify coordinators
            </button>
          </div>
          {requestStatus && <p className="simple-voter-note">{requestStatus}</p>}
          {configuredCoordinatorTargets.length === 0 && (
            <p className="simple-voter-empty">Add at least one coordinator npub.</p>
          )}
          <div className="simple-voter-ticket-area">
            <h3 className="simple-voter-question">Live Vote Tickets Received</h3>
            {voteTicketRows.length > 0 && configuredCoordinatorTargets.length > 0 ? (
              <div className="simple-voter-table-wrap">
                <table className="simple-voter-table">
                  <thead>
                    <tr>
                      <th scope="col">Vote</th>
                      {configuredCoordinatorTargets.map((coordinatorNpub, index) => (
                        <th key={coordinatorNpub} scope="col">Coord {index + 1}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {voteTicketRows.map((row) => (
                      <tr key={row.votingId}>
                        <th scope="row">{shortVotingId(row.votingId)}</th>
                        {configuredCoordinatorTargets.map((coordinatorNpub) => (
                          <td key={`${row.votingId}:${coordinatorNpub}`}>
                            {row.countsByCoordinator[coordinatorNpub] ?? 0}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="simple-voter-empty">No vote tickets received yet.</p>
            )}
          </div>
        </section>

        <section className="simple-voter-section" aria-labelledby="live-vote-title">
          <h2 id="live-vote-title" className="simple-voter-section-title">Live Vote</h2>
          {liveVoteSession ? (
            <>
              <p className="simple-voter-question">{liveVoteSession.prompt}</p>
              <p className="simple-voter-note">Vote {shortVotingId(liveVoteSession.votingId)}</p>
              <p className="simple-voter-question">
                Tickets ready: {uniqueShardResponses.length} of {requiredShardCount}
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
                <button
                  type="button"
                  className="simple-voter-primary"
                  onClick={() => void submitVote()}
                  disabled={!liveVoteChoice || uniqueShardResponses.length < requiredShardCount}
                >
                  Submit
                </button>
              </div>
              {submitStatus && <p className="simple-voter-note">{submitStatus}</p>}
            </>
          ) : (
            <p className="simple-voter-empty">No live vote yet.</p>
          )}
        </section>
      </section>
    </main>
  );
}

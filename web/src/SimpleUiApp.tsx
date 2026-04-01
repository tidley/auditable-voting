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

  const configuredCoordinatorTargets = useMemo(
    () => normalizeCoordinatorNpubs(manualCoordinators),
    [manualCoordinators],
  );
  const configuredCoordinatorTargetsKey = configuredCoordinatorTargets.join("|");
  const responseBackedLiveVoteSession = useMemo<SimpleLiveVoteSession | null>(() => {
    const candidateRows = receivedShards.flatMap((response) => {
      const parsed = parseSimpleShardCertificate(response.shardCertificate);
      if (!parsed || !configuredCoordinatorTargets.includes(response.coordinatorNpub)) {
        return [];
      }
      if (!response.votingPrompt) {
        return [];
      }
      return [{
        votingId: parsed.votingId,
        prompt: response.votingPrompt,
        coordinatorNpub: response.coordinatorNpub,
        createdAt: response.createdAt,
        thresholdT: parsed.thresholdT,
        thresholdN: parsed.thresholdN,
        eventId: `dm:${response.id}`,
      }];
    });

    candidateRows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return candidateRows[0] ?? null;
  }, [configuredCoordinatorTargets, receivedShards]);
  const effectiveLiveVoteSession = liveVoteSession ?? responseBackedLiveVoteSession;

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
    }, 2000);

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
    }, 2000);

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

      setRequestStatus(
        followSuccesses > 0
          ? "Coordinators notified. Waiting for round tickets."
          : "Coordinator notification failed.",
      );
    } catch {
      setRequestStatus("Coordinator notification failed.");
    }
  }

  const uniqueShardResponses = Array.from(
    new Map(
      receivedShards.flatMap((shard) => {
        const parsed = parseSimpleShardCertificate(shard.shardCertificate);
        const activeVotingId = effectiveLiveVoteSession?.votingId ?? "";
        if (!parsed || !activeVotingId || parsed.votingId !== activeVotingId) {
          return [];
        }
        return [[shard.coordinatorNpub, shard] as const];
      }),
    ).values(),
  );

  const requiredShardCount = Math.max(1, effectiveLiveVoteSession?.thresholdT ?? 1);

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

    if (effectiveLiveVoteSession?.votingId) {
      rows.set(effectiveLiveVoteSession.votingId, {
        votingId: effectiveLiveVoteSession.votingId,
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
  }, [effectiveLiveVoteSession?.votingId, receivedShards]);

  async function submitVote() {
    if (!effectiveLiveVoteSession || !liveVoteChoice || uniqueShardResponses.length < requiredShardCount) {
      return;
    }

    setSubmitStatus("Submitting vote...");

    try {
      const ballotSecretKey = generateSecretKey();
      const ballotNsec = nip19.nsecEncode(ballotSecretKey);
      const result = await publishSimpleSubmittedVote({
        ballotNsec,
        votingId: effectiveLiveVoteSession.votingId,
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
          {effectiveLiveVoteSession ? (
            <>
              <p className="simple-voter-question">{effectiveLiveVoteSession.prompt}</p>
              <p className="simple-voter-note">Vote {shortVotingId(effectiveLiveVoteSession.votingId)}</p>
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

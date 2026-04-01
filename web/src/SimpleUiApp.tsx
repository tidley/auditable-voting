import { useEffect, useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec } from "./nostrIdentity";
import { sha256Hex } from "./tokenIdentity";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import TokenFingerprint from "./TokenFingerprint";
import {
  deriveTokenIdFromSimpleShardCertificates,
  parseSimpleShardCertificate,
} from "./simpleShardCertificate";
import {
  sendSimpleCoordinatorFollow,
  subscribeSimpleShardResponses,
  type SimpleShardResponse,
} from "./simpleShardDm";
import {
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
  prompt: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  countsByCoordinator: Record<string, number>;
};

const SIMPLE_VOTER_STORAGE_KEY = "auditable-voting.simple-voter-keypair";

function normalizeCoordinatorNpubs(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function shortenNpub(value: string) {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-8)}`;
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
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([]);
  const [coordinatorDraft, setCoordinatorDraft] = useState("");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);
  const [selectedVotingId, setSelectedVotingId] = useState("");

  const configuredCoordinatorTargets = useMemo(
    () => normalizeCoordinatorNpubs(manualCoordinators),
    [manualCoordinators],
  );

  useEffect(() => {
    if (voterKeypair) {
      return;
    }

    const nextKeypair = createSimpleVoterKeypair();
    storeSimpleVoterKeypair(nextKeypair);
    setVoterKeypair(nextKeypair);
  }, [voterKeypair]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec) {
      setReceivedShards([]);
      return;
    }

    setReceivedShards([]);

    return subscribeSimpleShardResponses({
      voterNsec,
      onResponses: (nextResponses) => {
        setReceivedShards(nextResponses);
      },
    });
  }, [voterKeypair?.nsec]);

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
    setLiveVoteChoice(null);
    setSubmitStatus(null);
  }, [selectedVotingId]);

  function refreshIdentity() {
    const nextKeypair = createSimpleVoterKeypair();
    storeSimpleVoterKeypair(nextKeypair);
    setVoterKeypair(nextKeypair);
    setLiveVoteChoice(null);
    setRequestStatus(null);
    setSubmitStatus(null);
    setBallotTokenId(null);
    setReceivedShards([]);
    setSelectedVotingId("");
  }

  function addCoordinatorInput() {
    const nextCoordinator = coordinatorDraft.trim();
    if (!nextCoordinator) {
      return;
    }

    setManualCoordinators((current) => normalizeCoordinatorNpubs([...current, nextCoordinator]));
    setCoordinatorDraft("");
    setRequestStatus(null);
  }

  function removeCoordinatorInput(index: number) {
    setManualCoordinators((current) => current.filter((_, currentIndex) => currentIndex !== index));
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
        const activeVotingId = selectedVotingId.trim();

        if (
          !parsed
          || !activeVotingId
          || parsed.votingId !== activeVotingId
          || !configuredCoordinatorTargets.includes(shard.coordinatorNpub)
        ) {
          return [];
        }

        return [[shard.coordinatorNpub, shard] as const];
      }),
    ).values(),
  );

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

    for (const shard of receivedShards) {
      const parsed = parseSimpleShardCertificate(shard.shardCertificate);
      if (!parsed || !configuredCoordinatorTargets.includes(shard.coordinatorNpub) || !shard.votingPrompt) {
        continue;
      }

      const current = rows.get(parsed.votingId) ?? {
        votingId: parsed.votingId,
        prompt: shard.votingPrompt,
        createdAt: shard.createdAt,
        thresholdT: parsed.thresholdT,
        thresholdN: parsed.thresholdN,
        countsByCoordinator: {},
      };
      if (shard.createdAt > current.createdAt) {
        current.createdAt = shard.createdAt;
        current.prompt = shard.votingPrompt;
        current.thresholdT = parsed.thresholdT;
        current.thresholdN = parsed.thresholdN;
      }
      current.countsByCoordinator[shard.coordinatorNpub] = (current.countsByCoordinator[shard.coordinatorNpub] ?? 0) + 1;
      rows.set(parsed.votingId, current);
    }

    return [...rows.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [configuredCoordinatorTargets, receivedShards]);

  useEffect(() => {
    if (!voteTicketRows.length) {
      setSelectedVotingId("");
      return;
    }

    setSelectedVotingId((current) => (
      voteTicketRows.some((row) => row.votingId === current) ? current : voteTicketRows[0].votingId
    ));
  }, [voteTicketRows]);

  const effectiveLiveVoteSession = useMemo<SimpleLiveVoteSession | null>(() => {
    const selectedRow = voteTicketRows.find((row) => row.votingId === selectedVotingId) ?? voteTicketRows[0] ?? null;
    if (!selectedRow) {
      return null;
    }

    const sourceResponse = receivedShards.find((response) => {
      const parsed = parseSimpleShardCertificate(response.shardCertificate);
      return parsed?.votingId === selectedRow.votingId && configuredCoordinatorTargets.includes(response.coordinatorNpub);
    });

    return {
      votingId: selectedRow.votingId,
      prompt: selectedRow.prompt,
      coordinatorNpub: sourceResponse?.coordinatorNpub ?? "",
      createdAt: selectedRow.createdAt,
      thresholdT: selectedRow.thresholdT,
      thresholdN: selectedRow.thresholdN,
      eventId: `ticket-row:${selectedRow.votingId}`,
    };
  }, [configuredCoordinatorTargets, receivedShards, selectedVotingId, voteTicketRows]);

  const requiredShardCount = Math.max(1, effectiveLiveVoteSession?.thresholdT ?? 1);

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

        <SimpleCollapsibleSection title="Coordinators">
          <div className="simple-voter-field-stack simple-voter-field-stack-tight">
            <label className="simple-voter-label simple-voter-label-tight" htmlFor="simple-coordinator-draft">Coordinator npubs</label>
            <div className="simple-voter-add-row">
              <input
                id="simple-coordinator-draft"
                className="simple-voter-input simple-voter-input-inline"
                value={coordinatorDraft}
                onChange={(event) => setCoordinatorDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addCoordinatorInput();
                  }
                }}
                placeholder="Enter npub..."
              />
              <button
                type="button"
                className="simple-voter-add-button"
                onClick={addCoordinatorInput}
                aria-label="Add coordinator"
              >
                +
              </button>
            </div>
            {configuredCoordinatorTargets.length > 0 ? (
              <ul className="simple-coordinator-card-list">
                {configuredCoordinatorTargets.map((value, index) => (
                  <li key={value} className="simple-coordinator-card">
                    <div className="simple-coordinator-card-avatar" aria-hidden="true">•</div>
                    <div className="simple-coordinator-card-copy">
                      <p className="simple-coordinator-card-title">Coordinator {index + 1}</p>
                      <p className="simple-coordinator-card-meta" title={value}>{shortenNpub(value)}</p>
                    </div>
                    <button
                      type="button"
                      className="simple-coordinator-card-remove"
                      onClick={() => removeCoordinatorInput(index)}
                      aria-label={`Remove coordinator ${index + 1}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="simple-voter-empty">No coordinators added yet.</p>
            )}
          </div>
          <div className="simple-voter-action-row simple-voter-action-row-tight">
            <button
              type="button"
              className="simple-voter-primary simple-voter-primary-wide"
              onClick={() => void notifyCoordinators()}
              disabled={!voterKeypair?.npub || configuredCoordinatorTargets.length === 0}
            >
              Notify coordinators
            </button>
          </div>
          {requestStatus && <p className="simple-voter-note">{requestStatus}</p>}
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
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title="Live Vote">
          {effectiveLiveVoteSession ? (
            <>
              {voteTicketRows.length > 1 ? (
                <>
                  <label className="simple-voter-label" htmlFor="simple-live-round">Round</label>
                  <select
                    id="simple-live-round"
                    className="simple-voter-input"
                    value={effectiveLiveVoteSession.votingId}
                    onChange={(event) => setSelectedVotingId(event.target.value)}
                  >
                    {voteTicketRows.map((row) => (
                      <option key={row.votingId} value={row.votingId}>
                        {shortVotingId(row.votingId)} - {row.prompt}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
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
                  <TokenFingerprint tokenId={ballotTokenId} large />
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
            <p className="simple-voter-empty">No live vote ticket yet.</p>
          )}
        </SimpleCollapsibleSection>
      </section>
    </main>
  );
}

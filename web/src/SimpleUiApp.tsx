import { useEffect, useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec } from "./nostrIdentity";
import { sha256Hex } from "./tokenIdentity";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import TokenFingerprint from "./TokenFingerprint";
import {
  deriveTokenIdFromSimpleShardCertificates,
  createSimpleBlindIssuanceRequest,
  parseSimpleShardCertificate,
  subscribeLatestSimpleBlindKeyAnnouncement,
  unblindSimpleBlindShare,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindRequestSecret,
} from "./simpleShardCertificate";
import {
  sendSimpleCoordinatorFollow,
  sendSimpleShardRequest,
  subscribeSimpleShardResponses,
  type SimpleShardRequest,
  type SimpleShardResponse,
} from "./simpleShardDm";
import {
  publishSimpleSubmittedVote,
  subscribeLatestSimpleLiveVote,
  type SimpleLiveVoteSession,
} from "./simpleVotingSession";
import { reconcileSimpleKnownRounds } from "./simpleRoundState";
import {
  downloadSimpleActorBackup,
  loadSimpleActorState,
  parseSimpleActorBackupBundle,
  saveSimpleActorState,
  type SimpleActorKeypair,
} from "./simpleLocalState";

type LiveVoteChoice = "Yes" | "No" | null;

type SimpleVoterKeypair = {
  nsec: string;
  npub: string;
};

type PendingBlindRequest = {
  coordinatorNpub: string;
  votingId: string;
  request: SimpleShardRequest["blindRequest"];
  secret: SimpleBlindRequestSecret;
  createdAt: string;
};

type SimpleVoterCache = {
  manualCoordinators: string[];
  requestStatus: string | null;
  receivedShards: SimpleShardResponse[];
  pendingBlindRequests: Record<string, PendingBlindRequest>;
  submitStatus: string | null;
  selectedVotingId: string;
  liveVoteChoice: LiveVoteChoice;
};

function normalizeCoordinatorNpubs(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function shortenNpub(value: string) {
  if (value.length <= 18) {
    return value;
  }

  return `${value.slice(0, 10)}...${value.slice(-8)}`;
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

function createRoundTokenMessage(votingId: string, voterNpub: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${votingId}:${voterNpub}:${randomPart}`;
}

export default function SimpleUiApp() {
  const [voterKeypair, setVoterKeypair] = useState<SimpleVoterKeypair | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [voterId, setVoterId] = useState<string>("pending");
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([]);
  const [coordinatorDraft, setCoordinatorDraft] = useState("");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [pendingBlindRequests, setPendingBlindRequests] = useState<Record<string, PendingBlindRequest>>({});
  const [discoveredSessions, setDiscoveredSessions] = useState<SimpleLiveVoteSession[]>([]);
  const [knownBlindKeys, setKnownBlindKeys] = useState<Record<string, SimpleBlindKeyAnnouncement>>({});
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);
  const [selectedVotingId, setSelectedVotingId] = useState("");

  const configuredCoordinatorTargets = useMemo(
    () => normalizeCoordinatorNpubs(manualCoordinators),
    [manualCoordinators],
  );

  useEffect(() => {
    let cancelled = false;

    void loadSimpleActorState("voter").then((storedState) => {
      if (cancelled) {
        return;
      }

      if (storedState?.keypair) {
        setVoterKeypair(storedState.keypair);
        const cache = (storedState.cache ?? null) as Partial<SimpleVoterCache> | null;
        if (cache) {
          setManualCoordinators(Array.isArray(cache.manualCoordinators) ? cache.manualCoordinators : []);
          setRequestStatus(typeof cache.requestStatus === "string" ? cache.requestStatus : null);
          setReceivedShards(Array.isArray(cache.receivedShards) ? cache.receivedShards : []);
          setPendingBlindRequests(
            cache.pendingBlindRequests && typeof cache.pendingBlindRequests === "object"
              ? cache.pendingBlindRequests
              : {},
          );
          setSubmitStatus(typeof cache.submitStatus === "string" ? cache.submitStatus : null);
          setSelectedVotingId(typeof cache.selectedVotingId === "string" ? cache.selectedVotingId : "");
          setLiveVoteChoice(cache.liveVoteChoice === "Yes" || cache.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
        }
        setIdentityReady(true);
        return;
      }

      const nextKeypair = createSimpleVoterKeypair();
      void saveSimpleActorState({
        role: "voter",
        keypair: nextKeypair,
        updatedAt: new Date().toISOString(),
      });
      setVoterKeypair(nextKeypair);
      setIdentityReady(true);
    }).catch(() => {
      if (cancelled) {
        return;
      }

      const nextKeypair = createSimpleVoterKeypair();
      setVoterKeypair(nextKeypair);
      setIdentityReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!identityReady || !voterKeypair) {
      return;
    }

    const cache: SimpleVoterCache = {
      manualCoordinators,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
    };

    void saveSimpleActorState({
      role: "voter",
      keypair: voterKeypair,
      updatedAt: new Date().toISOString(),
      cache,
    });
  }, [
    identityReady,
    liveVoteChoice,
    manualCoordinators,
    pendingBlindRequests,
    receivedShards,
    requestStatus,
    selectedVotingId,
    submitStatus,
    voterKeypair,
  ]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec || configuredCoordinatorTargets.length === 0) {
      setReceivedShards([]);
      return;
    }

    setReceivedShards([]);

    return subscribeSimpleShardResponses({
      voterNsec,
      onResponses: (nextResponses) => {
        const nextIssuedShares = nextResponses.flatMap((response) => {
          const existingShare = response.shardCertificate;
          if (existingShare) {
            return [response];
          }

          const pending = pendingBlindRequests[`${response.coordinatorNpub}:${response.requestId}`]
            ?? Object.values(pendingBlindRequests).find((request) => request.request.requestId === response.requestId);
          if (!pending) {
            return [];
          }

          try {
            const shardCertificate = unblindSimpleBlindShare({
              response: response.blindShareResponse,
              secret: pending.secret,
            });
            return [{ ...response, shardCertificate }];
          } catch {
            return [];
          }
        });

        setReceivedShards(nextIssuedShares);
      },
    });
  }, [configuredCoordinatorTargets.length, pendingBlindRequests, voterKeypair?.nsec]);

  useEffect(() => {
    if (configuredCoordinatorTargets.length === 0) {
      setDiscoveredSessions([]);
      return;
    }

    const sessions = new Map<string, SimpleLiveVoteSession>();
    const cleanups = configuredCoordinatorTargets.map((coordinatorNpub) => subscribeLatestSimpleLiveVote({
      coordinatorNpub,
      onSession: (session: SimpleLiveVoteSession | null) => {
        if (!session) {
          return;
        }

        sessions.set(`${session.coordinatorNpub}:${session.votingId}`, session);
        setDiscoveredSessions(
          [...sessions.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
        );
      },
    }));

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [configuredCoordinatorTargets]);

  useEffect(() => {
    if (configuredCoordinatorTargets.length === 0) {
      setKnownBlindKeys({});
      return;
    }

    const cleanups = configuredCoordinatorTargets.map((coordinatorNpub) => subscribeLatestSimpleBlindKeyAnnouncement({
      coordinatorNpub,
      onAnnouncement: (announcement) => {
        if (!announcement) {
          return;
        }

        setKnownBlindKeys((current) => ({
          ...current,
          [coordinatorNpub]: announcement,
        }));
      },
    }));

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [configuredCoordinatorTargets]);

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
    void saveSimpleActorState({
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    });
    setVoterKeypair(nextKeypair);
    setIdentityStatus(null);
    setBackupStatus(null);
    setLiveVoteChoice(null);
    setRequestStatus(null);
    setSubmitStatus(null);
    setBallotTokenId(null);
    setReceivedShards([]);
    setPendingBlindRequests({});
    setDiscoveredSessions([]);
    setKnownBlindKeys({});
    setSelectedVotingId("");
  }

  function restoreIdentity(nextNsec: string) {
    const trimmed = nextNsec.trim();
    const derivedNpub = deriveNpubFromNsec(trimmed);

    if (!trimmed || !derivedNpub) {
      setIdentityStatus("Enter a valid nsec.");
      return;
    }

    const nextKeypair = {
      nsec: trimmed,
      npub: derivedNpub,
    };

    void saveSimpleActorState({
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    });
    setVoterKeypair(nextKeypair);
    setIdentityStatus("Identity restored from nsec.");
    setBackupStatus(null);
    setLiveVoteChoice(null);
    setRequestStatus(null);
    setSubmitStatus(null);
    setBallotTokenId(null);
    setReceivedShards([]);
    setPendingBlindRequests({});
    setDiscoveredSessions([]);
    setKnownBlindKeys({});
    setSelectedVotingId("");
  }

  function downloadBackup() {
    if (!voterKeypair) {
      return;
    }

    downloadSimpleActorBackup("voter", voterKeypair as SimpleActorKeypair, {
      manualCoordinators,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
    } satisfies SimpleVoterCache);
    setBackupStatus("Identity backup downloaded.");
  }

  async function restoreBackup(file: File) {
    try {
      const text = await file.text();
      const bundle = parseSimpleActorBackupBundle(text);
      if (!bundle || bundle.role !== "voter") {
        setBackupStatus("Backup file is not a voter backup.");
        return;
      }

      await saveSimpleActorState({
        role: "voter",
        keypair: bundle.keypair,
        updatedAt: new Date().toISOString(),
        cache: bundle.cache,
      });
      setVoterKeypair(bundle.keypair);
      setIdentityStatus("Identity restored from backup.");
      setBackupStatus(`Backup restored from ${bundle.exportedAt}.`);
      const cache = (bundle.cache ?? null) as Partial<SimpleVoterCache> | null;
      setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? cache.manualCoordinators : []);
      setLiveVoteChoice(cache?.liveVoteChoice === "Yes" || cache?.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
      setRequestStatus(typeof cache?.requestStatus === "string" ? cache.requestStatus : null);
      setSubmitStatus(typeof cache?.submitStatus === "string" ? cache.submitStatus : null);
      setBallotTokenId(null);
      setReceivedShards(Array.isArray(cache?.receivedShards) ? cache.receivedShards : []);
      setPendingBlindRequests(
        cache?.pendingBlindRequests && typeof cache.pendingBlindRequests === "object"
          ? cache.pendingBlindRequests
          : {},
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
    } catch {
      setBackupStatus("Backup restore failed.");
    }
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
        const parsed = shard.shardCertificate ? parseSimpleShardCertificate(shard.shardCertificate) : null;
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
      uniqueShardResponses
        .map((shard) => shard.shardCertificate)
        .filter((certificate): certificate is NonNullable<typeof certificate> => certificate !== undefined),
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

  const reconciledRoundState = useMemo(() => reconcileSimpleKnownRounds({
    configuredCoordinatorTargets,
    discoveredSessions,
    receivedShards,
  }), [configuredCoordinatorTargets, discoveredSessions, receivedShards]);

  const voteTicketRows = reconciledRoundState.ticketRows;

  useEffect(() => {
    if (!reconciledRoundState.knownRounds.length) {
      setSelectedVotingId("");
      return;
    }

    setSelectedVotingId((current) => (
      reconciledRoundState.knownRounds.some((round) => round.votingId === current)
        ? current
        : reconciledRoundState.knownRounds[0].votingId
    ));
  }, [reconciledRoundState.knownRounds]);

  const effectiveLiveVoteSession = useMemo<SimpleLiveVoteSession | null>(() => {
    return reconciledRoundState.knownRounds.find((round) => round.votingId === selectedVotingId)
      ?? reconciledRoundState.knownRounds[0]
      ?? null;
  }, [reconciledRoundState.knownRounds, selectedVotingId]);

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";
    const round = effectiveLiveVoteSession;

    if (!voterSecretKey || !voterNpub || voterId === "pending" || !round) {
      return;
    }

    const coordinatorsToRequest = configuredCoordinatorTargets.filter((coordinatorNpub) => {
      if (!knownBlindKeys[coordinatorNpub]) {
        return false;
      }

      if (pendingBlindRequests[`${coordinatorNpub}:${round.votingId}`]) {
        return false;
      }

      return !receivedShards.some((response) => {
        const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
        return parsed?.votingId === round.votingId && response.coordinatorNpub === coordinatorNpub;
      });
    });

    if (coordinatorsToRequest.length === 0) {
      return;
    }

    void (async () => {
      const existingRoundTokenMessage = Object.values(pendingBlindRequests).find((entry) => entry.votingId === round.votingId)?.secret.tokenMessage
        ?? receivedShards.find((response) => {
          const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
          return parsed?.votingId === round.votingId;
        })?.shardCertificate?.tokenMessage
        ?? createRoundTokenMessage(round.votingId, voterNpub);

      const createdEntries = await Promise.all(coordinatorsToRequest.map(async (coordinatorNpub) => {
        const announcement = knownBlindKeys[coordinatorNpub];
        const created = await createSimpleBlindIssuanceRequest({
          publicKey: announcement.publicKey,
          votingId: round.votingId,
          tokenMessage: existingRoundTokenMessage,
        });
        return {
          coordinatorNpub,
          votingId: round.votingId,
          request: created.request,
          secret: created.secret,
          createdAt: created.request.createdAt,
        } satisfies PendingBlindRequest;
      }));

      const nextRequests = Object.fromEntries(createdEntries.map((entry) => [`${entry.coordinatorNpub}:${entry.votingId}`, entry]));
      setPendingBlindRequests((current) => ({ ...current, ...nextRequests }));

      const results = await Promise.all(createdEntries.map(async (entry) => sendSimpleShardRequest({
        voterSecretKey,
        coordinatorNpub: entry.coordinatorNpub,
        voterNpub,
        voterId,
        votingId: round.votingId,
        blindRequest: entry.request,
      })));

      if (results.some((result) => result.successes > 0)) {
        setRequestStatus("Coordinators notified. Waiting for round tickets.");
      }
    })();
  }, [
    configuredCoordinatorTargets,
    effectiveLiveVoteSession,
    knownBlindKeys,
    pendingBlindRequests,
    receivedShards,
    voterId,
    voterKeypair?.npub,
    voterKeypair?.nsec,
  ]);

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
        shardCertificates: uniqueShardResponses
          .map((shard) => shard.shardCertificate)
          .filter((certificate): certificate is NonNullable<typeof certificate> => certificate !== undefined),
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
          onRestoreNsec={restoreIdentity}
          restoreMessage={identityStatus}
          onDownloadBackup={identityReady ? downloadBackup : undefined}
          onRestoreBackupFile={restoreBackup}
          backupMessage={backupStatus}
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

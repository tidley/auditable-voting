import { useEffect, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec } from "./nostrIdentity";
import { sha256Hex } from "./tokenIdentity";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import SimpleQrScanner from "./SimpleQrScanner";
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
import {
  parseSimpleVotingPackage,
  serializeSimpleVotingPackage,
  type SimpleVotingPackage,
} from "./simpleVotingPackage";

type LiveVoteChoice = "Yes" | "No" | null;
type SimpleVoterKeypair = {
  nsec: string;
  npub: string;
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

export default function SimpleUiApp() {
  const [voterKeypair, setVoterKeypair] = useState<SimpleVoterKeypair | null>(() => loadStoredSimpleVoterKeypair());
  const [voterId, setVoterId] = useState<string>("pending");
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [coordinatorNpub, setCoordinatorNpub] = useState<string>("");
  const [selectedVotingId, setSelectedVotingId] = useState<string>("");
  const [importedVotingPackage, setImportedVotingPackage] = useState<SimpleVotingPackage | null>(null);
  const [votingDetailsText, setVotingDetailsText] = useState<string>("");
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([""]);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [followStatus, setFollowStatus] = useState<string | null>(null);
  const [followedCoordinatorNpubs, setFollowedCoordinatorNpubs] = useState<string[]>([]);
  const [participatingCoordinators, setParticipatingCoordinators] = useState<string[]>([]);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [liveVoteSession, setLiveVoteSession] = useState<SimpleLiveVoteSession | null>(null);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const nextCoordinatorNpub = params.get("coordinator")?.trim() ?? "";
    const nextVotingId = params.get("voting")?.trim() ?? "";
    setCoordinatorNpub(nextCoordinatorNpub);
    setSelectedVotingId(nextVotingId);
    if (nextCoordinatorNpub || nextVotingId) {
      const nextPackage = {
        votingId: nextVotingId,
        coordinatorNpub: nextCoordinatorNpub || undefined,
        coordinators: nextCoordinatorNpub ? [nextCoordinatorNpub] : undefined,
      };
      setImportedVotingPackage(nextPackage);
      setManualCoordinators(nextCoordinatorNpub ? [nextCoordinatorNpub] : [""]);
      setVotingDetailsText(serializeSimpleVotingPackage(nextPackage));
    }
  }, []);

  const configuredCoordinatorTargets = normalizeCoordinatorNpubs([
    ...manualCoordinators,
    ...(importedVotingPackage?.coordinators ?? []),
    ...(importedVotingPackage?.coordinatorNpub ? [importedVotingPackage.coordinatorNpub] : []),
    ...(coordinatorNpub ? [coordinatorNpub] : []),
  ]);
  const configuredCoordinatorTargetsKey = configuredCoordinatorTargets.join("|");

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
    if (!coordinatorNpub && !selectedVotingId && receivedShards.length === 0 && !importedVotingPackage) {
      setLiveVoteSession(null);
      setParticipatingCoordinators([]);
      return;
    }

    let cancelled = false;

    async function refreshLiveVote() {
      try {
        const sessions = await fetchSimpleLiveVotes();
        const latestSessions = getLatestSessionsByCoordinator(sessions);
        const packageCoordinators = configuredCoordinatorTargets;
        const coordinatorScopedSessions = packageCoordinators.length > 0
          ? latestSessions.filter((session) => packageCoordinators.includes(session.coordinatorNpub))
          : [];
        const mostRecentScopedSession = coordinatorScopedSessions[0] ?? null;
        const candidateVotingId = selectedVotingId
          || importedVotingPackage?.votingId
          || liveVoteSession?.votingId
          || mostRecentScopedSession?.votingId
          || "";
        const matchingSessions = candidateVotingId
          ? latestSessions.filter((session) => (
            session.votingId === candidateVotingId
            && (packageCoordinators.length === 0 || packageCoordinators.includes(session.coordinatorNpub))
          ))
          : [];
        const nextCoordinators = Array.from(new Set([
          ...matchingSessions.map((session) => session.coordinatorNpub),
          ...(importedVotingPackage?.coordinatorNpub ? [importedVotingPackage.coordinatorNpub] : []),
          ...packageCoordinators,
        ]));
        const nextSession = matchingSessions[0] ?? null;
        if (!cancelled) {
          setLiveVoteSession((current) => {
            if (nextSession) {
              return nextSession;
            }
            if (!current) {
              return null;
            }
            if (!packageCoordinators.includes(current.coordinatorNpub)) {
              return null;
            }
            if (candidateVotingId && current.votingId !== candidateVotingId) {
              return null;
            }
            return current;
          });
          setParticipatingCoordinators(nextCoordinators.length > 0 ? nextCoordinators : packageCoordinators);
          if (nextSession?.votingId) {
            setSelectedVotingId(nextSession.votingId);
          }
        }
      } catch {
        // Keep the last known live session during transient relay failures.
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
  }, [configuredCoordinatorTargetsKey, coordinatorNpub, importedVotingPackage, liveVoteSession?.votingId, receivedShards, selectedVotingId]);

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

  function createNostrKeypair() {
    const secretKey = generateSecretKey();
    const nsec = nip19.nsecEncode(secretKey);
    const npub = nip19.npubEncode(getPublicKey(secretKey));
    const nextKeypair = { nsec, npub };
    storeSimpleVoterKeypair(nextKeypair);
    setVoterKeypair(nextKeypair);
  }

  function applyVotingDetails(parsed: SimpleVotingPackage, source: "imported" | "scanned") {
    const mergedCoordinators = Array.from(new Set([
      ...(importedVotingPackage?.coordinators ?? []),
      ...(parsed.coordinators ?? []),
      ...(importedVotingPackage?.coordinatorNpub ? [importedVotingPackage.coordinatorNpub] : []),
      ...(parsed.coordinatorNpub ? [parsed.coordinatorNpub] : []),
    ]));
    const nextVotingId = parsed.votingId
      || importedVotingPackage?.votingId
      || selectedVotingId
      || liveVoteSession?.votingId
      || "";

    if (!nextVotingId && mergedCoordinators.length === 0) {
      setImportStatus("Add at least one coordinator npub.");
      return;
    }

    const nextPackage = {
      ...importedVotingPackage,
      ...parsed,
      votingId: nextVotingId,
      coordinatorNpub: parsed.coordinatorNpub ?? importedVotingPackage?.coordinatorNpub ?? mergedCoordinators[0],
      coordinators: mergedCoordinators.length > 0 ? mergedCoordinators : undefined,
    };

    setImportedVotingPackage(nextPackage);
    setSelectedVotingId(nextVotingId);
    setCoordinatorNpub(nextPackage.coordinatorNpub ?? "");
    setManualCoordinators(mergedCoordinators.length > 0 ? mergedCoordinators : [""]);
    setVotingDetailsText(serializeSimpleVotingPackage(nextPackage));
    setImportStatus(source === "scanned"
      ? `Voting details scanned. ${mergedCoordinators.length || 1} coordinator${mergedCoordinators.length === 1 ? "" : "s"} loaded.`
      : `Voting details imported. ${mergedCoordinators.length || 1} coordinator${mergedCoordinators.length === 1 ? "" : "s"} loaded.`);
  }

  function importVotingDetails() {
    const parsed = parseSimpleVotingPackage(votingDetailsText);

    if (!parsed) {
      setImportStatus("Paste valid voting details or at least one coordinator npub.");
      return;
    }

    applyVotingDetails(parsed, "imported");
  }

  function handleScannedVotingPackage(scannedValue: string) {
    const parsed = parseSimpleVotingPackage(scannedValue);

    if (!parsed) {
      setImportStatus("QR code did not contain valid voting details.");
      return;
    }

    applyVotingDetails(parsed, "scanned");
  }

  function updateCoordinatorInput(index: number, value: string) {
    setManualCoordinators((current) => {
      const next = current.map((entry, currentIndex) => (
        currentIndex === index ? value : entry
      ));
      const normalized = normalizeCoordinatorNpubs(next);
      setCoordinatorNpub(normalized[0] ?? "");
      setImportedVotingPackage((currentPackage) => (
        normalized.length > 0 || currentPackage?.votingId
          ? {
              ...currentPackage,
              coordinatorNpub: normalized[0],
              coordinators: normalized.length > 0 ? normalized : undefined,
            }
          : null
      ));
      return next;
    });
  }

  function addCoordinatorInput() {
    setManualCoordinators((current) => [...current, ""]);
  }

  function removeCoordinatorInput(index: number) {
    setManualCoordinators((current) => {
      const next = current.filter((_, currentIndex) => currentIndex !== index);
      const nextValues = next.length > 0 ? next : [""];
      const normalized = normalizeCoordinatorNpubs(nextValues);
      setCoordinatorNpub(normalized[0] ?? "");
      setImportedVotingPackage((currentPackage) => (
        normalized.length > 0 || currentPackage?.votingId
          ? {
              ...currentPackage,
              coordinatorNpub: normalized[0],
              coordinators: normalized.length > 0 ? normalized : undefined,
            }
          : null
      ));
      return nextValues;
    });
  }

  async function followCoordinators() {
    const voterNpub = voterKeypair?.npub ?? "";
    const voterNsec = voterKeypair?.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);
    const targets = configuredCoordinatorTargets;

    if (!voterNpub || voterId === "pending" || !voterSecretKey || targets.length === 0) {
      return;
    }

    setFollowStatus("Following coordinators...");

    try {
      const results = await Promise.all(targets.map(async (targetCoordinatorNpub) => {
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub: targetCoordinatorNpub,
          voterNpub,
          voterId,
          votingId: (liveVoteSession?.votingId ?? selectedVotingId) || undefined,
        });
        return { targetCoordinatorNpub, success: result.successes > 0 };
      }));

      const successfulTargets = results
        .filter((result) => result.success)
        .map((result) => result.targetCoordinatorNpub);

      setFollowedCoordinatorNpubs((current) => Array.from(new Set([...current, ...successfulTargets])));
      setFollowStatus(
        successfulTargets.length > 0
          ? `Following ${successfulTargets.length} coordinator${successfulTargets.length === 1 ? "" : "s"}.`
          : "Coordinator follow failed.",
      );
    } catch {
      setFollowStatus("Coordinator follow failed.");
    }
  }

  async function requestVotingShard() {
    const voterNpub = voterKeypair?.npub ?? "";
    const voterNsec = voterKeypair?.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);
    const votingId = liveVoteSession?.votingId ?? "";

    if (!voterNpub || voterId === "pending" || !voterSecretKey || !liveVoteSession || !votingId) {
      return;
    }

    try {
      const tokenCommitment = await sha256Hex(`${voterNsec}:${votingId}:simple-threshold-token`);
      const targets = configuredCoordinatorTargets;

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

  const tokenCommitmentBasis = voterKeypair?.nsec && liveVoteSession?.votingId
    ? `${voterKeypair.nsec}:${liveVoteSession.votingId}:simple-threshold-token`
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
  const requestTargets = configuredCoordinatorTargets;
  const unfollowedRequestTargets = requestTargets.filter((target) => !followedCoordinatorNpubs.includes(target));
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
          npub={voterKeypair?.npub ?? ""}
          nsec={voterKeypair?.nsec ?? ""}
        />

        <section className="simple-voter-section" aria-labelledby="import-package-title">
          <h2 id="import-package-title" className="simple-voter-section-title">Scan or enter voting details</h2>
          <p className="simple-voter-question">
            Scan a coordinator QR code, paste the voting details text, or enter coordinator npubs manually.
          </p>
          <div className="simple-voter-action-row simple-voter-action-row-inline">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => setScannerOpen((current) => !current)}
            >
              {scannerOpen ? "Hide scanner" : "Scan with camera"}
            </button>
          </div>
          <label className="simple-voter-label" htmlFor="simple-voting-details-text">Voting details</label>
          <textarea
            id="simple-voting-details-text"
            className="simple-voter-textarea"
            value={votingDetailsText}
            onChange={(event) => setVotingDetailsText(event.target.value)}
            placeholder={"Voting ID: ...\nCoordinator npubs:\n- npub1..."}
            rows={5}
          />
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-secondary"
              onClick={importVotingDetails}
              disabled={votingDetailsText.trim().length === 0}
            >
              Use voting details
            </button>
          </div>
          <SimpleQrScanner
            active={scannerOpen}
            onDetected={handleScannedVotingPackage}
            onClose={() => setScannerOpen(false)}
          />
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
          {importStatus && <p className="simple-voter-note">{importStatus}</p>}
        </section>

        <section className="simple-voter-section" aria-labelledby="follow-coordinators-title">
          <h2 id="follow-coordinators-title" className="simple-voter-section-title">Follow coordinators</h2>
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => void followCoordinators()}
              disabled={!voterKeypair?.npub || requestTargets.length === 0}
            >
              Follow coordinators
            </button>
          </div>
          {followStatus && <p className="simple-voter-note">{followStatus}</p>}
          {requestTargets.length === 0 && (
            <p className="simple-voter-empty">Add at least one coordinator npub first.</p>
          )}
        </section>

        <section className="simple-voter-section" aria-labelledby="request-shard-title">
          <h2 id="request-shard-title" className="simple-voter-section-title">Request voting shares</h2>
          <div className="simple-voter-action-row">
            <button
              type="button"
              className="simple-voter-primary"
              onClick={() => void requestVotingShard()}
              disabled={!voterKeypair?.npub || !liveVoteSession?.votingId || requestTargets.length === 0 || unfollowedRequestTargets.length > 0}
            >
              Request voting shares
            </button>
          </div>
          {requestStatus && <p className="simple-voter-note">{requestStatus}</p>}
          {!liveVoteSession?.votingId && (
            <p className="simple-voter-empty">Waiting for coordinators to publish the live vote.</p>
          )}
          {requestTargets.length === 0 && (
            <p className="simple-voter-empty">Add at least one coordinator npub.</p>
          )}
          {requestTargets.length > 0 && unfollowedRequestTargets.length > 0 && (
            <p className="simple-voter-empty">Follow coordinators before requesting shares.</p>
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

import { useEffect, useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { fetchElection, type ElectionInfo } from "./coordinatorApi";
import { decodeNsec } from "./nostrIdentity";
import {
  subscribeSimpleCoordinatorFollowers,
  subscribeSimpleCoordinatorShareAssignments,
  subscribeSimpleSubCoordinatorApplications,
  sendSimpleShareAssignment,
  sendSimpleSubCoordinatorJoin,
  sendSimpleRoundTicket,
  type SimpleCoordinatorFollower,
  type SimpleSubCoordinatorApplication,
} from "./simpleShardDm";
import {
  subscribeSimpleLiveVotes,
  subscribeSimpleSubmittedVotes,
  publishSimpleLiveVote,
  type SimpleLiveVoteSession,
  type SimpleSubmittedVote,
} from "./simpleVotingSession";
import { validateSimpleSubmittedVotes } from "./simpleVoteValidation";
import { sha256Hex } from "./tokenIdentity";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import TokenFingerprint from "./TokenFingerprint";

const COORDINATOR_STORAGE_KEY = "auditable-voting.simple-coordinator-keypair";

type SimpleCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

function createSimpleCoordinatorKeypair(): SimpleCoordinatorKeypair {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
}

function loadStoredCoordinatorKeypair(): SimpleCoordinatorKeypair | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(COORDINATOR_STORAGE_KEY);
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

  window.sessionStorage.setItem(COORDINATOR_STORAGE_KEY, JSON.stringify(keypair));
}

function mergeFollowers(
  currentFollowers: SimpleCoordinatorFollower[],
  nextFollowers: SimpleCoordinatorFollower[],
) {
  if (nextFollowers.length === 0) {
    return currentFollowers;
  }

  const merged = new Map<string, SimpleCoordinatorFollower>();

  for (const follower of currentFollowers) {
    merged.set(follower.voterNpub, follower);
  }

  for (const follower of nextFollowers) {
    merged.set(follower.voterNpub, follower);
  }

  return [...merged.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

export default function SimpleCoordinatorApp() {
  const [election, setElection] = useState<ElectionInfo | null>(null);
  const [keypair, setKeypair] = useState<SimpleCoordinatorKeypair | null>(() => loadStoredCoordinatorKeypair());
  const [coordinatorId, setCoordinatorId] = useState("pending");
  const [leadCoordinatorNpub, setLeadCoordinatorNpub] = useState("");
  const [followers, setFollowers] = useState<SimpleCoordinatorFollower[]>([]);
  const [subCoordinators, setSubCoordinators] = useState<SimpleSubCoordinatorApplication[]>([]);
  const [ticketStatuses, setTicketStatuses] = useState<Record<string, string>>({});
  const [registrationStatus, setRegistrationStatus] = useState<string | null>(null);
  const [assignmentStatus, setAssignmentStatus] = useState<string | null>(null);
  const [questionPrompt, setQuestionPrompt] = useState("Should the proposal pass?");
  const [questionVotingId, setQuestionVotingId] = useState("");
  const [questionThresholdT, setQuestionThresholdT] = useState("1");
  const [questionThresholdN, setQuestionThresholdN] = useState("1");
  const [questionShareIndex, setQuestionShareIndex] = useState("1");
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [publishedVotes, setPublishedVotes] = useState<SimpleLiveVoteSession[]>([]);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [submittedVotes, setSubmittedVotes] = useState<SimpleSubmittedVote[]>([]);
  const isLeadCoordinator = !leadCoordinatorNpub.trim() || leadCoordinatorNpub.trim() === (keypair?.npub ?? "");
  const activeShareIndex = isLeadCoordinator ? 1 : (Number.parseInt(questionShareIndex, 10) || 0);
  const hasAssignedShareIndex = !isLeadCoordinator && activeShareIndex > 0;
  const liveVoteSourceNpub = !isLeadCoordinator ? leadCoordinatorNpub.trim() : "";
  const selectedPublishedVote = useMemo(
    () => publishedVotes.find((vote) => vote.votingId === selectedVotingId) ?? publishedVotes[0] ?? null,
    [publishedVotes, selectedVotingId],
  );
  const activeVotingId = selectedPublishedVote?.votingId ?? questionVotingId.trim();
  const activeThresholdT = selectedPublishedVote?.thresholdT ?? (Number.parseInt(questionThresholdT, 10) || undefined);
  const activeThresholdN = selectedPublishedVote?.thresholdN ?? (Number.parseInt(questionThresholdN, 10) || undefined);

  useEffect(() => {
    void fetchElection().then((nextElection) => {
      setElection(nextElection);
    }).catch(() => {
      setElection(null);
    });
  }, []);

  useEffect(() => {
    if (keypair) {
      return;
    }

    const nextKeypair = createSimpleCoordinatorKeypair();
    storeCoordinatorKeypair(nextKeypair);
    setKeypair(nextKeypair);
  }, [keypair]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";

    if (!coordinatorNsec) {
      setFollowers([]);
      return;
    }

    setFollowers([]);

    return subscribeSimpleCoordinatorFollowers({
      coordinatorNsec,
      onFollowers: (nextFollowers) => {
        setFollowers((current) => mergeFollowers(current, nextFollowers));
      },
    });
  }, [keypair?.nsec]);

  useEffect(() => {
    const leadCoordinatorNsec = keypair?.nsec ?? "";

    if (!leadCoordinatorNsec || !isLeadCoordinator) {
      setSubCoordinators([]);
      return;
    }

    setSubCoordinators([]);

    return subscribeSimpleSubCoordinatorApplications({
      leadCoordinatorNsec,
      onApplications: (nextApplications) => {
        setSubCoordinators(nextApplications);
      },
    });
  }, [isLeadCoordinator, keypair?.nsec]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";

    if (!coordinatorNsec || isLeadCoordinator || !leadCoordinatorNpub.trim()) {
      return;
    }

    return subscribeSimpleCoordinatorShareAssignments({
      coordinatorNsec,
      onAssignments: (nextAssignments) => {
        const activeLeadCoordinatorNpub = leadCoordinatorNpub.trim();
        if (!activeLeadCoordinatorNpub) {
          return;
        }

        const latestAssignment = nextAssignments.find((assignment) => (
          assignment.leadCoordinatorNpub === activeLeadCoordinatorNpub
          && assignment.coordinatorNpub === (keypair?.npub ?? "")
        ));

        if (!latestAssignment) {
          return;
        }

        setQuestionShareIndex(String(latestAssignment.shareIndex));
        if (latestAssignment.thresholdN && latestAssignment.thresholdN > 0) {
          setQuestionThresholdN(String(latestAssignment.thresholdN));
        }
        setRegistrationStatus(null);
        setAssignmentStatus(`Assigned share index ${latestAssignment.shareIndex} by the lead coordinator.`);
      },
    });
  }, [isLeadCoordinator, keypair?.nsec, keypair?.npub, leadCoordinatorNpub]);

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

  useEffect(() => {
    if (isLeadCoordinator) {
      setQuestionShareIndex("1");
    }
  }, [isLeadCoordinator, leadCoordinatorNpub]);

  useEffect(() => {
    if (!liveVoteSourceNpub) {
      setPublishedVotes([]);
      return;
    }

    setPublishedVotes([]);

    return subscribeSimpleLiveVotes({
      coordinatorNpub: liveVoteSourceNpub,
      onSessions: (nextVotes) => {
        setPublishedVotes(nextVotes);
      },
    });
  }, [liveVoteSourceNpub]);

  useEffect(() => {
    if (!publishedVotes.length) {
      setSelectedVotingId("");
      return;
    }

    if (questionVotingId.trim()) {
      const matchingVote = publishedVotes.find((vote) => vote.votingId === questionVotingId.trim());
      if (matchingVote) {
        setSelectedVotingId(questionVotingId.trim());
        return;
      }
    }

    setSelectedVotingId((current) => (
      publishedVotes.some((vote) => vote.votingId === current) ? current : publishedVotes[0].votingId
    ));
  }, [publishedVotes, questionVotingId]);

  useEffect(() => {
    const votingId = selectedPublishedVote?.votingId ?? "";

    if (!votingId) {
      setSubmittedVotes([]);
      return;
    }

    setSubmittedVotes([]);

    return subscribeSimpleSubmittedVotes({
      votingId,
      onVotes: (nextVotes) => {
        setSubmittedVotes(nextVotes);
      },
    });
  }, [selectedPublishedVote?.votingId]);

  function refreshIdentity() {
    const nextKeypair = createSimpleCoordinatorKeypair();
    storeCoordinatorKeypair(nextKeypair);
    setKeypair(nextKeypair);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketStatuses({});
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionVotingId("");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setPublishStatus(null);
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSubmittedVotes([]);
  }

  function getThresholdLabel() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return `${configuredT} of ${configuredN}`;
    }

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

  function getThresholdNumbers() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return { thresholdT: configuredT, thresholdN: configuredN };
    }

    const publishedT = election?.threshold_t;
    const publishedN = election?.threshold_n;

    if (publishedT && publishedN) {
      return { thresholdT: publishedT, thresholdN: publishedN };
    }

    const coordinatorCount = election?.coordinator_npubs.length ?? 0;
    if (coordinatorCount === 1) {
      return { thresholdT: 1, thresholdN: 1 };
    }

    if (coordinatorCount > 1) {
      return { thresholdN: coordinatorCount };
    }

    return {};
  }

  async function sendTicket(follower: SimpleCoordinatorFollower) {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const votingId = selectedPublishedVote?.votingId ?? "";
    const prompt = selectedPublishedVote?.prompt ?? "";

    if (!coordinatorNpub || !coordinatorSecretKey || !coordinatorId || coordinatorId === "pending" || !votingId || !prompt || activeShareIndex <= 0) {
      return;
    }

    const ticketStatusKey = `${follower.voterNpub}:${votingId}`;
    setTicketStatuses((current) => ({ ...current, [ticketStatusKey]: "Sending ticket..." }));

    try {
      const thresholdLabel = activeThresholdT && activeThresholdN
        ? `${activeThresholdT} of ${activeThresholdN}`
        : getThresholdLabel();
      const tokenCommitment = await sha256Hex(
        `${follower.voterNpub}:${votingId}:simple-round-ticket`,
      );
      const result = await sendSimpleRoundTicket({
        coordinatorSecretKey,
        voterNpub: follower.voterNpub,
        voterId: follower.voterId,
        coordinatorNpub,
        coordinatorId,
        thresholdLabel,
        votingId,
        votingPrompt: prompt,
        tokenCommitment,
        shareIndex: activeShareIndex,
        thresholdT: activeThresholdT,
        thresholdN: activeThresholdN,
      });

      setTicketStatuses((current) => ({
        ...current,
        [ticketStatusKey]: result.successes > 0 ? "Ticket sent." : "Ticket send failed.",
      }));
    } catch {
      setTicketStatuses((current) => ({ ...current, [ticketStatusKey]: "Ticket send failed." }));
    }
  }

  async function broadcastQuestion() {
    const coordinatorNsec = keypair?.nsec ?? "";
    const prompt = questionPrompt.trim();

    if (!coordinatorNsec || !prompt || !isLeadCoordinator) {
      return;
    }

    setPublishStatus("Broadcasting vote...");

    try {
      const threshold = getThresholdNumbers();
      const result = await publishSimpleLiveVote({
        coordinatorNsec,
        prompt,
        votingId: questionVotingId.trim() || undefined,
        thresholdT: threshold.thresholdT,
        thresholdN: threshold.thresholdN,
      });

      setPublishedVotes((current) => {
        const nextVote = {
          votingId: result.votingId,
          prompt,
          coordinatorNpub: result.coordinatorNpub,
          createdAt: result.createdAt,
          thresholdT: threshold.thresholdT,
          thresholdN: threshold.thresholdN,
          eventId: result.eventId,
        };
        return [nextVote, ...current.filter((vote) => vote.votingId !== nextVote.votingId)];
      });
      setSelectedVotingId(result.votingId);
      setQuestionVotingId(result.votingId);
      setPublishStatus(result.successes > 0 ? "Vote broadcast." : "Vote broadcast failed.");
    } catch {
      setPublishStatus("Vote broadcast failed.");
    }
  }

  function selectRound(votingId: string) {
    setSelectedVotingId(votingId);
    if (!isLeadCoordinator) {
      return;
    }

    const selectedVote = publishedVotes.find((vote) => vote.votingId === votingId);
    if (!selectedVote) {
      return;
    }

    setQuestionVotingId(selectedVote.votingId);
    setQuestionPrompt(selectedVote.prompt);
    setQuestionThresholdT(String(selectedVote.thresholdT ?? 1));
    setQuestionThresholdN(String(selectedVote.thresholdN ?? 1));
  }

  async function submitToLeadCoordinator() {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const nextLeadCoordinatorNpub = leadCoordinatorNpub.trim();

    if (
      !coordinatorNpub
      || !coordinatorSecretKey
      || !nextLeadCoordinatorNpub
      || nextLeadCoordinatorNpub === coordinatorNpub
      || coordinatorId === "pending"
    ) {
      return;
    }

    setRegistrationStatus("Submitting to lead coordinator...");

    try {
      const result = await sendSimpleSubCoordinatorJoin({
        coordinatorSecretKey,
        leadCoordinatorNpub: nextLeadCoordinatorNpub,
        coordinatorNpub,
        coordinatorId,
      });

      setRegistrationStatus(
        result.successes > 0
          ? "Submitted to lead coordinator. Waiting for share index assignment."
          : "Lead coordinator submission failed.",
      );
    } catch {
      setRegistrationStatus("Lead coordinator submission failed.");
    }
  }

  async function distributeShareIndexes() {
    const leadCoordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const leadCoordinatorNpub = keypair?.npub ?? "";

    if (!isLeadCoordinator || !leadCoordinatorSecretKey || !leadCoordinatorNpub || subCoordinators.length === 0) {
      return;
    }

    setAssignmentStatus("Distributing share indexes...");

    try {
      const thresholdN = Number.parseInt(questionThresholdN, 10) || undefined;
      const sortedApplications = [...subCoordinators].sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.coordinatorNpub.localeCompare(right.coordinatorNpub)
      ));

      const results = await Promise.all(sortedApplications.map(async (application, index) => {
        const shareIndex = index + 2;
        const result = await sendSimpleShareAssignment({
          leadCoordinatorSecretKey,
          leadCoordinatorNpub,
          coordinatorNpub: application.coordinatorNpub,
          shareIndex,
          thresholdN,
        });
        return result.successes > 0;
      }));

      setAssignmentStatus(
        results.every(Boolean)
          ? "Share indexes distributed."
          : "Some share index assignments failed.",
      );
    } catch {
      setAssignmentStatus("Share index distribution failed.");
    }
  }

  const requiredShardCount = Math.max(1, selectedPublishedVote?.thresholdT ?? 1);
  const validatedVotes = validateSimpleSubmittedVotes(submittedVotes, requiredShardCount);
  const validYesCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "Yes").length;
  const validNoCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "No").length;
  const visibleFollowers = activeVotingId
    ? followers.filter((follower) => !follower.votingId || follower.votingId === activeVotingId)
    : followers;
  const expectedSubCoordinatorCount = Math.max(0, (Number.parseInt(questionThresholdN, 10) || 1) - 1);

  return (
    <main className="simple-voter-shell">
      <section className="simple-voter-page">
        <div className="simple-voter-header-row">
          <h1 className="simple-voter-title">Coordinator ID {coordinatorId}</h1>
          <button type="button" className="simple-voter-primary" onClick={refreshIdentity}>
            Refresh ID
          </button>
        </div>

        <SimpleIdentityPanel
          npub={keypair?.npub ?? ""}
          nsec={keypair?.nsec ?? ""}
          title="Identity"
        />

        <SimpleCollapsibleSection title="Coordinator management">
          <label className="simple-voter-label" htmlFor="simple-lead-coordinator-npub">Lead coordinator npub</label>
          <input
            id="simple-lead-coordinator-npub"
            className="simple-voter-input"
            value={leadCoordinatorNpub}
            onChange={(event) => {
              const nextLeadCoordinatorNpub = event.target.value;
              setLeadCoordinatorNpub(nextLeadCoordinatorNpub);
              if (nextLeadCoordinatorNpub.trim() !== (keypair?.npub ?? "")) {
                setQuestionShareIndex("");
              }
              setRegistrationStatus(null);
              setAssignmentStatus(null);
            }}
            placeholder="Leave blank if this coordinator is the lead"
          />
          <p className="simple-voter-question">
            {isLeadCoordinator
              ? "This coordinator publishes the live question."
              : "This coordinator follows the lead question and only issues shares."}
          </p>
          {isLeadCoordinator ? (
            <>
              {publishedVotes.length > 0 ? (
                <>
                  <label className="simple-voter-label" htmlFor="simple-active-round">Current round</label>
                  <select
                    id="simple-active-round"
                    className="simple-voter-input"
                    value={selectedPublishedVote?.votingId ?? ""}
                    onChange={(event) => selectRound(event.target.value)}
                  >
                    {publishedVotes.map((vote) => (
                      <option key={vote.eventId} value={vote.votingId}>
                        {shortVotingId(vote.votingId)} - {vote.prompt}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
              <div className="simple-voter-action-row">
                <button
                  type="button"
                  className="simple-voter-secondary"
                  onClick={() => void distributeShareIndexes()}
                  disabled={!keypair?.nsec || subCoordinators.length === 0}
                >
                  Distribute share indexes
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="simple-vote-threshold-grid">
                <div>
                  <label className="simple-voter-label" htmlFor="simple-share-index">Share Index</label>
                  <input
                    id="simple-share-index"
                    className="simple-voter-input"
                    value={questionShareIndex || "Awaiting assignment"}
                    readOnly
                    disabled
                  />
                </div>
              </div>
              <div className="simple-voter-action-row">
                <button
                  type="button"
                  className="simple-voter-secondary"
                  onClick={() => void submitToLeadCoordinator()}
                  disabled={
                    !keypair?.nsec
                    || !leadCoordinatorNpub.trim()
                    || leadCoordinatorNpub.trim() === (keypair?.npub ?? "")
                    || hasAssignedShareIndex
                  }
                >
                  {hasAssignedShareIndex ? "Registered with lead" : "Submit to lead"}
                </button>
              </div>
            </>
          )}
          <p className="simple-voter-question">
            Threshold: {activeThresholdT && activeThresholdN ? `${activeThresholdT} of ${activeThresholdN}` : getThresholdLabel()}
          </p>
          {publishStatus && <p className="simple-voter-note">{publishStatus}</p>}
          {registrationStatus && !isLeadCoordinator && !hasAssignedShareIndex && (
            <p className="simple-voter-note">{registrationStatus}</p>
          )}
          {assignmentStatus && <p className="simple-voter-note">{assignmentStatus}</p>}
          {selectedPublishedVote && (
            <>
              <p className="simple-voter-question">Voting ID {selectedPublishedVote.votingId.slice(0, 12)}</p>
              <p className="simple-voter-question">Live prompt: {selectedPublishedVote.prompt}</p>
              <p className="simple-voter-question">
                Question source: {selectedPublishedVote.coordinatorNpub === (keypair?.npub ?? "") ? "This coordinator" : "Lead coordinator"}
              </p>
              <p className="simple-voter-question">This coordinator share index: {activeShareIndex || "Awaiting assignment"}</p>
            </>
          )}
        </SimpleCollapsibleSection>

        {isLeadCoordinator && (
          <SimpleCollapsibleSection title="Sub-coordinators">
            {subCoordinators.length > 0 ? (
              <>
                <p className="simple-voter-question">
                  {subCoordinators.length} sub-coordinator{subCoordinators.length === 1 ? "" : "s"} submitted
                  {expectedSubCoordinatorCount > 0 ? ` of ${expectedSubCoordinatorCount} expected` : ""}.
                </p>
                <ul className="simple-voter-list">
                  {subCoordinators.map((application, index) => (
                    <li key={application.id} className="simple-voter-list-item">
                      <p className="simple-voter-question">
                        Coordinator {application.coordinatorId} submitted as sub-coordinator #{index + 1}.
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="simple-voter-empty">No sub-coordinators have submitted yet.</p>
            )}
          </SimpleCollapsibleSection>
        )}

        <SimpleCollapsibleSection title="Following voters">
          {visibleFollowers.length > 0 ? (
            <ul className="simple-voter-list">
              {visibleFollowers.map((follower) => (
                <li key={follower.id} className="simple-voter-list-item">
                  <p className="simple-voter-question">
                    Voter {follower.voterId} is following this coordinator
                    {follower.votingId ? ` for ${follower.votingId.slice(0, 12)}` : " and is waiting for the next live vote"}
                  </p>
                  {selectedPublishedVote ? (
                    <div className="simple-voter-action-row">
                      <button
                        type="button"
                        className="simple-voter-secondary"
                        onClick={() => void sendTicket(follower)}
                        disabled={!keypair?.nsec || (!isLeadCoordinator && activeShareIndex <= 0)}
                      >
                        Send ticket
                      </button>
                    </div>
                  ) : null}
                  {ticketStatuses[`${follower.voterNpub}:${selectedPublishedVote?.votingId ?? ""}`] && (
                    <p className="simple-voter-note">{ticketStatuses[`${follower.voterNpub}:${selectedPublishedVote?.votingId ?? ""}`]}</p>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="simple-voter-empty">No voters are following this coordinator yet.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title="Question">
          {isLeadCoordinator ? (
            <>
              <label className="simple-voter-label" htmlFor="simple-question-prompt">Question</label>
              <textarea
                id="simple-question-prompt"
                className="simple-voter-textarea"
                value={questionPrompt}
                onChange={(event) => setQuestionPrompt(event.target.value)}
                rows={3}
              />
              <label className="simple-voter-label" htmlFor="simple-question-voting-id">Voting ID</label>
              <input
                id="simple-question-voting-id"
                className="simple-voter-input"
                value={questionVotingId}
                onChange={(event) => setQuestionVotingId(event.target.value)}
              />
              <div className="simple-vote-threshold-grid">
                <div>
                  <label className="simple-voter-label" htmlFor="simple-threshold-t">Threshold T</label>
                  <input
                    id="simple-threshold-t"
                    className="simple-voter-input"
                    value={questionThresholdT}
                    onChange={(event) => setQuestionThresholdT(event.target.value)}
                  />
                </div>
                <div>
                  <label className="simple-voter-label" htmlFor="simple-threshold-n">Threshold N</label>
                  <input
                    id="simple-threshold-n"
                    className="simple-voter-input"
                    value={questionThresholdN}
                    onChange={(event) => setQuestionThresholdN(event.target.value)}
                  />
                </div>
                <div>
                  <label className="simple-voter-label" htmlFor="simple-share-index">Share Index</label>
                  <input
                    id="simple-share-index"
                    className="simple-voter-input"
                    value="1"
                    readOnly
                    disabled
                  />
                </div>
              </div>
              <div className="simple-voter-action-row">
                <button
                  type="button"
                  className="simple-voter-primary"
                  onClick={() => void broadcastQuestion()}
                  disabled={!keypair?.nsec || questionPrompt.trim().length === 0}
                >
                  Broadcast live vote
                </button>
              </div>
            </>
          ) : selectedPublishedVote ? (
            <>
              <p className="simple-voter-question">{selectedPublishedVote.prompt}</p>
              <p className="simple-voter-note">Vote {shortVotingId(selectedPublishedVote.votingId)}</p>
            </>
          ) : (
            <p className="simple-voter-empty">No question selected yet.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title="Submitted votes">
          {selectedPublishedVote ? (
            <>
              <p className="simple-voter-question">
                Yes: {validYesCount} | No: {validNoCount}
              </p>
              {validatedVotes.length > 0 ? (
                <ul className="simple-voter-list">
                  {validatedVotes.map(({ vote, valid, reason }) => (
                    <li key={vote.eventId} className="simple-voter-list-item">
                      <div className="simple-vote-entry">
                        <div className="simple-vote-entry-copy">
                          <p className="simple-voter-question">
                            Vote {vote.choice} from {vote.voterNpub.slice(0, 16)}... {valid ? "(Valid)" : `(Invalid: ${reason})`}
                          </p>
                        </div>
                        {vote.tokenId && <TokenFingerprint tokenId={vote.tokenId} />}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="simple-voter-empty">No votes received yet.</p>
              )}
            </>
          ) : (
            <p className="simple-voter-empty">No live vote has been broadcast yet.</p>
          )}
        </SimpleCollapsibleSection>
      </section>
    </main>
  );
}

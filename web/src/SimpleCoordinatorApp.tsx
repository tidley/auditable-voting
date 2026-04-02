import { useEffect, useMemo, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec } from "./nostrIdentity";
import {
  subscribeSimpleCoordinatorFollowers,
  subscribeSimpleCoordinatorShareAssignments,
  subscribeSimpleShardRequests,
  subscribeSimpleSubCoordinatorApplications,
  sendSimpleShareAssignment,
  sendSimpleSubCoordinatorJoin,
  sendSimpleRoundTicket,
  type SimpleCoordinatorFollower,
  type SimpleShardRequest,
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
import {
  generateSimpleBlindKeyPair,
  publishSimpleBlindKeyAnnouncement,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindPrivateKey,
} from "./simpleShardCertificate";
import {
  downloadSimpleActorBackup,
  loadSimpleActorState,
  parseSimpleActorBackupBundle,
  saveSimpleActorState,
  type SimpleActorKeypair,
} from "./simpleLocalState";

type SimpleCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

type SimpleCoordinatorCache = {
  leadCoordinatorNpub: string;
  followers: SimpleCoordinatorFollower[];
  subCoordinators: SimpleSubCoordinatorApplication[];
  ticketStatuses: Record<string, string>;
  pendingRequests: SimpleShardRequest[];
  registrationStatus: string | null;
  assignmentStatus: string | null;
  questionPrompt: string;
  questionThresholdT: string;
  questionThresholdN: string;
  questionShareIndex: string;
  blindPrivateKey: SimpleBlindPrivateKey | null;
  publishStatus: string | null;
  publishedVotes: SimpleLiveVoteSession[];
  selectedVotingId: string;
  submittedVotes: SimpleSubmittedVote[];
};

function createSimpleCoordinatorKeypair(): SimpleCoordinatorKeypair {
  const secretKey = generateSecretKey();
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(getPublicKey(secretKey)),
  };
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

function findLatestRoundRequest(
  requests: SimpleShardRequest[],
  voterNpub: string,
  votingId: string,
) {
  return requests
    .filter((request) => request.voterNpub === voterNpub && request.votingId === votingId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export default function SimpleCoordinatorApp() {
  const [keypair, setKeypair] = useState<SimpleCoordinatorKeypair | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [coordinatorId, setCoordinatorId] = useState("pending");
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [leadCoordinatorNpub, setLeadCoordinatorNpub] = useState("");
  const [followers, setFollowers] = useState<SimpleCoordinatorFollower[]>([]);
  const [subCoordinators, setSubCoordinators] = useState<SimpleSubCoordinatorApplication[]>([]);
  const [ticketStatuses, setTicketStatuses] = useState<Record<string, string>>({});
  const [pendingRequests, setPendingRequests] = useState<SimpleShardRequest[]>([]);
  const [registrationStatus, setRegistrationStatus] = useState<string | null>(null);
  const [assignmentStatus, setAssignmentStatus] = useState<string | null>(null);
  const [questionPrompt, setQuestionPrompt] = useState("Should the proposal pass?");
  const [questionThresholdT, setQuestionThresholdT] = useState("1");
  const [questionThresholdN, setQuestionThresholdN] = useState("1");
  const [questionShareIndex, setQuestionShareIndex] = useState("1");
  const [blindPrivateKey, setBlindPrivateKey] = useState<SimpleBlindPrivateKey | null>(null);
  const [blindKeyAnnouncement, setBlindKeyAnnouncement] = useState<SimpleBlindKeyAnnouncement | null>(null);
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [publishedVotes, setPublishedVotes] = useState<SimpleLiveVoteSession[]>([]);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [submittedVotes, setSubmittedVotes] = useState<SimpleSubmittedVote[]>([]);
  const isLeadCoordinator = !leadCoordinatorNpub.trim() || leadCoordinatorNpub.trim() === (keypair?.npub ?? "");
  const activeShareIndex = isLeadCoordinator ? 1 : (Number.parseInt(questionShareIndex, 10) || 0);
  const hasAssignedShareIndex = !isLeadCoordinator && activeShareIndex > 0;
  const availableCoordinatorCount = Math.max(1, subCoordinators.length + 1);
  const liveVoteSourceNpub = isLeadCoordinator ? (keypair?.npub ?? "") : leadCoordinatorNpub.trim();
  const selectedPublishedVote = useMemo(
    () => publishedVotes.find((vote) => vote.votingId === selectedVotingId) ?? publishedVotes[0] ?? null,
    [publishedVotes, selectedVotingId],
  );
  const activeVotingId = selectedPublishedVote?.votingId ?? "";
  const activeThresholdT = selectedPublishedVote?.thresholdT ?? (Number.parseInt(questionThresholdT, 10) || undefined);
  const activeThresholdN = selectedPublishedVote?.thresholdN ?? (Number.parseInt(questionThresholdN, 10) || undefined);

  useEffect(() => {
    let cancelled = false;

    void loadSimpleActorState("coordinator").then((storedState) => {
      if (cancelled) {
        return;
      }

      if (storedState?.keypair) {
        setKeypair(storedState.keypair);
        const cache = (storedState.cache ?? null) as Partial<SimpleCoordinatorCache> | null;
        if (cache) {
          setLeadCoordinatorNpub(typeof cache.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
          setFollowers(Array.isArray(cache.followers) ? cache.followers : []);
          setSubCoordinators(Array.isArray(cache.subCoordinators) ? cache.subCoordinators : []);
          setTicketStatuses(cache.ticketStatuses && typeof cache.ticketStatuses === "object" ? cache.ticketStatuses : {});
          setPendingRequests(Array.isArray(cache.pendingRequests) ? cache.pendingRequests : []);
          setRegistrationStatus(typeof cache.registrationStatus === "string" ? cache.registrationStatus : null);
          setAssignmentStatus(typeof cache.assignmentStatus === "string" ? cache.assignmentStatus : null);
          setQuestionPrompt(typeof cache.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
          setQuestionThresholdT(typeof cache.questionThresholdT === "string" ? cache.questionThresholdT : "1");
          setQuestionThresholdN(typeof cache.questionThresholdN === "string" ? cache.questionThresholdN : "1");
          setQuestionShareIndex(typeof cache.questionShareIndex === "string" ? cache.questionShareIndex : "1");
          setBlindPrivateKey(cache.blindPrivateKey && typeof cache.blindPrivateKey === "object"
            ? cache.blindPrivateKey as SimpleBlindPrivateKey
            : null);
          setPublishStatus(typeof cache.publishStatus === "string" ? cache.publishStatus : null);
          setPublishedVotes(Array.isArray(cache.publishedVotes) ? cache.publishedVotes : []);
          setSelectedVotingId(typeof cache.selectedVotingId === "string" ? cache.selectedVotingId : "");
          setSubmittedVotes(Array.isArray(cache.submittedVotes) ? cache.submittedVotes : []);
        }
        setIdentityReady(true);
        return;
      }

      const nextKeypair = createSimpleCoordinatorKeypair();
      void saveSimpleActorState({
        role: "coordinator",
        keypair: nextKeypair,
        updatedAt: new Date().toISOString(),
      });
      setKeypair(nextKeypair);
      setIdentityReady(true);
    }).catch(() => {
      if (cancelled) {
        return;
      }

      const nextKeypair = createSimpleCoordinatorKeypair();
      setKeypair(nextKeypair);
      setIdentityReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!identityReady || !keypair) {
      return;
    }

    const cache: SimpleCoordinatorCache = {
      leadCoordinatorNpub,
      followers,
      subCoordinators,
      ticketStatuses,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      blindPrivateKey,
      publishStatus,
      publishedVotes,
      selectedVotingId,
      submittedVotes,
    };

    void saveSimpleActorState({
      role: "coordinator",
      keypair,
      updatedAt: new Date().toISOString(),
      cache,
    });
  }, [
    assignmentStatus,
    followers,
    identityReady,
    keypair,
    leadCoordinatorNpub,
    pendingRequests,
    publishStatus,
    publishedVotes,
    blindPrivateKey,
    questionPrompt,
    questionShareIndex,
    questionThresholdN,
    questionThresholdT,
    registrationStatus,
    selectedVotingId,
    subCoordinators,
    submittedVotes,
    ticketStatuses,
  ]);

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
    if (!isLeadCoordinator) {
      return;
    }

    setQuestionThresholdN(String(availableCoordinatorCount));
  }, [availableCoordinatorCount, isLeadCoordinator]);

  useEffect(() => {
    if (!isLeadCoordinator) {
      return;
    }

    const maxThresholdT = Math.max(
      1,
      Math.min(Number.parseInt(questionThresholdN, 10) || 1, availableCoordinatorCount),
    );
    setQuestionThresholdT((current) => {
      const parsed = Number.parseInt(current, 10);
      const nextValue = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 1), maxThresholdT)
        : maxThresholdT;
      return String(nextValue);
    });
  }, [availableCoordinatorCount, isLeadCoordinator, questionThresholdN]);

  useEffect(() => {
    if (!keypair || blindPrivateKey) {
      return;
    }

    let cancelled = false;
    void generateSimpleBlindKeyPair().then((nextBlindKey) => {
      if (!cancelled) {
        setBlindPrivateKey(nextBlindKey);
      }
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key generation failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [blindPrivateKey, keypair]);

  useEffect(() => {
    if (!keypair?.nsec || !blindPrivateKey) {
      setBlindKeyAnnouncement(null);
      return;
    }

    let cancelled = false;
    void publishSimpleBlindKeyAnnouncement({
      coordinatorNsec: keypair.nsec,
      publicKey: blindPrivateKey,
    }).then((result) => {
      if (!cancelled) {
        setBlindKeyAnnouncement({
          coordinatorNpub: keypair.npub,
          publicKey: blindPrivateKey,
          createdAt: result.createdAt,
          event: result.event,
        });
      }
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key announcement failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [blindPrivateKey, keypair?.npub, keypair?.nsec]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";
    if (!coordinatorNsec) {
      setPendingRequests([]);
      return;
    }

    setPendingRequests([]);

    return subscribeSimpleShardRequests({
      coordinatorNsec,
      onRequests: (nextRequests) => {
        setPendingRequests(nextRequests);
      },
    });
  }, [keypair?.nsec]);

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

    if (!isLeadCoordinator) {
      setSelectedVotingId(publishedVotes[0].votingId);
      return;
    }

    setSelectedVotingId((current) => (
      publishedVotes.some((vote) => vote.votingId === current) ? current : publishedVotes[0].votingId
    ));
  }, [isLeadCoordinator, publishedVotes]);

  useEffect(() => {
    setTicketStatuses({});
  }, [selectedPublishedVote?.votingId]);

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
    void saveSimpleActorState({
      role: "coordinator",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    });
    setKeypair(nextKeypair);
    setIdentityStatus(null);
    setBackupStatus(null);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketStatuses({});
    setPendingRequests([]);
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setBlindPrivateKey(null);
    setBlindKeyAnnouncement(null);
    setPublishStatus(null);
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSubmittedVotes([]);
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
      role: "coordinator",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    });
    setKeypair(nextKeypair);
    setIdentityStatus("Identity restored from nsec.");
    setBackupStatus(null);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketStatuses({});
    setPendingRequests([]);
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setBlindPrivateKey(null);
    setBlindKeyAnnouncement(null);
    setPublishStatus(null);
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSubmittedVotes([]);
  }

  function downloadBackup() {
    if (!keypair) {
      return;
    }

    downloadSimpleActorBackup("coordinator", keypair as SimpleActorKeypair, {
      leadCoordinatorNpub,
      followers,
      subCoordinators,
      ticketStatuses,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      blindPrivateKey,
      publishStatus,
      publishedVotes,
      selectedVotingId,
      submittedVotes,
    } satisfies SimpleCoordinatorCache);
    setBackupStatus("Coordinator backup downloaded.");
  }

  async function restoreBackup(file: File) {
    try {
      const text = await file.text();
      const bundle = parseSimpleActorBackupBundle(text);
      if (!bundle || bundle.role !== "coordinator") {
        setBackupStatus("Backup file is not a coordinator backup.");
        return;
      }

      await saveSimpleActorState({
        role: "coordinator",
        keypair: bundle.keypair,
        updatedAt: new Date().toISOString(),
        cache: bundle.cache,
      });
      setKeypair(bundle.keypair);
      setIdentityStatus("Identity restored from backup.");
      setBackupStatus(`Backup restored from ${bundle.exportedAt}.`);
      const cache = (bundle.cache ?? null) as Partial<SimpleCoordinatorCache> | null;
      setLeadCoordinatorNpub(typeof cache?.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
      setFollowers(Array.isArray(cache?.followers) ? cache.followers : []);
      setSubCoordinators(Array.isArray(cache?.subCoordinators) ? cache.subCoordinators : []);
      setTicketStatuses(cache?.ticketStatuses && typeof cache.ticketStatuses === "object" ? cache.ticketStatuses : {});
      setPendingRequests(Array.isArray(cache?.pendingRequests) ? cache.pendingRequests : []);
      setRegistrationStatus(typeof cache?.registrationStatus === "string" ? cache.registrationStatus : null);
      setAssignmentStatus(typeof cache?.assignmentStatus === "string" ? cache.assignmentStatus : null);
      setQuestionPrompt(typeof cache?.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
      setQuestionThresholdT(typeof cache?.questionThresholdT === "string" ? cache.questionThresholdT : "1");
      setQuestionThresholdN(typeof cache?.questionThresholdN === "string" ? cache.questionThresholdN : "1");
      setQuestionShareIndex(typeof cache?.questionShareIndex === "string" ? cache.questionShareIndex : "1");
      setBlindPrivateKey(cache?.blindPrivateKey && typeof cache.blindPrivateKey === "object"
        ? cache.blindPrivateKey as SimpleBlindPrivateKey
        : null);
      setBlindKeyAnnouncement(null);
      setPublishStatus(typeof cache?.publishStatus === "string" ? cache.publishStatus : null);
      setPublishedVotes(Array.isArray(cache?.publishedVotes) ? cache.publishedVotes : []);
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setSubmittedVotes(Array.isArray(cache?.submittedVotes) ? cache.submittedVotes : []);
    } catch {
      setBackupStatus("Backup restore failed.");
    }
  }

  function getThresholdLabel() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return `${configuredT} of ${configuredN}`;
    }

    return "1 of 1";
  }

  function getThresholdNumbers() {
    const configuredT = Number.parseInt(questionThresholdT, 10);
    const configuredN = Number.parseInt(questionThresholdN, 10);
    if (configuredT > 0 && configuredN > 0) {
      return { thresholdT: configuredT, thresholdN: configuredN };
    }

    return { thresholdT: 1, thresholdN: 1 };
  }

  async function sendTicket(follower: SimpleCoordinatorFollower) {
    const coordinatorNpub = keypair?.npub ?? "";
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const votingId = selectedPublishedVote?.votingId ?? "";
    const prompt = selectedPublishedVote?.prompt ?? "";
    const matchingRequest = findLatestRoundRequest(pendingRequests, follower.voterNpub, votingId);

    if (
      !coordinatorNpub
      || !coordinatorSecretKey
      || !blindPrivateKey
      || !blindKeyAnnouncement
      || !matchingRequest
      || !coordinatorId
      || coordinatorId === "pending"
      || !votingId
      || !prompt
      || activeShareIndex <= 0
    ) {
      return;
    }

    const ticketStatusKey = `${follower.voterNpub}:${votingId}`;
    setTicketStatuses((current) => ({ ...current, [ticketStatusKey]: "Sending ticket..." }));

    try {
      const thresholdLabel = activeThresholdT && activeThresholdN
        ? `${activeThresholdT} of ${activeThresholdN}`
        : getThresholdLabel();
      const result = await sendSimpleRoundTicket({
        coordinatorSecretKey,
        blindPrivateKey,
        keyAnnouncementEvent: blindKeyAnnouncement.event,
        voterNpub: follower.voterNpub,
        voterId: follower.voterId,
        coordinatorNpub,
        coordinatorId,
        thresholdLabel,
        request: matchingRequest,
        votingPrompt: prompt,
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
      setPublishStatus(result.successes > 0 ? "Vote broadcast." : "Vote broadcast failed.");
    } catch {
      setPublishStatus("Vote broadcast failed.");
    }
  }

  function selectRound(votingId: string) {
    setSelectedVotingId(votingId);
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
          onRestoreNsec={restoreIdentity}
          restoreMessage={identityStatus}
          onDownloadBackup={identityReady ? downloadBackup : undefined}
          onRestoreBackupFile={restoreBackup}
          backupMessage={backupStatus}
        />

        <SimpleCollapsibleSection title="Coordinator management">
          <label className="simple-voter-label" htmlFor="simple-lead-coordinator-npub">Lead coordinator npub</label>
          <div className="simple-voter-inline-field">
            <input
              id="simple-lead-coordinator-npub"
              className="simple-voter-input simple-voter-input-inline"
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
            {!isLeadCoordinator ? (
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
            ) : null}
          </div>
          <p className="simple-voter-question">
            {isLeadCoordinator
              ? "This coordinator publishes the live question."
              : "This coordinator follows the lead question and only issues shares."}
          </p>
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
          {isLeadCoordinator ? (
            <>
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
                  {(() => {
                    const ticketStatusKey = `${follower.voterNpub}:${selectedPublishedVote?.votingId ?? ""}`;
                    const ticketStatus = ticketStatuses[ticketStatusKey];
                    const ticketWasSent = ticketStatus === "Ticket sent.";
                    const hasPendingRequest = selectedPublishedVote
                      ? Boolean(findLatestRoundRequest(pendingRequests, follower.voterNpub, selectedPublishedVote.votingId))
                      : false;

                    return (
                      <>
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
                        disabled={
                          !keypair?.nsec
                          || !blindPrivateKey
                          || !blindKeyAnnouncement
                          || !hasPendingRequest
                          || (!isLeadCoordinator && activeShareIndex <= 0)
                        }
                      >
                        {ticketWasSent ? "Resend" : "Send ticket"}
                      </button>
                    </div>
                  ) : null}
                  {!ticketStatus && selectedPublishedVote && !hasPendingRequest ? (
                    <p className="simple-voter-note">Waiting for this voter&apos;s blinded ticket request.</p>
                  ) : null}
                  {ticketStatus && (
                    <p className="simple-voter-note">{ticketStatus}</p>
                  )}
                      </>
                    );
                  })()}
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
              <div className="simple-vote-threshold-grid">
                <div>
                  <label className="simple-voter-label" htmlFor="simple-threshold-t">Threshold T</label>
                  <input
                    id="simple-threshold-t"
                    className="simple-voter-range"
                    type="range"
                    min="1"
                    max={Math.max(1, Math.min(Number.parseInt(questionThresholdN, 10) || 1, availableCoordinatorCount))}
                    step="1"
                    value={questionThresholdT}
                    onChange={(event) => setQuestionThresholdT(event.target.value)}
                  />
                  <p className="simple-voter-note">T = {questionThresholdT}</p>
                </div>
                <div>
                  <label className="simple-voter-label" htmlFor="simple-threshold-n">Threshold N</label>
                  <input
                    id="simple-threshold-n"
                    className="simple-voter-range"
                    type="range"
                    min="1"
                    max={availableCoordinatorCount}
                    step="1"
                    value={questionThresholdN}
                    disabled
                    readOnly
                  />
                  <p className="simple-voter-note">N = {questionThresholdN} of {availableCoordinatorCount} coordinators</p>
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
              <p className="simple-voter-question">{selectedPublishedVote.prompt}</p>
              <p className="simple-voter-note">Vote {shortVotingId(selectedPublishedVote.votingId)}</p>
              <p className="simple-submitted-score">
                Yes: {validYesCount} | No: {validNoCount}
              </p>
              {validatedVotes.length > 0 ? (
                <ul className="simple-voter-list">
                  {validatedVotes.map(({ vote, valid, reason }) => (
                    <li key={vote.eventId} className="simple-voter-list-item">
                      <div className="simple-vote-entry">
                        <div className="simple-vote-entry-copy">
                          <p className="simple-voter-question simple-vote-result-line">
                            <span>Vote {vote.choice}</span>
                            {" "}
                            <span className={valid ? "simple-vote-valid" : "simple-vote-invalid"}>
                              {valid ? "[Valid]" : `[Invalid${reason ? `: ${reason}` : ""}]`}
                            </span>
                          </p>
                        </div>
                        {vote.tokenId && <TokenFingerprint tokenId={vote.tokenId} large hideMetadata />}
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

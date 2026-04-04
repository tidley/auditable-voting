import { useEffect, useMemo, useRef, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec } from "./nostrIdentity";
import {
  subscribeSimpleCoordinatorFollowers,
  subscribeSimpleDmAcknowledgements,
  subscribeSimpleCoordinatorShareAssignments,
  subscribeSimpleShardRequests,
  subscribeSimpleSubCoordinatorApplications,
  sendSimpleDmAcknowledgement,
  sendSimpleShareAssignment,
  sendSimpleSubCoordinatorJoin,
  sendSimpleRoundTicket,
  type SimpleDmAcknowledgement,
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
import SimpleQrScanner from "./SimpleQrScanner";
import TokenFingerprint from "./TokenFingerprint";
import { extractNpubFromScan } from "./npubScan";
import {
  generateSimpleBlindKeyPair,
  publishSimpleBlindKeyAnnouncement,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindPrivateKey,
} from "./simpleShardCertificate";
import {
  downloadSimpleActorBackup,
  loadSimpleActorState,
  parseEncryptedSimpleActorBackupBundle,
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
  ticketDeliveries: Record<
    string,
    { status: string; eventId?: string; responseId?: string }
  >;
  pendingRequests: SimpleShardRequest[];
  registrationStatus: string | null;
  assignmentStatus: string | null;
  questionPrompt: string;
  questionThresholdT: string;
  questionThresholdN: string;
  questionShareIndex: string;
  roundBlindPrivateKeys: Record<string, SimpleBlindPrivateKey>;
  roundBlindKeyAnnouncements: Record<string, SimpleBlindKeyAnnouncement>;
  publishStatus: string | null;
  publishedVotes: SimpleLiveVoteSession[];
  selectedVotingId: string;
  selectedSubmittedVotingId: string;
  submittedVotes: SimpleSubmittedVote[];
};

function sortCoordinatorRoster(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function normalizeLiveVoteSession(
  vote: Partial<SimpleLiveVoteSession> | null | undefined,
  fallbackCoordinatorNpubs: string[] = [],
): SimpleLiveVoteSession | null {
  if (
    !vote
    || typeof vote.votingId !== "string"
    || typeof vote.prompt !== "string"
    || typeof vote.coordinatorNpub !== "string"
    || typeof vote.createdAt !== "string"
    || typeof vote.eventId !== "string"
  ) {
    return null;
  }

  const authorizedCoordinatorNpubs = sortCoordinatorRoster(
    Array.isArray(vote.authorizedCoordinatorNpubs)
      ? vote.authorizedCoordinatorNpubs
      : [vote.coordinatorNpub, ...fallbackCoordinatorNpubs],
  );

  return {
    votingId: vote.votingId,
    prompt: vote.prompt,
    coordinatorNpub: vote.coordinatorNpub,
    createdAt: vote.createdAt,
    thresholdT: typeof vote.thresholdT === "number" ? vote.thresholdT : undefined,
    thresholdN: typeof vote.thresholdN === "number" ? vote.thresholdN : undefined,
    authorizedCoordinatorNpubs,
    eventId: vote.eventId,
  };
}

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
  const [leadScannerActive, setLeadScannerActive] = useState(false);
  const [leadScannerStatus, setLeadScannerStatus] = useState<string | null>(null);
  const [followers, setFollowers] = useState<SimpleCoordinatorFollower[]>([]);
  const [subCoordinators, setSubCoordinators] = useState<SimpleSubCoordinatorApplication[]>([]);
  const [ticketDeliveries, setTicketDeliveries] = useState<Record<string, { status: string; eventId?: string; responseId?: string }>>({});
  const [pendingRequests, setPendingRequests] = useState<SimpleShardRequest[]>([]);
  const [dmAcknowledgements, setDmAcknowledgements] = useState<SimpleDmAcknowledgement[]>([]);
  const [registrationStatus, setRegistrationStatus] = useState<string | null>(null);
  const [assignmentStatus, setAssignmentStatus] = useState<string | null>(null);
  const [questionPrompt, setQuestionPrompt] = useState("Should the proposal pass?");
  const [questionThresholdT, setQuestionThresholdT] = useState("1");
  const [questionThresholdN, setQuestionThresholdN] = useState("1");
  const [questionShareIndex, setQuestionShareIndex] = useState("1");
  const [roundBlindPrivateKeys, setRoundBlindPrivateKeys] = useState<Record<string, SimpleBlindPrivateKey>>({});
  const [roundBlindKeyAnnouncements, setRoundBlindKeyAnnouncements] = useState<Record<string, SimpleBlindKeyAnnouncement>>({});
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [publishedVotes, setPublishedVotes] = useState<SimpleLiveVoteSession[]>([]);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [selectedSubmittedVotingId, setSelectedSubmittedVotingId] =
    useState('');
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
  const selectedSubmittedVote = useMemo(
    () =>
      publishedVotes.find(
        (vote) => vote.votingId === selectedSubmittedVotingId,
      ) ??
      publishedVotes[0] ??
      null,
    [publishedVotes, selectedSubmittedVotingId],
  );
  const activeVotingId = selectedPublishedVote?.votingId ?? "";
  const activeThresholdT = selectedPublishedVote?.thresholdT ?? (Number.parseInt(questionThresholdT, 10) || undefined);
  const activeThresholdN = selectedPublishedVote?.thresholdN ?? (Number.parseInt(questionThresholdN, 10) || undefined);
  const activeBlindPrivateKey = activeVotingId ? roundBlindPrivateKeys[activeVotingId] ?? null : null;
  const activeBlindKeyAnnouncement = activeVotingId ? roundBlindKeyAnnouncements[activeVotingId] ?? null : null;
  const maxThresholdT = Math.max(
    1,
    Math.min(Number.parseInt(questionThresholdN, 10) || 1, availableCoordinatorCount),
  );
  const sentFollowAckIdsRef = useRef<Set<string>>(new Set());
  const sentRequestAckIdsRef = useRef<Set<string>>(new Set());
  const sentSubCoordinatorAckIdsRef = useRef<Set<string>>(new Set());
  const sentAssignmentAckIdsRef = useRef<Set<string>>(new Set());

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
          const fallbackCoordinatorNpubs = sortCoordinatorRoster(
            Array.isArray(cache.subCoordinators)
              ? cache.subCoordinators.flatMap((application) => (
                application && typeof application.coordinatorNpub === "string"
                  ? [application.coordinatorNpub]
                  : []
              ))
              : [],
          );
          setLeadCoordinatorNpub(typeof cache.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
          setFollowers(Array.isArray(cache.followers) ? cache.followers : []);
          setSubCoordinators(Array.isArray(cache.subCoordinators) ? cache.subCoordinators : []);
          setTicketDeliveries(cache.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {});
          setPendingRequests(Array.isArray(cache.pendingRequests) ? cache.pendingRequests : []);
          setRegistrationStatus(typeof cache.registrationStatus === "string" ? cache.registrationStatus : null);
          setAssignmentStatus(typeof cache.assignmentStatus === "string" ? cache.assignmentStatus : null);
          setQuestionPrompt(typeof cache.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
          setQuestionThresholdT(typeof cache.questionThresholdT === "string" ? cache.questionThresholdT : "1");
          setQuestionThresholdN(typeof cache.questionThresholdN === "string" ? cache.questionThresholdN : "1");
          setQuestionShareIndex(typeof cache.questionShareIndex === "string" ? cache.questionShareIndex : "1");
          setRoundBlindPrivateKeys(
            cache.roundBlindPrivateKeys && typeof cache.roundBlindPrivateKeys === "object"
              ? cache.roundBlindPrivateKeys as Record<string, SimpleBlindPrivateKey>
              : {},
          );
          setRoundBlindKeyAnnouncements(
            cache.roundBlindKeyAnnouncements && typeof cache.roundBlindKeyAnnouncements === "object"
              ? cache.roundBlindKeyAnnouncements as Record<string, SimpleBlindKeyAnnouncement>
              : {},
          );
          setPublishStatus(typeof cache.publishStatus === "string" ? cache.publishStatus : null);
          setPublishedVotes(
            Array.isArray(cache.publishedVotes)
              ? cache.publishedVotes
                .map((vote) => normalizeLiveVoteSession(vote, fallbackCoordinatorNpubs))
                .filter((vote): vote is SimpleLiveVoteSession => vote !== null)
              : [],
          );
          setSelectedVotingId(typeof cache.selectedVotingId === "string" ? cache.selectedVotingId : "");
          setSelectedSubmittedVotingId(
            typeof cache.selectedSubmittedVotingId === 'string'
              ? cache.selectedSubmittedVotingId
              : '',
          );
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
      ticketDeliveries,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      roundBlindPrivateKeys,
      roundBlindKeyAnnouncements,
      publishStatus,
      publishedVotes,
      selectedVotingId,
      selectedSubmittedVotingId,
      submittedVotes,
    };

    void saveSimpleActorState({
      role: 'coordinator',
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
    roundBlindKeyAnnouncements,
    roundBlindPrivateKeys,
    questionPrompt,
    questionShareIndex,
    questionThresholdN,
    questionThresholdT,
    registrationStatus,
    selectedSubmittedVotingId,
    selectedVotingId,
    subCoordinators,
    submittedVotes,
    ticketDeliveries,
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
    const actorNsec = keypair?.nsec ?? "";

    if (!actorNsec) {
      setDmAcknowledgements([]);
      return;
    }

    setDmAcknowledgements([]);

    return subscribeSimpleDmAcknowledgements({
      actorNsec,
      onAcknowledgements: (nextAcknowledgements) => {
        setDmAcknowledgements(nextAcknowledgements);
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

        if (!latestAssignment.dmEventId || sentAssignmentAckIdsRef.current.has(latestAssignment.dmEventId)) {
          return;
        }

        const coordinatorSecretKey = decodeNsec(coordinatorNsec);

        if (!coordinatorSecretKey || !keypair?.npub) {
          return;
        }

        sentAssignmentAckIdsRef.current.add(latestAssignment.dmEventId);
        void sendSimpleDmAcknowledgement({
          senderSecretKey: coordinatorSecretKey,
          recipientNpub: latestAssignment.leadCoordinatorNpub,
          actorNpub: keypair.npub,
          actorId: coordinatorId === "pending" ? undefined : coordinatorId,
          ackedAction: "simple_share_assignment",
          ackedEventId: latestAssignment.dmEventId,
        }).catch(() => {
          sentAssignmentAckIdsRef.current.delete(latestAssignment.dmEventId);
        });
      },
    });
  }, [coordinatorId, isLeadCoordinator, keypair?.nsec, keypair?.npub, leadCoordinatorNpub]);

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

    setQuestionThresholdT((current) => {
      const parsed = Number.parseInt(current, 10);
      const nextValue = Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 1), maxThresholdT)
        : maxThresholdT;
      return String(nextValue);
    });
  }, [availableCoordinatorCount, isLeadCoordinator, questionThresholdN]);

  useEffect(() => {
    const coordinatorNpub = keypair?.npub ?? "";
    const activeRound = selectedPublishedVote;

    if (!coordinatorNpub || !activeRound || !activeRound.authorizedCoordinatorNpubs.includes(coordinatorNpub)) {
      return;
    }

    if (roundBlindPrivateKeys[activeRound.votingId]) {
      return;
    }

    let cancelled = false;
    void generateSimpleBlindKeyPair().then((nextBlindKey) => {
      if (!cancelled) {
        setRoundBlindPrivateKeys((current) => ({
          ...current,
          [activeRound.votingId]: nextBlindKey,
        }));
      }
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key generation failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [keypair?.npub, roundBlindPrivateKeys, selectedPublishedVote]);

  useEffect(() => {
    const coordinatorNsec = keypair?.nsec ?? "";
    const coordinatorNpub = keypair?.npub ?? "";
    const activeRound = selectedPublishedVote;

    if (
      !coordinatorNsec
      || !coordinatorNpub
      || !activeRound
      || !activeRound.authorizedCoordinatorNpubs.includes(coordinatorNpub)
    ) {
      return;
    }

    const blindPrivateKey = roundBlindPrivateKeys[activeRound.votingId];
    if (!blindPrivateKey) {
      return;
    }

    const existingAnnouncement = roundBlindKeyAnnouncements[activeRound.votingId];
    const existingAnnouncementKeyId = existingAnnouncement?.publicKey?.keyId;
    if (existingAnnouncementKeyId === blindPrivateKey.keyId) {
      return;
    }

    let cancelled = false;
    void publishSimpleBlindKeyAnnouncement({
      coordinatorNsec,
      votingId: activeRound.votingId,
      publicKey: blindPrivateKey,
    }).then((result) => {
      if (!cancelled) {
        setRoundBlindKeyAnnouncements((current) => ({
          ...current,
          [activeRound.votingId]: {
            coordinatorNpub,
            votingId: activeRound.votingId,
            publicKey: blindPrivateKey,
            createdAt: result.createdAt,
            event: result.event,
          },
        }));
      }
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key announcement failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [keypair?.npub, keypair?.nsec, roundBlindKeyAnnouncements, roundBlindPrivateKeys, selectedPublishedVote]);

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
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!coordinatorSecretKey || !coordinatorNpub) {
      return;
    }

    for (const follower of followers) {
      if (!follower.dmEventId || sentFollowAckIdsRef.current.has(follower.dmEventId)) {
        continue;
      }

      sentFollowAckIdsRef.current.add(follower.dmEventId);
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: follower.voterNpub,
        actorNpub: coordinatorNpub,
        actorId: coordinatorId === "pending" ? undefined : coordinatorId,
        ackedAction: "simple_coordinator_follow",
        ackedEventId: follower.dmEventId,
        votingId: follower.votingId,
      }).catch(() => {
        sentFollowAckIdsRef.current.delete(follower.dmEventId);
      });
    }
  }, [coordinatorId, followers, keypair?.nsec, keypair?.npub]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!coordinatorSecretKey || !coordinatorNpub) {
      return;
    }

    for (const request of pendingRequests) {
      if (!request.dmEventId || sentRequestAckIdsRef.current.has(request.dmEventId)) {
        continue;
      }

      sentRequestAckIdsRef.current.add(request.dmEventId);
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: request.voterNpub,
        actorNpub: coordinatorNpub,
        actorId: coordinatorId === "pending" ? undefined : coordinatorId,
        ackedAction: "simple_shard_request",
        ackedEventId: request.dmEventId,
        votingId: request.votingId,
        requestId: request.blindRequest.requestId,
      }).catch(() => {
        sentRequestAckIdsRef.current.delete(request.dmEventId);
      });
    }
  }, [coordinatorId, keypair?.nsec, keypair?.npub, pendingRequests]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!isLeadCoordinator || !coordinatorSecretKey || !coordinatorNpub) {
      return;
    }

    for (const application of subCoordinators) {
      if (!application.dmEventId || sentSubCoordinatorAckIdsRef.current.has(application.dmEventId)) {
        continue;
      }

      sentSubCoordinatorAckIdsRef.current.add(application.dmEventId);
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: application.coordinatorNpub,
        actorNpub: coordinatorNpub,
        actorId: coordinatorId === "pending" ? undefined : coordinatorId,
        ackedAction: "simple_subcoordinator_join",
        ackedEventId: application.dmEventId,
      }).catch(() => {
        sentSubCoordinatorAckIdsRef.current.delete(application.dmEventId);
      });
    }
  }, [coordinatorId, isLeadCoordinator, keypair?.nsec, keypair?.npub, subCoordinators]);

  useEffect(() => {
    if (!liveVoteSourceNpub) {
      setPublishedVotes([]);
      return;
    }

    setPublishedVotes([]);

    return subscribeSimpleLiveVotes({
      coordinatorNpub: liveVoteSourceNpub,
      onSessions: (nextVotes) => {
        setPublishedVotes(
          nextVotes
            .map((vote) => normalizeLiveVoteSession(vote))
            .filter((vote): vote is SimpleLiveVoteSession => vote !== null),
        );
      },
    });
  }, [liveVoteSourceNpub]);

  useEffect(() => {
    if (!publishedVotes.length) {
      setSelectedVotingId("");
      setSelectedSubmittedVotingId('');
      return;
    }

    if (!isLeadCoordinator) {
      setSelectedVotingId(publishedVotes[0].votingId);
    } else {
      setSelectedVotingId((current) =>
        publishedVotes.some((vote) => vote.votingId === current)
          ? current
          : publishedVotes[0].votingId,
      );
    }

    setSelectedSubmittedVotingId((current) =>
      publishedVotes.some((vote) => vote.votingId === current)
        ? current
        : publishedVotes[0].votingId,
    );
  }, [isLeadCoordinator, publishedVotes]);

  useEffect(() => {
    const votingId = selectedSubmittedVote?.votingId ?? '';

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
  }, [selectedSubmittedVote?.votingId]);

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
    setTicketDeliveries({});
    setPendingRequests([]);
    setDmAcknowledgements([]);
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setRoundBlindPrivateKeys({});
    setRoundBlindKeyAnnouncements({});
    setPublishStatus(null);
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSelectedSubmittedVotingId('');
    setSubmittedVotes([]);
    sentFollowAckIdsRef.current.clear();
    sentRequestAckIdsRef.current.clear();
    sentSubCoordinatorAckIdsRef.current.clear();
    sentAssignmentAckIdsRef.current.clear();
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
    setTicketDeliveries({});
    setPendingRequests([]);
    setDmAcknowledgements([]);
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setQuestionPrompt("Should the proposal pass?");
    setQuestionThresholdT("1");
    setQuestionThresholdN("1");
    setQuestionShareIndex("1");
    setRoundBlindPrivateKeys({});
    setRoundBlindKeyAnnouncements({});
    setPublishStatus(null);
    setPublishedVotes([]);
    setSelectedVotingId("");
    setSelectedSubmittedVotingId('');
    setSubmittedVotes([]);
    sentFollowAckIdsRef.current.clear();
    sentRequestAckIdsRef.current.clear();
    sentSubCoordinatorAckIdsRef.current.clear();
    sentAssignmentAckIdsRef.current.clear();
  }

  function handleLeadCoordinatorScanDetected(rawValue: string) {
    const scannedNpub = extractNpubFromScan(rawValue);
    if (!scannedNpub) {
      setLeadScannerStatus("QR did not contain a valid npub.");
      return false;
    }

    setLeadCoordinatorNpub(scannedNpub);
    if (scannedNpub.trim() !== (keypair?.npub ?? '')) {
      setQuestionShareIndex('');
    }
    setRegistrationStatus(null);
    setAssignmentStatus(null);
    setLeadScannerStatus(`Scanned ${scannedNpub.slice(0, 18)}...`);
    return true;
  }

  function downloadBackup(passphrase?: string) {
    if (!keypair) {
      return;
    }

    void downloadSimpleActorBackup('coordinator', keypair as SimpleActorKeypair, {
      leadCoordinatorNpub,
      followers,
      subCoordinators,
      ticketDeliveries,
      pendingRequests,
      registrationStatus,
      assignmentStatus,
      questionPrompt,
      questionThresholdT,
      questionThresholdN,
      questionShareIndex,
      roundBlindPrivateKeys,
      roundBlindKeyAnnouncements,
      publishStatus,
      publishedVotes,
      selectedVotingId,
      selectedSubmittedVotingId,
      submittedVotes,
    } satisfies SimpleCoordinatorCache, { passphrase });
    setBackupStatus(passphrase?.trim() ? "Encrypted coordinator backup downloaded." : "Coordinator backup downloaded.");
  }

  async function restoreBackup(file: File, passphrase?: string) {
    try {
      const text = await file.text();
      const bundle = parseSimpleActorBackupBundle(text)
        ?? (passphrase?.trim() ? await parseEncryptedSimpleActorBackupBundle(text, passphrase.trim()) : null);
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
      const fallbackCoordinatorNpubs = sortCoordinatorRoster(
        Array.isArray(cache?.subCoordinators)
          ? cache.subCoordinators.flatMap((application) => (
            application && typeof application.coordinatorNpub === "string"
              ? [application.coordinatorNpub]
              : []
          ))
          : [],
      );
      setLeadCoordinatorNpub(typeof cache?.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
      setFollowers(Array.isArray(cache?.followers) ? cache.followers : []);
      setSubCoordinators(Array.isArray(cache?.subCoordinators) ? cache.subCoordinators : []);
      setTicketDeliveries(
        cache?.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {},
      );
      setPendingRequests(Array.isArray(cache?.pendingRequests) ? cache.pendingRequests : []);
      setDmAcknowledgements([]);
      setRegistrationStatus(typeof cache?.registrationStatus === "string" ? cache.registrationStatus : null);
      setAssignmentStatus(typeof cache?.assignmentStatus === "string" ? cache.assignmentStatus : null);
      setQuestionPrompt(typeof cache?.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
      setQuestionThresholdT(typeof cache?.questionThresholdT === "string" ? cache.questionThresholdT : "1");
      setQuestionThresholdN(typeof cache?.questionThresholdN === "string" ? cache.questionThresholdN : "1");
      setQuestionShareIndex(typeof cache?.questionShareIndex === "string" ? cache.questionShareIndex : "1");
      setRoundBlindPrivateKeys(
        cache?.roundBlindPrivateKeys && typeof cache.roundBlindPrivateKeys === "object"
          ? cache.roundBlindPrivateKeys as Record<string, SimpleBlindPrivateKey>
          : {},
      );
      setRoundBlindKeyAnnouncements(
        cache?.roundBlindKeyAnnouncements && typeof cache.roundBlindKeyAnnouncements === "object"
          ? cache.roundBlindKeyAnnouncements as Record<string, SimpleBlindKeyAnnouncement>
          : {},
      );
      setPublishStatus(typeof cache?.publishStatus === "string" ? cache.publishStatus : null);
      setPublishedVotes(
        Array.isArray(cache?.publishedVotes)
          ? cache.publishedVotes
            .map((vote) => normalizeLiveVoteSession(vote, fallbackCoordinatorNpubs))
            .filter((vote): vote is SimpleLiveVoteSession => vote !== null)
          : [],
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setSelectedSubmittedVotingId(
        typeof cache?.selectedSubmittedVotingId === 'string'
          ? cache.selectedSubmittedVotingId
          : '',
      );
      setSubmittedVotes(Array.isArray(cache?.submittedVotes) ? cache.submittedVotes : []);
      sentFollowAckIdsRef.current.clear();
      sentRequestAckIdsRef.current.clear();
      sentSubCoordinatorAckIdsRef.current.clear();
      sentAssignmentAckIdsRef.current.clear();
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
      || !activeBlindPrivateKey
      || !activeBlindKeyAnnouncement
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
    setTicketDeliveries((current) => ({ ...current, [ticketStatusKey]: { status: "Sending ticket..." } }));

    try {
      const thresholdLabel = activeThresholdT && activeThresholdN
        ? `${activeThresholdT} of ${activeThresholdN}`
        : getThresholdLabel();
      const result = await sendSimpleRoundTicket({
        coordinatorSecretKey,
        blindPrivateKey: activeBlindPrivateKey,
        keyAnnouncementEvent: activeBlindKeyAnnouncement.event,
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

      setTicketDeliveries((current) => ({
        ...current,
        [ticketStatusKey]: {
          status: result.successes > 0 ? "Ticket sent." : "Ticket send failed.",
          eventId: result.eventId,
          responseId: result.responseId,
        },
      }));
    } catch {
      setTicketDeliveries((current) => ({
        ...current,
        [ticketStatusKey]: { status: "Ticket send failed." },
      }));
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
      const authorizedCoordinatorNpubs = sortCoordinatorRoster([
        keypair?.npub ?? "",
        ...subCoordinators.map((application) => application.coordinatorNpub),
      ]);
      const result = await publishSimpleLiveVote({
        coordinatorNsec,
        prompt,
        thresholdT: threshold.thresholdT,
        thresholdN: threshold.thresholdN,
        authorizedCoordinatorNpubs,
      });

      setPublishedVotes((current) => {
        const nextVote = {
          votingId: result.votingId,
          prompt,
          coordinatorNpub: result.coordinatorNpub,
          createdAt: result.createdAt,
          thresholdT: threshold.thresholdT,
          thresholdN: threshold.thresholdN,
          authorizedCoordinatorNpubs,
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

  const requiredShardCount = Math.max(
    1,
    selectedSubmittedVote?.thresholdT ?? 1,
  );
  const validatedVotes = validateSimpleSubmittedVotes(
    submittedVotes,
    requiredShardCount,
    selectedSubmittedVote?.authorizedCoordinatorNpubs ?? [],
  );
  const validYesCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "Yes").length;
  const validNoCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "No").length;
  const visibleFollowers = activeVotingId
    ? followers.filter((follower) => !follower.votingId || follower.votingId === activeVotingId)
    : followers;
  const expectedSubCoordinatorCount = Math.max(0, (Number.parseInt(questionThresholdN, 10) || 1) - 1);

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>Coordinator ID {coordinatorId}</h1>
          <button
            type='button'
            className='simple-voter-primary'
            onClick={refreshIdentity}
          >
            Refresh ID
          </button>
        </div>

        <SimpleIdentityPanel
          npub={keypair?.npub ?? ''}
          nsec={keypair?.nsec ?? ''}
          title='Identity'
          onRestoreNsec={restoreIdentity}
          restoreMessage={identityStatus}
          onDownloadBackup={identityReady ? downloadBackup : undefined}
          onRestoreBackupFile={restoreBackup}
          backupMessage={backupStatus}
        />

        <SimpleCollapsibleSection title='Coordinator management'>
          <label
            className='simple-voter-label'
            htmlFor='simple-lead-coordinator-npub'
          >
            Lead coordinator npub
          </label>
          <div className='simple-voter-inline-field'>
            <input
              id='simple-lead-coordinator-npub'
              className='simple-voter-input simple-voter-input-inline'
              value={leadCoordinatorNpub}
              onChange={(event) => {
                const nextLeadCoordinatorNpub = event.target.value;
                setLeadCoordinatorNpub(nextLeadCoordinatorNpub);
                setLeadScannerStatus(null);
                if (nextLeadCoordinatorNpub.trim() !== (keypair?.npub ?? '')) {
                  setQuestionShareIndex('');
                }
                setRegistrationStatus(null);
                setAssignmentStatus(null);
              }}
              placeholder='Leave blank if this coordinator is the lead'
            />
            <button
              type='button'
              className='simple-voter-secondary simple-voter-scan-button'
              onClick={() => {
                setLeadScannerStatus(null);
                setLeadScannerActive(true);
              }}
            >
              Scan
            </button>
            {!isLeadCoordinator ? (
              <button
                type='button'
                className='simple-voter-secondary'
                onClick={() => void submitToLeadCoordinator()}
                disabled={
                  !keypair?.nsec ||
                  !leadCoordinatorNpub.trim() ||
                  leadCoordinatorNpub.trim() === (keypair?.npub ?? '') ||
                  hasAssignedShareIndex
                }
              >
                {hasAssignedShareIndex
                  ? 'Registered with lead'
                  : 'Submit to lead'}
              </button>
            ) : null}
          </div>
          <SimpleQrScanner
            active={leadScannerActive}
            onDetected={handleLeadCoordinatorScanDetected}
            onClose={() => setLeadScannerActive(false)}
            prompt='Point the camera at the lead coordinator npub QR code.'
          />
          {leadScannerStatus ? <p className='simple-voter-note'>{leadScannerStatus}</p> : null}
          <p className='simple-voter-question'>
            {isLeadCoordinator
              ? 'This coordinator publishes the live question.'
              : 'This coordinator follows the lead question and only issues shares.'}
          </p>
          {publishedVotes.length > 0 ? (
            <>
              <label
                className='simple-voter-label'
                htmlFor='simple-active-round'
              >
                Current round
              </label>
              <select
                id='simple-active-round'
                className='simple-voter-input'
                value={selectedPublishedVote?.votingId ?? ''}
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
              <div className='simple-voter-action-row'>
                <button
                  type='button'
                  className='simple-voter-secondary'
                  onClick={() => void distributeShareIndexes()}
                  disabled={!keypair?.nsec || subCoordinators.length === 0}
                >
                  Distribute share indexes
                </button>
              </div>
            </>
          ) : (
            <>
              <div className='simple-vote-threshold-grid'>
                <div>
                  <label
                    className='simple-voter-label'
                    htmlFor='simple-share-index'
                  >
                    Share Index
                  </label>
                  <input
                    id='simple-share-index'
                    className='simple-voter-input'
                    value={questionShareIndex || 'Awaiting assignment'}
                    readOnly
                    disabled
                  />
                </div>
              </div>
            </>
          )}
          <p className='simple-voter-question'>
            Threshold:{' '}
            {activeThresholdT && activeThresholdN
              ? `${activeThresholdT} of ${activeThresholdN}`
              : getThresholdLabel()}
          </p>
          {publishStatus && (
            <p className='simple-voter-note'>{publishStatus}</p>
          )}
          {registrationStatus &&
            !isLeadCoordinator &&
            !hasAssignedShareIndex && (
              <p className='simple-voter-note'>{registrationStatus}</p>
            )}
          {assignmentStatus && (
            <p className='simple-voter-note'>{assignmentStatus}</p>
          )}
          {selectedPublishedVote && (
            <>
              <p className='simple-voter-question'>
                Voting ID {selectedPublishedVote.votingId.slice(0, 12)}
              </p>
              <p className='simple-voter-question'>
                Live prompt: {selectedPublishedVote.prompt}
              </p>
              <p className='simple-voter-question'>
                Question source:{' '}
                {selectedPublishedVote.coordinatorNpub === (keypair?.npub ?? '')
                  ? 'This coordinator'
                  : 'Lead coordinator'}
              </p>
              <p className='simple-voter-question'>
                This coordinator share index:{' '}
                {activeShareIndex || 'Awaiting assignment'}
              </p>
            </>
          )}
        </SimpleCollapsibleSection>

        {isLeadCoordinator && (
          <SimpleCollapsibleSection title='Sub-coordinators'>
            {subCoordinators.length > 0 ? (
              <>
                <p className='simple-voter-question'>
                  {subCoordinators.length} sub-coordinator
                  {subCoordinators.length === 1 ? '' : 's'} submitted
                  {expectedSubCoordinatorCount > 0
                    ? ` of ${expectedSubCoordinatorCount} expected`
                    : ''}
                  .
                </p>
                <ul className='simple-voter-list'>
                  {subCoordinators.map((application, index) => (
                    <li key={application.id} className='simple-voter-list-item'>
                      <p className='simple-voter-question'>
                        Coordinator {application.coordinatorId} submitted as
                        sub-coordinator #{index + 1}.
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className='simple-voter-empty'>
                No sub-coordinators have submitted yet.
              </p>
            )}
          </SimpleCollapsibleSection>
        )}

        <SimpleCollapsibleSection title='Following voters'>
          {visibleFollowers.length > 0 ? (
            <ul className='simple-voter-list'>
              {visibleFollowers.map((follower) => (
                <li key={follower.id} className='simple-voter-list-item'>
                  {(() => {
                    const ticketStatusKey = `${follower.voterNpub}:${selectedPublishedVote?.votingId ?? ''}`;
                    const ticketDelivery = ticketDeliveries[ticketStatusKey];
                    const ticketStatus = ticketDelivery?.status ?? null;
                    const ticketWasSent = ticketStatus === 'Ticket sent.';
                    const hasPendingRequest = selectedPublishedVote
                      ? Boolean(
                          findLatestRoundRequest(
                            pendingRequests,
                            follower.voterNpub,
                            selectedPublishedVote.votingId,
                          ),
                        )
                      : false;
                    const canSendTicket = Boolean(
                      keypair?.nsec &&
                      activeBlindPrivateKey &&
                      activeBlindKeyAnnouncement &&
                      hasPendingRequest &&
                      (isLeadCoordinator || activeShareIndex > 0),
                    );
                    const ticketReceiptAck = ticketDelivery?.eventId
                      ? dmAcknowledgements.find(
                          (ack) =>
                            ack.ackedAction === 'simple_round_ticket' &&
                            ack.ackedEventId === ticketDelivery.eventId,
                        )
                      : null;

                    return (
                      <>
                        <p className='simple-voter-question'>
                          Voter {follower.voterId} is following this coordinator
                          {follower.votingId
                            ? ` for ${follower.votingId.slice(0, 12)}`
                            : ' and is waiting for the next live vote'}
                        </p>
                        {selectedPublishedVote ? (
                          <div className='simple-voter-action-row'>
                            <button
                              type='button'
                              className='simple-voter-secondary'
                              onClick={() => void sendTicket(follower)}
                              disabled={!canSendTicket}
                            >
                              {ticketWasSent ? 'Resend' : 'Send ticket'}
                            </button>
                          </div>
                        ) : null}
                        <ul className='simple-delivery-diagnostics'>
                          <li className='simple-delivery-ok'>
                            Follow request received.
                          </li>
                          <li
                            className={
                              hasPendingRequest
                                ? 'simple-delivery-ok'
                                : 'simple-delivery-waiting'
                            }
                          >
                            {hasPendingRequest
                              ? 'Blinded ticket request received.'
                              : "Waiting for this voter's blinded ticket request."}
                          </li>
                          {selectedPublishedVote ? (
                            <li
                              className={
                                ticketStatus === 'Ticket send failed.'
                                  ? 'simple-delivery-error'
                                  : ticketStatus
                                    ? 'simple-delivery-ok'
                                    : 'simple-delivery-waiting'
                              }
                            >
                              {ticketStatus ?? 'Ticket not sent yet.'}
                            </li>
                          ) : (
                            <li className='simple-delivery-waiting'>
                              Waiting for a live round.
                            </li>
                          )}
                          {selectedPublishedVote && ticketWasSent ? (
                            <li
                              className={
                                ticketReceiptAck
                                  ? 'simple-delivery-ok'
                                  : 'simple-delivery-waiting'
                              }
                            >
                              {ticketReceiptAck
                                ? 'Voter acknowledged ticket receipt.'
                                : 'Waiting for voter ticket receipt acknowledgement.'}
                            </li>
                          ) : null}
                        </ul>
                      </>
                    );
                  })()}
                </li>
              ))}
            </ul>
          ) : (
            <p className='simple-voter-empty'>
              No voters are following this coordinator yet.
            </p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Question'>
          {isLeadCoordinator ? (
            <>
              <label
                className='simple-voter-label'
                htmlFor='simple-question-prompt'
              >
                Question
              </label>
              <textarea
                id='simple-question-prompt'
                className='simple-voter-textarea'
                value={questionPrompt}
                onChange={(event) => setQuestionPrompt(event.target.value)}
                rows={3}
              />
              <div className='simple-vote-threshold-grid'>
                <div>
                  <label
                    className='simple-voter-label'
                    htmlFor='simple-threshold-t-value'
                  >
                    Threshold T
                  </label>
                  <div className='simple-threshold-stepper'>
                    <button
                      type='button'
                      className='simple-voter-secondary simple-threshold-stepper-button'
                      aria-label='Decrease Threshold T'
                      onClick={() =>
                        setQuestionThresholdT((current) =>
                          String(
                            Math.max(
                              1,
                              (Number.parseInt(current, 10) || 1) - 1,
                            ),
                          ),
                        )
                      }
                      disabled={
                        (Number.parseInt(questionThresholdT, 10) || 1) <= 1
                      }
                    >
                      -
                    </button>
                    <output
                      id='simple-threshold-t-value'
                      className='simple-threshold-stepper-value'
                      aria-live='polite'
                    >
                      {questionThresholdT}
                    </output>
                    <button
                      type='button'
                      className='simple-voter-secondary simple-threshold-stepper-button'
                      aria-label='Increase Threshold T'
                      onClick={() =>
                        setQuestionThresholdT((current) =>
                          String(
                            Math.min(
                              maxThresholdT,
                              (Number.parseInt(current, 10) || 1) + 1,
                            ),
                          ),
                        )
                      }
                      disabled={
                        (Number.parseInt(questionThresholdT, 10) || 1) >=
                        maxThresholdT
                      }
                    >
                      +
                    </button>
                  </div>
                  <p className='simple-voter-note'>
                    T = {questionThresholdT}, capped to 1-{maxThresholdT}. N is
                    fixed at {questionThresholdN}.
                  </p>
                </div>
              </div>
              <div className='simple-voter-action-row'>
                <button
                  type='button'
                  className='simple-voter-primary'
                  onClick={() => void broadcastQuestion()}
                  disabled={
                    !keypair?.nsec || questionPrompt.trim().length === 0
                  }
                >
                  Broadcast live vote
                </button>
              </div>
            </>
          ) : selectedPublishedVote ? (
            <>
              <p className='simple-voter-question'>
                {selectedPublishedVote.prompt}
              </p>
              <p className='simple-voter-note'>
                Vote {shortVotingId(selectedPublishedVote.votingId)}
              </p>
            </>
          ) : (
            <p className='simple-voter-empty'>No question selected yet.</p>
          )}
        </SimpleCollapsibleSection>

        <SimpleCollapsibleSection title='Submitted votes'>
          {selectedSubmittedVote ? (
            <>
              {publishedVotes.length > 1 ? (
                <>
                  <label
                    className='simple-voter-label'
                    htmlFor='simple-submitted-round'
                  >
                    Round
                  </label>
                  <select
                    id='simple-submitted-round'
                    className='simple-voter-input'
                    value={selectedSubmittedVote.votingId}
                    onChange={(event) =>
                      setSelectedSubmittedVotingId(event.target.value)
                    }
                  >
                    {publishedVotes.map((vote) => (
                      <option key={vote.eventId} value={vote.votingId}>
                        {shortVotingId(vote.votingId)} - {vote.prompt}
                      </option>
                    ))}
                  </select>
                </>
              ) : null}
              <p className='simple-voter-question'>
                {selectedSubmittedVote.prompt}
              </p>
              <p className='simple-voter-note'>
                Vote {shortVotingId(selectedSubmittedVote.votingId)}
              </p>
              <p className='simple-submitted-score'>
                Yes: {validYesCount} | No: {validNoCount}
              </p>
              {validatedVotes.length > 0 ? (
                <ul className='simple-voter-list'>
                  {validatedVotes.map(({ vote, valid, reason }) => (
                    <li key={vote.eventId} className='simple-voter-list-item'>
                      <div className='simple-vote-entry'>
                        <div className='simple-vote-entry-copy'>
                          <p className='simple-voter-question simple-vote-result-line'>
                            <span>{vote.choice}</span>{' '}
                            <span
                              className={
                                valid
                                  ? 'simple-vote-valid'
                                  : 'simple-vote-invalid'
                              }
                            >
                              {valid
                                ? '[Valid]'
                                : `[Invalid${reason ? `: ${reason}` : ''}]`}
                            </span>
                          </p>
                        </div>
                        {vote.tokenId && (
                          <TokenFingerprint
                            tokenId={vote.tokenId}
                            large
                            hideMetadata
                          />
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='simple-voter-empty'>No votes received yet.</p>
              )}
            </>
          ) : (
            <p className='simple-voter-empty'>
              No live vote has been broadcast yet.
            </p>
          )}
        </SimpleCollapsibleSection>
      </section>
    </main>
  );
}

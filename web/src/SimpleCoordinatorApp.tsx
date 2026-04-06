import { useEffect, useMemo, useRef, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec } from "./nostrIdentity";
import { deriveActorDisplayId } from "./actorDisplay";
import {
  subscribeSimpleCoordinatorFollowers,
  subscribeSimpleDmAcknowledgements,
  subscribeSimpleCoordinatorShareAssignments,
  subscribeSimpleShardRequests,
  subscribeSimpleSubCoordinatorApplications,
  sendSimpleCoordinatorRoster,
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
  SIMPLE_PUBLIC_RELAYS,
  type SimpleLiveVoteSession,
  type SimpleSubmittedVote,
} from "./simpleVotingSession";
import {
  validateSimpleSubmittedVotes,
  type SimpleValidatedVote,
} from "./simpleVoteValidation";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import SimpleQrScanner from "./SimpleQrScanner";
import SimpleRelayPanel from "./SimpleRelayPanel";
import SimpleUnlockGate from "./SimpleUnlockGate";
import TokenFingerprint from "./TokenFingerprint";
import { extractNpubFromScan } from "./npubScan";
import {
  primeNip65RelayHints,
  setNip65EnabledForSession,
} from "./nip65RelayHints";
import { formatRoundOptionLabel } from "./roundLabel";
import {
  fetchLatestSimpleBlindKeyAnnouncement,
  generateSimpleBlindKeyPair,
  publishSimpleBlindKeyAnnouncement,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindPrivateKey,
} from "./simpleShardCertificate";
import {
  downloadSimpleActorBackup,
  clearSimpleActorState,
  isSimpleActorStateLocked,
  loadSimpleActorState,
  loadSimpleActorStateWithOptions,
  parseEncryptedSimpleActorBackupBundle,
  parseSimpleActorBackupBundle,
  saveSimpleActorState,
  SimpleActorStateLockedError,
  type SimpleActorKeypair,
} from "./simpleLocalState";
import {
  buildCoordinatorFollowerRowsRust,
  mergeSimpleFollowersRust,
} from "./wasm/auditableVotingCore";

type CoordinatorTab = "configure" | "voting" | "settings";

type SimpleCoordinatorKeypair = {
  npub: string;
  nsec: string;
};

type SimpleCoordinatorCache = {
  leadCoordinatorNpub: string;
  nip65Enabled: boolean;
  followers: SimpleCoordinatorFollower[];
  subCoordinators: SimpleSubCoordinatorApplication[];
  ticketDeliveries: Record<
    string,
    { status: string; eventId?: string; responseId?: string; attempts?: number; lastAttemptAt?: string }
  >;
  autoSendFollowers: Record<string, boolean>;
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

function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

function deliveryToneClass(tone: string) {
  return tone === "error"
    ? "simple-delivery-error"
    : tone === "ok"
      ? "simple-delivery-ok"
      : "simple-delivery-waiting";
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
  const [storagePassphrase, setStoragePassphrase] = useState("");
  const [storageLocked, setStorageLocked] = useState(false);
  const [storageStatus, setStorageStatus] = useState<string | null>(null);
  const [leadCoordinatorNpub, setLeadCoordinatorNpub] = useState("");
  const [nip65Enabled, setNip65Enabled] = useState(false);
  const [leadScannerActive, setLeadScannerActive] = useState(false);
  const [leadScannerStatus, setLeadScannerStatus] = useState<string | null>(null);
  const [followers, setFollowers] = useState<SimpleCoordinatorFollower[]>([]);
  const [subCoordinators, setSubCoordinators] = useState<SimpleSubCoordinatorApplication[]>([]);
  const [ticketDeliveries, setTicketDeliveries] = useState<Record<string, { status: string; eventId?: string; responseId?: string; attempts?: number; lastAttemptAt?: string }>>({});
  const [autoSendFollowers, setAutoSendFollowers] = useState<Record<string, boolean>>({});
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
  const [validatedVotes, setValidatedVotes] = useState<SimpleValidatedVote[]>([]);
  const [activeTab, setActiveTab] = useState<CoordinatorTab>("configure");
  const blindKeyRepublishAtRef = useRef<Record<string, number>>({});
  const autoSendInFlightRef = useRef<Set<string>>(new Set());
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
  const sentFollowAckStateRef = useRef<Record<string, string>>({});
  const sentRosterStateRef = useRef<Record<string, string>>({});
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
          setNip65Enabled(cache?.nip65Enabled === true);
          setFollowers(Array.isArray(cache.followers) ? cache.followers : []);
          setSubCoordinators(Array.isArray(cache.subCoordinators) ? cache.subCoordinators : []);
          setTicketDeliveries(cache.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {});
          setAutoSendFollowers(
            cache.autoSendFollowers && typeof cache.autoSendFollowers === "object"
              ? cache.autoSendFollowers
              : {},
          );
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
        setStorageLocked(false);
        setIdentityReady(true);
        return;
      }

      const nextKeypair = createSimpleCoordinatorKeypair();
      void saveSimpleActorState({
        role: "coordinator",
        keypair: nextKeypair,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      setKeypair(nextKeypair);
      setStorageLocked(false);
      setIdentityReady(true);
    }).catch(async (error) => {
      if (cancelled) {
        return;
      }

      if (error instanceof SimpleActorStateLockedError || await isSimpleActorStateLocked("coordinator")) {
        setStorageLocked(true);
        setStorageStatus("Local coordinator state is locked.");
        return;
      }

      const nextKeypair = createSimpleCoordinatorKeypair();
      setKeypair(nextKeypair);
      setStorageLocked(false);
      setIdentityReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setNip65EnabledForSession(nip65Enabled);
  }, [nip65Enabled]);

  useEffect(() => {
    if (!identityReady || !keypair) {
      return;
    }

    const cache: SimpleCoordinatorCache = {
      leadCoordinatorNpub,
      nip65Enabled,
      followers,
      subCoordinators,
      ticketDeliveries,
      autoSendFollowers,
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
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
  }, [
    assignmentStatus,
    autoSendFollowers,
    followers,
    identityReady,
    keypair,
    leadCoordinatorNpub,
    nip65Enabled,
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
    storagePassphrase,
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
        setFollowers((current) => mergeSimpleFollowersRust(current, nextFollowers));
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
          ackedAction: "simple_share_assignment",
          ackedEventId: latestAssignment.dmEventId,
        }).catch(() => {
          sentAssignmentAckIdsRef.current.delete(latestAssignment.dmEventId);
        });
      },
    });
  }, [coordinatorId, isLeadCoordinator, keypair?.nsec, keypair?.npub, leadCoordinatorNpub]);

  useEffect(() => {
    const npub = keypair?.npub ?? "";

    if (!npub) {
      setCoordinatorId("pending");
      return;
    }

    setCoordinatorId(deriveActorDisplayId(npub));
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

    let cancelled = false;
    void publishBlindKeyForRound({
      votingId: activeRound.votingId,
      blindPrivateKey,
    }).catch(() => {
      if (!cancelled) {
        setPublishStatus("Blind signing key announcement failed.");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [keypair?.npub, keypair?.nsec, publishedVotes, roundBlindKeyAnnouncements, roundBlindPrivateKeys, selectedPublishedVote]);

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

    const coordinatorRoster = isLeadCoordinator
      ? sortCoordinatorRoster([
          coordinatorNpub,
          ...subCoordinators.map((application) => application.coordinatorNpub),
        ])
      : [];

    for (const follower of followers) {
      if (!follower.dmEventId) {
        continue;
      }

      const rosterSignature = isLeadCoordinator
        ? `follow:${coordinatorRoster.join("|")}`
        : "follow";
      if (sentFollowAckStateRef.current[follower.dmEventId] === rosterSignature) {
        continue;
      }

      sentFollowAckStateRef.current[follower.dmEventId] = rosterSignature;
      void sendSimpleDmAcknowledgement({
        senderSecretKey: coordinatorSecretKey,
        recipientNpub: follower.voterNpub,
        actorNpub: coordinatorNpub,
        ackedAction: "simple_coordinator_follow",
        ackedEventId: follower.dmEventId,
        coordinatorNpubs: isLeadCoordinator ? coordinatorRoster : undefined,
        votingId: follower.votingId,
      }).catch(() => {
        delete sentFollowAckStateRef.current[follower.dmEventId];
      });
    }
  }, [followers, isLeadCoordinator, keypair?.nsec, keypair?.npub, subCoordinators]);

  useEffect(() => {
    const coordinatorSecretKey = decodeNsec(keypair?.nsec ?? "");
    const coordinatorNpub = keypair?.npub ?? "";

    if (!isLeadCoordinator || !coordinatorSecretKey || !coordinatorNpub || followers.length === 0) {
      return;
    }

    const coordinatorRoster = sortCoordinatorRoster([
      coordinatorNpub,
      ...subCoordinators.map((application) => application.coordinatorNpub),
    ]);
    const rosterSignature = coordinatorRoster.join("|");

    for (const follower of followers) {
      if (sentRosterStateRef.current[follower.voterNpub] === rosterSignature) {
        continue;
      }

      sentRosterStateRef.current[follower.voterNpub] = rosterSignature;
      void sendSimpleCoordinatorRoster({
        leadCoordinatorSecretKey: coordinatorSecretKey,
        recipientNpub: follower.voterNpub,
        leadCoordinatorNpub: coordinatorNpub,
        coordinatorNpubs: coordinatorRoster,
      }).catch(() => {
        delete sentRosterStateRef.current[follower.voterNpub];
      });
    }
  }, [followers, isLeadCoordinator, keypair?.nsec, keypair?.npub, subCoordinators]);

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
        recipientNpub: request.replyNpub,
        actorNpub: coordinatorNpub,
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
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setKeypair(nextKeypair);
    setIdentityStatus(null);
    setBackupStatus(null);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketDeliveries({});
    setAutoSendFollowers({});
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
    setActiveTab("configure");
    sentFollowAckStateRef.current = {};
    sentRosterStateRef.current = {};
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
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setKeypair(nextKeypair);
    setIdentityStatus("Identity restored from nsec.");
    setBackupStatus(null);
    setLeadCoordinatorNpub("");
    setFollowers([]);
    setSubCoordinators([]);
    setTicketDeliveries({});
    setAutoSendFollowers({});
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
    setActiveTab("configure");
    sentFollowAckStateRef.current = {};
    sentRosterStateRef.current = {};
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
      nip65Enabled,
      followers,
      subCoordinators,
      ticketDeliveries,
      autoSendFollowers,
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
      }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
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
      setNip65Enabled(cache?.nip65Enabled === true);
      setFollowers(Array.isArray(cache?.followers) ? cache.followers : []);
      setSubCoordinators(Array.isArray(cache?.subCoordinators) ? cache.subCoordinators : []);
      setTicketDeliveries(
        cache?.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {},
      );
      setAutoSendFollowers(
        cache?.autoSendFollowers && typeof cache.autoSendFollowers === "object"
          ? cache.autoSendFollowers
          : {},
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
      setActiveTab("configure");
      sentFollowAckStateRef.current = {};
      sentRosterStateRef.current = {};
      sentRequestAckIdsRef.current.clear();
      sentSubCoordinatorAckIdsRef.current.clear();
      sentAssignmentAckIdsRef.current.clear();
    } catch {
      setBackupStatus("Backup restore failed.");
    }
  }

  async function unlockLocalState(passphrase: string) {
    const trimmed = passphrase.trim();
    if (!trimmed) {
      setStorageStatus("Enter the passphrase.");
      return;
    }

    try {
      const storedState = await loadSimpleActorStateWithOptions("coordinator", { passphrase: trimmed });
      if (!storedState?.keypair) {
        setStorageStatus("No coordinator state was found.");
        return;
      }

      const cache = (storedState.cache ?? null) as Partial<SimpleCoordinatorCache> | null;
      const fallbackCoordinatorNpubs = sortCoordinatorRoster(
        Array.isArray(cache?.subCoordinators)
          ? cache.subCoordinators.flatMap((application) => (
            application && typeof application.coordinatorNpub === "string"
              ? [application.coordinatorNpub]
              : []
          ))
          : [],
      );
      setStoragePassphrase(trimmed);
      setKeypair(storedState.keypair);
      setLeadCoordinatorNpub(typeof cache?.leadCoordinatorNpub === "string" ? cache.leadCoordinatorNpub : "");
      setFollowers(Array.isArray(cache?.followers) ? cache.followers : []);
      setSubCoordinators(Array.isArray(cache?.subCoordinators) ? cache.subCoordinators : []);
      setTicketDeliveries(cache?.ticketDeliveries && typeof cache.ticketDeliveries === "object" ? cache.ticketDeliveries : {});
      setAutoSendFollowers(
        cache?.autoSendFollowers && typeof cache.autoSendFollowers === "object"
          ? cache.autoSendFollowers
          : {},
      );
      setPendingRequests(Array.isArray(cache?.pendingRequests) ? cache.pendingRequests : []);
      setRegistrationStatus(typeof cache?.registrationStatus === "string" ? cache.registrationStatus : null);
      setAssignmentStatus(typeof cache?.assignmentStatus === "string" ? cache.assignmentStatus : null);
      setQuestionPrompt(typeof cache?.questionPrompt === "string" ? cache.questionPrompt : "Should the proposal pass?");
      setQuestionThresholdT(typeof cache?.questionThresholdT === "string" ? cache.questionThresholdT : "1");
      setQuestionThresholdN(typeof cache?.questionThresholdN === "string" ? cache.questionThresholdN : "1");
      setQuestionShareIndex(typeof cache?.questionShareIndex === "string" ? cache.questionShareIndex : "1");
      setRoundBlindPrivateKeys(cache?.roundBlindPrivateKeys && typeof cache.roundBlindPrivateKeys === "object" ? cache.roundBlindPrivateKeys as Record<string, SimpleBlindPrivateKey> : {});
      setRoundBlindKeyAnnouncements(cache?.roundBlindKeyAnnouncements && typeof cache.roundBlindKeyAnnouncements === "object" ? cache.roundBlindKeyAnnouncements as Record<string, SimpleBlindKeyAnnouncement> : {});
      setPublishStatus(typeof cache?.publishStatus === "string" ? cache.publishStatus : null);
      setPublishedVotes(
        Array.isArray(cache?.publishedVotes)
          ? cache.publishedVotes
            .map((vote) => normalizeLiveVoteSession(vote, fallbackCoordinatorNpubs))
            .filter((vote): vote is SimpleLiveVoteSession => vote !== null)
          : [],
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setSelectedSubmittedVotingId(typeof cache?.selectedSubmittedVotingId === "string" ? cache.selectedSubmittedVotingId : "");
      setSubmittedVotes(Array.isArray(cache?.submittedVotes) ? cache.submittedVotes : []);
      setActiveTab("configure");
      setStorageLocked(false);
      setStorageStatus("Local coordinator state unlocked.");
      setIdentityReady(true);
    } catch {
      setStorageStatus("Unlock failed.");
    }
  }

  async function protectLocalState(passphrase: string) {
    if (!passphrase.trim() || !keypair) {
      setStorageStatus("Enter a passphrase first.");
      return;
    }
    setStoragePassphrase(passphrase.trim());
    setStorageStatus("Local coordinator state will be stored encrypted.");
  }

  async function disableLocalStateProtection(currentPassphrase?: string) {
    if (!keypair) {
      return;
    }
    if (!storagePassphrase && !currentPassphrase?.trim()) {
      setStorageStatus("Enter the current passphrase to remove protection.");
      return;
    }
    setStoragePassphrase("");
    setStorageStatus("Local coordinator state protection removed.");
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

  async function publishBlindKeyForRound(input: {
    votingId: string;
    blindPrivateKey: SimpleBlindPrivateKey;
    force?: boolean;
  }) {
    const coordinatorNsec = keypair?.nsec ?? "";
    const coordinatorNpub = keypair?.npub ?? "";
    const activeRound =
      publishedVotes.find((vote) => vote.votingId === input.votingId) ?? null;

    if (
      !coordinatorNsec ||
      !coordinatorNpub ||
      !activeRound ||
      !activeRound.authorizedCoordinatorNpubs.includes(coordinatorNpub)
    ) {
      return null;
    }

    const existingAnnouncement = roundBlindKeyAnnouncements[input.votingId];
    const existingAnnouncementKeyId = existingAnnouncement?.publicKey?.keyId;
    if (!input.force && existingAnnouncementKeyId === input.blindPrivateKey.keyId) {
      return existingAnnouncement ?? null;
    }

    const result = await publishSimpleBlindKeyAnnouncement({
      coordinatorNsec,
      votingId: input.votingId,
      publicKey: input.blindPrivateKey,
    });

    const nextAnnouncement: SimpleBlindKeyAnnouncement = {
      coordinatorNpub,
      votingId: input.votingId,
      publicKey: input.blindPrivateKey,
      createdAt: result.createdAt,
      event: result.event,
    };

    setRoundBlindKeyAnnouncements((current) => ({
      ...current,
      [input.votingId]: nextAnnouncement,
    }));

    return nextAnnouncement;
  }

  async function republishActiveBlindKey() {
    if (!activeVotingId || !activeBlindPrivateKey) {
      return;
    }

    setPublishStatus("Republishing blind key...");

    try {
      const result = await publishBlindKeyForRound({
        votingId: activeVotingId,
        blindPrivateKey: activeBlindPrivateKey,
        force: true,
      });
      setPublishStatus(result ? "Blind key republished." : "Blind key republish failed.");
    } catch {
      setPublishStatus("Blind key republish failed.");
    }
  }

  async function ensureBlindKeyAnnouncementForRound(input: {
    votingId: string;
    blindPrivateKey: SimpleBlindPrivateKey;
    forceRepublish?: boolean;
  }) {
    const coordinatorNpub = keypair?.npub ?? "";
    if (!coordinatorNpub) {
      return null;
    }

    const existingAnnouncement = roundBlindKeyAnnouncements[input.votingId];
    if (existingAnnouncement && !input.forceRepublish) {
      return existingAnnouncement;
    }

    if (!input.forceRepublish) {
      try {
        const fetchedAnnouncement = await fetchLatestSimpleBlindKeyAnnouncement({
          coordinatorNpub,
          votingId: input.votingId,
        });
        if (fetchedAnnouncement) {
          setRoundBlindKeyAnnouncements((current) => ({
            ...current,
            [input.votingId]: fetchedAnnouncement,
          }));
          return fetchedAnnouncement;
        }
      } catch {
        // Fall through to republish with the local private key.
      }
    }

    return publishBlindKeyForRound({
      votingId: input.votingId,
      blindPrivateKey: input.blindPrivateKey,
      force: true,
    });
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
      || !matchingRequest
      || !coordinatorId
      || coordinatorId === "pending"
      || !votingId
      || !prompt
      || activeShareIndex <= 0
    ) {
      return;
    }

    const keyAnnouncement = await ensureBlindKeyAnnouncementForRound({
      votingId,
      blindPrivateKey: activeBlindPrivateKey,
    });
    if (!keyAnnouncement) {
      setTicketDeliveries((current) => ({
        ...current,
        [`${follower.voterNpub}:${votingId}`]: {
          status: "Blind key announcement unavailable.",
          attempts: (current[`${follower.voterNpub}:${votingId}`]?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
      }));
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
        keyAnnouncementEvent: keyAnnouncement.event,
        recipientNpub: matchingRequest.replyNpub,
        coordinatorNpub,
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
          attempts: (current[ticketStatusKey]?.attempts ?? 0) + 1,
          lastAttemptAt: new Date().toISOString(),
        },
      }));
    } catch {
      setTicketDeliveries((current) => ({
        ...current,
        [ticketStatusKey]: { status: "Ticket send failed." },
      }));
    }
  }

  async function resendRoundInfo(follower: SimpleCoordinatorFollower) {
    const coordinatorNsec = keypair?.nsec ?? "";
    const votingId = selectedPublishedVote?.votingId ?? "";
    const prompt = selectedPublishedVote?.prompt ?? "";

    if (!coordinatorNsec || !votingId || !prompt || !activeBlindPrivateKey) {
      return;
    }

    const followerId = deriveActorDisplayId(follower.voterNpub);
    setPublishStatus(`Resending round info for Voter ${followerId}...`);

    try {
      let announcementRepublished = false;

      if (isLeadCoordinator) {
        const result = await publishSimpleLiveVote({
          coordinatorNsec,
          prompt,
          votingId,
          thresholdT: selectedPublishedVote?.thresholdT,
          thresholdN: selectedPublishedVote?.thresholdN,
          authorizedCoordinatorNpubs: selectedPublishedVote?.authorizedCoordinatorNpubs,
        });
        announcementRepublished = result.successes > 0;
      }

      const keyAnnouncement = await ensureBlindKeyAnnouncementForRound({
        votingId,
        blindPrivateKey: activeBlindPrivateKey,
        forceRepublish: true,
      });

      if (keyAnnouncement && (announcementRepublished || !isLeadCoordinator)) {
        setPublishStatus(`Round info resent for Voter ${followerId}.`);
      } else {
        setPublishStatus(`Round info resend failed for Voter ${followerId}.`);
      }
    } catch {
      setPublishStatus(`Round info resend failed for Voter ${followerId}.`);
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
      setSelectedSubmittedVotingId(result.votingId);
      setPublishStatus(result.successes > 0 ? "Vote broadcast." : "Vote broadcast failed.");
    } catch {
      setPublishStatus("Vote broadcast failed.");
    }
  }

  function selectRound(votingId: string) {
    setSelectedVotingId(votingId);
  }

  function selectTab(nextTab: CoordinatorTab) {
    setActiveTab(nextTab);
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

    setRegistrationStatus("Notifying lead coordinator...");

    try {
      const result = await sendSimpleSubCoordinatorJoin({
        coordinatorSecretKey,
        leadCoordinatorNpub: nextLeadCoordinatorNpub,
        coordinatorNpub,
      });

      setRegistrationStatus(
        result.successes > 0
          ? "Lead coordinator notified. Waiting for share index assignment."
          : "Lead coordinator notification failed.",
      );
    } catch {
      setRegistrationStatus("Lead coordinator notification failed.");
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
  useEffect(() => {
    let cancelled = false;

    void validateSimpleSubmittedVotes(
      submittedVotes,
      requiredShardCount,
      selectedSubmittedVote?.authorizedCoordinatorNpubs ?? [],
    ).then((nextValidatedVotes) => {
      if (!cancelled) {
        setValidatedVotes(nextValidatedVotes);
      }
    }).catch(() => {
      if (!cancelled) {
        setValidatedVotes([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [requiredShardCount, selectedSubmittedVote?.authorizedCoordinatorNpubs, submittedVotes]);

  useEffect(() => {
    const knownFollowerNpubs = new Set(followers.map((follower) => follower.voterNpub));
    setAutoSendFollowers((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([voterNpub]) => {
          const keep = knownFollowerNpubs.has(voterNpub);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });
  }, [followers]);

  const validYesCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "Yes").length;
  const validNoCount = validatedVotes.filter((entry) => entry.valid && entry.vote.choice === "No").length;
  const yesValidatedVotes = validatedVotes.filter((entry) => entry.vote.choice === "Yes");
  const noValidatedVotes = validatedVotes.filter((entry) => entry.vote.choice === "No");
  const visibleFollowers = activeVotingId
    ? followers.filter((follower) => !follower.votingId || follower.votingId === activeVotingId)
    : followers;
  const canIssueTickets = Boolean(
    keypair?.nsec &&
    activeBlindPrivateKey &&
    (isLeadCoordinator || activeShareIndex > 0),
  );
  const coordinatorFollowerRows = useMemo(() => buildCoordinatorFollowerRowsRust({
    followers,
    selectedPublishedVotingId: selectedPublishedVote?.votingId ?? null,
    pendingRequests: pendingRequests.map((request) => ({
      voterNpub: request.voterNpub,
      votingId: request.votingId,
      createdAt: request.createdAt,
    })),
    ticketDeliveries,
    acknowledgements: dmAcknowledgements.map((ack) => ({
      actorNpub: ack.actorNpub,
      ackedAction: ack.ackedAction,
      ackedEventId: ack.ackedEventId,
    })),
    canIssueTickets,
  }), [
    canIssueTickets,
    dmAcknowledgements,
    followers,
    pendingRequests,
    selectedPublishedVote?.votingId,
    ticketDeliveries,
  ]);
  const visibleFollowersById = useMemo(
    () => new Map(visibleFollowers.map((follower) => [follower.id, follower])),
    [visibleFollowers],
  );
  const expectedSubCoordinatorCount = Math.max(0, (Number.parseInt(questionThresholdN, 10) || 1) - 1);

  useEffect(() => {
    if (!selectedPublishedVote || !activeBlindPrivateKey || !keypair?.npub) {
      return;
    }

    const waitingFollowerCount = visibleFollowers.filter((follower) => (
      !findLatestRoundRequest(pendingRequests, follower.voterNpub, selectedPublishedVote.votingId)
    )).length;

    if (waitingFollowerCount === 0 && activeBlindKeyAnnouncement) {
      return;
    }

    let cancelled = false;

    const refreshBlindKeyAnnouncement = () => {
      const now = Date.now();
      const lastRepublishAt = blindKeyRepublishAtRef.current[selectedPublishedVote.votingId] ?? 0;
      if (now - lastRepublishAt < 8000) {
        return;
      }

      blindKeyRepublishAtRef.current[selectedPublishedVote.votingId] = now;
      void ensureBlindKeyAnnouncementForRound({
        votingId: selectedPublishedVote.votingId,
        blindPrivateKey: activeBlindPrivateKey,
        forceRepublish: waitingFollowerCount > 0 || !activeBlindKeyAnnouncement,
      }).catch(() => {
        if (!cancelled) {
          setPublishStatus("Blind signing key announcement failed.");
        }
      });
    };

    refreshBlindKeyAnnouncement();
    const intervalId = window.setInterval(refreshBlindKeyAnnouncement, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeBlindKeyAnnouncement,
    activeBlindPrivateKey,
    keypair?.npub,
    pendingRequests,
    selectedPublishedVote,
    visibleFollowers,
  ]);

  useEffect(() => {
    const knownParticipants = sortCoordinatorRoster([
      leadCoordinatorNpub,
      ...followers.map((follower) => follower.voterNpub),
      ...subCoordinators.map((application) => application.coordinatorNpub),
    ]);
    if (knownParticipants.length === 0) {
      return;
    }

    void primeNip65RelayHints(knownParticipants, SIMPLE_PUBLIC_RELAYS);
  }, [followers, leadCoordinatorNpub, subCoordinators]);

  useEffect(() => {
    if (!activeVotingId) {
      return;
    }

    for (const follower of visibleFollowers) {
      if (!autoSendFollowers[follower.voterNpub]) {
        continue;
      }

      const ticketStatusKey = `${follower.voterNpub}:${activeVotingId}`;
      if (ticketDeliveries[ticketStatusKey]) {
        continue;
      }

      const row = coordinatorFollowerRows.find((entry) => entry.id === follower.id);
      if (!row?.canSendTicket || autoSendInFlightRef.current.has(ticketStatusKey)) {
        continue;
      }

      autoSendInFlightRef.current.add(ticketStatusKey);
      void sendTicket(follower).finally(() => {
        autoSendInFlightRef.current.delete(ticketStatusKey);
      });
    }
  }, [activeVotingId, autoSendFollowers, coordinatorFollowerRows, ticketDeliveries, visibleFollowers]);

  if (storageLocked && !identityReady) {
    return (
      <SimpleUnlockGate
        roleLabel="Coordinator"
        status={storageStatus}
        onUnlock={unlockLocalState}
        onReset={async () => {
          await clearSimpleActorState("coordinator");
          setStorageLocked(false);
          setStoragePassphrase("");
          const nextKeypair = createSimpleCoordinatorKeypair();
          await saveSimpleActorState({
            role: "coordinator",
            keypair: nextKeypair,
            updatedAt: new Date().toISOString(),
          });
          setKeypair(nextKeypair);
          setIdentityReady(true);
          setStorageStatus("Locked local coordinator state reset.");
        }}
      />
    );
  }

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
            New ID
          </button>
        </div>
        <div
          className='simple-voter-tabs'
          role='tablist'
          aria-label='Coordinator sections'
        >
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'configure'}
            className={`simple-voter-tab${activeTab === 'configure' ? ' is-active' : ''}`}
            onClick={() => selectTab('configure')}
          >
            Configure
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'voting'}
            className={`simple-voter-tab${activeTab === 'voting' ? ' is-active' : ''}`}
            onClick={() => selectTab('voting')}
          >
            Voting
          </button>
          <button
            type='button'
            role='tab'
            aria-selected={activeTab === 'settings'}
            className={`simple-voter-tab${activeTab === 'settings' ? ' is-active' : ''}`}
            onClick={() => selectTab('settings')}
          >
            Settings
          </button>
        </div>

        {activeTab === 'configure' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Configure'
          >
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
                    if (
                      nextLeadCoordinatorNpub.trim() !== (keypair?.npub ?? '')
                    ) {
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
                      ? 'Coordinator notified'
                      : 'Notify coordinator'}
                  </button>
                ) : null}
              </div>
              <SimpleQrScanner
                active={leadScannerActive}
                onDetected={handleLeadCoordinatorScanDetected}
                onClose={() => setLeadScannerActive(false)}
                prompt='Point the camera at the lead coordinator npub QR code.'
              />
              {leadScannerStatus ? (
                <p className='simple-voter-note'>{leadScannerStatus}</p>
              ) : null}
              <p className='simple-voter-question'>
                {isLeadCoordinator
                  ? 'This coordinator publishes the live question.'
                  : 'This coordinator follows the lead question and only issues shares.'}
              </p>
              {registrationStatus &&
                !isLeadCoordinator &&
                !hasAssignedShareIndex && (
                  <p className='simple-voter-note'>{registrationStatus}</p>
                )}
              {assignmentStatus && (
                <p className='simple-voter-note'>{assignmentStatus}</p>
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
                        <li
                          key={application.id}
                          className='simple-voter-list-item'
                        >
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
              {coordinatorFollowerRows.length > 0 ? (
                <ul className='simple-voter-list'>
                  {coordinatorFollowerRows.map((row) => {
                    const follower = visibleFollowersById.get(row.id);
                    if (!follower) {
                      return null;
                    }

                    const waitingForBlindedRequest = Boolean(
                      selectedPublishedVote &&
                      !findLatestRoundRequest(
                        pendingRequests,
                        follower.voterNpub,
                        selectedPublishedVote.votingId,
                      ),
                    );
                    const ticketStatusKey = selectedPublishedVote
                      ? `${follower.voterNpub}:${selectedPublishedVote.votingId}`
                      : '';
                    const ticketDelivery = ticketStatusKey
                      ? ticketDeliveries[ticketStatusKey]
                      : undefined;
                    const isTicketSending =
                      ticketDelivery?.status === 'Sending ticket...';

                    return (
                      <li key={row.id} className='simple-voter-list-item'>
                        <div className='simple-follower-row'>
                          <div className='simple-follower-row-main'>
                            <p className='simple-voter-question'>
                              {row.followingText}
                            </p>
                            <ul className='simple-delivery-diagnostics'>
                              <li
                                className={deliveryToneClass(row.follow.tone)}
                              >
                                {row.follow.text}
                              </li>
                              <li
                                className={deliveryToneClass(
                                  row.pendingRequest.tone,
                                )}
                              >
                                {row.pendingRequest.text}
                              </li>
                              <li
                                className={deliveryToneClass(row.ticket.tone)}
                              >
                                {row.ticket.text}
                              </li>
                              {row.receipt ? (
                                <li
                                  className={deliveryToneClass(
                                    row.receipt.tone,
                                  )}
                                >
                                  {row.receipt.text}
                                </li>
                              ) : null}
                            </ul>
                          </div>
                          <div className='simple-follower-row-controls'>
                            <label className='simple-follower-auto-send'>
                              <input
                                type='checkbox'
                                checked={Boolean(
                                  autoSendFollowers[follower.voterNpub],
                                )}
                                onChange={(event) => {
                                  setAutoSendFollowers((current) => ({
                                    ...current,
                                    [follower.voterNpub]: event.target.checked,
                                  }));
                                }}
                              />
                              <span>Verified</span>
                            </label>
                            {selectedPublishedVote ? (
                              <button
                                type='button'
                                className='simple-voter-secondary'
                                onClick={() => void sendTicket(follower)}
                                disabled={!row.canSendTicket || isTicketSending}
                              >
                                Resend on fail
                              </button>
                            ) : null}
                            {waitingForBlindedRequest ? (
                              <button
                                type='button'
                                className='simple-voter-secondary'
                                onClick={() => void resendRoundInfo(follower)}
                                disabled={!activeBlindPrivateKey}
                              >
                                Resend round info
                              </button>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className='simple-voter-empty'>
                  No voters are following this coordinator yet.
                </p>
              )}
            </SimpleCollapsibleSection>
          </section>
        ) : null}

        {activeTab === 'voting' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Voting'
          >
            <SimpleCollapsibleSection title='Threshold'>
              {isLeadCoordinator ? (
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
                      T = {questionThresholdT}, capped to 1-{maxThresholdT}. N
                      is fixed at {questionThresholdN}.
                    </p>
                  </div>
                </div>
              ) : (
                <p className='simple-voter-question'>
                  Threshold:{' '}
                  {activeThresholdT && activeThresholdN
                    ? `${activeThresholdT} of ${activeThresholdN}`
                    : getThresholdLabel()}
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
                <p className='simple-voter-question'>
                  {selectedPublishedVote.prompt}
                </p>
              ) : (
                <p className='simple-voter-empty'>No question selected yet.</p>
              )}
            </SimpleCollapsibleSection>

            <SimpleCollapsibleSection title='Round'>
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
                        {formatRoundOptionLabel(vote)}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <p className='simple-voter-empty'>
                  No live vote has been broadcast yet.
                </p>
              )}
              {isLeadCoordinator ? (
                <div className='simple-voter-action-row simple-voter-action-row-inline'>
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void distributeShareIndexes()}
                    disabled={!keypair?.nsec || subCoordinators.length === 0}
                  >
                    Distribute share indexes
                  </button>
                  <button
                    type='button'
                    className='simple-voter-secondary'
                    onClick={() => void republishActiveBlindKey()}
                    disabled={!activeVotingId || !activeBlindPrivateKey}
                  >
                    Republish blind key
                  </button>
                </div>
              ) : (
                <div className='simple-vote-threshold-grid'>
                  <div>
                    <label
                      className='simple-voter-label'
                      htmlFor='simple-share-index'
                    >
                      Share index
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
              )}
              <p className='simple-voter-question'>
                Threshold:{' '}
                {activeThresholdT && activeThresholdN
                  ? `${activeThresholdT} of ${activeThresholdN}`
                  : getThresholdLabel()}
              </p>
              {publishStatus ? (
                <p className='simple-voter-note'>{publishStatus}</p>
              ) : null}
              {selectedPublishedVote ? (
                <>
                  <p className='simple-voter-question'>
                    Live prompt: {selectedPublishedVote.prompt}
                  </p>
                  <p className='simple-voter-question'>
                    Question source:{' '}
                    {selectedPublishedVote.coordinatorNpub ===
                    (keypair?.npub ?? '')
                      ? 'This coordinator'
                      : 'Lead coordinator'}
                  </p>
                  <p className='simple-voter-question'>
                    This coordinator share index:{' '}
                    {activeShareIndex || 'Awaiting assignment'}
                  </p>
                </>
              ) : null}
            </SimpleCollapsibleSection>

            <SimpleCollapsibleSection title='Submitted votes'>
              {selectedSubmittedVote ? (
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
                        {formatRoundOptionLabel(vote)}
                      </option>
                    ))}
                  </select>
                  <p className='simple-submitted-score'>
                    Yes: {validYesCount} | No: {validNoCount}
                  </p>
                  <div className='simple-submitted-columns'>
                    <section className='simple-submitted-column'>
                      <h3 className='simple-submitted-column-title'>Yes</h3>
                      {yesValidatedVotes.length > 0 ? (
                        <ul className='simple-submitted-vote-list'>
                          {yesValidatedVotes.map(({ vote, valid, reason }, index) => (
                            <li key={vote.eventId} className='simple-submitted-vote-item'>
                              <div className='simple-vote-entry'>
                                <div className='simple-vote-entry-copy'>
                                  <p className='simple-voter-question simple-vote-result-line'>
                                    <span>Vote {index + 1}</span>{' '}
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
                                {vote.tokenId ? (
                                  <TokenFingerprint
                                    tokenId={vote.tokenId}
                                    large
                                    hideMetadata
                                  />
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                    <section className='simple-submitted-column'>
                      <h3 className='simple-submitted-column-title'>No</h3>
                      {noValidatedVotes.length > 0 ? (
                        <ul className='simple-submitted-vote-list'>
                          {noValidatedVotes.map(({ vote, valid, reason }, index) => (
                            <li key={vote.eventId} className='simple-submitted-vote-item'>
                              <div className='simple-vote-entry'>
                                <div className='simple-vote-entry-copy'>
                                  <p className='simple-voter-question simple-vote-result-line'>
                                    <span>Vote {index + 1}</span>{' '}
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
                                {vote.tokenId ? (
                                  <TokenFingerprint
                                    tokenId={vote.tokenId}
                                    large
                                    hideMetadata
                                  />
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </section>
                  </div>
                </>
              ) : (
                <p className='simple-voter-empty'>
                  No live vote has been broadcast yet.
                </p>
              )}
            </SimpleCollapsibleSection>
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Settings'
          >
            <SimpleIdentityPanel
              npub={keypair?.npub ?? ''}
              nsec={keypair?.nsec ?? ''}
              title='Identity'
              onRestoreNsec={restoreIdentity}
              restoreMessage={identityStatus}
              onDownloadBackup={identityReady ? downloadBackup : undefined}
              onRestoreBackupFile={restoreBackup}
              backupMessage={backupStatus}
              onProtectLocalState={
                identityReady ? protectLocalState : undefined
              }
              onDisableLocalStateProtection={
                identityReady ? disableLocalStateProtection : undefined
              }
              localStateProtected={Boolean(storagePassphrase)}
              localStateMessage={storageStatus}
            />
            <section
              className='simple-settings-card'
              aria-label='Relay hint settings'
            >
              <h3 className='simple-voter-question'>Relay hints</h3>
              <label className='simple-settings-toggle'>
                <input
                  type='checkbox'
                  checked={nip65Enabled}
                  onChange={(event) => setNip65Enabled(event.target.checked)}
                />
                <span>Enable NIP-65 relay hints</span>
              </label>
              <p className='simple-voter-note'>
                Disabled by default. Turn this on only if you want to publish
                and use NIP-65 inbox/outbox relay hints.
              </p>
            </section>
            <SimpleRelayPanel />
          </section>
        ) : null}
      </section>
    </main>
  );
}

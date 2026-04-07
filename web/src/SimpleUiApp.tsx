import { useEffect, useMemo, useRef, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec } from "./nostrIdentity";
import { deriveActorDisplayId } from "./actorDisplay";
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
  deriveTokenIdFromSimplePublicShardProofs,
  createSimpleBlindIssuanceRequest,
  fetchLatestSimpleBlindKeyAnnouncement,
  parseSimpleShardCertificate,
  subscribeLatestSimpleBlindKeyAnnouncement,
  unblindSimpleBlindShare,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindRequestSecret,
} from "./simpleShardCertificate";
import {
  subscribeSimpleCoordinatorRosterAnnouncements,
  fetchSimpleShardResponses,
  sendSimpleCoordinatorFollow,
  sendSimpleDmAcknowledgement,
  sendSimpleShardRequest,
  subscribeSimpleDmAcknowledgements,
  subscribeSimpleShardResponses,
  type SimpleDmAcknowledgement,
  type SimpleShardRequest,
  type SimpleShardResponse,
} from "./simpleShardDm";
import {
  publishSimpleSubmittedVote,
  SIMPLE_PUBLIC_RELAYS,
  subscribeLatestSimpleLiveVote,
  type SimpleLiveVoteSession,
} from "./simpleVotingSession";
import { buildSimpleVoteTicketRows } from "./simpleRoundState";
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
  buildVoterCoordinatorDiagnosticsRust,
  normalizeCoordinatorNpubsRust,
  selectFollowRetryTargetsRust,
  selectRequestRetryKeysRust,
} from "./wasm/auditableVotingCore";
import {
  ProtocolStateService,
  SIMPLE_PUBLIC_ELECTION_ID,
  type ProtocolStateCache,
} from "./services/ProtocolStateService";

type LiveVoteChoice = "Yes" | "No" | null;
type VoterTab = "configure" | "vote" | "settings";

type SimpleVoterKeypair = {
  nsec: string;
  npub: string;
};

type PendingBlindRequest = {
  coordinatorNpub: string;
  votingId: string;
  replyNpub: string;
  request: SimpleShardRequest["blindRequest"];
  secret: SimpleBlindRequestSecret;
  createdAt: string;
  dmEventId?: string;
};

type RoundReplyKeypair = {
  npub: string;
  nsec: string;
};

type SimpleVoterCache = {
  manualCoordinators: string[];
  nip65Enabled: boolean;
  protocolStateCache?: ProtocolStateCache | null;
  requestStatus: string | null;
  receivedShards: SimpleShardResponse[];
  pendingBlindRequests: Record<string, PendingBlindRequest>;
  roundReplyKeypairs: Record<string, RoundReplyKeypair>;
  followDeliveries: Record<string, { status: string; eventId?: string; attempts?: number; lastAttemptAt?: string }>;
  requestDeliveries: Record<string, { status: string; eventId?: string; requestId?: string; attempts?: number; lastAttemptAt?: string }>;
  submitStatus: string | null;
  selectedVotingId: string;
  liveVoteChoice: LiveVoteChoice;
};

function createEmptyVoterCache(): SimpleVoterCache {
  return {
    manualCoordinators: [],
    nip65Enabled: false,
    protocolStateCache: null,
    requestStatus: null,
    receivedShards: [],
    pendingBlindRequests: {},
    roundReplyKeypairs: {},
    followDeliveries: {},
    requestDeliveries: {},
    submitStatus: null,
    selectedVotingId: "",
    liveVoteChoice: null,
  };
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

function equalReceivedShards(
  left: SimpleShardResponse[],
  right: SimpleShardResponse[],
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => {
    const next = right[index];
    return (
      value.id === next?.id
      && value.requestId === next?.requestId
      && value.coordinatorNpub === next?.coordinatorNpub
      && Boolean(value.shardCertificate) === Boolean(next?.shardCertificate)
    );
  });
}

function createRoundTokenMessage(votingId: string) {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${votingId}:${randomPart}`;
}

function makeRoundBlindKeyId(coordinatorNpub: string, votingId: string) {
  return `${coordinatorNpub}:${votingId}`;
}

function formatMissingCoordinatorKeyText(indices: number[]) {
  if (indices.length === 0) {
    return 'Waiting for a coordinator key before preparing ticket request.';
  }
  if (indices.length === 1) {
    return `Waiting for Coordinator ${indices[0]}'s key before preparing ticket request.`;
  }
  if (indices.length === 2) {
    return `Waiting for Coordinators ${indices[0]} and ${indices[1]}' keys before preparing ticket request.`;
  }

  const leading = indices.slice(0, -1).join(', ');
  const trailing = indices[indices.length - 1];
  return `Waiting for Coordinators ${leading}, and ${trailing}' keys before preparing ticket request.`;
}

export default function SimpleUiApp() {
  const [voterKeypair, setVoterKeypair] = useState<SimpleVoterKeypair | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [voterId, setVoterId] = useState<string>("pending");
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([]);
  const [nip65Enabled, setNip65Enabled] = useState(false);
  const [coordinatorDraft, setCoordinatorDraft] = useState("");
  const [coordinatorScannerActive, setCoordinatorScannerActive] = useState(false);
  const [coordinatorScannerStatus, setCoordinatorScannerStatus] = useState<string | null>(null);
  const [liveVoteChoice, setLiveVoteChoice] = useState<LiveVoteChoice>(null);
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const [identityStatus, setIdentityStatus] = useState<string | null>(null);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [storagePassphrase, setStoragePassphrase] = useState("");
  const [storageLocked, setStorageLocked] = useState(false);
  const [storageStatus, setStorageStatus] = useState<string | null>(null);
  const [receivedShards, setReceivedShards] = useState<SimpleShardResponse[]>([]);
  const [pendingBlindRequests, setPendingBlindRequests] = useState<Record<string, PendingBlindRequest>>({});
  const [roundReplyKeypairs, setRoundReplyKeypairs] = useState<Record<string, RoundReplyKeypair>>({});
  const [followDeliveries, setFollowDeliveries] = useState<Record<string, { status: string; eventId?: string; attempts?: number; lastAttemptAt?: string }>>({});
  const [requestDeliveries, setRequestDeliveries] = useState<Record<string, { status: string; eventId?: string; requestId?: string; attempts?: number; lastAttemptAt?: string }>>({});
  const [dmAcknowledgements, setDmAcknowledgements] = useState<SimpleDmAcknowledgement[]>([]);
  const [discoveredSessions, setDiscoveredSessions] = useState<SimpleLiveVoteSession[]>([]);
  const [protocolStateCache, setProtocolStateCache] = useState<ProtocolStateCache | null>(null);
  const [derivedPublicRounds, setDerivedPublicRounds] = useState<SimpleLiveVoteSession[]>([]);
  const [knownBlindKeys, setKnownBlindKeys] = useState<Record<string, SimpleBlindKeyAnnouncement>>({});
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const [activeTab, setActiveTab] = useState<VoterTab>("configure");
  const [showVoteDetails, setShowVoteDetails] = useState(false);
  const sentTicketReceiptAckIdsRef = useRef<Set<string>>(new Set());
  const lastAutoSelectedVotingIdRef = useRef("");
  const manualRoundSelectionRef = useRef(false);
  const protocolStateServiceRef = useRef<ProtocolStateService | null>(null);

  function persistVoterIdentity(nextKeypair: SimpleVoterKeypair, cache?: Partial<SimpleVoterCache>) {
    return saveSimpleActorState({
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
      cache,
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
  }

  async function reconcileIncomingShardResponses(nextResponses: SimpleShardResponse[]) {
    const nextIssuedShares = (await Promise.all(nextResponses.map(async (response) => {
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
        const shardCertificate = await unblindSimpleBlindShare({
          response: response.blindShareResponse,
          secret: pending.secret,
        });
        return [{ ...response, shardCertificate }];
      } catch {
        return [];
      }
    }))).flat();

    setReceivedShards((current) => {
      const merged = new Map(current.map((response) => [response.id, response]));
      for (const response of nextIssuedShares) {
        merged.set(response.id, response);
      }

      const nextMergedShares = [...merged.values()];
      return equalReceivedShards(current, nextMergedShares) ? current : nextMergedShares;
    });
  }

  const configuredCoordinatorTargets = useMemo(
    () => normalizeCoordinatorNpubsRust(manualCoordinators),
    [manualCoordinators],
  );
  const knownRoundVotingIds = useMemo(() => {
    const values = new Set<string>();

    for (const session of discoveredSessions) {
      values.add(session.votingId);
    }

    for (const request of Object.values(pendingBlindRequests)) {
      values.add(request.votingId);
    }

    for (const response of receivedShards) {
      const votingId = response.shardCertificate?.votingId;
      if (votingId) {
        values.add(votingId);
      }
    }

    return [...values];
  }, [discoveredSessions, pendingBlindRequests, receivedShards]);

  useEffect(() => {
    const receivedRequestIds = new Set(receivedShards.map((response) => response.requestId));
    if (receivedRequestIds.size === 0) {
      return;
    }

    setPendingBlindRequests((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([, requestEntry]) => {
          const keep = !receivedRequestIds.has(requestEntry.request.requestId);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setRequestDeliveries((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([, delivery]) => {
          const keep = !delivery.requestId || !receivedRequestIds.has(delivery.requestId);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });
  }, [receivedShards]);

  useEffect(() => {
    const pendingKeys = new Set(Object.keys(pendingBlindRequests));
    const activeRoundIds = new Set(knownRoundVotingIds);

    setRequestDeliveries((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => {
          const keep = pendingKeys.has(key);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setRoundReplyKeypairs((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([votingId]) => {
          const keep = activeRoundIds.has(votingId) || votingId === selectedVotingId;
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setKnownBlindKeys((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([key, announcement]) => {
          const keep = activeRoundIds.has(announcement.votingId) || announcement.votingId === selectedVotingId;
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });

    setFollowDeliveries((current) => {
      let changed = false;
      const next = Object.fromEntries(
        Object.entries(current).filter(([coordinatorNpub]) => {
          const keep = configuredCoordinatorTargets.includes(coordinatorNpub);
          if (!keep) {
            changed = true;
          }
          return keep;
        }),
      );
      return changed ? next : current;
    });
  }, [configuredCoordinatorTargets, knownRoundVotingIds, pendingBlindRequests, selectedVotingId]);

  useEffect(() => {
    let cancelled = false;

    void loadSimpleActorState("voter").then((storedState) => {
      if (cancelled) {
        return;
      }

      if (storedState?.keypair) {
        setVoterKeypair(storedState.keypair);
        const cache = (storedState.cache ?? null) as Partial<SimpleVoterCache> | null;
        setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? cache.manualCoordinators : []);
        setNip65Enabled(cache?.nip65Enabled === true);
        setProtocolStateCache(
          cache?.protocolStateCache && typeof cache.protocolStateCache === "object"
            ? cache.protocolStateCache as ProtocolStateCache
            : null,
        );
        setRequestStatus(typeof cache?.requestStatus === "string" ? cache.requestStatus : null);
        setReceivedShards(Array.isArray(cache?.receivedShards) ? cache.receivedShards : []);
        setPendingBlindRequests(
          cache?.pendingBlindRequests && typeof cache.pendingBlindRequests === "object"
            ? cache.pendingBlindRequests
            : {},
        );
        setRoundReplyKeypairs(
          cache?.roundReplyKeypairs && typeof cache.roundReplyKeypairs === "object"
            ? cache.roundReplyKeypairs
            : {},
        );
        setFollowDeliveries(
          cache?.followDeliveries && typeof cache.followDeliveries === "object"
            ? cache.followDeliveries
            : {},
        );
        setRequestDeliveries(
          cache?.requestDeliveries && typeof cache.requestDeliveries === "object"
            ? cache.requestDeliveries
            : {},
        );
        setSubmitStatus(typeof cache?.submitStatus === "string" ? cache.submitStatus : null);
        setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
        setLiveVoteChoice(cache?.liveVoteChoice === "Yes" || cache?.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
        setStorageLocked(false);
        setIdentityReady(true);
        return;
      }

      const nextKeypair = createSimpleVoterKeypair();
      void saveSimpleActorState({
        role: "voter",
        keypair: nextKeypair,
        updatedAt: new Date().toISOString(),
      }).catch(() => undefined);
      setVoterKeypair(nextKeypair);
      setStorageLocked(false);
      setIdentityReady(true);
    }).catch(async (error) => {
      if (cancelled) {
        return;
      }

      if (error instanceof SimpleActorStateLockedError || await isSimpleActorStateLocked("voter")) {
        setStorageLocked(true);
        setStorageStatus("Local voter state is locked.");
        return;
      }

      const nextKeypair = createSimpleVoterKeypair();
      setVoterKeypair(nextKeypair);
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
    if (!identityReady || !voterKeypair) {
      return;
    }

    const cache: SimpleVoterCache = {
      manualCoordinators,
      nip65Enabled,
      protocolStateCache,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      roundReplyKeypairs,
      followDeliveries,
      requestDeliveries,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
    };

    void saveSimpleActorState({
      role: "voter",
      keypair: voterKeypair,
      updatedAt: new Date().toISOString(),
      cache,
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
  }, [
    identityReady,
    liveVoteChoice,
    manualCoordinators,
    nip65Enabled,
    protocolStateCache,
    followDeliveries,
    pendingBlindRequests,
    roundReplyKeypairs,
    receivedShards,
    requestStatus,
    requestDeliveries,
    selectedVotingId,
    storagePassphrase,
    submitStatus,
    voterKeypair,
  ]);

  useEffect(() => {
    const actorNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!actorNsec) {
      setDmAcknowledgements([]);
      return;
    }

    setDmAcknowledgements([]);

    return subscribeSimpleDmAcknowledgements({
      actorNsec,
      actorNsecs: Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec),
      onAcknowledgements: (nextAcknowledgements) => {
        setDmAcknowledgements(nextAcknowledgements);
      },
    });
  }, [roundReplyKeypairs, voterKeypair?.nsec]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec) {
      return;
    }

    return subscribeSimpleCoordinatorRosterAnnouncements({
      voterNsec,
      onAnnouncements: (announcements) => {
        const discoveredCoordinatorNpubs = normalizeCoordinatorNpubsRust(
          announcements.flatMap((announcement) => announcement.coordinatorNpubs),
        );

        if (discoveredCoordinatorNpubs.length === 0) {
          return;
        }

        setManualCoordinators((current) => {
          const next = normalizeCoordinatorNpubsRust([
            ...current,
            ...discoveredCoordinatorNpubs,
          ]);
          return next.length === current.length
            && next.every((value, index) => value === current[index])
            ? current
            : next;
        });
      },
    });
  }, [voterKeypair?.nsec]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec || configuredCoordinatorTargets.length === 0) {
      setReceivedShards([]);
      return;
    }

    return subscribeSimpleShardResponses({
      voterNsec,
      voterNsecs: Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec),
      onResponses: (responses) => {
        void reconcileIncomingShardResponses(responses);
      },
    });
  }, [configuredCoordinatorTargets.length, roundReplyKeypairs, voterKeypair?.nsec]);

  useEffect(() => {
    const voterNsec = voterKeypair?.nsec?.trim() ?? "";

    if (!voterNsec || configuredCoordinatorTargets.length === 0) {
      return;
    }

    const hasPendingTicket = Object.values(pendingBlindRequests).some((request) => {
      return !receivedShards.some((response) => response.requestId === request.request.requestId);
    });

    if (!hasPendingTicket) {
      return;
    }

    let cancelled = false;

    const refresh = () => {
      void fetchSimpleShardResponses({
        voterNsec,
        voterNsecs: Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec),
      }).then((nextResponses) => {
        if (!cancelled) {
          void reconcileIncomingShardResponses(nextResponses);
        }
      }).catch(() => undefined);
    };

    refresh();
    const intervalId = window.setInterval(refresh, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    configuredCoordinatorTargets.length,
    pendingBlindRequests,
    receivedShards,
    roundReplyKeypairs,
    voterKeypair?.nsec,
  ]);

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
    const knownParticipants = [
      ...configuredCoordinatorTargets,
      ...Object.values(roundReplyKeypairs).map((keypair) => keypair.npub),
    ];
    if (knownParticipants.length === 0) {
      return;
    }

    void primeNip65RelayHints(knownParticipants, SIMPLE_PUBLIC_RELAYS);
  }, [configuredCoordinatorTargets, roundReplyKeypairs]);

  useEffect(() => {
    let cancelled = false;

    async function replayProtocolState() {
      const authorPubkey = voterKeypair?.npub ?? configuredCoordinatorTargets[0] ?? "voter";
      const service = protocolStateServiceRef.current ?? await ProtocolStateService.create({
        electionId: SIMPLE_PUBLIC_ELECTION_ID,
        snapshot: protocolStateCache,
      });
      protocolStateServiceRef.current = service;

      const replay = service.replayPublicState({
        electionId: SIMPLE_PUBLIC_ELECTION_ID,
        authorPubkey,
        rounds: discoveredSessions,
      });
      const nextCache = service.snapshot();

      if (cancelled) {
        return;
      }

      setDerivedPublicRounds(replay.roundSessions);
      setProtocolStateCache(nextCache);
    }

    void replayProtocolState();

    return () => {
      cancelled = true;
    };
  }, [configuredCoordinatorTargets, discoveredSessions, voterKeypair?.npub]);

  useEffect(() => {
    if (configuredCoordinatorTargets.length === 0 || knownRoundVotingIds.length === 0) {
      setKnownBlindKeys({});
      return;
    }

    const cleanups = configuredCoordinatorTargets.flatMap((coordinatorNpub) => (
      knownRoundVotingIds.map((votingId) => subscribeLatestSimpleBlindKeyAnnouncement({
        coordinatorNpub,
        votingId,
        onAnnouncement: (announcement) => {
          if (!announcement) {
            return;
          }

          setKnownBlindKeys((current) => ({
            ...current,
            [makeRoundBlindKeyId(coordinatorNpub, votingId)]: announcement,
          }));
        },
      }))
    ));

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [configuredCoordinatorTargets, knownRoundVotingIds]);

  useEffect(() => {
    const roundsMissingBlindKeys = configuredCoordinatorTargets.flatMap((coordinatorNpub) => {
      return knownRoundVotingIds.flatMap((votingId) => (
        knownBlindKeys[makeRoundBlindKeyId(coordinatorNpub, votingId)]
          ? []
          : [{ coordinatorNpub, votingId }]
      ));
    });

    if (roundsMissingBlindKeys.length === 0) {
      return;
    }

    let cancelled = false;

    const refreshMissingBlindKeys = () => {
      void Promise.all(roundsMissingBlindKeys.map(async ({ coordinatorNpub, votingId }) => {
        const announcement = await fetchLatestSimpleBlindKeyAnnouncement({
          coordinatorNpub,
          votingId,
        });
        return announcement ? { coordinatorNpub, votingId, announcement } : null;
      })).then((results) => {
        if (cancelled) {
          return;
        }

        const foundAnnouncements = results.filter((value): value is NonNullable<typeof value> => value !== null);
        if (foundAnnouncements.length === 0) {
          return;
        }

        setKnownBlindKeys((current) => {
          const next = { ...current };
          for (const result of foundAnnouncements) {
            next[makeRoundBlindKeyId(result.coordinatorNpub, result.votingId)] = result.announcement;
          }
          return next;
        });
      }).catch(() => undefined);
    };

    refreshMissingBlindKeys();
    const intervalId = window.setInterval(refreshMissingBlindKeys, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [configuredCoordinatorTargets, knownBlindKeys, knownRoundVotingIds]);

  useEffect(() => {
    const npub = voterKeypair?.npub?.trim() ?? "";
    if (!npub) {
      setVoterId("pending");
      return;
    }

    setVoterId(deriveActorDisplayId(npub));
  }, [voterKeypair?.npub]);

  useEffect(() => {
    setLiveVoteChoice(null);
    setSubmitStatus(null);
  }, [selectedVotingId]);

  function clearVoterSessionState(options?: { clearManualCoordinators?: boolean }) {
    if (options?.clearManualCoordinators ?? false) {
      setManualCoordinators([]);
      setCoordinatorDraft("");
    }
    protocolStateServiceRef.current = null;
    setProtocolStateCache(null);
    setDerivedPublicRounds([]);
    setLiveVoteChoice(null);
    setRequestStatus(null);
    setSubmitStatus(null);
    setBallotTokenId(null);
    setReceivedShards([]);
    setPendingBlindRequests({});
    setRoundReplyKeypairs({});
    setFollowDeliveries({});
    setRequestDeliveries({});
    setDmAcknowledgements([]);
    setDiscoveredSessions([]);
    setKnownBlindKeys({});
    setSelectedVotingId("");
    setActiveTab("configure");
    setShowVoteDetails(false);
    lastAutoSelectedVotingIdRef.current = "";
    manualRoundSelectionRef.current = false;
    sentTicketReceiptAckIdsRef.current.clear();
  }

  function refreshIdentity() {
    const nextKeypair = createSimpleVoterKeypair();
    void saveSimpleActorState({
      role: "voter",
      keypair: nextKeypair,
      updatedAt: new Date().toISOString(),
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setVoterKeypair(nextKeypair);
    setIdentityStatus(null);
    setBackupStatus(null);
    clearVoterSessionState({ clearManualCoordinators: true });
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
    }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
    setVoterKeypair(nextKeypair);
    setIdentityStatus("Identity restored from nsec.");
    setBackupStatus(null);
    clearVoterSessionState({ clearManualCoordinators: true });
  }

  function downloadBackup(passphrase?: string) {
    if (!voterKeypair) {
      return;
    }

    void downloadSimpleActorBackup("voter", voterKeypair as SimpleActorKeypair, {
      manualCoordinators,
      nip65Enabled,
      protocolStateCache,
      requestStatus,
      receivedShards,
      pendingBlindRequests,
      roundReplyKeypairs,
      followDeliveries,
      requestDeliveries,
      submitStatus,
      selectedVotingId,
      liveVoteChoice,
    } satisfies SimpleVoterCache, { passphrase });
    setBackupStatus(passphrase?.trim() ? "Encrypted identity backup downloaded." : "Identity backup downloaded.");
  }

  async function restoreBackup(file: File, passphrase?: string) {
    try {
      const text = await file.text();
      const bundle = parseSimpleActorBackupBundle(text)
        ?? (passphrase?.trim() ? await parseEncryptedSimpleActorBackupBundle(text, passphrase.trim()) : null);
      if (!bundle || bundle.role !== "voter") {
        setBackupStatus("Backup file is not a voter backup.");
        return;
      }

      await saveSimpleActorState({
        role: "voter",
        keypair: bundle.keypair,
        updatedAt: new Date().toISOString(),
        cache: bundle.cache,
      }, storagePassphrase ? { passphrase: storagePassphrase } : undefined);
      setVoterKeypair(bundle.keypair);
      setIdentityStatus("Identity restored from backup.");
      setBackupStatus(`Backup restored from ${bundle.exportedAt}.`);
      const cache = (bundle.cache ?? null) as Partial<SimpleVoterCache> | null;
      protocolStateServiceRef.current = null;
      setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? cache.manualCoordinators : []);
      setNip65Enabled(cache?.nip65Enabled === true);
      setProtocolStateCache(
        cache?.protocolStateCache && typeof cache.protocolStateCache === "object"
          ? cache.protocolStateCache as ProtocolStateCache
          : null,
      );
      setDerivedPublicRounds([]);
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
      setRoundReplyKeypairs(
        cache?.roundReplyKeypairs && typeof cache.roundReplyKeypairs === "object"
          ? cache.roundReplyKeypairs
          : {},
      );
      setFollowDeliveries(
        cache?.followDeliveries && typeof cache.followDeliveries === "object"
          ? cache.followDeliveries
          : {},
      );
      setRequestDeliveries(
        cache?.requestDeliveries && typeof cache.requestDeliveries === "object"
          ? cache.requestDeliveries
          : {},
      );
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setDmAcknowledgements([]);
      sentTicketReceiptAckIdsRef.current.clear();
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
      const storedState = await loadSimpleActorStateWithOptions("voter", { passphrase: trimmed });
      if (!storedState?.keypair) {
        setStorageStatus("No voter state was found.");
        return;
      }

      const cache = (storedState.cache ?? null) as Partial<SimpleVoterCache> | null;
      setStoragePassphrase(trimmed);
      setVoterKeypair(storedState.keypair);
      protocolStateServiceRef.current = null;
      setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? cache.manualCoordinators : []);
      setProtocolStateCache(
        cache?.protocolStateCache && typeof cache.protocolStateCache === "object"
          ? cache.protocolStateCache as ProtocolStateCache
          : null,
      );
      setDerivedPublicRounds([]);
      setRequestStatus(typeof cache?.requestStatus === "string" ? cache.requestStatus : null);
      setReceivedShards(Array.isArray(cache?.receivedShards) ? cache.receivedShards : []);
      setPendingBlindRequests(cache?.pendingBlindRequests && typeof cache.pendingBlindRequests === "object" ? cache.pendingBlindRequests : {});
      setRoundReplyKeypairs(cache?.roundReplyKeypairs && typeof cache.roundReplyKeypairs === "object" ? cache.roundReplyKeypairs : {});
      setFollowDeliveries(cache?.followDeliveries && typeof cache.followDeliveries === "object" ? cache.followDeliveries : {});
      setRequestDeliveries(cache?.requestDeliveries && typeof cache.requestDeliveries === "object" ? cache.requestDeliveries : {});
      setSubmitStatus(typeof cache?.submitStatus === "string" ? cache.submitStatus : null);
      setSelectedVotingId(typeof cache?.selectedVotingId === "string" ? cache.selectedVotingId : "");
      setLiveVoteChoice(cache?.liveVoteChoice === "Yes" || cache?.liveVoteChoice === "No" ? cache.liveVoteChoice : null);
      setStorageLocked(false);
      setStorageStatus("Local voter state unlocked.");
      setIdentityReady(true);
    } catch {
      setStorageStatus("Unlock failed.");
    }
  }

  async function protectLocalState(passphrase: string) {
    const trimmed = passphrase.trim();
    if (!trimmed || !voterKeypair) {
      setStorageStatus("Enter a passphrase first.");
      return;
    }
    setStoragePassphrase(trimmed);
    setStorageStatus("Local voter state will be stored encrypted.");
  }

  async function disableLocalStateProtection(currentPassphrase?: string) {
    if (!voterKeypair) {
      return;
    }
    if (!storagePassphrase && !currentPassphrase?.trim()) {
      setStorageStatus("Enter the current passphrase to remove protection.");
      return;
    }
    setStoragePassphrase("");
    setStorageStatus("Local voter state protection removed.");
  }

  function addCoordinatorInput() {
    const nextCoordinator = coordinatorDraft.trim();
    if (!nextCoordinator) {
      return;
    }

    setManualCoordinators((current) => normalizeCoordinatorNpubsRust([...current, nextCoordinator]));
    setCoordinatorDraft("");
    setRequestStatus(null);
  }

  function handleCoordinatorScanDetected(rawValue: string) {
    const scannedNpub = extractNpubFromScan(rawValue);
    if (!scannedNpub) {
      setCoordinatorScannerStatus("QR did not contain a valid npub.");
      return false;
    }

    setManualCoordinators((current) => normalizeCoordinatorNpubsRust([...current, scannedNpub]));
    setCoordinatorDraft("");
    setRequestStatus(null);
    setCoordinatorScannerStatus(`Scanned ${shortenNpub(scannedNpub)}.`);
    return true;
  }

  function removeCoordinatorInput(index: number) {
    setManualCoordinators((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }

  async function sendFollowRequests(
    targetCoordinatorNpubs: string[],
    messages?: {
      pending?: string;
      success?: string;
      failure?: string;
    },
  ) {
    const voterNpub = voterKeypair?.npub ?? "";
    const voterNsec = voterKeypair?.nsec ?? "";
    const voterSecretKey = decodeNsec(voterNsec);

    if (
      !voterNpub
      || voterId === "pending"
      || !voterSecretKey
      || targetCoordinatorNpubs.length === 0
    ) {
      return;
    }

    setRequestStatus(messages?.pending ?? "Contacting coordinators...");

    try {
      const followResults = await Promise.all(targetCoordinatorNpubs.map(async (coordinatorNpub) => {
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
        });
        return {
          coordinatorNpub,
          success: result.successes > 0,
          eventId: result.eventId,
        };
      }));
      const nextDeliveries = Object.fromEntries(followResults.map((result) => [
        result.coordinatorNpub,
        {
          status: result.success ? "Follow request sent." : "Follow request failed.",
          eventId: result.eventId,
          attempts: 1,
          lastAttemptAt: new Date().toISOString(),
        },
      ]));
      setFollowDeliveries((current) => ({ ...current, ...nextDeliveries }));
      const followSuccesses = followResults.filter((result) => result.success).length;

      setRequestStatus(
        followSuccesses > 0
          ? (messages?.success ?? "Coordinators notified. Waiting for round tickets.")
          : (messages?.failure ?? "Coordinator notification failed."),
      );
    } catch {
      setRequestStatus(messages?.failure ?? "Coordinator notification failed.");
    }
  }

  async function retryUnresponsiveCoordinators() {
    const retryTargets = configuredCoordinatorTargets.filter(
      (coordinatorNpub) => coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone !== "ok",
    );
    await sendFollowRequests(retryTargets, {
      pending: "Retrying unresponsive coordinators...",
      success: "Retry sent. Waiting for round tickets.",
      failure: "Coordinator retry failed.",
    });
  }

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";

    if (!voterSecretKey || !voterNpub || configuredCoordinatorTargets.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const retryTargets = selectFollowRetryTargetsRust({
        configuredCoordinatorTargets,
        followDeliveries,
        acknowledgements: dmAcknowledgements.map((ack) => ({
          actorNpub: ack.actorNpub,
          ackedAction: ack.ackedAction,
          ackedEventId: ack.ackedEventId,
        })),
        nowMs: now,
        minRetryAgeMs: 8000,
        maxAttempts: 3,
      });

      if (!retryTargets.length) {
        return;
      }

      void Promise.all(retryTargets.map(async (coordinatorNpub) => {
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
        });
        return { coordinatorNpub, result };
      })).then((results) => {
        setFollowDeliveries((current) => {
          const next = { ...current };
          for (const { coordinatorNpub, result } of results) {
            const previous = current[coordinatorNpub];
            next[coordinatorNpub] = {
              status: result.successes > 0 ? "Follow request resent." : "Follow request retry failed.",
              eventId: result.eventId,
              attempts: (previous?.attempts ?? 0) + 1,
              lastAttemptAt: new Date().toISOString(),
            };
          }
          return next;
        });
      }).catch(() => undefined);
    }, 4000);

    return () => window.clearInterval(intervalId);
  }, [configuredCoordinatorTargets, dmAcknowledgements, followDeliveries, voterKeypair?.npub, voterKeypair?.nsec]);

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

    void deriveTokenIdFromSimplePublicShardProofs(
      uniqueShardResponses
        .map((shard) => shard.shardCertificate)
        .filter((certificate): certificate is NonNullable<typeof certificate> => certificate !== undefined)
        .map((certificate) => ({
          coordinatorNpub: certificate.coordinatorNpub,
          votingId: certificate.votingId,
          tokenCommitment: certificate.tokenMessage,
          unblindedSignature: certificate.unblindedSignature,
          shareIndex: certificate.shareIndex,
          keyAnnouncementEvent: certificate.keyAnnouncementEvent,
        })),
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

  const voteTicketRows = useMemo(
    () => buildSimpleVoteTicketRows(receivedShards, configuredCoordinatorTargets),
    [configuredCoordinatorTargets, receivedShards],
  );
  const knownRounds = useMemo(() => {
    const sessionsByVotingId = new Map(
      derivedPublicRounds.map((round) => [round.votingId, round] as const),
    );

    for (const row of voteTicketRows) {
      if (sessionsByVotingId.has(row.votingId)) {
        continue;
      }

      const sourceShard = receivedShards.find((response) => {
        const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
        return parsed?.votingId === row.votingId && configuredCoordinatorTargets.includes(response.coordinatorNpub);
      });

      sessionsByVotingId.set(row.votingId, {
        votingId: row.votingId,
        prompt: row.prompt,
        coordinatorNpub: sourceShard?.coordinatorNpub ?? "",
        createdAt: row.createdAt,
        thresholdT: row.thresholdT,
        thresholdN: row.thresholdN,
        authorizedCoordinatorNpubs: [...configuredCoordinatorTargets],
        eventId: `ticket-row:${row.votingId}`,
      });
    }

    return Array.from(sessionsByVotingId.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }, [configuredCoordinatorTargets, derivedPublicRounds, receivedShards, voteTicketRows]);

  useEffect(() => {
    if (!knownRounds.length) {
      setSelectedVotingId("");
      lastAutoSelectedVotingIdRef.current = "";
      manualRoundSelectionRef.current = false;
      return;
    }

    const latestVotingId = knownRounds[0].votingId;
    setSelectedVotingId((current) => {
      const canAutoAdvance =
        !manualRoundSelectionRef.current
        || !current
        || current === lastAutoSelectedVotingIdRef.current;

      if (lastAutoSelectedVotingIdRef.current !== latestVotingId && canAutoAdvance) {
        lastAutoSelectedVotingIdRef.current = latestVotingId;
        return latestVotingId;
      }

      return knownRounds.some((round) => round.votingId === current)
        ? current
        : latestVotingId;
    });
  }, [knownRounds]);

  const effectiveLiveVoteSession = useMemo<SimpleLiveVoteSession | null>(() => {
    return knownRounds.find((round) => round.votingId === selectedVotingId)
      ?? knownRounds[0]
      ?? null;
  }, [knownRounds, selectedVotingId]);

  const coordinatorDiagnostics = useMemo(() => buildVoterCoordinatorDiagnosticsRust({
    configuredCoordinatorTargets,
    activeVotingId: effectiveLiveVoteSession?.votingId ?? null,
    discoveredRoundSources: discoveredSessions.map((session) => ({
      coordinatorNpub: session.coordinatorNpub,
      votingId: session.votingId,
    })),
    knownBlindKeyIds: Object.keys(knownBlindKeys),
    followDeliveries,
    requestDeliveries,
    acknowledgements: dmAcknowledgements.map((ack) => ({
      actorNpub: ack.actorNpub,
      ackedAction: ack.ackedAction,
      ackedEventId: ack.ackedEventId,
    })),
    ticketReceivedCoordinatorNpubs: uniqueShardResponses.map((response) => response.coordinatorNpub),
  }), [
    configuredCoordinatorTargets,
    discoveredSessions,
    dmAcknowledgements,
    effectiveLiveVoteSession?.votingId,
    followDeliveries,
    knownBlindKeys,
    requestDeliveries,
    uniqueShardResponses,
  ]);
  const coordinatorDiagnosticsByNpub = useMemo(
    () => new Map(coordinatorDiagnostics.map((entry) => [entry.coordinatorNpub, entry])),
    [coordinatorDiagnostics],
  );
  const followAcknowledgedByAllConfiguredCoordinators =
    configuredCoordinatorTargets.length > 0 &&
    configuredCoordinatorTargets.every(
      (coordinatorNpub) =>
        coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone === 'ok',
    );
  const coordinatorsHaveBeenNotified =
    followAcknowledgedByAllConfiguredCoordinators ||
    configuredCoordinatorTargets.some(
      (coordinatorNpub) =>
        followDeliveries[coordinatorNpub]?.eventId ||
        followDeliveries[coordinatorNpub]?.status?.startsWith('Follow request'),
    );
  const hasUnresponsiveCoordinators =
    configuredCoordinatorTargets.length > 0
    && configuredCoordinatorTargets.some(
      (coordinatorNpub) => coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone !== 'ok',
    );

  useEffect(() => {
    const discoveredCoordinatorNpubs = normalizeCoordinatorNpubsRust(
      dmAcknowledgements.flatMap((ack) => (
        ack.ackedAction === 'simple_coordinator_follow'
          ? ack.coordinatorNpubs ?? []
          : []
      )),
    );

    if (discoveredCoordinatorNpubs.length === 0) {
      return;
    }

    setManualCoordinators((current) => {
      const next = normalizeCoordinatorNpubsRust([
        ...current,
        ...discoveredCoordinatorNpubs,
      ]);
      return next.length === current.length
        && next.every((value, index) => value === current[index])
        ? current
        : next;
    });
  }, [dmAcknowledgements]);

  useEffect(() => {
    const roundCoordinatorNpubs = normalizeCoordinatorNpubsRust(
      knownRounds.flatMap((round) => round.authorizedCoordinatorNpubs),
    );

    if (roundCoordinatorNpubs.length === 0) {
      return;
    }

    setManualCoordinators((current) => {
      const next = normalizeCoordinatorNpubsRust([
        ...current,
        ...roundCoordinatorNpubs,
      ]);
      return next.length === current.length
        && next.every((value, index) => value === current[index])
        ? current
        : next;
    });
  }, [knownRounds]);

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";

    if (!voterSecretKey || !voterNpub) {
      return;
    }

    const undispatchedCoordinators = configuredCoordinatorTargets.filter(
      (coordinatorNpub) =>
        !followDeliveries[coordinatorNpub]?.eventId
        && coordinatorDiagnosticsByNpub.get(coordinatorNpub)?.follow.tone !== 'ok',
    );

    if (undispatchedCoordinators.length === 0) {
      return;
    }

    void Promise.all(
      undispatchedCoordinators.map(async (coordinatorNpub) => {
        const result = await sendSimpleCoordinatorFollow({
          voterSecretKey,
          coordinatorNpub,
          voterNpub,
        });
        return {
          coordinatorNpub,
          success: result.successes > 0,
          eventId: result.eventId,
        };
      }),
    ).then((results) => {
      setFollowDeliveries((current) => ({
        ...current,
        ...Object.fromEntries(
          results.map((result) => [
            result.coordinatorNpub,
            {
              status: result.success
                ? 'Follow request sent.'
                : 'Follow request failed.',
              eventId: result.eventId,
              attempts: (current[result.coordinatorNpub]?.attempts ?? 0) + 1,
              lastAttemptAt: new Date().toISOString(),
            },
          ]),
        ),
      }));
      if (results.some((result) => result.success)) {
        setRequestStatus(
          configuredCoordinatorTargets.length === results.length
            ? 'Coordinators notified. Waiting for round tickets.'
            : 'Additional coordinators received. Waiting for round tickets.',
        );
      }
    }).catch(() => undefined);
  }, [
    configuredCoordinatorTargets,
    coordinatorDiagnosticsByNpub,
    followDeliveries,
    voterKeypair?.npub,
    voterKeypair?.nsec,
  ]);

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";
    const round = effectiveLiveVoteSession;

    if (!voterSecretKey || !voterNpub || voterId === "pending" || !round) {
      return;
    }

    const coordinatorsToRequest = configuredCoordinatorTargets.filter((coordinatorNpub) => {
      if (!round.authorizedCoordinatorNpubs.includes(coordinatorNpub)) {
        return false;
      }

      if (!knownBlindKeys[makeRoundBlindKeyId(coordinatorNpub, round.votingId)]) {
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
        ?? createRoundTokenMessage(round.votingId);
      const replyKeypair = roundReplyKeypairs[round.votingId] ?? createSimpleVoterKeypair();

      const createdEntries = await Promise.all(coordinatorsToRequest.map(async (coordinatorNpub) => {
        const announcement = knownBlindKeys[makeRoundBlindKeyId(coordinatorNpub, round.votingId)];
        const created = await createSimpleBlindIssuanceRequest({
          publicKey: announcement.publicKey,
          votingId: round.votingId,
          tokenMessage: existingRoundTokenMessage,
        });
        return {
          coordinatorNpub,
          votingId: round.votingId,
          replyNpub: replyKeypair.npub,
          request: created.request,
          secret: created.secret,
          createdAt: created.request.createdAt,
        } satisfies PendingBlindRequest;
      }));

      const results = await Promise.all(createdEntries.map(async (entry) => sendSimpleShardRequest({
        voterSecretKey: decodeNsec(replyKeypair.nsec) ?? voterSecretKey,
        coordinatorNpub: entry.coordinatorNpub,
        voterNpub,
        replyNpub: entry.replyNpub,
        votingId: round.votingId,
        blindRequest: entry.request,
      })));

      const successfulEntries = createdEntries.flatMap((entry, index) => (
        results[index].successes > 0
          ? [{ ...entry, dmEventId: results[index].eventId }]
          : []
      ));
      const nextRequests = Object.fromEntries(
        successfulEntries.map((entry) => [`${entry.coordinatorNpub}:${entry.votingId}`, entry]),
      );
      setRoundReplyKeypairs((current) => ({
        ...current,
        [round.votingId]: current[round.votingId] ?? replyKeypair,
      }));
      setPendingBlindRequests((current) => ({ ...current, ...nextRequests }));
      const nextRequestDeliveries = Object.fromEntries(createdEntries.map((entry, index) => [
        `${entry.coordinatorNpub}:${entry.votingId}`,
        {
          status: results[index].successes > 0 ? "Blinded ticket request sent." : "Blinded ticket request failed.",
          eventId: results[index].eventId,
          requestId: entry.request.requestId,
          attempts: results[index].successes > 0 ? 1 : 0,
          lastAttemptAt: new Date().toISOString(),
        },
      ]));
      setRequestDeliveries((current) => ({ ...current, ...nextRequestDeliveries }));

      setRequestStatus(
        results.some((result) => result.successes > 0)
          ? "Coordinators notified. Waiting for round tickets."
          : "Blinded ticket requests failed.",
      );
    })();
  }, [
    configuredCoordinatorTargets,
    effectiveLiveVoteSession,
    knownBlindKeys,
    pendingBlindRequests,
    receivedShards,
    roundReplyKeypairs,
    voterId,
    voterKeypair?.npub,
    voterKeypair?.nsec,
  ]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const retryKeys = new Set(selectRequestRetryKeysRust({
        pendingRequests: Object.entries(pendingBlindRequests).map(([key, requestEntry]) => ({
          key,
          requestId: requestEntry.request.requestId,
        })),
        requestDeliveries,
        acknowledgements: dmAcknowledgements.map((ack) => ({
          actorNpub: ack.actorNpub,
          ackedAction: ack.ackedAction,
          ackedEventId: ack.ackedEventId,
        })),
        receivedRequestIds: receivedShards.map((response) => response.requestId),
        nowMs: now,
        minRetryAgeMs: 4000,
        maxAttempts: 8,
      }));
      const retryEntries = Object.entries(pendingBlindRequests).filter(([key]) => retryKeys.has(key));

      if (!retryEntries.length) {
        return;
      }

      void Promise.all(retryEntries.map(async ([key, requestEntry]) => {
        const replyKeypair = roundReplyKeypairs[requestEntry.votingId];
        const senderSecretKey = decodeNsec(replyKeypair?.nsec ?? "");
        const voterNpub = voterKeypair?.npub ?? "";
        if (!senderSecretKey || !voterNpub) {
          return null;
        }
        const result = await sendSimpleShardRequest({
          voterSecretKey: senderSecretKey,
          coordinatorNpub: requestEntry.coordinatorNpub,
          voterNpub,
          replyNpub: requestEntry.replyNpub,
          votingId: requestEntry.votingId,
          blindRequest: requestEntry.request,
        });
        return { key, result, requestId: requestEntry.request.requestId };
      })).then((results) => {
        const completed = results.filter((value): value is NonNullable<typeof value> => value !== null);
        if (!completed.length) {
          return;
        }
        setRequestDeliveries((current) => {
          const next = { ...current };
          for (const { key, result, requestId } of completed) {
            const previous = current[key];
            next[key] = {
              status: result.successes > 0 ? "Blinded ticket request resent." : "Blinded ticket request retry failed.",
              eventId: result.eventId,
              requestId,
              attempts: (previous?.attempts ?? 0) + 1,
              lastAttemptAt: new Date().toISOString(),
            };
          }
          return next;
        });
      }).catch(() => undefined);
    }, 2000);

    return () => window.clearInterval(intervalId);
  }, [dmAcknowledgements, pendingBlindRequests, receivedShards, requestDeliveries, roundReplyKeypairs, voterKeypair?.npub]);

  useEffect(() => {
    if (!voterKeypair?.npub) {
      return;
    }

    for (const response of receivedShards) {
      if (!response.dmEventId || sentTicketReceiptAckIdsRef.current.has(response.dmEventId)) {
        continue;
      }

      const responseVotingId = response.shardCertificate?.votingId
        ?? Object.values(pendingBlindRequests).find((request) => request.request.requestId === response.requestId)?.votingId;
      const replyKeypair = responseVotingId ? roundReplyKeypairs[responseVotingId] : null;
      const senderSecretKey = decodeNsec(replyKeypair?.nsec ?? "");
      const actorNpub = replyKeypair?.npub ?? "";
      if (!senderSecretKey || !actorNpub) {
        continue;
      }

      sentTicketReceiptAckIdsRef.current.add(response.dmEventId);
      void sendSimpleDmAcknowledgement({
        senderSecretKey,
        recipientNpub: response.coordinatorNpub,
        actorNpub,
        ackedAction: "simple_round_ticket",
        ackedEventId: response.dmEventId,
        votingId: responseVotingId,
        requestId: response.requestId,
        responseId: response.id,
      }).catch(() => {
        sentTicketReceiptAckIdsRef.current.delete(response.dmEventId);
      });
    }
  }, [pendingBlindRequests, receivedShards, roundReplyKeypairs, voterKeypair?.npub]);

  const requiredShardCount = Math.max(1, effectiveLiveVoteSession?.thresholdT ?? 1);
  const voteSubmittedSuccessfully = submitStatus?.startsWith("Vote submitted:") ?? false;
  const voteSubmitting = submitStatus === "Submitting vote...";
  const voteTicketReady = uniqueShardResponses.length >= requiredShardCount && requiredShardCount > 0;
  const hasCoordinatorConnection = coordinatorDiagnostics.some((entry) => (
    entry.follow.tone === "ok"
    || entry.round.tone === "ok"
    || entry.request.tone === "ok"
    || entry.ticket.tone === "ok"
  ));
  const missingActiveVoteCoordinatorIndices = effectiveLiveVoteSession
    ? configuredCoordinatorTargets
      .map((value, index) => (
        effectiveLiveVoteSession.authorizedCoordinatorNpubs.includes(value)
        && !knownBlindKeys[makeRoundBlindKeyId(value, effectiveLiveVoteSession.votingId)]
          ? index + 1
          : null
      ))
      .filter((value): value is number => value !== null)
    : [];
  const waitingForCoordinatorKeyText = formatMissingCoordinatorKeyText(
    missingActiveVoteCoordinatorIndices,
  );

  function selectTab(nextTab: VoterTab) {
    setActiveTab(nextTab);
  }

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

  if (storageLocked && !identityReady) {
    return (
      <SimpleUnlockGate
        roleLabel="Voter"
        status={storageStatus}
        onUnlock={unlockLocalState}
        onReset={async () => {
          await clearSimpleActorState("voter");
          setStorageLocked(false);
          setStoragePassphrase("");
          const nextKeypair = createSimpleVoterKeypair();
          await saveSimpleActorState({
            role: "voter",
            keypair: nextKeypair,
            updatedAt: new Date().toISOString(),
          });
          setVoterKeypair(nextKeypair);
          setIdentityReady(true);
          setStorageStatus("Locked local voter state reset.");
        }}
      />
    );
  }

  return (
    <main className='simple-voter-shell'>
      <section className='simple-voter-page'>
        <div className='simple-voter-header-row'>
          <h1 className='simple-voter-title'>Voter ID {voterId}</h1>
          <button
            type='button'
            className='simple-voter-primary'
            onClick={refreshIdentity}
          >
            New
          </button>
        </div>
        <div
          className='simple-voter-tabs'
          role='tablist'
          aria-label='Voter sections'
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
            aria-selected={activeTab === 'vote'}
            className={`simple-voter-tab${activeTab === 'vote' ? ' is-active' : ''}`}
            onClick={() => selectTab('vote')}
          >
            Vote
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
            <div className='simple-voter-field-stack simple-voter-field-stack-tight'>
              <div className='simple-voter-add-row simple-voter-add-row-with-scan'>
                <input
                  id='simple-coordinator-draft'
                  className='simple-voter-input simple-voter-input-inline'
                  value={coordinatorDraft}
                  onChange={(event) => {
                    setCoordinatorDraft(event.target.value);
                    setCoordinatorScannerStatus(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addCoordinatorInput();
                    }
                  }}
                  placeholder='Enter coordinator npub...'
                />
                <button
                  type='button'
                  className='simple-voter-add-button'
                  onClick={addCoordinatorInput}
                  aria-label='Add coordinator'
                >
                  +
                </button>
                <button
                  type='button'
                  className='simple-voter-secondary simple-voter-scan-button'
                  onClick={() => {
                    setCoordinatorScannerStatus(null);
                    setCoordinatorScannerActive(true);
                  }}
                >
                  Scan
                </button>
              </div>
              <SimpleQrScanner
                active={coordinatorScannerActive}
                onDetected={handleCoordinatorScanDetected}
                onClose={() => setCoordinatorScannerActive(false)}
                prompt='Point the camera at a coordinator npub QR code.'
              />
              {coordinatorScannerStatus ? (
                <p className='simple-voter-note'>{coordinatorScannerStatus}</p>
              ) : null}
              {configuredCoordinatorTargets.length > 0 ? (
                <ul className='simple-coordinator-card-list'>
                  {configuredCoordinatorTargets.map((value, index) => (
                    <li key={value} className='simple-coordinator-card'>
                      <div
                        className='simple-coordinator-card-avatar'
                        aria-hidden='true'
                      >
                        •
                      </div>
                      <div className='simple-coordinator-card-copy'>
                        <p className='simple-coordinator-card-title'>
                          Coordinator {index + 1}
                        </p>
                        <p
                          className='simple-coordinator-card-meta'
                          title={value}
                        >
                          {shortenNpub(value)}
                        </p>
                        {(() => {
                          const diagnostic =
                            coordinatorDiagnosticsByNpub.get(value);
                          const toneClass = (tone: string) =>
                            tone === 'error'
                              ? 'simple-delivery-error'
                              : tone === 'ok'
                                ? 'simple-delivery-ok'
                                : 'simple-delivery-waiting';

                          return (
                            <ul className='simple-delivery-diagnostics simple-delivery-diagnostics-compact'>
                              <li
                                className={toneClass(
                                  diagnostic?.follow.tone ?? 'waiting',
                                )}
                              >
                                {diagnostic?.follow.text ??
                                  'Follow request not sent yet.'}
                              </li>
                              <li
                                className={toneClass(
                                  diagnostic?.round.tone ?? 'waiting',
                                )}
                              >
                                {diagnostic?.round.text ??
                                  'Waiting for live round.'}
                              </li>
                              <li
                                className={toneClass(
                                  diagnostic?.blindKey.tone ?? 'waiting',
                                )}
                              >
                                {diagnostic?.blindKey.text ??
                                  formatMissingCoordinatorKeyText([index + 1])}
                              </li>
                              <li
                                className={toneClass(
                                  diagnostic?.request.tone ?? 'waiting',
                                )}
                              >
                                {diagnostic?.request.text ??
                                  'Waiting to send blinded ticket request.'}
                              </li>
                              <li
                                className={toneClass(
                                  diagnostic?.ticket.tone ?? 'waiting',
                                )}
                              >
                                {diagnostic?.ticket.text ??
                                  'Waiting for ticket.'}
                              </li>
                            </ul>
                          );
                        })()}
                      </div>
                      <button
                        type='button'
                        className='simple-coordinator-card-remove'
                        onClick={() => removeCoordinatorInput(index)}
                        aria-label={`Remove coordinator ${index + 1}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className='simple-voter-empty'>No coordinators added yet.</p>
              )}
            </div>
            {coordinatorsHaveBeenNotified ? (
              <div className='simple-voter-action-row simple-voter-action-row-tight'>
                <button
                  type='button'
                  className='simple-voter-primary simple-voter-primary-wide'
                  onClick={() => selectTab('vote')}
                  disabled={
                    !voterKeypair?.npub ||
                    configuredCoordinatorTargets.length === 0
                  }
                >
                  Vote
                </button>
              </div>
            ) : hasUnresponsiveCoordinators ? (
              <div className='simple-voter-action-row simple-voter-action-row-tight'>
                <button
                  type='button'
                  className='simple-voter-secondary simple-voter-primary-wide'
                  onClick={() => void retryUnresponsiveCoordinators()}
                  disabled={
                    !voterKeypair?.npub ||
                    configuredCoordinatorTargets.length === 0
                  }
                >
                  Retry
                </button>
              </div>
            ) : null}
            {requestStatus ? (
              <p className='simple-voter-note'>{requestStatus}</p>
            ) : null}
          </section>
        ) : null}

        {activeTab === 'vote' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Vote'
          >
            {effectiveLiveVoteSession ? (
              <>
                {knownRounds.length > 1 ? (
                  <div className='simple-voter-round-picker'>
                    <label
                      className='simple-voter-label'
                      htmlFor='simple-live-round'
                    >
                      Round
                    </label>
                    <select
                      id='simple-live-round'
                      className='simple-voter-input'
                      value={effectiveLiveVoteSession.votingId}
                      onChange={(event) => {
                        manualRoundSelectionRef.current = true;
                        setSelectedVotingId(event.target.value);
                      }}
                    >
                      {knownRounds.map((round) => (
                        <option key={round.votingId} value={round.votingId}>
                          {formatRoundOptionLabel(round)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <div className='simple-vote-card'>
                  <h2 className='simple-vote-card-title'>
                    {effectiveLiveVoteSession.prompt}
                  </h2>
                  <p className='simple-vote-card-meta'>
                    Tickets ready: {uniqueShardResponses.length} of{' '}
                    {requiredShardCount}
                  </p>
                </div>

                <div className='simple-vote-button-grid'>
                  <button
                    type='button'
                    className={`simple-voter-choice simple-voter-choice-yes${liveVoteChoice === 'Yes' ? ' is-active' : ''}${liveVoteChoice === 'No' ? ' is-dimmed' : ''}${voteTicketReady && !liveVoteChoice ? ' is-awaiting-choice' : ''}`}
                    onClick={() => setLiveVoteChoice('Yes')}
                  >
                    Yes
                  </button>
                  <button
                    type='button'
                    className={`simple-voter-choice simple-voter-choice-no${liveVoteChoice === 'No' ? ' is-active' : ''}${liveVoteChoice === 'Yes' ? ' is-dimmed' : ''}${voteTicketReady && !liveVoteChoice ? ' is-awaiting-choice' : ''}`}
                    onClick={() => setLiveVoteChoice('No')}
                  >
                    No
                  </button>
                </div>

                <button
                  type='button'
                  className={`simple-voter-primary simple-voter-primary-wide simple-vote-submit${voteSubmittedSuccessfully ? ' is-success' : ''}`}
                  onClick={() => void submitVote()}
                  disabled={
                    voteSubmitting ||
                    voteSubmittedSuccessfully ||
                    !liveVoteChoice ||
                    uniqueShardResponses.length < requiredShardCount
                  }
                >
                  {voteSubmitting
                    ? 'Submitting vote...'
                    : voteSubmittedSuccessfully
                      ? 'Vote submitted'
                      : !liveVoteChoice || uniqueShardResponses.length < requiredShardCount
                        ? 'Preparing vote'
                        : 'Submit vote'}
                </button>

                <section
                  className='simple-vote-status-card'
                  aria-label='Vote status'
                >
                  <h3 className='simple-vote-status-title'>Status</h3>
                  <ul className='simple-vote-status-list'>
                    <li
                      className={
                        hasCoordinatorConnection ? 'is-complete' : 'is-pending'
                      }
                    >
                      <span
                        className='simple-vote-status-icon'
                        aria-hidden='true'
                      >
                        {hasCoordinatorConnection ? '✓' : '○'}
                      </span>
                      <span>
                        {hasCoordinatorConnection
                          ? 'Connected to voting network'
                          : 'Waiting to connect to coordinators'}
                      </span>
                    </li>
                    <li
                      className={voteTicketReady ? 'is-complete' : 'is-pending'}
                    >
                      <span
                        className='simple-vote-status-icon'
                        aria-hidden='true'
                      >
                        {voteTicketReady ? '✓' : '○'}
                      </span>
                      <span>
                        {voteTicketReady
                          ? 'Vote ticket received'
                          : waitingForCoordinatorKeyText}
                      </span>
                    </li>
                    <li
                      className={
                        voteSubmittedSuccessfully ? 'is-complete' : 'is-pending'
                      }
                    >
                      <span
                        className='simple-vote-status-icon'
                        aria-hidden='true'
                      >
                        {voteSubmittedSuccessfully ? '✓' : '○'}
                      </span>
                      <span>
                        {voteSubmittedSuccessfully
                          ? 'Vote submitted successfully'
                          : 'Vote not submitted yet'}
                      </span>
                    </li>
                  </ul>
                  {submitStatus && !voteSubmittedSuccessfully ? (
                    <p className='simple-voter-note'>{submitStatus}</p>
                  ) : null}
                  <button
                    type='button'
                    className='simple-vote-details-toggle'
                    onClick={() => setShowVoteDetails((current) => !current)}
                    aria-expanded={showVoteDetails}
                  >
                    {showVoteDetails ? 'Hide details' : 'Show details'}
                  </button>
                  {showVoteDetails ? (
                    <div className='simple-vote-details'>
                      {ballotTokenId ? (
                        <div className='simple-vote-entry simple-vote-entry-ballot'>
                          <div className='simple-vote-entry-copy'>
                            <h3 className='simple-voter-question'>
                              Ballot footprint
                            </h3>
                          </div>
                          <div className='simple-vote-entry-media'>
                            <TokenFingerprint tokenId={ballotTokenId} large />
                          </div>
                        </div>
                      ) : null}
                      <div className='simple-voter-ticket-area'>
                        <h3 className='simple-voter-question'>
                          Live Vote Tickets Received
                        </h3>
                        {voteTicketRows.length > 0 &&
                        configuredCoordinatorTargets.length > 0 ? (
                          <div className='simple-voter-table-wrap'>
                            <table className='simple-voter-table'>
                              <thead>
                                <tr>
                                  <th scope='col'>Vote</th>
                                  {configuredCoordinatorTargets.map(
                                    (coordinatorNpub, index) => (
                                      <th key={coordinatorNpub} scope='col'>
                                        Coord {index + 1}
                                      </th>
                                    ),
                                  )}
                                </tr>
                              </thead>
                              <tbody>
                                {voteTicketRows.map((row) => (
                                  <tr key={row.votingId}>
                                    <th scope='row'>
                                      {shortVotingId(row.votingId)}
                                    </th>
                                    {configuredCoordinatorTargets.map(
                                      (coordinatorNpub) => (
                                        <td
                                          key={`${row.votingId}:${coordinatorNpub}`}
                                        >
                                          {row.countsByCoordinator[
                                            coordinatorNpub
                                          ] ?? 0}
                                        </td>
                                      ),
                                    )}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className='simple-voter-empty'>
                            No vote tickets received yet.
                          </p>
                        )}
                      </div>
                    </div>
                  ) : null}
                </section>
              </>
            ) : (
              <div className='simple-vote-empty-state'>
                <p className='simple-voter-question'>
                  No live vote ticket yet.
                </p>
                <p className='simple-voter-note'>
                  {coordinatorsHaveBeenNotified
                    ? 'Waiting for the next live round and ticket.'
                    : 'Add coordinators in Configure, then wait for the next live round and ticket.'}
                </p>
              </div>
            )}
          </section>
        ) : null}

        {activeTab === 'settings' ? (
          <section
            className='simple-voter-tab-panel'
            role='tabpanel'
            aria-label='Settings'
          >
            <SimpleIdentityPanel
              npub={voterKeypair?.npub ?? ''}
              nsec={voterKeypair?.nsec ?? ''}
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
            <section className='simple-settings-card' aria-label='Relay hint settings'>
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
                Disabled by default. Turn this on only if you want to publish and use NIP-65 inbox/outbox relay hints.
              </p>
            </section>
            <SimpleRelayPanel />
          </section>
        ) : null}
      </section>
    </main>
  );
}

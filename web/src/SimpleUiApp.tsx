import { useEffect, useMemo, useRef, useState } from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { decodeNsec, deriveNpubFromNsec } from "./nostrIdentity";
import { sha256Hex } from "./tokenIdentity";
import SimpleCollapsibleSection from "./SimpleCollapsibleSection";
import SimpleIdentityPanel from "./SimpleIdentityPanel";
import SimpleQrScanner from "./SimpleQrScanner";
import SimpleUnlockGate from "./SimpleUnlockGate";
import TokenFingerprint from "./TokenFingerprint";
import { extractNpubFromScan } from "./npubScan";
import { primeNip65RelayHints } from "./nip65RelayHints";
import {
  deriveTokenIdFromSimplePublicShardProofs,
  createSimpleBlindIssuanceRequest,
  parseSimpleShardCertificate,
  subscribeLatestSimpleBlindKeyAnnouncement,
  unblindSimpleBlindShare,
  type SimpleBlindKeyAnnouncement,
  type SimpleBlindRequestSecret,
} from "./simpleShardCertificate";
import {
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
import { reconcileSimpleKnownRounds } from "./simpleRoundState";
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

type LiveVoteChoice = "Yes" | "No" | null;

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

export default function SimpleUiApp() {
  const [voterKeypair, setVoterKeypair] = useState<SimpleVoterKeypair | null>(null);
  const [identityReady, setIdentityReady] = useState(false);
  const [voterId, setVoterId] = useState<string>("pending");
  const [manualCoordinators, setManualCoordinators] = useState<string[]>([]);
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
  const [knownBlindKeys, setKnownBlindKeys] = useState<Record<string, SimpleBlindKeyAnnouncement>>({});
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [ballotTokenId, setBallotTokenId] = useState<string | null>(null);
  const [selectedVotingId, setSelectedVotingId] = useState("");
  const sentTicketReceiptAckIdsRef = useRef<Set<string>>(new Set());
  const lastAutoSelectedVotingIdRef = useRef("");
  const manualRoundSelectionRef = useRef(false);

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

    setReceivedShards((current) => (
      equalReceivedShards(current, nextIssuedShares) ? current : nextIssuedShares
    ));
  }

  const configuredCoordinatorTargets = useMemo(
    () => normalizeCoordinatorNpubs(manualCoordinators),
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
    let cancelled = false;

    void loadSimpleActorState("voter").then((storedState) => {
      if (cancelled) {
        return;
      }

      if (storedState?.keypair) {
        setVoterKeypair(storedState.keypair);
        const cache = (storedState.cache ?? null) as Partial<SimpleVoterCache> | null;
        setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? cache.manualCoordinators : []);
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
    if (!identityReady || !voterKeypair) {
      return;
    }

    const cache: SimpleVoterCache = {
      manualCoordinators,
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

    if (!voterNsec || configuredCoordinatorTargets.length === 0) {
      setReceivedShards([]);
      return;
    }

    setReceivedShards([]);

    return subscribeSimpleShardResponses({
      voterNsec,
      voterNsecs: Object.values(roundReplyKeypairs).map((keypair) => keypair.nsec),
      onResponses: (responses) => {
        void reconcileIncomingShardResponses(responses);
      },
    });
  }, [configuredCoordinatorTargets.length, pendingBlindRequests, roundReplyKeypairs, voterKeypair?.nsec]);

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
    const intervalId = window.setInterval(refresh, 5000);

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

  function clearVoterSessionState(options?: { clearManualCoordinators?: boolean }) {
    if (options?.clearManualCoordinators ?? false) {
      setManualCoordinators([]);
      setCoordinatorDraft("");
    }
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
      setManualCoordinators(Array.isArray(cache?.manualCoordinators) ? cache.manualCoordinators : []);
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

    setManualCoordinators((current) => normalizeCoordinatorNpubs([...current, nextCoordinator]));
    setCoordinatorDraft("");
    setRequestStatus(null);
  }

  function handleCoordinatorScanDetected(rawValue: string) {
    const scannedNpub = extractNpubFromScan(rawValue);
    if (!scannedNpub) {
      setCoordinatorScannerStatus("QR did not contain a valid npub.");
      return false;
    }

    setManualCoordinators((current) => normalizeCoordinatorNpubs([...current, scannedNpub]));
    setCoordinatorDraft("");
    setRequestStatus(null);
    setCoordinatorScannerStatus(`Scanned ${shortenNpub(scannedNpub)}.`);
    return true;
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
          ? "Coordinators notified. Waiting for round tickets."
          : "Coordinator notification failed.",
      );
    } catch {
      setRequestStatus("Coordinator notification failed.");
    }
  }

  useEffect(() => {
    const voterSecretKey = decodeNsec(voterKeypair?.nsec ?? "");
    const voterNpub = voterKeypair?.npub ?? "";

    if (!voterSecretKey || !voterNpub || configuredCoordinatorTargets.length === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const retryTargets = configuredCoordinatorTargets.filter((coordinatorNpub) => {
        const delivery = followDeliveries[coordinatorNpub];
        if (!delivery?.eventId) {
          return false;
        }
        const acknowledged = dmAcknowledgements.some((ack) => (
          ack.ackedAction === "simple_coordinator_follow"
          && ack.ackedEventId === delivery.eventId
        ));
        if (acknowledged || (delivery.attempts ?? 0) >= 3) {
          return false;
        }
        const lastAttemptAt = delivery.lastAttemptAt ? Date.parse(delivery.lastAttemptAt) : 0;
        return now - lastAttemptAt >= 8000;
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

  const reconciledRoundState = useMemo(() => reconcileSimpleKnownRounds({
    configuredCoordinatorTargets,
    discoveredSessions,
    receivedShards,
  }), [configuredCoordinatorTargets, discoveredSessions, receivedShards]);

  const voteTicketRows = reconciledRoundState.ticketRows;

  useEffect(() => {
    if (!reconciledRoundState.knownRounds.length) {
      setSelectedVotingId("");
      lastAutoSelectedVotingIdRef.current = "";
      manualRoundSelectionRef.current = false;
      return;
    }

    const latestVotingId = reconciledRoundState.knownRounds[0].votingId;
    setSelectedVotingId((current) => {
      const canAutoAdvance =
        !manualRoundSelectionRef.current
        || !current
        || current === lastAutoSelectedVotingIdRef.current;

      if (lastAutoSelectedVotingIdRef.current !== latestVotingId && canAutoAdvance) {
        lastAutoSelectedVotingIdRef.current = latestVotingId;
        return latestVotingId;
      }

      return reconciledRoundState.knownRounds.some((round) => round.votingId === current)
        ? current
        : latestVotingId;
    });
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
      const retryEntries = Object.entries(pendingBlindRequests).filter(([key, requestEntry]) => {
        const delivery = requestDeliveries[key];
        const acknowledged = delivery?.eventId
          ? dmAcknowledgements.some((ack) => (
              ack.ackedAction === "simple_shard_request"
              && ack.ackedEventId === delivery.eventId
            ))
          : false;
        const received = receivedShards.some((response) => response.requestId === requestEntry.request.requestId);
        if (acknowledged || received || (delivery?.attempts ?? 0) >= 4) {
          return false;
        }
        const lastAttemptAt = delivery?.lastAttemptAt ? Date.parse(delivery.lastAttemptAt) : 0;
        return now - lastAttemptAt >= 10000;
      });

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
    }, 5000);

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
          onProtectLocalState={identityReady ? protectLocalState : undefined}
          onDisableLocalStateProtection={identityReady ? disableLocalStateProtection : undefined}
          localStateProtected={Boolean(storagePassphrase)}
          localStateMessage={storageStatus}
        />

        <SimpleCollapsibleSection title="Coordinators">
          <div className="simple-voter-field-stack simple-voter-field-stack-tight">
            <label className="simple-voter-label simple-voter-label-tight" htmlFor="simple-coordinator-draft">Coordinator npubs</label>
            <div className="simple-voter-add-row simple-voter-add-row-with-scan">
              <input
                id="simple-coordinator-draft"
                className="simple-voter-input simple-voter-input-inline"
                value={coordinatorDraft}
                onChange={(event) => {
                  setCoordinatorDraft(event.target.value);
                  setCoordinatorScannerStatus(null);
                }}
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
              <button
                type="button"
                className="simple-voter-secondary simple-voter-scan-button"
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
              prompt="Point the camera at a coordinator npub QR code."
            />
            {coordinatorScannerStatus ? <p className="simple-voter-note">{coordinatorScannerStatus}</p> : null}
            {configuredCoordinatorTargets.length > 0 ? (
              <ul className="simple-coordinator-card-list">
                {configuredCoordinatorTargets.map((value, index) => (
                  <li key={value} className="simple-coordinator-card">
                    <div className="simple-coordinator-card-avatar" aria-hidden="true">•</div>
                    <div className="simple-coordinator-card-copy">
                      <p className="simple-coordinator-card-title">Coordinator {index + 1}</p>
                      <p className="simple-coordinator-card-meta" title={value}>{shortenNpub(value)}</p>
                      {(() => {
                        const followDelivery = followDeliveries[value];
                        const followAck = followDelivery?.eventId
                          ? dmAcknowledgements.find((ack) => (
                            ack.actorNpub === value
                            && ack.ackedAction === "simple_coordinator_follow"
                            && ack.ackedEventId === followDelivery.eventId
                          ))
                          : null;
                        const roundSeen = effectiveLiveVoteSession
                          ? discoveredSessions.some((session) => (
                            session.coordinatorNpub === value
                            && session.votingId === effectiveLiveVoteSession.votingId
                          ))
                          : false;
                        const blindKeySeen = effectiveLiveVoteSession
                          ? Boolean(knownBlindKeys[makeRoundBlindKeyId(value, effectiveLiveVoteSession.votingId)])
                          : false;
                        const requestDeliveryKey = effectiveLiveVoteSession ? `${value}:${effectiveLiveVoteSession.votingId}` : "";
                        const requestDelivery = requestDeliveryKey ? requestDeliveries[requestDeliveryKey] : undefined;
                        const requestAck = requestDelivery?.eventId
                          ? dmAcknowledgements.find((ack) => (
                            ack.actorNpub === value
                            && ack.ackedAction === "simple_shard_request"
                            && ack.ackedEventId === requestDelivery.eventId
                          ))
                          : null;
                        const ticketReceived = uniqueShardResponses.some((response) => response.coordinatorNpub === value);

                        return (
                          <ul className="simple-delivery-diagnostics simple-delivery-diagnostics-compact">
                            <li className={
                              followDelivery?.status === "Follow request failed."
                                ? "simple-delivery-error"
                                : followAck
                                  ? "simple-delivery-ok"
                                  : followDelivery
                                    ? "simple-delivery-waiting"
                                    : "simple-delivery-waiting"
                            }>
                              {followAck
                                ? "Follow request acknowledged."
                                : followDelivery?.status ?? "Follow request not sent yet."}
                            </li>
                            <li className={roundSeen ? "simple-delivery-ok" : "simple-delivery-waiting"}>
                              {roundSeen ? "Live round seen." : "Waiting for live round."}
                            </li>
                            <li className={blindKeySeen ? "simple-delivery-ok" : "simple-delivery-waiting"}>
                              {blindKeySeen ? "Blind key seen." : "Waiting for blind key."}
                            </li>
                            <li className={
                              requestDelivery?.status === "Blinded ticket request failed."
                                ? "simple-delivery-error"
                                : ticketReceived || requestAck
                                  ? "simple-delivery-ok"
                                  : requestDelivery
                                    ? "simple-delivery-waiting"
                                    : "simple-delivery-waiting"
                            }>
                              {ticketReceived
                                ? "Blinded ticket request acknowledged."
                                : requestAck
                                  ? "Blinded ticket request acknowledged."
                                  : requestDelivery?.status ?? "Waiting to send blinded ticket request."}
                            </li>
                            <li className={ticketReceived ? "simple-delivery-ok" : "simple-delivery-waiting"}>
                              {ticketReceived ? "Ticket received." : "Waiting for ticket."}
                            </li>
                          </ul>
                        );
                      })()}
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
              {reconciledRoundState.knownRounds.length > 1 ? (
                <>
                  <label className="simple-voter-label" htmlFor="simple-live-round">Round</label>
                  <select
                    id="simple-live-round"
                    className="simple-voter-input"
                    value={effectiveLiveVoteSession.votingId}
                    onChange={(event) => {
                      manualRoundSelectionRef.current = true;
                      setSelectedVotingId(event.target.value);
                    }}
                  >
                    {reconciledRoundState.knownRounds.map((round) => (
                      <option key={round.votingId} value={round.votingId}>
                        {shortVotingId(round.votingId)} - {round.prompt}
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

// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicKey, nip19 } from "nostr-tools";
import { createHash } from "node:crypto";
import { resetSimpleActorStateForTests, saveSimpleActorState } from "./simpleLocalState";

type InternalResponse = {
  id: string;
  dmEventId: string;
  requestId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  createdAt: string;
  recipientNpub: string;
  votingPrompt?: string;
  blindShareResponse: any;
  shardCertificate?: any;
};

type InternalLiveVote = {
  votingId: string;
  prompt: string;
  coordinatorNpub: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  authorizedCoordinatorNpubs: string[];
  eventId: string;
};

type InternalSubmittedVote = {
  eventId: string;
  votingId: string;
  voterNpub: string;
  choice: "Yes" | "No";
  shardProofs: any[];
  tokenId: string;
  createdAt: string;
};

let responseCounter = 0;
let voteCounter = 0;
let liveVotes: InternalLiveVote[] = [];
let shardResponses: InternalResponse[] = [];
let submittedVotes: InternalSubmittedVote[] = [];
let coordinatorFollowers: Array<{
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
  votingId?: string;
  createdAt: string;
}> = [];
let subCoordinatorApplications: Array<{
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  coordinatorId: string;
  createdAt: string;
}> = [];
let shareAssignments: Array<{
  leadCoordinatorNpub: string;
  coordinatorNpub: string;
  shareIndex: number;
  thresholdN?: number;
  createdAt: string;
}> = [];
let shardRequests: Array<{
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
  replyNpub: string;
  votingId: string;
  blindRequest: any;
  createdAt: string;
}> = [];
let blindAnnouncements: Record<string, any> = {};
let dmAcknowledgements: Array<{
  recipientNpub: string;
  ackedAction: string;
  ackedEventId: string;
  actorNpub: string;
  actorId?: string;
  coordinatorNpubs?: string[];
  votingId?: string;
  requestId?: string;
  responseId?: string;
  createdAt: string;
}> = [];
let followerSubscribers: Array<{
  coordinatorNpub: string;
  onFollowers: (followers: Array<{
    id: string;
    dmEventId: string;
    voterNpub: string;
    voterId: string;
    votingId?: string;
    createdAt: string;
  }>) => void;
}> = [];
let shardResponseSubscribers: Array<{
  recipientNpubs: string[];
  onResponses: (responses: InternalResponse[]) => void;
}> = [];
let liveVoteSubscribers: Array<{
  coordinatorNpub: string;
  onSession: (vote: InternalLiveVote | null) => void;
}> = [];
let liveVoteListSubscribers: Array<{
  coordinatorNpub: string;
  onSessions: (votes: InternalLiveVote[]) => void;
}> = [];
let submittedVoteSubscribers: Array<{
  votingId: string;
  onVotes: (votes: InternalSubmittedVote[]) => void;
}> = [];
let subCoordinatorApplicationSubscribers: Array<{
  leadCoordinatorNpub: string;
  onApplications: (applications: Array<{
    id: string;
    dmEventId: string;
    coordinatorNpub: string;
    coordinatorId: string;
    leadCoordinatorNpub: string;
    createdAt: string;
  }>) => void;
}> = [];
let shareAssignmentSubscribers: Array<{
  coordinatorNpub: string;
  onAssignments: (assignments: Array<{
    id: string;
    dmEventId: string;
    leadCoordinatorNpub: string;
    coordinatorNpub: string;
    shareIndex: number;
    thresholdN?: number;
    createdAt: string;
  }>) => void;
}> = [];
let shardRequestSubscribers: Array<{
  coordinatorNpub: string;
  onRequests: (requests: Array<{
    id: string;
    dmEventId: string;
    voterNpub: string;
    voterId: string;
    replyNpub: string;
    votingId: string;
    blindRequest: any;
    createdAt: string;
  }>) => void;
}> = [];
let dmAcknowledgementSubscribers: Array<{
  actorNpubs: string[];
  onAcknowledgements: (acknowledgements: Array<{
    id: string;
    ackedAction: string;
    ackedEventId: string;
    actorNpub: string;
    actorId?: string;
    votingId?: string;
    requestId?: string;
    responseId?: string;
    createdAt: string;
  }>) => void;
}> = [];
let coordinatorRosterAnnouncements: Array<{
  recipientNpub: string;
  leadCoordinatorNpub: string;
  coordinatorNpubs: string[];
  createdAt: string;
}> = [];
let coordinatorRosterSubscribers: Array<{
  recipientNpub: string;
  onAnnouncements: (announcements: Array<{
    id: string;
    dmEventId: string;
    leadCoordinatorNpub: string;
    coordinatorNpubs: string[];
    createdAt: string;
  }>) => void;
}> = [];
let blindAnnouncementSubscribers: Array<{
  coordinatorNpub: string;
  votingId?: string;
  onAnnouncement: (announcement: any | null) => void;
}> = [];
let suppressedShardResponseNotifications = new Set<string>();
const originalWebSocket = globalThis.WebSocket;

function sha(input: string) {
  return createHash("sha256").update(input).digest("hex");
}

function nsecToNpub(nsec: string) {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error("expected nsec");
  }
  return nip19.npubEncode(getPublicKey(decoded.data as Uint8Array));
}

function secretToNpub(secretKey: Uint8Array) {
  return nip19.npubEncode(getPublicKey(secretKey));
}

function makeTokenId(shardProofs: any[]) {
  const ids = shardProofs
    .map((proof) => `${proof.coordinatorNpub}:${proof.votingId}:${proof.tokenCommitment}:${proof.shareIndex}:${proof.keyAnnouncementEvent?.id ?? proof.id}`)
    .sort()
    .join("|");
  return sha(ids).slice(0, 16);
}

function followerEntriesForCoordinator(coordinatorNpub: string) {
  return coordinatorFollowers
    .filter((entry) => entry.coordinatorNpub === coordinatorNpub)
    .map((entry, index) => ({
      id: `follow-${index + 1}`,
      dmEventId: `follow-event-${index + 1}`,
      voterNpub: entry.voterNpub,
      voterId: entry.voterId,
      votingId: entry.votingId,
      createdAt: entry.createdAt,
    }));
}

function notifyFollowerSubscribers(coordinatorNpub: string) {
  const nextFollowers = followerEntriesForCoordinator(coordinatorNpub);
  for (const subscriber of followerSubscribers) {
    if (subscriber.coordinatorNpub === coordinatorNpub) {
      subscriber.onFollowers(nextFollowers);
    }
  }
}

function notifyShardResponseSubscribers(recipientNpub: string) {
  const nextResponses = shardResponses.filter((response) => response.recipientNpub === recipientNpub);
  for (const subscriber of shardResponseSubscribers) {
    if (subscriber.recipientNpubs.includes(recipientNpub)) {
      subscriber.onResponses(
        shardResponses.filter((response) => subscriber.recipientNpubs.includes(response.recipientNpub)),
      );
    }
  }
}

function latestLiveVoteForCoordinator(coordinatorNpub: string) {
  const matches = liveVotes.filter((vote) => vote.coordinatorNpub === coordinatorNpub);
  return matches[matches.length - 1] ?? null;
}

function notifyLiveVoteSubscribers(coordinatorNpub: string) {
  const nextVote = latestLiveVoteForCoordinator(coordinatorNpub);
  for (const subscriber of liveVoteSubscribers) {
    if (subscriber.coordinatorNpub === coordinatorNpub) {
      subscriber.onSession(nextVote);
    }
  }
  const nextVotes = liveVotes
    .filter((vote) => vote.coordinatorNpub === coordinatorNpub)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const subscriber of liveVoteListSubscribers) {
    if (subscriber.coordinatorNpub === coordinatorNpub) {
      subscriber.onSessions(nextVotes);
    }
  }
}

function notifySubmittedVoteSubscribers(votingId: string) {
  const nextVotes = submittedVotes.filter((vote) => vote.votingId === votingId);
  for (const subscriber of submittedVoteSubscribers) {
    if (subscriber.votingId === votingId) {
      subscriber.onVotes(nextVotes);
    }
  }
}

function subCoordinatorEntriesForLead(leadCoordinatorNpub: string) {
  return subCoordinatorApplications
    .filter((entry) => entry.leadCoordinatorNpub === leadCoordinatorNpub)
    .map((entry, index) => ({
      id: `application-${index + 1}`,
      dmEventId: `application-event-${index + 1}`,
      coordinatorNpub: entry.coordinatorNpub,
      coordinatorId: entry.coordinatorId,
      leadCoordinatorNpub: entry.leadCoordinatorNpub,
      createdAt: entry.createdAt,
    }));
}

function notifySubCoordinatorApplicationSubscribers(leadCoordinatorNpub: string) {
  const nextApplications = subCoordinatorEntriesForLead(leadCoordinatorNpub);
  for (const subscriber of subCoordinatorApplicationSubscribers) {
    if (subscriber.leadCoordinatorNpub === leadCoordinatorNpub) {
      subscriber.onApplications(nextApplications);
    }
  }
}

function shareAssignmentsForCoordinator(coordinatorNpub: string) {
  return shareAssignments
    .filter((entry) => entry.coordinatorNpub === coordinatorNpub)
    .map((entry, index) => ({
      id: `assignment-${index + 1}`,
      dmEventId: `assignment-event-${index + 1}`,
      leadCoordinatorNpub: entry.leadCoordinatorNpub,
      coordinatorNpub: entry.coordinatorNpub,
      shareIndex: entry.shareIndex,
      thresholdN: entry.thresholdN,
      createdAt: entry.createdAt,
    }));
}

function notifyShareAssignmentSubscribers(coordinatorNpub: string) {
  const nextAssignments = shareAssignmentsForCoordinator(coordinatorNpub);
  for (const subscriber of shareAssignmentSubscribers) {
    if (subscriber.coordinatorNpub === coordinatorNpub) {
      subscriber.onAssignments(nextAssignments);
    }
  }
}

function shardRequestsForCoordinator(coordinatorNpub: string) {
  return shardRequests
    .filter((entry) => entry.coordinatorNpub === coordinatorNpub)
    .map((entry, index) => ({
      id: `request-${index + 1}:${entry.blindRequest.requestId}`,
      dmEventId: `request-event-${index + 1}:${entry.blindRequest.requestId}`,
      voterNpub: entry.voterNpub,
      voterId: entry.voterId,
      replyNpub: entry.replyNpub,
      votingId: entry.votingId,
      blindRequest: entry.blindRequest,
      createdAt: entry.createdAt,
    }));
}

function notifyShardRequestSubscribers(coordinatorNpub: string) {
  const nextRequests = shardRequestsForCoordinator(coordinatorNpub);
  for (const subscriber of shardRequestSubscribers) {
    if (subscriber.coordinatorNpub === coordinatorNpub) {
      subscriber.onRequests(nextRequests);
    }
  }
}

function makeBlindAnnouncementKey(coordinatorNpub: string, votingId: string) {
  return `${coordinatorNpub}:${votingId}`;
}

function notifyBlindAnnouncementSubscribers(coordinatorNpub: string, votingId: string) {
  const nextAnnouncement = blindAnnouncements[makeBlindAnnouncementKey(coordinatorNpub, votingId)] ?? null;
  for (const subscriber of blindAnnouncementSubscribers) {
    if (subscriber.coordinatorNpub === coordinatorNpub && (!subscriber.votingId || subscriber.votingId === votingId)) {
      subscriber.onAnnouncement(nextAnnouncement);
    }
  }
}

function notifyDmAcknowledgementSubscribers(recipientNpub: string) {
  const nextAcknowledgements = dmAcknowledgements
    .filter((entry) => entry.recipientNpub === recipientNpub)
    .map((entry, index) => ({
      id: `ack-${index + 1}`,
      ackedAction: entry.ackedAction,
      ackedEventId: entry.ackedEventId,
      actorNpub: entry.actorNpub,
      actorId: entry.actorId,
      coordinatorNpubs: entry.coordinatorNpubs,
      votingId: entry.votingId,
      requestId: entry.requestId,
      responseId: entry.responseId,
      createdAt: entry.createdAt,
    }));
  for (const subscriber of dmAcknowledgementSubscribers) {
    if (subscriber.actorNpubs.includes(recipientNpub)) {
      subscriber.onAcknowledgements(nextAcknowledgements);
    }
  }
}

function notifyCoordinatorRosterSubscribers(recipientNpub: string) {
  const nextAnnouncements = coordinatorRosterAnnouncements
    .filter((entry) => entry.recipientNpub === recipientNpub)
    .map((entry, index) => ({
      id: `roster-${index + 1}`,
      dmEventId: `roster-event-${index + 1}`,
      leadCoordinatorNpub: entry.leadCoordinatorNpub,
      coordinatorNpubs: entry.coordinatorNpubs,
      createdAt: entry.createdAt,
    }));
  for (const subscriber of coordinatorRosterSubscribers) {
    if (subscriber.recipientNpub === recipientNpub) {
      subscriber.onAnnouncements(nextAnnouncements);
    }
  }
}

vi.mock("./SimpleQrScanner", () => ({
  default: () => null,
}));

vi.mock("./SimpleRelayPanel", () => ({
  default: () => null,
}));

vi.mock("./nip65RelayHints", () => ({
  publishOwnNip65RelayHints: vi.fn(async () => ({ successes: 1 })),
  primeNip65RelayHints: vi.fn(async () => undefined),
  setNip65EnabledForSession: vi.fn(() => undefined),
  resolveNip65InboxRelays: vi.fn(async ({ fallbackRelays }: { fallbackRelays: string[] }) => fallbackRelays),
  resolveNip65OutboxRelays: vi.fn(async ({ fallbackRelays }: { fallbackRelays: string[] }) => fallbackRelays),
  resolveNip65ConversationRelays: vi.fn(async ({ fallbackRelays }: { fallbackRelays: string[] }) => fallbackRelays),
}));

vi.mock("./TokenFingerprint", () => ({
  default: ({ tokenId }: { tokenId: string }) => <div data-testid="token-fingerprint">{tokenId}</div>,
}));

vi.mock("./tokenIdentity", () => ({
  sha256Hex: vi.fn(async (value: string) => sha(value)),
}));

vi.mock("./simpleShardCertificate", () => ({
  generateSimpleBlindKeyPair: vi.fn(async () => ({
    scheme: "rsa-blind-v1",
    keyId: `key-${Object.keys(blindAnnouncements).length + 1}`,
    bits: 3072,
    n: `n-${Object.keys(blindAnnouncements).length + 1}`,
    e: "10001",
    d: `d-${Object.keys(blindAnnouncements).length + 1}`,
  })),
  publishSimpleBlindKeyAnnouncement: vi.fn(async (input: { coordinatorNsec: string; votingId: string; publicKey: any }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    const announcement = {
      coordinatorNpub,
      votingId: input.votingId,
      publicKey: input.publicKey,
      createdAt: new Date().toISOString(),
      event: {
        id: `blind-key-${coordinatorNpub}-${input.votingId}`,
        kind: 38993,
        pubkey: coordinatorNpub,
      },
    };
    blindAnnouncements[makeBlindAnnouncementKey(coordinatorNpub, input.votingId)] = announcement;
    notifyBlindAnnouncementSubscribers(coordinatorNpub, input.votingId);
    return {
      eventId: announcement.event.id,
      successes: 1,
      failures: 0,
      createdAt: announcement.createdAt,
      event: announcement.event,
    };
  }),
  subscribeLatestSimpleBlindKeyAnnouncement: vi.fn((input: { coordinatorNpub: string; votingId?: string; onAnnouncement: (announcement: any | null) => void }) => {
    const subscriber = {
      coordinatorNpub: input.coordinatorNpub,
      votingId: input.votingId,
      onAnnouncement: input.onAnnouncement,
    };
    blindAnnouncementSubscribers.push(subscriber);
    input.onAnnouncement(
      input.votingId
        ? blindAnnouncements[makeBlindAnnouncementKey(input.coordinatorNpub, input.votingId)] ?? null
        : null,
    );
    return () => {
      blindAnnouncementSubscribers = blindAnnouncementSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  createSimpleBlindIssuanceRequest: vi.fn(async (input: { publicKey: any; votingId: string; tokenMessage?: string }) => {
    const requestId = `blind-request-${crypto.randomUUID()}`;
    return {
      request: {
        requestId,
        votingId: input.votingId,
        blindedMessage: `blinded:${requestId}`,
        createdAt: new Date().toISOString(),
      },
      secret: {
        requestId,
        votingId: input.votingId,
        tokenMessage: input.tokenMessage ?? `token:${input.votingId}:${requestId}`,
        blindingFactor: `factor:${requestId}`,
        publicKey: input.publicKey,
        createdAt: new Date().toISOString(),
      },
    };
  }),
  unblindSimpleBlindShare: vi.fn((input: { response: any; secret: any }) => ({
    shareId: input.response.shareId,
    requestId: input.response.requestId,
    coordinatorNpub: input.response.coordinatorNpub,
    votingId: input.secret.votingId,
    tokenMessage: input.secret.tokenMessage,
    unblindedSignature: `signature:${input.response.shareId}`,
    shareIndex: input.response.shareIndex,
    thresholdT: input.response.thresholdT,
    thresholdN: input.response.thresholdN,
    createdAt: input.response.createdAt,
    keyAnnouncementEvent: input.response.keyAnnouncementEvent,
  })),
  parseSimpleShardCertificate: vi.fn((certificate: any) => (
    certificate
      ? {
          shardId: certificate.shareId,
          requestId: certificate.requestId,
          coordinatorNpub: certificate.coordinatorNpub,
          votingId: certificate.votingId,
          tokenCommitment: certificate.tokenMessage,
          shareIndex: certificate.shareIndex,
          thresholdT: certificate.thresholdT,
          thresholdN: certificate.thresholdN,
          createdAt: certificate.createdAt,
          publicKey: { keyId: certificate.keyAnnouncementEvent?.id ?? "blind-key" },
          event: certificate,
        }
      : null
  )),
  parseSimplePublicShardProof: vi.fn((proof: any) => (
    proof
      ? {
          coordinatorNpub: proof.coordinatorNpub,
          votingId: proof.votingId,
          tokenCommitment: proof.tokenCommitment,
          shareIndex: proof.shareIndex,
          publicKey: proof.keyAnnouncementEvent?.content?.public_key ?? { keyId: proof.keyAnnouncementEvent?.id ?? "blind-key" },
          keyAnnouncement: {
            coordinatorNpub: proof.coordinatorNpub,
            votingId: proof.votingId,
            publicKey: proof.keyAnnouncementEvent?.content?.public_key ?? { keyId: proof.keyAnnouncementEvent?.id ?? "blind-key" },
            createdAt: proof.keyAnnouncementEvent?.created_at ?? new Date().toISOString(),
            event: proof.keyAnnouncementEvent,
          },
          event: proof,
        }
      : null
  )),
  verifySimplePublicShardProof: vi.fn(async (proof: any) => (
    proof
      ? {
          coordinatorNpub: proof.coordinatorNpub,
          votingId: proof.votingId,
          tokenCommitment: proof.tokenCommitment,
          shareIndex: proof.shareIndex,
          publicKey: proof.keyAnnouncementEvent?.content?.public_key ?? { keyId: proof.keyAnnouncementEvent?.id ?? "blind-key" },
          keyAnnouncement: {
            coordinatorNpub: proof.coordinatorNpub,
            votingId: proof.votingId,
            publicKey: proof.keyAnnouncementEvent?.content?.public_key ?? { keyId: proof.keyAnnouncementEvent?.id ?? "blind-key" },
            createdAt: proof.keyAnnouncementEvent?.created_at ?? new Date().toISOString(),
            event: proof.keyAnnouncementEvent,
          },
          event: proof,
        }
      : null
  )),
  deriveTokenIdFromSimplePublicShardProofs: vi.fn(async (proofs: any[]) => makeTokenId(proofs)),
}));

vi.mock("./simpleShardDm", () => ({
  SIMPLE_DM_RELAYS: [
    "wss://nip17.com",
    "wss://nip17.tomdwyer.uk",
    "wss://relay.nostr.band",
    "wss://nos.lol",
  ],
  sendSimpleCoordinatorFollow: vi.fn(async (input: {
    voterSecretKey: Uint8Array;
    coordinatorNpub: string;
    voterNpub: string;
    votingId?: string;
  }) => {
    coordinatorFollowers.push({
      coordinatorNpub: input.coordinatorNpub,
      voterNpub: input.voterNpub,
      voterId: sha(input.voterNpub).slice(0, 7),
      votingId: input.votingId,
      createdAt: new Date().toISOString(),
    });
    notifyFollowerSubscribers(input.coordinatorNpub);
    return { eventId: `follow-${coordinatorFollowers.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleCoordinatorFollowers: vi.fn((input: {
    coordinatorNsec: string;
    onFollowers: (followers: Array<{
      id: string;
      dmEventId: string;
      voterNpub: string;
      voterId: string;
      votingId?: string;
      createdAt: string;
    }>) => void;
  }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    const subscriber = {
      coordinatorNpub,
      onFollowers: input.onFollowers,
    };
    followerSubscribers.push(subscriber);
    input.onFollowers(followerEntriesForCoordinator(coordinatorNpub));
    return () => {
      followerSubscribers = followerSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  fetchSimpleCoordinatorFollowers: vi.fn(async (input: { coordinatorNsec: string }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    return followerEntriesForCoordinator(coordinatorNpub);
  }),
  sendSimpleSubCoordinatorJoin: vi.fn(async (input: {
    leadCoordinatorNpub: string;
    coordinatorNpub: string;
  }) => {
    subCoordinatorApplications.push({
      leadCoordinatorNpub: input.leadCoordinatorNpub,
      coordinatorNpub: input.coordinatorNpub,
      coordinatorId: sha(input.coordinatorNpub).slice(0, 7),
      createdAt: new Date().toISOString(),
    });
    notifySubCoordinatorApplicationSubscribers(input.leadCoordinatorNpub);
    return { eventId: `subcoord-${subCoordinatorApplications.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleSubCoordinatorApplications: vi.fn((input: {
    leadCoordinatorNsec: string;
    onApplications: (applications: Array<{
      id: string;
      dmEventId: string;
      coordinatorNpub: string;
      coordinatorId: string;
      leadCoordinatorNpub: string;
      createdAt: string;
    }>) => void;
  }) => {
    const leadCoordinatorNpub = nsecToNpub(input.leadCoordinatorNsec);
    const subscriber = {
      leadCoordinatorNpub,
      onApplications: input.onApplications,
    };
    subCoordinatorApplicationSubscribers.push(subscriber);
    input.onApplications(subCoordinatorEntriesForLead(leadCoordinatorNpub));
    return () => {
      subCoordinatorApplicationSubscribers = subCoordinatorApplicationSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  sendSimpleShareAssignment: vi.fn(async (input: {
    leadCoordinatorNpub: string;
    coordinatorNpub: string;
    shareIndex: number;
    thresholdN?: number;
  }) => {
    shareAssignments.push({
      leadCoordinatorNpub: input.leadCoordinatorNpub,
      coordinatorNpub: input.coordinatorNpub,
      shareIndex: input.shareIndex,
      thresholdN: input.thresholdN,
      createdAt: new Date().toISOString(),
    });
    notifyShareAssignmentSubscribers(input.coordinatorNpub);
    return { eventId: `assignment-${shareAssignments.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleCoordinatorShareAssignments: vi.fn((input: {
    coordinatorNsec: string;
    onAssignments: (assignments: Array<{
      id: string;
      dmEventId: string;
      leadCoordinatorNpub: string;
      coordinatorNpub: string;
      shareIndex: number;
      thresholdN?: number;
      createdAt: string;
    }>) => void;
  }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    const subscriber = {
      coordinatorNpub,
      onAssignments: input.onAssignments,
    };
    shareAssignmentSubscribers.push(subscriber);
    input.onAssignments(shareAssignmentsForCoordinator(coordinatorNpub));
    return () => {
      shareAssignmentSubscribers = shareAssignmentSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  sendSimpleShardRequest: vi.fn(async (input: {
    coordinatorNpub: string;
    voterNpub: string;
    replyNpub: string;
    votingId: string;
    blindRequest: any;
  }) => {
    shardRequests.push({
      coordinatorNpub: input.coordinatorNpub,
      voterNpub: input.voterNpub,
      voterId: sha(input.voterNpub).slice(0, 7),
      replyNpub: input.replyNpub,
      votingId: input.votingId,
      blindRequest: input.blindRequest,
      createdAt: new Date().toISOString(),
    });
    notifyShardRequestSubscribers(input.coordinatorNpub);
    return { eventId: `request-${shardRequests.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleShardRequests: vi.fn((input: {
    coordinatorNsec: string;
    onRequests: (requests: Array<{
      id: string;
      dmEventId: string;
      voterNpub: string;
      voterId: string;
      replyNpub: string;
      votingId: string;
      blindRequest: any;
      createdAt: string;
    }>) => void;
  }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    const subscriber = {
      coordinatorNpub,
      onRequests: input.onRequests,
    };
    shardRequestSubscribers.push(subscriber);
    input.onRequests(shardRequestsForCoordinator(coordinatorNpub));
    return () => {
      shardRequestSubscribers = shardRequestSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  fetchSimpleShardRequests: vi.fn(async (input: { coordinatorNsec: string }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    return shardRequestsForCoordinator(coordinatorNpub);
  }),
  sendSimpleRoundTicket: vi.fn(async (input: {
    coordinatorSecretKey: Uint8Array;
    blindPrivateKey: any;
    keyAnnouncementEvent: any;
    recipientNpub: string;
    coordinatorNpub: string;
    thresholdLabel: string;
    request: {
      id: string;
      replyNpub: string;
      votingId: string;
      blindRequest: {
        requestId: string;
      };
    };
    votingPrompt: string;
    shareIndex: number;
    thresholdT?: number;
    thresholdN?: number;
  }) => {
    const responseId = `response-${++responseCounter}`;
    const nextResponse = {
      id: responseId,
      dmEventId: `dm-response-${responseCounter}`,
      requestId: input.request.blindRequest.requestId,
      coordinatorNpub: input.coordinatorNpub,
      coordinatorId: sha(input.coordinatorNpub).slice(0, 7),
      thresholdLabel: input.thresholdLabel,
      createdAt: new Date().toISOString(),
      recipientNpub: input.recipientNpub,
      votingPrompt: input.votingPrompt,
      blindShareResponse: {
        shareId: responseId,
        requestId: input.request.blindRequest.requestId,
        coordinatorNpub: input.coordinatorNpub,
        blindedSignature: `blind-signature:${responseId}`,
        shareIndex: input.shareIndex,
        thresholdT: input.thresholdT,
        thresholdN: input.thresholdN,
        createdAt: new Date().toISOString(),
        keyAnnouncementEvent: input.keyAnnouncementEvent,
      },
    };
    shardResponses.push(nextResponse);
    if (
      !suppressedShardResponseNotifications.has(input.recipientNpub)
    ) {
      notifyShardResponseSubscribers(input.recipientNpub);
    }
    return { responseId, eventId: `dm-response-${responseCounter}`, successes: 1, failures: 0, relayResults: [] };
  }),
  fetchSimpleShardResponses: vi.fn(async (input: { voterNsec: string; voterNsecs?: string[] }) => {
    const voterNpubs = [input.voterNsec, ...(input.voterNsecs ?? [])].map((value) => nsecToNpub(value) as string);
    return shardResponses.filter((response) => voterNpubs.includes(response.recipientNpub));
  }),
  subscribeSimpleShardResponses: vi.fn((input: {
    voterNsec: string;
    voterNsecs?: string[];
    onResponses: (responses: InternalResponse[]) => void;
  }) => {
    const recipientNpubs = [input.voterNsec, ...(input.voterNsecs ?? [])].map((value) => nsecToNpub(value) as string);
    const subscriber = {
      recipientNpubs,
      onResponses: input.onResponses,
    };
    shardResponseSubscribers.push(subscriber);
    input.onResponses(shardResponses.filter((response) => recipientNpubs.includes(response.recipientNpub)));
    return () => {
      shardResponseSubscribers = shardResponseSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  sendSimpleDmAcknowledgement: vi.fn(async (input: {
    recipientNpub: string;
    ackedAction: string;
    ackedEventId: string;
    actorNpub: string;
    coordinatorNpubs?: string[];
    votingId?: string;
    requestId?: string;
    responseId?: string;
  }) => {
    dmAcknowledgements.push({
      recipientNpub: input.recipientNpub,
      ackedAction: input.ackedAction,
      ackedEventId: input.ackedEventId,
      actorNpub: input.actorNpub,
      actorId: sha(input.actorNpub).slice(0, 7),
      coordinatorNpubs: input.coordinatorNpubs,
      votingId: input.votingId,
      requestId: input.requestId,
      responseId: input.responseId,
      createdAt: new Date().toISOString(),
    });
    notifyDmAcknowledgementSubscribers(input.recipientNpub);
    return { eventId: `ack-event-${dmAcknowledgements.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleDmAcknowledgements: vi.fn((input: {
    actorNsec: string;
    actorNsecs?: string[];
    onAcknowledgements: (acknowledgements: Array<{
      id: string;
      ackedAction: string;
      ackedEventId: string;
      actorNpub: string;
      actorId?: string;
      coordinatorNpubs?: string[];
      votingId?: string;
      requestId?: string;
      responseId?: string;
      createdAt: string;
    }>) => void;
  }) => {
    const actorNpubs = [input.actorNsec, ...(input.actorNsecs ?? [])].map((value) => nsecToNpub(value));
    const subscriber = {
      actorNpubs,
      onAcknowledgements: input.onAcknowledgements,
    };
    dmAcknowledgementSubscribers.push(subscriber);
    for (const actorNpub of actorNpubs) {
      notifyDmAcknowledgementSubscribers(actorNpub);
    }
    return () => {
      dmAcknowledgementSubscribers = dmAcknowledgementSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  fetchSimpleDmAcknowledgements: vi.fn(async (input: { actorNsec: string; actorNsecs?: string[] }) => {
    const actorNpubs = [input.actorNsec, ...(input.actorNsecs ?? [])].map((value) => nsecToNpub(value) as string);
    return dmAcknowledgements.filter((ack) => actorNpubs.includes(ack.recipientNpub));
  }),
  sendSimpleCoordinatorRoster: vi.fn(async (input: {
    recipientNpub: string;
    leadCoordinatorNpub: string;
    coordinatorNpubs: string[];
  }) => {
    coordinatorRosterAnnouncements.push({
      recipientNpub: input.recipientNpub,
      leadCoordinatorNpub: input.leadCoordinatorNpub,
      coordinatorNpubs: input.coordinatorNpubs,
      createdAt: new Date().toISOString(),
    });
    notifyCoordinatorRosterSubscribers(input.recipientNpub);
    return { eventId: `roster-event-${coordinatorRosterAnnouncements.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleCoordinatorRosterAnnouncements: vi.fn((input: {
    voterNsec: string;
    onAnnouncements: (announcements: Array<{
      id: string;
      dmEventId: string;
      leadCoordinatorNpub: string;
      coordinatorNpubs: string[];
      createdAt: string;
    }>) => void;
  }) => {
    const recipientNpub = nsecToNpub(input.voterNsec);
    const subscriber = {
      recipientNpub,
      onAnnouncements: input.onAnnouncements,
    };
    coordinatorRosterSubscribers.push(subscriber);
    notifyCoordinatorRosterSubscribers(recipientNpub);
    return () => {
      coordinatorRosterSubscribers = coordinatorRosterSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
}));

vi.mock("./simpleVotingSession", () => ({
  SIMPLE_PUBLIC_RELAYS: [
    "wss://nos.lol",
    "wss://relay.snort.social",
    "wss://relay.nostr.band",
    "wss://relay.damus.io",
  ],
  publishSimpleLiveVote: vi.fn(async (input: {
    coordinatorNsec: string;
    prompt: string;
    votingId?: string;
    thresholdT?: number;
    thresholdN?: number;
    authorizedCoordinatorNpubs?: string[];
  }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    const votingId = input.votingId?.trim() || `round-${liveVotes.length + 1}`;
    const liveVote = {
      votingId,
      prompt: input.prompt,
      coordinatorNpub,
      createdAt: new Date().toISOString(),
      thresholdT: input.thresholdT,
      thresholdN: input.thresholdN,
      authorizedCoordinatorNpubs: input.authorizedCoordinatorNpubs ?? [coordinatorNpub],
      eventId: `live-${liveVotes.length + 1}`,
    };
    liveVotes = [...liveVotes.filter((entry) => !(entry.coordinatorNpub === coordinatorNpub && entry.votingId === votingId)), liveVote];
    notifyLiveVoteSubscribers(coordinatorNpub);
    return {
      votingId,
      eventId: liveVote.eventId,
      coordinatorNpub,
      createdAt: liveVote.createdAt,
      successes: 1,
      failures: 0,
      relayResults: [],
    };
  }),
  subscribeLatestSimpleLiveVote: vi.fn((input: {
    coordinatorNpub: string;
    onSession: (vote: InternalLiveVote | null) => void;
  }) => {
    const subscriber = {
      coordinatorNpub: input.coordinatorNpub,
      onSession: input.onSession,
    };
    liveVoteSubscribers.push(subscriber);
    input.onSession(latestLiveVoteForCoordinator(input.coordinatorNpub));
    return () => {
      liveVoteSubscribers = liveVoteSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  fetchLatestSimpleLiveVote: vi.fn(async (input: { coordinatorNpub: string }) => {
    return latestLiveVoteForCoordinator(input.coordinatorNpub);
  }),
  subscribeSimpleLiveVotes: vi.fn((input: {
    coordinatorNpub: string;
    onSessions: (votes: InternalLiveVote[]) => void;
  }) => {
    const subscriber = {
      coordinatorNpub: input.coordinatorNpub,
      onSessions: input.onSessions,
    };
    liveVoteListSubscribers.push(subscriber);
    input.onSessions(
      liveVotes
        .filter((vote) => vote.coordinatorNpub === input.coordinatorNpub)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    );
    return () => {
      liveVoteListSubscribers = liveVoteListSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
  fetchSimpleLiveVotes: vi.fn(async () => (
    [...liveVotes].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  )),
  publishSimpleSubmittedVote: vi.fn(async (input: {
    ballotNsec: string;
    votingId: string;
    choice: "Yes" | "No";
    shardCertificates: any[];
  }) => {
    const ballotNpub = nsecToNpub(input.ballotNsec);
    const createdAt = new Date().toISOString();
    const shardProofs = input.shardCertificates.map((certificate) => ({
      coordinatorNpub: certificate.coordinatorNpub,
      votingId: certificate.votingId,
      tokenCommitment: certificate.tokenMessage,
      unblindedSignature: certificate.unblindedSignature,
      shareIndex: certificate.shareIndex,
      keyAnnouncementEvent: certificate.keyAnnouncementEvent,
    }));
    submittedVotes.push({
      eventId: `ballot-${++voteCounter}`,
      votingId: input.votingId,
      voterNpub: ballotNpub,
      choice: input.choice,
      shardProofs,
      tokenId: makeTokenId(shardProofs),
      createdAt,
    });
    notifySubmittedVoteSubscribers(input.votingId);
    return {
      eventId: `ballot-${voteCounter}`,
      ballotNpub,
      createdAt,
      successes: 1,
      failures: 0,
      relayResults: [],
    };
  }),
  subscribeSimpleSubmittedVotes: vi.fn((input: {
    votingId: string;
    onVotes: (votes: InternalSubmittedVote[]) => void;
  }) => {
    const subscriber = {
      votingId: input.votingId,
      onVotes: input.onVotes,
    };
    submittedVoteSubscribers.push(subscriber);
    input.onVotes(submittedVotes.filter((vote) => vote.votingId === input.votingId));
    return () => {
      submittedVoteSubscribers = submittedVoteSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
}));

describe("Simple round flow", () => {
  beforeEach(async () => {
    class MockWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = MockWebSocket.OPEN;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        queueMicrotask(() => {
          this.dispatchEvent(new Event("open"));
        });
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.dispatchEvent(new Event("close"));
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    responseCounter = 0;
    voteCounter = 0;
    liveVotes = [{
      votingId: "old-round",
      prompt: "Old stale prompt",
      coordinatorNpub: secretToNpub(new Uint8Array(32).fill(7)),
      createdAt: "2026-03-31T11:00:00.000Z",
      thresholdT: 1,
      thresholdN: 1,
      authorizedCoordinatorNpubs: [secretToNpub(new Uint8Array(32).fill(7))],
      eventId: "live-old",
    }];
    shardResponses = [];
    submittedVotes = [];
    coordinatorFollowers = [];
    subCoordinatorApplications = [];
    shareAssignments = [];
    shardRequests = [];
    blindAnnouncements = {};
    dmAcknowledgements = [];
    coordinatorRosterAnnouncements = [];
    followerSubscribers = [];
    shardResponseSubscribers = [];
    liveVoteSubscribers = [];
    liveVoteListSubscribers = [];
    submittedVoteSubscribers = [];
    subCoordinatorApplicationSubscribers = [];
    shareAssignmentSubscribers = [];
    shardRequestSubscribers = [];
    dmAcknowledgementSubscribers = [];
    coordinatorRosterSubscribers = [];
    blindAnnouncementSubscribers = [];
    suppressedShardResponseNotifications = new Set();
    window.sessionStorage.clear();
    await resetSimpleActorStateForTests();
  });

  afterEach(async () => {
    globalThis.WebSocket = originalWebSocket;
    cleanup();
    vi.useRealTimers();
    window.sessionStorage.clear();
    await resetSimpleActorStateForTests();
  });

  it("restores voter and coordinator identities from pasted nsec", async () => {
    const user = userEvent.setup();
    const { default: SimpleCoordinatorApp } = await import("./SimpleCoordinatorApp");
    const { default: SimpleUiApp } = await import("./SimpleUiApp");

    const coordinator = render(<SimpleCoordinatorApp />);
    const voter = render(<SimpleUiApp />);

    const voterSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const voterNsec = nip19.nsecEncode(voterSecretKey);
    const voterNpub = nip19.npubEncode(getPublicKey(voterSecretKey));
    const coordinatorSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecretKey);
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecretKey));

    const coordinatorUi = within(coordinator.container);
    const voterUi = within(voter.container);

    await user.click(voterUi.getByRole("tab", { name: /^Settings$/i }));
    await user.click(coordinatorUi.getByRole("tab", { name: /^Settings$/i }));
    const voterRestoreInput = await voterUi.findByPlaceholderText("nsec1...");
    await user.clear(voterRestoreInput);
    await user.type(voterRestoreInput, voterNsec);
    await user.click(voterUi.getByRole("button", { name: /^Restore$/i }));
    await user.click(voterUi.getByRole("tab", { name: /^Settings$/i }));

    const coordinatorRestoreInput = await coordinatorUi.findByPlaceholderText("nsec1...");
    await user.clear(coordinatorRestoreInput);
    await user.type(coordinatorRestoreInput, coordinatorNsec);
    await user.click(coordinatorUi.getByRole("button", { name: /^Restore$/i }));
    await user.click(coordinatorUi.getByRole("tab", { name: /^Settings$/i }));

    await waitFor(() => {
      expect(voterUi.getByText("Identity restored from nsec.")).toBeTruthy();
      expect(coordinatorUi.getByText("Identity restored from nsec.")).toBeTruthy();
      expect(voter.container.querySelectorAll("code.simple-identity-code")[0]?.textContent).toBe(voterNpub);
      expect(voter.container.querySelectorAll("code.simple-identity-code")[1]?.textContent).toBe("Hidden");
      expect(coordinator.container.querySelectorAll("code.simple-identity-code")[0]?.textContent).toBe(coordinatorNpub);
      expect(coordinator.container.querySelectorAll("code.simple-identity-code")[1]?.textContent).toBe("Hidden");
    });

    await user.click(voterUi.getByRole("tab", { name: /^Settings$/i }));
    await user.click(voterUi.getByRole("button", { name: "Click to reveal" }));
    await user.click(coordinatorUi.getByRole("button", { name: "Click to reveal" }));

    await waitFor(() => {
      expect(voter.container.querySelectorAll("code.simple-identity-code")[1]?.textContent).toBe(voterNsec);
      expect(coordinator.container.querySelectorAll("code.simple-identity-code")[1]?.textContent).toBe(coordinatorNsec);
    });
  });

  it("normalizes legacy coordinator rounds without authorized coordinator roster", async () => {
    const { default: SimpleCoordinatorApp } = await import("./SimpleCoordinatorApp");

    const coordinatorSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecretKey);
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecretKey));

    liveVotes = [{
      votingId: "legacy-round",
      prompt: "Legacy cached prompt",
      coordinatorNpub,
      createdAt: "2026-04-02T00:00:00.000Z",
      thresholdT: 1,
      thresholdN: 1,
      eventId: "legacy-event",
    } as unknown as InternalLiveVote];

    await saveSimpleActorState({
      role: "coordinator",
      keypair: {
        nsec: coordinatorNsec,
        npub: coordinatorNpub,
      },
      updatedAt: new Date().toISOString(),
      cache: {
        leadCoordinatorNpub: "",
        followers: [],
        subCoordinators: [],
        ticketDeliveries: {},
        pendingRequests: [],
        registrationStatus: null,
        assignmentStatus: null,
        questionPrompt: "Should the proposal pass?",
        questionThresholdT: "1",
        questionThresholdN: "1",
        questionShareIndex: "1",
        roundBlindPrivateKeys: {},
        roundBlindKeyAnnouncements: {},
        publishStatus: null,
        publishedVotes: [{
          votingId: "legacy-round",
          prompt: "Legacy cached prompt",
          coordinatorNpub,
          createdAt: "2026-04-02T00:00:00.000Z",
          thresholdT: 1,
          thresholdN: 1,
          eventId: "legacy-event",
        }],
        selectedVotingId: "legacy-round",
        selectedSubmittedVotingId: "legacy-round",
        submittedVotes: [],
      },
    });

    const coordinator = render(<SimpleCoordinatorApp />);
    const coordinatorUi = within(coordinator.container);

    await userEvent.setup().click(coordinatorUi.getByRole("tab", { name: /^Voting$/i }));

    await waitFor(() => {
      expect(coordinatorUi.getByText(/Live prompt: Legacy cached prompt/i)).toBeTruthy();
      expect(coordinatorUi.getByText(/This coordinator share index:\s*1/i)).toBeTruthy();
    });
  });

  it("keeps send ticket disabled until the blinded ticket request is received", async () => {
    const user = userEvent.setup();
    const { default: SimpleCoordinatorApp } = await import("./SimpleCoordinatorApp");
    const votingSession = await import("./simpleVotingSession");
    const publishSimpleLiveVoteMock = vi.mocked(votingSession.publishSimpleLiveVote);
    publishSimpleLiveVoteMock.mockClear();

    const coordinatorSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 65);
    const coordinatorNsec = nip19.nsecEncode(coordinatorSecretKey);
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecretKey));

    liveVotes = [{
      votingId: "legacy-round",
      prompt: "Legacy cached prompt",
      coordinatorNpub,
      createdAt: "2026-04-02T00:00:00.000Z",
      thresholdT: 1,
      thresholdN: 1,
      authorizedCoordinatorNpubs: [coordinatorNpub],
      eventId: "legacy-event",
    }];
    coordinatorFollowers = [{
      coordinatorNpub,
      voterNpub: "npub1voterxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      voterId: "abc1234",
      createdAt: "2026-04-02T00:01:00.000Z",
    }];

    await saveSimpleActorState({
      role: "coordinator",
      keypair: {
        nsec: coordinatorNsec,
        npub: coordinatorNpub,
      },
      updatedAt: new Date().toISOString(),
      cache: {
        leadCoordinatorNpub: "",
        followers: [{
          id: "follower-1",
          dmEventId: "follow-event-1",
          voterNpub: "npub1voterxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          voterId: "abc1234",
          createdAt: "2026-04-02T00:01:00.000Z",
        }],
        subCoordinators: [],
        ticketDeliveries: {},
        pendingRequests: [],
        registrationStatus: null,
        assignmentStatus: null,
        questionPrompt: "Should the proposal pass?",
        questionThresholdT: "1",
        questionThresholdN: "1",
        questionShareIndex: "1",
        roundBlindPrivateKeys: {
          "legacy-round": {
            scheme: "rsabssa-sha384-pss-randomized-v1",
            modulus: "c3Q",
            exponent: "AQAB",
            privateExponent: "c3Q",
            primeP: "cA",
            primeQ: "cQ",
            publicKeyJwk: {
              kty: "RSA",
              n: "c3Q",
              e: "AQAB",
              alg: "PS384",
              key_ops: ["verify"],
              ext: true,
            },
            hash: "SHA-384",
            saltLength: 48,
          } as any,
        },
        roundBlindKeyAnnouncements: {
          "legacy-round": {
            coordinatorNpub,
            votingId: "legacy-round",
            publicKey: {
              scheme: "rsabssa-sha384-pss-randomized-v1",
              keyId: "legacy-key-id",
              modulus: "c3Q",
              exponent: "AQAB",
              keyBits: 3072,
              hash: "SHA-384",
              saltLength: 48,
            },
            createdAt: "2026-04-02T00:00:00.000Z",
            event: { id: "blind-key-event" },
          } as any,
        },
        publishStatus: null,
        publishedVotes: [{
          votingId: "legacy-round",
          prompt: "Legacy cached prompt",
          coordinatorNpub,
          createdAt: "2026-04-02T00:00:00.000Z",
          thresholdT: 1,
          thresholdN: 1,
          authorizedCoordinatorNpubs: [coordinatorNpub],
          eventId: "legacy-event",
        }],
        selectedVotingId: "legacy-round",
        selectedSubmittedVotingId: "legacy-round",
        submittedVotes: [],
      },
    });

    const coordinator = render(<SimpleCoordinatorApp />);
    const coordinatorUi = within(coordinator.container);

    await user.click(coordinatorUi.getByRole("tab", { name: /^Voting$/i }));

    await waitFor(() => {
      expect(
        coordinatorUi.getByText(/Waiting for this voter's blinded ticket request\./i),
      ).toBeTruthy();
    });

    expect(
      (coordinatorUi.getByRole("button", { name: /Resend on fail/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.click(coordinatorUi.getByRole("button", { name: /Resend round info/i }));

    await waitFor(() => {
      expect(publishSimpleLiveVoteMock).toHaveBeenCalledWith(expect.objectContaining({
        coordinatorNsec,
        votingId: "legacy-round",
        prompt: "Legacy cached prompt",
      }));
    });
  });

  it("clears voter coordinators on refresh id and does not restore them on reload", async () => {
    const user = userEvent.setup();
    const { default: SimpleUiApp } = await import("./SimpleUiApp");

    const firstRender = render(<SimpleUiApp />);
    const firstUi = within(firstRender.container);

    await user.click(firstUi.getByRole("button", { name: /New/i }));
    const coordinatorInput = await firstUi.findByPlaceholderText(
      'Enter coordinator npub...',
    );
    await user.type(coordinatorInput, "npub1examplecoordinatorxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    await user.click(firstUi.getByRole("button", { name: /Add coordinator/i }));

    await waitFor(() => {
      expect(
        firstUi.getByText("Coordinator 1", {
          selector: ".simple-coordinator-card-title",
        }),
      ).toBeTruthy();
    });

    await user.click(firstUi.getByRole("button", { name: /New/i }));

    await waitFor(() => {
      expect(
        firstUi.queryByText("Coordinator 1", {
          selector: ".simple-coordinator-card-title",
        }),
      ).toBeNull();
      expect(firstUi.getByText(/No coordinators added yet\./i)).toBeTruthy();
    });

    firstRender.unmount();

    const secondRender = render(<SimpleUiApp />);
    const secondUi = within(secondRender.container);

    await waitFor(() => {
      expect(secondUi.getByText(/No coordinators added yet\./i)).toBeTruthy();
      expect(secondUi.queryByText(/Coordinator 1/i)).toBeNull();
    });
  });

  it("simulates a two-coordinator two-voter voting round", async () => {
    const user = userEvent.setup();
    const { default: SimpleCoordinatorApp } = await import("./SimpleCoordinatorApp");
    const { default: SimpleUiApp } = await import("./SimpleUiApp");

    const coordinatorOne = render(<SimpleCoordinatorApp />);
    const coordinatorTwo = render(<SimpleCoordinatorApp />);
    const voterOne = render(<SimpleUiApp />);
    const voterTwo = render(<SimpleUiApp />);

    const coordinatorOneUi = within(coordinatorOne.container);
    const coordinatorTwoUi = within(coordinatorTwo.container);
    const voterOneUi = within(voterOne.container);
    const voterTwoUi = within(voterTwo.container);

    await user.click(coordinatorOneUi.getByRole('button', { name: /New ID/i }));
    await user.click(coordinatorTwoUi.getByRole('button', { name: /New ID/i }));
    await user.click(voterOneUi.getByRole("button", { name: /New/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /New/i }));
    await user.click(coordinatorOneUi.getByRole("tab", { name: /^Settings$/i }));
    await user.click(coordinatorTwoUi.getByRole("tab", { name: /^Settings$/i }));
    await user.click(voterOneUi.getByRole("tab", { name: /^Settings$/i }));
    await user.click(voterTwoUi.getByRole("tab", { name: /^Settings$/i }));

    await waitFor(() => {
      expect(coordinatorOne.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(coordinatorTwo.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(voterOne.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(voterTwo.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
    });

    const coordinatorOneCodes = coordinatorOne.container.querySelectorAll("code.simple-identity-code");
    const coordinatorTwoCodes = coordinatorTwo.container.querySelectorAll("code.simple-identity-code");
    const coordinatorOneNpub = coordinatorOneCodes[0]?.textContent ?? "";
    const coordinatorTwoNpub = coordinatorTwoCodes[0]?.textContent ?? "";

    expect(coordinatorOneNpub.startsWith("npub1")).toBe(true);
    expect(coordinatorTwoNpub.startsWith("npub1")).toBe(true);
    expect(coordinatorOneNpub).not.toBe(coordinatorTwoNpub);

    await user.click(coordinatorOneUi.getByRole("tab", { name: /^Configure$/i }));
    await user.click(coordinatorTwoUi.getByRole("tab", { name: /^Configure$/i }));
    const coordinatorTwoLeadInput = coordinatorTwoUi.getByPlaceholderText("Leave blank if this coordinator is the lead");
    await user.clear(coordinatorTwoLeadInput);
    await user.type(coordinatorTwoLeadInput, coordinatorOneNpub);
    await user.click(coordinatorTwoUi.getByRole("button", { name: /Submit to lead/i }));

    await waitFor(() => {
      expect(voterOne.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(voterTwo.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
    });
    await user.click(voterOneUi.getByRole("tab", { name: /^Configure$/i }));
    await user.click(voterTwoUi.getByRole("tab", { name: /^Configure$/i }));
    await user.type(
      voterOneUi.getByPlaceholderText('Enter coordinator npub...'),
      coordinatorOneNpub,
    );
    await user.click(voterOneUi.getByRole("button", { name: /Add coordinator/i }));
    await user.type(
      voterTwoUi.getByPlaceholderText('Enter coordinator npub...'),
      coordinatorOneNpub,
    );
    await user.click(voterTwoUi.getByRole("button", { name: /Add coordinator/i }));

    await waitFor(() => {
      expect(
        voterOneUi.getByText(
          /(?:Coordinators notified|Additional coordinators received)\..*Waiting for round tickets\./i,
        ),
      ).toBeTruthy();
      expect(
        voterTwoUi.getByText(
          /(?:Coordinators notified|Additional coordinators received)\..*Waiting for round tickets\./i,
        ),
      ).toBeTruthy();
      expect(coordinatorOneUi.getByText(/submitted as sub-coordinator/i)).toBeTruthy();
    });

    await user.click(coordinatorOneUi.getByRole("tab", { name: /^Voting$/i }));
    await user.click(coordinatorTwoUi.getByRole("tab", { name: /^Voting$/i }));
    await user.click(coordinatorOneUi.getByRole("button", { name: /Increase Threshold T/i }));
    await user.click(coordinatorOneUi.getByRole("button", { name: /Broadcast live vote/i }));
    await user.click(coordinatorOneUi.getByRole("button", { name: /Distribute share indexes/i }));
    await user.click(voterOneUi.getByRole("tab", { name: /^Vote$/i }));
    await user.click(voterTwoUi.getByRole("tab", { name: /^Vote$/i }));

    const firstRoundId = liveVotes[liveVotes.length - 1]?.votingId ?? "";
    expect(firstRoundId).toBeTruthy();

    await waitFor(() => {
      expect(voterOneUi.getByText(/Tickets ready: 0 of 2/i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Tickets ready: 0 of 2/i)).toBeTruthy();
      expect(coordinatorOneUi.getAllByText(/is following this coordinator/i).length).toBeGreaterThanOrEqual(2);
      expect(coordinatorTwoUi.getAllByText(/is following this coordinator/i).length).toBeGreaterThanOrEqual(2);
      expect(coordinatorTwoUi.getByDisplayValue("2")).toBeTruthy();
    });
    expect(voterOneUi.queryByText("Old stale prompt")).toBeNull();
    expect(voterTwoUi.queryByText("Old stale prompt")).toBeNull();

    await waitFor(() => {
      expect(coordinatorOneUi.getAllByRole("button", { name: /Resend on fail/i })).toHaveLength(2);
      expect(coordinatorTwoUi.getAllByRole("button", { name: /Resend on fail/i })).toHaveLength(2);
    });

    for (const button of coordinatorOneUi.getAllByRole("button", { name: /Resend on fail/i })) {
      await user.click(button);
    }
    for (const button of coordinatorTwoUi.getAllByRole("button", { name: /Resend on fail/i })) {
      await user.click(button);
    }

    await user.click(voterOneUi.getByRole("button", { name: /Show details/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /Show details/i }));

    await waitFor(() => {
      expect(voterOneUi.getByText(/Tickets ready: 2 of 2/i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Tickets ready: 2 of 2/i)).toBeTruthy();
      expect(voterOneUi.getAllByText(firstRoundId).length).toBeGreaterThanOrEqual(1);
      expect(voterTwoUi.getAllByText(firstRoundId).length).toBeGreaterThanOrEqual(1);
      expect(voterOneUi.getAllByText("1").length).toBeGreaterThanOrEqual(2);
      expect(voterTwoUi.getAllByText("1").length).toBeGreaterThanOrEqual(2);
      expect(voterOneUi.getByText(/Vote ticket received/i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Vote ticket received/i)).toBeTruthy();
      expect(coordinatorOneUi.getAllByText(/Voter acknowledged ticket receipt\./i).length).toBeGreaterThanOrEqual(2);
      expect(coordinatorTwoUi.getAllByText(/Voter acknowledged ticket receipt\./i).length).toBeGreaterThanOrEqual(2);
    });

    await user.click(coordinatorOneUi.getByRole("tab", { name: /^Voting$/i }));
    const questionSection = coordinatorOneUi.getByRole("heading", { name: /^Question$/i }).closest("section");
    expect(questionSection).toBeTruthy();
    const leadQuestionInput = within(questionSection as HTMLElement).getByLabelText(/^Question$/i);
    await user.clear(leadQuestionInput);
    await user.type(leadQuestionInput, "Second question");
    await user.click(coordinatorOneUi.getByRole("button", { name: /Broadcast live vote/i }));

    await waitFor(() => {
      const roundSelector = coordinatorOne.container.querySelector("select#simple-active-round");
      expect(roundSelector).toBeTruthy();
      const roundOptions = within(roundSelector as HTMLSelectElement).getAllByRole("option");
      const roundOptionTexts = roundOptions.map((option) => option.textContent ?? "");
      expect(roundOptions).toHaveLength(2);
      expect(roundOptionTexts.some((text) => text.includes(firstRoundId))).toBe(true);
      expect(roundOptionTexts.some((text) => text.includes("Second question"))).toBe(true);
      expect(within(questionSection as HTMLElement).getByDisplayValue("Second question")).toBeTruthy();
    });

    await user.click(coordinatorTwoUi.getByRole("tab", { name: /^Voting$/i }));
    await waitFor(() => {
      expect(coordinatorTwoUi.getByText(/Live prompt: Second question/i)).toBeTruthy();
      expect(coordinatorTwoUi.getAllByRole("button", { name: /Resend on fail/i }).length).toBeGreaterThanOrEqual(2);
    });
    const voterOneRoundSelector = voterOne.container.querySelector("select#simple-live-round") as HTMLSelectElement | null;
    const voterTwoRoundSelector = voterTwo.container.querySelector("select#simple-live-round") as HTMLSelectElement | null;
    if (voterOneRoundSelector) {
      expect(Array.from(voterOneRoundSelector.options).some((option) => option.value === firstRoundId)).toBe(true);
    }
    if (voterTwoRoundSelector) {
      expect(Array.from(voterTwoRoundSelector.options).some((option) => option.value === firstRoundId)).toBe(true);
    }
  }, 40000);

  it("recovers a ticket from DM history when the live delivery is missed", async () => {
    const user = userEvent.setup();
    const { default: SimpleCoordinatorApp } = await import("./SimpleCoordinatorApp");
    const { default: SimpleUiApp } = await import("./SimpleUiApp");

    const coordinator = render(<SimpleCoordinatorApp />);
    const voter = render(<SimpleUiApp />);

    const coordinatorUi = within(coordinator.container);
    const voterUi = within(voter.container);

    await user.click(coordinatorUi.getByRole('button', { name: /New ID/i }));
    await user.click(voterUi.getByRole("button", { name: /New/i }));
    await user.click(coordinatorUi.getByRole("tab", { name: /^Settings$/i }));
    await user.click(voterUi.getByRole("tab", { name: /^Settings$/i }));

    await waitFor(() => {
      expect(coordinator.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(voter.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
    });

    const coordinatorNpub =
      coordinator.container.querySelectorAll("code.simple-identity-code")[0]?.textContent ?? "";
    const voterNpub =
      voter.container.querySelectorAll("code.simple-identity-code")[0]?.textContent ?? "";

    suppressedShardResponseNotifications = new Set([voterNpub]);

    await user.click(voterUi.getByRole("tab", { name: /^Configure$/i }));
    await user.type(
      voterUi.getByPlaceholderText('Enter coordinator npub...'),
      coordinatorNpub,
    );
    await user.click(voterUi.getByRole("button", { name: /Add coordinator/i }));

    await waitFor(() => {
      expect(coordinatorUi.getByRole("tab", { name: /^Voting$/i })).toBeTruthy();
    });

    await user.click(coordinatorUi.getByRole("tab", { name: /^Voting$/i }));
    await waitFor(() => {
      expect(coordinatorUi.getByText(/is following this coordinator/i)).toBeTruthy();
    });

    await user.click(coordinatorUi.getByRole("tab", { name: /^Voting$/i }));
    await user.click(coordinatorUi.getByRole("button", { name: /Broadcast live vote/i }));
    await user.click(voterUi.getByRole("tab", { name: /^Vote$/i }));

    await waitFor(() => {
      expect(voterUi.getByText(/Tickets ready: 0 of 1/i)).toBeTruthy();
      expect(coordinatorUi.getByRole("button", { name: /Resend on fail/i })).toBeTruthy();
    });

    await user.click(coordinatorUi.getByRole("button", { name: /Resend on fail/i }));

    await waitFor(() => {
      const bodyText = voter.container.textContent ?? "";
      expect(
        /Waiting for ticket\./i.test(bodyText)
        || /Tickets ready: 1 of 1/i.test(bodyText),
      ).toBe(true);
    });

    await new Promise((resolve) => window.setTimeout(resolve, 5200));

    await waitFor(() => {
      expect(voterUi.getByText(/Tickets ready: 1 of 1/i)).toBeTruthy();
      expect(voterUi.getByText(/Vote ticket received/i)).toBeTruthy();
    });
  }, 40000);

  it("lets an auditor inspect a public round and reconstruct the tally", async () => {
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    const coordinatorSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 101);
    const coordinatorNpub = nip19.npubEncode(getPublicKey(coordinatorSecretKey));
    const ballotSecretKey = Uint8Array.from({ length: 32 }, (_, index) => index + 151);
    const ballotNpub = nip19.npubEncode(getPublicKey(ballotSecretKey));

    liveVotes = [{
      votingId: "audit-round-1",
      prompt: "Should the proposal pass?",
      coordinatorNpub,
      createdAt: "2026-04-04T00:00:00.000Z",
      thresholdT: 1,
      thresholdN: 1,
      authorizedCoordinatorNpubs: [coordinatorNpub],
      eventId: "live-audit-1",
    }];
    submittedVotes = [{
      eventId: "ballot-audit-1",
      votingId: "audit-round-1",
      voterNpub: ballotNpub,
      choice: "Yes",
      shardProofs: [{
        coordinatorNpub,
        votingId: "audit-round-1",
        tokenCommitment: "audit-token-1",
        unblindedSignature: "sig-1",
        shareIndex: 1,
        keyAnnouncementEvent: {
          id: "blind-key-audit-1",
          kind: 38993,
          pubkey: coordinatorNpub,
          content: JSON.stringify({
            voting_id: "audit-round-1",
            scheme: "rsabssa-sha384-pss-randomized-v1",
            key_id: "audit-key-1",
            bits: 3072,
            hash: "SHA-384",
            salt_length: 48,
            n: "n-1",
            e: "10001",
            created_at: "2026-04-04T00:00:00.000Z",
          }),
          created_at: 1,
          tags: [],
          sig: "sig",
        },
      }],
      tokenId: "token-audit-1",
      createdAt: "2026-04-04T00:00:05.000Z",
    }];

    const auditor = render(<SimpleAppShell initialRole="auditor" />);
    const auditorUi = within(auditor.container);

    await waitFor(() => {
      expect(auditorUi.getByRole("heading", { name: /^Auditor$/i, level: 1 })).toBeTruthy();
      expect(auditorUi.getAllByText(/Should the proposal pass\?/i).length).toBeGreaterThan(0);
      expect(auditorUi.getByText(/Yes: 1 \| No: 0/i)).toBeTruthy();
      expect(auditorUi.getByText(/Vote Yes/i)).toBeTruthy();
      expect(auditorUi.getByText(/Authorized coordinators: 1/i)).toBeTruthy();
    });
  });
});

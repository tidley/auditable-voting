// @vitest-environment jsdom
import React from "react";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicKey, nip19 } from "nostr-tools";
import { createHash } from "node:crypto";

type InternalResponse = {
  id: string;
  requestId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  createdAt: string;
  voterNpub: string;
  votingPrompt?: string;
  shardCertificate: any;
};

type InternalLiveVote = {
  votingId: string;
  prompt: string;
  coordinatorNpub: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  eventId: string;
};

type InternalSubmittedVote = {
  eventId: string;
  votingId: string;
  voterNpub: string;
  choice: "Yes" | "No";
  shardCertificates: any[];
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
let followerSubscribers: Array<{
  coordinatorNpub: string;
  onFollowers: (followers: Array<{
    id: string;
    voterNpub: string;
    voterId: string;
    votingId?: string;
    createdAt: string;
  }>) => void;
}> = [];
let shardResponseSubscribers: Array<{
  voterNpub: string;
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
    leadCoordinatorNpub: string;
    coordinatorNpub: string;
    shareIndex: number;
    thresholdN?: number;
    createdAt: string;
  }>) => void;
}> = [];

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

function makeTokenId(shardCertificates: any[]) {
  const ids = shardCertificates.map((certificate) => certificate.id).sort().join("|");
  return sha(ids).slice(0, 16);
}

function followerEntriesForCoordinator(coordinatorNpub: string) {
  return coordinatorFollowers
    .filter((entry) => entry.coordinatorNpub === coordinatorNpub)
    .map((entry, index) => ({
      id: `follow-${index + 1}`,
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

function notifyShardResponseSubscribers(voterNpub: string) {
  const nextResponses = shardResponses.filter((response) => response.voterNpub === voterNpub);
  for (const subscriber of shardResponseSubscribers) {
    if (subscriber.voterNpub === voterNpub) {
      subscriber.onResponses(nextResponses);
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

vi.mock("./coordinatorApi", () => ({
  fetchElection: vi.fn().mockResolvedValue(null),
}));

vi.mock("./SimpleQrScanner", () => ({
  default: () => null,
}));

vi.mock("./TokenFingerprint", () => ({
  default: ({ tokenId }: { tokenId: string }) => <div data-testid="token-fingerprint">{tokenId}</div>,
}));

vi.mock("./tokenIdentity", () => ({
  sha256Hex: vi.fn(async (value: string) => sha(value)),
}));

vi.mock("./simpleShardCertificate", () => ({
  parseSimpleShardCertificate: vi.fn((certificate: any) => {
    try {
      const payload = JSON.parse(certificate.content);
      return {
        shardId: payload.shard_id,
        coordinatorNpub: nip19.npubEncode(certificate.pubkey),
        thresholdLabel: payload.threshold_label,
        votingId: payload.voting_id,
        tokenCommitment: payload.token_commitment,
        shareIndex: payload.share_index,
        thresholdT: payload.threshold_t,
        thresholdN: payload.threshold_n,
        createdAt: new Date((certificate.created_at ?? 0) * 1000).toISOString(),
        event: certificate,
      };
    } catch {
      return null;
    }
  }),
  deriveTokenIdFromSimpleShardCertificates: vi.fn(async (certificates: any[]) => makeTokenId(certificates)),
}));

vi.mock("./simpleShardDm", () => ({
  sendSimpleCoordinatorFollow: vi.fn(async (input: {
    voterSecretKey: Uint8Array;
    coordinatorNpub: string;
    voterNpub: string;
    voterId: string;
    votingId?: string;
  }) => {
    coordinatorFollowers.push({
      coordinatorNpub: input.coordinatorNpub,
      voterNpub: input.voterNpub,
      voterId: input.voterId,
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
  sendSimpleSubCoordinatorJoin: vi.fn(async (input: {
    leadCoordinatorNpub: string;
    coordinatorNpub: string;
    coordinatorId: string;
  }) => {
    subCoordinatorApplications.push({
      leadCoordinatorNpub: input.leadCoordinatorNpub,
      coordinatorNpub: input.coordinatorNpub,
      coordinatorId: input.coordinatorId,
      createdAt: new Date().toISOString(),
    });
    notifySubCoordinatorApplicationSubscribers(input.leadCoordinatorNpub);
    return { eventId: `subcoord-${subCoordinatorApplications.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleSubCoordinatorApplications: vi.fn((input: {
    leadCoordinatorNsec: string;
    onApplications: (applications: Array<{
      id: string;
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
  sendSimpleRoundTicket: vi.fn(async (input: {
    coordinatorSecretKey: Uint8Array;
    voterNpub: string;
    voterId: string;
    coordinatorNpub: string;
    coordinatorId: string;
    thresholdLabel: string;
    votingId: string;
    votingPrompt: string;
    tokenCommitment: string;
    shareIndex: number;
    thresholdT?: number;
    thresholdN?: number;
  }) => {
    const responseId = `response-${++responseCounter}`;
    const shardCertificate = {
      id: `certificate-${responseCounter}`,
      kind: 38993,
      pubkey: getPublicKey(input.coordinatorSecretKey),
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({
        shard_id: responseId,
        threshold_label: input.thresholdLabel,
        voting_id: input.votingId,
        token_commitment: input.tokenCommitment,
        share_index: input.shareIndex,
        threshold_t: input.thresholdT,
        threshold_n: input.thresholdN,
      }),
      sig: "sig",
    };
    shardResponses.push({
      id: responseId,
      requestId: `round-ticket:${input.votingId}:${input.coordinatorNpub}`,
      coordinatorNpub: input.coordinatorNpub,
      coordinatorId: input.coordinatorId,
      thresholdLabel: input.thresholdLabel,
      createdAt: new Date().toISOString(),
      voterNpub: input.voterNpub,
      votingPrompt: input.votingPrompt,
      shardCertificate,
    });
    notifyShardResponseSubscribers(input.voterNpub);
    return { responseId, eventId: `dm-response-${responseCounter}`, successes: 1, failures: 0, relayResults: [] };
  }),
  subscribeSimpleShardResponses: vi.fn((input: {
    voterNsec: string;
    onResponses: (responses: InternalResponse[]) => void;
  }) => {
    const voterNpub = nsecToNpub(input.voterNsec);
    const subscriber = {
      voterNpub,
      onResponses: input.onResponses,
    };
    shardResponseSubscribers.push(subscriber);
    input.onResponses(shardResponses.filter((response) => response.voterNpub === voterNpub));
    return () => {
      shardResponseSubscribers = shardResponseSubscribers.filter((entry) => entry !== subscriber);
    };
  }),
}));

vi.mock("./simpleVotingSession", () => ({
  publishSimpleLiveVote: vi.fn(async (input: {
    coordinatorNsec: string;
    prompt: string;
    votingId?: string;
    thresholdT?: number;
    thresholdN?: number;
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
  publishSimpleSubmittedVote: vi.fn(async (input: {
    ballotNsec: string;
    votingId: string;
    choice: "Yes" | "No";
    shardCertificates: any[];
  }) => {
    const ballotNpub = nsecToNpub(input.ballotNsec);
    const createdAt = new Date().toISOString();
    submittedVotes.push({
      eventId: `ballot-${++voteCounter}`,
      votingId: input.votingId,
      voterNpub: ballotNpub,
      choice: input.choice,
      shardCertificates: input.shardCertificates,
      tokenId: makeTokenId(input.shardCertificates),
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
  beforeEach(() => {
    responseCounter = 0;
    voteCounter = 0;
    liveVotes = [{
      votingId: "old-round",
      prompt: "Old stale prompt",
      coordinatorNpub: secretToNpub(new Uint8Array(32).fill(7)),
      createdAt: "2026-03-31T11:00:00.000Z",
      thresholdT: 1,
      thresholdN: 1,
      eventId: "live-old",
    }];
    shardResponses = [];
    submittedVotes = [];
    coordinatorFollowers = [];
    subCoordinatorApplications = [];
    shareAssignments = [];
    followerSubscribers = [];
    shardResponseSubscribers = [];
    liveVoteSubscribers = [];
    liveVoteListSubscribers = [];
    submittedVoteSubscribers = [];
    subCoordinatorApplicationSubscribers = [];
    shareAssignmentSubscribers = [];
    window.sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    window.sessionStorage.clear();
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

    await user.click(coordinatorOneUi.getByRole("button", { name: /Refresh ID/i }));
    await user.click(coordinatorTwoUi.getByRole("button", { name: /Refresh ID/i }));
    await user.click(voterOneUi.getByRole("button", { name: /Refresh ID/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /Refresh ID/i }));

    await waitFor(() => {
      expect(coordinatorOne.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(coordinatorTwo.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
    });

    const coordinatorOneCodes = coordinatorOne.container.querySelectorAll("code.simple-identity-code");
    const coordinatorTwoCodes = coordinatorTwo.container.querySelectorAll("code.simple-identity-code");
    const coordinatorOneNpub = coordinatorOneCodes[0]?.textContent ?? "";
    const coordinatorTwoNpub = coordinatorTwoCodes[0]?.textContent ?? "";

    expect(coordinatorOneNpub.startsWith("npub1")).toBe(true);
    expect(coordinatorTwoNpub.startsWith("npub1")).toBe(true);
    expect(coordinatorOneNpub).not.toBe(coordinatorTwoNpub);

    const roundId = "round-1";
    const coordinatorOneInputs = coordinatorOne.container.querySelectorAll("input.simple-voter-input");
    const coordinatorTwoInputs = coordinatorTwo.container.querySelectorAll("input.simple-voter-input");
    await user.clear(coordinatorOneInputs[1] as HTMLInputElement);
    await user.type(coordinatorOneInputs[1] as HTMLInputElement, roundId);
    await user.clear(coordinatorOneInputs[2] as HTMLInputElement);
    await user.type(coordinatorOneInputs[2] as HTMLInputElement, "2");
    await user.clear(coordinatorOneInputs[3] as HTMLInputElement);
    await user.type(coordinatorOneInputs[3] as HTMLInputElement, "2");
    await user.clear(coordinatorTwoInputs[0] as HTMLInputElement);
    await user.type(coordinatorTwoInputs[0] as HTMLInputElement, coordinatorOneNpub);
    await user.click(coordinatorTwoUi.getByRole("button", { name: /Submit to lead/i }));

    await waitFor(() => {
      expect(voterOne.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(voterTwo.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
    });
    await user.type(voterOne.container.querySelector("input.simple-voter-input-inline") as HTMLInputElement, coordinatorOneNpub);
    await user.click(voterOneUi.getByRole("button", { name: /Add coordinator/i }));
    await user.type(voterOne.container.querySelector("input.simple-voter-input-inline") as HTMLInputElement, coordinatorTwoNpub);
    await user.click(voterOneUi.getByRole("button", { name: /Add coordinator/i }));
    await user.type(voterTwo.container.querySelector("input.simple-voter-input-inline") as HTMLInputElement, coordinatorOneNpub);
    await user.click(voterTwoUi.getByRole("button", { name: /Add coordinator/i }));
    await user.type(voterTwo.container.querySelector("input.simple-voter-input-inline") as HTMLInputElement, coordinatorTwoNpub);
    await user.click(voterTwoUi.getByRole("button", { name: /Add coordinator/i }));

    await user.click(voterOneUi.getByRole("button", { name: /Notify coordinators/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /Notify coordinators/i }));

    await waitFor(() => {
      expect(voterOneUi.getByText(/Coordinators notified\. Waiting for round tickets\./i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Coordinators notified\. Waiting for round tickets\./i)).toBeTruthy();
      expect(coordinatorOneUi.getByText(/submitted as sub-coordinator/i)).toBeTruthy();
    });

    await user.click(coordinatorOneUi.getByRole("button", { name: /Broadcast live vote/i }));
    await user.click(coordinatorOneUi.getByRole("button", { name: /Distribute share indexes/i }));

    await waitFor(() => {
      expect(voterOneUi.getByText(/No live vote ticket yet\./i)).toBeTruthy();
      expect(voterTwoUi.getByText(/No live vote ticket yet\./i)).toBeTruthy();
      expect(coordinatorOneUi.getAllByText(/is following this coordinator/i).length).toBeGreaterThanOrEqual(2);
      expect(coordinatorTwoUi.getAllByText(/is following this coordinator/i).length).toBeGreaterThanOrEqual(2);
      expect(coordinatorTwoUi.getByDisplayValue("2")).toBeTruthy();
    });
    expect(voterOneUi.queryByText("Old stale prompt")).toBeNull();
    expect(voterTwoUi.queryByText("Old stale prompt")).toBeNull();

    await waitFor(() => {
      expect(coordinatorOneUi.getAllByRole("button", { name: /Send ticket/i })).toHaveLength(2);
      expect(coordinatorTwoUi.getAllByRole("button", { name: /Send ticket/i })).toHaveLength(2);
    });

    for (const button of coordinatorOneUi.getAllByRole("button", { name: /Send ticket/i })) {
      await user.click(button);
    }
    for (const button of coordinatorTwoUi.getAllByRole("button", { name: /Send ticket/i })) {
      await user.click(button);
    }

    await waitFor(() => {
      expect(voterOneUi.getByText(/Tickets ready: 2 of 2/i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Tickets ready: 2 of 2/i)).toBeTruthy();
      expect(voterOneUi.getByText("round-1")).toBeTruthy();
      expect(voterTwoUi.getByText("round-1")).toBeTruthy();
      expect(voterOneUi.getAllByText("1").length).toBeGreaterThanOrEqual(2);
      expect(voterTwoUi.getAllByText("1").length).toBeGreaterThanOrEqual(2);
    });

    await user.click(voterOneUi.getByRole("button", { name: /^Yes$/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /^No$/i }));
    await user.click(voterOneUi.getByRole("button", { name: /^Submit$/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /^Submit$/i }));

    await waitFor(() => {
      expect(coordinatorOneUi.getByText((_, element) => element?.textContent === "Yes: 1 | No: 1")).toBeTruthy();
      expect(coordinatorTwoUi.getByText((_, element) => element?.textContent === "Yes: 1 | No: 1")).toBeTruthy();
    });
  }, 40000);
});

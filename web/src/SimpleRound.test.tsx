// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublicKey, nip19 } from "nostr-tools";
import { createHash } from "node:crypto";

type InternalRequest = {
  id: string;
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
  votingId: string;
  tokenCommitment: string;
  createdAt: string;
};

type InternalResponse = {
  id: string;
  requestId: string;
  coordinatorNpub: string;
  coordinatorId: string;
  thresholdLabel: string;
  createdAt: string;
  voterNpub: string;
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

let requestCounter = 0;
let responseCounter = 0;
let voteCounter = 0;
let liveVotes: InternalLiveVote[] = [];
let shardRequests: InternalRequest[] = [];
let shardResponses: InternalResponse[] = [];
let submittedVotes: InternalSubmittedVote[] = [];
let coordinatorFollowers: Array<{
  coordinatorNpub: string;
  voterNpub: string;
  voterId: string;
  votingId?: string;
  createdAt: string;
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
    return { eventId: `follow-${coordinatorFollowers.length}`, successes: 1, failures: 0, relayResults: [] };
  }),
  fetchSimpleCoordinatorFollowers: vi.fn(async (input: { coordinatorNsec: string }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    return coordinatorFollowers
      .filter((entry) => entry.coordinatorNpub === coordinatorNpub)
      .map((entry, index) => ({
        id: `follow-${index + 1}`,
        voterNpub: entry.voterNpub,
        voterId: entry.voterId,
        votingId: entry.votingId,
        createdAt: entry.createdAt,
      }));
  }),
  sendSimpleShardRequest: vi.fn(async (input: {
    voterSecretKey: Uint8Array;
    coordinatorNpub: string;
    voterNpub: string;
    voterId: string;
    votingId: string;
    tokenCommitment: string;
  }) => {
    shardRequests.push({
      id: `request-${++requestCounter}`,
      coordinatorNpub: input.coordinatorNpub,
      voterNpub: input.voterNpub,
      voterId: input.voterId,
      votingId: input.votingId,
      tokenCommitment: input.tokenCommitment,
      createdAt: new Date().toISOString(),
    });
    return { eventId: `dm-request-${requestCounter}`, successes: 1, failures: 0, relayResults: [] };
  }),
  fetchSimpleShardRequests: vi.fn(async (input: { coordinatorNsec: string }) => {
    const coordinatorNpub = nsecToNpub(input.coordinatorNsec);
    return shardRequests
      .filter((request) => request.coordinatorNpub === coordinatorNpub)
      .map((request) => ({
        id: request.id,
        voterNpub: request.voterNpub,
        voterId: request.voterId,
        votingId: request.votingId,
        tokenCommitment: request.tokenCommitment,
        createdAt: request.createdAt,
      }));
  }),
  sendSimpleShardResponse: vi.fn(async (input: {
    coordinatorSecretKey: Uint8Array;
    voterNpub: string;
    requestId: string;
    coordinatorNpub: string;
    coordinatorId: string;
    thresholdLabel: string;
    votingId: string;
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
      requestId: input.requestId,
      coordinatorNpub: input.coordinatorNpub,
      coordinatorId: input.coordinatorId,
      thresholdLabel: input.thresholdLabel,
      createdAt: new Date().toISOString(),
      voterNpub: input.voterNpub,
      shardCertificate,
    });
    return { responseId, eventId: `dm-response-${responseCounter}`, successes: 1, failures: 0, relayResults: [] };
  }),
  fetchSimpleShardResponses: vi.fn(async (input: { voterNsec: string }) => {
    const voterNpub = nsecToNpub(input.voterNsec);
    return shardResponses
      .filter((response) => response.voterNpub === voterNpub)
      .map((response) => ({
        id: response.id,
        requestId: response.requestId,
        coordinatorNpub: response.coordinatorNpub,
        coordinatorId: response.coordinatorId,
        thresholdLabel: response.thresholdLabel,
        createdAt: response.createdAt,
        shardCertificate: response.shardCertificate,
      }));
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
  fetchLatestSimpleLiveVote: vi.fn(async (input: { coordinatorNpub: string }) => {
    const matches = liveVotes.filter((vote) => vote.coordinatorNpub === input.coordinatorNpub);
    return matches[matches.length - 1] ?? null;
  }),
  fetchSimpleLiveVotes: vi.fn(async () => [...liveVotes].sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
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
    return {
      eventId: `ballot-${voteCounter}`,
      ballotNpub,
      createdAt,
      successes: 1,
      failures: 0,
      relayResults: [],
    };
  }),
  fetchSimpleSubmittedVotes: vi.fn(async (input: { votingId: string }) => (
    submittedVotes.filter((vote) => vote.votingId === input.votingId)
  )),
}));

describe("Simple round flow", () => {
  beforeEach(() => {
    requestCounter = 0;
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
    shardRequests = [];
    shardResponses = [];
    submittedVotes = [];
    coordinatorFollowers = [];
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

    await user.click(coordinatorOneUi.getByRole("button", { name: /Create Nostr keypair/i }));
    await user.click(coordinatorTwoUi.getByRole("button", { name: /Create Nostr keypair/i }));

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
    await user.clear(coordinatorTwoInputs[4] as HTMLInputElement);
    await user.type(coordinatorTwoInputs[4] as HTMLInputElement, "2");

    await user.click(coordinatorOneUi.getByRole("button", { name: /Broadcast live vote/i }));

    let votingDetailsValue = "";
    await waitFor(() => {
      const votingDetailsBlocks = Array.from(
        coordinatorOne.container.querySelectorAll(".simple-qr-panel .simple-identity-code"),
      ) as HTMLElement[];
      votingDetailsValue = votingDetailsBlocks.find((block) => (block.textContent ?? "").includes("Voting ID:"))?.textContent ?? "";
      expect(votingDetailsValue).toContain("Voting ID: round-1");
    });
    expect(votingDetailsValue).toContain("Voting ID: round-1");
    expect(votingDetailsValue).toContain(coordinatorOneNpub);

    const voterOneCoordinatorInputs = voterOne.container.querySelectorAll("input.simple-voter-input-inline");
    const voterTwoCoordinatorInputs = voterTwo.container.querySelectorAll("input.simple-voter-input-inline");
    await waitFor(() => {
      expect(voterOne.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
      expect(voterTwo.container.querySelectorAll("code.simple-identity-code")[0]?.textContent?.startsWith("npub1")).toBe(true);
    });
    await user.type(voterOneCoordinatorInputs[0] as HTMLInputElement, coordinatorOneNpub);
    await user.click(voterOneUi.getByRole("button", { name: /Add coordinator/i }));
    await user.type(voterOne.container.querySelectorAll("input.simple-voter-input-inline")[1] as HTMLInputElement, coordinatorTwoNpub);
    await user.type(voterTwoCoordinatorInputs[0] as HTMLInputElement, coordinatorOneNpub);
    await user.click(voterTwoUi.getByRole("button", { name: /Add coordinator/i }));
    await user.type(voterTwo.container.querySelectorAll("input.simple-voter-input-inline")[1] as HTMLInputElement, coordinatorTwoNpub);

    await waitFor(() => {
      expect(voterOneUi.getByText("Should the proposal pass?")).toBeTruthy();
      expect(voterTwoUi.getByText("Should the proposal pass?")).toBeTruthy();
    });
    expect(voterOneUi.queryByText("Old stale prompt")).toBeNull();
    expect(voterTwoUi.queryByText("Old stale prompt")).toBeNull();

    await user.click(voterOneUi.getByRole("button", { name: /Notify coordinators/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /Notify coordinators/i }));

    await waitFor(() => {
      expect(voterOneUi.getByText(/Vote tickets requested for round-1\./i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Vote tickets requested for round-1\./i)).toBeTruthy();
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5200));
    });

    await waitFor(() => {
      expect(coordinatorOneUi.getAllByRole("button", { name: /Send shard/i })).toHaveLength(2);
      expect(coordinatorTwoUi.getAllByRole("button", { name: /Send shard/i })).toHaveLength(2);
    });

    for (const button of coordinatorOneUi.getAllByRole("button", { name: /Send shard/i })) {
      await user.click(button);
    }
    for (const button of coordinatorTwoUi.getAllByRole("button", { name: /Send shard/i })) {
      await user.click(button);
    }

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 5200));
    });

    await waitFor(() => {
      expect(voterOneUi.getByText(/Tickets ready: 2 of 2/i)).toBeTruthy();
      expect(voterTwoUi.getByText(/Tickets ready: 2 of 2/i)).toBeTruthy();
      expect(voterOneUi.getByText("round-1")).toBeTruthy();
      expect(voterTwoUi.getByText("round-1")).toBeTruthy();
      expect(voterOneUi.getAllByText("2").length).toBeGreaterThan(1);
      expect(voterTwoUi.getAllByText("2").length).toBeGreaterThan(1);
    });

    await user.click(voterOneUi.getByRole("button", { name: /^Yes$/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /^No$/i }));
    await user.click(voterOneUi.getByRole("button", { name: /^Submit$/i }));
    await user.click(voterTwoUi.getByRole("button", { name: /^Submit$/i }));

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 6200));
    });

    await waitFor(() => {
      expect(coordinatorOneUi.getByText((_, element) => element?.textContent === "Yes: 1 | No: 1")).toBeTruthy();
      expect(coordinatorTwoUi.getByText((_, element) => element?.textContent === "Yes: 1 | No: 1")).toBeTruthy();
    }, { timeout: 8000 });
  }, 40000);
});

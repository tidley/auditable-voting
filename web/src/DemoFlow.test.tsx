// @vitest-environment jsdom
import React from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const secretKey = generateSecretKey();
const publicKey = getPublicKey(secretKey);
const testIdentity = {
  nsec: nip19.nsecEncode(secretKey),
  npub: nip19.npubEncode(publicKey),
  pubkey: publicKey,
};

const now = Math.floor(Date.now() / 1000);

let issued = false;
let ballotPublished = false;
let confirmationPublished = false;

const mockCoordinator = {
  coordinatorNpub: "npub1coorddemo0000000000000000000000000000000000000000000000000000",
  mintUrl: "http://mint.example",
  mintPublicKey: "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  relays: ["wss://relay.example"],
  electionId: "mock-election-id",
};

const mockCoordinator2 = {
  coordinatorNpub: "npub1coorddemo1111111111111111111111111111111111111111111111111111",
  mintUrl: "http://mint-2.example",
  mintPublicKey: "02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  relays: ["wss://relay.example"],
  electionId: "mock-election-id",
};

const mockElection = {
  election_id: "mock-election-id",
  event_id: "a".repeat(64),
  title: "Mock election",
  description: "Local demo election",
  questions: [
    {
      id: "funding_priority",
      type: "choice" as const,
      prompt: "Which area should receive the first round of funding?",
      options: ["Community grants", "Security audits", "Education programs"],
      select: "single" as const,
    },
  ],
  vote_start: now - 300,
  vote_end: now - 60,
  confirm_end: now + 3600,
  mint_urls: [mockCoordinator.mintUrl],
  coordinator_npubs: [mockCoordinator.coordinatorNpub],
  eligible_root: "",
  eligible_count: 1,
  eligible_url: "",
};

const mockProof = {
  quoteId: "quote-1",
  npub: testIdentity.npub,
  amount: 1,
  secret: "proof-secret",
  signature: "proof-signature",
  mintUrl: mockCoordinator.mintUrl,
  issuedAt: new Date().toISOString(),
};

vi.mock("./config", () => ({
  DEMO_MODE: true,
  USE_MOCK: true,
  MINT_URL: mockCoordinator.mintUrl,
  DEMO_COPY: { pass: "voting pass", quote: "approval request", proof: "voting pass", mint: "issuer" },
}));

vi.mock("./demoIdentity", () => ({
  createDemoIdentity: () => testIdentity,
}));

vi.mock("./voterManagementApi", () => ({
  fetchEligibility: vi.fn().mockResolvedValue({
    eligibleNpubs: [testIdentity.npub],
    eligibleCount: 1,
    verifiedNpubs: [],
    verifiedCount: 0,
  }),
  checkEligibility: vi.fn(async (npub: string) => ({
    npub,
    allowed: npub === testIdentity.npub,
    canProceed: npub === testIdentity.npub,
    message: npub === testIdentity.npub
      ? "npub is allowed and has not voted yet"
      : "npub is not in the allowed list",
  })),
  resetEligibility: vi.fn().mockResolvedValue({
    eligibleNpubs: [testIdentity.npub],
    eligibleCount: 1,
    verifiedNpubs: [],
    verifiedCount: 0,
    message: "reset",
  }),
  seedEligibility: vi.fn().mockImplementation(async (npub: string) => ({
    eligibleNpubs: [npub],
    eligibleCount: 1,
    verifiedNpubs: [],
    verifiedCount: 0,
    message: "seeded",
  })),
}));

vi.mock("./coordinatorApi", () => ({
  fetchCoordinatorInfo: vi.fn().mockResolvedValue(mockCoordinator),
  fetchEligibility: vi.fn().mockResolvedValue({
    election_id: mockElection.election_id,
    eligible_count: 1,
    eligible_npubs: [testIdentity.npub],
  }),
  fetchElection: vi.fn().mockResolvedValue(mockElection),
  fetchIssuanceStatus: vi.fn().mockImplementation(async () => ({
    election_id: mockElection.election_id,
    voters: {
      [testIdentity.npub]: { eligible: true, issued },
    },
  })),
  fetchTally: vi.fn().mockImplementation(async () => ({
    election_id: mockElection.election_id,
    status: "closed",
    total_published_votes: ballotPublished ? 1 : 0,
    total_accepted_votes: ballotPublished ? 1 : 0,
    spent_commitment_root: null,
    results: ballotPublished
      ? { funding_priority: { "Community grants": 1 } }
      : {},
  })),
  fetchResult: vi.fn().mockResolvedValue(null),
  discoverCoordinators: vi.fn().mockResolvedValue([
    { npub: mockCoordinator.coordinatorNpub, httpApi: "http://coordinator.example", mintUrl: mockCoordinator.mintUrl, relays: mockCoordinator.relays },
    { npub: mockCoordinator2.coordinatorNpub, httpApi: "http://coordinator-2.example", mintUrl: mockCoordinator2.mintUrl, relays: mockCoordinator2.relays },
  ]),
  fetchPerCoordinatorTallies: vi.fn().mockImplementation(async () => ([
    {
      coordinatorNpub: mockCoordinator.coordinatorNpub,
      httpApi: "http://coordinator.example",
      tally: {
        election_id: mockElection.election_id,
        status: "closed",
        total_published_votes: ballotPublished ? 1 : 0,
        total_accepted_votes: ballotPublished ? 1 : 0,
        spent_commitment_root: null,
        results: ballotPublished ? { funding_priority: { "Community grants": 1 } } : {},
      },
      result: null,
    },
    {
      coordinatorNpub: mockCoordinator2.coordinatorNpub,
      httpApi: "http://coordinator-2.example",
      tally: {
        election_id: mockElection.election_id,
        status: "closed",
        total_published_votes: ballotPublished ? 1 : 0,
        total_accepted_votes: ballotPublished ? 1 : 0,
        spent_commitment_root: null,
        results: ballotPublished ? { funding_priority: { "Community grants": 1 } } : {},
      },
      result: null,
    },
  ])),
  startIssuanceTracking: vi.fn().mockResolvedValue({
    request_id: "request-1",
    status_url: "/issuance/request-1",
    status: "pending",
  }),
  awaitIssuanceStatus: vi.fn().mockResolvedValue({
    request_id: "request-1",
    status: "issued",
    issued: true,
    quote_state: "PAID",
    message: "approved",
  }),
  runAudit: vi.fn().mockImplementation(async () => ([
    {
      coordinatorNpub: mockCoordinator.coordinatorNpub,
      tally: ballotPublished ? 1 : 0,
      confirmations: confirmationPublished ? 1 : 0,
      fakeConfirmations: 0,
      canonicalCount: 1,
      flags: ballotPublished ? [] : ["pending"],
    },
    {
      coordinatorNpub: mockCoordinator2.coordinatorNpub,
      tally: ballotPublished ? 1 : 0,
      confirmations: confirmationPublished ? 1 : 0,
      fakeConfirmations: 0,
      canonicalCount: 1,
      flags: ballotPublished ? [] : ["pending"],
    },
  ])),
  fetchElectionsFromNostr: vi.fn().mockResolvedValue([]),
  checkVoteAccepted: vi.fn().mockImplementation(async () => [{
    npub: mockCoordinator.coordinatorNpub,
    accepted: ballotPublished,
  }]),
  fetchVoteTree: vi.fn(),
  fetchInclusionProof: vi.fn(),
}));

vi.mock("./MerkleTreeViz", () => ({ default: () => null }));

vi.mock("./mintApi", () => ({
  createMintQuote: vi.fn().mockResolvedValue({
    quote: "quote-1",
    request: "lnbc10u1pquote1",
    state: "UNPAID",
    amount: 1,
    unit: "sat",
    expiry: 600000,
  }),
  checkQuoteStatus: vi.fn().mockResolvedValue({
    quote: "quote-1",
    state: "PAID",
    amount: 1,
    unit: "sat",
  }),
}));

vi.mock("./cashuBlind", () => ({
  requestQuoteAndMint: vi.fn().mockImplementation(async () => {
    issued = true;
    return {
      quote: "quote-1",
      proofs: [mockProof],
    };
  }),
}));

vi.mock("./cashuMintApi", () => ({
  logClaimDebug: vi.fn(),
  logBallotDebug: vi.fn(),
}));

vi.mock("./nostrIdentity", async () => {
  const actual = await vi.importActual<typeof import("./nostrIdentity")>("./nostrIdentity");
  return {
    ...actual,
    getNostrEventVerificationUrl: vi.fn(() => "https://njump.me/e/demo"),
    createCashuClaimEvent: vi.fn(() => ({
      id: "claim-1",
      pubkey: testIdentity.pubkey,
      kind: 38010,
      created_at: now,
      content: "{}",
      tags: [],
      sig: "sig",
    })),
    publishCashuClaim: vi.fn().mockResolvedValue({
      eventId: "claim-1",
      successes: 1,
      failures: 0,
      relayResults: [],
    }),
    signCashuClaimEvent: vi.fn().mockResolvedValue({
      id: "claim-1",
      pubkey: testIdentity.pubkey,
      kind: 38010,
      created_at: now,
      content: "{}",
      tags: [],
      sig: "sig",
    }),
  };
});

vi.mock("./ballot", () => ({
  BALLOT_EVENT_KIND: 38000,
  DEFAULT_VOTE_RELAYS: mockCoordinator.relays,
  isBallotComplete: (answers: Record<string, unknown>, questions: Array<{ id: string }>) =>
    questions.every((q) => answers[q.id] !== undefined),
  publishBallotEvent: vi.fn().mockImplementation(async () => {
    ballotPublished = true;
    return {
      eventId: "vote-1",
      ballotNpub: "npub1ballot",
      ballotSecretKey: new Uint8Array([1]),
      event: {
        id: "vote-1",
        pubkey: testIdentity.pubkey,
        kind: 38000,
        created_at: now,
        content: "{}",
        tags: [["election", mockElection.election_id]],
        sig: "sig",
      },
      relays: mockCoordinator.relays,
      successes: 1,
      failures: 0,
      relayResults: [],
    };
  }),
}));

vi.mock("nostr-tools", async () => {
  const actual = await vi.importActual<typeof import("nostr-tools")>("nostr-tools");

  class MockSimplePool {
    querySync() {
      return [];
    }

    publish(relays: string[], event: { kind?: number }) {
      if (event.kind === 38013) {
        confirmationPublished = true;
      }
      return relays.map(() => Promise.resolve());
    }

    close() {}

    destroy() {}
  }

  return {
    ...actual,
    SimplePool: MockSimplePool,
  };
});

vi.mock("./signer", () => ({
  createRawSigner: vi.fn(),
  createNip07Signer: vi.fn(),
  startSignerDetection: () => () => {},
}));

describe("full voting demo flow", () => {
  beforeEach(() => {
    issued = false;
    ballotPublished = false;
    confirmationPublished = false;
    window.localStorage.clear();
    vi.clearAllMocks();
    window.alert = vi.fn();
  });

  afterEach(() => {
    cleanup();
  });

  it("walks through the full issuance, ballot, proof, confirmation, and audit flow", async () => {
    const user = userEvent.setup();
    const { default: DemoApp } = await import("./DemoApp");
    const { default: App } = await import("./App");
    const { default: VotingApp } = await import("./VotingApp");
    const { default: DashboardApp } = await import("./DashboardApp");

    const demo = render(<DemoApp />);
    expect(await screen.findByText(/AUDITABLE-VOTING/i)).toBeTruthy();
    expect(screen.getByDisplayValue(testIdentity.nsec)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check eligibility/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Run full demo/i }));
    await waitFor(() => expect(screen.getByText(/Demo root derived from the proof receipt\./i)).toBeTruthy(), { timeout: 5000 });
    demo.unmount();

    const app = render(<App />);
    const nsecField = await screen.findByLabelText(/nsec/i);
    await user.clear(nsecField);
    await user.type(nsecField, testIdentity.nsec);
    await screen.findByText(/Eligible npub confirmed/i);
    await user.click(screen.getByRole("button", { name: /Request voting pass/i }));
    await user.click(screen.getByRole("button", { name: /Confirm request/i }));
    await waitFor(() => expect(screen.getByText(/Voting pass received/i)).toBeTruthy(), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText(/Proof received and stored/i)).toBeTruthy(), { timeout: 5000 });
    const bundle = JSON.parse(window.localStorage.getItem("auditable-voting.cashu-proof") || "null");
    expect(bundle).not.toBeNull();
    expect(bundle.ephemeralKeypair.nsec).toBe(testIdentity.nsec);
    expect(bundle.ephemeralKeypair.npub).toBe(testIdentity.npub);
    app.unmount();

    const vote = render(<VotingApp />);
    const radios = await screen.findAllByRole("radio");
    expect(radios.length).toBeGreaterThan(0);
    await user.click(radios[0]);
    await user.click(screen.getByRole("button", { name: /Submit ballot/i }));
    await waitFor(() => expect(screen.getAllByText(/Proof DM sent/i).length).toBeGreaterThan(0), { timeout: 5000 });
    expect(screen.getByText(/Proof sent/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/accepted by the coordinator/i)).toBeTruthy(), { timeout: 5000 });
    vote.unmount();

    const dashboard = render(<DashboardApp />);
    await waitFor(() => expect(screen.getAllByText(/^Eligible$/).length).toBeGreaterThan(0), { timeout: 5000 });
    expect(screen.getByText(/Multi-Coordinator Audit/i)).toBeTruthy();
    expect(screen.getByText(/Audit is unavailable in mock mode/i)).toBeTruthy();
    expect(screen.getAllByText(/^Accepted$/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
    dashboard.unmount();
  }, 15000);
});

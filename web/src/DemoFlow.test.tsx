// @vitest-environment jsdom
import React from "react";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

function makeIdentity() {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return {
    nsec: nip19.nsecEncode(secretKey),
    npub: nip19.npubEncode(publicKey),
    pubkey: publicKey,
  };
}

const testIdentity = makeIdentity();
const testIdentity2 = makeIdentity();
const testIdentity3 = makeIdentity();
const demoIdentities = [testIdentity, testIdentity2, testIdentity3];

const coordinatorSecretKey = generateSecretKey();
const coordinatorPublicKey = getPublicKey(coordinatorSecretKey);
const coordinatorIdentity = {
  nsec: nip19.nsecEncode(coordinatorSecretKey),
  npub: nip19.npubEncode(coordinatorPublicKey),
  pubkey: coordinatorPublicKey,
};

const coordinatorSecretKey2 = generateSecretKey();
const coordinatorPublicKey2 = getPublicKey(coordinatorSecretKey2);
const coordinatorIdentity2 = {
  nsec: nip19.nsecEncode(coordinatorSecretKey2),
  npub: nip19.npubEncode(coordinatorPublicKey2),
  pubkey: coordinatorPublicKey2,
};

const now = Math.floor(Date.now() / 1000);
const receiptRoot = "b".repeat(64);

let issuedNpubs = new Set<string>();
let ballotPublished = false;
let confirmationPublished = false;

const mockCoordinator = {
  coordinatorNpub: coordinatorIdentity.npub,
  mintUrl: "http://mint.example",
  mintPublicKey: "02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  relays: ["wss://relay.example"],
  electionId: "mock-election-id",
};

const mockCoordinator2 = {
  coordinatorNpub: coordinatorIdentity2.npub,
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
      id: "proposal_approval",
      type: "choice" as const,
      prompt: "Should the proposal pass?",
      options: ["Yes", "No"],
      select: "single" as const,
    },
  ],
  vote_start: now - 300,
  vote_end: now - 60,
  confirm_end: now + 3600,
  mint_urls: [mockCoordinator.mintUrl],
  coordinator_npubs: [mockCoordinator.coordinatorNpub],
  eligible_root: "",
  eligible_count: demoIdentities.length,
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

let demoIdentityIndex = 0;
vi.mock("./demoIdentity", () => ({
  createDemoIdentity: () => demoIdentities[(demoIdentityIndex++) % demoIdentities.length],
}));

let activeNpub = testIdentity.npub;
vi.mock("./voterManagementApi", () => ({
  fetchEligibility: vi.fn().mockResolvedValue({
    eligibleNpubs: demoIdentities.map((identity) => identity.npub),
    eligibleCount: demoIdentities.length,
    verifiedNpubs: [],
    verifiedCount: 0,
  }),
  checkEligibility: vi.fn(async (npub: string) => {
    activeNpub = npub;
    const allowed = demoIdentities.some((identity) => identity.npub === npub);
    return {
      npub,
      allowed,
      canProceed: allowed,
      message: allowed
        ? "npub is allowed and has not voted yet"
        : "npub is not in the allowed list",
    };
  }),
  resetEligibility: vi.fn().mockResolvedValue({
    eligibleNpubs: demoIdentities.map((identity) => identity.npub),
    eligibleCount: demoIdentities.length,
    verifiedNpubs: [],
    verifiedCount: 0,
    message: "reset",
  }),
  seedEligibility: vi.fn().mockImplementation(async (npub: string) => {
    activeNpub = npub;
    return {
      eligibleNpubs: [npub],
      eligibleCount: 1,
      verifiedNpubs: [],
      verifiedCount: 0,
      message: "seeded",
    };
  }),
}));

vi.mock("./coordinatorApi", () => ({
  fetchCoordinatorInfo: vi.fn().mockResolvedValue(mockCoordinator),
  fetchEligibility: vi.fn().mockResolvedValue({
    election_id: mockElection.election_id,
    eligible_count: demoIdentities.length,
    eligible_npubs: demoIdentities.map((identity) => identity.npub),
  }),
  fetchElection: vi.fn().mockResolvedValue(mockElection),
  fetchIssuanceStatus: vi.fn().mockImplementation(async () => ({
    election_id: mockElection.election_id,
    voters: {
      [testIdentity.npub]: { eligible: true, issued: issuedNpubs.has(testIdentity.npub) },
      [testIdentity2.npub]: { eligible: true, issued: issuedNpubs.has(testIdentity2.npub) },
      [testIdentity3.npub]: { eligible: true, issued: issuedNpubs.has(testIdentity3.npub) },
    },
  })),
  fetchPublicLedger: vi.fn().mockResolvedValue(null),
  fetchTally: vi.fn().mockImplementation(async () => ({
    election_id: mockElection.election_id,
    status: "closed",
    total_published_votes: ballotPublished ? 3 : 0,
    total_accepted_votes: ballotPublished ? 3 : 0,
    spent_commitment_root: ballotPublished ? receiptRoot : null,
    results: ballotPublished
      ? { proposal_approval: { Yes: 2, No: 1 } }
      : {},
  })),
  fetchResult: vi.fn().mockImplementation(async () => ({
    election_id: mockElection.election_id,
    total_votes: ballotPublished ? 3 : 0,
    results: ballotPublished ? { proposal_approval: { Yes: 2, No: 1 } } : {},
    merkle_root: ballotPublished ? receiptRoot : "",
    total_proofs_burned: ballotPublished ? 3 : 0,
    issuance_commitment_root: "issuance-root",
    spent_commitment_root: ballotPublished ? receiptRoot : "",
    max_supply: 3,
    event_id: mockElection.event_id,
    closed_at: now,
  })),
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
        total_published_votes: ballotPublished ? 3 : 0,
        total_accepted_votes: ballotPublished ? 3 : 0,
        spent_commitment_root: ballotPublished ? receiptRoot : null,
        results: ballotPublished ? { proposal_approval: { Yes: 2, No: 1 } } : {},
      },
      result: {
        election_id: mockElection.election_id,
        total_votes: ballotPublished ? 3 : 0,
        results: ballotPublished ? { proposal_approval: { Yes: 2, No: 1 } } : {},
        merkle_root: ballotPublished ? receiptRoot : "",
        total_proofs_burned: ballotPublished ? 3 : 0,
        issuance_commitment_root: "issuance-root",
        spent_commitment_root: ballotPublished ? receiptRoot : "",
        max_supply: 3,
        event_id: mockElection.event_id,
        closed_at: now,
      },
    },
    {
      coordinatorNpub: mockCoordinator2.coordinatorNpub,
      httpApi: "http://coordinator-2.example",
      tally: {
        election_id: mockElection.election_id,
        status: "closed",
        total_published_votes: ballotPublished ? 3 : 0,
        total_accepted_votes: ballotPublished ? 3 : 0,
        spent_commitment_root: ballotPublished ? receiptRoot : null,
        results: ballotPublished ? { proposal_approval: { Yes: 2, No: 1 } } : {},
      },
      result: {
        election_id: mockElection.election_id,
        total_votes: ballotPublished ? 3 : 0,
        results: ballotPublished ? { proposal_approval: { Yes: 2, No: 1 } } : {},
        merkle_root: ballotPublished ? receiptRoot : "",
        total_proofs_burned: ballotPublished ? 3 : 0,
        issuance_commitment_root: "issuance-root-2",
        spent_commitment_root: ballotPublished ? receiptRoot : "",
        max_supply: 3,
        event_id: mockElection.event_id,
        closed_at: now,
      },
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
      tally: ballotPublished ? 3 : 0,
      confirmations: confirmationPublished ? 3 : 0,
      fakeConfirmations: 0,
      canonicalCount: 3,
      flags: ballotPublished ? [] : ["pending"],
    },
    {
      coordinatorNpub: mockCoordinator2.coordinatorNpub,
      tally: ballotPublished ? 3 : 0,
      confirmations: confirmationPublished ? 3 : 0,
      fakeConfirmations: 0,
      canonicalCount: 3,
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
    issuedNpubs.add(activeNpub);
    return {
      quote: "quote-1",
      proofs: [{
        ...mockProof,
        npub: activeNpub,
        secret: `proof-secret-${activeNpub}`,
      }],
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
  computeProofHash: vi.fn(async (secret: string) => `hash-${secret}`),
  isBallotComplete: (answers: Record<string, unknown>, questions: Array<{ id: string }>) =>
    questions.every((q) => answers[q.id] !== undefined),
  publishBallotEvent: vi.fn().mockImplementation(async ({ answers }: { answers: Record<string, string | string[] | number> }) => {
    ballotPublished = true;
    const choice = String(answers.proposal_approval ?? "Yes");
    const eventId = `vote-${Math.floor(Math.random() * 1000)}`;
    return {
      eventId,
      ballotNpub: "npub1ballot",
      ballotSecretKey: new Uint8Array([1]),
      event: {
        id: eventId,
        pubkey: testIdentity.pubkey,
        kind: 38000,
        created_at: now,
        content: JSON.stringify({ election_id: mockElection.election_id, responses: [{ question_id: "proposal_approval", value: choice }], timestamp: now }),
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
    nip17: {
      wrapEvent: vi.fn((_secretKey, _recipient, content, _subject, extra) => ({
        id: extra?.eventId ?? "gift-wrap-1",
        pubkey: testIdentity.pubkey,
        kind: 1059,
        created_at: now,
        content,
        tags: [],
        sig: "sig",
      })),
    },
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
    issuedNpubs = new Set<string>();
    ballotPublished = false;
    confirmationPublished = false;
    demoIdentityIndex = 0;
    activeNpub = testIdentity.npub;
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
    expect(screen.getByRole("table", { name: /Public ballot ledger/i })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Run full demo/i }));
    await waitFor(() => expect(screen.getAllByText(/Confirmation event/i).length).toBeGreaterThan(0), { timeout: 5000 });
    await waitFor(() => expect(screen.getAllByText(/bbbbbbbb\.\.\.bbbb/i).length).toBeGreaterThan(0), { timeout: 5000 });
    await waitFor(() => expect(screen.getByText(/3 minted/i)).toBeTruthy(), { timeout: 5000 });
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
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    dashboard.unmount();
  }, 15000);
});

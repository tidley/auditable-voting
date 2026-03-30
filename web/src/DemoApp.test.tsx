// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./config", () => ({ DEMO_MODE: true, USE_MOCK: false }));
vi.mock("./demoIdentity", () => ({
  createDemoIdentity: () => ({
    nsec: "nsec1demo",
    npub: "npub1demo",
    pubkey: "demo-pubkey",
  }),
}));
vi.mock("./nostrIdentity", () => ({ formatDateTime: (value: number) => `time-${value}`, deriveNpubFromNsec: () => "npub1demo" }));
vi.mock("./voterManagementApi", () => ({
  fetchEligibility: vi.fn().mockResolvedValue({
    eligibleNpubs: ["npub1demo"],
    eligibleCount: 1,
    verifiedNpubs: [],
    verifiedCount: 0,
  }),
  checkEligibility: vi.fn().mockResolvedValue({
    npub: "npub1demo",
    allowed: true,
    canProceed: true,
    message: "npub is in the eligible list",
  }),
}));
vi.mock("./coordinatorApi", () => ({
  fetchCoordinatorInfo: vi.fn().mockResolvedValue({
    coordinatorNpub: "npub1coord",
    mintUrl: "http://mint.example",
    mintPublicKey: "pk",
    relays: ["wss://relay.example"],
    electionId: "e1",
  }),
  fetchEligibility: vi.fn().mockResolvedValue({
    election_id: "e1",
    eligible_count: 1,
    eligible_npubs: ["npub1demo"],
  }),
  fetchElection: vi.fn().mockResolvedValue({
    election_id: "e1",
    event_id: "evt1",
    title: "Election",
    description: "",
    questions: [],
    vote_start: 1,
    vote_end: 2,
    mint_urls: [],
    coordinator_npubs: ["npub1coord"],
  }),
  fetchIssuanceStatus: vi.fn().mockResolvedValue({
    election_id: "e1",
    voters: {
      npub1demo: { eligible: true, issued: true },
    },
  }),
  fetchTally: vi.fn().mockResolvedValue({ status: "in_progress", total_published_votes: 1, total_accepted_votes: 1, spent_commitment_root: null, results: {} }),
  fetchResult: vi.fn().mockResolvedValue({ election_id: "e1", total_votes: 1, results: {}, merkle_root: "r", total_proofs_burned: 1, issuance_commitment_root: "i", spent_commitment_root: "s", max_supply: 1, event_id: "evt1", closed_at: 1 }),
  discoverCoordinators: vi.fn().mockResolvedValue([{ npub: "npub1coord", httpApi: "http://coord.example", mintUrl: "http://mint.example", relays: ["wss://relay.example"] }]),
  fetchPerCoordinatorTallies: vi.fn().mockResolvedValue([]),
  runAudit: vi.fn().mockResolvedValue([]),
}));

describe("DemoApp", () => {
  it("renders the live demo control room", async () => {
    const { default: DemoApp } = await import("./DemoApp");
    render(<DemoApp />);

    expect(await screen.findByText(/AUDITABLE-VOTING/i)).toBeTruthy();
    expect(screen.getByDisplayValue("nsec1demo")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check eligibility/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Mint proof/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Run full demo/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run audit/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish confirmation/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Paste here/i })).toBeTruthy();
    expect(screen.getByText(/Live protocol log/i)).toBeTruthy();
    expect(screen.getAllByText(/Auditors can reconstruct the spent commitment tree from those receipts\./i).length).toBeGreaterThan(0);
  });
});

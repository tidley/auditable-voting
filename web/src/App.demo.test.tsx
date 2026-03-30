// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./config", () => ({ DEMO_MODE: true, DEMO_COPY: { pass: "voting pass" }, MINT_URL: "http://mint.example", USE_MOCK: false }));
vi.mock("./coordinatorApi", () => ({
  fetchCoordinatorInfo: vi.fn().mockResolvedValue({ coordinatorNpub: "npub1coord", mintUrl: "http://mint.example", relays: ["wss://relay.example"], mintPublicKey: "pk", electionId: "e1" }),
  fetchElection: vi.fn().mockResolvedValue({ election_id: "e1", event_id: "evt1", title: "Election", description: "", questions: [], vote_start: 1, vote_end: 2, mint_urls: [], coordinator_npubs: ["npub1coord"] }),
  fetchElectionsFromNostr: vi.fn().mockResolvedValue([]),
  discoverCoordinators: vi.fn().mockResolvedValue([]),
  startIssuanceTracking: vi.fn(),
  awaitIssuanceStatus: vi.fn(),
}));
vi.mock("./voterManagementApi", () => ({ checkEligibility: vi.fn() }));
vi.mock("./mintApi", () => ({ createMintQuote: vi.fn(), checkQuoteStatus: vi.fn() }));
vi.mock("./nostrIdentity", () => ({
  deriveNpubFromNsec: () => "",
  isValidNpub: () => false,
  createCashuClaimEvent: vi.fn(),
  publishCashuClaim: vi.fn(),
  signCashuClaimEvent: vi.fn(),
  formatDateTime: () => "time",
  getNostrEventVerificationUrl: () => "",
}));
vi.mock("./cashuBlind", () => ({ requestQuoteAndMint: vi.fn() }));
vi.mock("./cashuWallet", () => ({ loadStoredWalletBundle: vi.fn().mockReturnValue(null), storeWalletBundle: vi.fn(), addCoordinatorProof: vi.fn() }));
vi.mock("./cashuMintApi", () => ({ logClaimDebug: vi.fn() }));
vi.mock("./signer", () => ({ createRawSigner: vi.fn(), createNip07Signer: vi.fn(), startSignerDetection: () => () => {} }));

describe("App demo stepper copy", () => {
  it("renders demo step labels and actions", async () => {
    const { default: App } = await import("./App");
    render(<App />);

    expect(await screen.findByText(/Verify eligibility and get your voting pass\./i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Request voting pass/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm request/i })).toBeTruthy();
    expect(screen.getByText(/Step 2\.1/i)).toBeTruthy();
    expect(screen.getByText(/Step 2\.2/i)).toBeTruthy();
  });
});

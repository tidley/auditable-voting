// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("./config", () => ({ DEMO_MODE: true }));
const submitProofsToAllCoordinators = vi.fn().mockResolvedValue([{ coordinatorNpub: "npub1coord", result: { eventId: "dm-1", successes: 1, failures: 0, relayResults: [] } }]);
vi.mock("./proofSubmission", () => ({ submitProofViaDm: vi.fn(), submitProofsToAllCoordinators }));
const publishBallotEvent = vi.fn().mockResolvedValue({ eventId: "vote-1", ballotNpub: "npub1ballot", ballotSecretKey: new Uint8Array([1]), event: { id: "vote-1", pubkey: "pk", kind: 38000, created_at: 1, content: "{}", tags: [], sig: "sig" }, relays: ["wss://relay.example"], successes: 1, failures: 0, relayResults: [] });
vi.mock("./ballot", () => ({ BALLOT_EVENT_KIND: 38000, DEFAULT_VOTE_RELAYS: ["wss://relay.example"], isBallotComplete: () => true, publishBallotEvent }));
vi.mock("./cashuWallet", () => ({
  loadStoredWalletBundle: () => ({ election: { electionId: "e1", title: "Election", questions: [{ id: "q1", type: "choice", prompt: "Q?", options: ["A"] }], vote_end: 9999999999, coordinator_npubs: ["npub1coord"] }, coordinatorProofs: [{ coordinatorNpub: "npub1coord", proof: { id: "kid", amount: 1, secret: "s", C: "c" } }], relays: ["wss://relay.example"] }),
  storeBallotEventId: vi.fn(),
}));
vi.mock("./coordinatorApi", () => ({ fetchTally: vi.fn().mockResolvedValue(null), checkVoteAccepted: vi.fn().mockResolvedValue([]) }));
vi.mock("./nostrIdentity", () => ({ formatDateTime: () => "time", getNostrEventVerificationUrl: () => "https://njump.me/e", decodeNsec: () => new Uint8Array([1]) }));
vi.mock("./MerkleTreeViz", () => ({ default: () => null }));

describe("VotingApp demo retry controls", () => {
  it("shows retry buttons after ballot publish in demo mode", async () => {
    const { default: VotingApp } = await import("./VotingApp");
    render(<VotingApp />);

    expect(screen.getByText(/Send your voting pass/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Submit ballot/i }));

    await waitFor(() => expect(submitProofsToAllCoordinators).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Retry send/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry confirmation/i })).toBeTruthy();
  });
});

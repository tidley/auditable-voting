import { describe, expect, it, vi } from "vitest";
import { validateSimpleSubmittedVotes } from "./simpleVoteValidation";

vi.mock("./simpleShardCertificate", () => ({
  verifySimplePublicShardProof: async (proof: { id: string }) => (
    proof.id === "valid-proof"
      ? {
          coordinatorNpub: "npub1coord",
          votingId: "vote-1",
          tokenCommitment: "commit-1",
          shareIndex: 1,
          publicKey: { keyId: "key-1" },
          keyAnnouncement: { votingId: "vote-1" },
          event: proof,
        }
      : proof.id === "valid-proof-2"
        ? {
            coordinatorNpub: "npub1coord2",
            votingId: "vote-1",
            tokenCommitment: "commit-1",
            shareIndex: 1,
            publicKey: { keyId: "key-2" },
            keyAnnouncement: { votingId: "vote-1" },
            event: proof,
          }
        : proof.id === "wrong-round"
          ? {
              coordinatorNpub: "npub1coord",
              votingId: "vote-x",
              tokenCommitment: "commit-1",
              shareIndex: 1,
              publicKey: { keyId: "key-1" },
              keyAnnouncement: { votingId: "vote-x" },
              event: proof,
            }
          : null
  ),
  parseSimplePublicShardProof: () => null,
}));

describe("simpleVoteValidation", () => {
  it("marks votes valid when enough signed shard proofs are present", async () => {
    const results = await validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [{ id: "valid-proof" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1, ["npub1coord"]);

    expect(results[0]).toEqual({
      vote: {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [{ id: "valid-proof" }],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
      valid: true,
      reason: "Valid",
    });
  });

  it("marks votes invalid when shard proofs are missing", async () => {
    const results = await validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [],
        tokenId: null,
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1, ["npub1coord"]);

    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toBe("Not enough valid shards");
  });

  it("marks duplicate combined tokens invalid using canonical event ordering", async () => {
    const results = await validateSimpleSubmittedVotes([
      {
        eventId: "vote-later",
        votingId: "vote-1",
        voterNpub: "npub1ballot2",
        choice: "No",
        shardProofs: [{ id: "valid-proof" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:01:00.000Z",
      },
      {
        eventId: "vote-earlier",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [{ id: "valid-proof" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1, ["npub1coord"]);

    expect(results[0].vote.eventId).toBe("vote-earlier");
    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[1].reason).toBe("Duplicate token");
  });

  it("accepts distinct authorized coordinator shares even when share indexes match", async () => {
    const results = await validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [{ id: "valid-proof" } as any, { id: "valid-proof-2" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 2, ["npub1coord", "npub1coord2"]);

    expect(results[0].valid).toBe(true);
    expect(results[0].reason).toBe("Valid");
  });

  it("rejects shares from unauthorized coordinators", async () => {
    const results = await validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [{ id: "valid-proof-2" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1, ["npub1coord"]);

    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toBe("Unauthorized coordinator share");
  });

  it("rejects proofs that bind to a different round", async () => {
    const results = await validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardProofs: [{ id: "wrong-round" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1, ["npub1coord"]);

    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toBe("Mismatched voting id");
  });
});

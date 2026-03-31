import { describe, expect, it, vi } from "vitest";
import { validateSimpleSubmittedVotes } from "./simpleVoteValidation";

vi.mock("./simpleShardCertificate", () => ({
  parseSimpleShardCertificate: (certificate: { id: string }) => (
    certificate.id === "valid-cert"
      ? {
          shardId: "resp-1",
          coordinatorNpub: "npub1coord",
          thresholdLabel: "1 of 1",
          createdAt: "2026-03-31T00:00:00.000Z",
          event: certificate,
        }
      : null
  ),
}));

describe("simpleVoteValidation", () => {
  it("marks votes valid when enough signed shards are present", () => {
    const results = validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "v-1",
        coordinatorNpub: "npub1coord",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardCertificates: [{ id: "valid-cert" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1);

    expect(results[0]).toEqual({
      vote: {
        eventId: "vote-1",
        votingId: "v-1",
        coordinatorNpub: "npub1coord",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardCertificates: [{ id: "valid-cert" }],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
      valid: true,
      reason: "Valid",
    });
  });

  it("marks votes invalid when signed shards are missing", () => {
    const results = validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "v-1",
        coordinatorNpub: "npub1coord",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardCertificates: [],
        tokenId: null,
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 1);

    expect(results[0].valid).toBe(false);
    expect(results[0].reason).toBe("Not enough valid shards");
  });
});

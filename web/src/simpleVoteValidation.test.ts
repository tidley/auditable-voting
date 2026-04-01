import { describe, expect, it, vi } from "vitest";
import { validateSimpleSubmittedVotes } from "./simpleVoteValidation";

vi.mock("./simpleShardCertificate", () => ({
  parseSimpleShardCertificate: (certificate: { id: string }) => (
    certificate.id === "valid-cert"
      ? {
          shardId: "resp-1",
          coordinatorNpub: "npub1coord",
          thresholdLabel: "1 of 1",
          votingId: "vote-1",
          tokenCommitment: "commit-1",
          shareIndex: 1,
          thresholdT: 1,
          thresholdN: 1,
          createdAt: "2026-03-31T00:00:00.000Z",
          event: certificate,
        }
      : certificate.id === "valid-cert-2"
        ? {
            shardId: "resp-2",
            coordinatorNpub: "npub1coord2",
            thresholdLabel: "2 of 2",
            votingId: "vote-1",
            tokenCommitment: "commit-1",
            shareIndex: 1,
            thresholdT: 2,
            thresholdN: 2,
            createdAt: "2026-03-31T00:00:01.000Z",
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
        votingId: "vote-1",
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
        votingId: "vote-1",
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
        votingId: "vote-1",
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

  it("marks duplicate combined tokens invalid", () => {
    const results = validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardCertificates: [{ id: "valid-cert" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
      {
        eventId: "vote-2",
        votingId: "vote-1",
        voterNpub: "npub1ballot2",
        choice: "No",
        shardCertificates: [{ id: "valid-cert" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:01:00.000Z",
      },
    ], 1);

    expect(results[0].valid).toBe(true);
    expect(results[1].valid).toBe(false);
    expect(results[1].reason).toBe("Duplicate token");
  });

  it("accepts distinct coordinator shares even when share indexes match", () => {
    const results = validateSimpleSubmittedVotes([
      {
        eventId: "vote-1",
        votingId: "vote-1",
        voterNpub: "npub1ballot",
        choice: "Yes",
        shardCertificates: [{ id: "valid-cert" } as any, { id: "valid-cert-2" } as any],
        tokenId: "token-1",
        createdAt: "2026-03-31T00:00:00.000Z",
      },
    ], 2);

    expect(results[0].valid).toBe(true);
    expect(results[0].reason).toBe("Valid");
  });
});

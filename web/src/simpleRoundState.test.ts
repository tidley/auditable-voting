import { describe, expect, it, vi } from "vitest";
import { buildSimpleVoteTicketRows, reconcileSimpleKnownRounds } from "./simpleRoundState";

vi.mock("./simpleShardCertificate", () => ({
  parseSimpleShardCertificate: vi.fn((certificate: any) => (
    certificate
      ? {
          shardId: certificate.shareId,
          requestId: certificate.requestId,
          coordinatorNpub: certificate.coordinatorNpub,
          votingId: certificate.votingId,
          tokenCommitment: certificate.tokenMessage,
          shareIndex: certificate.shareIndex,
          thresholdT: certificate.thresholdT,
          thresholdN: certificate.thresholdN,
          createdAt: certificate.createdAt,
          publicKey: { keyId: "blind-key-1" },
          event: certificate,
        }
      : null
  )),
}));

describe("simpleRoundState", () => {
  it("builds ticket rows from received blind-share certificates", () => {
    const rows = buildSimpleVoteTicketRows([
      {
        id: "resp-1",
        requestId: "request-1",
        coordinatorNpub: "npub1coord1",
        coordinatorId: "coord1",
        thresholdLabel: "2 of 2",
        createdAt: "2026-04-02T00:00:00.000Z",
        votingPrompt: "Question one",
        blindShareResponse: {},
        shardCertificate: {
          shareId: "share-1",
          requestId: "request-1",
          coordinatorNpub: "npub1coord1",
          votingId: "vote-1",
          tokenMessage: "token-1",
          shareIndex: 1,
          thresholdT: 2,
          thresholdN: 2,
          createdAt: "2026-04-02T00:00:00.000Z",
          keyAnnouncementEvent: { id: "blind-key-1" },
        },
      },
      {
        id: "resp-2",
        requestId: "request-2",
        coordinatorNpub: "npub1coord2",
        coordinatorId: "coord2",
        thresholdLabel: "2 of 2",
        createdAt: "2026-04-02T00:00:01.000Z",
        votingPrompt: "Question one",
        blindShareResponse: {},
        shardCertificate: {
          shareId: "share-2",
          requestId: "request-2",
          coordinatorNpub: "npub1coord2",
          votingId: "vote-1",
          tokenMessage: "token-1",
          shareIndex: 2,
          thresholdT: 2,
          thresholdN: 2,
          createdAt: "2026-04-02T00:00:01.000Z",
          keyAnnouncementEvent: { id: "blind-key-2" },
        },
      },
    ] as any, ["npub1coord1", "npub1coord2"]);

    expect(rows).toEqual([
      {
        votingId: "vote-1",
        prompt: "Question one",
        createdAt: "2026-04-02T00:00:01.000Z",
        thresholdT: 2,
        thresholdN: 2,
        countsByCoordinator: {
          npub1coord1: 1,
          npub1coord2: 1,
        },
      },
    ]);
  });

  it("reconciles known rounds from live sessions and ticket rows", () => {
    const reconciled = reconcileSimpleKnownRounds({
      configuredCoordinatorTargets: ["npub1coord1"],
      discoveredSessions: [
        {
          votingId: "vote-1",
          prompt: "Question from relay",
          coordinatorNpub: "npub1coord1",
          createdAt: "2026-04-02T00:00:00.000Z",
          thresholdT: 1,
          thresholdN: 1,
          eventId: "live-1",
        },
      ],
      receivedShards: [
        {
          id: "resp-1",
          requestId: "request-1",
          coordinatorNpub: "npub1coord1",
          coordinatorId: "coord1",
          thresholdLabel: "1 of 1",
          createdAt: "2026-04-02T00:00:02.000Z",
          votingPrompt: "Question from ticket",
          blindShareResponse: {},
          shardCertificate: {
            shareId: "share-1",
            requestId: "request-1",
            coordinatorNpub: "npub1coord1",
            votingId: "vote-2",
            tokenMessage: "token-2",
            shareIndex: 1,
            thresholdT: 1,
            thresholdN: 1,
            createdAt: "2026-04-02T00:00:02.000Z",
            keyAnnouncementEvent: { id: "blind-key-1" },
          },
        },
      ] as any,
    });

    expect(reconciled.knownRounds.map((round) => round.votingId)).toEqual(["vote-2", "vote-1"]);
    expect(reconciled.ticketRows[0]?.votingId).toBe("vote-2");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const publishMock = vi.fn(() => [Promise.resolve()]);
const queueMock = vi.fn((task: () => Promise<unknown>) => task());

vi.mock("nostr-tools", () => ({
  finalizeEvent: vi.fn((event) => ({ ...event, id: "vote-1", pubkey: "pubkey-1", sig: "sig-1" })),
  generateSecretKey: vi.fn(() => new Uint8Array([1, 2, 3])),
  getPublicKey: vi.fn(() => "pubkey-1"),
  nip19: { npubEncode: vi.fn(() => "npub1ballot") },
  SimplePool: class {
    publish(...args: unknown[]) {
      return publishMock(...args);
    }

    destroy() {}
  },
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (...args: Parameters<typeof queueMock>) => queueMock(...args),
}));

vi.mock("./cashuMintApi", () => ({
  logBallotDebug: vi.fn(),
}));

vi.mock("./config", () => ({
  USE_MOCK: false,
}));

import { isBallotComplete, publishBallotEvent } from "./ballot";

describe("isBallotComplete", () => {
  beforeEach(() => {
    publishMock.mockClear();
    queueMock.mockClear();
  });

  it("requires all questions to be answered", () => {
    const questions = [
      { id: "q1", type: "choice", prompt: "A" },
      { id: "q2", type: "text", prompt: "B" },
    ] as any;

    expect(isBallotComplete({ q1: "yes" }, questions)).toBe(false);
    expect(isBallotComplete({ q1: "yes", q2: "hello" }, questions)).toBe(true);
  });

  it("requires at least one option for multi-select questions", () => {
    const questions = [
      { id: "q1", type: "choice", select: "multiple", prompt: "A" },
    ] as any;

    expect(isBallotComplete({ q1: [] }, questions)).toBe(false);
    expect(isBallotComplete({ q1: ["x"] }, questions)).toBe(true);
  });

  it("publishes token_id and token-id tag with the ballot", async () => {
    const result = await publishBallotEvent({
      electionId: "election-1",
      questions: [{ id: "q1", type: "choice", prompt: "A" }] as any,
      answers: { q1: "yes" },
      relays: ["wss://relay.example"],
      coordinatorProofs: [{
        coordinatorNpub: "npub1coord",
        mintUrl: "http://mint.example",
        proof: { id: "kid", amount: 1, secret: "secret-a", C: "c" },
        proofSecret: "secret-a",
      }],
    });

    expect(result.tokenId).toBeTruthy();
    expect(result.event.content).toContain("\"token_id\"");
    expect(result.event.tags.some((tag) => tag[0] === "token-id" && tag[1] === result.tokenId)).toBe(true);
  });
});

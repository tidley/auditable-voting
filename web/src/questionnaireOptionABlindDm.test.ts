import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip17, nip19 } from "nostr-tools";
import type { SignerService } from "./services/signerService";
import {
  fetchOptionABallotAcceptanceDmsWithNsec,
  fetchOptionABallotSubmissionDmsWithNsec,
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionABlindRequestDmsWithNsec,
  publishOptionABlindRequestDm,
} from "./questionnaireOptionABlindDm";

const querySync = vi.fn();
const publish = vi.fn();
const queueNostrPublish = vi.fn();
const publishToRelaysStaggered = vi.fn();

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ querySync, publish }),
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (...args: unknown[]) => queueNostrPublish(...args),
  publishToRelaysStaggered: (...args: unknown[]) => publishToRelaysStaggered(...args),
}));

function makeSigner(overrides: Partial<SignerService> = {}): SignerService {
  return {
    isAvailable: async () => true,
    getPublicKey: async () => "f".repeat(64),
    signMessage: async () => "sig",
    signEvent: async <T extends Record<string, unknown>>(event: T) => ({ ...event, id: "event-1", sig: "sig", pubkey: "f".repeat(64) }),
    nip44Encrypt: async () => "ciphertext",
    nip44Decrypt: async () => "",
    ...overrides,
  };
}

describe("questionnaireOptionABlindDm", () => {
  beforeEach(() => {
    querySync.mockReset();
    publish.mockReset();
    queueNostrPublish.mockReset();
    publishToRelaysStaggered.mockReset();
  });

  it("publishes a blind request DM as gift-wrapped event", async () => {
    publish.mockReturnValue([Promise.resolve(undefined)]);
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) => Promise.allSettled(relays.slice(0, 1).map((relay) => publishOne(relay))),
    );
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());

    const invitedHex = getPublicKey(generateSecretKey());
    const recipientHex = getPublicKey(generateSecretKey());
    const request = {
      type: "blind_ballot_request" as const,
      schemaVersion: 1 as const,
      electionId: "q_1",
      requestId: "request_1",
      invitedNpub: nip19.npubEncode(invitedHex),
      blindedMessage: "blind_1",
      clientNonce: "nonce_1",
      createdAt: new Date().toISOString(),
    };

    const result = await publishOptionABlindRequestDm({
      signer: makeSigner(),
      recipientNpub: nip19.npubEncode(recipientHex),
      request,
    });

    expect(result.successes).toBe(1);
    expect(result.failures).toBe(0);
    const event = publish.mock.calls[0]?.[1] as { kind: number; tags: string[][] };
    expect(event.kind).toBe(1059);
    expect(event.tags[0]?.[0]).toBe("p");
  });

  it("mixes recipient NIP-17 relay hints with fallback relays for delivery", async () => {
    querySync.mockResolvedValue([{
      kind: 10050,
      created_at: 10,
      tags: [
        ["relay", "wss://recipient.one"],
        ["relay", "wss://recipient.two"],
        ["relay", "wss://recipient.three"],
        ["relay", "wss://recipient.four"],
      ],
    }]);
    publish.mockReturnValue([Promise.resolve(undefined)]);
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) => Promise.allSettled(relays.map((relay) => publishOne(relay))),
    );
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());

    const recipientHex = getPublicKey(generateSecretKey());
    await publishOptionABlindRequestDm({
      signer: makeSigner(),
      recipientNpub: nip19.npubEncode(recipientHex),
      request: {
        type: "blind_ballot_request",
        schemaVersion: 1,
        electionId: "q_1",
        requestId: "request_1",
        invitedNpub: nip19.npubEncode(getPublicKey(generateSecretKey())),
        blindedMessage: "blind_1",
        tokenCommitment: "token_1",
        blindSigningKeyId: "key_1",
        clientNonce: "nonce_1",
        createdAt: new Date().toISOString(),
      },
    });

    const relays = publishToRelaysStaggered.mock.calls[0]?.[1] as string[];
    expect(relays.slice(0, 6)).toEqual([
      "wss://recipient.one",
      "wss://recipient.two",
      "wss://nip17.com",
      "wss://nip17.tomdwyer.uk",
      "wss://recipient.three",
      "wss://recipient.four",
    ]);
  });

  it("reads blind request and issuance DMs via local nsec", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();

    const request = {
      type: "blind_ballot_request" as const,
      schemaVersion: 1 as const,
      electionId: "q_2",
      requestId: "request_2",
      invitedNpub: recipientNpub,
      blindedMessage: "blind_2",
      clientNonce: "nonce_2",
      createdAt: new Date().toISOString(),
    };

    const issuance = {
      type: "blind_ballot_response" as const,
      schemaVersion: 1 as const,
      electionId: "q_2",
      requestId: "request_2",
      issuanceId: "issuance_2",
      invitedNpub: recipientNpub,
      blindSignature: "sig_2",
      issuedAt: new Date().toISOString(),
    };

    const wrappedRequest = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_blind_request_dm",
        schemaVersion: 1,
        request,
        sentAt: new Date().toISOString(),
      }),
      "Option A blind request",
    );

    const wrappedIssuance = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_blind_issuance_dm",
        schemaVersion: 1,
        issuance,
        sentAt: new Date().toISOString(),
      }),
      "Option A blind issuance",
    );

    querySync.mockResolvedValue([wrappedRequest, wrappedIssuance]);

    const fetchedRequests = await fetchOptionABlindRequestDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_2",
      limit: 20,
    });
    const fetchedIssuances = await fetchOptionABlindIssuanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_2",
      limit: 20,
    });

    expect(fetchedRequests).toHaveLength(1);
    expect(fetchedRequests[0]?.requestId).toBe("request_2");
    expect(fetchedIssuances).toHaveLength(1);
    expect(fetchedIssuances[0]?.issuanceId).toBe("issuance_2");
  });

  it("falls back to broader relay reads when the primary issuance scan is empty", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();

    const issuance = {
      type: "blind_ballot_response" as const,
      schemaVersion: 1 as const,
      electionId: "q_fallback",
      requestId: "request_fallback",
      issuanceId: "issuance_fallback",
      invitedNpub: recipientNpub,
      blindSignature: "sig_fallback",
      issuedAt: new Date().toISOString(),
    };

    const wrappedIssuance = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_blind_issuance_dm",
        schemaVersion: 1,
        issuance,
        sentAt: new Date().toISOString(),
      }),
      "Option A blind issuance",
    );

    querySync
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([wrappedIssuance]);

    const fetchedIssuances = await fetchOptionABlindIssuanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_fallback",
      limit: 20,
    });

    expect(fetchedIssuances).toHaveLength(1);
    expect(fetchedIssuances[0]?.issuanceId).toBe("issuance_fallback");
    expect(querySync).toHaveBeenCalledTimes(2);
  });

  it("reads ballot submission and acceptance DMs via local nsec", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();
    const senderNpub = nip19.npubEncode(getPublicKey(senderSecret));

    const submission = {
      type: "ballot_submission" as const,
      schemaVersion: 1 as const,
      electionId: "q_3",
      submissionId: "submission_3",
      invitedNpub: senderNpub,
      responseNpub: senderNpub,
      credential: "sig_3",
      nullifier: "nullifier_3",
      payload: {
        electionId: "q_3",
        responses: [{ questionId: "q1", type: "yes_no" as const, answer: "yes" as const }],
      },
      submittedAt: new Date().toISOString(),
    };
    const acceptance = {
      type: "ballot_acceptance_result" as const,
      schemaVersion: 1 as const,
      electionId: "q_3",
      submissionId: "submission_3",
      accepted: true,
      decidedAt: new Date().toISOString(),
    };

    const wrappedSubmission = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_ballot_submission_dm",
        schemaVersion: 1,
        submission,
        sentAt: new Date().toISOString(),
      }),
      "Option A ballot submission",
    );
    const wrappedAcceptance = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_ballot_acceptance_dm",
        schemaVersion: 1,
        acceptance,
        sentAt: new Date().toISOString(),
      }),
      "Option A ballot acceptance",
    );

    querySync.mockResolvedValue([wrappedSubmission, wrappedAcceptance]);

    const fetchedSubmissions = await fetchOptionABallotSubmissionDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_3",
      limit: 20,
    });
    const fetchedAcceptances = await fetchOptionABallotAcceptanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_3",
      limit: 20,
    });

    expect(fetchedSubmissions).toHaveLength(1);
    expect(fetchedSubmissions[0]?.submissionId).toBe("submission_3");
    expect(fetchedAcceptances).toHaveLength(1);
    expect(fetchedAcceptances[0]?.submissionId).toBe("submission_3");
  });
});

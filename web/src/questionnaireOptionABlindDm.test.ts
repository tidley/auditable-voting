import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey, nip17, nip19, nip44 } from "nostr-tools";
import type { SignerService } from "./services/signerService";
import {
  buildOptionABlindIssuanceBundleEnvelope,
  encodeOptionADmEnvelopeContent,
  fetchOptionABallotAcceptanceDmsWithNsec,
  fetchOptionABallotSubmissionDmsWithNsec,
  fetchOptionABlindIssuanceDms,
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionABlindRequestDmsWithNsec,
  fetchOptionAParticipantStatusDms,
  fetchOptionAParticipantStatusDmsWithNsec,
  parseOptionADmEnvelopeContent,
  parseBlindBallotPlanDmContent,
  parseOptionAParticipantStatusDmContent,
  publishOptionABlindRequestDm,
  publishOptionAParticipantStatusDm,
  type OptionAParticipantStatus,
} from "./questionnaireOptionABlindDm";
import type { BlindBallotIssuance, BlindBallotRequest } from "./questionnaireOptionA";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { questionnaireDefinitionHash } from "./questionnaireDefinitionReference";

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

function makeDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    protocolVersion: 2,
    flowMode: "public_submission_v1",
    responseMode: "blind_token",
    questionnaireId: "q_bundle",
    title: "Bundle",
    description: "Bundle test",
    createdAt: 1,
    openAt: 1,
    closeAt: 2,
    coordinatorPubkey: "coordinator",
    coordinatorEncryptionPubkey: "coordinator",
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    ballotCredentialMode: "per_question",
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: "Question 1",
        required: true,
        ballotSlot: { slotId: "q1:1", slotIndex: 1, version: 1 },
      },
    ],
  };
}

function makeIssuance(
  requestId: string,
  definition: QuestionnaireDefinition,
): BlindBallotIssuance {
  return {
    type: "blind_ballot_response",
    schemaVersion: 1,
    electionId: definition.questionnaireId,
    requestId,
    issuanceId: `issuance_${requestId}`,
    invitedNpub: "npub1voter",
    blindSigningKeyId: "key",
    blindSignature: "signature",
    ballotScope: {
      questionId: requestId,
      slotId: `${requestId}:1`,
      slotIndex: 1,
      version: 1,
    },
    definition,
    issuedAt: "2026-06-18T00:00:00.000Z",
  };
}

function makeRequest(input: { requestId: string; invitedNpub: string; padding?: string }): BlindBallotRequest {
  return {
    type: "blind_ballot_request",
    schemaVersion: 1,
    electionId: "q_bundle",
    requestId: input.requestId,
    invitedNpub: input.invitedNpub,
    blindedMessage: `blind_${input.requestId}${input.padding ?? ""}`,
    blindSigningKeyId: "key",
    clientNonce: `nonce_${input.requestId}`,
    createdAt: "2026-06-18T00:00:00.000Z",
    ballotScope: {
      questionId: input.requestId,
      slotId: `${input.requestId}:1`,
      slotIndex: 1,
      version: 1,
    },
  };
}

function makeParticipantStatus(input: Partial<OptionAParticipantStatus> & Pick<OptionAParticipantStatus, "invitedNpub">): OptionAParticipantStatus {
  return {
    type: "participant_status",
    schemaVersion: 1,
    electionId: "q_status",
    source: "voter",
    state: "voter_live",
    observedAt: "2026-07-15T12:00:00.000Z",
    ...input,
  };
}

function wrapParticipantStatus(input: {
  senderSecret: Uint8Array;
  recipientHex: string;
  status: OptionAParticipantStatus;
}) {
  return nip17.wrapEvent(
    input.senderSecret,
    { publicKey: input.recipientHex, relayUrl: "wss://relay.example" },
    JSON.stringify({
      type: "optiona_participant_status_dm",
      schemaVersion: 1,
      status: input.status,
      sentAt: "2026-07-15T12:00:01.000Z",
    }),
    "Auditable Voting participant status",
  );
}

describe("questionnaireOptionABlindDm", () => {
  it("parses only a complete two-credential issuer ballot plan", () => {
    const plan = parseBlindBallotPlanDmContent(JSON.stringify({
      type: "optiona_blind_ballot_plan_dm",
      schemaVersion: 1,
      sentAt: "2026-07-19T00:00:00.000Z",
      plan: {
        type: "blind_ballot_plan", schemaVersion: 1, planId: "plan_1",
        electionId: "election_1", invitedNpub: "npub1voter", issuerNpub: "npub1issuer",
        initialRequestId: "request_1", blindSigningKeyId: "key_1", credentialCount: 2,
        ballotScopes: [{ credentialIndex: 1 }, { credentialIndex: 2 }], issuedAt: "2026-07-19T00:00:00.000Z",
      },
    }));
    expect(plan?.credentialCount).toBe(2);
    expect(parseBlindBallotPlanDmContent(JSON.stringify({ type: "blind_ballot_plan", schemaVersion: 1, credentialCount: 3 }))).toBeNull();
  });
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

  it("publishes and parses a participant status DM roundtrip", async () => {
    querySync.mockResolvedValue([]);
    publish.mockReturnValue([Promise.resolve(undefined)]);
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) => Promise.allSettled(relays.slice(0, 1).map((relay) => publishOne(relay))),
    );
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());
    const voterSecret = generateSecretKey();
    const organiserSecret = generateSecretKey();
    const status = makeParticipantStatus({
      invitedNpub: nip19.npubEncode(getPublicKey(voterSecret)),
    });

    const result = await publishOptionAParticipantStatusDm({
      signer: makeSigner(),
      fallbackNsec: nip19.nsecEncode(voterSecret),
      recipientNpub: nip19.npubEncode(getPublicKey(organiserSecret)),
      status,
    });
    const giftWrap = publish.mock.calls[0]?.[1];
    querySync.mockResolvedValue([giftWrap]);

    const fetched = await fetchOptionAParticipantStatusDmsWithNsec({
      nsec: nip19.nsecEncode(organiserSecret),
      electionId: "q_status",
    });
    const content = JSON.stringify({
      type: "optiona_participant_status_dm",
      schemaVersion: 1,
      status,
      sentAt: "2026-07-15T12:00:01.000Z",
    });

    expect(result.successes).toBe(1);
    expect(parseOptionAParticipantStatusDmContent(content)).toEqual(status);
    expect(parseOptionAParticipantStatusDmContent(JSON.stringify({ ...JSON.parse(content), schemaVersion: 2 }))).toBeNull();
    expect(fetched).toEqual([status]);
  });

  it("validates voter and issuer proxy participant status seal senders", async () => {
    const organiserSecret = generateSecretKey();
    const organiserHex = getPublicKey(organiserSecret);
    const voterSecret = generateSecretKey();
    const workerSecret = generateSecretKey();
    const workerNpub = nip19.npubEncode(getPublicKey(workerSecret));
    const voterStatus = makeParticipantStatus({
      invitedNpub: nip19.npubEncode(getPublicKey(voterSecret)),
    });
    const proxyStatus = makeParticipantStatus({
      invitedNpub: nip19.npubEncode(getPublicKey(generateSecretKey())),
      source: "issuer_proxy",
      state: "ballot_issued",
      issuanceId: "issuance_status",
    });
    querySync.mockResolvedValue([
      wrapParticipantStatus({ senderSecret: voterSecret, recipientHex: organiserHex, status: voterStatus }),
      wrapParticipantStatus({ senderSecret: workerSecret, recipientHex: organiserHex, status: proxyStatus }),
    ]);

    const fetched = await fetchOptionAParticipantStatusDmsWithNsec({
      nsec: nip19.nsecEncode(organiserSecret),
      electionId: "q_status",
      workerNpub,
    });

    expect(fetched).toEqual(expect.arrayContaining([voterStatus, proxyStatus]));
    expect(fetched).toHaveLength(2);
  });

  it("filters organiser participant status reads by election", async () => {
    const organiserSecret = generateSecretKey();
    const organiserHex = getPublicKey(organiserSecret);
    const targetVoter = generateSecretKey();
    const otherVoter = generateSecretKey();
    const target = makeParticipantStatus({ invitedNpub: nip19.npubEncode(getPublicKey(targetVoter)) });
    const other = makeParticipantStatus({
      electionId: "q_other",
      invitedNpub: nip19.npubEncode(getPublicKey(otherVoter)),
    });
    querySync.mockResolvedValue([
      wrapParticipantStatus({ senderSecret: targetVoter, recipientHex: organiserHex, status: target }),
      wrapParticipantStatus({ senderSecret: otherVoter, recipientHex: organiserHex, status: other }),
    ]);

    const fetched = await fetchOptionAParticipantStatusDmsWithNsec({
      nsec: nip19.nsecEncode(organiserSecret),
      electionId: "q_status",
    });

    expect(fetched).toEqual([target]);
  });

  it("rejects participant status forged by a different signer", async () => {
    const organiserSecret = generateSecretKey();
    const organiserHex = getPublicKey(organiserSecret);
    const voterSecret = generateSecretKey();
    const attackerSecret = generateSecretKey();
    const status = makeParticipantStatus({
      invitedNpub: nip19.npubEncode(getPublicKey(voterSecret)),
      state: "ballot_received",
      issuanceId: "issuance_status",
    });
    querySync.mockResolvedValue([
      wrapParticipantStatus({ senderSecret: attackerSecret, recipientHex: organiserHex, status }),
    ]);
    const signer = makeSigner({
      getPublicKey: async () => organiserHex,
      nip44Decrypt: async (pubkey, payload) => nip44.v2.decrypt(
        payload,
        nip44.v2.utils.getConversationKey(organiserSecret, pubkey),
      ),
    });

    const fetched = await fetchOptionAParticipantStatusDms({
      signer,
      electionId: "q_status",
    });

    expect(fetched).toEqual([]);
  });

  it("rejects identity-linked participant activity after ballot receipt", () => {
    const content = JSON.stringify({
      type: "optiona_participant_status_dm",
      schemaVersion: 1,
      status: {
        type: "participant_status",
        schemaVersion: 1,
        electionId: "q_status",
        invitedNpub: "npub1voter",
        source: "voter",
        state: "vote_submitted",
        observedAt: "2026-07-16T00:00:04.000Z",
        submissionId: "submission_status",
      },
      sentAt: "2026-07-16T00:00:04.000Z",
    });

    expect(parseOptionAParticipantStatusDmContent(content)).toBeNull();
  });

  it("rejects ballot receipt claimed by an issuer proxy", () => {
    const content = JSON.stringify({
      type: "optiona_participant_status_dm",
      schemaVersion: 1,
      status: {
        type: "participant_status",
        schemaVersion: 1,
        electionId: "q_status",
        invitedNpub: "npub1voter",
        source: "issuer_proxy",
        state: "ballot_received",
        observedAt: "2026-07-16T00:00:03.000Z",
        requestId: "request_status",
        issuanceId: "issuance_status",
      },
      sentAt: "2026-07-16T00:00:03.000Z",
    });

    expect(parseOptionAParticipantStatusDmContent(content)).toBeNull();
  });

  it("uses configured relays for delivery without recipient relay hints", async () => {
    querySync.mockResolvedValue([{
      kind: 10050,
      created_at: 10,
      tags: [
        ["relay", "wss://recipient.one"],
        ["relay", "wss://recipient.two"],
        ["relay", "wss://relay.nostr.info"],
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
        blindSigningKeyId: "key_1",
        clientNonce: "nonce_1",
        createdAt: new Date().toISOString(),
      },
    });

    const relays = publishToRelaysStaggered.mock.calls[0]?.[1] as string[];
    expect(relays).toEqual([
      "wss://vm-1734.lnvps.cloud/",
      "wss://relay.nostr.net",
      "wss://nos.lol",
    ]);
    expect(relays).not.toContain("wss://relay.nostr.info");
  });

  it("builds issuance bundles with a shared definition hash and no definition payload", () => {
    const definition = makeDefinition();
    const definitionHash = questionnaireDefinitionHash(definition);
    const envelope = buildOptionABlindIssuanceBundleEnvelope({
      issuances: [
        makeIssuance("q1", definition),
        makeIssuance("q2", definition),
      ],
      sentAt: "2026-06-18T00:00:01.000Z",
    });

    expect(envelope.definition).toBeUndefined();
    expect(envelope.definitionHash).toBe(definitionHash);
    expect(envelope.issuances).toHaveLength(2);
    expect(envelope.issuances.every((issuance) => issuance.definition === undefined)).toBe(true);
    expect(envelope.issuances.every((issuance) => issuance.definitionHash === definitionHash)).toBe(true);

    const serialized = JSON.parse(JSON.stringify(envelope)) as {
      definition?: QuestionnaireDefinition;
      definitionHash?: string;
      issuances: Array<Record<string, unknown>>;
    };
    expect(serialized.definition).toBeUndefined();
    expect(serialized.definitionHash).toBe(definitionHash);
    expect(serialized.issuances.every((issuance) => !("definition" in issuance))).toBe(true);
    expect(serialized.issuances.every((issuance) => issuance.definitionHash === definitionHash)).toBe(true);
  });

  it("keeps small bundle envelopes as plain JSON", () => {
    const recipientNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const envelope = {
      type: "optiona_blind_request_bundle_dm" as const,
      schemaVersion: 1 as const,
      requests: [makeRequest({ requestId: "request_small", invitedNpub: recipientNpub })],
      sentAt: "2026-06-18T00:00:00.000Z",
    };

    const content = encodeOptionADmEnvelopeContent(envelope);
    const parsed = JSON.parse(content) as { type?: string };

    expect(parsed.type).toBe("optiona_blind_request_bundle_dm");
    expect(parseOptionADmEnvelopeContent(content)).toEqual(envelope);
  });

  it("decodes compressed blind request bundles for organiser intake", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = recipientSecret;
    const envelope = {
      type: "optiona_blind_request_bundle_dm" as const,
      schemaVersion: 1 as const,
      requests: [
        {
          ...makeRequest({
            requestId: "request_compressed_1",
            invitedNpub: recipientNpub,
            padding: "x".repeat(16_000),
          }),
          tokenCommitment: "legacy-request-leak",
          ballotScope: {
            questionId: "request_compressed_1",
            slotId: "request_compressed_1:1",
            slotIndex: 1,
            version: 1,
            tokenCommitment: "legacy-nested-leak",
          },
        } as unknown as BlindBallotRequest,
      ],
      sentAt: "2026-06-18T00:00:00.000Z",
    };
    const content = encodeOptionADmEnvelopeContent(envelope);
    const wrapper = JSON.parse(content) as { type?: string; innerType?: string };

    expect(wrapper.type).toBe("optiona_compressed_bundle_dm");
    expect(wrapper.innerType).toBe("optiona_blind_request_bundle_dm");

    const wrappedRequest = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      content,
      "Option A blind request bundle",
    );
    querySync.mockResolvedValue([wrappedRequest]);

    const fetchedRequests = await fetchOptionABlindRequestDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_bundle",
      limit: 20,
    });

    expect(fetchedRequests).toHaveLength(1);
    expect(fetchedRequests[0]?.requestId).toBe("request_compressed_1");
    expect(fetchedRequests[0] as unknown as Record<string, unknown>).not.toHaveProperty("tokenCommitment");
    expect(fetchedRequests[0]?.ballotScope as unknown as Record<string, unknown>).not.toHaveProperty("tokenCommitment");
  });

  it("decodes compressed blind issuance bundles for voter intake", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();
    const definition = makeDefinition();
    const issuances = Array.from({ length: 24 }, (_, index) => ({
      ...makeIssuance(`q${index + 1}`, definition),
      blindSignature: `signature_${index}_${"y".repeat(600)}`,
      tokenCommitment: `legacy-issuance-leak-${index + 1}`,
      ballotScope: {
        questionId: `q${index + 1}`,
        slotId: `q${index + 1}:1`,
        slotIndex: 1,
        version: 1,
        tokenCommitment: `legacy-nested-leak-${index + 1}`,
      },
    }));
    const envelope = buildOptionABlindIssuanceBundleEnvelope({
      issuances,
      sentAt: "2026-06-18T00:00:01.000Z",
    });
    (envelope.issuances[0] as unknown as Record<string, unknown>).tokenCommitment = "legacy-issuance-leak";
    (envelope.issuances[0]?.ballotScope as unknown as Record<string, unknown>).tokenCommitment = "legacy-nested-leak";
    const content = encodeOptionADmEnvelopeContent(envelope);
    const wrapper = JSON.parse(content) as { type?: string; innerType?: string };

    expect(wrapper.type).toBe("optiona_compressed_bundle_dm");
    expect(wrapper.innerType).toBe("optiona_blind_issuance_bundle_dm");

    const wrappedIssuance = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      content,
      "Option A blind issuance bundle",
    );
    querySync.mockResolvedValue([wrappedIssuance]);

    const fetchedIssuances = await fetchOptionABlindIssuanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: definition.questionnaireId,
      limit: 30,
    });

    expect(fetchedIssuances).toHaveLength(24);
    expect(fetchedIssuances[0]?.definitionHash).toBe(questionnaireDefinitionHash(definition));
    expect(fetchedIssuances[0] as unknown as Record<string, unknown>).not.toHaveProperty("tokenCommitment");
    expect(fetchedIssuances[0]?.ballotScope as unknown as Record<string, unknown>).not.toHaveProperty("tokenCommitment");
    expect(fetchedIssuances.at(-1)?.issuanceId).toBe("issuance_q24");
  });

  it("rejects a blind request whose authenticated sender is not the invited voter", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const attackerSecret = generateSecretKey();
    const wrappedRequest = nip17.wrapEvent(
      attackerSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_blind_request_dm",
        schemaVersion: 1,
        request: makeRequest({ requestId: "forged_request", invitedNpub: recipientNpub }),
        sentAt: new Date().toISOString(),
      }),
      "Forged blind request",
    );
    querySync.mockResolvedValue([wrappedRequest]);

    await expect(fetchOptionABlindRequestDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_bundle",
    })).resolves.toEqual([]);
  });

  it("rejects compressed bundles that exceed the decode limit", () => {
    expect(() => parseOptionADmEnvelopeContent(JSON.stringify({
      type: "optiona_compressed_bundle_dm",
      schemaVersion: 1,
      encoding: "gzip+base64url",
      innerType: "optiona_blind_request_bundle_dm",
      payload: "",
      compressedLength: 0,
      originalLength: 1024 * 1024 + 1,
    }))).toThrow("exceeds the supported size");
  });

  it("reads blind request and issuance DMs via local nsec", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = recipientSecret;

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

  it("hydrates bundled issuance definitions from the shared envelope definition", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();
    const definition = makeDefinition();
    const issuance = {
      ...makeIssuance("q1", definition),
      definition: undefined,
    };

    const wrappedIssuance = nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_blind_issuance_bundle_dm",
        schemaVersion: 1,
        definition,
        issuances: [issuance],
        sentAt: new Date().toISOString(),
      }),
      "Option A blind issuance",
    );

    querySync.mockResolvedValue([wrappedIssuance]);

    const fetchedIssuances = await fetchOptionABlindIssuanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: definition.questionnaireId,
      limit: 20,
    });

    expect(fetchedIssuances).toHaveLength(1);
    expect(fetchedIssuances[0]?.issuanceId).toBe("issuance_q1");
    expect(fetchedIssuances[0]?.definition).toEqual(definition);
  });

  it("does not use recipient relay hints when the configured issuance scan is empty", async () => {
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

    expect(fetchedIssuances).toHaveLength(0);
    expect(querySync).toHaveBeenCalledTimes(1);
  });

  it("does not use recipient relay hints when configured relays contain another issuance", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();
    const wrapIssuance = (requestId: string, issuanceId: string) => nip17.wrapEvent(
      senderSecret,
      { publicKey: recipientHex, relayUrl: "wss://relay.example" },
      JSON.stringify({
        type: "optiona_blind_issuance_dm",
        schemaVersion: 1,
        issuance: {
          type: "blind_ballot_response",
          schemaVersion: 1,
          electionId: "q_target_fallback",
          requestId,
          issuanceId,
          invitedNpub: nip19.npubEncode(recipientHex),
          blindSignature: `sig_${issuanceId}`,
          issuedAt: new Date().toISOString(),
        },
        sentAt: new Date().toISOString(),
      }),
      "Option A blind issuance",
    );

    querySync
      .mockResolvedValueOnce([wrapIssuance("request_other", "issuance_other")])
      .mockResolvedValueOnce([wrapIssuance("request_target", "issuance_target")]);

    const fetchedIssuances = await fetchOptionABlindIssuanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_target_fallback",
      targetRequestId: "request_target",
      limit: 20,
    });

    expect(fetchedIssuances.some((issuance) => issuance.issuanceId === "issuance_target")).toBe(false);
    expect(querySync).toHaveBeenCalledTimes(1);
  });

  it("prefers NIP-17 relays that accept p-tag gift-wrap reads", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    querySync.mockResolvedValue([]);

    await fetchOptionABlindRequestDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_read_relays",
      limit: 20,
    });

    const giftWrapCall = querySync.mock.calls.find((call) => {
      const filter = call[1] as { kinds?: number[] };
      return filter.kinds?.[0] === 1059;
    });
    const relays = giftWrapCall?.[0] as string[];

    expect(relays).toEqual([
      "wss://vm-1734.lnvps.cloud/",
      "wss://relay.nostr.net",
      "wss://nos.lol",
    ]);
    expect(relays).not.toContain("wss://nip17.com");
    expect(relays).not.toContain("wss://relay.nostr.info");
    expect(relays).not.toContain("wss://relay.damus.io");
    expect(relays).not.toContain("wss://relay.primal.net");
    expect(relays).not.toContain("wss://nostr.wine");
    expect(relays).not.toContain("wss://nostr.mom");
  });

  it("reuses cached signer decrypts for repeated issuance scans of the same event", async () => {
    const recipientHex = getPublicKey(generateSecretKey());
    const recipientNpub = nip19.npubEncode(recipientHex);
    const giftWrapEvent = {
      id: "gift-wrap-cache-test",
      kind: 1059,
      created_at: Math.round(Date.now() / 1000),
      pubkey: "a".repeat(64),
      content: "wrapped_payload",
      tags: [["p", recipientHex]],
      sig: "b".repeat(128),
    };
    const decrypt = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        kind: 13,
        pubkey: "c".repeat(64),
        content: "sealed_payload",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: JSON.stringify({
          type: "optiona_blind_issuance_dm",
          schemaVersion: 1,
          issuance: {
            type: "blind_ballot_response",
            schemaVersion: 1,
            electionId: "q_cache",
            requestId: "request_cache",
            issuanceId: "issuance_cache",
            invitedNpub: recipientNpub,
            blindSignature: "sig_cache",
            issuedAt: new Date().toISOString(),
          },
          sentAt: new Date().toISOString(),
        }),
      }));
    querySync.mockResolvedValue([giftWrapEvent]);

    const signer = makeSigner({
      getPublicKey: async () => recipientHex,
      nip44Decrypt: decrypt,
    });

    const first = await fetchOptionABlindIssuanceDms({
      signer,
      electionId: "q_cache",
      limit: 10,
    });
    const second = await fetchOptionABlindIssuanceDms({
      signer,
      electionId: "q_cache",
      limit: 10,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.issuanceId).toBe("issuance_cache");
    expect(second[0]?.issuanceId).toBe("issuance_cache");
    expect(decrypt).toHaveBeenCalledTimes(2);
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

  it("paginates local issuance recovery until an older target message is found", async () => {
    const recipientSecret = generateSecretKey();
    const recipientHex = getPublicKey(recipientSecret);
    const recipientNpub = nip19.npubEncode(recipientHex);
    const recipientNsec = nip19.nsecEncode(recipientSecret);
    const senderSecret = generateSecretKey();
    const events = Array.from({ length: 55 }, (_, index) => {
      const isTarget = index === 48;
      const wrapped = nip17.wrapEvent(
        senderSecret,
        { publicKey: recipientHex, relayUrl: "wss://relay.example" },
        JSON.stringify(isTarget
          ? {
              type: "optiona_blind_issuance_dm",
              schemaVersion: 1,
              issuance: {
                type: "blind_ballot_response",
                schemaVersion: 1,
                electionId: "q_paginated",
                requestId: "request_paginated",
                issuanceId: "issuance_paginated",
                invitedNpub: recipientNpub,
                blindSignature: "sig_paginated",
                issuedAt: new Date().toISOString(),
              },
              sentAt: new Date().toISOString(),
            }
          : {
              type: "unrelated_dm",
              schemaVersion: 1,
              sentAt: new Date().toISOString(),
            }),
        "Option A blind issuance",
      );
      return {
        ...wrapped,
        id: `gift_wrap_${index}`,
        created_at: 10_000 - index,
      };
    });

    querySync.mockImplementation(async (_relays: string[], filter: { kinds?: number[]; limit?: number; until?: number }) => {
      if (filter.kinds?.[0] !== 1059) {
        return [];
      }
      const until = typeof filter.until === "number" ? filter.until : Number.POSITIVE_INFINITY;
      return events
        .filter((event) => event.created_at <= until)
        .sort((left, right) => right.created_at - left.created_at)
        .slice(0, Math.max(1, filter.limit ?? 20));
    });

    const fetchedIssuances = await fetchOptionABlindIssuanceDmsWithNsec({
      nsec: recipientNsec,
      electionId: "q_paginated",
      limit: 60,
      pageLimit: 20,
      maxPages: 10,
      targetRequestId: "request_paginated",
    });

    expect(fetchedIssuances).toHaveLength(1);
    expect(fetchedIssuances[0]?.issuanceId).toBe("issuance_paginated");
    const giftWrapQueries = querySync.mock.calls.filter(([, filter]) => (
      (filter as { kinds?: number[] }).kinds?.[0] === 1059
    ));
    expect(giftWrapQueries).toHaveLength(3);
    expect(querySync).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ kinds: [1059], limit: 20 }),
    );
    expect(querySync).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ kinds: [1059], limit: 20, until: 9_980 }),
    );
  });
});

// @vitest-environment jsdom
import { getPublicKey, nip19 } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processOptionAQueuesForCoordinator,
  QuestionnaireOptionACoordinatorRuntime,
  QuestionnaireOptionAVoterRuntime,
} from "./questionnaireOptionARuntime";
import type { BallotAcceptanceResult, BallotSubmission } from "./questionnaireOptionA";
import { reduceCoordinatorEvent } from "./questionnaireOptionA";
import {
  dequeueBlindRequest,
  listBlindRequests,
  loadCoordinatorState,
  loadElectionSummary,
  readAcceptance,
  readBlindIssuance,
  saveCoordinatorState,
  storeAcceptance,
  storeBlindIssuance,
  upsertElectionSummary,
} from "./questionnaireOptionAStorage";
import {
  fetchOptionABallotSubmissionDmsWithNsec,
  publishOptionABallotAcceptanceDm,
  publishOptionABallotSubmissionDm,
  publishOptionABlindIssuanceBundleDm,
  publishOptionABlindIssuanceDm,
  publishOptionABlindRequestBundleDm,
  publishOptionABlindRequestDm,
  publishOptionAVoterStateDm,
  subscribeOptionABlindIssuanceDms,
  subscribeOptionABlindIssuanceDmsWithNsec,
  subscribeOptionABlindRequestAckDms,
  subscribeOptionABlindRequestAckDmsWithNsec,
} from "./questionnaireOptionABlindDm";
import { readCachedQuestionnaireDefinition, storeCachedQuestionnaireDefinition } from "./questionnaireDefinitionCache";
import {
  buildQuestionnaireBlindTokenSignedMessage,
} from "./questionnaireBlindToken";
import { hashQuestionnaireInviteCode } from "./questionnaireInviteCode";
import {
  generateQuestionnaireBlindKeyPair,
  signBlindedQuestionnaireToken,
  toQuestionnaireBlindPublicKey,
  verifyQuestionnaireBlindSignature,
} from "./questionnaireBlindSignature";
import { publishQuestionnaireResultSummary } from "./questionnaireNostr";
import type { QuestionnaireDefinition, QuestionnaireResponseAnswer } from "./questionnaireProtocol";
import { buildQuestionnaireResultSummary } from "./questionnaireRuntime";
import {
  publishQuestionnaireBlindResponsePublic,
  publishQuestionnaireSubmissionDecisionPublic,
} from "./questionnaireResponsePublish";
import type { SignerService } from "./services/signerService";
import { fetchQuestionnaireActiveWorkerDelegationForCapability, fetchQuestionnaireDefinitions } from "./questionnaireTransport";
import { createWorkerDelegationCertificate, upsertStoredWorkerDelegation } from "./questionnaireWorkerDelegation";

const publicBlindResponseStore = vi.hoisted(() => ({
  entries: [] as Array<{
    event: { id: string; created_at: number };
    response: {
      questionnaireId: string;
      responseId: string;
      submittedAt: number;
      authorPubkey: string;
      tokenNullifier: string;
      tokenProof: {
        tokenCommitment: string;
        questionnaireId: string;
        signature: string;
        questionId?: string | null;
        ballotScope?: Record<string, unknown> | null;
      };
      tokenProofs?: Array<{
        tokenCommitment: string;
        questionnaireId: string;
        signature: string;
        questionId?: string | null;
        ballotScope?: Record<string, unknown> | null;
      }>;
      tokenNullifiers?: Array<{
        questionId?: string | null;
        tokenNullifier: string;
        ballotScope?: Record<string, unknown> | null;
      }>;
      answers: Array<Record<string, unknown>>;
    };
  }>,
}));

vi.mock("./questionnaireOptionAInviteDm", () => ({
  fetchOptionAInviteDms: vi.fn().mockResolvedValue([]),
  publishOptionAInviteDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-invite-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
}));

vi.mock("./questionnaireOptionABlindDm", () => ({
  fetchOptionABallotSubmissionAckDms: vi.fn().mockResolvedValue([]),
  fetchOptionABallotSubmissionAckDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABlindIssuanceAckDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindIssuanceAckDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABlindRequestAckDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindRequestAckDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABallotAcceptanceDms: vi.fn().mockResolvedValue([]),
  fetchOptionABallotAcceptanceDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABallotSubmissionDms: vi.fn().mockResolvedValue([]),
  fetchOptionABallotSubmissionDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABlindIssuanceDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindIssuanceDmsWithNsec: vi.fn().mockResolvedValue([]),
  fetchOptionABlindRequestDms: vi.fn().mockResolvedValue([]),
  fetchOptionABlindRequestDmsWithNsec: vi.fn().mockResolvedValue([]),
  publishOptionABallotAcceptanceDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-acceptance-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionACoordinatorStateDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-coordinator-state-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionAVoterStateDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-voter-state-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABallotSubmissionAckDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-submission-ack-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABallotSubmissionDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-submission-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindIssuanceDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-issuance-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindIssuanceBundleDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-issuance-bundle-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindIssuanceAckDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-issuance-ack-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindRequestAckDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-request-ack-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindRequestDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-request-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  publishOptionABlindRequestBundleDm: vi.fn().mockResolvedValue({
    eventId: "mock-option-a-request-bundle-dm",
    successes: 1,
    failures: 0,
    relayResults: [],
  }),
  subscribeOptionABlindRequestDms: vi.fn(() => () => undefined),
  subscribeOptionABlindIssuanceDms: vi.fn(() => () => undefined),
  subscribeOptionABlindIssuanceDmsWithNsec: vi.fn(() => () => undefined),
  subscribeOptionABallotSubmissionDms: vi.fn(() => () => undefined),
  subscribeOptionABallotSubmissionAckDms: vi.fn(() => () => undefined),
  subscribeOptionABallotAcceptanceDms: vi.fn(() => () => undefined),
  subscribeOptionABlindIssuanceAckDms: vi.fn(() => () => undefined),
  subscribeOptionABlindRequestAckDms: vi.fn(() => () => undefined),
  subscribeOptionABlindRequestAckDmsWithNsec: vi.fn(() => () => undefined),
}));

vi.mock("./questionnaireResponsePublish", () => ({
  publishQuestionnaireBlindResponsePublic: vi.fn(async (input: {
    responseNsec: string;
    questionnaireId: string;
    responseId: string;
    submittedAt?: number;
    tokenNullifier: string;
    tokenProof: {
      tokenCommitment: string;
      questionnaireId: string;
      signature: string;
      questionId?: string | null;
      ballotScope?: Record<string, unknown> | null;
    };
    tokenProofs?: Array<{
      tokenCommitment: string;
      questionnaireId: string;
      signature: string;
      questionId?: string | null;
      ballotScope?: Record<string, unknown> | null;
    }>;
    tokenNullifiers?: Array<{
      questionId?: string | null;
      tokenNullifier: string;
      ballotScope?: Record<string, unknown> | null;
    }>;
    answers: Array<Record<string, unknown>>;
  }) => {
    const createdAt = input.submittedAt ?? Math.floor(Date.now() / 1000);
    publicBlindResponseStore.entries.push({
      event: {
        id: `public-${input.responseId}`,
        created_at: createdAt,
      },
      response: {
        questionnaireId: input.questionnaireId,
        responseId: input.responseId,
        submittedAt: createdAt,
        authorPubkey: nip19.npubEncode(getPublicKey(nip19.decode(input.responseNsec).data as Uint8Array)),
        tokenNullifier: input.tokenNullifier,
        tokenNullifiers: input.tokenNullifiers,
        tokenProof: input.tokenProof,
        tokenProofs: input.tokenProofs,
        answers: input.answers,
      },
    });
    return {
      eventId: `public-${input.responseId}`,
      successes: 1,
      failures: 0,
      relayResults: [],
    };
  }),
  publishQuestionnaireSubmissionDecisionPublic: vi.fn(async (input: { submissionId: string }) => ({
    eventId: `decision-${input.submissionId}`,
    successes: 1,
    failures: 0,
    relayResults: [],
  })),
}));

vi.mock("./questionnaireNostr", async () => {
  const actual = await vi.importActual<typeof import("./questionnaireNostr")>("./questionnaireNostr");
  return {
    ...actual,
    publishQuestionnaireResultSummary: vi.fn(async (input: {
      resultSummary: { questionnaireId: string };
    }) => ({
      eventId: `summary-${input.resultSummary.questionnaireId}`,
      event: {
        id: `summary-${input.resultSummary.questionnaireId}`,
        kind: actual.QUESTIONNAIRE_RESULT_SUMMARY_KIND,
        tags: [
          ["t", "questionnaire_result_summary"],
          ["questionnaire-id", input.resultSummary.questionnaireId],
        ],
      },
      successes: 1,
      failures: 0,
      relayResults: [],
    })),
  };
});

vi.mock("./questionnaireTransport", () => ({
  fetchQuestionnaireActiveWorkerDelegationForCapability: vi.fn().mockResolvedValue(null),
  fetchQuestionnaireDefinitions: vi.fn().mockResolvedValue([]),
  fetchQuestionnaireBlindResponses: vi.fn(async (input: { questionnaireId: string }) =>
    publicBlindResponseStore.entries.filter((entry) => entry.response.questionnaireId === input.questionnaireId)),
  fetchQuestionnaireSubmissionDecisions: vi.fn().mockResolvedValue([]),
}));

function signer(npub: string): SignerService {
  return {
    async isAvailable() {
      return true;
    },
    async getPublicKey() {
      return npub;
    },
    async signMessage(message: string) {
      return `sig:${npub}:${message}`;
    },
    async signEvent<T extends Record<string, unknown>>(event: T) {
      return { ...event, pubkey: npub };
    },
  };
}

function buildDefinition(input: {
  electionId: string;
  coordinatorNpub: string;
  title?: string;
}) : QuestionnaireDefinition {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    protocolVersion: 2,
    flowMode: "public_submission_v1",
    responseMode: "blind_token",
    questionnaireId: input.electionId,
    title: input.title ?? "Runtime",
    description: "Test",
    createdAt: now,
    openAt: now - 30,
    closeAt: now + 3600,
    coordinatorPubkey: input.coordinatorNpub,
    coordinatorEncryptionPubkey: input.coordinatorNpub,
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        prompt: "Approve?",
        required: true,
        type: "yes_no",
      },
    ],
  };
}

async function processDelegatedCoordinatorQueues(input: {
  electionId: string;
  coordinatorNpub: string;
  workerNpub: string;
  expectedInviteeCount: number;
}) {
  const cachedDefinition = readCachedQuestionnaireDefinition(input.electionId);
  if (!cachedDefinition) {
    throw new Error("Delegate coordinator test requires a cached questionnaire definition.");
  }
  const loaded = loadCoordinatorState({
    coordinatorNpub: input.coordinatorNpub,
    electionId: input.electionId,
  });
  if (!loaded?.blindSigningPrivateKey) {
    throw new Error("Delegate coordinator test requires persisted blind-signing key.");
  }
  let next = loaded;

  for (const request of listBlindRequests(input.electionId)) {
    const claimed = reduceCoordinatorEvent(next, {
      type: "LOGIN_VERIFIED",
      electionId: input.electionId,
      invitedNpub: request.invitedNpub,
    });
    if (claimed.ok) {
      next = claimed.state;
    }

    const received = reduceCoordinatorEvent(next, {
      type: "BLIND_REQUEST_RECEIVED",
      request,
    });
    if (!received.ok && received.error !== "already_issued") {
      throw new Error(`Unexpected delegated blind-request error: ${received.error}`);
    }
    if (received.ok) {
      next = received.state;
    }

    const existingIssuance = next.issuedBlindResponses[request.requestId] ?? readBlindIssuance(request.requestId);
    const issuance = existingIssuance ?? {
      type: "blind_ballot_response" as const,
      schemaVersion: 1 as const,
      electionId: input.electionId,
      requestId: request.requestId,
      issuanceId: `issuance_${request.requestId}`,
      invitedNpub: request.invitedNpub,
      tokenCommitment: request.tokenCommitment,
      blindSigningKeyId: loaded.blindSigningPrivateKey.keyId,
      blindSignature: await signBlindedQuestionnaireToken({
        privateKey: loaded.blindSigningPrivateKey,
        blindedMessage: request.blindedMessage,
      }),
      ballotScope: request.ballotScope ?? null,
      definition: cachedDefinition,
      issuedAt: new Date().toISOString(),
    };

    if (!existingIssuance) {
      const issued = reduceCoordinatorEvent(next, {
        type: "BLIND_SIGNATURE_ISSUED",
        issuance,
      });
      if (!issued.ok) {
        throw new Error(`Unexpected delegated blind-issuance error: ${issued.error}`);
      }
      next = issued.state;
    }

    storeBlindIssuance(issuance);
    dequeueBlindRequest(request.requestId);
    await publishOptionABlindIssuanceDm({
      signer: signer(input.workerNpub),
      recipientNpub: issuance.invitedNpub,
      issuance,
    });
  }

  saveCoordinatorState({
    coordinatorNpub: input.coordinatorNpub,
    state: next,
  });

  for (const entry of publicBlindResponseStore.entries.filter((candidate) => candidate.response.questionnaireId === input.electionId)) {
    if (next.acceptanceResults[entry.response.responseId]) {
      continue;
    }

    const issuance = Object.values(next.issuedBlindResponses)
      .find((candidate) => candidate.tokenCommitment === entry.response.tokenProof.tokenCommitment);

    const submission: BallotSubmission = {
      type: "ballot_submission",
      schemaVersion: 1,
      electionId: input.electionId,
      submissionId: entry.response.responseId,
      invitedNpub: entry.response.authorPubkey,
      responseNpub: entry.response.authorPubkey,
      tokenCommitment: entry.response.tokenProof.tokenCommitment,
      blindSigningKeyId: issuance?.blindSigningKeyId ?? loaded.blindSigningPrivateKey.keyId,
      credential: entry.response.tokenProof.signature,
      nullifier: entry.response.tokenNullifier,
      payload: {
        electionId: input.electionId,
        responses: [
          {
            questionId: "q1",
            type: "yes_no",
            answer: (entry.response.answers[0] as QuestionnaireResponseAnswer | undefined)?.answerType === "yes_no"
              && Boolean((entry.response.answers[0] as QuestionnaireResponseAnswer & { value?: boolean }).value)
              ? "yes"
              : "no",
          },
        ],
      },
      submittedAt: new Date((entry.response.submittedAt ?? entry.event.created_at) * 1000).toISOString(),
    };

    const received = reduceCoordinatorEvent(next, {
      type: "BALLOT_SUBMISSION_RECEIVED",
      submission,
    });

    let result: BallotAcceptanceResult;
    if (!received.ok) {
      result = {
        type: "ballot_acceptance_result",
        schemaVersion: 1,
        electionId: input.electionId,
        submissionId: submission.submissionId,
        accepted: false,
        reason: "already_voted",
        decidedAt: new Date().toISOString(),
      };
    } else {
      next = received.state;
      const publicKey = next.election.blindSigningPublicKey ?? toQuestionnaireBlindPublicKey(loaded.blindSigningPrivateKey);
      const credentialValid = Boolean(issuance) && await verifyQuestionnaireBlindSignature({
        publicKey,
        message: buildQuestionnaireBlindTokenSignedMessage({
          questionnaireId: input.electionId,
          tokenSecretCommitment: submission.tokenCommitment,
        }),
        signature: submission.credential,
      });

      if (!credentialValid) {
        result = {
          type: "ballot_acceptance_result",
          schemaVersion: 1,
          electionId: input.electionId,
          submissionId: submission.submissionId,
          accepted: false,
          reason: "invalid_credential",
          decidedAt: new Date().toISOString(),
        };
      } else {
        const accepted: BallotAcceptanceResult = {
          type: "ballot_acceptance_result",
          schemaVersion: 1,
          electionId: input.electionId,
          submissionId: submission.submissionId,
          accepted: true,
          decidedAt: new Date().toISOString(),
        };
        const reducedAccepted = reduceCoordinatorEvent(next, {
          type: "BALLOT_ACCEPTED",
          result: accepted,
        });
        if (!reducedAccepted.ok) {
          result = {
            ...accepted,
            accepted: false,
            reason: reducedAccepted.error === "duplicate_nullifier" ? "duplicate_nullifier" : "already_voted",
          };
        } else {
          next = reducedAccepted.state;
          result = accepted;
        }
      }
    }

    storeAcceptance(result);
    await publishQuestionnaireSubmissionDecisionPublic({
      coordinatorNsec: "nsec1delegatecoordinatormockxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      questionnaireId: input.electionId,
      submissionId: submission.submissionId,
      tokenNullifier: submission.nullifier,
      accepted: result.accepted,
      reason: result.accepted ? "accepted" : "invalid_payload_shape",
      coordinatorNpub: input.coordinatorNpub,
      decidedAt: Math.floor(Date.parse(result.decidedAt) / 1000),
    });
    if (result.accepted) {
      await publishOptionABallotAcceptanceDm({
        signer: signer(input.workerNpub),
        recipientNpub: submission.responseNpub ?? submission.invitedNpub,
        acceptance: result,
      });
    }
  }

  saveCoordinatorState({
    coordinatorNpub: input.coordinatorNpub,
    state: next,
  });

  const decisions = publicBlindResponseStore.entries
    .filter((entry) => entry.response.questionnaireId === input.electionId)
    .map((entry) => ({
      entry,
      result: next.acceptanceResults[entry.response.responseId] ?? readAcceptance(entry.response.responseId),
    }))
    .filter((entry): entry is typeof entry & { result: BallotAcceptanceResult } => Boolean(entry.result));

  if (decisions.length >= input.expectedInviteeCount) {
    const acceptedResponses = decisions
      .filter((entry) => entry.result.accepted)
      .map((entry) => ({
        eventId: entry.entry.event.id,
        authorPubkey: entry.entry.response.authorPubkey,
        envelope: {
          schemaVersion: 1 as const,
          eventType: "questionnaire_response_private" as const,
          questionnaireId: entry.entry.response.questionnaireId,
          responseId: entry.entry.response.responseId,
          createdAt: entry.entry.response.submittedAt ?? entry.entry.event.created_at,
          authorPubkey: entry.entry.response.authorPubkey,
          ciphertextScheme: "nip44v2" as const,
          ciphertextRecipient: input.coordinatorNpub,
          ciphertext: "",
          payloadHash: entry.entry.response.tokenProof.tokenCommitment,
        },
        payload: {
          schemaVersion: 1 as const,
          kind: "questionnaire_response_payload" as const,
          questionnaireId: entry.entry.response.questionnaireId,
          responseId: entry.entry.response.responseId,
          submittedAt: entry.entry.response.submittedAt ?? entry.entry.event.created_at,
          answers: entry.entry.response.answers as QuestionnaireResponseAnswer[],
        },
      }));
    const rejectedResponses = decisions
      .filter((entry) => !entry.result.accepted)
      .map((entry) => ({
        eventId: entry.entry.event.id,
        authorPubkey: entry.entry.response.authorPubkey,
        responseId: entry.entry.response.responseId,
        reason: "invalid_payload_shape" as const,
      }));
    const summary = buildQuestionnaireResultSummary({
      definition: cachedDefinition,
      coordinatorPubkey: input.coordinatorNpub,
      acceptedResponses,
      rejectedResponses,
    });
    summary.acceptedNullifierCount = new Set(
      decisions
        .filter((entry) => entry.result.accepted)
        .map((entry) => entry.entry.response.tokenNullifier.trim())
        .filter((value) => value.length > 0),
    ).size;
    summary.publishedResponseRefs = decisions.map((entry) => ({
      responseId: entry.entry.response.responseId,
      authorPubkey: entry.entry.response.authorPubkey,
      submittedAt: entry.entry.response.submittedAt ?? entry.entry.event.created_at,
      accepted: entry.result.accepted,
      answers: entry.entry.response.answers as QuestionnaireResponseAnswer[],
    }));
    await publishQuestionnaireResultSummary({
      coordinatorNsec: "nsec1delegatecoordinatormockxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      resultSummary: summary,
    });
  }

  return next;
}

describe("questionnaireOptionARuntime", () => {
  const electionId = "election_runtime_1";
  const coordinatorNpub = "npub1coordinatorruntime0000000000000000000000000000";
  const voterNpub = "npub1voterruntime00000000000000000000000000000000000000";
  const otherNpub = "npub1otherruntime00000000000000000000000000000000000000";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchQuestionnaireActiveWorkerDelegationForCapability).mockReset();
    vi.mocked(fetchQuestionnaireActiveWorkerDelegationForCapability).mockResolvedValue(null);
    vi.mocked(fetchQuestionnaireDefinitions).mockReset();
    vi.mocked(fetchQuestionnaireDefinitions).mockResolvedValue([]);
    window.localStorage.clear();
    publicBlindResponseStore.entries.splice(0, publicBlindResponseStore.entries.length);
  });

  it("repairs stale coordinator blind public key state from the local private key", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    const savedPrivateKey = loadCoordinatorState({ coordinatorNpub, electionId })?.blindSigningPrivateKey;
    expect(savedPrivateKey).toBeTruthy();
    const expectedPublicKey = toQuestionnaireBlindPublicKey(savedPrivateKey!);
    const stalePublicKey = toQuestionnaireBlindPublicKey(await generateQuestionnaireBlindKeyPair());
    upsertElectionSummary({
      ...loadElectionSummary(electionId)!,
      blindSigningPublicKey: stalePublicKey,
    });

    const reloaded = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await reloaded.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });

    expect(reloaded.getSnapshot()?.election.blindSigningPublicKey?.keyId).toBe(expectedPublicKey.keyId);
    expect(loadElectionSummary(electionId)?.blindSigningPublicKey?.keyId).toBe(expectedPublicKey.keyId);
  });

  it("restores login state and invite mismatch is rejected", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const invite = sentInvite.invite;

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    const loggedIn = await voter.loginWithSigner(invite);
    expect(loggedIn.loginVerified).toBe(true);

    const wrongVoter = new QuestionnaireOptionAVoterRuntime(signer(otherNpub), electionId);
    await expect(wrongVoter.loginWithSigner(invite)).rejects.toThrow(/different Nostr account/i);

    const resumed = await voter.loginWithSigner(null);
    expect(resumed.loginVerified).toBe(true);
  });

  it("updates a persisted draft coordinator state when the questionnaire is published", async () => {
    const publishedElectionId = `${electionId}_published`;
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), publishedElectionId);
    await coordinator.loginWithSigner({ title: "Draft runtime", description: "Draft", state: "draft" });
    expect(coordinator.getSnapshot()?.election.state).toBe("draft");

    const restoredCoordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), publishedElectionId);
    restoredCoordinator.bootstrapCoordinatorNpub({
      coordinatorNpub,
      summary: {
        title: "Published runtime",
        description: "Published",
        state: "open",
        openedAt: "2026-06-12T12:00:00.000Z",
        closedAt: "2036-06-12T12:00:00.000Z",
      },
      startDmSubscriptions: false,
      recoverSelfState: false,
      publishSelfState: false,
    });

    expect(restoredCoordinator.getSnapshot()?.election).toEqual(expect.objectContaining({
      title: "Published runtime",
      description: "Published",
      state: "open",
      openedAt: "2026-06-12T12:00:00.000Z",
      closedAt: "2036-06-12T12:00:00.000Z",
    }));
  });

  it("defers public submissions while a local questionnaire is still draft and accepts after publish state is stored", async () => {
    const raceElectionId = `${electionId}_publish_race`;
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), raceElectionId);
    await coordinator.loginWithSigner({
      title: "Runtime",
      description: "Test",
      state: "draft",
      flowMode: "public_submission_v1",
      responseMode: "blind_token",
    });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), raceElectionId);
    await voter.loginWithSigner(sentInvite.invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot({ forceResend: true });
    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    await voter.submitVote(["q1"]);
    const submissionId = voter.getSnapshot()?.submission?.submissionId ?? "";

    vi.mocked(publishQuestionnaireSubmissionDecisionPublic).mockClear();
    await coordinator.processPendingSubmissions(["q1"]);
    expect(readAcceptance(submissionId)).toBe(null);
    expect(publishQuestionnaireSubmissionDecisionPublic).not.toHaveBeenCalled();

    const definition = buildDefinition({ electionId: raceElectionId, coordinatorNpub });
    storeCachedQuestionnaireDefinition(definition);
    upsertElectionSummary({
      electionId: raceElectionId,
      title: definition.title,
      description: definition.description ?? "",
      state: "open",
      openedAt: new Date(definition.openAt * 1000).toISOString(),
      closedAt: new Date(definition.closeAt * 1000).toISOString(),
      coordinatorNpub,
      blindSigningPublicKey: coordinator.getSnapshot()?.election.blindSigningPublicKey ?? null,
      questionnaireRelays: definition.questionnaireRelays,
      protocolVersion: definition.protocolVersion,
      flowMode: definition.flowMode,
      responseMode: definition.responseMode,
    });

    await coordinator.processPendingSubmissions(["q1"]);
    expect(readAcceptance(submissionId)?.accepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);
  });

  it("routes blind requests to the delegated worker from invite metadata when available", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const workerNpub = "npub1workerhint000000000000000000000000000000000000000000";
    const invite = {
      ...sentInvite.invite,
      issueBlindTokensWorker: {
        delegationId: "delegation_hint_1",
        workerNpub,
        controlRelays: ["wss://worker-relay.example"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    };

    vi.mocked(fetchQuestionnaireActiveWorkerDelegationForCapability).mockResolvedValueOnce(null);

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(invite);
    await voter.requestBlindBallot({ forceResend: true });

    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: workerNpub,
      relays: expect.arrayContaining(["wss://worker-relay.example"]),
    }));
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: coordinatorNpub,
    }));
  });

  it("runs request -> issuance -> submit -> acceptance and supports resume", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const invite = sentInvite.invite;

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot({ forceResend: true });

    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);

    await voter.submitVote(["q1"]);
    const submitted = voter.getSnapshot()?.submission;
    expect(submitted?.responseNpub).toBeTruthy();
    expect(submitted?.responseNpub).not.toBe(voterNpub);
    expect(submitted?.invitedNpub).toBe(submitted?.responseNpub);
    expect(vi.mocked(publishQuestionnaireBlindResponsePublic)).toHaveBeenCalledWith(expect.objectContaining({
      questionnaireId: electionId,
      responseId: submitted?.submissionId,
    }));
    expect(vi.mocked(publishOptionABallotSubmissionDm)).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: voterNpub,
    }));
    await coordinator.processPendingSubmissions(["q1"]);
    voter.refreshIssuanceAndAcceptance();

    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);

    const resumed = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await resumed.loginWithSigner(null);
    resumed.refreshIssuanceAndAcceptance();
    expect(resumed.getSnapshot()?.credentialReady).toBe(true);
    expect(resumed.getSnapshot()?.submissionAccepted).toBe(true);

    window.localStorage.clear();
    vi.mocked(fetchOptionABallotSubmissionDmsWithNsec).mockResolvedValueOnce(submitted ? [submitted] : []);
    const recovered = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId, "nsec1selfcopy");
    recovered.bootstrapWithLocalIdentity({
      invitedNpub: voterNpub,
      coordinatorNpub,
      allowInviteMissing: true,
    });
    await recovered.recoverSubmittedBallotFromSelfDm();
    expect(recovered.getSnapshot()?.submission?.submissionId).toBe(submitted?.submissionId);
    expect(recovered.getSnapshot()?.draftResponses).toEqual(submitted?.payload.responses);
  });

  it("requests and submits a scoped credential bundle for per-question questionnaires", async () => {
    const bundleElectionId = `${electionId}_credential_bundle`;
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), bundleElectionId);
    await coordinator.loginWithSigner({
      title: "AGM",
      description: "Director votes",
      state: "open",
      flowMode: "public_submission_v1",
      responseMode: "blind_token",
    });
    coordinator.addWhitelistNpub(voterNpub);
    const blindSigningPublicKey = coordinator.getSnapshot()?.election.blindSigningPublicKey ?? null;
    const now = Math.floor(Date.now() / 1000);
    const definition: QuestionnaireDefinition = {
      ...buildDefinition({ electionId: bundleElectionId, coordinatorNpub, title: "AGM" }),
      ballotCredentialMode: "per_question",
      blindSigningPublicKey,
      createdAt: now,
      openAt: now - 30,
      closeAt: now + 3600,
      questions: [
        {
          questionId: "q1",
          type: "yes_no",
          prompt: "Elect Alice?",
          required: true,
          ballotSlot: { slotId: "director-alice", slotIndex: 1, version: 1 },
        },
        {
          questionId: "q2",
          type: "yes_no",
          prompt: "Elect Bob?",
          required: true,
          ballotSlot: { slotId: "director-bob", slotIndex: 2, version: 1 },
        },
      ],
    };
    storeCachedQuestionnaireDefinition(definition);
    upsertElectionSummary({
      electionId: bundleElectionId,
      title: definition.title,
      description: definition.description ?? "",
      state: "open",
      openedAt: new Date(definition.openAt * 1000).toISOString(),
      closedAt: new Date(definition.closeAt * 1000).toISOString(),
      coordinatorNpub,
      blindSigningPublicKey,
      protocolVersion: definition.protocolVersion,
      flowMode: definition.flowMode,
      responseMode: definition.responseMode,
    });
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "AGM",
      description: "Director votes",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), bundleElectionId);
    await voter.loginWithSigner(sentInvite.invite);
    voter.updateDraftResponses([
      { questionId: "q1", type: "yes_no", answer: "yes" },
      { questionId: "q2", type: "yes_no", answer: "no" },
    ]);
    await voter.requestBlindBallot({ forceResend: true });

    const requestedScopes = Object.values(voter.getSnapshot()?.blindRequests ?? {})
      .map((request) => request.ballotScope?.slotId)
      .sort();
    expect(requestedScopes).toEqual(["director-alice", "director-bob"]);
    expect(vi.mocked(publishOptionABlindRequestDm)).not.toHaveBeenCalled();
    expect(vi.mocked(publishOptionABlindRequestBundleDm)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishOptionABlindRequestBundleDm)).toHaveBeenCalledWith(expect.objectContaining({
      requests: expect.arrayContaining([
        expect.objectContaining({ ballotScope: expect.objectContaining({ slotId: "director-alice" }) }),
        expect.objectContaining({ ballotScope: expect.objectContaining({ slotId: "director-bob" }) }),
      ]),
    }));

    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    const issuedScopes = Object.values(voter.getSnapshot()?.blindIssuances ?? {})
      .map((issuance) => issuance.ballotScope?.slotId)
      .sort();
    expect(issuedScopes).toEqual(["director-alice", "director-bob"]);
    expect(voter.getSnapshot()?.credentialReady).toBe(true);

    await voter.submitVote(["q1"], { questionId: "q1" });
    const firstSubmission = voter.getSnapshot()?.submissions?.q1;
    expect(firstSubmission?.credentialBundle).toHaveLength(1);
    expect(firstSubmission?.payload.responses).toHaveLength(1);
    expect(firstSubmission?.payload.responses[0]?.questionId).toBe("q1");
    expect(firstSubmission?.credentialBundle?.[0]?.ballotScope?.slotId).toBe("director-alice");

    await coordinator.processPendingSubmissions(["q1", "q2"]);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.submissionDecisions?.q1?.accepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);
    expect(Object.keys(coordinator.getSnapshot()?.acceptedNullifiers ?? {})).toHaveLength(1);

    await voter.submitVote(["q2"], { questionId: "q2" });
    const secondSubmission = voter.getSnapshot()?.submissions?.q2;
    expect(secondSubmission?.credentialBundle).toHaveLength(1);
    expect(secondSubmission?.payload.responses).toHaveLength(1);
    expect(secondSubmission?.payload.responses[0]?.questionId).toBe("q2");
    expect(secondSubmission?.credentialBundle?.[0]?.ballotScope?.slotId).toBe("director-bob");

    const publicResponses = publicBlindResponseStore.entries.filter((entry) => (
      entry.response.questionnaireId === bundleElectionId
    )).map((entry) => entry.response);
    expect(publicResponses).toHaveLength(2);
    expect(publicResponses.map((response) => response.answers.map((answer) => answer.questionId)).flat().sort()).toEqual(["q1", "q2"]);
    for (const response of publicResponses) {
      expect(response.tokenProofs).toHaveLength(1);
      expect(response.tokenNullifiers).toHaveLength(1);
    }

    await coordinator.processPendingSubmissions(["q1", "q2"]);
    voter.refreshIssuanceAndAcceptance();

    expect(voter.getSnapshot()?.submissionAccepted).toBe(null);
    expect(voter.getSnapshot()?.submissionDecisions?.q2?.accepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(2);
    expect(Object.keys(coordinator.getSnapshot()?.acceptedNullifiers ?? {})).toHaveLength(2);
  });

  it("accepts recovered public submissions that arrived before close", async () => {
    const closedElectionId = `${electionId}_closed_replay`;
    storeCachedQuestionnaireDefinition(buildDefinition({
      electionId: closedElectionId,
      coordinatorNpub,
    }));
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), closedElectionId);
    await coordinator.loginWithSigner({
      title: "Runtime",
      description: "Test",
      state: "open",
      flowMode: "public_submission_v1",
    });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), closedElectionId);
    await voter.loginWithSigner(sentInvite.invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot({ forceResend: true });
    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);

    await voter.submitVote(["q1"]);
    const submission = voter.getSnapshot()?.submission;
    expect(submission?.submissionId).toBeTruthy();

    const persisted = loadCoordinatorState({
      coordinatorNpub,
      electionId: closedElectionId,
    });
    expect(persisted).toBeTruthy();
    const submittedAt = Date.parse(submission?.submittedAt ?? "");
    expect(Number.isFinite(submittedAt)).toBe(true);
    const closedAt = new Date(submittedAt + 60_000).toISOString();
    saveCoordinatorState({
      coordinatorNpub,
      state: {
        ...persisted!,
        election: {
          ...persisted!.election,
          state: "closed",
          closedAt,
        },
        receivedSubmissions: {},
        acceptedNullifiers: {},
        acceptanceResults: {},
        lastUpdatedAt: closedAt,
      },
    });

    vi.mocked(publishQuestionnaireSubmissionDecisionPublic).mockClear();
    const recoveredCoordinator = new QuestionnaireOptionACoordinatorRuntime(
      signer(coordinatorNpub),
      closedElectionId,
      "nsec1coordinatorruntimeclosedreplayxxxxxxxxxxxxxxxxxx",
    );
    recoveredCoordinator.bootstrapCoordinatorNpub({
      coordinatorNpub,
      summary: {
        ...persisted!.election,
        state: "closed",
        closedAt,
      },
      startDmSubscriptions: false,
      recoverSelfState: false,
      publishSelfState: false,
    });
    await recoveredCoordinator.processPendingSubmissions(["q1"]);

    expect(recoveredCoordinator.getSnapshot()?.election.state).toBe("closed");
    expect(recoveredCoordinator.getAcceptedUniqueCount()).toBe(1);
    expect(readAcceptance(submission?.submissionId ?? "")).toEqual(expect.objectContaining({
      accepted: true,
    }));
    expect(publishQuestionnaireSubmissionDecisionPublic).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: submission?.submissionId,
      accepted: true,
    }));
  });

  it("reuses an in-flight blind request across retries and republishes issuance on bounded retry cadence", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(sentInvite.invite);

    const [first, second] = await Promise.all([
      voter.requestBlindBallot(),
      voter.requestBlindBallot(),
    ]);
    const requestId = first.blindRequest?.requestId;
    expect(requestId).toBeTruthy();
    expect(second.blindRequest?.requestId).toBe(requestId);
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledTimes(1);

    const retried = await voter.requestBlindBallot();
    expect(retried.blindRequest?.requestId).toBe(requestId);
    expect(listBlindRequests(electionId).map((entry) => entry.requestId)).toEqual([requestId]);

    await coordinator.processPendingBlindRequests();
    await coordinator.publishPendingBlindIssuancesToDm();
    const issued = readBlindIssuance(requestId ?? "");
    expect(issued?.requestId).toBe(requestId);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(1);

    await coordinator.processPendingBlindRequests();
    await coordinator.publishPendingBlindIssuancesToDm();
    expect(readBlindIssuance(requestId ?? "")).toEqual(issued);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(1);

    await coordinator.publishPendingBlindIssuancesToDm({ minRetryMs: 0 });
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(2);

    await voter.requestBlindBallot({ forceResend: true });
    await coordinator.processPendingBlindRequests();
    await coordinator.publishPendingBlindIssuancesToDm();
    expect(readBlindIssuance(requestId ?? "")).toEqual(issued);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledTimes(3);
  });

  it("shares in-flight per-question blind requests across voter runtime instances", async () => {
    const sharedElectionId = `${electionId}_shared_per_question`;
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), sharedElectionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const blindSigningPublicKey = coordinator.getSnapshot()?.election.blindSigningPublicKey ?? null;
    const definition: QuestionnaireDefinition = {
      ...buildDefinition({ electionId: sharedElectionId, coordinatorNpub }),
      ballotCredentialMode: "per_question",
      blindSigningPublicKey,
      questions: [
        {
          questionId: "q3",
          type: "yes_no",
          prompt: "Approve?",
          required: true,
          ballotSlot: { slotId: "q3", slotIndex: 1, version: 5 },
        },
      ],
    };
    storeCachedQuestionnaireDefinition(definition);
    upsertElectionSummary({
      electionId: sharedElectionId,
      title: definition.title,
      description: definition.description ?? "",
      state: "open",
      openedAt: new Date(definition.openAt * 1000).toISOString(),
      closedAt: new Date(definition.closeAt * 1000).toISOString(),
      coordinatorNpub,
      blindSigningPublicKey,
      protocolVersion: definition.protocolVersion,
      flowMode: definition.flowMode,
      responseMode: definition.responseMode,
    });
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const firstRuntime = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), sharedElectionId);
    const secondRuntime = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), sharedElectionId);
    await firstRuntime.loginWithSigner(sentInvite.invite);
    await secondRuntime.loginWithSigner(sentInvite.invite);
    vi.mocked(publishOptionABlindRequestDm).mockClear();

    const [first, second] = await Promise.all([
      firstRuntime.requestBlindBallot({ forceResend: true }),
      secondRuntime.requestBlindBallot({ forceResend: true }),
    ]);
    const firstRequest = Object.values(first.blindRequests ?? {})[0] ?? null;
    const secondRequest = Object.values(second.blindRequests ?? {})[0] ?? null;

    expect(firstRequest?.requestId).toBeTruthy();
    expect(secondRequest?.requestId).toBe(firstRequest?.requestId);
    expect(listBlindRequests(sharedElectionId).map((entry) => entry.requestId)).toEqual([firstRequest?.requestId]);
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledTimes(1);
  });

  it("uses local nsec subscriptions for voter blind issuance recovery", async () => {
    const voterNsec = "nsec1localvoterruntime000000000000000000000000000000";
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId, voterNsec);
    await voter.loginWithSigner(sentInvite.invite);
    await voter.requestBlindBallot({ forceResend: true });

    expect(subscribeOptionABlindRequestAckDmsWithNsec).toHaveBeenCalledWith(expect.objectContaining({
      nsec: voterNsec,
      electionId,
      onAck: expect.any(Function),
    }));
    expect(subscribeOptionABlindIssuanceDmsWithNsec).toHaveBeenCalledWith(expect.objectContaining({
      nsec: voterNsec,
      electionId,
      onIssuance: expect.any(Function),
    }));
    const blindRequestPublishOrder = vi.mocked(publishOptionABlindRequestDm).mock.invocationCallOrder[0];
    expect(vi.mocked(subscribeOptionABlindRequestAckDmsWithNsec).mock.invocationCallOrder[0]).toBeLessThan(blindRequestPublishOrder);
    expect(vi.mocked(subscribeOptionABlindIssuanceDmsWithNsec).mock.invocationCallOrder[0]).toBeLessThan(blindRequestPublishOrder);
    expect(subscribeOptionABlindRequestAckDms).not.toHaveBeenCalled();
    expect(subscribeOptionABlindIssuanceDms).not.toHaveBeenCalled();
  });

  it("prevents duplicate issuance and duplicate accepted submissions from inflating unique count", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    const invite = sentInvite.invite;

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);

    await voter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();

    // Re-request after issuance is idempotent and should not mint a second credential.
    const issuedRequestId = voter.getSnapshot()?.blindRequest?.requestId;
    const retryAfterIssuance = await voter.requestBlindBallot();
    expect(retryAfterIssuance.blindRequest?.requestId).toBe(issuedRequestId);

    await voter.submitVote(["q1"]);
    const submissionPublishCallsAfterFirstSubmit = vi.mocked(publishQuestionnaireBlindResponsePublic).mock.calls.length;
    await coordinator.processPendingSubmissions(["q1"]);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);

    // Re-submission is idempotent and should not increase accepted unique count.
    const firstSubmission = voter.getSnapshot()?.submission;
    const retrySubmissionState = await voter.submitVote(["q1"]);
    expect(retrySubmissionState.submission?.responseNpub).toBe(firstSubmission?.responseNpub);
    expect(retrySubmissionState.submission?.responseId).toBe(firstSubmission?.responseId);
    expect(vi.mocked(publishQuestionnaireBlindResponsePublic).mock.calls.length).toBe(submissionPublishCallsAfterFirstSubmit);
    await coordinator.processPendingSubmissions(["q1"]);
    expect(coordinator.getAcceptedUniqueCount()).toBe(1);
  });

  it("allows non-whitelisted voter request then manual coordinator authorization", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(otherNpub), electionId);
    await voter.loginWithSigner(null);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot();

    await coordinator.processPendingBlindRequests();
    expect(coordinator.getPendingAuthorizations().some((entry) => entry.invitedNpub === otherNpub)).toBe(true);

    await coordinator.authorizeRequester(otherNpub);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);
  });

  it("redeems a private invite code into the first requester whitelist entry", async () => {
    const inviteCode = "private-invite-code-1";
    const inviteCodeHash = await hashQuestionnaireInviteCode(inviteCode);
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addBearerInviteCode(inviteCodeHash);

    const voter = new QuestionnaireOptionAVoterRuntime(signer(otherNpub), electionId);
    voter.setBearerInviteCode(inviteCode);
    await voter.loginWithSigner(null);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    await voter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();

    const redeemed = coordinator.getSnapshot()?.bearerInviteCodes[inviteCodeHash];
    expect(redeemed?.state).toBe("redeemed");
    expect(redeemed?.redeemedNpub).toBe(otherNpub);
    expect(coordinator.getSnapshot()?.whitelist[otherNpub]?.inviteCodeHash).toBe(inviteCodeHash);
    expect(coordinator.getPendingAuthorizations().some((entry) => entry.invitedNpub === otherNpub)).toBe(false);
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);

    const secondNpub = "npub1secondcoderuntime0000000000000000000000000000000";
    const secondVoter = new QuestionnaireOptionAVoterRuntime(signer(secondNpub), electionId);
    secondVoter.setBearerInviteCode(inviteCode);
    await secondVoter.loginWithSigner(null);
    await secondVoter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();
    expect(coordinator.getSnapshot()?.whitelist[secondNpub]).toBeUndefined();
    expect(coordinator.getPendingAuthorizations().some((entry) => entry.invitedNpub === secondNpub)).toBe(false);
    expect(listBlindRequests(electionId).some((entry) => entry.invitedNpub === secondNpub)).toBe(false);
  });

  it("uses organiser private invite metadata to control availability", async () => {
    const inviteCodeHash = await hashQuestionnaireInviteCode("private-invite-code-metadata");
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });

    coordinator.addBearerInviteCode(inviteCodeHash);
    coordinator.updateBearerInviteCodeNote(inviteCodeHash, "Alice");
    expect(coordinator.getSnapshot()?.bearerInviteCodes[inviteCodeHash]).toEqual(
      expect.objectContaining({
        autoRequestBallot: true,
      }),
    );
    coordinator.setBearerInviteCodeAutoRequestBallot(inviteCodeHash, false);
    coordinator.setBearerInviteCodeMarkedUsed(inviteCodeHash, true);
    expect(coordinator.getSnapshot()?.bearerInviteCodes[inviteCodeHash]).toEqual(
      expect.objectContaining({
        state: "revoked",
        note: "Alice",
        autoRequestBallot: false,
        markedUsedAt: expect.any(String),
        revokedAt: expect.any(String),
      }),
    );

    coordinator.setBearerInviteCodeAutoRequestBallot(inviteCodeHash, true);
    coordinator.setBearerInviteCodeMarkedUsed(inviteCodeHash, false);
    expect(coordinator.getSnapshot()?.bearerInviteCodes[inviteCodeHash]).toEqual(
      expect.objectContaining({
        state: "available",
        note: "Alice",
        autoRequestBallot: true,
        markedUsedAt: null,
        revokedAt: null,
      }),
    );
  });

  it("recovers coordinator routing from the public summary for a private invite code request", async () => {
    const inviteCode = "private-invite-code-routing";
    const inviteCodeHash = await hashQuestionnaireInviteCode(inviteCode);
    const privateCodeNpub = "npub1privatecoderuntime00000000000000000000000000000";
    const voter = new QuestionnaireOptionAVoterRuntime(signer(privateCodeNpub), electionId);
    voter.setBearerInviteCode(inviteCode);
    const bootstrapped = voter.bootstrapWithLocalIdentity({
      invitedNpub: privateCodeNpub,
      allowInviteMissing: true,
    });
    expect(bootstrapped.coordinatorNpub).toBe("");

    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addBearerInviteCode(inviteCodeHash);

    await voter.requestBlindBallot();
    expect(voter.getSnapshot()?.coordinatorNpub).toBe(coordinatorNpub);
    await coordinator.processPendingBlindRequests();
    expect(coordinator.getSnapshot()?.bearerInviteCodes[inviteCodeHash]?.redeemedNpub).toBe(privateCodeNpub);
  });

  it("hydrates private code ballot requests from cached public questionnaire metadata", async () => {
    const inviteCode = "private-invite-code-cached-definition";
    const privateCodeNpub = "npub1cacheddefinitionvoter0000000000000000000000000";
    const privateKey = await generateQuestionnaireBlindKeyPair();
    storeCachedQuestionnaireDefinition({
      ...buildDefinition({ electionId, coordinatorNpub }),
      blindSigningPublicKey: toQuestionnaireBlindPublicKey(privateKey),
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(privateCodeNpub), electionId);
    voter.setBearerInviteCode(inviteCode);
    const bootstrapped = voter.bootstrapWithLocalIdentity({
      invitedNpub: privateCodeNpub,
      allowInviteMissing: true,
    });
    expect(bootstrapped.coordinatorNpub).toBe(coordinatorNpub);

    const requested = await voter.requestBlindBallot({ forceResend: true });

    expect(requested.blindRequestSent).toBe(true);
    expect(requested.coordinatorNpub).toBe(coordinatorNpub);
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: coordinatorNpub,
      request: expect.objectContaining({
        electionId,
        invitedNpub: privateCodeNpub,
        blindSigningKeyId: toQuestionnaireBlindPublicKey(privateKey).keyId,
      }),
    }));
  });

  it("resets stale blind token request state when signing key changes despite stale invite key", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(sentInvite.invite);
    await voter.requestBlindBallot({ forceResend: true });
    const firstRequest = voter.getSnapshot()?.blindRequest;
    expect(firstRequest?.blindSigningKeyId).toBeTruthy();
    const firstRequestId = firstRequest?.requestId ?? "";
    const firstKeyId = firstRequest?.blindSigningKeyId ?? "";

    const replacementKey = toQuestionnaireBlindPublicKey(await generateQuestionnaireBlindKeyPair());
    const summary = loadElectionSummary(electionId);
    expect(summary).not.toBeNull();
    upsertElectionSummary({
      ...summary!,
      blindSigningPublicKey: replacementKey,
    });

    const nextVoter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await nextVoter.bootstrapWithLocalIdentity({
      invitedNpub: voterNpub,
      coordinatorNpub,
      invite: sentInvite.invite,
      allowInviteMissing: true,
    });
    vi.mocked(publishOptionABlindRequestDm).mockClear();

    const refreshed = await nextVoter.requestBlindBallot({ forceResend: true });

    expect(refreshed.blindRequest?.blindSigningKeyId).toBe(replacementKey.keyId);
    expect(refreshed.blindRequest?.requestId).not.toBe(firstRequestId);
    expect(firstRequest?.blindSigningKeyId).toBe(firstKeyId);
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        blindSigningKeyId: replacementKey.keyId,
      }),
    }));
  });

  it("refreshes the public definition before publishing a blind request so stale cached keys cannot loop forever", async () => {
    const staleKey = toQuestionnaireBlindPublicKey(await generateQuestionnaireBlindKeyPair());
    const latestKey = toQuestionnaireBlindPublicKey(await generateQuestionnaireBlindKeyPair());
    const staleDefinition: QuestionnaireDefinition = {
      ...buildDefinition({ electionId, coordinatorNpub }),
      createdAt: 100,
      openAt: 90,
      closeAt: 3600,
      blindSigningPublicKey: staleKey,
    };
    const latestDefinition: QuestionnaireDefinition = {
      ...buildDefinition({ electionId, coordinatorNpub }),
      createdAt: 200,
      openAt: 190,
      closeAt: 7200,
      blindSigningPublicKey: latestKey,
    };
    storeCachedQuestionnaireDefinition(staleDefinition);
    upsertElectionSummary({
      electionId,
      title: "Runtime",
      description: "Test",
      state: "open",
      openedAt: "2026-06-17T22:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
      blindSigningPublicKey: staleKey,
    });
    vi.mocked(fetchQuestionnaireDefinitions).mockResolvedValueOnce([{
      event: { id: "latest-definition", created_at: latestDefinition.createdAt },
      definition: latestDefinition,
    }] as Awaited<ReturnType<typeof fetchQuestionnaireDefinitions>>);

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    voter.bootstrapWithLocalIdentity({
      invitedNpub: voterNpub,
      coordinatorNpub,
      invite: {
        type: "election_invite",
        schemaVersion: 1,
        electionId,
        title: "Runtime",
        description: "Test",
        voteUrl: "https://example.org/vote",
        invitedNpub: voterNpub,
        coordinatorNpub,
        blindSigningPublicKey: staleKey,
        definition: staleDefinition,
        expiresAt: null,
      },
      allowInviteMissing: true,
    });
    vi.mocked(publishOptionABlindRequestDm).mockClear();

    const refreshed = await voter.requestBlindBallot({ forceResend: true });

    expect(refreshed.blindRequest?.blindSigningKeyId).toBe(latestKey.keyId);
    expect(loadElectionSummary(electionId)?.blindSigningPublicKey?.keyId).toBe(latestKey.keyId);
    expect(readCachedQuestionnaireDefinition(electionId)?.blindSigningPublicKey?.keyId).toBe(latestKey.keyId);
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        blindSigningKeyId: latestKey.keyId,
      }),
    }));
  });

  it("uses a newer cached public definition over an older summary when relay refresh is empty", async () => {
    const staleKey = toQuestionnaireBlindPublicKey(await generateQuestionnaireBlindKeyPair());
    const latestKey = toQuestionnaireBlindPublicKey(await generateQuestionnaireBlindKeyPair());
    const latestDefinition: QuestionnaireDefinition = {
      ...buildDefinition({ electionId, coordinatorNpub }),
      createdAt: 300,
      openAt: 290,
      closeAt: 7200,
      blindSigningPublicKey: latestKey,
    };
    storeCachedQuestionnaireDefinition(latestDefinition);
    upsertElectionSummary({
      electionId,
      title: "Runtime",
      description: "Test",
      state: "open",
      openedAt: "2026-06-17T22:00:00.000Z",
      closedAt: null,
      coordinatorNpub,
      blindSigningPublicKey: staleKey,
      definitionCreatedAt: 100,
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    voter.bootstrapWithLocalIdentity({
      invitedNpub: voterNpub,
      coordinatorNpub,
      invite: {
        type: "election_invite",
        schemaVersion: 1,
        electionId,
        title: "Runtime",
        description: "Test",
        voteUrl: "https://example.org/vote",
        invitedNpub: voterNpub,
        coordinatorNpub,
        blindSigningPublicKey: staleKey,
        expiresAt: null,
      },
      allowInviteMissing: true,
    });
    vi.mocked(publishOptionABlindRequestDm).mockClear();

    const refreshed = await voter.requestBlindBallot({ forceResend: true });

    expect(refreshed.blindRequest?.blindSigningKeyId).toBe(latestKey.keyId);
    expect(vi.mocked(publishOptionABlindRequestDm)).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        blindSigningKeyId: latestKey.keyId,
      }),
    }));
  });

  it("does not republish unchanged voter state during credential wait refresh", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(sentInvite.invite);
    await voter.requestBlindBallot({ forceResend: true });
    await Promise.resolve();
    await Promise.resolve();
    vi.mocked(publishOptionAVoterStateDm).mockClear();

    const before = voter.getSnapshot();
    const refreshed = voter.refreshIssuanceAndAcceptance();

    expect(refreshed).toBe(before);
    expect(publishOptionAVoterStateDm).not.toHaveBeenCalled();
  });

  it("binds an invite to a local ephemeral voter identity when explicitly allowed", async () => {
    const inviteRecipientNpub = "npub1inviteerecipient0000000000000000000000000000000";
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);

    const voter = new QuestionnaireOptionAVoterRuntime(signer(inviteRecipientNpub), electionId);
    const state = voter.bootstrapWithLocalIdentity({
      invitedNpub: voterNpub,
      coordinatorNpub,
      invite: {
        type: "election_invite",
        schemaVersion: 1,
        electionId,
        title: "Runtime",
        description: "Test",
        voteUrl: "https://example.org/vote",
        invitedNpub: inviteRecipientNpub,
        coordinatorNpub,
        expiresAt: null,
      },
      allowInviteRecipientMismatch: true,
    });

    expect(state.loginVerified).toBe(true);
    expect(state.invitedNpub).toBe(voterNpub);
    await voter.requestBlindBallot();
    await coordinator.processPendingBlindRequests();
    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);
  });

  it("loads invite from mailbox when voter logs in without URL invite", async () => {
    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addWhitelistNpub(voterNpub);
    await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    const loggedIn = await voter.loginWithSigner(null);
    expect(loggedIn.loginVerified).toBe(true);
    expect(loggedIn.inviteMessage?.invitedNpub).toBe(voterNpub);
    expect(loggedIn.inviteMessage?.electionId).toBe(electionId);
  });

  it("processes pending requests across multiple elections for the same coordinator", async () => {
    const electionIdOne = "election_runtime_multi_1";
    const electionIdTwo = "election_runtime_multi_2";
    const coordinator = signer(coordinatorNpub);

    const coordinatorOne = new QuestionnaireOptionACoordinatorRuntime(coordinator, electionIdOne);
    await coordinatorOne.loginWithSigner({ title: "Runtime 1", description: "Test", state: "open" });
    coordinatorOne.addWhitelistNpub(voterNpub);
    await coordinatorOne.sendInvite(voterNpub, {
      title: "Runtime 1",
      description: "Test",
      voteUrl: "https://example.org/vote/1",
    });

    const coordinatorTwo = new QuestionnaireOptionACoordinatorRuntime(coordinator, electionIdTwo);
    await coordinatorTwo.loginWithSigner({ title: "Runtime 2", description: "Test", state: "open" });
    coordinatorTwo.addWhitelistNpub(voterNpub);
    const sentTwo = await coordinatorTwo.sendInvite(voterNpub, {
      title: "Runtime 2",
      description: "Test",
      voteUrl: "https://example.org/vote/2",
    });

    const voterTwo = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionIdTwo);
    await voterTwo.loginWithSigner(sentTwo.invite);
    await voterTwo.requestBlindBallot();

    const processed = await processOptionAQueuesForCoordinator({
      coordinatorNpub,
      signer: coordinator,
      preferredElectionId: electionIdOne,
    });
    expect(processed.processedElectionIds).toContain(electionIdTwo);

    voterTwo.refreshIssuanceAndAcceptance();
    expect(voterTwo.getSnapshot()?.credentialReady).toBe(true);
  });

  it("can project an admitted voter into later questionnaires while issuing fresh blind credentials", async () => {
    const electionIdOne = "election_runtime_admitted_1";
    const electionIdTwo = "election_runtime_admitted_2";
    const coordinator = signer(coordinatorNpub);

    const coordinatorOne = new QuestionnaireOptionACoordinatorRuntime(coordinator, electionIdOne);
    await coordinatorOne.loginWithSigner({ title: "Runtime 1", description: "Test", state: "open" });
    expect(coordinatorOne.addWhitelistNpubs([voterNpub, voterNpub]).addedCount).toBe(1);
    const sentOne = await coordinatorOne.sendInvite(voterNpub, {
      title: "Runtime 1",
      description: "Test",
      voteUrl: "https://example.org/vote/1",
    });

    const coordinatorTwo = new QuestionnaireOptionACoordinatorRuntime(coordinator, electionIdTwo);
    await coordinatorTwo.loginWithSigner({ title: "Runtime 2", description: "Test", state: "open" });
    expect(coordinatorTwo.addWhitelistNpubs([voterNpub]).addedCount).toBe(1);
    const sentTwo = await coordinatorTwo.sendInvite(voterNpub, {
      title: "Runtime 2",
      description: "Test",
      voteUrl: "https://example.org/vote/2",
    });

    const voterOne = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionIdOne);
    await voterOne.loginWithSigner(sentOne.invite);
    await voterOne.requestBlindBallot();
    await coordinatorOne.processPendingBlindRequests();
    voterOne.refreshIssuanceAndAcceptance();

    const voterTwo = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionIdTwo);
    await voterTwo.loginWithSigner(sentTwo.invite);
    await voterTwo.requestBlindBallot();
    await coordinatorTwo.processPendingBlindRequests();
    voterTwo.refreshIssuanceAndAcceptance();

    const issuanceOne = voterOne.getSnapshot()?.blindIssuance;
    const issuanceTwo = voterTwo.getSnapshot()?.blindIssuance;
    expect(issuanceOne?.electionId).toBe(electionIdOne);
    expect(issuanceTwo?.electionId).toBe(electionIdTwo);
    expect(issuanceOne?.tokenCommitment).toBeTruthy();
    expect(issuanceTwo?.tokenCommitment).toBeTruthy();
    expect(issuanceOne?.tokenCommitment).not.toBe(issuanceTwo?.tokenCommitment);
    expect(coordinatorOne.getSnapshot()?.whitelist[voterNpub]?.issuanceId).toBe(issuanceOne?.issuanceId);
    expect(coordinatorTwo.getSnapshot()?.whitelist[voterNpub]?.issuanceId).toBe(issuanceTwo?.issuanceId);
  });

  it("issues organiser ballots to multiple voters across multiple sessions without a proxy", async () => {
    const sessionIds = [
      "election_runtime_organiser_multi_1",
      "election_runtime_organiser_multi_2",
    ];
    const voterNpubs = [
      voterNpub,
      otherNpub,
      "npub1thirdorganisermultiruntime0000000000000000000000",
    ];
    const tokenCommitments = new Map<string, string>();
    const coordinatorSigner = signer(coordinatorNpub);

    for (const sessionId of sessionIds) {
      const coordinator = new QuestionnaireOptionACoordinatorRuntime(coordinatorSigner, sessionId);
      await coordinator.loginWithSigner({
        title: `Runtime ${sessionId}`,
        description: "Multi-session organiser ballot test",
        state: "open",
      });
      expect(coordinator.addWhitelistNpubs(voterNpubs).addedCount).toBe(voterNpubs.length);

      const voters = [];
      for (const invitedNpub of voterNpubs) {
        const sentInvite = await coordinator.sendInvite(invitedNpub, {
          title: `Runtime ${sessionId}`,
          description: "Multi-session organiser ballot test",
          voteUrl: `https://example.org/vote/${sessionId}`,
        });
        expect(sentInvite.invite.issueBlindTokensWorker).toBeNull();

        const voter = new QuestionnaireOptionAVoterRuntime(signer(invitedNpub), sessionId);
        await voter.loginWithSigner(sentInvite.invite);
        await voter.requestBlindBallot({ forceResend: true });
        voters.push({ invitedNpub, voter });
      }

      await coordinator.processPendingBlindRequests();

      for (const { invitedNpub, voter } of voters) {
        voter.refreshIssuanceAndAcceptance();
        const issuance = voter.getSnapshot()?.blindIssuance;
        expect(voter.getSnapshot()?.credentialReady).toBe(true);
        expect(issuance?.electionId).toBe(sessionId);
        expect(issuance?.invitedNpub).toBe(invitedNpub);
        expect(issuance?.tokenCommitment).toBeTruthy();
        expect(coordinator.getSnapshot()?.whitelist[invitedNpub]?.issuanceId).toBe(issuance?.issuanceId);
        tokenCommitments.set(`${sessionId}:${invitedNpub}`, issuance?.tokenCommitment ?? "");
      }
    }

    expect(new Set(tokenCommitments.values()).size).toBe(sessionIds.length * voterNpubs.length);
    for (const invitedNpub of voterNpubs) {
      expect(tokenCommitments.get(`${sessionIds[0]}:${invitedNpub}`)).not.toBe(
        tokenCommitments.get(`${sessionIds[1]}:${invitedNpub}`),
      );
    }
  }, 15_000);

  it("issues ballots directly when stale delegated-worker mode is present but no active proxy routing", async () => {
    const staleSessionId = `${electionId}_stale_no_proxy`;
    const staleDelegation = createWorkerDelegationCertificate({
      electionId: staleSessionId,
      coordinatorNpub,
      workerNpub: "npub1staleproxynoproxy00000000000000000000000",
      capabilities: ["issue_blind_tokens"],
      controlRelays: ["wss://worker-relay.example"],
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    upsertStoredWorkerDelegation({
      electionId: staleSessionId,
      mode: "delegated_worker",
      activeDelegation: staleDelegation,
      lastRevocation: null,
      lastUpdatedAt: new Date().toISOString(),
    });

    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), staleSessionId);
    await coordinator.loginWithSigner({
      title: "Runtime stale proxy fallback",
      description: "Stale delegation fallback test",
      state: "open",
    });
    coordinator.addWhitelistNpub(voterNpub);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime stale proxy fallback",
      description: "Stale delegation fallback test",
      voteUrl: "https://example.org/vote/stale-no-proxy",
    });
    expect(sentInvite.invite.issueBlindTokensWorker).toBeNull();

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), staleSessionId);
    await voter.loginWithSigner(sentInvite.invite);
    await voter.requestBlindBallot({ forceResend: true });
    await coordinator.processPendingBlindRequests();

    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);
    expect(voter.getSnapshot()?.blindIssuance?.electionId).toBe(staleSessionId);
    expect(voter.getSnapshot()?.blindIssuance?.invitedNpub).toBe(voterNpub);
    expect(coordinator.getSnapshot()?.whitelist[voterNpub]?.issuanceId).toBe(
      voter.getSnapshot()?.blindIssuance?.issuanceId,
    );
  });

  it("issues delegated proxy ballots to multiple voters across multiple sessions", async () => {
    const sessionIds = [
      "election_runtime_proxy_multi_1",
      "election_runtime_proxy_multi_2",
    ];
    const voterNpubs = [
      voterNpub,
      otherNpub,
      "npub1thirdproxymultiruntime000000000000000000000000000",
    ];
    const workerNpub = "npub1delegateproxymultiruntime000000000000000000000000";
    const coordinatorSigner = signer(coordinatorNpub);
    const delegations = new Map<string, ReturnType<typeof createWorkerDelegationCertificate>>();
    const tokenCommitments = new Map<string, string>();

    for (const sessionId of sessionIds) {
      const definition = buildDefinition({
        electionId: sessionId,
        coordinatorNpub,
        title: `Runtime ${sessionId}`,
      });
      storeCachedQuestionnaireDefinition(definition);
      const delegation = createWorkerDelegationCertificate({
        electionId: sessionId,
        coordinatorNpub,
        workerNpub,
        capabilities: ["issue_blind_tokens"],
        controlRelays: ["wss://worker-relay.example"],
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
      delegations.set(sessionId, delegation);
      upsertStoredWorkerDelegation({
        electionId: sessionId,
        mode: "delegated_worker",
        activeDelegation: delegation,
        lastRevocation: null,
        lastUpdatedAt: new Date().toISOString(),
      });
    }

    vi.mocked(fetchQuestionnaireActiveWorkerDelegationForCapability).mockImplementation(async (input) => (
      delegations.get(input.questionnaireId) ?? null
    ));

    for (const sessionId of sessionIds) {
      const coordinator = new QuestionnaireOptionACoordinatorRuntime(coordinatorSigner, sessionId);
      await coordinator.loginWithSigner({
        title: `Runtime ${sessionId}`,
        description: "Multi-session proxy ballot test",
        state: "open",
      });
      expect(coordinator.addWhitelistNpubs(voterNpubs).addedCount).toBe(voterNpubs.length);

      const voters = [];
      for (const invitedNpub of voterNpubs) {
        const sentInvite = await coordinator.sendInvite(invitedNpub, {
          title: `Runtime ${sessionId}`,
          description: "Multi-session proxy ballot test",
          voteUrl: `https://example.org/vote/${sessionId}`,
        });
        expect(sentInvite.invite.issueBlindTokensWorker?.workerNpub).toBe(workerNpub);

        const voter = new QuestionnaireOptionAVoterRuntime(signer(invitedNpub), sessionId);
        await voter.loginWithSigner(sentInvite.invite);
        await voter.requestBlindBallot({ forceResend: true });
        voters.push({ invitedNpub, voter });
      }

      await coordinator.processPendingBlindRequests();
      for (const { invitedNpub, voter } of voters) {
        const requestId = voter.getSnapshot()?.blindRequest?.requestId ?? "";
        expect(requestId).toBeTruthy();
        expect(coordinator.getSnapshot()?.whitelist[invitedNpub]?.claimState).toBe("blind_request_received");
        expect(readBlindIssuance(requestId)).toBe(null);
      }

      await processDelegatedCoordinatorQueues({
        electionId: sessionId,
        coordinatorNpub,
        workerNpub,
        expectedInviteeCount: voterNpubs.length,
      });

      for (const { invitedNpub, voter } of voters) {
        voter.refreshIssuanceAndAcceptance();
        const issuance = voter.getSnapshot()?.blindIssuance;
        expect(voter.getSnapshot()?.credentialReady).toBe(true);
        expect(issuance?.electionId).toBe(sessionId);
        expect(issuance?.invitedNpub).toBe(invitedNpub);
        expect(issuance?.tokenCommitment).toBeTruthy();
        expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledWith(expect.objectContaining({
          recipientNpub: invitedNpub,
        }));
        tokenCommitments.set(`${sessionId}:${invitedNpub}`, issuance?.tokenCommitment ?? "");
      }
    }

    expect(new Set(tokenCommitments.values()).size).toBe(sessionIds.length * voterNpubs.length);
    for (const invitedNpub of voterNpubs) {
      expect(tokenCommitments.get(`${sessionIds[0]}:${invitedNpub}`)).not.toBe(
        tokenCommitments.get(`${sessionIds[1]}:${invitedNpub}`),
      );
    }
    for (const sessionId of sessionIds) {
      expect(publishOptionABlindRequestDm).toHaveBeenCalledWith(expect.objectContaining({
        recipientNpub: workerNpub,
        request: expect.objectContaining({ electionId: sessionId }),
      }));
      expect(publishOptionABlindRequestDm).toHaveBeenCalledWith(expect.objectContaining({
        recipientNpub: coordinatorNpub,
        request: expect.objectContaining({ electionId: sessionId }),
      }));
    }
  }, 15_000);

  it("runs delegated request -> issuance -> submission -> summary end to end", async () => {
    const workerNpub = "npub1delegatecoordinatorruntime00000000000000000000000";
    const definition = buildDefinition({
      electionId,
      coordinatorNpub,
    });
    storeCachedQuestionnaireDefinition(definition);

    const delegation = createWorkerDelegationCertificate({
      electionId,
      coordinatorNpub,
      workerNpub,
      capabilities: [
        "issue_blind_tokens",
        "verify_public_submissions",
        "publish_submission_decisions",
        "publish_result_summary",
      ],
      controlRelays: ["wss://worker-relay.example"],
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    upsertStoredWorkerDelegation({
      electionId,
      mode: "delegated_worker",
      activeDelegation: delegation,
      lastRevocation: null,
      lastUpdatedAt: new Date().toISOString(),
    });

    coordinator.addWhitelistNpub(voterNpub);
    vi.mocked(fetchQuestionnaireActiveWorkerDelegationForCapability).mockResolvedValueOnce(delegation);
    const sentInvite = await coordinator.sendInvite(voterNpub, {
      title: "Runtime",
      description: "Test",
      voteUrl: "https://example.org/vote",
    });
    expect(sentInvite.invite.issueBlindTokensWorker?.workerNpub).toBe(workerNpub);

    const voter = new QuestionnaireOptionAVoterRuntime(signer(voterNpub), electionId);
    await voter.loginWithSigner(sentInvite.invite);
    voter.updateDraftResponses([{ questionId: "q1", type: "yes_no", answer: "yes" }]);
    vi.mocked(publishOptionABlindRequestDm).mockClear();
    await voter.requestBlindBallot({ forceResend: true });

    const requestId = voter.getSnapshot()?.blindRequest?.requestId;
    expect(requestId).toBeTruthy();
    expect(publishOptionABlindRequestDm).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: workerNpub,
    }));
    expect(publishOptionABlindRequestDm).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: coordinatorNpub,
    }));
    await coordinator.processPendingBlindRequests();
    expect(coordinator.getSnapshot()?.whitelist[voterNpub]?.claimState).toBe("blind_request_received");
    expect(readBlindIssuance(requestId ?? "")).toBe(null);

    await processDelegatedCoordinatorQueues({
      electionId,
      coordinatorNpub,
      workerNpub,
      expectedInviteeCount: 1,
    });

    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.credentialReady).toBe(true);
    expect(vi.mocked(publishOptionABlindIssuanceDm)).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: voterNpub,
    }));

    await voter.submitVote(["q1"]);
    const submission = voter.getSnapshot()?.submission;
    expect(submission?.submissionId).toBeTruthy();

    await coordinator.processPendingSubmissions(["q1"]);
    expect(readAcceptance(submission?.submissionId ?? "")).toBe(null);

    await processDelegatedCoordinatorQueues({
      electionId,
      coordinatorNpub,
      workerNpub,
      expectedInviteeCount: 1,
    });

    voter.refreshIssuanceAndAcceptance();
    expect(voter.getSnapshot()?.submissionAccepted).toBe(true);

    const recoveredCoordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    recoveredCoordinator.bootstrapCoordinatorNpub({
      coordinatorNpub,
      summary: loadCoordinatorState({ coordinatorNpub, electionId })?.election,
      startDmSubscriptions: false,
      recoverSelfState: false,
      publishSelfState: false,
    });
    expect(recoveredCoordinator.getAcceptedUniqueCount()).toBe(1);

    expect(vi.mocked(publishQuestionnaireSubmissionDecisionPublic)).toHaveBeenCalledWith(expect.objectContaining({
      submissionId: submission?.submissionId,
      accepted: true,
    }));
    expect(vi.mocked(publishOptionABallotAcceptanceDm)).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: submission?.responseNpub,
    }));
    expect(vi.mocked(publishQuestionnaireResultSummary)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishQuestionnaireResultSummary)).toHaveBeenCalledWith(expect.objectContaining({
      resultSummary: expect.objectContaining({
        questionnaireId: electionId,
        acceptedResponseCount: 1,
        rejectedResponseCount: 0,
        acceptedNullifierCount: 1,
        questionSummaries: [
          expect.objectContaining({
            questionId: "q1",
            answerType: "yes_no",
            yesCount: 1,
            noCount: 0,
          }),
        ],
      }),
    }));
  });

  it("observes delegated private invite requests without local issuance", async () => {
    const workerNpub = "npub1delegateprivatecoderuntime000000000000000000000";
    const privateCodeNpub = "npub1privatecodedelegated000000000000000000000000";
    const inviteCode = "private-invite-code-delegated";
    const inviteCodeHash = await hashQuestionnaireInviteCode(inviteCode);
    const definition = buildDefinition({
      electionId,
      coordinatorNpub,
    });
    storeCachedQuestionnaireDefinition(definition);
    const delegation = createWorkerDelegationCertificate({
      electionId,
      coordinatorNpub,
      workerNpub,
      capabilities: ["issue_blind_tokens"],
      controlRelays: ["wss://worker-relay.example"],
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    const coordinator = new QuestionnaireOptionACoordinatorRuntime(signer(coordinatorNpub), electionId);
    await coordinator.loginWithSigner({ title: "Runtime", description: "Test", state: "open" });
    coordinator.addBearerInviteCode(inviteCodeHash);
    upsertStoredWorkerDelegation({
      electionId,
      mode: "delegated_worker",
      activeDelegation: delegation,
      lastRevocation: null,
      lastUpdatedAt: new Date().toISOString(),
    });

    vi.mocked(fetchQuestionnaireActiveWorkerDelegationForCapability).mockResolvedValueOnce(delegation);
    vi.mocked(publishOptionABlindRequestDm).mockClear();
    const voter = new QuestionnaireOptionAVoterRuntime(signer(privateCodeNpub), electionId);
    voter.setBearerInviteCode(inviteCode);
    voter.bootstrapWithLocalIdentity({
      invitedNpub: privateCodeNpub,
      allowInviteMissing: true,
    });
    await voter.requestBlindBallot({ forceResend: true });

    const requestId = voter.getSnapshot()?.blindRequest?.requestId ?? "";
    await coordinator.processPendingBlindRequests();
    const redeemed = coordinator.getSnapshot()?.bearerInviteCodes[inviteCodeHash];
    expect(redeemed?.state).toBe("redeemed");
    expect(redeemed?.redeemedNpub).toBe(privateCodeNpub);
    expect(coordinator.getSnapshot()?.whitelist[privateCodeNpub]?.claimState).toBe("blind_request_received");
    expect(readBlindIssuance(requestId)).toBe(null);
    expect(publishOptionABlindRequestDm).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: workerNpub,
    }));
    expect(publishOptionABlindRequestDm).toHaveBeenCalledWith(expect.objectContaining({
      recipientNpub: coordinatorNpub,
    }));
  });
});

import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type NostrEvent,
} from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "../src/nostrPublishQueue";
import { buildQuestionnaireBlindTokenSignedMessage, deriveQuestionnaireTokenNullifier } from "../src/questionnaireBlindToken";
import {
  blindQuestionnaireToken,
  finalizeQuestionnaireBlindSignature,
  generateQuestionnaireBlindKeyPair,
  signBlindedQuestionnaireToken,
  toQuestionnaireBlindPublicKey,
  verifyQuestionnaireBlindSignature,
} from "../src/questionnaireBlindSignature";
import {
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionABlindRequestDmsWithNsec,
  fetchOptionAWorkerElectionConfigDmsWithNsec,
  publishOptionABlindIssuanceDm,
  publishOptionABlindRequestDm,
  publishOptionAWorkerElectionConfigDm,
  type WorkerElectionConfigSnapshot,
} from "../src/questionnaireOptionABlindDm";
import {
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  publishQuestionnaireDefinition,
  publishQuestionnaireState,
} from "../src/questionnaireNostr";
import type {
  QuestionnaireDefinition,
  QuestionnaireResponseAnswer,
  QuestionnaireResultSummary,
  QuestionnaireSubmissionDecision,
} from "../src/questionnaireProtocol";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
  IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION,
} from "../src/questionnaireProtocolConstants";
import { buildQuestionnaireResultSummary, type QuestionnaireRejectedResponse } from "../src/questionnaireRuntime";
import {
  fetchQuestionnaireActiveWorkerDelegationForCapability,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireSubmissionDecisions,
  evaluateQuestionnaireBlindAdmissions,
} from "../src/questionnaireTransport";
import { publishQuestionnaireBlindResponsePublic } from "../src/questionnaireResponsePublish";
import { createWorkerDelegationCertificate, publishWorkerDelegationCertificate } from "../src/questionnaireWorkerDelegation";
import { getSharedNostrPool } from "../src/sharedNostrPool";
import { SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS, SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS, SIMPLE_PUBLIC_PUBLISH_STAGGER_MS, SIMPLE_PUBLIC_RELAYS } from "../src/simpleVotingSession";
import type { SignerService } from "../src/services/signerService";
import { normalizeRelaysRust } from "../src/wasm/auditableVotingCore";

const webcrypto = nodeCrypto.webcrypto as unknown as Crypto;
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}

function envInt(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomId(prefix: string) {
  const entropy = nodeCrypto.randomBytes(8).toString("hex");
  return `${prefix}_${entropy}`;
}

function sha256Hex(value: string) {
  return nodeCrypto.createHash("sha256").update(value).digest("hex");
}

function decodeNsecSecretKey(nsec: string) {
  const decoded = nip19.decode(nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Expected nsec.");
  }
  return decoded.data as Uint8Array;
}

function buildRelays() {
  const raw = process.env.OPTIONA_LIVE_DELEGATE_RELAYS?.trim();
  const relays = raw
    ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
    : SIMPLE_PUBLIC_RELAYS.slice(0, 4);
  return normalizeRelaysRust(relays);
}

function makeNostrIdentity() {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return {
    secretKey,
    npub: nip19.npubEncode(publicKey),
    nsec: nip19.nsecEncode(secretKey),
  };
}

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

async function waitForValue<T>(
  label: string,
  task: () => Promise<T>,
  isReady: (value: T) => boolean,
  timeoutMs: number,
  intervalMs: number,
) {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await task();
      if (isReady(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError instanceof Error) {
    throw new Error(`${label} timed out after ${timeoutMs}ms: ${lastError.message}`);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms.`);
}

function buildDefinition(input: {
  questionnaireId: string;
  coordinatorNpub: string;
  blindSigningPublicKey: ReturnType<typeof toQuestionnaireBlindPublicKey>;
}): QuestionnaireDefinition {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    protocolVersion: 2,
    flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: input.questionnaireId,
    title: "Live delegate coordinator smoke",
    description: "Opt-in public-relay delegate coordinator smoke test",
    createdAt: now,
    openAt: now - 30,
    closeAt: now + 900,
    coordinatorPubkey: input.coordinatorNpub,
    coordinatorEncryptionPubkey: input.coordinatorNpub,
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    blindSigningPublicKey: input.blindSigningPublicKey,
    questions: [
      {
        questionId: "q1",
        prompt: "Does delegated blind issuance work over public relays?",
        required: true,
        type: "yes_no",
      },
    ],
  };
}

async function publishWorkerSignedEvent(input: {
  workerNsec: string;
  kind: number;
  createdAt: number;
  content: string;
  tags: string[][];
  relays: string[];
  channel: string;
}) {
  const secretKey = decodeNsecSecretKey(input.workerNsec);
  const event = finalizeEvent({
    kind: input.kind,
    created_at: input.createdAt,
    tags: input.tags,
    content: input.content,
  }, secretKey);
  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
      input.relays,
      { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
    ),
    {
      channel: input.channel,
      minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
    },
  );
  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: input.relays[index], success: true as const }
      : {
          relay: input.relays[index],
          success: false as const,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
  return {
    eventId: event.id,
    successes: relayResults.filter((entry) => entry.success).length,
    failures: relayResults.filter((entry) => !entry.success).length,
    relayResults,
    event,
  };
}

async function publishWorkerSignedSubmissionDecision(input: {
  workerNsec: string;
  workerNpub: string;
  coordinatorNpub: string;
  questionnaireId: string;
  submissionId: string;
  tokenNullifier: string;
  accepted: boolean;
  delegationId: string;
  relays: string[];
}) {
  const decision: QuestionnaireSubmissionDecision = {
    schemaVersion: 1,
    eventType: "questionnaire_submission_decision",
    questionnaireId: input.questionnaireId,
    submissionId: input.submissionId,
    tokenNullifier: input.tokenNullifier,
    accepted: input.accepted,
    reason: input.accepted ? "accepted" : "invalid_payload_shape",
    decidedAt: Math.floor(Date.now() / 1000),
    coordinatorPubkey: input.coordinatorNpub,
  };
  return publishWorkerSignedEvent({
    workerNsec: input.workerNsec,
    kind: IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION,
    createdAt: decision.decidedAt,
    content: JSON.stringify(decision),
    tags: [
      ["t", "questionnaire_submission_decision"],
      ["questionnaire", input.questionnaireId],
      ["schema", "1"],
      ["etype", "questionnaire_submission_decision"],
      ["submission-id", input.submissionId],
      ["nullifier", input.tokenNullifier],
      ["accepted", input.accepted ? "1" : "0"],
      ["reason", decision.reason],
      ["coordinator", input.coordinatorNpub],
      ["worker", input.workerNpub],
      ["delegation-id", input.delegationId],
    ],
    relays: input.relays,
    channel: "questionnaire-submission-decision-live-smoke",
  });
}

async function publishWorkerSignedResultSummary(input: {
  workerNsec: string;
  workerNpub: string;
  coordinatorNpub: string;
  questionnaireId: string;
  resultSummary: QuestionnaireResultSummary;
  relays: string[];
}) {
  return publishWorkerSignedEvent({
    workerNsec: input.workerNsec,
    kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
    createdAt: input.resultSummary.createdAt,
    content: JSON.stringify(input.resultSummary),
    tags: [
      ["t", "questionnaire_result_summary"],
      ["questionnaire-id", input.questionnaireId],
      ["worker", input.workerNpub],
      ["coordinator", input.coordinatorNpub],
    ],
    relays: input.relays,
    channel: "questionnaire-result-summary-live-smoke",
  });
}

async function queryPublicEventById(input: {
  eventId: string;
  kind: number;
  relays: string[];
}) {
  const pool = getSharedNostrPool();
  const events = await pool.querySync(input.relays, {
    ids: [input.eventId],
    kinds: [input.kind],
    limit: 1,
  });
  return events.find((event) => event.id === input.eventId) ?? null;
}

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("Global WebSocket is not available in this Node runtime.");
  }

  const relays = buildRelays();
  const timeoutMs = envInt("OPTIONA_LIVE_DELEGATE_TIMEOUT_MS", 120_000);
  const intervalMs = envInt("OPTIONA_LIVE_DELEGATE_POLL_MS", 4_000);
  const readRelayLimit = envInt("OPTIONA_LIVE_DELEGATE_READ_RELAY_LIMIT", Math.min(6, relays.length));

  const coordinator = makeNostrIdentity();
  const worker = makeNostrIdentity();
  const voter = makeNostrIdentity();
  const questionnaireId = `q_live_delegate_${nodeCrypto.randomBytes(8).toString("hex")}`;
  const blindSigningPrivateKey = await generateQuestionnaireBlindKeyPair();
  const blindSigningPublicKey = toQuestionnaireBlindPublicKey(blindSigningPrivateKey);
  const definition = buildDefinition({
    questionnaireId,
    coordinatorNpub: coordinator.npub,
    blindSigningPublicKey,
  });

  process.stdout.write(`Live delegate coordinator smoke\n`);
  process.stdout.write(`Questionnaire: ${questionnaireId}\n`);
  process.stdout.write(`Coordinator: ${coordinator.npub}\n`);
  process.stdout.write(`Delegate coordinator: ${worker.npub}\n`);
  process.stdout.write(`Voter: ${voter.npub}\n`);
  process.stdout.write(`Relays: ${relays.join(", ")}\n`);

  const publishedDefinition = await publishQuestionnaireDefinition({
    coordinatorNsec: coordinator.nsec,
    definition,
    relays,
  });
  assert(publishedDefinition.successes > 0, "expected questionnaire definition publish to succeed on at least one relay");

  const publishedState = await publishQuestionnaireState({
    coordinatorNsec: coordinator.nsec,
    stateEvent: {
      schemaVersion: 1,
      eventType: "questionnaire_state",
      questionnaireId,
      state: "open",
      createdAt: Math.floor(Date.now() / 1000),
      coordinatorPubkey: coordinator.npub,
    },
    relays,
  });
  assert(publishedState.successes > 0, "expected questionnaire state publish to succeed on at least one relay");

  const delegation = createWorkerDelegationCertificate({
    electionId: questionnaireId,
    coordinatorNpub: coordinator.npub,
    workerNpub: worker.npub,
    capabilities: [
      "issue_blind_tokens",
      "verify_public_submissions",
      "publish_submission_decisions",
      "publish_result_summary",
    ],
    controlRelays: relays,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  const publishedDelegation = await publishWorkerDelegationCertificate({
    coordinatorNsec: coordinator.nsec,
    delegation,
    relays,
  });
  assert(publishedDelegation.successes > 0, "expected worker delegation publish to succeed on at least one relay");

  const visibleDelegation = await waitForValue(
    "delegate coordinator delegation visibility",
    () => fetchQuestionnaireActiveWorkerDelegationForCapability({
      questionnaireId,
      capability: "issue_blind_tokens",
      relays,
      readRelayLimit,
    }),
    (value) => Boolean(value?.workerNpub === worker.npub),
    timeoutMs,
    intervalMs,
  );
  assert.equal(visibleDelegation?.workerNpub, worker.npub);

  const configSnapshot: WorkerElectionConfigSnapshot = {
    type: "worker_election_config",
    schemaVersion: 1,
    electionId: questionnaireId,
    delegationId: delegation.delegationId,
    coordinatorNpub: coordinator.npub,
    workerNpub: worker.npub,
    expectedInviteeCount: 1,
    blindSigningPrivateKey,
    definition,
    sentAt: new Date().toISOString(),
  };
  const publishedConfigDm = await publishOptionAWorkerElectionConfigDm({
    signer: signer(coordinator.npub),
    recipientNpub: worker.npub,
    snapshot: configSnapshot,
    fallbackNsec: coordinator.nsec,
    relays,
  });
  assert(publishedConfigDm.successes > 0, "expected worker election config DM publish to succeed on at least one relay");

  const visibleConfig = await waitForValue(
    "delegate coordinator election config DM",
    async () => {
      const entries = await fetchOptionAWorkerElectionConfigDmsWithNsec({
        nsec: worker.nsec,
        electionId: questionnaireId,
        relays,
        limit: 20,
      });
      return entries.find((entry) => entry.delegationId === delegation.delegationId) ?? null;
    },
    (value) => Boolean(value?.delegationId === delegation.delegationId),
    timeoutMs,
    intervalMs,
  );
  assert.equal(visibleConfig?.workerNpub, worker.npub);

  const tokenSecret = nodeCrypto.randomBytes(32).toString("hex");
  const tokenCommitment = sha256Hex(tokenSecret);
  const blindTokenMessage = buildQuestionnaireBlindTokenSignedMessage({
    questionnaireId,
    tokenSecretCommitment: tokenCommitment,
  });
  const blindedToken = await blindQuestionnaireToken({
    publicKey: blindSigningPublicKey,
    message: blindTokenMessage,
  });
  const request = {
    type: "blind_ballot_request" as const,
    schemaVersion: 1 as const,
    electionId: questionnaireId,
    requestId: randomId("request"),
    invitedNpub: voter.npub,
    blindedMessage: blindedToken.blindedMessage,
    tokenCommitment,
    blindSigningKeyId: blindSigningPublicKey.keyId,
    clientNonce: randomId("nonce"),
    createdAt: new Date().toISOString(),
  };
  const publishedBlindRequest = await publishOptionABlindRequestDm({
    signer: signer(voter.npub),
    recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
    request,
    fallbackNsec: voter.nsec,
    relays: visibleDelegation?.controlRelays ?? relays,
  });
  assert(publishedBlindRequest.successes > 0, "expected blind request DM publish to succeed on at least one relay");

  const visibleBlindRequest = await waitForValue(
    "delegate coordinator blind request DM",
    async () => {
      const entries = await fetchOptionABlindRequestDmsWithNsec({
        nsec: worker.nsec,
        electionId: questionnaireId,
        relays,
        limit: 30,
      });
      return entries.find((entry) => entry.requestId === request.requestId) ?? null;
    },
    (value) => Boolean(value?.requestId === request.requestId),
    timeoutMs,
    intervalMs,
  );
  assert.equal(visibleBlindRequest?.requestId, request.requestId);

  const issuance = {
    type: "blind_ballot_response" as const,
    schemaVersion: 1 as const,
    electionId: questionnaireId,
    requestId: request.requestId,
    issuanceId: randomId("issuance"),
    invitedNpub: voter.npub,
    tokenCommitment,
    blindSigningKeyId: blindSigningPublicKey.keyId,
    blindSignature: await signBlindedQuestionnaireToken({
      privateKey: blindSigningPrivateKey,
      blindedMessage: request.blindedMessage,
    }),
    definition,
    issuedAt: new Date().toISOString(),
  };
  const publishedBlindIssuance = await publishOptionABlindIssuanceDm({
    signer: signer(worker.npub),
    recipientNpub: voter.npub,
    issuance,
    fallbackNsec: worker.nsec,
    relays,
  });
  assert(publishedBlindIssuance.successes > 0, "expected blind issuance DM publish to succeed on at least one relay");

  const visibleIssuance = await waitForValue(
    "voter blind issuance DM",
    async () => {
      const entries = await fetchOptionABlindIssuanceDmsWithNsec({
        nsec: voter.nsec,
        electionId: questionnaireId,
        relays,
        limit: 30,
      });
      return entries.find((entry) => entry.requestId === request.requestId) ?? null;
    },
    (value) => Boolean(value?.requestId === request.requestId),
    timeoutMs,
    intervalMs,
  );
  assert.equal(visibleIssuance?.definition?.questionnaireId, questionnaireId);

  const credential = await finalizeQuestionnaireBlindSignature({
    publicKey: blindSigningPublicKey,
    message: blindTokenMessage,
    blindSignature: visibleIssuance?.blindSignature ?? issuance.blindSignature,
    blindingFactor: blindedToken.blindingFactor,
  });
  assert.equal(
    await verifyQuestionnaireBlindSignature({
      publicKey: blindSigningPublicKey,
      message: blindTokenMessage,
      signature: credential,
    }),
    true,
    "expected final credential verification to succeed",
  );

  const responseSecretKey = generateSecretKey();
  const responseNsec = nip19.nsecEncode(responseSecretKey);
  const responseNpub = nip19.npubEncode(getPublicKey(responseSecretKey));
  const submissionId = randomId("submission");
  const submittedAt = Math.floor(Date.now() / 1000);
  const tokenNullifier = deriveQuestionnaireTokenNullifier({
    questionnaireId,
    tokenSecret,
  });
  const answers: QuestionnaireResponseAnswer[] = [
    {
      questionId: "q1",
      answerType: "yes_no",
      value: true,
    },
  ];
  const publishedBlindResponse = await publishQuestionnaireBlindResponsePublic({
    responseNsec,
    questionnaireId,
    questionnaireDefinitionEventId: publishedDefinition.eventId,
    responseId: submissionId,
    submittedAt,
    tokenNullifier,
    tokenProof: {
      tokenCommitment,
      questionnaireId,
      signature: credential,
    },
    answers,
    relays,
  });
  assert(publishedBlindResponse.successes > 0, "expected public blind response publish to succeed on at least one relay");

  const publicResponses = await waitForValue(
    "public blind response visibility",
    async () => {
      const entries = await fetchQuestionnaireBlindResponses({
        questionnaireId,
        relays,
        readRelayLimit,
        preferKindOnly: true,
        limit: 100,
      });
      return entries.some((entry) => entry.response.responseId === submissionId) ? entries : [];
    },
    (value) => Array.isArray(value) && value.some((entry) => entry.response.responseId === submissionId),
    timeoutMs,
    intervalMs,
  );
  assert(publicResponses.some((entry) => entry.response.responseId === submissionId), "expected published blind response to be queryable");

  const publishedDecision = await publishWorkerSignedSubmissionDecision({
    workerNsec: worker.nsec,
    workerNpub: worker.npub,
    coordinatorNpub: coordinator.npub,
    questionnaireId,
    submissionId,
    tokenNullifier,
    accepted: true,
    delegationId: delegation.delegationId,
    relays,
  });
  assert(publishedDecision.successes > 0, "expected delegate coordinator decision publish to succeed on at least one relay");

  const submissionDecisions = await waitForValue(
    "public submission decision visibility",
    async () => {
      const entries = await fetchQuestionnaireSubmissionDecisions({
        questionnaireId,
        relays,
        readRelayLimit,
        preferKindOnly: true,
        limit: 100,
      });
      return entries.some((entry) => entry.decision.submissionId === submissionId && entry.decision.accepted) ? entries : [];
    },
    (value) => Array.isArray(value) && value.some((entry) => entry.decision.submissionId === submissionId && entry.decision.accepted),
    timeoutMs,
    intervalMs,
  );
  assert(submissionDecisions.some((entry) => entry.decision.submissionId === submissionId && entry.decision.accepted));

  const admissions = evaluateQuestionnaireBlindAdmissions({
    entries: publicResponses,
    decisionEntries: submissionDecisions,
  });
  assert.equal(admissions.accepted.length, 1, "expected one accepted delegated response");
  assert.equal(admissions.rejected.length, 0, "expected no rejected delegated responses");

  const acceptedResponses = admissions.accepted.map((entry) => ({
    eventId: entry.event.id,
    authorPubkey: entry.response.authorPubkey,
    envelope: {
      schemaVersion: 1 as const,
      eventType: "questionnaire_response_private" as const,
      questionnaireId: entry.response.questionnaireId,
      responseId: entry.response.responseId,
      createdAt: entry.response.submittedAt ?? entry.event.created_at,
      authorPubkey: entry.response.authorPubkey,
      ciphertextScheme: "nip44v2" as const,
      ciphertextRecipient: coordinator.npub,
      ciphertext: "",
      payloadHash: entry.response.tokenProof.tokenCommitment,
    },
    payload: {
      schemaVersion: 1 as const,
      kind: "questionnaire_response_payload" as const,
      questionnaireId: entry.response.questionnaireId,
      responseId: entry.response.responseId,
      submittedAt: entry.response.submittedAt ?? entry.event.created_at,
      answers: entry.response.answers ?? [],
    },
  }));
  const rejectedResponses: QuestionnaireRejectedResponse[] = admissions.rejected.map((entry) => ({
    eventId: entry.event.id,
    authorPubkey: entry.response.authorPubkey,
    responseId: entry.response.responseId,
    reason: "invalid_payload_shape",
    detail: entry.rejectionReason ?? undefined,
  }));
  const resultSummary = buildQuestionnaireResultSummary({
    definition,
    coordinatorPubkey: coordinator.npub,
    acceptedResponses,
    rejectedResponses,
  });
  resultSummary.acceptedNullifierCount = new Set(
    admissions.accepted
      .map((entry) => entry.response.tokenNullifier.trim())
      .filter((value) => value.length > 0),
  ).size;
  resultSummary.publishedResponseRefs = admissions.decisions.map((entry) => ({
    responseId: entry.response.responseId,
    authorPubkey: entry.response.authorPubkey,
    submittedAt: entry.response.submittedAt ?? entry.event.created_at,
    accepted: entry.accepted,
    answers: entry.response.answers,
  }));

  const publishedSummary = await publishWorkerSignedResultSummary({
    workerNsec: worker.nsec,
    workerNpub: worker.npub,
    coordinatorNpub: coordinator.npub,
    questionnaireId,
    resultSummary,
    relays,
  });
  assert(publishedSummary.successes > 0, "expected delegate coordinator result summary publish to succeed on at least one relay");

  let visibleSummary = null as QuestionnaireResultSummary | null;
  try {
    visibleSummary = await waitForValue(
      "public result summary visibility",
      () => fetchQuestionnaireResultSummary({
        questionnaireId,
        relays,
        readRelayLimit,
        preferKindOnly: true,
        limit: 50,
      }),
      (value) => Boolean(value?.questionnaireId === questionnaireId && value.acceptedResponseCount === 1),
      timeoutMs,
      intervalMs,
    );
  } catch {
    const summaryEvent = await waitForValue(
      "public result summary event visibility",
      () => queryPublicEventById({
        eventId: publishedSummary.eventId,
        kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
        relays,
      }),
      (value): value is NostrEvent => Boolean(value?.id === publishedSummary.eventId),
      timeoutMs,
      intervalMs,
    );
    visibleSummary = JSON.parse(summaryEvent.content) as QuestionnaireResultSummary;
  }
  assert.equal(visibleSummary?.acceptedResponseCount, 1);
  assert.equal(visibleSummary?.rejectedResponseCount, 0);

  process.stdout.write(`delegate coordinator live smoke passed\n`);
  process.stdout.write(`Delegation event: ${publishedDelegation.eventId}\n`);
  process.stdout.write(`Blind request: ${request.requestId}\n`);
  process.stdout.write(`Blind issuance: ${issuance.issuanceId}\n`);
  process.stdout.write(`Submission: ${submissionId} (${responseNpub})\n`);
  process.stdout.write(`Result summary: ${publishedSummary.eventId}\n`);
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    getSharedNostrPool().destroy?.();
  });

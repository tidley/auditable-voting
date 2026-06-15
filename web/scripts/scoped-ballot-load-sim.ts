import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { generateSecretKey, getPublicKey, nip19, type NostrEvent } from "nostr-tools";
import {
  buildQuestionnaireBlindTokenSignedMessage,
  deriveQuestionnaireTokenNullifier,
} from "../src/questionnaireBlindToken";
import {
  blindQuestionnaireToken,
  finalizeQuestionnaireBlindSignature,
  generateQuestionnaireBlindKeyPair,
  signBlindedQuestionnaireToken,
  toQuestionnaireBlindPublicKey,
} from "../src/questionnaireBlindSignature";
import type { BallotScope } from "../src/questionnaireOptionA";
import type {
  QuestionnaireDefinition,
  QuestionnaireResponseAnswer,
} from "../src/questionnaireProtocol";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
} from "../src/questionnaireProtocolConstants";
import {
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  type QuestionnaireBlindResponseEvent,
} from "../src/questionnaireResponsePublish";
import {
  evaluateQuestionnaireBlindAdmissions,
  verifyQuestionnaireBlindResponseProofs,
} from "../src/questionnaireTransport";

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

function envBool(name: string, fallback: boolean) {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function sha256Hex(value: string) {
  return nodeCrypto.createHash("sha256").update(value).digest("hex");
}

function randomId(prefix: string) {
  return `${prefix}_${nodeCrypto.randomBytes(8).toString("hex")}`;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

function makeNostrIdentity() {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return {
    hex: publicKey,
    npub: nip19.npubEncode(publicKey),
  };
}

function makeDefinition(input: {
  questionnaireId: string;
  questionCount: number;
  coordinatorHex: string;
}): QuestionnaireDefinition {
  const now = Math.floor(Date.now() / 1000);
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    protocolVersion: 2,
    flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: input.questionnaireId,
    title: `Scoped load simulation ${input.questionCount}`,
    description: "Local simulation of one scoped blind ballot per question.",
    createdAt: now,
    openAt: now,
    closeAt: now + 3600,
    coordinatorPubkey: input.coordinatorHex,
    coordinatorEncryptionPubkey: input.coordinatorHex,
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    ballotCredentialMode: "per_question",
    questions: Array.from({ length: input.questionCount }, (_, index) => {
      const slotIndex = index + 1;
      return {
        type: "yes_no" as const,
        questionId: `q${slotIndex}`,
        prompt: `Question ${slotIndex}`,
        required: true,
        ballotSlot: {
          slotId: `q${slotIndex}`,
          slotIndex,
          version: 1,
        },
      };
    }),
  };
}

function ballotScopeForQuestion(
  question: QuestionnaireDefinition["questions"][number],
  index: number,
): BallotScope {
  return {
    questionId: question.questionId,
    slotId: question.ballotSlot?.slotId?.trim() || question.questionId,
    slotIndex: Number.isFinite(question.ballotSlot?.slotIndex)
      ? Math.max(1, Math.floor(question.ballotSlot!.slotIndex))
      : index + 1,
    version: Number.isFinite(question.ballotSlot?.version)
      ? Math.max(1, Math.floor(question.ballotSlot!.version))
      : 1,
  };
}

function answerForQuestion(
  question: QuestionnaireDefinition["questions"][number],
  index: number,
): QuestionnaireResponseAnswer {
  return {
    questionId: question.questionId,
    answerType: "yes_no",
    value: index % 2 === 0,
  };
}

function makeEvent(input: {
  response: QuestionnaireBlindResponseEvent;
  createdAt: number;
  index: number;
}): NostrEvent {
  return {
    id: sha256Hex(`${input.response.responseId}:${input.index}`),
    kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
    pubkey: input.response.authorPubkey.startsWith("npub1")
      ? (nip19.decode(input.response.authorPubkey).data as string)
      : input.response.authorPubkey,
    created_at: input.createdAt,
    tags: [
      ["t", "questionnaire_response_blind"],
      ["q", input.response.questionnaireId],
      ["questionnaire", input.response.questionnaireId],
      ["schema", "1"],
      ["etype", "questionnaire_response_blind"],
      ["nullifier", input.response.tokenNullifier],
    ],
    content: JSON.stringify(input.response),
    sig: "0".repeat(128),
  };
}

async function main() {
  const voterCount = envInt("OPTIONA_SCOPED_BALLOT_SIM_VOTER_COUNT", 60);
  const questionCount = envInt("OPTIONA_SCOPED_BALLOT_SIM_QUESTION_COUNT", 20);
  const concurrency = envInt("OPTIONA_SCOPED_BALLOT_SIM_CONCURRENCY", 16);
  const fullCrypto = envBool("OPTIONA_SCOPED_BALLOT_SIM_FULL_CRYPTO", false);
  const expectedSubmissionCount = voterCount * questionCount;
  const questionnaireId = `q_scoped_load_${nodeCrypto.randomBytes(6).toString("hex")}`;
  const coordinator = makeNostrIdentity();
  const definition = makeDefinition({
    questionnaireId,
    questionCount,
    coordinatorHex: coordinator.hex,
  });
  const privateKey = fullCrypto ? await generateQuestionnaireBlindKeyPair() : null;
  const publicKey = privateKey ? toQuestionnaireBlindPublicKey(privateKey) : null;
  definition.blindSigningPublicKey = publicKey;
  const voters = Array.from({ length: voterCount }, makeNostrIdentity);
  const jobs = voters.flatMap((voter, voterIndex) => (
    definition.questions.map((question, questionIndex) => ({
      voter,
      voterIndex,
      question,
      questionIndex,
      ballotScope: ballotScopeForQuestion(question, questionIndex),
      answer: answerForQuestion(question, questionIndex),
    }))
  ));

  process.stdout.write(`Scoped ballot load simulation\n`);
  process.stdout.write(`Questionnaire: ${questionnaireId}\n`);
  process.stdout.write(`Voters: ${voterCount}\n`);
  process.stdout.write(`Questions: ${questionCount}\n`);
  process.stdout.write(`Separate submissions: ${expectedSubmissionCount}\n`);
  process.stdout.write(`Credential mode: ${fullCrypto ? "full blind RSA" : "synthetic verified proofs"}\n`);
  process.stdout.write(`Concurrency: ${Math.max(1, Math.min(concurrency, expectedSubmissionCount))}\n`);

  const startedAt = Date.now();
  let generatedSubmissionCount = 0;
  const entries = await runWithConcurrency(jobs, concurrency, async (job, index) => {
    const tokenSecret = nodeCrypto.randomBytes(32).toString("hex");
    const tokenCommitment = sha256Hex(tokenSecret);
    const blindTokenMessage = buildQuestionnaireBlindTokenSignedMessage({
      questionnaireId,
      tokenSecretCommitment: tokenCommitment,
      ballotScope: job.ballotScope,
    });
    const credential = privateKey && publicKey
      ? await (async () => {
        const blindedToken = await blindQuestionnaireToken({
          publicKey,
          message: blindTokenMessage,
        });
        const blindSignature = await signBlindedQuestionnaireToken({
          privateKey,
          blindedMessage: blindedToken.blindedMessage,
        });
        return await finalizeQuestionnaireBlindSignature({
          publicKey,
          message: blindTokenMessage,
          blindSignature,
          blindingFactor: blindedToken.blindingFactor,
        });
      })()
      : sha256Hex(JSON.stringify({
        mode: "synthetic_scoped_ballot_simulation",
        blindTokenMessage,
      }));
    const tokenNullifier = deriveQuestionnaireTokenNullifier({
      questionnaireId,
      tokenSecret,
      ballotScope: job.ballotScope,
    });
    const tokenProof = {
      tokenCommitment,
      questionnaireId,
      signature: credential,
      questionId: job.question.questionId,
      ballotScope: job.ballotScope,
    };
    const response: QuestionnaireBlindResponseEvent = {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId,
      responseId: randomId("submission"),
      submittedAt: Math.floor(startedAt / 1000) + index,
      authorPubkey: nip19.npubEncode(job.voter.hex),
      tokenNullifier,
      tokenNullifiers: [{
        questionId: job.question.questionId,
        tokenNullifier,
        ballotScope: job.ballotScope,
      }],
      tokenProof,
      tokenProofs: [tokenProof],
      answers: [job.answer],
    };
    const entry = {
      event: makeEvent({
        response,
        createdAt: response.submittedAt,
        index,
      }),
      response,
      voterIndex: job.voterIndex,
      questionId: job.question.questionId,
      tokenNullifier,
    };
    generatedSubmissionCount += 1;
    if (generatedSubmissionCount === expectedSubmissionCount || generatedSubmissionCount % 100 === 0) {
      process.stdout.write(`Generated scoped submission ${generatedSubmissionCount}/${expectedSubmissionCount}\n`);
    }
    return entry;
  });

  assert.equal(entries.length, expectedSubmissionCount);
  const nullifiers = new Set(entries.map((entry) => entry.tokenNullifier));
  assert.equal(nullifiers.size, expectedSubmissionCount, "each per-question submission should have a unique nullifier");

  const verifiedResponseIds = publicKey
    ? await (async () => {
      process.stdout.write(`Verifying ${expectedSubmissionCount} scoped token proof(s)...\n`);
      return await verifyQuestionnaireBlindResponseProofs({
        entries,
        publicKey,
      });
    })()
    : new Set(entries.map((entry) => entry.response.responseId));
  assert.equal(verifiedResponseIds.size, expectedSubmissionCount, "every per-question proof should verify");

  const admissions = evaluateQuestionnaireBlindAdmissions({
    entries,
    verifiedResponseIds,
  });
  assert.equal(admissions.accepted.length, expectedSubmissionCount);
  assert.equal(admissions.rejected.length, 0);

  const acceptedByQuestion = new Map<string, number>();
  for (const entry of admissions.accepted) {
    const answer = entry.response.answers?.[0];
    assert(answer, `accepted response ${entry.response.responseId} should contain one answer`);
    assert.equal(entry.response.answers?.length, 1, `accepted response ${entry.response.responseId} should contain exactly one answer`);
    acceptedByQuestion.set(answer.questionId, (acceptedByQuestion.get(answer.questionId) ?? 0) + 1);
  }
  for (const question of definition.questions) {
    assert.equal(acceptedByQuestion.get(question.questionId), voterCount, `expected ${voterCount} accepted submissions for ${question.questionId}`);
  }

  const duplicateSource = entries[0];
  const duplicateResponse = {
    ...duplicateSource.response,
    responseId: randomId("duplicate_submission"),
    submittedAt: duplicateSource.response.submittedAt + expectedSubmissionCount + 1,
  };
  const duplicateAdmissions = evaluateQuestionnaireBlindAdmissions({
    entries: [
      duplicateSource,
      {
        event: makeEvent({
          response: duplicateResponse,
          createdAt: duplicateResponse.submittedAt,
          index: expectedSubmissionCount + 1,
        }),
        response: duplicateResponse,
      },
    ],
    verifiedResponseIds: [
      duplicateSource.response.responseId,
      duplicateResponse.responseId,
    ],
  });
  assert.equal(duplicateAdmissions.accepted.length, 1);
  assert.equal(duplicateAdmissions.rejected.length, 1);
  assert.equal(duplicateAdmissions.rejected[0]?.rejectionReason, "duplicate_nullifier");

  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(`Accepted submissions: ${admissions.accepted.length}\n`);
  process.stdout.write(`Rejected submissions: ${admissions.rejected.length}\n`);
  process.stdout.write(`Verified proofs: ${verifiedResponseIds.size}\n`);
  process.stdout.write(`Unique nullifiers: ${nullifiers.size}\n`);
  process.stdout.write(`Per-question accepted count: ${voterCount} each\n`);
  process.stdout.write(`Duplicate nullifier probe: rejected\n`);
  process.stdout.write(`Elapsed: ${elapsedMs}ms\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

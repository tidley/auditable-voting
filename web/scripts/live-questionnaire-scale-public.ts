import { randomBytes } from "node:crypto";
import { finalizeEvent, getPublicKey, nip19, SimplePool, type EventTemplate, type NostrEvent } from "nostr-tools";
import {
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireResultSummary,
  fetchQuestionnaireSubmissionDecisions,
} from "../src/questionnaireTransport";
import { QUESTIONNAIRE_RESULT_SUMMARY_KIND } from "../src/questionnaireNostr";
import {
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
} from "../src/questionnaireResponsePublish";
import type { QuestionnaireResponseAnswer } from "../src/questionnaireProtocol";

type RelayResult = {
  relay: string;
  success: boolean;
  error?: string;
};

const DEFAULT_RELAYS = [
  "wss://vm-1734.lnvps.cloud/",
  "wss://relay.nostr.net",
  "wss://nos.lol",
];

function readInt(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function readRelays() {
  const raw = process.env.LIVE_SCALE_RELAYS?.trim();
  const relays = raw
    ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
    : DEFAULT_RELAYS;
  return Array.from(new Set(relays));
}

function makeSecretKey() {
  return Uint8Array.from(randomBytes(32));
}

function makeEvent(secretKey: Uint8Array, template: EventTemplate) {
  return finalizeEvent(template, secretKey) as NostrEvent;
}

function eventQuestionnaireId(event: NostrEvent) {
  return event.tags.find((tag) => tag[0] === "q")?.[1] ?? "";
}

function buildScaleEvents(input: {
  roundCount: number;
  voterCount: number;
  questionCount: number;
  proxyVoterCount: number;
  abcQuestionCount: number;
  runId: string;
  secretKey: Uint8Array;
}) {
  const coordinatorNpub = nip19.npubEncode(getPublicKey(input.secretKey));
  const proxyVoterCount = clampInt(input.proxyVoterCount, 0, input.voterCount);
  const submissionCount = input.voterCount + proxyVoterCount;
  const questionCount = Math.max(1, input.questionCount);
  const totalQuestionCount = questionCount + Math.max(0, input.abcQuestionCount);
  const roundIds = Array.from(
    { length: input.roundCount },
    (_, index) => `av_live_scale_${input.runId}_${String(index + 1).padStart(2, "0")}`,
  );
  let createdAt = Math.floor(Date.now() / 1000) - 5;
  const events: NostrEvent[] = [];

  for (const questionnaireId of roundIds) {
    for (let submissionIndex = 0; submissionIndex < submissionCount; submissionIndex += 1) {
      const voterIndex = submissionIndex % input.voterCount;
      const credentialIndex = submissionIndex >= input.voterCount ? 2 : 1;
      const responseId = `submission_${questionnaireId}_${String(submissionIndex + 1).padStart(3, "0")}`;
      const nullifier = `nullifier_${questionnaireId}_${String(submissionIndex + 1).padStart(3, "0")}`;
      const answers: QuestionnaireResponseAnswer[] = Array.from({ length: totalQuestionCount }, (_, questionIndex) => {
        const questionNumber = questionIndex + 1;
        if (questionIndex >= questionCount - 1) {
          const selectedOptionId = (["a", "b", "c"] as const)[(submissionIndex + questionIndex) % 3];
          return {
            questionId: `q${questionNumber}`,
            answerType: "multiple_choice",
            selectedOptionIds: [selectedOptionId],
          };
        }
        return {
          questionId: `q${questionNumber}`,
          answerType: "yes_no",
          value: (submissionIndex + questionIndex) % 2 === 0,
        };
      });
      events.push(makeEvent(input.secretKey, {
        kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
        created_at: createdAt--,
        tags: [
          ["t", "questionnaire_response_blind"],
          ["q", questionnaireId],
          ["questionnaire", questionnaireId],
          ["schema", "1"],
          ["etype", "questionnaire_response_blind"],
          ["nullifier", nullifier],
          ["test", "auditable-voting-live-scale"],
        ],
        content: JSON.stringify({
          schemaVersion: 1,
          eventType: "questionnaire_response_blind",
          questionnaireId,
          responseId,
          submittedAt: createdAt,
          authorPubkey: coordinatorNpub,
          tokenNullifier: nullifier,
          tokenProof: {
            tokenCommitment: `commitment_${responseId}_${credentialIndex}`,
            questionnaireId,
            signature: `live_scale_signature_${responseId}`,
          },
          answers,
          testMetadata: {
            voterIndex: voterIndex + 1,
            credentialIndex,
            proxyCredential: credentialIndex > 1,
          },
        }),
      }));
      events.push(makeEvent(input.secretKey, {
        kind: QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
        created_at: createdAt--,
        tags: [
          ["t", "questionnaire_submission_decision"],
          ["q", questionnaireId],
          ["questionnaire", questionnaireId],
          ["schema", "1"],
          ["etype", "questionnaire_submission_decision"],
          ["submission-id", responseId],
          ["nullifier", nullifier],
          ["accepted", "1"],
          ["reason", "accepted"],
          ["test", "auditable-voting-live-scale"],
        ],
        content: JSON.stringify({
          schemaVersion: 1,
          eventType: "questionnaire_submission_decision",
          questionnaireId,
          submissionId: responseId,
          tokenNullifier: nullifier,
          accepted: true,
          reason: "accepted",
          decidedAt: createdAt,
          coordinatorPubkey: coordinatorNpub,
        }),
      }));
    }

    events.push(makeEvent(input.secretKey, {
      kind: QUESTIONNAIRE_RESULT_SUMMARY_KIND,
      created_at: createdAt--,
      tags: [
        ["t", "questionnaire_result_summary"],
        ["q", questionnaireId],
        ["questionnaire-id", questionnaireId],
        ["test", "auditable-voting-live-scale"],
      ],
      content: JSON.stringify({
        schemaVersion: 1,
        eventType: "questionnaire_result_summary",
        questionnaireId,
        createdAt,
        coordinatorPubkey: coordinatorNpub,
        acceptedResponseCount: submissionCount,
        expectedEligibleVoterCount: input.voterCount,
        proxyVoterCount,
        rejectedResponseCount: 0,
        acceptedNullifierCount: submissionCount,
        questionSummaries: Array.from({ length: totalQuestionCount }, (_, questionIndex) => ({
          questionId: `q${questionIndex + 1}`,
          answerType: questionIndex >= questionCount - 1 ? "multiple_choice" : "yes_no",
        })),
      }),
    }));
  }

  return { roundIds, events, submissionCount, totalQuestionCount };
}

function answerDistribution(events: NostrEvent[], questionId: string) {
  const counts = { a: 0, b: 0, c: 0, missing: 0 };
  for (const event of events) {
    const parsed = JSON.parse(event.content) as { answers?: QuestionnaireResponseAnswer[] };
    const answer = parsed.answers?.find((entry) => entry.questionId === questionId);
    if (answer?.answerType !== "multiple_choice") {
      counts.missing += 1;
      continue;
    }
    const selected = answer.selectedOptionIds[0];
    if (selected === "a" || selected === "b" || selected === "c") {
      counts[selected] += 1;
    } else {
      counts.missing += 1;
    }
  }
  return counts;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function publishEvent(pool: SimplePool, relays: string[], event: NostrEvent, maxWaitMs: number) {
  const settled = await Promise.allSettled(
    relays.map(async (relay) => {
      await pool.publish([relay], event, { maxWait: maxWaitMs })[0];
      return relay;
    }),
  );
  return settled.map((result, index): RelayResult => (
    result.status === "fulfilled"
      ? { relay: relays[index], success: true }
      : {
          relay: relays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));
}

function summarizePublishResults(results: RelayResult[][]) {
  const byRelay = new Map<string, { successes: number; failures: number; sampleErrors: string[] }>();
  for (const eventResults of results) {
    for (const result of eventResults) {
      const entry = byRelay.get(result.relay) ?? { successes: 0, failures: 0, sampleErrors: [] };
      if (result.success) {
        entry.successes += 1;
      } else {
        entry.failures += 1;
        if (entry.sampleErrors.length < 5 && result.error) {
          entry.sampleErrors.push(result.error);
        }
      }
      byRelay.set(result.relay, entry);
    }
  }
  return Object.fromEntries(byRelay.entries());
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const roundCount = readInt("LIVE_SCALE_ROUNDS", 30);
  const voterCount = readInt("LIVE_SCALE_VOTERS", 100);
  const questionCount = readInt("LIVE_SCALE_QUESTIONS", 1);
  const proxyVoterCount = readInt("LIVE_SCALE_PROXY_VOTERS", 0);
  const abcQuestionCount = readInt("LIVE_SCALE_ABC_EXTRA_QUESTIONS", 0);
  const publishConcurrency = readInt("LIVE_SCALE_PUBLISH_CONCURRENCY", 4);
  const publishMaxWaitMs = readInt("LIVE_SCALE_PUBLISH_MAX_WAIT_MS", 4_000);
  const readbackWaitMs = readInt("LIVE_SCALE_READBACK_WAIT_MS", 8_000);
  const readbackTimeBudgetMs = readInt("LIVE_SCALE_READBACK_TIME_BUDGET_MS", 20_000);
  const readbackMaxPages = readInt("LIVE_SCALE_READBACK_MAX_PAGES", 16);
  const relays = readRelays();
  const runId = process.env.LIVE_SCALE_RUN_ID?.trim()
    || `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomBytes(3).toString("hex")}`;
  const secretKey = makeSecretKey();
  const pool = new SimplePool({ enablePing: true, enableReconnect: true });
  const { roundIds, events, submissionCount, totalQuestionCount } = buildScaleEvents({
    roundCount,
    voterCount,
    questionCount,
    proxyVoterCount,
    abcQuestionCount,
    runId,
    secretKey,
  });
  const selectedRound = roundIds[Math.min(20, roundIds.length - 1)];
  const finalQuestionId = `q${questionCount}`;

  process.stdout.write(JSON.stringify({
    phase: "start",
    runId,
    relays,
    roundCount,
    voterCount,
    proxyVoterCount: clampInt(proxyVoterCount, 0, voterCount),
    expectedSubmissionsPerQuestionnaire: submissionCount,
    questionCount,
    abcQuestionCount,
    totalQuestionCount,
    selectedRound,
    eventCount: events.length,
    publishConcurrency,
  }, null, 2) + "\n");

  const startedAt = Date.now();
  const publishResults = await mapWithConcurrency(
    events,
    publishConcurrency,
    async (event, index) => {
      const result = await publishEvent(pool, relays, event, publishMaxWaitMs);
      if ((index + 1) % 250 === 0 || index + 1 === events.length) {
        process.stdout.write(JSON.stringify({
          phase: "publish_progress",
          publishedEventsAttempted: index + 1,
          eventCount: events.length,
        }) + "\n");
      }
      return result;
    },
  );
  const publishElapsedMs = Date.now() - startedAt;
  const acceptedEvents = events.filter((_, index) => publishResults[index].some((result) => result.success));
  const selectedAcceptedEvents = acceptedEvents.filter((event) => eventQuestionnaireId(event) === selectedRound);
  const selectedAcceptedResponses = selectedAcceptedEvents.filter((event) => event.kind === QUESTIONNAIRE_RESPONSE_BLIND_KIND);

  process.stdout.write(JSON.stringify({
    phase: "publish_complete",
    publishElapsedMs,
    attemptedEvents: events.length,
    acceptedEvents: acceptedEvents.length,
    selectedRoundAcceptedEvents: selectedAcceptedEvents.length,
    selectedRoundFinalQuestionDistribution: answerDistribution(selectedAcceptedResponses, finalQuestionId),
    publishByRelay: summarizePublishResults(publishResults),
  }, null, 2) + "\n");

  await sleep(readbackWaitMs);
  const readStartedAt = Date.now();
  const [responses, decisions, results] = await Promise.all([
    fetchQuestionnaireBlindResponses({
      questionnaireId: selectedRound,
      relays,
      limit: submissionCount + 50,
      readRelayLimit: relays.length,
      maxPages: readbackMaxPages,
      timeBudgetMs: readbackTimeBudgetMs,
    }),
    fetchQuestionnaireSubmissionDecisions({
      questionnaireId: selectedRound,
      relays,
      limit: submissionCount + 50,
      readRelayLimit: relays.length,
      maxPages: readbackMaxPages,
      timeBudgetMs: readbackTimeBudgetMs,
    }),
    fetchQuestionnaireResultSummary({
      questionnaireId: selectedRound,
      relays,
      limit: 20,
      readRelayLimit: relays.length,
      maxPages: readbackMaxPages,
      timeBudgetMs: readbackTimeBudgetMs,
    }),
  ]);
  const readElapsedMs = Date.now() - readStartedAt;
  const readbackEvents = responses.map((entry) => entry.event);

  process.stdout.write(JSON.stringify({
    phase: "readback_complete",
    runId,
    selectedRound,
    readElapsedMs,
    expectedResponses: submissionCount,
    responses: responses.length,
    decisions: decisions.length,
    results: results.length,
    finalQuestionDistribution: answerDistribution(readbackEvents, finalQuestionId),
    passed: responses.length === submissionCount && decisions.length === submissionCount && results.length >= 1,
  }, null, 2) + "\n");

  pool.destroy();
  process.exit(0);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});

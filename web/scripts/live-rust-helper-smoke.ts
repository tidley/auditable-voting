import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  generateSecretKey,
  getPublicKey,
  nip19,
  type NostrEvent,
} from "nostr-tools";
import { buildQuestionnaireBlindTokenSignedMessage, deriveQuestionnaireTokenNullifier } from "../src/questionnaireBlindToken";
import {
  blindQuestionnaireToken,
  finalizeQuestionnaireBlindSignature,
  generateQuestionnaireBlindKeyPair,
  toQuestionnaireBlindPublicKey,
  verifyQuestionnaireBlindSignature,
} from "../src/questionnaireBlindSignature";
import {
  fetchOptionABlindIssuanceDmsWithNsec,
  fetchOptionAWorkerElectionConfigDmsWithNsec,
  publishOptionABlindRequestBundleDm,
  publishOptionABlindRequestDm,
  publishOptionAWorkerElectionConfigDm,
  type WorkerElectionConfigSnapshot,
} from "../src/questionnaireOptionABlindDm";
import type { BallotScope, BlindBallotIssuance, BlindBallotRequest, ElectionInviteMessage } from "../src/questionnaireOptionA";
import { publishOptionAInviteDm } from "../src/questionnaireOptionAInviteDm";
import { buildInviteUrl } from "../src/questionnaireInvite";
import { buildQuestionnaireDefinitionReference, questionnaireDefinitionEventHash } from "../src/questionnaireDefinitionReference";
import {
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  publishQuestionnaireDefinition,
  publishQuestionnaireParticipantCount,
  publishQuestionnaireState,
} from "../src/questionnaireNostr";
import {
  allowedScopesForRequiredScope,
  questionRequiredScope,
  type QuestionnaireDefinition,
  type QuestionnaireResponseAnswer,
  type QuestionnaireResultSummary,
} from "../src/questionnaireProtocol";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
} from "../src/questionnaireProtocolConstants";
import {
  fetchQuestionnaireActiveWorkerDelegationForCapability,
  fetchQuestionnaireBlindResponses,
  fetchQuestionnaireSubmissionDecisions,
  evaluateQuestionnaireBlindAdmissions,
} from "../src/questionnaireTransport";
import { publishQuestionnaireBlindResponsePublic } from "../src/questionnaireResponsePublish";
import {
  parseQuestionnaireBlindResponseEvent,
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
} from "../src/questionnaireResponsePublish";
import { createWorkerDelegationCertificate, publishWorkerDelegationCertificate } from "../src/questionnaireWorkerDelegation";
import { buildIssueBlindTokensWorkerRouting } from "../src/questionnaireWorkerRouting";
import { getSharedNostrPool } from "../src/sharedNostrPool";
import { SIMPLE_PUBLIC_RELAYS } from "../src/simpleVotingSession";
import type { SignerService } from "../src/services/signerService";
import { normalizeRelaysRust } from "../src/wasm/auditableVotingCore";

type HelperElectionState = {
  expected_invitee_count?: number | null;
  seen_blind_request_ids?: string[];
  processed_submission_ids?: string[];
  published_decisions?: Record<string, string>;
  accepted_nullifiers?: string[];
  summary_published?: boolean;
  last_blind_issuance_at?: string | null;
  last_result_summary_publish_at?: string | null;
  blind_signing_private_key?: unknown;
  definition?: unknown;
};

type HelperPersistentState = {
  elections?: Record<string, HelperElectionState>;
};

type LiveRustHelperSubmissionMode = "bundled" | "per_question";

type LiveRustHelperSubmissionJob = {
  voter: ReturnType<typeof makeNostrIdentity>;
  voterIndex: number;
  questionIndex: number | null;
  answers: QuestionnaireResponseAnswer[];
  ballotScope: BallotScope | null;
};

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

function envIntAllowZero(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function randomDelayMs(minMs: number, maxMs: number) {
  const lower = Math.max(0, Math.floor(minMs));
  const upper = Math.max(lower, Math.floor(maxMs));
  if (upper <= lower) {
    return lower;
  }
  return nodeCrypto.randomInt(lower, upper + 1);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
) {
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index], index);
    }
  }));
}

async function withTimeout<T>(label: string, task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function randomId(prefix: string) {
  const entropy = nodeCrypto.randomBytes(8).toString("hex");
  return `${prefix}_${entropy}`;
}

function sha256Hex(value: string) {
  return nodeCrypto.createHash("sha256").update(value).digest("hex");
}

function buildRelays() {
  const raw = process.env.OPTIONA_LIVE_RUST_HELPER_RELAYS?.trim();
  const relays = raw
    ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
    : SIMPLE_PUBLIC_RELAYS.slice(0, 4);
  return normalizeRelaysRust(relays);
}

function envBool(name: string, fallback: boolean) {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function envScopedSubmissionSchedule(name: string) {
  const value = (process.env[name] ?? "").trim().toLowerCase().replace(/-/g, "_");
  return value === "question_waves" || value === "waves" || value === "by_question"
    ? "question_waves"
    : "voter_batches";
}

function envSubmissionMode(name: string, fallback: LiveRustHelperSubmissionMode): LiveRustHelperSubmissionMode {
  const value = (process.env[name] ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (value === "per_question" || value === "scoped" || value === "separate") {
    return "per_question";
  }
  if (value === "bundled" || value === "bundle" || value === "single") {
    return "bundled";
  }
  return fallback;
}

function makeNostrIdentity() {
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  return {
    secretKey,
    hex: publicKey,
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
  attemptTimeoutMs = Math.max(10_000, intervalMs * 2),
  assertContinue: () => void = () => {},
) {
  const startedAt = Date.now();
  let lastError: unknown = null;
  while (Date.now() - startedAt < timeoutMs) {
    assertContinue();
    try {
      const value = await withTimeout(`${label} attempt`, task(), attemptTimeoutMs);
      assertContinue();
      if (isReady(value)) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
    assertContinue();
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
  baseQuestionCount: number;
  restrictedQuestionGroupCount: number;
  perQuestionCredentials: boolean;
}): QuestionnaireDefinition {
  const now = Math.floor(Date.now() / 1000);
  const baseQuestionCount = Math.max(1, Math.floor(input.baseQuestionCount));
  const restrictedQuestionGroupCount = Math.max(0, Math.floor(input.restrictedQuestionGroupCount));
  const questionCount = baseQuestionCount + restrictedQuestionGroupCount;
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    protocolVersion: 2,
    flowMode: QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: input.questionnaireId,
    title: "Live Rust delegate coordinator smoke",
    description: "Opt-in public-relay smoke test for the spawned Rust delegate coordinator",
    createdAt: now,
    openAt: now - 30,
    closeAt: now + 900,
    coordinatorPubkey: input.coordinatorNpub,
    coordinatorEncryptionPubkey: input.coordinatorNpub,
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    ...(input.perQuestionCredentials ? { ballotCredentialMode: "per_question" as const } : {}),
    blindSigningPublicKey: input.blindSigningPublicKey,
    voterGroups: Array.from({ length: restrictedQuestionGroupCount }, (_, index) => ({
      id: `group_${String(index + 1).padStart(3, "0")}`,
      label: `Harness group ${index + 1}`,
    })),
    questions: Array.from({ length: questionCount }, (_, index) => {
      const ballotGroup = ballotGroupForQuestionIndex(index, baseQuestionCount);
      return {
        questionId: `q${index + 1}`,
        prompt: `Live proxy harness question ${index + 1}`,
        required: true,
        type: "yes_no",
        ...(ballotGroup ? { requiredScope: ballotGroup, ballotGroup } : {}),
        ...(input.perQuestionCredentials
          ? { ballotSlot: { slotId: `q${index + 1}`, slotIndex: index + 1, version: 1 } }
          : {}),
      };
    }),
  };
}

function ballotScopeForQuestion(
  question: QuestionnaireDefinition["questions"][number],
  index: number,
  credentialIndex = 1,
): BallotScope {
  const requiredScope = questionRequiredScope(question);
  return {
    questionId: question.questionId,
    slotId: question.ballotSlot?.slotId?.trim() || question.questionId,
    slotIndex: Number.isFinite(question.ballotSlot?.slotIndex)
      ? Math.max(1, Math.floor(question.ballotSlot!.slotIndex))
      : index + 1,
    version: Number.isFinite(question.ballotSlot?.version)
      ? Math.max(1, Math.floor(question.ballotSlot!.version))
      : 1,
    ...(requiredScope ? { allowedScopes: allowedScopesForRequiredScope(requiredScope), ballotGroup: requiredScope } : {}),
    ...(credentialIndex > 1 ? { credentialIndex } : {}),
  };
}

function ballotScopeForQuestionnaireCredential(credentialIndex: number, ballotGroup?: string | null): BallotScope | null {
  const allowedScopes = allowedScopesForRequiredScope(ballotGroup);
  const scope: BallotScope = {
    allowedScopes,
    ...(ballotGroup ? { ballotGroup } : {}),
    ...(credentialIndex > 1 ? { credentialIndex } : {}),
  };
  return Object.keys(scope).length > 0 ? scope : null;
}

function answerForQuestion(
  question: QuestionnaireDefinition["questions"][number],
  index: number,
): QuestionnaireResponseAnswer {
  if (question.type !== "yes_no") {
    throw new Error(`live Rust helper only generates yes/no answers; got ${question.type}`);
  }
  return {
    questionId: question.questionId,
    answerType: "yes_no",
    value: index % 2 === 0,
  };
}

function resolveWorkerBinary() {
  const override = process.env.OPTIONA_LIVE_RUST_HELPER_BINARY?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), "..", "worker", "target", "debug", "auditable-voting-worker");
}

function scopedEligibleVoterIndexes(input: {
  questionIndex: number;
  baseQuestionCount: number;
  voterCount: number;
  restrictedQuestionGroupCount: number;
  restrictedEligibleCount: number;
}) {
  if (input.questionIndex < input.baseQuestionCount || input.restrictedQuestionGroupCount <= 0) {
    return Array.from({ length: input.voterCount }, (_, index) => index);
  }
  const groupIndex = input.questionIndex - input.baseQuestionCount;
  const start = (groupIndex * input.restrictedEligibleCount) % input.voterCount;
  return Array.from({ length: Math.min(input.restrictedEligibleCount, input.voterCount) }, (_, offset) => (
    (start + offset) % input.voterCount
  ));
}

function ballotGroupForQuestionIndex(questionIndex: number, baseQuestionCount: number) {
  if (questionIndex < baseQuestionCount) {
    return null;
  }
  const groupIndex = questionIndex - baseQuestionCount;
  return `group_${String(groupIndex + 1).padStart(3, "0")}`;
}

function ballotGroupForVoterIndex(input: {
  voterIndex: number;
  baseQuestionCount: number;
  voterCount: number;
  restrictedQuestionGroupCount: number;
  restrictedEligibleCount: number;
}) {
  for (let groupIndex = 0; groupIndex < input.restrictedQuestionGroupCount; groupIndex += 1) {
    const questionIndex = input.baseQuestionCount + groupIndex;
    const eligible = scopedEligibleVoterIndexes({
      questionIndex,
      baseQuestionCount: input.baseQuestionCount,
      voterCount: input.voterCount,
      restrictedQuestionGroupCount: input.restrictedQuestionGroupCount,
      restrictedEligibleCount: input.restrictedEligibleCount,
    });
    if (eligible.includes(input.voterIndex)) {
      return ballotGroupForQuestionIndex(questionIndex, input.baseQuestionCount);
    }
  }
  return null;
}

function scopedCredentialIndexes(voterIndex: number, proxyVoterCount: number) {
  return voterIndex < proxyVoterCount ? [1, 2] : [1];
}

async function queryDecisionEvents(input: {
  relays: string[];
  workerHex: string;
  questionnaireId: string;
  limit?: number;
  readRelayLimit?: number;
}) {
  const limit = input.limit ?? 100;
  const pool = getSharedNostrPool();
  const directEvents = await withTimeout("submission decision author relay query", pool.querySync(input.relays, {
    authors: [input.workerHex],
    kinds: [QUESTIONNAIRE_SUBMISSION_DECISION_KIND],
    "#q": [input.questionnaireId],
    limit,
  }), 10_000).catch(() => [] as NostrEvent[]);
  if (directEvents.length > 0) {
    return directEvents;
  }

  const entries = await withTimeout(
    "submission decision relay query",
    fetchQuestionnaireSubmissionDecisions({
      questionnaireId: input.questionnaireId,
      relays: input.relays,
      limit,
      readRelayLimit: input.readRelayLimit,
      maxPages: Math.max(1, Math.ceil(limit / 500) + 2),
      timeBudgetMs: 20_000,
    }),
    25_000,
  );
  return [...new Map([...directEvents, ...entries
    .filter((entry) => entry.event.pubkey === input.workerHex)
    .map((entry) => entry.event)].map((event) => [event.id, event])).values()];
}

async function queryBlindResponseEntries(input: {
  relays: string[];
  questionnaireId: string;
  limit?: number;
  readRelayLimit?: number;
}) {
  const limit = input.limit ?? 200;
  const pool = getSharedNostrPool();
  const directEvents = await withTimeout("blind response q relay query", pool.querySync(input.relays, {
    kinds: [QUESTIONNAIRE_RESPONSE_BLIND_KIND],
    "#q": [input.questionnaireId],
    limit,
  }), 10_000).catch(() => [] as NostrEvent[]);
  const directEntries = directEvents
    .map((event) => ({ event, response: parseQuestionnaireBlindResponseEvent(event.content) }))
    .filter((entry) => entry.response?.questionnaireId === input.questionnaireId)
    .filter((entry): entry is NonNullable<typeof entry> & { response: NonNullable<typeof entry.response> } => Boolean(entry.response));
  if (directEntries.length > 0) {
    return directEntries;
  }

  return await withTimeout(
    "blind response relay query",
    fetchQuestionnaireBlindResponses({
      questionnaireId: input.questionnaireId,
      relays: input.relays,
      readRelayLimit: input.readRelayLimit,
      preferKindOnly: true,
      limit,
      maxPages: Math.max(16, Math.ceil(limit / 500) + 2),
      timeBudgetMs: 20_000,
    }),
    25_000,
  );
}

async function querySummaryEvents(relays: string[], workerHex: string) {
  const pool = getSharedNostrPool();
  return await withTimeout("result summary relay query", pool.querySync(relays, {
    authors: [workerHex],
    kinds: [QUESTIONNAIRE_RESULT_SUMMARY_KIND],
    limit: 50,
  }), 10_000);
}

async function waitForWorkerStartup(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
  const logs: string[] = [];
  return await new Promise<{ logs: string[] }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`worker startup timed out after ${timeoutMs}ms\n${logs.join("")}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logs.push(text);
      process.stdout.write(`[rust-helper] ${text}`);
      if (logs.join("").includes("worker started as")) {
        clearTimeout(timer);
        cleanup();
        resolve({ logs });
      }
    };

    const onErrorData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      logs.push(text);
      process.stderr.write(`[rust-helper] ${text}`);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      cleanup();
      reject(new Error(`worker exited before startup completed (code=${code}, signal=${signal})\n${logs.join("")}`));
    };

    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.on("exit", onExit);
  });
}

function attachWorkerLogCapture(child: ChildProcessWithoutNullStreams) {
  const lines: string[] = [];
  const onStdout = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    lines.push(text);
    process.stdout.write(`[rust-helper] ${text}`);
  };
  const onStderr = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    lines.push(text);
    process.stderr.write(`[rust-helper] ${text}`);
  };
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  return {
    lines,
    detach() {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
    },
  };
}

function watchWorkerExit(child: ChildProcessWithoutNullStreams) {
  let exitError: Error | null = null;
  let stopping = false;
  let expectedExitAllowed = false;
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
      if (stopping || (expectedExitAllowed && code === 0)) {
        return;
      }
      exitError = new Error(`Rust helper exited unexpectedly (code=${code}, signal=${signal})`);
      process.stderr.write(`${exitError.message}\n`);
    });
  });
  return {
    assertRunning() {
      if (exitError) {
        throw exitError;
      }
    },
    markStopping() {
      stopping = true;
    },
    allowExpectedExit() {
      expectedExitAllowed = true;
    },
    async waitForExpectedExit(timeoutMs: number) {
      expectedExitAllowed = true;
      const exit = await withTimeout("Rust helper completion exit", exitPromise, timeoutMs);
      assert.equal(exit.code, 0, `expected Rust helper to exit cleanly after completion, signal=${exit.signal}`);
    },
  };
}

async function readHelperState(stateDir: string): Promise<HelperPersistentState | null> {
  try {
    const raw = await fs.readFile(path.join(stateDir, "state.json"), "utf8");
    return JSON.parse(raw) as HelperPersistentState;
  } catch {
    return null;
  }
}

function getHelperElectionState(
  state: HelperPersistentState | null,
  questionnaireId: string,
): HelperElectionState | null {
  return state?.elections?.[questionnaireId] ?? null;
}

async function terminateProcess(child: ChildProcessWithoutNullStreams) {
  if (child.killed || child.exitCode !== null) {
    return;
  }
  const isAlive = () => {
    if (!child.pid || child.exitCode !== null) {
      return false;
    }
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  child.kill("SIGTERM");
  const startedAt = Date.now();
  while (isAlive() && Date.now() - startedAt < 5_000) {
    await sleep(100);
  }
  if (isAlive()) {
    child.kill("SIGKILL");
    const killStartedAt = Date.now();
    while (isAlive() && Date.now() - killStartedAt < 5_000) {
      await sleep(100);
    }
  }
}

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("Global WebSocket is not available in this Node runtime.");
  }

  const relays = buildRelays();
  const timeoutMs = envInt("OPTIONA_LIVE_RUST_HELPER_TIMEOUT_MS", 180_000);
  const intervalMs = envInt("OPTIONA_LIVE_RUST_HELPER_POLL_MS", 4_000);
  const readRelayLimit = envInt("OPTIONA_LIVE_RUST_HELPER_READ_RELAY_LIMIT", Math.min(6, relays.length));
  const configRetryLimit = envInt("OPTIONA_LIVE_RUST_HELPER_CONFIG_RETRY_LIMIT", 3);
  const requestRetryLimit = envInt("OPTIONA_LIVE_RUST_HELPER_REQUEST_RETRY_LIMIT", 3);
  const voterCount = envInt("OPTIONA_LIVE_RUST_HELPER_VOTER_COUNT", 1);
  const baseQuestionCount = envInt("OPTIONA_LIVE_RUST_HELPER_QUESTION_COUNT", 1);
  const restrictedQuestionGroupCount = envInt("OPTIONA_LIVE_RUST_HELPER_RESTRICTED_QUESTION_GROUPS", 0);
  const restrictedEligibleCount = envInt("OPTIONA_LIVE_RUST_HELPER_RESTRICTED_ELIGIBLE_COUNT", Math.max(1, Math.floor(voterCount / 3)));
  const proxyVoterCount = Math.min(voterCount, envInt("OPTIONA_LIVE_RUST_HELPER_PROXY_VOTER_COUNT", 0));
  const privateInviteMode = envBool("OPTIONA_LIVE_RUST_HELPER_PRIVATE_INVITES", false);
  const questionCount = baseQuestionCount + restrictedQuestionGroupCount;
  const submissionMode = envSubmissionMode("OPTIONA_LIVE_RUST_HELPER_SUBMISSION_MODE", "bundled");
  const perQuestionSubmissions = submissionMode === "per_question";
  const scopedSubmissionSchedule = envScopedSubmissionSchedule("OPTIONA_LIVE_RUST_HELPER_SCOPED_SUBMISSION_SCHEDULE");
  const preissueScopedCredentials = perQuestionSubmissions
    && envBool("OPTIONA_LIVE_RUST_HELPER_PREISSUE_SCOPED_CREDENTIALS", false);
  const requestRetryWaitMs = envInt(
    "OPTIONA_LIVE_RUST_HELPER_REQUEST_RETRY_WAIT_MS",
    perQuestionSubmissions ? Math.max(intervalMs, 30_000) : intervalMs,
  );
  const defaultDelegationTtlMs = perQuestionSubmissions
    ? Math.max(30 * 60_000, voterCount * questionCount * 2_000)
    : 10 * 60_000;
  const delegationTtlMs = envInt("OPTIONA_LIVE_RUST_HELPER_DELEGATION_TTL_MS", defaultDelegationTtlMs);
  const inviteConcurrency = envInt("OPTIONA_LIVE_RUST_HELPER_INVITE_CONCURRENCY", Math.min(5, voterCount));
  const responseDelayMinMs = envInt(
    "OPTIONA_LIVE_RUST_HELPER_RESPONSE_DELAY_MIN_MS",
    perQuestionSubmissions ? 0 : 5_000,
  );
  const responseDelayMaxMs = Math.max(
    responseDelayMinMs,
    envIntAllowZero("OPTIONA_LIVE_RUST_HELPER_RESPONSE_DELAY_MAX_MS", perQuestionSubmissions ? 250 : 30_000),
  );
  const submissionConcurrency = envInt(
    "OPTIONA_LIVE_RUST_HELPER_SUBMISSION_CONCURRENCY",
    perQuestionSubmissions ? 12 : 1,
  );
  const expectWorkerExit = envBool("OPTIONA_LIVE_RUST_HELPER_EXPECT_WORKER_EXIT", false);
  const inviteBaseUrl = process.env.OPTIONA_LIVE_RUST_HELPER_INVITE_BASE_URL?.trim()
    || "https://auditable-voting.pages.dev/";
  const requireRelayReadback = envBool("OPTIONA_LIVE_RUST_HELPER_REQUIRE_RELAY_READBACK", false);
  const waveRelayReadback = envBool("OPTIONA_LIVE_RUST_HELPER_WAVE_RELAY_READBACK", false);
  const fastPublicPublish = envBool("OPTIONA_LIVE_RUST_HELPER_FAST_PUBLIC_PUBLISH", false);
  const responsePublishRetryLimit = envInt(
    "OPTIONA_LIVE_RUST_HELPER_RESPONSE_PUBLISH_RETRY_LIMIT",
    fastPublicPublish ? 3 : 1,
  );
  const workerBinary = resolveWorkerBinary();
  const workerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "auditable-voting-worker-live-"));

  const coordinator = makeNostrIdentity();
  const worker = makeNostrIdentity();
  const voters = Array.from({ length: voterCount }, () => makeNostrIdentity());
  const privateInviteHashesByNpub = new Map(
    voters.map((voter) => [voter.npub, sha256Hex(nodeCrypto.randomBytes(32).toString("hex"))]),
  );
  const voterBallotGroups = voters.map((_, voterIndex) => ballotGroupForVoterIndex({
    voterIndex,
    baseQuestionCount,
    voterCount: voters.length,
    restrictedQuestionGroupCount,
    restrictedEligibleCount,
  }));
  const ballotGroupsByNpub: Record<string, string> = {};
  voters.forEach((voter, index) => {
    const ballotGroup = voterBallotGroups[index];
    if (ballotGroup) {
      ballotGroupsByNpub[voter.npub] = ballotGroup;
    }
  });
  const questionnaireId = `q_live_rust_helper_${nodeCrypto.randomBytes(8).toString("hex")}`;
  const blindSigningPrivateKey = await generateQuestionnaireBlindKeyPair();
  const blindSigningPublicKey = toQuestionnaireBlindPublicKey(blindSigningPrivateKey);
  const definition = buildDefinition({
    questionnaireId,
    coordinatorNpub: coordinator.npub,
    blindSigningPublicKey,
    baseQuestionCount,
    restrictedQuestionGroupCount,
    perQuestionCredentials: perQuestionSubmissions,
  });
  const expectedSubmissionCount = perQuestionSubmissions
    ? definition.questions.reduce((total, _question, questionIndex) => {
      const eligibleIndexes = scopedEligibleVoterIndexes({
        questionIndex,
        baseQuestionCount,
        voterCount: voters.length,
        restrictedQuestionGroupCount,
        restrictedEligibleCount,
      });
      return total + eligibleIndexes.reduce((questionTotal, voterIndex) => (
        questionTotal + scopedCredentialIndexes(voterIndex, proxyVoterCount).length
      ), 0);
    }, 0)
    : voters.length + proxyVoterCount;

  process.stdout.write(`Live Rust helper smoke\n`);
  process.stdout.write(`Questionnaire: ${questionnaireId}\n`);
  process.stdout.write(`Coordinator: ${coordinator.npub}\n`);
  process.stdout.write(`Audit proxy: ${worker.npub}\n`);
  process.stdout.write(`Voters: ${voters.length}\n`);
  process.stdout.write(`Questions: ${definition.questions.length}\n`);
  process.stdout.write(`Base questions: ${baseQuestionCount}\n`);
  process.stdout.write(`Restricted question groups: ${restrictedQuestionGroupCount} x ${Math.min(restrictedEligibleCount, voters.length)} eligible voter(s)\n`);
  process.stdout.write(`Proxy voters: ${proxyVoterCount}\n`);
  process.stdout.write(`Submission mode: ${submissionMode}\n`);
  if (perQuestionSubmissions) {
    process.stdout.write(`Scoped submission schedule: ${scopedSubmissionSchedule}\n`);
    process.stdout.write(`Pre-issue scoped credentials: ${preissueScopedCredentials ? "yes" : "no"}\n`);
  }
  process.stdout.write(`Expected submissions: ${expectedSubmissionCount}\n`);
  process.stdout.write(`First voter: ${voters[0]?.npub ?? "none"}\n`);
  process.stdout.write(`Bulk invite concurrency: ${Math.max(1, Math.min(inviteConcurrency, voters.length))}\n`);
  process.stdout.write(`Submission concurrency: ${Math.max(1, Math.min(submissionConcurrency, expectedSubmissionCount))}\n`);
  process.stdout.write(`Submission start delay: ${responseDelayMinMs}-${responseDelayMaxMs}ms\n`);
  process.stdout.write(`Fast public publish: ${fastPublicPublish ? "yes" : "no"}\n`);
  process.stdout.write(`Question wave relay readback: ${waveRelayReadback ? "yes" : "no"}\n`);
  process.stdout.write(`Response publish retry limit: ${responsePublishRetryLimit}\n`);
  process.stdout.write(`Binary: ${workerBinary}\n`);
  process.stdout.write(`State dir: ${workerStateDir}\n`);
  process.stdout.write(`Relays: ${relays.join(", ")}\n`);

  const workerProcess = spawn(workerBinary, [], {
    cwd: path.dirname(workerBinary),
    env: {
      ...process.env,
      RUST_LOG: process.env.RUST_LOG ?? "info",
      WORKER_NSEC: worker.nsec,
      COORDINATOR_NPUB: coordinator.npub,
      WORKER_RELAYS: relays.join(","),
      WORKER_STATE_DIR: workerStateDir,
      WORKER_POLL_SECONDS: process.env.OPTIONA_LIVE_RUST_HELPER_WORKER_POLL_SECONDS ?? "5",
      WORKER_HEARTBEAT_SECONDS: "10",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let startupLogs = "";
  const liveWorkerLogs = attachWorkerLogCapture(workerProcess);
  const workerExit = watchWorkerExit(workerProcess);
  try {
    const started = await waitForWorkerStartup(workerProcess, 20_000);
    startupLogs = started.logs.join("");

    const publishedDefinition = await publishQuestionnaireDefinition({
      coordinatorNsec: coordinator.nsec,
      definition,
      relays,
    });
    assert(publishedDefinition.successes > 0, "expected questionnaire definition publish to succeed on at least one relay");
    const definitionReference = buildQuestionnaireDefinitionReference({
      definition,
      definitionEventId: publishedDefinition.eventId,
      definitionHash: questionnaireDefinitionEventHash(publishedDefinition.event.content),
      relays,
    });

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

    const publishedParticipantCount = await publishQuestionnaireParticipantCount({
      coordinatorNsec: coordinator.nsec,
      participantCount: {
        schemaVersion: 1,
        eventType: "questionnaire_participant_count",
        questionnaireId,
        expectedInviteeCount: voters.length,
        createdAt: Math.floor(Date.now() / 1000),
        coordinatorPubkey: coordinator.npub,
      },
      relays,
    });
    assert(publishedParticipantCount.successes > 0, "expected questionnaire participant count publish to succeed on at least one relay");

    const delegation = createWorkerDelegationCertificate({
      electionId: questionnaireId,
      coordinatorNpub: coordinator.npub,
      workerNpub: worker.npub,
      capabilities: [
        "issue_blind_tokens",
        "verify_public_submissions",
        "publish_submission_decisions",
        "close_questionnaire",
        "publish_result_summary",
      ],
      controlRelays: relays,
      expiresAt: new Date(Date.now() + delegationTtlMs).toISOString(),
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
      undefined,
      () => workerExit.assertRunning(),
    );
    assert.equal(visibleDelegation?.workerNpub, worker.npub);

    const configSnapshot: WorkerElectionConfigSnapshot = {
      type: "worker_election_config",
      schemaVersion: 1,
      electionId: questionnaireId,
      delegationId: delegation.delegationId,
      coordinatorNpub: coordinator.npub,
      workerNpub: worker.npub,
      expectedInviteeCount: expectedSubmissionCount,
      whitelistNpubs: privateInviteMode ? [] : voters.map((voter) => voter.npub),
      proxyVoterNpubs: voters.slice(0, proxyVoterCount).map((voter) => voter.npub),
      ballotGroupsByNpub,
      bearerInviteCodes: privateInviteMode
        ? voters.map((voter, index) => ({
          electionId: questionnaireId,
          codeHash: privateInviteHashesByNpub.get(voter.npub) ?? "",
          createdAt: new Date().toISOString(),
          state: "available" as const,
          credentialsPerVoter: index < proxyVoterCount ? 2 as const : 1 as const,
          ballotGroup: voterBallotGroups[index] ?? null,
        }))
        : [],
      eligibilityRequired: true,
      blindSigningPrivateKey,
      definitionReference,
      sentAt: new Date().toISOString(),
    };
    let configApplied = false;
    for (let attempt = 1; attempt <= configRetryLimit; attempt += 1) {
      const publishedConfigDm = await publishOptionAWorkerElectionConfigDm({
        signer: signer(coordinator.npub),
        recipientNpub: worker.npub,
        snapshot: configSnapshot,
        fallbackNsec: coordinator.nsec,
        relays,
      });
      assert(publishedConfigDm.successes > 0, `expected worker election config DM publish attempt ${attempt} to succeed on at least one relay`);
      if (attempt > 1) {
        process.stdout.write(`Retried worker config publish attempt ${attempt}/${configRetryLimit}\n`);
      }
      await sleep(intervalMs);
      workerExit.assertRunning();
      const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
      if (helperState?.expected_invitee_count === expectedSubmissionCount && helperState?.blind_signing_private_key && helperState?.definition) {
        configApplied = true;
        break;
      }
      try {
        await waitForValue(
          "worker election config DM visibility before blind request",
          async () => {
            const entries = await fetchOptionAWorkerElectionConfigDmsWithNsec({
              nsec: worker.nsec,
              electionId: questionnaireId,
              relays,
              limit: 20,
            });
            workerExit.assertRunning();
            return entries.find((entry) => entry.delegationId === delegation.delegationId) ?? null;
          },
          (value) => Boolean(value?.delegationId === delegation.delegationId),
          Math.max(20_000, Math.floor(timeoutMs / 4)),
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
        const refreshedState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        workerExit.assertRunning();
        if (refreshedState?.expected_invitee_count === expectedSubmissionCount && refreshedState?.blind_signing_private_key && refreshedState?.definition) {
          configApplied = true;
          break;
        }
      } catch {
        // keep retrying the config DM against live relays
      }
    }
    assert(configApplied, `helper never applied election config after ${configRetryLimit} publish attempts`);

    const issueBlindTokensWorker = buildIssueBlindTokensWorkerRouting({
      delegationId: delegation.delegationId,
      workerNpub: visibleDelegation?.workerNpub ?? worker.npub,
      controlRelays: visibleDelegation?.controlRelays ?? relays,
      expiresAt: delegation.expiresAt,
    });
    process.stdout.write(`Bulk inviting ${voters.length} voters before responses start...\n`);
    let invitedCount = 0;
    await runWithConcurrency(voters, inviteConcurrency, async (voter, index) => {
      const ballotGroup = voterBallotGroups[index] ?? null;
      const draftInvite: ElectionInviteMessage = {
        type: "election_invite",
        schemaVersion: 1,
        electionId: questionnaireId,
        title: definition.title,
        description: definition.description ?? "",
        voteUrl: "",
        invitedNpub: voter.npub,
        coordinatorNpub: coordinator.npub,
        blindSigningPublicKey,
        issueBlindTokensWorker,
        definitionReference,
        ...(index < proxyVoterCount ? { credentialsPerVoter: 2 as const } : {}),
        ...(ballotGroup ? { ballotGroup } : {}),
        expiresAt: null,
      };
      const invite: ElectionInviteMessage = {
        ...draftInvite,
        voteUrl: buildInviteUrl({ baseUrl: inviteBaseUrl, invite: draftInvite }),
      };
      const publishedInvite = await publishOptionAInviteDm({
        signer: signer(coordinator.npub),
        invite,
        fallbackNsec: coordinator.nsec,
        relays,
      });
      assert(
        publishedInvite.successes > 0,
        `expected voter ${index + 1}/${voters.length} invite DM publish to succeed on at least one relay`,
      );
      invitedCount += 1;
      if (invitedCount === voters.length || invitedCount % 10 === 0) {
        process.stdout.write(`Bulk invited ${invitedCount}/${voters.length} voters\n`);
      }
    });

    const completedVoters: Array<{
      requestId: string;
      issuanceId: string | undefined;
      submissionId: string;
      tokenNullifier: string;
    }> = [];
    const answers: QuestionnaireResponseAnswer[] = definition.questions.map(answerForQuestion);
    let completedSubmissionCount = 0;

    async function publishCompletedSubmission(input: {
      voterNsec: string;
      voterLabel: string;
      request: BlindBallotRequest;
      issuance: BlindBallotIssuance;
      blindTokenMessage: string;
      blindingFactor: string;
      tokenSecret: string;
      tokenCommitment: string;
      ballotScope: BallotScope | null;
      responseAnswers: QuestionnaireResponseAnswer[];
      totalSubmissions: number;
    }) {
      assert.equal(input.issuance.electionId, questionnaireId);
      if (input.issuance.definition) {
        assert.equal(input.issuance.definition.questionnaireId, questionnaireId);
      } else {
        assert(
          input.issuance.definitionHash || input.issuance.definitionEventId,
          "expected blind issuance to carry either a legacy definition or a public definition reference",
        );
      }
      const credential = await finalizeQuestionnaireBlindSignature({
        publicKey: blindSigningPublicKey,
        message: input.blindTokenMessage,
        blindSignature: input.issuance.blindSignature,
        blindingFactor: input.blindingFactor,
      });
      assert.equal(
        await verifyQuestionnaireBlindSignature({
          publicKey: blindSigningPublicKey,
          message: input.blindTokenMessage,
          signature: credential,
        }),
        true,
        `expected ${input.voterLabel} final credential verification to succeed`,
      );

      const responseSecretKey = generateSecretKey();
      const responseNsec = nip19.nsecEncode(responseSecretKey);
      const submissionId = randomId("submission");
      const submittedAt = Math.floor(Date.now() / 1000);
      const tokenNullifier = deriveQuestionnaireTokenNullifier({
        questionnaireId,
        tokenSecret: input.tokenSecret,
        ballotScope: input.ballotScope,
      });
      const tokenProof = {
        tokenCommitment: input.tokenCommitment,
        questionnaireId,
        signature: credential,
        ...(input.ballotScope ? {
          questionId: input.ballotScope.questionId ?? input.responseAnswers[0]?.questionId ?? null,
          ballotScope: input.ballotScope,
        } : {}),
      };
      const tokenNullifiers = input.ballotScope
        ? [{
          questionId: input.ballotScope.questionId ?? input.responseAnswers[0]?.questionId ?? null,
          tokenNullifier,
          ballotScope: input.ballotScope,
        }]
        : undefined;
      let publishedBlindResponse: Awaited<ReturnType<typeof publishQuestionnaireBlindResponsePublic>> | null = null;
      let publishError: unknown = null;
      for (let attempt = 1; attempt <= responsePublishRetryLimit; attempt += 1) {
        try {
          const result = await publishQuestionnaireBlindResponsePublic({
            responseNsec,
            questionnaireId,
            questionnaireDefinitionEventId: publishedDefinition.eventId,
            responseId: submissionId,
            submittedAt,
            tokenNullifier,
            ...(tokenNullifiers ? { tokenNullifiers } : {}),
            tokenProof,
            ...(input.ballotScope ? { tokenProofs: [tokenProof] } : {}),
            answers: input.responseAnswers,
            relays,
            ...(fastPublicPublish ? {
              includeDefaultRelays: false,
              usePublishQueue: false,
              relayStaggerMs: 0,
              minPublishIntervalMs: 0,
              publishMaxWaitMs: 5_000,
            } : {}),
          });
          publishedBlindResponse = result;
          if (result.successes > 0) {
            break;
          }
          publishError = new Error("zero relay successes");
        } catch (error) {
          publishError = error;
        }
        if (attempt < responsePublishRetryLimit) {
          process.stdout.write(`Retried ${input.voterLabel} public blind response publish attempt ${attempt + 1}/${responsePublishRetryLimit}\n`);
          await sleep(Math.min(1_000, intervalMs));
        }
      }
      assert(
        publishedBlindResponse && publishedBlindResponse.successes > 0,
        `expected ${input.voterLabel} public blind response publish to succeed on at least one relay: ${publishError instanceof Error ? publishError.message : String(publishError ?? "zero relay successes")}`,
      );
      completedVoters.push({
        requestId: input.request.requestId,
        issuanceId: input.issuance.issuanceId,
        submissionId,
        tokenNullifier,
      });
      completedSubmissionCount += 1;
      if (
        !perQuestionSubmissions
        || completedSubmissionCount === input.totalSubmissions
        || completedSubmissionCount % 25 === 0
      ) {
        process.stdout.write(`Completed submission ${completedSubmissionCount}/${input.totalSubmissions}: ${input.voterLabel}, request=${input.request.requestId}, submission=${submissionId}\n`);
      }
    }

    async function waitForWaveRelayReadback(input: {
      questionLabel: string;
      submissionIds: string[];
    }) {
      if (!waveRelayReadback || input.submissionIds.length === 0) {
        return;
      }
      const startedAt = Date.now();
      const expectedIds = new Set(input.submissionIds);
      await waitForValue(
        `${input.questionLabel} public blind response relay readback`,
        async () => {
          const entries = await queryBlindResponseEntries({
            questionnaireId,
            relays,
            readRelayLimit,
            limit: Math.max(expectedSubmissionCount + 100, expectedIds.size + 50),
          });
          return new Set(entries.map((entry) => entry.response.responseId));
        },
        (seenIds) => input.submissionIds.every((submissionId) => seenIds.has(submissionId)),
        timeoutMs,
        intervalMs,
        Math.max(30_000, intervalMs * 2),
        () => workerExit.assertRunning(),
      );
      process.stdout.write(
        `Read back ${input.questionLabel}: submissions=${input.submissionIds.length}, elapsedMs=${Date.now() - startedAt}\n`,
      );
    }

    async function buildBlindRequest(input: {
      voterNpub: string;
      ballotScope: BallotScope | null;
    }) {
      const tokenSecret = nodeCrypto.randomBytes(32).toString("hex");
      const tokenCommitment = sha256Hex(tokenSecret);
      const blindTokenMessage = buildQuestionnaireBlindTokenSignedMessage({
        questionnaireId,
        tokenSecretCommitment: tokenCommitment,
        ballotScope: input.ballotScope,
      });
      const blindedToken = await blindQuestionnaireToken({
        publicKey: blindSigningPublicKey,
        message: blindTokenMessage,
      });
      const request: BlindBallotRequest = {
        type: "blind_ballot_request" as const,
        schemaVersion: 1 as const,
        electionId: questionnaireId,
        requestId: randomId("request"),
        invitedNpub: input.voterNpub,
        blindedMessage: blindedToken.blindedMessage,
        blindSigningKeyId: blindSigningPublicKey.keyId,
        clientNonce: randomId("nonce"),
        createdAt: new Date().toISOString(),
        ...(privateInviteMode ? { inviteCodeHash: privateInviteHashesByNpub.get(input.voterNpub) } : {}),
        ...(input.ballotScope ? { ballotScope: input.ballotScope } : {}),
      };
      return {
        request,
        tokenSecret,
        tokenCommitment,
        blindTokenMessage,
        blindingFactor: blindedToken.blindingFactor,
        ballotScope: input.ballotScope,
      };
    }

    type ScopedRequestEntry = Awaited<ReturnType<typeof buildBlindRequest>> & {
      question: QuestionnaireDefinition["questions"][number];
      questionIndex: number;
      credentialIndex: number;
      answer: QuestionnaireResponseAnswer;
    };

    type ScopedIssuedEntry = ScopedRequestEntry & {
      voter: ReturnType<typeof makeNostrIdentity>;
      voterIndex: number;
      issuance: Awaited<ReturnType<typeof fetchOptionABlindIssuanceDmsWithNsec>>[number];
    };

    async function buildScopedRequestEntriesForVoter(
      voter: ReturnType<typeof makeNostrIdentity>,
      voterIndex: number,
    ): Promise<ScopedRequestEntry[]> {
      return await Promise.all(definition.questions.flatMap((question, questionIndex) => {
        const eligibleVoterIndexes = scopedEligibleVoterIndexes({
          questionIndex,
          baseQuestionCount,
          voterCount: voters.length,
          restrictedQuestionGroupCount,
          restrictedEligibleCount,
        });
        if (!eligibleVoterIndexes.includes(voterIndex)) {
          return [];
        }
        return scopedCredentialIndexes(voterIndex, proxyVoterCount).map(async (credentialIndex) => ({
          question,
          questionIndex,
          credentialIndex,
          answer: answerForQuestion(question, questionIndex),
          ...(await buildBlindRequest({
            voterNpub: voter.npub,
            ballotScope: ballotScopeForQuestion(question, questionIndex, credentialIndex),
          })),
        }));
      }));
    }

    async function publishScopedRequestEntriesForVoter(input: {
      voter: ReturnType<typeof makeNostrIdentity>;
      voterIndex: number;
      requestEntries: ScopedRequestEntry[];
    }) {
      const voterLabel = `voter ${input.voterIndex + 1}/${voters.length}`;
      const requestIds = new Set(input.requestEntries.map((entry) => entry.request.requestId));
      const helperSeenRequestIds = new Set<string>();
      for (let attempt = 1; attempt <= requestRetryLimit; attempt += 1) {
        const pendingEntries = input.requestEntries.filter((entry) => !helperSeenRequestIds.has(entry.request.requestId));
        if (pendingEntries.length === 0) {
          break;
        }
        const publishFailures: string[] = [];
        try {
          if (pendingEntries.length === 1) {
            const entry = pendingEntries[0]!;
            const publishedBlindRequest = await publishOptionABlindRequestDm({
              signer: signer(input.voter.npub),
              recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
              request: entry.request,
              fallbackNsec: input.voter.nsec,
              relays: visibleDelegation?.controlRelays ?? relays,
            });
            if (publishedBlindRequest.successes === 0) {
              publishFailures.push(`${entry.question.questionId}: zero relay successes`);
            }
          } else {
            const publishedBlindRequest = await publishOptionABlindRequestBundleDm({
              signer: signer(input.voter.npub),
              recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
              requests: pendingEntries.map((entry) => entry.request),
              fallbackNsec: input.voter.nsec,
              relays: visibleDelegation?.controlRelays ?? relays,
            });
            if (publishedBlindRequest.successes === 0) {
              publishFailures.push("bundle: zero relay successes");
            }
          }
        } catch (error) {
          publishFailures.push(`bundle: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (publishFailures.length > 0) {
          process.stdout.write(`Retryable ${voterLabel} scoped blind request publish failures on attempt ${attempt}/${requestRetryLimit}: ${publishFailures.join("; ")}\n`);
        }
        if (attempt > 1) {
          process.stdout.write(`Retried ${voterLabel} scoped blind request publish attempt ${attempt}/${requestRetryLimit} for ${pendingEntries.length} pending request(s)\n`);
        }
        const waitStartedAt = Date.now();
        const waitUntil = waitStartedAt + (attempt < requestRetryLimit ? requestRetryWaitMs : intervalMs);
        do {
          await sleep(Math.min(intervalMs, Math.max(0, waitUntil - Date.now())));
          workerExit.assertRunning();
          const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
          for (const requestId of helperState?.seen_blind_request_ids ?? []) {
            if (requestIds.has(requestId)) {
              helperSeenRequestIds.add(requestId);
            }
          }
          if (input.requestEntries.every((entry) => helperSeenRequestIds.has(entry.request.requestId))) {
            break;
          }
        } while (Date.now() < waitUntil);
      }

      const missingSeenRequests = input.requestEntries.filter((entry) => !helperSeenRequestIds.has(entry.request.requestId));
      if (missingSeenRequests.length > 0) {
        process.stdout.write(
          `Waiting for ${voterLabel} scoped blind issuance after ${missingSeenRequests.length} request(s) remained unconfirmed after ${requestRetryLimit} publish attempts: ${missingSeenRequests.map((entry) => entry.request.requestId).join(", ")}\n`,
        );
      }

      const issuanceEntries = await waitForValue(
        `${voterLabel} scoped blind issuance DM batch from spawned Rust helper`,
        async () => {
          const entries = await fetchOptionABlindIssuanceDmsWithNsec({
            nsec: input.voter.nsec,
            electionId: questionnaireId,
            relays,
            limit: Math.max(100, definition.questions.length * 3),
          });
          return entries.filter((entry) => requestIds.has(entry.requestId));
        },
        (value) => input.requestEntries.every((requestEntry) => value.some((entry) => (
          entry.requestId === requestEntry.request.requestId
          && entry.invitedNpub === input.voter.npub
        ))),
        timeoutMs,
        intervalMs,
        undefined,
        () => workerExit.assertRunning(),
      );
      return new Map(issuanceEntries.map((entry) => [entry.requestId, entry]));
    }

    async function publishIssuedScopedEntry(input: {
      entry: ScopedRequestEntry;
      issuance: ScopedIssuedEntry["issuance"];
      voter: ReturnType<typeof makeNostrIdentity>;
      voterIndex: number;
      totalSubmissions: number;
    }) {
      const credentialLabel = input.entry.credentialIndex > 1 ? ` credential ${input.entry.credentialIndex}` : "";
      await publishCompletedSubmission({
        voterNsec: input.voter.nsec,
        voterLabel: `voter ${input.voterIndex + 1}/${voters.length}${credentialLabel} question ${input.entry.questionIndex + 1}/${definition.questions.length}`,
        request: input.entry.request,
        issuance: input.issuance,
        blindTokenMessage: input.entry.blindTokenMessage,
        blindingFactor: input.entry.blindingFactor,
        tokenSecret: input.entry.tokenSecret,
        tokenCommitment: input.entry.tokenCommitment,
        ballotScope: input.entry.ballotScope,
        responseAnswers: [input.entry.answer],
        totalSubmissions: input.totalSubmissions,
      });
    }

    async function submitScopedEntry(input: {
      voter: ReturnType<typeof makeNostrIdentity>;
      voterIndex: number;
      question: QuestionnaireDefinition["questions"][number];
      questionIndex: number;
      credentialIndex: number;
      totalSubmissions: number;
    }) {
      const credentialLabel = input.credentialIndex > 1 ? ` credential ${input.credentialIndex}` : "";
      const voterLabel = `voter ${input.voterIndex + 1}/${voters.length}${credentialLabel} question ${input.questionIndex + 1}/${definition.questions.length}`;
      const submissionDelayMs = randomDelayMs(responseDelayMinMs, responseDelayMaxMs);
      if (submissionDelayMs > 0) {
        await sleep(submissionDelayMs);
      }
      workerExit.assertRunning();
      const entry = {
        question: input.question,
        questionIndex: input.questionIndex,
        answer: answerForQuestion(input.question, input.questionIndex),
        ...(await buildBlindRequest({
          voterNpub: input.voter.npub,
          ballotScope: ballotScopeForQuestion(input.question, input.questionIndex, input.credentialIndex),
        })),
      };

      let workerSawRequest = false;
      for (let attempt = 1; attempt <= requestRetryLimit; attempt += 1) {
        try {
          const publishedBlindRequest = await publishOptionABlindRequestDm({
            signer: signer(input.voter.npub),
            recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
            request: entry.request,
            fallbackNsec: input.voter.nsec,
            relays: visibleDelegation?.controlRelays ?? relays,
          });
          if (publishedBlindRequest.successes === 0) {
            process.stdout.write(`Retryable ${voterLabel} blind request publish failure on attempt ${attempt}/${requestRetryLimit}: zero relay successes\n`);
          }
        } catch (error) {
          process.stdout.write(`Retryable ${voterLabel} blind request publish failure on attempt ${attempt}/${requestRetryLimit}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        if (attempt > 1) {
          process.stdout.write(`Retried ${voterLabel} blind request publish attempt ${attempt}/${requestRetryLimit}\n`);
        }
        const waitStartedAt = Date.now();
        const waitUntil = waitStartedAt + (attempt < requestRetryLimit ? requestRetryWaitMs : intervalMs);
        do {
          await sleep(Math.min(intervalMs, Math.max(0, waitUntil - Date.now())));
          workerExit.assertRunning();
          const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
          if (helperState?.seen_blind_request_ids?.includes(entry.request.requestId)) {
            workerSawRequest = true;
            break;
          }
        } while (Date.now() < waitUntil);
        if (workerSawRequest) {
          break;
        }
      }

      let visibleIssuance = null as Awaited<ReturnType<typeof fetchOptionABlindIssuanceDmsWithNsec>>[number] | null;
      try {
        visibleIssuance = await waitForValue(
          `${voterLabel} scoped blind issuance DM from spawned Rust helper`,
          async () => {
            const entries = await fetchOptionABlindIssuanceDmsWithNsec({
              nsec: input.voter.nsec,
              electionId: questionnaireId,
              relays,
              limit: Math.max(50, definition.questions.length + 10),
            });
            return entries.find((issuanceEntry) => issuanceEntry.requestId === entry.request.requestId) ?? null;
          },
          (value) => Boolean(value?.requestId === entry.request.requestId && value?.invitedNpub === input.voter.npub),
          timeoutMs,
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
      } catch (error) {
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        const logText = liveWorkerLogs.lines.join("");
        workerSawRequest = Boolean(
          helperState?.seen_blind_request_ids?.includes(entry.request.requestId)
          || logText.includes(`blind request received: election_id=${questionnaireId}, request_id=${entry.request.requestId}`),
        );
        assert(
          workerSawRequest,
          `helper state/logs never confirmed ${voterLabel} blind request ${entry.request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        assert(
          Boolean(helperState?.last_blind_issuance_at) || logText.includes(`blind issuance published: election_id=${questionnaireId}, request_id=${entry.request.requestId}`),
          `helper state/logs never confirmed ${voterLabel} blind issuance for ${entry.request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        visibleIssuance = await waitForValue(
          `${voterLabel} scoped blind issuance DM after helper-confirmed issuance`,
          async () => {
            const entries = await fetchOptionABlindIssuanceDmsWithNsec({
              nsec: input.voter.nsec,
              electionId: questionnaireId,
              relays,
              limit: Math.max(50, definition.questions.length + 10),
            });
            return entries.find((issuanceEntry) => issuanceEntry.requestId === entry.request.requestId) ?? null;
          },
          (value) => Boolean(value?.requestId === entry.request.requestId && value?.invitedNpub === input.voter.npub),
          Math.max(30_000, Math.floor(timeoutMs / 2)),
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
      }
      if (!workerSawRequest) {
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        const logText = liveWorkerLogs.lines.join("");
        workerSawRequest = Boolean(
          helperState?.seen_blind_request_ids?.includes(entry.request.requestId)
          || logText.includes(`blind request received: election_id=${questionnaireId}, request_id=${entry.request.requestId}`)
          || visibleIssuance?.requestId === entry.request.requestId,
        );
      }
      assert(workerSawRequest, `helper never confirmed ${voterLabel} blind request ${entry.request.requestId} after ${requestRetryLimit} publish attempts`);
      assert(visibleIssuance, `missing ${voterLabel} issuance`);
      await publishCompletedSubmission({
        voterNsec: input.voter.nsec,
        voterLabel,
        request: entry.request,
        issuance: visibleIssuance,
        blindTokenMessage: entry.blindTokenMessage,
        blindingFactor: entry.blindingFactor,
        tokenSecret: entry.tokenSecret,
        tokenCommitment: entry.tokenCommitment,
        ballotScope: entry.ballotScope,
        responseAnswers: [entry.answer],
        totalSubmissions: input.totalSubmissions,
      });
    }

    if (perQuestionSubmissions) {
      if (preissueScopedCredentials) {
        const issuedEntries: ScopedIssuedEntry[] = [];
        let preissuedVoterCount = 0;
        process.stdout.write(`Pre-issuing ${expectedSubmissionCount} scoped credential(s) in ${voters.length} voter registration batch(es)...\n`);
        await runWithConcurrency(voters, inviteConcurrency, async (voter, voterIndex) => {
          workerExit.assertRunning();
          const requestEntries = await buildScopedRequestEntriesForVoter(voter, voterIndex);
          if (requestEntries.length === 0) {
            return;
          }
          const issuanceByRequestId = await publishScopedRequestEntriesForVoter({
            voter,
            voterIndex,
            requestEntries,
          });
          for (const entry of requestEntries) {
            const issuance = issuanceByRequestId.get(entry.request.requestId);
            assert(issuance, `missing voter ${voterIndex + 1}/${voters.length} ${entry.question.questionId} issuance after pre-issue readback`);
            issuedEntries.push({
              ...entry,
              voter,
              voterIndex,
              issuance,
            });
          }
          preissuedVoterCount += 1;
          if (preissuedVoterCount === voters.length || preissuedVoterCount % 10 === 0) {
            process.stdout.write(`Pre-issued scoped credentials for ${preissuedVoterCount}/${voters.length} voters; credentials=${issuedEntries.length}/${expectedSubmissionCount}\n`);
          }
        });
        assert.equal(issuedEntries.length, expectedSubmissionCount, "expected every scoped credential to be pre-issued before question waves");
        process.stdout.write(`Submitting ${expectedSubmissionCount} pre-issued blind response job(s) in ${definition.questions.length} question wave(s)...\n`);
        for (const [questionIndex, question] of definition.questions.entries()) {
          const waveStartedAt = Date.now();
          const completedBeforeWave = completedSubmissionCount;
          const waveEntries = issuedEntries.filter((entry) => entry.questionIndex === questionIndex);
          process.stdout.write(`Starting question wave ${questionIndex + 1}/${definition.questions.length}: ${question.questionId}, submissions=${waveEntries.length}\n`);
          await runWithConcurrency(waveEntries, submissionConcurrency, async (entry) => {
            await publishIssuedScopedEntry({
              entry,
              issuance: entry.issuance,
              voter: entry.voter,
              voterIndex: entry.voterIndex,
              totalSubmissions: expectedSubmissionCount,
            });
          });
          const waveCompletedCount = completedSubmissionCount - completedBeforeWave;
          const waveSubmissionIds = completedVoters
            .slice(completedBeforeWave)
            .map((entry) => entry.submissionId);
          assert.equal(waveCompletedCount, waveEntries.length, `expected ${waveEntries.length} submissions in ${question.questionId} wave`);
          await waitForWaveRelayReadback({
            questionLabel: `question wave ${questionIndex + 1}/${definition.questions.length}: ${question.questionId}`,
            submissionIds: waveSubmissionIds,
          });
          process.stdout.write(`Completed question wave ${questionIndex + 1}/${definition.questions.length}: ${question.questionId}, submissions=${waveCompletedCount}/${waveEntries.length}, elapsedMs=${Date.now() - waveStartedAt}\n`);
        }
      } else if (scopedSubmissionSchedule === "question_waves") {
        process.stdout.write(`Submitting ${expectedSubmissionCount} scoped blind response job(s) in ${definition.questions.length} question wave(s)...\n`);
        for (const [questionIndex, question] of definition.questions.entries()) {
          const waveStartedAt = Date.now();
          const completedBeforeWave = completedSubmissionCount;
          const eligibleVoterIndexes = scopedEligibleVoterIndexes({
            questionIndex,
            baseQuestionCount,
            voterCount: voters.length,
            restrictedQuestionGroupCount,
            restrictedEligibleCount,
          });
          const waveJobs = eligibleVoterIndexes.flatMap((voterIndex) => (
            scopedCredentialIndexes(voterIndex, proxyVoterCount).map((credentialIndex) => ({
              voter: voters[voterIndex],
              voterIndex,
              credentialIndex,
            }))
          ));
          process.stdout.write(`Starting question wave ${questionIndex + 1}/${definition.questions.length}: ${question.questionId}, voters=${eligibleVoterIndexes.length}, submissions=${waveJobs.length}\n`);
          await runWithConcurrency(waveJobs, submissionConcurrency, async (job) => {
            await submitScopedEntry({
              voter: job.voter,
              voterIndex: job.voterIndex,
              question,
              questionIndex,
              credentialIndex: job.credentialIndex,
              totalSubmissions: expectedSubmissionCount,
            });
          });
          const waveCompletedCount = completedSubmissionCount - completedBeforeWave;
          const waveSubmissionIds = completedVoters
            .slice(completedBeforeWave)
            .map((entry) => entry.submissionId);
          assert.equal(waveCompletedCount, waveJobs.length, `expected ${waveJobs.length} submissions in ${question.questionId} wave`);
          await waitForWaveRelayReadback({
            questionLabel: `question wave ${questionIndex + 1}/${definition.questions.length}: ${question.questionId}`,
            submissionIds: waveSubmissionIds,
          });
          process.stdout.write(`Completed question wave ${questionIndex + 1}/${definition.questions.length}: ${question.questionId}, submissions=${waveCompletedCount}/${waveJobs.length}, elapsedMs=${Date.now() - waveStartedAt}\n`);
        }
      } else {
        process.stdout.write(`Submitting ${expectedSubmissionCount} scoped blind response job(s) in ${voters.length} voter batch(es)...\n`);
        await runWithConcurrency(voters, submissionConcurrency, async (voter, voterIndex) => {
        const voterLabel = `voter ${voterIndex + 1}/${voters.length}`;
        const submissionDelayMs = randomDelayMs(responseDelayMinMs, responseDelayMaxMs);
        if (submissionDelayMs > 0) {
          await sleep(submissionDelayMs);
        }
        workerExit.assertRunning();
        const requestEntries = await Promise.all(definition.questions.flatMap((question, questionIndex) => {
          const eligibleVoterIndexes = scopedEligibleVoterIndexes({
            questionIndex,
            baseQuestionCount,
            voterCount: voters.length,
            restrictedQuestionGroupCount,
            restrictedEligibleCount,
          });
          if (!eligibleVoterIndexes.includes(voterIndex)) {
            return [];
          }
          return scopedCredentialIndexes(voterIndex, proxyVoterCount).map(async (credentialIndex) => ({
            question,
            questionIndex,
            credentialIndex,
            answer: answerForQuestion(question, questionIndex),
            ...(await buildBlindRequest({
              voterNpub: voter.npub,
              ballotScope: ballotScopeForQuestion(question, questionIndex, credentialIndex),
            })),
          }));
        }));
        if (requestEntries.length === 0) {
          return;
        }

        const requestIds = new Set(requestEntries.map((entry) => entry.request.requestId));
        const helperSeenRequestIds = new Set<string>();
        for (let attempt = 1; attempt <= requestRetryLimit; attempt += 1) {
          const pendingEntries = requestEntries.filter((entry) => !helperSeenRequestIds.has(entry.request.requestId));
          if (pendingEntries.length === 0) {
            break;
          }
          const publishFailures: string[] = [];
          try {
            if (pendingEntries.length === 1) {
              const entry = pendingEntries[0]!;
              const publishedBlindRequest = await publishOptionABlindRequestDm({
                signer: signer(voter.npub),
                recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
                request: entry.request,
                fallbackNsec: voter.nsec,
                relays: visibleDelegation?.controlRelays ?? relays,
              });
              if (publishedBlindRequest.successes === 0) {
                publishFailures.push(`${entry.question.questionId}: zero relay successes`);
              }
            } else {
              const publishedBlindRequest = await publishOptionABlindRequestBundleDm({
                signer: signer(voter.npub),
                recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
                requests: pendingEntries.map((entry) => entry.request),
                fallbackNsec: voter.nsec,
                relays: visibleDelegation?.controlRelays ?? relays,
              });
              if (publishedBlindRequest.successes === 0) {
                publishFailures.push(`bundle: zero relay successes`);
              }
            }
          } catch (error) {
            publishFailures.push(`bundle: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (publishFailures.length > 0) {
            process.stdout.write(`Retryable ${voterLabel} scoped blind request publish failures on attempt ${attempt}/${requestRetryLimit}: ${publishFailures.join("; ")}\n`);
          }
          if (attempt > 1) {
            process.stdout.write(`Retried ${voterLabel} scoped blind request publish attempt ${attempt}/${requestRetryLimit} for ${pendingEntries.length} pending request(s)\n`);
          }
          const waitStartedAt = Date.now();
          const waitUntil = waitStartedAt + (attempt < requestRetryLimit ? requestRetryWaitMs : intervalMs);
          do {
            await sleep(Math.min(intervalMs, Math.max(0, waitUntil - Date.now())));
            workerExit.assertRunning();
            const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
            for (const requestId of helperState?.seen_blind_request_ids ?? []) {
              if (requestIds.has(requestId)) {
                helperSeenRequestIds.add(requestId);
              }
            }
            if (requestEntries.every((entry) => helperSeenRequestIds.has(entry.request.requestId))) {
              break;
            }
          } while (Date.now() < waitUntil);
        }
        const missingSeenRequests = requestEntries.filter((entry) => !helperSeenRequestIds.has(entry.request.requestId));
        if (missingSeenRequests.length > 0) {
          process.stdout.write(
            `Waiting for ${voterLabel} scoped blind issuance after ${missingSeenRequests.length} request(s) remained unconfirmed after ${requestRetryLimit} publish attempts: ${missingSeenRequests.map((entry) => entry.request.requestId).join(", ")}\n`,
          );
        }

        const issuanceEntries = await waitForValue(
          `${voterLabel} scoped blind issuance DM batch from spawned Rust helper`,
          async () => {
            const entries = await fetchOptionABlindIssuanceDmsWithNsec({
              nsec: voter.nsec,
              electionId: questionnaireId,
              relays,
              limit: Math.max(100, definition.questions.length * 3),
            });
            return entries.filter((entry) => requestIds.has(entry.requestId));
          },
          (value) => requestEntries.every((requestEntry) => value.some((entry) => (
            entry.requestId === requestEntry.request.requestId
            && entry.invitedNpub === voter.npub
          ))),
          timeoutMs,
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
        const issuanceByRequestId = new Map(issuanceEntries.map((entry) => [entry.requestId, entry]));
        await runWithConcurrency(requestEntries, Math.min(5, requestEntries.length), async (entry) => {
          const visibleIssuance = issuanceByRequestId.get(entry.request.requestId);
          assert(visibleIssuance, `missing ${voterLabel} ${entry.question.questionId} issuance after batch readback`);
          await publishCompletedSubmission({
            voterNsec: voter.nsec,
            voterLabel: `${voterLabel} question ${entry.questionIndex + 1}/${definition.questions.length}`,
            request: entry.request,
            issuance: visibleIssuance,
            blindTokenMessage: entry.blindTokenMessage,
            blindingFactor: entry.blindingFactor,
            tokenSecret: entry.tokenSecret,
            tokenCommitment: entry.tokenCommitment,
            ballotScope: entry.ballotScope,
            responseAnswers: [entry.answer],
            totalSubmissions: expectedSubmissionCount,
          });
        });
        });
      }
    } else {
      const submissionJobs: LiveRustHelperSubmissionJob[] = voters.flatMap((voter, voterIndex) => (
        scopedCredentialIndexes(voterIndex, proxyVoterCount).map((credentialIndex) => {
          const ballotGroup = voterBallotGroups[voterIndex] ?? null;
          return {
            voter,
            voterIndex,
            questionIndex: null,
            answers: definition.questions
              .map((question, questionIndex) => ({ question, questionIndex }))
              .filter(({ questionIndex }) => scopedEligibleVoterIndexes({
                questionIndex,
                baseQuestionCount,
                voterCount: voters.length,
                restrictedQuestionGroupCount,
                restrictedEligibleCount,
              }).includes(voterIndex))
              .map(({ question, questionIndex }) => answerForQuestion(question, questionIndex)),
            ballotScope: ballotScopeForQuestionnaireCredential(credentialIndex, ballotGroup),
          };
        })
      ));
      process.stdout.write(`Submitting ${submissionJobs.length} blind response job(s)...\n`);

      await runWithConcurrency(submissionJobs, submissionConcurrency, async (job) => {
        const voter = job.voter;
        const credentialIndex = job.ballotScope?.credentialIndex ?? 1;
        const credentialLabel = credentialIndex > 1 ? ` credential ${credentialIndex}` : "";
        const voterLabel = `voter ${job.voterIndex + 1}/${voters.length}${credentialLabel}`;
        const submissionDelayMs = randomDelayMs(responseDelayMinMs, responseDelayMaxMs);
        if (submissionDelayMs > 0) {
          await sleep(submissionDelayMs);
        }
        workerExit.assertRunning();
        const entry = await buildBlindRequest({
          voterNpub: voter.npub,
          ballotScope: job.ballotScope,
        });
      let workerSawRequest = false;
      for (let attempt = 1; attempt <= requestRetryLimit; attempt += 1) {
        try {
          const publishedBlindRequest = await publishOptionABlindRequestDm({
            signer: signer(voter.npub),
            recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
            request: entry.request,
            fallbackNsec: voter.nsec,
            relays: visibleDelegation?.controlRelays ?? relays,
          });
          if (publishedBlindRequest.successes === 0) {
            process.stdout.write(`Retryable ${voterLabel} blind request publish failure on attempt ${attempt}/${requestRetryLimit}: zero relay successes\n`);
          }
        } catch (error) {
          process.stdout.write(`Retryable ${voterLabel} blind request publish failure on attempt ${attempt}/${requestRetryLimit}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        if (attempt > 1) {
          process.stdout.write(`Retried ${voterLabel} blind request publish attempt ${attempt}/${requestRetryLimit}\n`);
        }
        await sleep(intervalMs);
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        if (helperState?.seen_blind_request_ids?.includes(entry.request.requestId)) {
          workerSawRequest = true;
          break;
        }
      }

      let visibleIssuance = null as Awaited<ReturnType<typeof fetchOptionABlindIssuanceDmsWithNsec>>[number] | null;
      try {
        visibleIssuance = await waitForValue(
          `${voterLabel} blind issuance DM from spawned Rust helper`,
          async () => {
            const entries = await fetchOptionABlindIssuanceDmsWithNsec({
              nsec: voter.nsec,
              electionId: questionnaireId,
              relays,
              limit: Math.max(50, definition.questions.length + 10),
            });
            return entries.find((issuanceEntry) => issuanceEntry.requestId === entry.request.requestId) ?? null;
          },
          (value) => Boolean(value?.requestId === entry.request.requestId && value?.invitedNpub === voter.npub),
          timeoutMs,
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
      } catch (error) {
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        const logText = liveWorkerLogs.lines.join("");
        workerSawRequest = Boolean(
          helperState?.seen_blind_request_ids?.includes(entry.request.requestId)
          || logText.includes(`blind request received: election_id=${questionnaireId}, request_id=${entry.request.requestId}`),
        );
        assert(
          workerSawRequest,
          `helper state/logs never confirmed ${voterLabel} blind request ${entry.request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        assert(
          Boolean(helperState?.last_blind_issuance_at) || logText.includes(`blind issuance published: election_id=${questionnaireId}, request_id=${entry.request.requestId}`),
          `helper state/logs never confirmed ${voterLabel} blind issuance for ${entry.request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        visibleIssuance = await waitForValue(
          `${voterLabel} blind issuance DM after helper-confirmed issuance`,
          async () => {
            const entries = await fetchOptionABlindIssuanceDmsWithNsec({
              nsec: voter.nsec,
              electionId: questionnaireId,
              relays,
              limit: Math.max(50, definition.questions.length + 10),
            });
            return entries.find((issuanceEntry) => issuanceEntry.requestId === entry.request.requestId) ?? null;
          },
          (value) => Boolean(value?.requestId === entry.request.requestId && value?.invitedNpub === voter.npub),
          Math.max(30_000, Math.floor(timeoutMs / 2)),
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
      }
      if (!workerSawRequest) {
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        const logText = liveWorkerLogs.lines.join("");
        workerSawRequest = Boolean(
          helperState?.seen_blind_request_ids?.includes(entry.request.requestId)
          || logText.includes(`blind request received: election_id=${questionnaireId}, request_id=${entry.request.requestId}`)
          || visibleIssuance?.requestId === entry.request.requestId,
        );
      }
      assert(workerSawRequest, `helper never confirmed ${voterLabel} blind request ${entry.request.requestId} after ${requestRetryLimit} publish attempts`);
      assert(visibleIssuance, `missing ${voterLabel} issuance`);
      await publishCompletedSubmission({
        voterNsec: voter.nsec,
        voterLabel,
        request: entry.request,
        issuance: visibleIssuance,
        blindTokenMessage: entry.blindTokenMessage,
        blindingFactor: entry.blindingFactor,
        tokenSecret: entry.tokenSecret,
        tokenCommitment: entry.tokenCommitment,
        ballotScope: job.ballotScope,
        responseAnswers: job.answers,
        totalSubmissions: submissionJobs.length,
      });
      });
    }
    workerExit.allowExpectedExit();

    const submissionIds = new Set(completedVoters.map((entry) => entry.submissionId));
    let publicResponses = [] as Awaited<ReturnType<typeof fetchQuestionnaireBlindResponses>>;
    let publicResponsesCameFromRelayReadback = false;
    if (!requireRelayReadback) {
      const helperStateWithProcessedSubmissions = await waitForValue(
        "helper processed submission state from spawned Rust helper",
        async () => getHelperElectionState(await readHelperState(workerStateDir), questionnaireId),
        (value) => Boolean(value && completedVoters.every((entry) => value.processed_submission_ids?.includes(entry.submissionId))),
        timeoutMs,
        intervalMs,
        Math.max(30_000, intervalMs * 2),
        () => workerExit.assertRunning(),
      );
      const now = Math.floor(Date.now() / 1000);
      publicResponses = completedVoters.map((entry) => ({
        event: {
          id: `helper-state-response-${entry.submissionId}`,
          pubkey: worker.hex,
          created_at: now,
          kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
          tags: [],
          content: "",
          sig: "",
        },
        response: {
          schemaVersion: 1,
          eventType: "questionnaire_response_blind",
          questionnaireId,
          responseId: entry.submissionId,
          submittedAt: now,
          authorPubkey: worker.hex,
          tokenNullifier: entry.tokenNullifier,
          tokenProof: {
            tokenCommitment: "",
            questionnaireId,
            signature: "",
          },
          answers: [],
        },
      }));
      assert(helperStateWithProcessedSubmissions);
    } else {
      publicResponses = await waitForValue(
        "public blind response visibility",
        async () => {
          const entries = await queryBlindResponseEntries({
            questionnaireId,
            relays,
            readRelayLimit,
            limit: Math.max(100, expectedSubmissionCount * 2),
          });
          const seen = new Set(entries.map((entry) => entry.response.responseId));
          return completedVoters.every((entry) => seen.has(entry.submissionId)) ? entries : [];
        },
        (value) => Array.isArray(value) && completedVoters.every((entry) => value.some((seen) => seen.response.responseId === entry.submissionId)),
        timeoutMs,
        intervalMs,
        Math.max(60_000, intervalMs * 2),
        () => workerExit.assertRunning(),
      );
      publicResponsesCameFromRelayReadback = true;
    }

    let submissionDecisions = [] as Array<{ submissionId: string; accepted: boolean; questionnaireId: string }>;
    let submissionDecisionCameFromRelayReadback = false;
    if (!requireRelayReadback) {
      const helperStateWithDecisions = await waitForValue(
        "helper submission decision state from spawned Rust helper",
        async () => getHelperElectionState(await readHelperState(workerStateDir), questionnaireId),
        (value) => Boolean(value && completedVoters.every((entry) => Boolean(value.published_decisions?.[entry.submissionId]))),
        timeoutMs,
        intervalMs,
        Math.max(30_000, intervalMs * 2),
        () => workerExit.assertRunning(),
      );
      submissionDecisions = completedVoters.map((entry) => ({
        submissionId: entry.submissionId,
        accepted: true,
        questionnaireId,
      }));
      assert(helperStateWithDecisions);
    } else {
      submissionDecisions = await waitForValue(
        "public submission decision visibility from spawned Rust helper",
        async () => {
          const events = await queryDecisionEvents({
            relays,
            workerHex: worker.hex,
            questionnaireId,
            limit: Math.max(100, expectedSubmissionCount),
            readRelayLimit,
          });
          return events
            .map((event) => {
              try {
                return JSON.parse(event.content) as {
                  submissionId: string;
                  accepted: boolean;
                  questionnaireId: string;
                };
              } catch {
                return null;
              }
            })
            .filter((entry): entry is { submissionId: string; accepted: boolean; questionnaireId: string } => Boolean(entry))
            .filter((entry) => entry.questionnaireId === questionnaireId);
        },
        (value) => Array.isArray(value) && completedVoters.every((entry) => value.some((decision) => decision.submissionId === entry.submissionId && decision.accepted)),
        timeoutMs,
        intervalMs,
        undefined,
        () => workerExit.assertRunning(),
      );
      submissionDecisionCameFromRelayReadback = true;
    }
    assert(completedVoters.every((entry) => submissionDecisions.some((decision) => decision.submissionId === entry.submissionId && decision.accepted)));

    const tokenNullifierBySubmissionId = new Map(completedVoters.map((entry) => [entry.submissionId, entry.tokenNullifier]));
    const admissions = evaluateQuestionnaireBlindAdmissions({
      entries: publicResponses,
      decisionEntries: submissionDecisions
        .filter((decision) => submissionIds.has(decision.submissionId))
        .map((decision) => {
          const decidedAt = Math.floor(Date.now() / 1000);
          const decisionPayload = {
            schemaVersion: 1,
            eventType: "questionnaire_submission_decision",
            questionnaireId,
            submissionId: decision.submissionId,
            tokenNullifier: tokenNullifierBySubmissionId.get(decision.submissionId) ?? "",
            accepted: decision.accepted,
            reason: decision.accepted ? "accepted" : "invalid_payload_shape",
            decidedAt,
            coordinatorPubkey: coordinator.npub,
          } as const;
          return {
            event: {
              id: `helper-state-${decision.submissionId}`,
              pubkey: worker.hex,
              created_at: decidedAt,
              kind: QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
              tags: [],
              content: JSON.stringify(decisionPayload),
              sig: "",
            },
            decision: decisionPayload,
          };
        }),
    });
    assert.equal(admissions.accepted.length, expectedSubmissionCount, `expected ${expectedSubmissionCount} accepted responses after helper decisions`);

    let visibleSummary = null as QuestionnaireResultSummary | null;
    let summaryCameFromRelayReadback = false;
    if (!requireRelayReadback) {
      const helperStateWithSummary = await waitForValue(
        "helper result summary state from spawned Rust helper",
        async () => getHelperElectionState(await readHelperState(workerStateDir), questionnaireId),
        (value) => Boolean(value?.summary_published && value.last_result_summary_publish_at),
        timeoutMs,
        intervalMs,
        Math.max(30_000, intervalMs * 2),
        () => workerExit.assertRunning(),
      );
      visibleSummary = {
        schemaVersion: 1,
        eventType: "questionnaire_result_summary",
        questionnaireId,
        createdAt: Math.floor(Date.now() / 1000),
        coordinatorPubkey: coordinator.npub,
        acceptedResponseCount: helperStateWithSummary.processed_submission_ids?.length ?? expectedSubmissionCount,
        rejectedResponseCount: 0,
        acceptedNullifierCount: helperStateWithSummary.accepted_nullifiers?.length ?? expectedSubmissionCount,
        questionSummaries: [],
      };
    } else {
      visibleSummary = await waitForValue(
        "public result summary visibility from spawned Rust helper",
        async () => {
          const events = await querySummaryEvents(relays, worker.hex);
          const summaryEvent = events.find((event: NostrEvent) => {
            try {
              const parsed = JSON.parse(event.content) as QuestionnaireResultSummary;
              return parsed.questionnaireId === questionnaireId;
            } catch {
              return false;
            }
          }) ?? null;
          return summaryEvent ? JSON.parse(summaryEvent.content) as QuestionnaireResultSummary : null;
        },
        (value) => Boolean(value?.questionnaireId === questionnaireId && value.acceptedResponseCount === expectedSubmissionCount),
        timeoutMs,
        intervalMs,
        undefined,
        () => workerExit.assertRunning(),
      );
      summaryCameFromRelayReadback = true;
    }
    assert.equal(visibleSummary?.acceptedResponseCount, expectedSubmissionCount);
    assert.equal(visibleSummary?.rejectedResponseCount, 0);
    if (requireRelayReadback) {
      assert(submissionDecisionCameFromRelayReadback, "submission decision required relay readback but only helper state confirmed success");
      assert(summaryCameFromRelayReadback, "result summary required relay readback but only helper state confirmed success");
    }
    if (expectWorkerExit) {
      await workerExit.waitForExpectedExit(Math.max(30_000, intervalMs * 4));
    } else {
      await sleep(Math.min(500, intervalMs));
      workerExit.assertRunning();
    }

    process.stdout.write("rust helper live smoke passed\n");
    process.stdout.write(`Submissions completed: ${completedVoters.length}\n`);
    process.stdout.write(`First blind request: ${completedVoters[0]?.requestId ?? "none"}\n`);
    process.stdout.write(`First blind issuance: ${completedVoters[0]?.issuanceId ?? "none"}\n`);
    process.stdout.write(`First submission: ${completedVoters[0]?.submissionId ?? "none"}\n`);
  } finally {
    liveWorkerLogs.detach();
    workerExit.markStopping();
    await terminateProcess(workerProcess);
    await fs.rm(workerStateDir, { recursive: true, force: true });
    if (startupLogs) {
      process.stdout.write("Captured worker startup logs.\n");
    }
  }
}

void main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    getSharedNostrPool().destroy?.();
  });

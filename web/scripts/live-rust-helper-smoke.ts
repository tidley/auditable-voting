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
  publishOptionABlindRequestDm,
  publishOptionAWorkerElectionConfigDm,
  type WorkerElectionConfigSnapshot,
} from "../src/questionnaireOptionABlindDm";
import type { BallotScope, BlindBallotIssuance, BlindBallotRequest, ElectionInviteMessage } from "../src/questionnaireOptionA";
import { publishOptionAInviteDm } from "../src/questionnaireOptionAInviteDm";
import { buildInviteUrl } from "../src/questionnaireInvite";
import {
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  publishQuestionnaireDefinition,
  publishQuestionnaireParticipantCount,
  publishQuestionnaireState,
} from "../src/questionnaireNostr";
import type {
  QuestionnaireDefinition,
  QuestionnaireResponseAnswer,
  QuestionnaireResultSummary,
} from "../src/questionnaireProtocol";
import {
  QUESTIONNAIRE_FLOW_MODE_PUBLIC_SUBMISSION_V1,
  QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
} from "../src/questionnaireProtocolConstants";
import {
  fetchQuestionnaireActiveWorkerDelegationForCapability,
  fetchQuestionnaireBlindResponses,
  evaluateQuestionnaireBlindAdmissions,
} from "../src/questionnaireTransport";
import { publishQuestionnaireBlindResponsePublic } from "../src/questionnaireResponsePublish";
import { QUESTIONNAIRE_RESPONSE_BLIND_KIND, QUESTIONNAIRE_SUBMISSION_DECISION_KIND } from "../src/questionnaireResponsePublish";
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
  questionCount: number;
  perQuestionCredentials: boolean;
}): QuestionnaireDefinition {
  const now = Math.floor(Date.now() / 1000);
  const questionCount = Math.max(1, Math.floor(input.questionCount));
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
    questions: Array.from({ length: questionCount }, (_, index) => ({
      questionId: `q${index + 1}`,
      prompt: `Live proxy harness question ${index + 1}`,
      required: true,
      type: "yes_no",
      ...(input.perQuestionCredentials
        ? { ballotSlot: { slotId: `q${index + 1}`, slotIndex: index + 1, version: 1 } }
        : {}),
    })),
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

async function queryDecisionEvents(relays: string[], workerHex: string, limit = 100) {
  const pool = getSharedNostrPool();
  return await withTimeout("submission decision relay query", pool.querySync(relays, {
    authors: [workerHex],
    kinds: [QUESTIONNAIRE_SUBMISSION_DECISION_KIND],
    limit,
  }), 10_000);
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
  const questionCount = envInt("OPTIONA_LIVE_RUST_HELPER_QUESTION_COUNT", 1);
  const submissionMode = envSubmissionMode("OPTIONA_LIVE_RUST_HELPER_SUBMISSION_MODE", "bundled");
  const perQuestionSubmissions = submissionMode === "per_question";
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
    envInt("OPTIONA_LIVE_RUST_HELPER_RESPONSE_DELAY_MAX_MS", perQuestionSubmissions ? 250 : 30_000),
  );
  const submissionConcurrency = envInt(
    "OPTIONA_LIVE_RUST_HELPER_SUBMISSION_CONCURRENCY",
    perQuestionSubmissions ? 12 : 1,
  );
  const expectWorkerExit = envBool("OPTIONA_LIVE_RUST_HELPER_EXPECT_WORKER_EXIT", false);
  const inviteBaseUrl = process.env.OPTIONA_LIVE_RUST_HELPER_INVITE_BASE_URL?.trim()
    || "https://auditable-voting.pages.dev/";
  const requireRelayReadback = envBool("OPTIONA_LIVE_RUST_HELPER_REQUIRE_RELAY_READBACK", false);
  const workerBinary = resolveWorkerBinary();
  const workerStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "auditable-voting-worker-live-"));

  const coordinator = makeNostrIdentity();
  const worker = makeNostrIdentity();
  const voters = Array.from({ length: voterCount }, () => makeNostrIdentity());
  const questionnaireId = `q_live_rust_helper_${nodeCrypto.randomBytes(8).toString("hex")}`;
  const blindSigningPrivateKey = await generateQuestionnaireBlindKeyPair();
  const blindSigningPublicKey = toQuestionnaireBlindPublicKey(blindSigningPrivateKey);
  const definition = buildDefinition({
    questionnaireId,
    coordinatorNpub: coordinator.npub,
    blindSigningPublicKey,
    questionCount,
    perQuestionCredentials: perQuestionSubmissions,
  });
  const expectedSubmissionCount = perQuestionSubmissions
    ? voters.length * definition.questions.length
    : voters.length;

  process.stdout.write(`Live Rust helper smoke\n`);
  process.stdout.write(`Questionnaire: ${questionnaireId}\n`);
  process.stdout.write(`Coordinator: ${coordinator.npub}\n`);
  process.stdout.write(`Audit proxy: ${worker.npub}\n`);
  process.stdout.write(`Voters: ${voters.length}\n`);
  process.stdout.write(`Questions: ${definition.questions.length}\n`);
  process.stdout.write(`Submission mode: ${submissionMode}\n`);
  process.stdout.write(`Expected submissions: ${expectedSubmissionCount}\n`);
  process.stdout.write(`First voter: ${voters[0]?.npub ?? "none"}\n`);
  process.stdout.write(`Bulk invite concurrency: ${Math.max(1, Math.min(inviteConcurrency, voters.length))}\n`);
  process.stdout.write(`Submission concurrency: ${Math.max(1, Math.min(submissionConcurrency, expectedSubmissionCount))}\n`);
  process.stdout.write(`Submission start delay: ${responseDelayMinMs}-${responseDelayMaxMs}ms\n`);
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
      whitelistNpubs: voters.map((voter) => voter.npub),
      bearerInviteCodes: [],
      eligibilityRequired: true,
      blindSigningPrivateKey,
      definition,
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
      const draftInvite: ElectionInviteMessage = {
        type: "election_invite",
        schemaVersion: 1,
        electionId: questionnaireId,
        title: definition.title,
        description: definition.description,
        voteUrl: "",
        invitedNpub: voter.npub,
        coordinatorNpub: coordinator.npub,
        blindSigningPublicKey,
        issueBlindTokensWorker,
        definition,
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
      assert.equal(input.issuance.definition?.questionnaireId, questionnaireId);
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
      const publishedBlindResponse = await publishQuestionnaireBlindResponsePublic({
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
      });
      assert(publishedBlindResponse.successes > 0, `expected ${input.voterLabel} public blind response publish to succeed on at least one relay`);
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
        tokenCommitment,
        blindSigningKeyId: blindSigningPublicKey.keyId,
        clientNonce: randomId("nonce"),
        createdAt: new Date().toISOString(),
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

    if (perQuestionSubmissions) {
      process.stdout.write(`Submitting ${expectedSubmissionCount} scoped blind response job(s) in ${voters.length} voter batch(es)...\n`);
      await runWithConcurrency(voters, submissionConcurrency, async (voter, voterIndex) => {
        const voterLabel = `voter ${voterIndex + 1}/${voters.length}`;
        const submissionDelayMs = randomDelayMs(responseDelayMinMs, responseDelayMaxMs);
        if (submissionDelayMs > 0) {
          await sleep(submissionDelayMs);
        }
        workerExit.assertRunning();
        const requestEntries = await Promise.all(definition.questions.map(async (question, questionIndex) => ({
          question,
          questionIndex,
          answer: answerForQuestion(question, questionIndex),
          ...(await buildBlindRequest({
            voterNpub: voter.npub,
            ballotScope: ballotScopeForQuestion(question, questionIndex),
          })),
        })));

        const requestIds = new Set(requestEntries.map((entry) => entry.request.requestId));
        const helperSeenRequestIds = new Set<string>();
        for (let attempt = 1; attempt <= requestRetryLimit; attempt += 1) {
          const pendingEntries = requestEntries.filter((entry) => !helperSeenRequestIds.has(entry.request.requestId));
          if (pendingEntries.length === 0) {
            break;
          }
          const publishFailures: string[] = [];
          await runWithConcurrency(pendingEntries, Math.min(5, pendingEntries.length), async (entry) => {
            try {
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
            } catch (error) {
              publishFailures.push(`${entry.question.questionId}: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
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
    } else {
      const submissionJobs: LiveRustHelperSubmissionJob[] = voters.map((voter, voterIndex) => ({
        voter,
        voterIndex,
        questionIndex: null,
        answers,
        ballotScope: null,
      }));
      process.stdout.write(`Submitting ${submissionJobs.length} blind response job(s)...\n`);

      await runWithConcurrency(submissionJobs, submissionConcurrency, async (job) => {
        const voter = job.voter;
        const voterLabel = `voter ${job.voterIndex + 1}/${voters.length}`;
        const submissionDelayMs = randomDelayMs(responseDelayMinMs, responseDelayMaxMs);
        if (submissionDelayMs > 0) {
          await sleep(submissionDelayMs);
        }
        workerExit.assertRunning();
        const entry = await buildBlindRequest({
          voterNpub: voter.npub,
          ballotScope: null,
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
        ballotScope: null,
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
          const entries = await fetchQuestionnaireBlindResponses({
            questionnaireId,
            relays,
            readRelayLimit,
            preferKindOnly: true,
            limit: Math.max(100, expectedSubmissionCount),
            maxPages: Math.max(16, Math.ceil(expectedSubmissionCount / 500) + 2),
            timeBudgetMs: Math.min(timeoutMs, Math.max(60_000, intervalMs * 4)),
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
          const events = await queryDecisionEvents(relays, worker.hex, Math.max(100, expectedSubmissionCount));
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

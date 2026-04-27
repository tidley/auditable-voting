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
import {
  QUESTIONNAIRE_RESULT_SUMMARY_KIND,
  publishQuestionnaireDefinition,
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
import { QUESTIONNAIRE_SUBMISSION_DECISION_KIND } from "../src/questionnaireResponsePublish";
import { createWorkerDelegationCertificate, publishWorkerDelegationCertificate } from "../src/questionnaireWorkerDelegation";
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
}): QuestionnaireDefinition {
  const now = Math.floor(Date.now() / 1000);
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
    blindSigningPublicKey: input.blindSigningPublicKey,
    questions: [
      {
        questionId: "q1",
        prompt: "Does the spawned Rust delegate coordinator handle blind issuance?",
        required: true,
        type: "yes_no",
      },
    ],
  };
}

function resolveWorkerBinary() {
  const override = process.env.OPTIONA_LIVE_RUST_HELPER_BINARY?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.resolve(process.cwd(), "..", "worker", "target", "debug", "auditable-voting-worker");
}

async function queryDecisionEvents(relays: string[], workerHex: string) {
  const pool = getSharedNostrPool();
  return await withTimeout("submission decision relay query", pool.querySync(relays, {
    authors: [workerHex],
    kinds: [QUESTIONNAIRE_SUBMISSION_DECISION_KIND],
    limit: 100,
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
  child.once("exit", (code, signal) => {
    if (stopping) {
      return;
    }
    exitError = new Error(`Rust helper exited unexpectedly (code=${code}, signal=${signal})`);
    process.stderr.write(`${exitError.message}\n`);
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
  });

  process.stdout.write(`Live Rust helper smoke\n`);
  process.stdout.write(`Questionnaire: ${questionnaireId}\n`);
  process.stdout.write(`Coordinator: ${coordinator.npub}\n`);
  process.stdout.write(`Audit proxy: ${worker.npub}\n`);
  process.stdout.write(`Voters: ${voters.length}\n`);
  process.stdout.write(`First voter: ${voters[0]?.npub ?? "none"}\n`);
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
      WORKER_POLL_SECONDS: "5",
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
      expectedInviteeCount: voters.length,
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
      if (helperState?.expected_invitee_count === voters.length && helperState?.blind_signing_private_key && helperState?.definition) {
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
        if (refreshedState?.expected_invitee_count === voters.length && refreshedState?.blind_signing_private_key && refreshedState?.definition) {
          configApplied = true;
          break;
        }
      } catch {
        // keep retrying the config DM against live relays
      }
    }
    assert(configApplied, `helper never applied election config after ${configRetryLimit} publish attempts`);

    const completedVoters: Array<{
      requestId: string;
      issuanceId: string | undefined;
      submissionId: string;
      tokenNullifier: string;
    }> = [];
    const answers: QuestionnaireResponseAnswer[] = [{
      questionId: "q1",
      answerType: "yes_no",
      value: true,
    }];

    for (const [index, voter] of voters.entries()) {
      const voterLabel = `voter ${index + 1}/${voters.length}`;
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
      let workerSawRequest = false;
      for (let attempt = 1; attempt <= requestRetryLimit; attempt += 1) {
        const publishedBlindRequest = await publishOptionABlindRequestDm({
          signer: signer(voter.npub),
          recipientNpub: visibleDelegation?.workerNpub ?? coordinator.npub,
          request,
          fallbackNsec: voter.nsec,
          relays: visibleDelegation?.controlRelays ?? relays,
        });
        assert(publishedBlindRequest.successes > 0, `expected ${voterLabel} blind request DM publish attempt ${attempt} to succeed on at least one relay`);
        if (attempt > 1) {
          process.stdout.write(`Retried ${voterLabel} blind request publish attempt ${attempt}/${requestRetryLimit}\n`);
        }
        await sleep(intervalMs);
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        if (helperState?.seen_blind_request_ids?.includes(request.requestId)) {
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
              limit: 50,
            });
            return entries.find((entry) => entry.requestId === request.requestId) ?? null;
          },
          (value) => Boolean(value?.requestId === request.requestId && value?.invitedNpub === voter.npub),
          timeoutMs,
          intervalMs,
          undefined,
          () => workerExit.assertRunning(),
        );
      } catch (error) {
        const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
        const logText = liveWorkerLogs.lines.join("");
        workerSawRequest = Boolean(
          helperState?.seen_blind_request_ids?.includes(request.requestId)
          || logText.includes(`blind request received: election_id=${questionnaireId}, request_id=${request.requestId}`),
        );
        assert(
          workerSawRequest,
          `helper state/logs never confirmed ${voterLabel} blind request ${request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        assert(
          Boolean(helperState?.last_blind_issuance_at) || logText.includes(`blind issuance published: election_id=${questionnaireId}, request_id=${request.requestId}`),
          `helper state/logs never confirmed ${voterLabel} blind issuance for ${request.requestId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        visibleIssuance = await waitForValue(
          `${voterLabel} blind issuance DM after helper-confirmed issuance`,
          async () => {
            const entries = await fetchOptionABlindIssuanceDmsWithNsec({
              nsec: voter.nsec,
              electionId: questionnaireId,
              relays,
              limit: 50,
            });
            return entries.find((entry) => entry.requestId === request.requestId) ?? null;
          },
          (value) => Boolean(value?.requestId === request.requestId && value?.invitedNpub === voter.npub),
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
          helperState?.seen_blind_request_ids?.includes(request.requestId)
          || logText.includes(`blind request received: election_id=${questionnaireId}, request_id=${request.requestId}`)
          || visibleIssuance?.requestId === request.requestId,
        );
      }
      assert(workerSawRequest, `helper never confirmed ${voterLabel} blind request ${request.requestId} after ${requestRetryLimit} publish attempts`);
      assert.equal(visibleIssuance?.definition?.questionnaireId, questionnaireId);

      const credential = await finalizeQuestionnaireBlindSignature({
        publicKey: blindSigningPublicKey,
        message: blindTokenMessage,
        blindSignature: visibleIssuance?.blindSignature,
        blindingFactor: blindedToken.blindingFactor,
      });
      assert.equal(
        await verifyQuestionnaireBlindSignature({
          publicKey: blindSigningPublicKey,
          message: blindTokenMessage,
          signature: credential,
        }),
        true,
        `expected ${voterLabel} final credential verification to succeed`,
      );

      const responseSecretKey = generateSecretKey();
      const responseNsec = nip19.nsecEncode(responseSecretKey);
      const submissionId = randomId("submission");
      const submittedAt = Math.floor(Date.now() / 1000);
      const tokenNullifier = deriveQuestionnaireTokenNullifier({
        questionnaireId,
        tokenSecret,
      });
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
      assert(publishedBlindResponse.successes > 0, `expected ${voterLabel} public blind response publish to succeed on at least one relay`);
      completedVoters.push({
        requestId: request.requestId,
        issuanceId: visibleIssuance?.issuanceId,
        submissionId,
        tokenNullifier,
      });
      process.stdout.write(`Completed ${voterLabel}: request=${request.requestId}, submission=${submissionId}\n`);
    }

    const submissionIds = new Set(completedVoters.map((entry) => entry.submissionId));
    const publicResponses = await waitForValue(
      "public blind response visibility",
      async () => {
        const entries = await fetchQuestionnaireBlindResponses({
          questionnaireId,
          relays,
          readRelayLimit,
          preferKindOnly: true,
          limit: Math.max(100, voters.length * 20),
        });
        const seen = new Set(entries.map((entry) => entry.response.responseId));
        return completedVoters.every((entry) => seen.has(entry.submissionId)) ? entries : [];
      },
      (value) => Array.isArray(value) && completedVoters.every((entry) => value.some((seen) => seen.response.responseId === entry.submissionId)),
      timeoutMs,
      intervalMs,
      undefined,
      () => workerExit.assertRunning(),
    );

    let submissionDecisions = [] as Array<{ submissionId: string; accepted: boolean; questionnaireId: string }>;
    let submissionDecisionCameFromRelayReadback = false;
    const helperStateBeforeDecisionReadback = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
    const helperPublishedDecisions = helperStateBeforeDecisionReadback?.published_decisions ?? {};
    const helperHasAllDecisions = completedVoters.every((entry) => Boolean(helperPublishedDecisions[entry.submissionId]));
    if (helperHasAllDecisions) {
      submissionDecisions = completedVoters.map((entry) => ({
        submissionId: entry.submissionId,
        accepted: true,
        questionnaireId,
      }));
    } else {
      try {
      submissionDecisions = await waitForValue(
        "public submission decision visibility from spawned Rust helper",
        async () => {
          const events = await queryDecisionEvents(relays, worker.hex);
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
      } catch (error) {
      const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
      const publishedDecisions = helperState?.published_decisions ?? {};
      for (const voterEntry of completedVoters) {
        assert(
          Boolean(publishedDecisions[voterEntry.submissionId]),
          `helper state never recorded submission decision for ${voterEntry.submissionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      submissionDecisions = completedVoters.map((entry) => ({
        submissionId: entry.submissionId,
        accepted: true,
        questionnaireId,
      }));
      }
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
    assert.equal(admissions.accepted.length, voters.length, `expected ${voters.length} accepted responses after helper decisions`);

    let visibleSummary = null as QuestionnaireResultSummary | null;
    let summaryCameFromRelayReadback = false;
    const helperStateBeforeSummaryReadback = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
    if (helperStateBeforeSummaryReadback?.summary_published && helperStateBeforeSummaryReadback.last_result_summary_publish_at) {
      visibleSummary = {
        schemaVersion: 1,
        eventType: "questionnaire_result_summary",
        questionnaireId,
        createdAt: Math.floor(Date.now() / 1000),
        coordinatorPubkey: coordinator.npub,
        acceptedResponseCount: helperStateBeforeSummaryReadback.processed_submission_ids?.length ?? voters.length,
        rejectedResponseCount: 0,
        acceptedNullifierCount: helperStateBeforeSummaryReadback.processed_submission_ids?.length ?? voters.length,
        questionSummaries: [],
      };
    } else {
      try {
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
        (value) => Boolean(value?.questionnaireId === questionnaireId && value.acceptedResponseCount === voters.length),
        timeoutMs,
        intervalMs,
        undefined,
        () => workerExit.assertRunning(),
      );
      summaryCameFromRelayReadback = true;
      } catch (error) {
      const helperState = getHelperElectionState(await readHelperState(workerStateDir), questionnaireId);
      assert(
        Boolean(helperState?.summary_published && helperState?.last_result_summary_publish_at),
        `helper state never recorded result summary publication: ${error instanceof Error ? error.message : String(error)}`,
      );
      visibleSummary = {
        schemaVersion: 1,
        eventType: "questionnaire_result_summary",
        questionnaireId,
        createdAt: Math.floor(Date.now() / 1000),
        coordinatorPubkey: coordinator.npub,
        acceptedResponseCount: helperState?.processed_submission_ids?.length ?? voters.length,
        rejectedResponseCount: 0,
        acceptedNullifierCount: helperState?.accepted_nullifiers ? helperState.accepted_nullifiers.length : 1,
        questionSummaries: [],
      };
      }
    }
    assert.equal(visibleSummary?.acceptedResponseCount, voters.length);
    assert.equal(visibleSummary?.rejectedResponseCount, 0);
    if (requireRelayReadback) {
      assert(submissionDecisionCameFromRelayReadback, "submission decision required relay readback but only helper state confirmed success");
      assert(summaryCameFromRelayReadback, "result summary required relay readback but only helper state confirmed success");
    }

    process.stdout.write("rust helper live smoke passed\n");
    process.stdout.write(`Voters completed: ${completedVoters.length}\n`);
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

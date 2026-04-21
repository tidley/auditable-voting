import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { SimplePool } from "nostr-tools";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEBUG_DIR = path.resolve(process.cwd(), ".planning/debug/live-harness");
const relayProbePool = new SimplePool({
  enablePing: true,
  enableReconnect: true,
});

function envInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function deriveHarnessTimeoutMs({
  startupWaitMs,
  roundWaitMs,
  ticketWaitMs,
  roundCount,
}) {
  return startupWaitMs + (roundCount * (roundWaitMs + ticketWaitMs + 20000)) + 120000;
}

function isQuestionnaireFlowDeployment(deploymentMode = "course_feedback") {
  return deploymentMode === "course_feedback"
    || deploymentMode === "legacy"
    || deploymentMode === "option_a";
}

function classifyHarnessFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Harness timeout after/i.test(message)) {
    return "protocol_timeout";
  }
  if (/Target page, context or browser has been closed/i.test(message)) {
    return "browser_resource_collapse";
  }
  if (/Timeout .*exceeded/i.test(message) || /waiting for/i.test(message)) {
    return "harness_failure";
  }
  return "unknown_failure";
}

function classifyProtocolFailure(rounds, deploymentMode = "course_feedback") {
  const latestRound = rounds.at(-1) ?? null;
  if (!latestRound?.stageMetrics) {
    return {
      protocolFailureClass: "startup",
      firstMissingStage: isQuestionnaireFlowDeployment(deploymentMode)
        ? "questionnaireSeen"
        : "roundSeen",
    };
  }

  const stageMetrics = latestRound.stageMetrics;
  if (isQuestionnaireFlowDeployment(deploymentMode)) {
    const firstMissingStage = [
      "questionnaireSeen",
      "questionnaireOpen",
      "responsePublished",
      "resultSummaryPublished",
    ].find((stageName) => Number(stageMetrics[stageName]?.count ?? 0) === 0) ?? null;
    const questionnaireSeen = Number(stageMetrics.questionnaireSeen?.count ?? 0);
    const responsePublished = Number(stageMetrics.responsePublished?.count ?? 0);
    const resultSummaryPublished = Number(stageMetrics.resultSummaryPublished?.count ?? 0);
    let protocolFailureClass = "mixed";
    if (questionnaireSeen === 0) {
      protocolFailureClass = "startup";
    } else if (responsePublished > 0 || resultSummaryPublished > 0) {
      protocolFailureClass = "dm_pipeline";
    }
    return {
      protocolFailureClass,
      firstMissingStage,
    };
  }

  const firstMissingStage = [
    "roundSeen",
    "blindKeySeen",
    "blindedRequestSent",
    "ticketSent",
    "ticketDeliveryConfirmed",
  ].find((stageName) => Number(stageMetrics[stageName]?.count ?? 0) === 0) ?? null;

  const roundSeen = Number(stageMetrics.roundSeen?.count ?? 0);
  const requestSeen = Number(stageMetrics.blindedRequestSent?.count ?? 0);
  const ticketSent = Number(stageMetrics.ticketSent?.count ?? 0);
  const completionSeen = Number(stageMetrics.ticketDeliveryConfirmed?.count ?? 0);

  let protocolFailureClass = "mixed";
  if (roundSeen === 0 && requestSeen === 0) {
    protocolFailureClass = "startup";
  } else if (roundSeen > 0 && (requestSeen > 0 || ticketSent > 0 || completionSeen > 0)) {
    protocolFailureClass = "dm_pipeline";
  }

  return {
    protocolFailureClass,
    firstMissingStage,
  };
}

function classifyStartupJoinFailure(snapshots) {
  const coordinatorSnapshots = snapshots.filter((snapshot) => snapshot.label.startsWith("coord"));
  return coordinatorSnapshots.map((snapshot) => {
    const startup = snapshot.coordinatorDebug?.startupDiagnostics ?? null;
    const readiness = snapshot.coordinatorDebug?.runtimeReadiness ?? null;
    const engineStatus = snapshot.coordinatorDebug?.engineStatus ?? null;
    const bucket = startup?.startupJoinFailureBucket ?? null;
    return {
      coordinator: snapshot.label,
      bucket,
      phase: readiness?.phase ?? null,
      joinedGroup: engineStatus?.joined_group ?? null,
      groupReady: engineStatus?.group_ready ?? null,
      startupDiagnostics: startup,
    };
  });
}

async function ensureDebugDir() {
  await mkdir(DEBUG_DIR, { recursive: true });
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function splitIntoBatches(items, batchSize) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : items.length;
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

function batchStageCount(stageMap, voterIds) {
  return voterIds.reduce((count, voterId) => count + (stageMap.has(voterId) ? 1 : 0), 0);
}

async function runCommandOrThrow({ cmd, args, cwd }) {
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runCourseFeedbackPreflight({ skip = false } = {}) {
  if (skip) {
    return { skipped: true, passed: true };
  }
  const runningFromWebDir = path.basename(process.cwd()) === "web";
  const args = runningFromWebDir
    ? ["run", "test:course-feedback-preflight"]
    : ["--prefix", "web", "run", "test:course-feedback-preflight"];
  await runCommandOrThrow({
    cmd: "npm",
    args,
    cwd: process.cwd(),
  });
  return { skipped: false, passed: true };
}

async function loadCheckpoint(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCheckpoint(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function createTimelineArtifact(input) {
  return {
    runId: input.runId,
    startedAtMs: input.startedAtMs,
    config: {
      coordinators: input.coordinatorCount,
      voters: input.voterCount,
      rounds: input.roundCount,
      deploymentMode: input.deploymentMode,
    },
    globalTimeline: [],
    coordinatorTimeline: [],
    voterTimelines: {},
    finalSnapshot: null,
    summary: null,
    _seenKeys: new Set(),
  };
}

function timelineEventTMs(timeline, nowMs = Date.now()) {
  return Math.max(0, nowMs - timeline.startedAtMs);
}

function recordTimelineEvent(timeline, actor, kind, details = null) {
  const event = {
    tMs: timelineEventTMs(timeline),
    actor,
    kind,
    ...(details ? { details } : {}),
  };
  timeline.globalTimeline.push(event);
  if (actor.startsWith("coord")) {
    timeline.coordinatorTimeline.push(event);
    return;
  }
  if (!timeline.voterTimelines[actor]) {
    timeline.voterTimelines[actor] = [];
  }
  timeline.voterTimelines[actor].push(event);
}

function recordTimelineEventOnce(timeline, dedupeKey, actor, kind, details = null) {
  if (timeline._seenKeys.has(dedupeKey)) {
    return;
  }
  timeline._seenKeys.add(dedupeKey);
  recordTimelineEvent(timeline, actor, kind, details);
}

function deriveVoterPhase(debug) {
  if (!debug) {
    return "no_debug_state";
  }
  if (debug.responsePublished) {
    return "response_published";
  }
  if (debug.questionnaireOpen) {
    return "questionnaire_open";
  }
  if (debug.questionnaireSeen) {
    return "questionnaire_seen";
  }
  return "waiting_for_questionnaire";
}

function buildQuestionnaireFinalSnapshotFromRound(roundState) {
  const coordinator = roundState?.coordinatorStates?.coord1?.questionnaireCoordinatorDebug ?? null;
  const voterEntries = Object.entries(roundState?.voterStates ?? {});
  const voters = Object.fromEntries(
    voterEntries.map(([label, state]) => {
      const voterDebug = state?.questionnaireVoterDebug ?? null;
      return [label, {
        questionnaireSeen: Boolean(voterDebug?.questionnaireSeen),
        questionnaireOpen: Boolean(voterDebug?.questionnaireOpen),
        eligibilityRequested: false,
        blindIssueReceived: false,
        tokenReady: false,
        responsePublished: Boolean(voterDebug?.responsePublished),
        currentPhase: deriveVoterPhase(voterDebug),
      }];
    }),
  );
  return {
    coordinator: {
      phase: coordinator?.status ?? null,
      questionnaireId: coordinator?.questionnaireId ?? null,
      questionnairePublishAttempted: Boolean(coordinator?.definitionPublishDiagnostic?.attempted),
      questionnairePublishSucceeded: Boolean(coordinator?.definitionPublishDiagnostic?.succeeded),
      questionnaireOpenPublishAttempted: Boolean(coordinator?.statePublishDiagnostic?.attempted),
      questionnaireOpenPublishSucceeded: Boolean(coordinator?.statePublishDiagnostic?.succeeded),
      eligibilityRequestsReceived: 0,
      blindIssuesSucceeded: 0,
      responsesSeen: Number(coordinator?.responseEventCount ?? 0),
      responsesAccepted: Number(coordinator?.latestAcceptedCount ?? 0),
      responsesRejected: Number(coordinator?.latestRejectedCount ?? 0),
    },
    voters,
  };
}

function buildQuestionnaireFinalSnapshotFromActorSnapshots(snapshots) {
  const coordinatorSnapshot = snapshots.find((entry) => entry.label === "coord1");
  const coordinatorDebug = coordinatorSnapshot?.questionnaireCoordinatorDebug ?? null;
  const voters = Object.fromEntries(
    snapshots
      .filter((entry) => entry.label.startsWith("voter"))
      .map((entry) => {
        const voterDebug = entry.questionnaireVoterDebug ?? null;
        return [entry.label, {
          questionnaireSeen: Boolean(voterDebug?.questionnaireSeen),
          questionnaireOpen: Boolean(voterDebug?.questionnaireOpen),
          eligibilityRequested: false,
          blindIssueReceived: false,
          tokenReady: false,
          responsePublished: Boolean(voterDebug?.responsePublished),
          currentPhase: deriveVoterPhase(voterDebug),
        }];
      }),
  );
  return {
    coordinator: {
      phase: coordinatorDebug?.status ?? null,
      questionnaireId: coordinatorDebug?.questionnaireId ?? null,
      questionnairePublishAttempted: Boolean(coordinatorDebug?.definitionPublishDiagnostic?.attempted),
      questionnairePublishSucceeded: Boolean(coordinatorDebug?.definitionPublishDiagnostic?.succeeded),
      questionnaireOpenPublishAttempted: Boolean(coordinatorDebug?.statePublishDiagnostic?.attempted),
      questionnaireOpenPublishSucceeded: Boolean(coordinatorDebug?.statePublishDiagnostic?.succeeded),
      eligibilityRequestsReceived: 0,
      blindIssuesSucceeded: 0,
      responsesSeen: Number(coordinatorDebug?.responseEventCount ?? 0),
      responsesAccepted: Number(coordinatorDebug?.latestAcceptedCount ?? 0),
      responsesRejected: Number(coordinatorDebug?.latestRejectedCount ?? 0),
    },
    voters,
  };
}

async function collectQuestionnaireTimelineEvents(input) {
  const {
    coordinators,
    voters,
    timeline,
    state,
  } = input;
  const lead = coordinators[0];
  if (!lead?.page) {
    return;
  }
  const coordinatorDebug = await readQuestionnaireCoordinatorDebug(lead.page);
  if (coordinatorDebug) {
    recordTimelineEventOnce(
      timeline,
      "coord1:runtime_ready",
      "coord1",
      "coordinator_runtime_ready",
    );
    recordTimelineEventOnce(
      timeline,
      "coord1:mode_selected",
      "coord1",
      "coordinator_mode_selected",
      { deploymentMode: "course_feedback" },
    );
    if (typeof coordinatorDebug.questionnaireId === "string" && coordinatorDebug.questionnaireId.trim()) {
      if (state.coordinatorQuestionnaireId !== coordinatorDebug.questionnaireId) {
        state.coordinatorQuestionnaireId = coordinatorDebug.questionnaireId;
        recordTimelineEventOnce(
          timeline,
          `coord1:questionnaire_id_set:${coordinatorDebug.questionnaireId}`,
          "coord1",
          "questionnaire_id_set",
          { questionnaireId: coordinatorDebug.questionnaireId },
        );
      }
    }
    const definitionPublish = coordinatorDebug.definitionPublishDiagnostic ?? null;
    if (definitionPublish?.attempted) {
      recordTimelineEventOnce(
        timeline,
        `coord1:questionnaire_publish_attempted:${coordinatorDebug.questionnaireId ?? "unknown"}`,
        "coord1",
        "questionnaire_publish_attempted",
        { questionnaireId: coordinatorDebug.questionnaireId ?? null },
      );
    }
    if (definitionPublish?.succeeded) {
      recordTimelineEventOnce(
        timeline,
        `coord1:questionnaire_publish_succeeded:${definitionPublish.eventId ?? "none"}`,
        "coord1",
        "questionnaire_publish_succeeded",
        {
          questionnaireId: coordinatorDebug.questionnaireId ?? null,
          eventId: definitionPublish.eventId ?? null,
        },
      );
    }
    const statePublish = coordinatorDebug.statePublishDiagnostic ?? null;
    if (statePublish?.attempted) {
      recordTimelineEventOnce(
        timeline,
        `coord1:questionnaire_open_publish_attempted:${coordinatorDebug.questionnaireId ?? "unknown"}`,
        "coord1",
        "questionnaire_open_publish_attempted",
        { questionnaireId: coordinatorDebug.questionnaireId ?? null },
      );
    }
    if (statePublish?.succeeded) {
      recordTimelineEventOnce(
        timeline,
        `coord1:questionnaire_open_publish_succeeded:${statePublish.eventId ?? "none"}`,
        "coord1",
        "questionnaire_open_publish_succeeded",
        {
          questionnaireId: coordinatorDebug.questionnaireId ?? null,
          eventId: statePublish.eventId ?? null,
        },
      );
    }
    const responseCount = Number(coordinatorDebug.responseEventCount ?? 0);
    if (responseCount > state.lastCoordinatorResponseCount) {
      for (let count = state.lastCoordinatorResponseCount + 1; count <= responseCount; count += 1) {
        recordTimelineEvent(
          timeline,
          "coord1",
          "response_event_seen",
          { observedCount: count },
        );
        recordTimelineEvent(
          timeline,
          "coord1",
          "response_decrypt_attempted",
          { observedCount: count },
        );
        recordTimelineEvent(
          timeline,
          "coord1",
          "response_decrypt_succeeded",
          { observedCount: count },
        );
      }
      state.lastCoordinatorResponseCount = responseCount;
    }
    const acceptedCount = Number(coordinatorDebug.latestAcceptedCount ?? 0);
    if (acceptedCount > state.lastCoordinatorAcceptedCount) {
      for (let count = state.lastCoordinatorAcceptedCount + 1; count <= acceptedCount; count += 1) {
        recordTimelineEvent(
          timeline,
          "coord1",
          "response_accepted",
          { acceptedCount: count },
        );
      }
      state.lastCoordinatorAcceptedCount = acceptedCount;
    }
    const rejectedCount = Number(coordinatorDebug.latestRejectedCount ?? 0);
    if (rejectedCount > state.lastCoordinatorRejectedCount) {
      for (let count = state.lastCoordinatorRejectedCount + 1; count <= rejectedCount; count += 1) {
        recordTimelineEvent(
          timeline,
          "coord1",
          "response_rejected",
          { rejectedCount: count },
        );
      }
      state.lastCoordinatorRejectedCount = rejectedCount;
    }
    const resultPublish = coordinatorDebug.resultPublishDiagnostic ?? null;
    if (resultPublish?.attempted) {
      recordTimelineEventOnce(
        timeline,
        "coord1:result_summary_publish_attempted",
        "coord1",
        "result_summary_publish_attempted",
      );
    }
    if (resultPublish?.succeeded) {
      recordTimelineEventOnce(
        timeline,
        `coord1:result_summary_publish_succeeded:${resultPublish.eventId ?? "none"}`,
        "coord1",
        "result_summary_publish_succeeded",
        { eventId: resultPublish.eventId ?? null },
      );
    }
    if (coordinatorDebug.latestResultAcceptedCount !== null && coordinatorDebug.latestResultAcceptedCount !== undefined) {
      recordTimelineEventOnce(
        timeline,
        `coord1:result_summary_publish_succeeded:fallback:${coordinatorDebug.latestResultAcceptedCount}`,
        "coord1",
        "result_summary_publish_succeeded",
        { acceptedCount: Number(coordinatorDebug.latestResultAcceptedCount) },
      );
    }
  }

  for (const actor of voters) {
    const voterDebug = await readQuestionnaireVoterDebug(actor.page);
    if (!voterDebug) {
      continue;
    }
    const voterLabel = actor.label;
    recordTimelineEventOnce(
      timeline,
      `${voterLabel}:runtime_ready`,
      voterLabel,
      "voter_runtime_ready",
    );
    if (typeof voterDebug.questionnaireId === "string" && voterDebug.questionnaireId.trim()) {
      const previousQuestionnaireId = state.voterQuestionnaireIds[voterLabel] ?? null;
      if (previousQuestionnaireId !== voterDebug.questionnaireId) {
        state.voterQuestionnaireIds[voterLabel] = voterDebug.questionnaireId;
        recordTimelineEventOnce(
          timeline,
          `${voterLabel}:questionnaire_id_set:${voterDebug.questionnaireId}`,
          voterLabel,
          "questionnaire_id_set",
          { questionnaireId: voterDebug.questionnaireId },
        );
      }
    }
    if (voterDebug.questionnaireSeen) {
      recordTimelineEventOnce(
        timeline,
        `${voterLabel}:questionnaire_seen`,
        voterLabel,
        "questionnaire_seen",
      );
    }
    if (voterDebug.questionnaireOpen) {
      recordTimelineEventOnce(
        timeline,
        `${voterLabel}:questionnaire_open_seen`,
        voterLabel,
        "questionnaire_open_seen",
      );
    }
    if (typeof voterDebug.status === "string" && /Submitting encrypted response/i.test(voterDebug.status)) {
      recordTimelineEventOnce(
        timeline,
        `${voterLabel}:response_publish_attempted`,
        voterLabel,
        "response_publish_attempted",
      );
    }
    if (voterDebug.responsePublished) {
      recordTimelineEventOnce(
        timeline,
        `${voterLabel}:response_publish_succeeded`,
        voterLabel,
        "response_publish_succeeded",
        { submittedCount: Number(voterDebug.responseSubmittedCount ?? 0) },
      );
    }
    if (voterDebug.latestResultAcceptedCount !== null && voterDebug.latestResultAcceptedCount !== undefined) {
      recordTimelineEventOnce(
        timeline,
        `${voterLabel}:result_summary_seen`,
        voterLabel,
        "result_summary_seen",
        { acceptedCount: Number(voterDebug.latestResultAcceptedCount) },
      );
    }
  }
}

async function runRelayProbe(input) {
  const relay = String(input?.relay ?? "").trim();
  const kind = Number(input?.kind ?? 0);
  const mailboxId = typeof input?.mailboxId === "string" ? input.mailboxId.trim() : "";
  const etype = typeof input?.etype === "string" ? input.etype.trim() : "";
  const eventId = typeof input?.eventId === "string" ? input.eventId.trim() : "";
  const ticketId = typeof input?.ticketId === "string" ? input.ticketId.trim() : "";
  const requestId = typeof input?.requestId === "string" ? input.requestId.trim() : "";

  if (!relay || !Number.isFinite(kind) || kind <= 0) {
    return null;
  }

  const filters = [
    {
      name: "kind_only",
      filter: { kinds: [kind], limit: 200 },
    },
    {
      name: "kind_mailbox",
      filter: { kinds: [kind], "#mailbox": mailboxId ? [mailboxId] : undefined, limit: 200 },
    },
    {
      name: "kind_mailbox_etype",
      filter: {
        kinds: [kind],
        "#mailbox": mailboxId ? [mailboxId] : undefined,
        "#etype": etype ? [etype] : undefined,
        limit: 200,
      },
    },
  ];

  const probes = [];
  const queryWithTimeout = async (relay, filter, timeoutMs = 8000) => {
    let timeoutId;
    try {
      return await Promise.race([
        relayProbePool.querySync([relay], filter),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Relay probe timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          timeoutId.unref?.();
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };
  for (const entry of filters) {
    const filter = Object.fromEntries(
      Object.entries(entry.filter).filter(([, value]) => value !== undefined),
    );
    try {
      const events = await queryWithTimeout(relay, filter, 8000);
      probes.push({
        name: entry.name,
        relay,
        filter,
        count: events.length,
        matchedEventId: Boolean(eventId) && events.some((event) => event.id === eventId),
        matchedTicketTag: Boolean(ticketId) && events.some((event) => (
          Array.isArray(event.tags) && event.tags.some((tag) => tag[0] === "ticket" && tag[1] === ticketId)
        )),
        matchedRequestTag: Boolean(requestId) && events.some((event) => (
          Array.isArray(event.tags) && event.tags.some((tag) => tag[0] === "request" && tag[1] === requestId)
        )),
      });
    } catch (error) {
      probes.push({
        name: entry.name,
        relay,
        filter,
        error: safeErrorMessage(error),
      });
    }
  }
  return probes;
}

async function runQuestionnaireRelayProbe(input) {
  const relay = String(input?.relay ?? "").trim();
  const kind = Number(input?.kind ?? 0);
  const questionnaireId = String(input?.questionnaireId ?? "").trim();
  const tTag = String(input?.tTag ?? "").trim();
  const eventId = String(input?.eventId ?? "").trim();
  const author = String(input?.author ?? "").trim();
  if (!relay || !Number.isFinite(kind) || kind <= 0 || !questionnaireId) {
    return null;
  }

  const filters = [
    {
      name: "kind_only",
      filter: { kinds: [kind], limit: 200 },
    },
    {
      name: "kind_questionnaire_id",
      filter: { kinds: [kind], "#questionnaire-id": [questionnaireId], limit: 200 },
    },
    {
      name: "kind_questionnaire_id_t",
      filter: {
        kinds: [kind],
        "#questionnaire-id": [questionnaireId],
        ...(tTag ? { "#t": [tTag] } : {}),
        limit: 200,
      },
    },
    {
      name: "kind_author",
      filter: {
        kinds: [kind],
        ...(author ? { authors: [author] } : {}),
        limit: 200,
      },
    },
  ];

  const probes = [];
  const queryWithTimeout = async (targetRelay, filter, timeoutMs = 8000) => {
    let timeoutId;
    try {
      return await Promise.race([
        relayProbePool.querySync([targetRelay], filter),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error(`Relay probe timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          timeoutId.unref?.();
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  };

  for (const entry of filters) {
    try {
      const events = await queryWithTimeout(relay, entry.filter);
      probes.push({
        name: entry.name,
        relay,
        filter: entry.filter,
        count: events.length,
        matchedEventId: Boolean(eventId) && events.some((event) => event.id === eventId),
      });
    } catch (error) {
      probes.push({
        name: entry.name,
        relay,
        filter: entry.filter,
        error: safeErrorMessage(error),
      });
    }
  }
  return probes;
}

function pageRuntimeState(page) {
  return {
    browserConnected: page.context().browser()?.isConnected?.() ?? false,
    contextClosed: page.context().pages().length === 0 && page.isClosed(),
    pageClosed: page.isClosed(),
  };
}

async function isPageAlive(page) {
  if (page.isClosed()) {
    return false;
  }
  const browser = page.context().browser();
  if (browser && typeof browser.isConnected === "function" && !browser.isConnected()) {
    return false;
  }
  return true;
}

async function snapshotPage(actor, reason) {
  const label = actor.label.replace(/[^a-z0-9_-]/gi, "_");
  const prefix = `${Date.now()}-${label}-${reason.replace(/[^a-z0-9_-]/gi, "_")}`;
  const htmlPath = path.join(DEBUG_DIR, `${prefix}.html`);
  const pngPath = path.join(DEBUG_DIR, `${prefix}.png`);
  const metaPath = path.join(DEBUG_DIR, `${prefix}.json`);
  const meta = {
    label: actor.label,
    reason,
    url: null,
    body: null,
    coordinatorDebug: null,
    questionnaireCoordinatorDebug: null,
    voterDebug: null,
    questionnaireVoterDebug: null,
    ticketLifecycleTraces: [],
    runtime: pageRuntimeState(actor.page),
    screenshotPath: pngPath,
    htmlPath,
    captureError: null,
  };

  try {
    meta.url = actor.page.url();
    if (await isPageAlive(actor.page)) {
      const html = await actor.page.content().catch(() => null);
      const body = await actor.page.locator("body").innerText().catch(() => null);
      const traces = await readTicketLifecycleTraces(actor.page).catch(() => []);
      const coordinatorDebug = await readCoordinatorDebug(actor.page).catch(() => null);
      const questionnaireCoordinatorDebug = await readQuestionnaireCoordinatorDebug(actor.page).catch(() => null);
      const voterDebug = await readVoterDebug(actor.page).catch(() => null);
      const questionnaireVoterDebug = await readQuestionnaireVoterDebug(actor.page).catch(() => null);
      meta.body = typeof body === "string" ? body.replace(/\s+/g, " ").trim() : null;
      meta.coordinatorDebug = coordinatorDebug;
      meta.questionnaireCoordinatorDebug = questionnaireCoordinatorDebug;
      meta.voterDebug = voterDebug;
      meta.questionnaireVoterDebug = questionnaireVoterDebug;
      meta.ticketLifecycleTraces = Array.isArray(traces) ? traces : [];
      if (typeof html === "string") {
        await writeFile(htmlPath, html, "utf8");
      }
      await actor.page.screenshot({ path: pngPath, fullPage: true }).catch(() => undefined);
    }
  } catch (error) {
    meta.captureError = safeErrorMessage(error);
  }

  await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return meta;
}

async function snapshotAllActors(actors, reason) {
  await ensureDebugDir();
  return Promise.all(actors.map((actor) => snapshotPage(actor, reason)));
}

async function getNpub(page) {
  await ensureTab(page, "Settings");
  const codeLocator = page.locator("code.simple-identity-code").first();
  if (await codeLocator.count()) {
    await codeLocator.waitFor({ state: "attached", timeout: 30000 });
    const text = (await codeLocator.textContent())?.trim();
    if (text) {
      return text;
    }
  }

  const copyButton = page.getByRole("button", { name: /Copy npub/i }).first();
  if (await copyButton.count()) {
    await copyButton.waitFor({ state: "visible", timeout: 30000 });
    const identityField = page.locator(".simple-identity-field").first();
    const identityCode = identityField.locator("code.simple-identity-code").first();
    if (await identityCode.count()) {
      const text = (await identityCode.textContent())?.trim();
      if (text) {
        return text;
      }
    }
  }

  const indexedDbNpub = await withTimeout(page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("auditable-voting-simple", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open IndexedDB."));
    });

    const roles = ["coordinator", "voter"];
    for (const role of roles) {
      const value = await new Promise((resolve, reject) => {
        const transaction = database.transaction("actor-state", "readonly");
        const store = transaction.objectStore("actor-state");
        const request = store.get(role);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error("Unable to read actor state."));
      });

      if (value && typeof value === "object" && "keypair" in value) {
        const npub = value.keypair?.npub;
        if (typeof npub === "string" && npub.trim()) {
          database.close();
          return npub.trim();
        }
      }
    }

    database.close();
    return null;
  }).catch(() => null), 8000, "getNpub(indexeddb)").catch(() => null);

  if (indexedDbNpub) {
    return indexedDbNpub;
  }

  const body = await readBody(page);
  const match = body.match(/npub1[023456789acdefghjklmnpqrstuvwxyz]+/i);
  if (match) {
    return match[0];
  }

  throw new Error("Could not find npub on page");
}

async function clickByText(page, role, name) {
  const locator = page.getByRole(role, { name }).first();
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click();
}

async function clickByTextIfAvailable(page, role, name, timeoutMs = 5000) {
  const locator = page.getByRole(role, { name }).first();
  if (await locator.count().catch(() => 0) === 0) {
    return false;
  }
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }
  if (await locator.isDisabled().catch(() => true)) {
    return false;
  }
  await locator.click();
  return true;
}

async function continueFromRoleLandingIfPresent(page, role) {
  const continueButton = page.getByRole("button", {
    name: new RegExp(`^Continue as ${role}$`, "i"),
  }).first();
  if (await continueButton.count().catch(() => 0) === 0) {
    return false;
  }
  try {
    await continueButton.waitFor({ state: "visible", timeout: 3000 });
  } catch {
    return false;
  }
  if (await continueButton.isDisabled().catch(() => true)) {
    return false;
  }
  await continueButton.click();
  await sleep(150);
  return true;
}

async function ensureVoterTab(page, name, actorLabel = "unknown-voter") {
  if (!(await isPageAlive(page))) {
    throw new Error(`Page is closed before ensureVoterTab(${name}) for ${actorLabel}`);
  }
  const tab = page.getByRole("tab", { name: new RegExp(`^${name}$`, "i") });
  try {
    if (await tab.count() > 0) {
      const first = tab.first();
      if (await first.isDisabled().catch(() => true)) {
        return false;
      }
      await first.click();
      await sleep(100);
      return true;
    }
  } catch (error) {
    if (await isPageAlive(page)) {
      await sleep(150);
      if (await tab.count().catch(() => 0) > 0) {
        const first = tab.first();
        if (await first.isDisabled().catch(() => true)) {
          return false;
        }
        await first.click();
        await sleep(100);
        return true;
      }
    }
    throw new Error(`ensureVoterTab(${name}) failed for ${actorLabel}: ${safeErrorMessage(error)}`);
  }
  const button = page.getByRole("button", { name: new RegExp(`^${name}$`, "i") });
  if (await button.count().catch(() => 0) === 0) {
    return false;
  }
  await button.first().click();
  await sleep(100);
  return true;
}

function tabNameCandidates(name) {
  const aliases = new Map([
    ["Configure", ["Build"]],
    ["Build", ["Configure"]],
    ["Voting", ["Build", "Responses"]],
    ["Responses", ["Voting"]],
  ]);
  return [name, ...(aliases.get(name) ?? [])];
}

async function ensureTab(page, name, actorLabel = "unknown-actor") {
  if (!(await isPageAlive(page))) {
    throw new Error(`Page is closed before ensureTab(${name}) for ${actorLabel}`);
  }
  const names = tabNameCandidates(name);
  try {
    for (const candidate of names) {
      const tab = page.getByRole("tab", { name: new RegExp(`^${candidate}$`, "i") });
      if (await tab.count() > 0) {
        await tab.first().click();
        await sleep(100);
        return true;
      }
    }
  } catch (error) {
    if (await isPageAlive(page)) {
      await sleep(150);
      for (const candidate of names) {
        const tab = page.getByRole("tab", { name: new RegExp(`^${candidate}$`, "i") });
        if (await tab.count().catch(() => 0) > 0) {
          await tab.first().click();
          await sleep(100);
          return true;
        }
      }
    }
    throw new Error(`ensureTab(${name}) failed for ${actorLabel}: ${safeErrorMessage(error)}`);
  }
  for (const candidate of names) {
    const button = page.getByRole("button", { name: new RegExp(`^${candidate}$`, "i") });
    if (await button.count().catch(() => 0) === 0) {
      continue;
    }
    await button.first().click();
    await sleep(100);
    return true;
  }
  return false;
}

async function coordinatorDiagnostics(page) {
  if (!(await isPageAlive(page))) {
    return ["PAGE_CLOSED"];
  }
  return page.locator(".simple-delivery-diagnostics").allInnerTexts().catch(() => []);
}

async function coordinatorFollowerRows(page) {
  if (!(await isPageAlive(page))) {
    return [];
  }
  const rows = page.locator(".simple-voter-list-item");
  const count = await rows.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push((await rows.nth(index).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function voterCardDiagnostics(page) {
  if (!(await isPageAlive(page))) {
    return [];
  }
  const cards = page.locator(".simple-coordinator-card");
  const count = await cards.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    results.push((await cards.nth(index).innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function readBody(page) {
  if (!(await isPageAlive(page))) {
    return "PAGE_CLOSED";
  }
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

async function readTicketLifecycleTraces(page) {
  if (!(await isPageAlive(page))) {
    return [];
  }
  return page.evaluate(() => {
    const state = globalThis.__simpleTicketLifecycleTraceState;
    if (!state || typeof state !== "object" || !state.traces || typeof state.traces !== "object") {
      return [];
    }
    return Object.values(state.traces);
  }).catch(() => []);
}

async function readCoordinatorDebug(page) {
  if (!(await isPageAlive(page))) {
    return null;
  }
  return page.evaluate(() => globalThis.__simpleCoordinatorDebug ?? null).catch(() => null);
}

async function readVoterDebug(page) {
  if (!(await isPageAlive(page))) {
    return null;
  }
  return page.evaluate(() => globalThis.__simpleVoterDebug ?? null).catch(() => null);
}

async function readQuestionnaireCoordinatorDebug(page) {
  if (!(await isPageAlive(page))) {
    return null;
  }
  return page.evaluate(() => globalThis.__questionnaireCoordinatorDebug ?? null).catch(() => null);
}

async function readQuestionnaireVoterDebug(page) {
  if (!(await isPageAlive(page))) {
    return null;
  }
  return page.evaluate(() => globalThis.__questionnaireVoterDebug ?? null).catch(() => null);
}

async function getDisplayedActorId(page, prefix) {
  const body = await readBody(page);
  const match = body.match(new RegExp(`${prefix} ID ([a-z0-9]+)`, "i"))
    ?? body.match(/\bID ([a-z0-9]{5,})\b/i);
  if (!match) {
    throw new Error(`Could not find ${prefix} ID on page`);
  }
  return match[1];
}

async function clickAllEnabled(page, matcher) {
  const buttons = page.getByRole("button", { name: matcher });
  const count = await buttons.count();
  let clicked = 0;
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    try {
      if (!(await button.isVisible({ timeout: 1000 }))) {
        continue;
      }
      if (!(await button.isDisabled({ timeout: 1000 }))) {
        await button.click();
        clicked += 1;
        await sleep(100);
      }
    } catch {
      continue;
    }
  }
  return clicked;
}

async function getThresholdT(page) {
  const output = page.locator("#simple-threshold-t-value").first();
  if (await output.count() === 0) {
    return null;
  }
  await output.waitFor({ state: "visible", timeout: 30000 });
  const text = (await output.textContent())?.trim() ?? "";
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function ensureThresholdT(page, desiredT) {
  const increaseThreshold = page.getByRole("button", { name: /Increase Threshold T/i }).first();
  if (await increaseThreshold.count() === 0) {
    return { reached: false, value: null, reason: "threshold_stepper_missing" };
  }

  let currentT = await getThresholdT(page);
  if (currentT === null) {
    return { reached: false, value: null, reason: "threshold_value_missing" };
  }

  if (currentT >= desiredT) {
    return { reached: true, value: currentT, reason: currentT === desiredT ? "already_target" : "already_above_target" };
  }

  for (let attempts = 0; attempts < 10 && currentT < desiredT; attempts += 1) {
    if (await increaseThreshold.isDisabled()) {
      return { reached: false, value: currentT, reason: "threshold_stepper_disabled" };
    }
    await increaseThreshold.click();
    await sleep(150);
    const nextT = await getThresholdT(page);
    if (nextT === null) {
      return { reached: false, value: currentT, reason: "threshold_value_missing_after_click" };
    }
    currentT = nextT;
  }

  return {
    reached: currentT >= desiredT,
    value: currentT,
    reason: currentT >= desiredT ? "target_reached" : "target_not_reached",
  };
}

async function waitForLeadRoundBroadcastReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await ensureTab(page, "Voting", "lead");
    const body = await readBody(page);
    const questionBox = page.locator("#simple-question-prompt").first();
    const broadcastButton = page.getByRole("button", { name: /Broadcast live vote|Vote broadcast/i }).first();
    const waitingForSupervisor =
      /Preparing coordinator MLS group/i.test(body)
      || /Waiting for MLS welcome acknowledgements/i.test(body)
      || /Coordinator control engine is not ready/i.test(body);

    const questionVisible =
      (await questionBox.count().catch(() => 0)) > 0
      && (await questionBox.isVisible().catch(() => false));
    const buttonVisible =
      (await broadcastButton.count().catch(() => 0)) > 0
      && (await broadcastButton.isVisible().catch(() => false));
    const buttonEnabled = buttonVisible && !(await broadcastButton.isDisabled().catch(() => true));

    if (questionVisible && buttonEnabled && !waitingForSupervisor) {
      return true;
    }

    await sleep(500);
  }

  return false;
}

async function setVerifyAll(page) {
  await ensureTab(page, "Configure");
  const checkbox = page.getByRole("checkbox", { name: /Verify all/i }).first();
  if (await checkbox.count() === 0) {
    return false;
  }
  await checkbox.waitFor({ state: "visible", timeout: 30000 });
  if (!(await checkbox.isChecked())) {
    await checkbox.click();
    await sleep(100);
  }
  return true;
}

async function allVotersTicketReady(voters) {
  for (const actor of voters) {
    await ensureVoterTab(actor.page, "Vote", actor.label);
    const body = await readBody(actor.page);
    const ticketReady = parseTicketReady(body);
    if (!ticketReady || ticketReady.ready < ticketReady.required) {
      return false;
    }
  }
  return true;
}

function createRoundStageTracker({ round, prompt, voterIds, coordinatorCount }) {
  return {
    round,
    prompt,
    startedAtMs: Date.now(),
    lastObservedAtMs: 0,
    totalPairs: voterIds.length * coordinatorCount,
    voterIds,
    stages: {
      roundSeen: new Map(),
      blindKeySeen: new Map(),
      blindedRequestSent: new Map(),
      ticketSent: new Map(),
      ticketObserved: new Map(),
      ballotSubmitted: new Map(),
      ballotAccepted: new Map(),
      ticketDeliveryConfirmedByAck: new Map(),
      ticketDeliveryConfirmedByBallot: new Map(),
      ticketDeliveryConfirmed: new Map(),
      receiptAcknowledged: new Map(),
    },
  };
}

function createQuestionnaireStageTracker({ round, questionnaireId, voterIds }) {
  return {
    round,
    questionnaireId,
    startedAtMs: Date.now(),
    lastObservedAtMs: 0,
    totalPairs: voterIds.length,
    voterIds,
    stages: {
      questionnaireSeen: new Map(),
      questionnaireOpen: new Map(),
      responsePublished: new Map(),
      resultSummaryPublished: new Map(),
    },
  };
}

function buildQuestionnaireVisibilityByVoter(stageTracker) {
  return Object.fromEntries(
    stageTracker.voterIds.map((voterId) => {
      const seenAt = stageTracker.stages.questionnaireSeen.get(voterId);
      const openAt = stageTracker.stages.questionnaireOpen.get(voterId);
      return [voterId, {
        questionnaireSeenAtMs: typeof seenAt === "number" ? Math.max(0, seenAt - stageTracker.startedAtMs) : null,
        questionnaireOpenAtMs: typeof openAt === "number" ? Math.max(0, openAt - stageTracker.startedAtMs) : null,
      }];
    }),
  );
}

function recordStage(stageTracker, stageName, pairKey, nowMs) {
  const stageMap = stageTracker.stages[stageName];
  if (!stageMap.has(pairKey)) {
    stageMap.set(pairKey, nowMs);
  }
}

function summariseStageMap(stageMap, startedAtMs, totalPairs) {
  const timings = [...stageMap.values()]
    .map((value) => value - startedAtMs)
    .sort((left, right) => left - right);
  const midpoint = timings.length
    ? timings[Math.floor((timings.length - 1) / 2)]
    : null;

  return {
    count: stageMap.size,
    totalPairs,
    firstMs: timings[0] ?? null,
    medianMs: midpoint,
    lastMs: timings[timings.length - 1] ?? null,
  };
}

function summariseRoundStages(stageTracker) {
  return Object.fromEntries(
    Object.entries(stageTracker.stages).map(([stageName, stageMap]) => [
      stageName,
      summariseStageMap(stageMap, stageTracker.startedAtMs, stageTracker.totalPairs),
    ]),
  );
}

function recordStageForAllCoordinators(stageTracker, stageName, voterId, coordinatorCount, nowMs) {
  for (let coordinatorIndex = 0; coordinatorIndex < coordinatorCount; coordinatorIndex += 1) {
    const pairKey = `${voterId}:coord${coordinatorIndex + 1}`;
    recordStage(stageTracker, stageName, pairKey, nowMs);
  }
}

async function observeRoundStages(stageTracker, coordinators, voters) {
  const nowMs = Date.now();

  for (const [voterIndex, actor] of voters.entries()) {
    const page = actor.page;
    const voterId = stageTracker.voterIds[voterIndex] ?? `voter${voterIndex + 1}`;
    await ensureTab(page, "Configure", actor.label);
    const cards = await voterCardDiagnostics(page);
    for (let coordinatorIndex = 0; coordinatorIndex < cards.length; coordinatorIndex += 1) {
      const text = cards[coordinatorIndex];
      const pairKey = `${voterId}:coord${coordinatorIndex + 1}`;
      if (/Live round seen\./i.test(text)) {
        recordStage(stageTracker, "roundSeen", pairKey, nowMs);
      }
      if (/Blind key seen\./i.test(text)) {
        recordStage(stageTracker, "blindKeySeen", pairKey, nowMs);
      }
      if (/Blinded ticket request acknowledged\./i.test(text)) {
        recordStage(stageTracker, "blindedRequestSent", pairKey, nowMs);
      }
    }
    const voterDebug = await readVoterDebug(page);
    if (voterDebug && typeof voterDebug === "object") {
      const coordinatorCount = coordinators.length;
      if (voterDebug.ticketObserved === true) {
        recordStageForAllCoordinators(stageTracker, "ticketObserved", voterId, coordinatorCount, nowMs);
      }
      if (voterDebug.ticketAckSent === true) {
        recordStageForAllCoordinators(stageTracker, "ticketDeliveryConfirmedByAck", voterId, coordinatorCount, nowMs);
      }
      if (voterDebug.ballotSubmitted === true) {
        recordStageForAllCoordinators(stageTracker, "ballotSubmitted", voterId, coordinatorCount, nowMs);
      }
      if (voterDebug.ticketAckSent === true) {
        recordStageForAllCoordinators(stageTracker, "ticketDeliveryConfirmed", voterId, coordinatorCount, nowMs);
      }
    }
  }

  for (const [coordinatorIndex, actor] of coordinators.entries()) {
    const page = actor.page;
    await ensureTab(page, "Configure", actor.label);
    const rows = await coordinatorFollowerRows(page);
    for (const text of rows) {
      const match = text.match(/Voter ([a-z0-9]+)/i);
      if (!match) {
        continue;
      }
      const voterId = match[1];
      const pairKey = `${voterId}:coord${coordinatorIndex + 1}`;
      if (/Blinded ticket request received\./i.test(text)) {
        recordStage(stageTracker, "blindedRequestSent", pairKey, nowMs);
      }
      if (/Ticket sent\./i.test(text)) {
        recordStage(stageTracker, "ticketSent", pairKey, nowMs);
      }
      if (/Voter acknowledged ticket receipt\./i.test(text)) {
        recordStage(stageTracker, "receiptAcknowledged", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmedByAck", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmed", pairKey, nowMs);
      }
      if (/Valid ballot accepted\./i.test(text)) {
        recordStage(stageTracker, "ballotAccepted", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmedByBallot", pairKey, nowMs);
        recordStage(stageTracker, "ticketDeliveryConfirmed", pairKey, nowMs);
      }
    }
  }

  stageTracker.lastObservedAtMs = nowMs;
}

async function observeQuestionnaireStages(stageTracker, coordinators, voters, voterIdsOverride = null) {
  const nowMs = Date.now();
  const leadCoordinatorDebug = await readQuestionnaireCoordinatorDebug(coordinators[0]?.page);
  const hasPublishedSummary = leadCoordinatorDebug?.latestResultAcceptedCount !== null
    && leadCoordinatorDebug?.latestResultAcceptedCount !== undefined;

  for (const [voterIndex, actor] of voters.entries()) {
    const voterId = Array.isArray(voterIdsOverride)
      ? voterIdsOverride[voterIndex] ?? `voter${voterIndex + 1}`
      : stageTracker.voterIds[voterIndex] ?? `voter${voterIndex + 1}`;
    await ensureVoterTab(actor.page, "Vote", actor.label);
    const voterDebug = await readQuestionnaireVoterDebug(actor.page);
    const voterBody = voterDebug ? "" : await readBody(actor.page);
    const hasVisibleQuestionnaireFromUi = !voterDebug
      && /Question \d+/i.test(voterBody)
      && !/Waiting for questions to be published/i.test(voterBody);
    if (voterDebug?.questionnaireSeen) {
      recordStage(stageTracker, "questionnaireSeen", voterId, nowMs);
    }
    if (hasVisibleQuestionnaireFromUi) {
      recordStage(stageTracker, "questionnaireSeen", voterId, nowMs);
    }
    if (voterDebug?.questionnaireOpen) {
      recordStage(stageTracker, "questionnaireOpen", voterId, nowMs);
    }
    if (hasVisibleQuestionnaireFromUi) {
      recordStage(stageTracker, "questionnaireOpen", voterId, nowMs);
    }
    if (voterDebug?.responsePublished || Number(voterDebug?.responseSubmittedCount ?? 0) > 0) {
      recordStage(stageTracker, "responsePublished", voterId, nowMs);
    }
    if (!voterDebug && /Response submitted|Submission accepted:\s*Yes/i.test(voterBody)) {
      recordStage(stageTracker, "responsePublished", voterId, nowMs);
    }
    if (hasPublishedSummary) {
      recordStage(stageTracker, "resultSummaryPublished", voterId, nowMs);
    }
  }

  stageTracker.lastObservedAtMs = nowMs;
}

async function waitForQuestionnaireVisibilityReadiness({
  stageTracker,
  coordinators,
  voters,
  timeoutMs,
  pollMs = 1000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observeQuestionnaireStages(stageTracker, coordinators, voters);
    const seenCount = Number(stageTracker.stages.questionnaireSeen.size ?? 0);
    const openCount = Number(stageTracker.stages.questionnaireOpen.size ?? 0);
    const expected = stageTracker.totalPairs;
    if (seenCount >= expected && openCount >= expected) {
      return {
        ready: true,
        timedOut: false,
        seenCount,
        openCount,
        expected,
        byVoter: buildQuestionnaireVisibilityByVoter(stageTracker),
      };
    }
    await sleep(pollMs);
  }
  await observeQuestionnaireStages(stageTracker, coordinators, voters);
  const seenCount = Number(stageTracker.stages.questionnaireSeen.size ?? 0);
  const openCount = Number(stageTracker.stages.questionnaireOpen.size ?? 0);
  const expected = stageTracker.totalPairs;
  return {
    ready: false,
    timedOut: true,
    seenCount,
    openCount,
    expected,
    byVoter: buildQuestionnaireVisibilityByVoter(stageTracker),
  };
}

async function waitForQuestionnaireBatchVisibilityReadiness({
  stageTracker,
  coordinators,
  batchActors,
  batchVoterIds,
  timeoutMs,
  pollMs = 1000,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observeQuestionnaireStages(stageTracker, coordinators, batchActors, batchVoterIds);
    const seenCount = batchStageCount(stageTracker.stages.questionnaireSeen, batchVoterIds);
    const openCount = batchStageCount(stageTracker.stages.questionnaireOpen, batchVoterIds);
    const expected = batchVoterIds.length;
    if (seenCount >= expected && openCount >= expected) {
      return { ready: true, timedOut: false, seenCount, openCount, expected };
    }
    await sleep(pollMs);
  }
  await observeQuestionnaireStages(stageTracker, coordinators, batchActors, batchVoterIds);
  const seenCount = batchStageCount(stageTracker.stages.questionnaireSeen, batchVoterIds);
  const openCount = batchStageCount(stageTracker.stages.questionnaireOpen, batchVoterIds);
  const expected = batchVoterIds.length;
  return { ready: false, timedOut: true, seenCount, openCount, expected };
}

async function waitForQuestionnaireBatchSubmissionReadiness({
  stageTracker,
  coordinators,
  batchActors,
  batchVoterIds,
  expectedAcceptedCount,
  timeoutMs,
  pollMs = 1500,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await observeQuestionnaireStages(stageTracker, coordinators, batchActors, batchVoterIds);
    const submittedCount = batchStageCount(stageTracker.stages.responsePublished, batchVoterIds);
    const expected = batchVoterIds.length;
    const coordinatorDebug = await readQuestionnaireCoordinatorDebug(coordinators[0]?.page).catch(() => null);
    const acceptedCount = Number(coordinatorDebug?.latestAcceptedCount ?? 0);
    if (submittedCount >= expected && acceptedCount >= expectedAcceptedCount) {
      return {
        ready: true,
        timedOut: false,
        submittedCount,
        expected,
        acceptedCount,
      };
    }
    await sleep(pollMs);
  }
  await observeQuestionnaireStages(stageTracker, coordinators, batchActors, batchVoterIds);
  const submittedCount = batchStageCount(stageTracker.stages.responsePublished, batchVoterIds);
  const expected = batchVoterIds.length;
  const coordinatorDebug = await readQuestionnaireCoordinatorDebug(coordinators[0]?.page).catch(() => null);
  const acceptedCount = Number(coordinatorDebug?.latestAcceptedCount ?? 0);
  return {
    ready: false,
    timedOut: true,
    submittedCount,
    expected,
    acceptedCount,
  };
}

async function waitForQuestionnaireResultPublication(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const debug = await readQuestionnaireCoordinatorDebug(page);
    if (debug?.latestResultAcceptedCount !== null && debug?.latestResultAcceptedCount !== undefined) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

async function waitForQuestionnaireCoordinatorReady(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const debug = await readQuestionnaireCoordinatorDebug(page);
    if (debug?.coordinatorNpubLoaded) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function waitForQuestionnaireVoterReadyToSubmit(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const submitButtons = page.getByRole("button", { name: /^(Submit encrypted response|Submit response)$/i });
    const buttonCount = await submitButtons.count().catch(() => 0);
    let hasEnabledVisible = false;
    for (let index = 0; index < buttonCount; index += 1) {
      const candidate = submitButtons.nth(index);
      const visible = await candidate.isVisible().catch(() => false);
      const disabled = await candidate.isDisabled().catch(() => true);
      if (visible && !disabled) {
        hasEnabledVisible = true;
        break;
      }
    }
    const voterDebug = await readQuestionnaireVoterDebug(page);
    if (hasEnabledVisible && (voterDebug?.responseReady === true || !voterDebug)) {
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function ensureQuestionnaireDraftReady(page, roundNumber) {
  const titleInput = page.locator("#questionnaire-title").first();
  if (await titleInput.count().catch(() => 0) > 0) {
    const title = `Harness questionnaire round ${roundNumber}`;
    await titleInput.fill(title);
  }

  const descriptionInput = page.locator("#questionnaire-description").first();
  if (await descriptionInput.count().catch(() => 0) > 0) {
    const description = `Automated harness run for round ${roundNumber}.`;
    await descriptionInput.fill(description);
  }

  const promptInput = page.locator("#question-prompt-0").first();
  if (await promptInput.count().catch(() => 0) === 0) {
    await clickByText(page, "button", /^Add yes\/no question$/i);
  }

  if (await promptInput.count().catch(() => 0) > 0) {
    const currentPrompt = (await promptInput.inputValue().catch(() => "")).trim();
    if (!currentPrompt) {
      await promptInput.fill(`Round ${roundNumber}: Should this proposal pass?`);
    }
  }

  await sleep(200);
}

async function sendQuestionnaireInvitesToVoters(page, voterNpubs) {
  const uniqueVoterNpubs = [...new Set(
    voterNpubs
      .map((value) => String(value ?? "").trim())
      .filter((value) => value.startsWith("npub1")),
  )];
  if (uniqueVoterNpubs.length === 0) {
    return;
  }

  await ensureTab(page, "Configure", "lead");
  const knownVoterInput = page.getByPlaceholder("npub1...").first();
  if (await knownVoterInput.count().catch(() => 0) === 0) {
    return;
  }

  for (const npub of uniqueVoterNpubs) {
    await knownVoterInput.fill(npub);
    await clickByTextIfAvailable(page, "button", /^Add known voter$/i, 3000);
    await sleep(120);
  }
  await clickByTextIfAvailable(page, "button", /^Invite all whitelisted$/i, 5000);
  await sleep(400);
}

async function clickEnabledTicketsDuringWindow(coordinators, voters, durationMs, stageTracker) {
  const deadline = Date.now() + durationMs;
  const sendCounts = coordinators.map((_, index) => ({
    coordinator: index + 1,
    clicked: 0,
  }));

  while (Date.now() < deadline) {
    let clickedThisPass = 0;
    for (const [index, actor] of coordinators.entries()) {
      const clicked = await clickAllEnabled(actor.page, /^Send ticket$/i);
      sendCounts[index].clicked += clicked;
      clickedThisPass += clicked;
    }

    if (await allVotersTicketReady(voters)) {
      break;
    }

    if (!stageTracker.lastObservedAtMs || Date.now() - stageTracker.lastObservedAtMs >= 4000) {
      await observeRoundStages(stageTracker, coordinators, voters);
    }

    await sleep(clickedThisPass > 0 ? 750 : 1500);
  }

  return sendCounts;
}

async function addCoordinatorsToVoter(page, coordinatorNpubs) {
  const draft = page.getByPlaceholder('Enter coordinator npub...');
  for (const coordinatorNpub of coordinatorNpubs) {
    await draft.fill(coordinatorNpub);
    await clickByText(page, "button", "Add coordinator");
    await sleep(100);
  }
}

function parseTicketReady(text) {
  const match = /Tickets ready: ([0-9]+) of ([0-9]+)/i.exec(text);
  return match ? { ready: Number(match[1]), required: Number(match[2]) } : null;
}

async function captureRoundState(coordinators, voters) {
  const coordinatorStates = {};
  for (const [index, actor] of coordinators.entries()) {
    const page = actor.page;
    coordinatorStates[`coord${index + 1}`] = {
      diagnostics: await coordinatorDiagnostics(page),
      body: await readBody(page),
      coordinatorDebug: await readCoordinatorDebug(page),
      questionnaireCoordinatorDebug: await readQuestionnaireCoordinatorDebug(page),
      ticketLifecycleTraces: await readTicketLifecycleTraces(page),
      url: await isPageAlive(page) ? page.url() : null,
      runtime: pageRuntimeState(page),
    };
  }

  const voterStates = {};
  for (const [index, actor] of voters.entries()) {
    const page = actor.page;
    await ensureVoterTab(page, "Vote", actor.label);
    const body = await readBody(page);
    voterStates[`voter${index + 1}`] = {
      cards: await voterCardDiagnostics(page),
      body,
      voterDebug: await readVoterDebug(page),
      questionnaireVoterDebug: await readQuestionnaireVoterDebug(page),
      ticketLifecycleTraces: await readTicketLifecycleTraces(page),
      ticketReady: parseTicketReady(body),
      seesQuestion: /Round [0-9]+/i.test(body) || /Should the proposal pass\?/i.test(body),
      url: await isPageAlive(page) ? page.url() : null,
      runtime: pageRuntimeState(page),
    };
  }

  return { coordinatorStates, voterStates };
}

async function main() {
  const startedAtMs = Date.now();
  const coordinatorCount = envInt("LIVE_COORDINATORS", 5);
  const voterCount = envInt("LIVE_VOTERS", 10);
  const roundCount = envInt("LIVE_ROUNDS", 3);
  const deploymentMode = (process.env.LIVE_DEPLOYMENT_MODE ?? "course_feedback").trim().toLowerCase();
  const visibilityOnly = /^(1|true|yes|on)$/i.test((process.env.LIVE_VISIBILITY_ONLY ?? "").trim());
  const base = process.env.LIVE_SIMPLE_BASE_URL ?? "http://127.0.0.1:4175/simple.html";
  const nip65Mode = (process.env.LIVE_NIP65 ?? "off").trim().toLowerCase();
  const startupWaitMs = envInt("LIVE_STARTUP_WAIT_MS", 45000);
  const roundWaitMs = envInt("LIVE_ROUND_WAIT_MS", 20000);
  const ticketWaitMs = envInt("LIVE_TICKET_WAIT_MS", 20000);
  const questionnaireSubmitReadyWaitMs = envInt("LIVE_QUESTIONNAIRE_SUBMIT_READY_WAIT_MS", Math.max(20000, roundWaitMs));
  const voterStartupStaggerMs = envInt(
    "LIVE_VOTER_STARTUP_STAGGER_MS",
    envInt("LIVE_VOTER_START_STAGGER_MS", 150),
  );
  const batchSize = envInt("LIVE_BATCH_SIZE", isQuestionnaireFlowDeployment(deploymentMode) ? 5 : Math.max(1, voterCount));
  const skipPreflight = /^(1|true|yes|on)$/i.test((process.env.LIVE_SKIP_PREFLIGHT ?? "").trim());
  const harnessTimeoutMs = envInt(
    "LIVE_HARNESS_TIMEOUT_MS",
    deriveHarnessTimeoutMs({ startupWaitMs, roundWaitMs, ticketWaitMs, roundCount }),
  );

  const browser = await chromium.launch({ headless: true });
  const voterBaseUrl = new URL(base);
  const coordinatorBaseUrl = new URL(base);
  coordinatorBaseUrl.pathname = coordinatorBaseUrl.pathname.replace(/simple(?:-coordinator)?\.html$/i, "simple-coordinator.html");
  voterBaseUrl.pathname = voterBaseUrl.pathname.replace(/simple(?:-coordinator)?\.html$/i, "simple.html");

  const coordinators = [];
  const voters = [];
  const rounds = [];
  let timeoutId = null;
  const runId = process.env.LIVE_RUN_ID?.trim() || `phase25_timeline_${startedAtMs}`;
  const checkpointFile = process.env.LIVE_CHECKPOINT_PATH?.trim()
    || path.join(DEBUG_DIR, `${runId}.checkpoint.json`);
  const resumeFromCheckpoint = /^(1|true|yes|on)$/i.test((process.env.LIVE_RESUME_FROM_CHECKPOINT ?? "").trim());
  const loadedCheckpoint = resumeFromCheckpoint ? await loadCheckpoint(checkpointFile) : null;
  const checkpoint = loadedCheckpoint && typeof loadedCheckpoint === "object"
    ? loadedCheckpoint
    : {
      runId,
      deploymentMode,
      batchSize,
      rounds: {},
      updatedAtMs: Date.now(),
    };
  const preflight = await runCourseFeedbackPreflight({ skip: skipPreflight });
  const timeline = createTimelineArtifact({
    runId,
    startedAtMs,
    coordinatorCount,
    voterCount,
    roundCount,
    deploymentMode,
  });
  const timelineState = {
    coordinatorQuestionnaireId: null,
    voterQuestionnaireIds: {},
    lastCoordinatorResponseCount: 0,
    lastCoordinatorAcceptedCount: 0,
    lastCoordinatorRejectedCount: 0,
  };

  try {
    const runPromise = (async () => {
      for (let index = 0; index < coordinatorCount; index += 1) {
        const context = await browser.newContext();
        const page = await context.newPage();
        const url = new URL(coordinatorBaseUrl.toString());
        if (nip65Mode !== "on") {
          url.searchParams.set("nip65", "off");
        }
        url.searchParams.set("deployment", deploymentMode);
        await page.goto(url.toString(), { waitUntil: "networkidle" });
        await continueFromRoleLandingIfPresent(page, "coordinator");
        const label = `coord${index + 1}`;
        coordinators.push({ label, page, context });
        recordTimelineEvent(timeline, label, "coordinator_page_loaded", { url: page.url() });
      }

      const voterLabels = Array.from({ length: voterCount }, (_, index) => `voter${index + 1}`);
      const voterLabelBatches = splitIntoBatches(voterLabels, batchSize);
      for (const labelBatch of voterLabelBatches) {
        for (const label of labelBatch) {
          const context = await browser.newContext();
          await context.addInitScript(() => {
            globalThis.__AUDITABLE_VOTING_FORCE_LEGACY_QUESTIONNAIRE__ = true;
          });
          const page = await context.newPage();
          const url = new URL(voterBaseUrl.toString());
          if (nip65Mode !== "on") {
            url.searchParams.set("nip65", "off");
          }
          url.searchParams.set("deployment", deploymentMode);
          await page.goto(url.toString(), { waitUntil: "networkidle" });
          await continueFromRoleLandingIfPresent(page, "voter");
          voters.push({ label, page, context });
          recordTimelineEvent(timeline, label, "voter_page_loaded", { url: page.url() });
          if (voterStartupStaggerMs > 0) {
            await sleep(voterStartupStaggerMs);
          }
        }
      }

      for (const actor of coordinators) {
        await clickByText(actor.page, "button", /^New(?: ID)?$/i);
        await ensureTab(actor.page, "Settings", actor.label);
      }
      await sleep(1500);
      if (isQuestionnaireFlowDeployment(deploymentMode)) {
        await collectQuestionnaireTimelineEvents({
          coordinators,
          voters,
          timeline,
          state: timelineState,
        });
      }

      const coordinatorNpubs = [];
      for (const actor of coordinators) {
        const npub = await getNpub(actor.page);
        if (!npub) {
          throw new Error(`identity_read_failed: coordinator npub missing for ${actor.label}`);
        }
        coordinatorNpubs.push(npub);
      }

      for (let index = 1; index < coordinators.length; index += 1) {
        await ensureTab(coordinators[index].page, "Configure", coordinators[index].label);
        await coordinators[index].page.getByPlaceholder("Leave blank if this coordinator is the lead").fill(coordinatorNpubs[0]);
        await clickByText(coordinators[index].page, "button", /Notify coordinator/i);
      }

      const voterBatches = splitIntoBatches(voters, batchSize);
      const voterIds = [];
      const voterNpubs = [];
      for (const [batchIndex, batch] of voterBatches.entries()) {
        for (const actor of batch) {
          await clickByText(actor.page, "button", /^New(?: ID)?$/i);
          await ensureTab(actor.page, "Settings", actor.label);
          const voterId = await getDisplayedActorId(actor.page, "Voter");
          const voterNpub = await getNpub(actor.page);
          if (!voterId) {
            throw new Error(`identity_read_failed: voter id missing for ${actor.label}`);
          }
          voterIds.push(voterId);
          voterNpubs.push(voterNpub);
          await ensureTab(actor.page, "Configure", actor.label);
          await addCoordinatorsToVoter(actor.page, coordinatorNpubs);
        }
        checkpoint.updatedAtMs = Date.now();
        checkpoint.voterSetupCompletedBatches = Math.max(Number(checkpoint.voterSetupCompletedBatches ?? 0), batchIndex + 1);
        checkpoint.voterSetup = voters.map((actor, index) => ({
          label: actor.label,
          voterId: voterIds[index] ?? null,
        }));
        await writeCheckpoint(checkpointFile, checkpoint);
      }

      await sleep(startupWaitMs);

      for (const actor of coordinators) {
        await setVerifyAll(actor.page);
      }

      for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
        const lead = coordinators[0].page;
        if (isQuestionnaireFlowDeployment(deploymentMode)) {
          const questionnaireId = `course_feedback_${Date.now()}_${roundIndex + 1}`;
          const stageTracker = createQuestionnaireStageTracker({
            round: roundIndex + 1,
            questionnaireId,
            voterIds,
          });
          await ensureTab(lead, "Configure", coordinators[0].label);
          const coordinatorReady = await waitForQuestionnaireCoordinatorReady(lead, 45000);
          if (!coordinatorReady) {
            throw new Error("questionnaire_coordinator_not_ready: coordinator identity/debug not loaded in time");
          }
          const coordinatorQuestionnaireIdInput = lead.locator("#questionnaire-id").first();
          await coordinatorQuestionnaireIdInput.fill(questionnaireId);
          await coordinatorQuestionnaireIdInput.blur();
          await ensureQuestionnaireDraftReady(lead, roundIndex + 1);
          await sleep(300);
          await clickByText(lead, "button", /^(Publish definition|Publish Questionnaire)$/i);
          await sleep(1000);
          await collectQuestionnaireTimelineEvents({
            coordinators,
            voters,
            timeline,
            state: timelineState,
          });
          const coordinatorPostPublishDebug = await readQuestionnaireCoordinatorDebug(lead);
          if (coordinatorPostPublishDebug?.latestState !== "open") {
            await clickByTextIfAvailable(lead, "button", /^(Set open|Open Questionnaire)$/i);
          }
          await sleep(1000);
          await collectQuestionnaireTimelineEvents({
            coordinators,
            voters,
            timeline,
            state: timelineState,
          });
          await sendQuestionnaireInvitesToVoters(lead, voterNpubs);
          for (const actor of voters) {
            const voterUrl = new URL(actor.page.url());
            voterUrl.searchParams.set("questionnaire", questionnaireId);
            await actor.page.goto(voterUrl.toString(), { waitUntil: "networkidle" });
            await continueFromRoleLandingIfPresent(actor.page, "voter");
          }

          const roundCheckpoint = checkpoint.rounds[String(roundIndex + 1)] ?? {
            enrollmentCompletedBatchIndex: 0,
            submissionCompletedBatchIndex: 0,
            batches: [],
          };
          checkpoint.rounds[String(roundIndex + 1)] = roundCheckpoint;

          for (const [batchIndex, batch] of voterBatches.entries()) {
            if (batchIndex < Number(roundCheckpoint.enrollmentCompletedBatchIndex ?? 0)) {
              continue;
            }
            const batchVoterIds = batch.map((_, index) => {
              const absoluteIndex = (batchIndex * batchSize) + index;
              return voterIds[absoluteIndex] ?? `voter${absoluteIndex + 1}`;
            });
            await sleep(1200);
            await observeQuestionnaireStages(stageTracker, coordinators, batch);
            const batchVisibilityReadiness = await waitForQuestionnaireBatchVisibilityReadiness({
              stageTracker,
              coordinators,
              batchActors: batch,
              batchVoterIds,
              timeoutMs: startupWaitMs,
              pollMs: 1000,
            });
            if (!batchVisibilityReadiness.ready) {
              throw new Error(`questionnaire_visibility_timeout:${JSON.stringify({
                questionnaireId,
                round: roundIndex + 1,
                batchIndex: batchIndex + 1,
                seenCount: batchVisibilityReadiness.seenCount,
                openCount: batchVisibilityReadiness.openCount,
                expected: batchVisibilityReadiness.expected,
                byVoter: buildQuestionnaireVisibilityByVoter(stageTracker),
              })}`);
            }
            roundCheckpoint.enrollmentCompletedBatchIndex = batchIndex + 1;
            const batchParticipants = await Promise.all(batch.map(async (actor, index) => {
              const voterDebug = await readVoterDebug(actor.page).catch(() => null);
              const questionnaireVoterDebug = await readQuestionnaireVoterDebug(actor.page).catch(() => null);
              return {
                label: actor.label,
                voterId: batchVoterIds[index] ?? null,
                questionnaireId: questionnaireVoterDebug?.questionnaireId ?? questionnaireId,
                responderId: batchVoterIds[index] ?? null,
                tokenRequested: Boolean(questionnaireVoterDebug?.tokenRequested),
                tokenReceived: Boolean(questionnaireVoterDebug?.tokenReceived),
                responsePublished: Boolean(questionnaireVoterDebug?.responsePublished),
                submitted: Number(questionnaireVoterDebug?.responseSubmittedCount ?? 0) > 0,
                accepted: null,
                voterNpub: voterDebug?.voterNpub ?? null,
              };
            }));
            roundCheckpoint.batches[batchIndex] = {
              ...(roundCheckpoint.batches[batchIndex] ?? {}),
              voterLabels: batch.map((actor) => actor.label),
              voterIds: batchVoterIds,
              questionnaireId,
              participants: batchParticipants,
              enrollmentReady: true,
              enrolledAtMs: Date.now(),
            };
            checkpoint.updatedAtMs = Date.now();
            await writeCheckpoint(checkpointFile, checkpoint);
            recordTimelineEvent(timeline, "coord1", "enrollment_batch_ready", {
              round: roundIndex + 1,
              batchIndex: batchIndex + 1,
              batchSize: batch.length,
            });
          }
          await collectQuestionnaireTimelineEvents({
            coordinators,
            voters,
            timeline,
            state: timelineState,
          });

          if (!visibilityOnly) {
            for (const [batchIndex, batch] of voterBatches.entries()) {
              if (batchIndex < Number(roundCheckpoint.submissionCompletedBatchIndex ?? 0)) {
                continue;
              }
              const batchVoterIds = batch.map((_, index) => {
                const absoluteIndex = (batchIndex * batchSize) + index;
                return voterIds[absoluteIndex] ?? `voter${absoluteIndex + 1}`;
              });
              for (const actor of batch) {
                await ensureVoterTab(actor.page, "Vote", actor.label);
                const voterReadyToSubmit = await waitForQuestionnaireVoterReadyToSubmit(
                  actor.page,
                  questionnaireSubmitReadyWaitMs,
                );
                if (!voterReadyToSubmit) {
                  throw new Error(`questionnaire_submit_not_ready:${JSON.stringify({
                    questionnaireId,
                    round: roundIndex + 1,
                    batchIndex: batchIndex + 1,
                    voter: actor.label,
                    submitReadyWaitMs: questionnaireSubmitReadyWaitMs,
                  })}`);
                }
                const yesButton = actor.page.getByRole("button", { name: /^Yes$/i }).first();
                if (await yesButton.count()) {
                  await yesButton.click({ force: true });
                }
                const option = actor.page.getByLabel(/About right/i).first();
                if (await option.count()) {
                  await option.click({ force: true });
                }
                recordTimelineEvent(timeline, actor.label, "response_form_filled", { questionnaireId });
                const submitButtons = actor.page.getByRole("button", { name: /^(Submit encrypted response|Submit response)$/i });
                const submitButtonCount = await submitButtons.count();
                const submitButtonStates = [];
                for (let index = 0; index < submitButtonCount; index += 1) {
                  const candidate = submitButtons.nth(index);
                  submitButtonStates.push({
                    index,
                    text: (await candidate.innerText().catch(() => "")).replace(/\s+/g, " ").trim(),
                    visible: await candidate.isVisible().catch(() => false),
                    disabled: await candidate.isDisabled().catch(() => true),
                  });
                }
                recordTimelineEvent(timeline, actor.label, "response_submit_button_probe", {
                  questionnaireId,
                  selector: "role=button[name=/^(Submit encrypted response|Submit response)$/i]",
                  submitButtonCount,
                  submitButtonStates,
                });
                let clickedSubmit = false;
                const enabledVisibleButton = submitButtonStates.find((entry) => entry.visible && !entry.disabled);
                if (enabledVisibleButton) {
                  await submitButtons.nth(enabledVisibleButton.index).click({ force: true });
                  clickedSubmit = true;
                } else if (submitButtonCount > 0) {
                  const domClickResult = await actor.page.evaluate(() => {
                    const candidates = Array.from(document.querySelectorAll("button"))
                      .filter((button) => /^(Submit encrypted response|Submit response)$/i.test((button.textContent ?? "").trim()));
                    const snapshot = candidates.map((button, index) => ({
                      index,
                      text: (button.textContent ?? "").trim(),
                      disabled: button.disabled,
                    }));
                    if (candidates.length === 0) {
                      return { clicked: false, reason: "no_matching_dom_button", snapshot };
                    }
                    candidates[0].click();
                    return { clicked: true, reason: "clicked_first_dom_match", snapshot };
                  }).catch((error) => ({
                    clicked: false,
                    reason: error instanceof Error ? error.message : String(error),
                    snapshot: [],
                  }));
                  recordTimelineEvent(timeline, actor.label, "response_submit_dom_click_fallback", domClickResult);
                  clickedSubmit = Boolean(domClickResult?.clicked);
                }
                recordTimelineEvent(timeline, actor.label, "response_submit_click_attempted", {
                  questionnaireId,
                  clickedSubmit,
                  batchIndex: batchIndex + 1,
                });
                if (clickedSubmit) {
                  await sleep(250);
                }
              }

              const expectedAcceptedCount = Math.min(voters.length, (batchIndex + 1) * batchSize);
              const submissionReadiness = await waitForQuestionnaireBatchSubmissionReadiness({
                stageTracker,
                coordinators,
                batchActors: batch,
                batchVoterIds,
                expectedAcceptedCount,
                timeoutMs: roundWaitMs,
                pollMs: 1500,
              });
              if (!submissionReadiness.ready) {
                throw new Error(`questionnaire_submission_timeout:${JSON.stringify({
                  questionnaireId,
                  round: roundIndex + 1,
                  batchIndex: batchIndex + 1,
                  submittedCount: submissionReadiness.submittedCount,
                  expectedSubmitted: submissionReadiness.expected,
                  acceptedCount: submissionReadiness.acceptedCount,
                  expectedAcceptedCount,
                })}`);
              }
              roundCheckpoint.submissionCompletedBatchIndex = batchIndex + 1;
              const coordinatorDebug = await readQuestionnaireCoordinatorDebug(coordinators[0]?.page).catch(() => null);
              const batchParticipants = await Promise.all(batch.map(async (actor, index) => {
                const questionnaireVoterDebug = await readQuestionnaireVoterDebug(actor.page).catch(() => null);
                return {
                  label: actor.label,
                  voterId: batchVoterIds[index] ?? null,
                  questionnaireId: questionnaireVoterDebug?.questionnaireId ?? questionnaireId,
                  responderId: batchVoterIds[index] ?? null,
                  tokenRequested: Boolean(questionnaireVoterDebug?.tokenRequested),
                  tokenReceived: Boolean(questionnaireVoterDebug?.tokenReceived),
                  responsePublished: Boolean(questionnaireVoterDebug?.responsePublished),
                  submitted: Number(questionnaireVoterDebug?.responseSubmittedCount ?? 0) > 0,
                  accepted: null,
                };
              }));
              roundCheckpoint.batches[batchIndex] = {
                ...(roundCheckpoint.batches[batchIndex] ?? {}),
                questionnaireId,
                participants: batchParticipants,
                submissionReady: true,
                submittedAtMs: Date.now(),
                expectedAcceptedCount,
                acceptedObservedCount: Number(coordinatorDebug?.latestAcceptedCount ?? 0),
              };
              checkpoint.updatedAtMs = Date.now();
              await writeCheckpoint(checkpointFile, checkpoint);
              recordTimelineEvent(timeline, "coord1", "submission_batch_ready", {
                round: roundIndex + 1,
                batchIndex: batchIndex + 1,
                batchSize: batch.length,
                expectedAcceptedCount,
              });
              await collectQuestionnaireTimelineEvents({
                coordinators,
                voters,
                timeline,
                state: timelineState,
              });
            }

            await ensureTab(lead, "Configure", coordinators[0].label);
            await clickByTextIfAvailable(lead, "button", /^(Publish results|Count Responses)$/i);
            await waitForQuestionnaireResultPublication(lead, 20000);
            await observeQuestionnaireStages(stageTracker, coordinators, voters);
            await collectQuestionnaireTimelineEvents({
              coordinators,
              voters,
              timeline,
              state: timelineState,
            });
          }

          rounds.push({
            round: roundIndex + 1,
            prompt: `Questionnaire ${roundIndex + 1}`,
            sendCounts: [],
            stageMetrics: summariseRoundStages(stageTracker),
            visibilityByVoter: buildQuestionnaireVisibilityByVoter(stageTracker),
            state: await captureRoundState(coordinators, voters),
          });
          continue;
        }

        const prompt = `Round ${roundIndex + 1}: Should the proposal pass?`;
        const stageTracker = createRoundStageTracker({
          round: roundIndex + 1,
          prompt,
          voterIds,
          coordinatorCount,
        });
        await ensureTab(lead, "Voting", coordinators[0].label);
        if (coordinatorCount > 1) {
          const thresholdResult = await ensureThresholdT(lead, Math.min(coordinatorCount, 2));
          if (!thresholdResult.reached) {
            throw new Error(
              `Could not reach desired Threshold T before round ${roundIndex + 1}: ${thresholdResult.reason} (current=${thresholdResult.value ?? "unknown"})`,
            );
          }
        }
        const readyForBroadcast = await waitForLeadRoundBroadcastReady(lead, startupWaitMs);
        if (!readyForBroadcast) {
          throw new Error(`Lead coordinator was not ready to broadcast round ${roundIndex + 1} within ${startupWaitMs}ms`);
        }
        const questionBox = lead.locator("#simple-question-prompt").first();
        await questionBox.waitFor({ state: "visible", timeout: 30000 });
        await questionBox.fill(prompt);
        await clickByText(lead, "button", /Broadcast live vote|Vote broadcast/i);

        await observeRoundStages(stageTracker, coordinators, voters);

        const roundDiscoveryDeadline = Date.now() + roundWaitMs;
        while (Date.now() < roundDiscoveryDeadline) {
          await sleep(4000);
          await observeRoundStages(stageTracker, coordinators, voters);
        }

        const sendCounts = await clickEnabledTicketsDuringWindow(
          coordinators,
          voters,
          ticketWaitMs,
          stageTracker,
        );

        await sleep(4000);
        await observeRoundStages(stageTracker, coordinators, voters);

        for (const [index, actor] of voters.entries()) {
          const page = actor.page;
          await ensureVoterTab(page, "Vote", actor.label);
          const body = await readBody(page);
          const ticketReady = parseTicketReady(body);
          if (ticketReady && ticketReady.ready >= ticketReady.required) {
            const voteChoice = index % 2 === 0 ? "Yes" : "No";
            const button = page.getByRole("button", { name: new RegExp(`^${voteChoice}$`, "i") });
            await button.click({ force: true });
            const submit = page.getByRole("button", { name: /^Submit vote$/i });
            if (await submit.count()) {
              if (!(await submit.isDisabled())) {
                await submit.click({ force: true });
                await sleep(200);
              }
            }
          }
        }

        rounds.push({
          round: roundIndex + 1,
          prompt,
          sendCounts,
          stageMetrics: summariseRoundStages(stageTracker),
          state: await captureRoundState(coordinators, voters),
        });
      }
    })();

    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        reject(new Error(`Harness timeout after ${harnessTimeoutMs}ms`));
      }, harnessTimeoutMs);
    });

    await Promise.race([runPromise, timeoutPromise]);
  } catch (error) {
    const errorMessage = safeErrorMessage(error);
    const visibilityTimeoutMatch = /^questionnaire_visibility_timeout:(.+)$/s.exec(errorMessage);
    let questionnaireVisibilityTimeout = null;
    if (visibilityTimeoutMatch) {
      try {
        questionnaireVisibilityTimeout = JSON.parse(visibilityTimeoutMatch[1]);
      } catch {
        questionnaireVisibilityTimeout = {
          parseError: true,
          raw: visibilityTimeoutMatch[1],
        };
      }
    }
    const participants = [...coordinators, ...voters];
    const snapshots = await snapshotAllActors(participants, classifyHarnessFailure(error));
    const diagnostic = {
      runId: timeline.runId,
      startedAtMs: timeline.startedAtMs,
      configTimeline: timeline.config,
      failureClass: classifyHarnessFailure(error),
      error: errorMessage,
      config: {
        base,
        deploymentMode,
        visibilityOnly,
        nip65Mode,
        coordinatorCount,
        voterCount,
        roundCount,
        startupWaitMs,
        roundWaitMs,
        ticketWaitMs,
        questionnaireSubmitReadyWaitMs,
        harnessTimeoutMs,
        voterStartupStaggerMs,
      },
      questionnaireVisibilityTimeout,
      completedRoundCount: rounds.filter((round) => {
        const metrics = round?.stageMetrics ?? {};
        if (isQuestionnaireFlowDeployment(deploymentMode)) {
          return Number(metrics.questionnaireSeen?.count ?? 0) > 0
            && Number(metrics.questionnaireOpen?.count ?? 0) > 0;
        }
        return Number(metrics.roundSeen?.count ?? 0) > 0;
      }).length,
      completedRounds: rounds,
      snapshots,
      globalTimeline: timeline.globalTimeline,
      coordinatorTimeline: timeline.coordinatorTimeline,
      voterTimelines: timeline.voterTimelines,
    };
    const protocolFailure = classifyProtocolFailure(rounds, deploymentMode);
    diagnostic.protocolFailureClass = protocolFailure.protocolFailureClass;
    diagnostic.firstMissingStage = protocolFailure.firstMissingStage;
    diagnostic.coordinatorReadinessSummary = snapshots
      .filter((snapshot) => snapshot.label.startsWith("coord"))
      .map((snapshot) => ({
        coordinator: snapshot.label,
        readiness: snapshot.coordinatorDebug?.runtimeReadiness ?? null,
        engineStatus: snapshot.coordinatorDebug?.engineStatus ?? null,
        startupDiagnostics: snapshot.coordinatorDebug?.startupDiagnostics ?? null,
        controlStateLabel: snapshot.coordinatorDebug?.controlStateLabel ?? null,
      }));
    diagnostic.startupJoinSummary = classifyStartupJoinFailure(snapshots);
    diagnostic.voterRoundVisibilitySummary = snapshots
      .filter((snapshot) => snapshot.label.startsWith("voter"))
      .map((snapshot) => ({
        voter: snapshot.label,
        visibility: snapshot.voterDebug ?? null,
      }));
    timeline.finalSnapshot = isQuestionnaireFlowDeployment(deploymentMode)
      ? buildQuestionnaireFinalSnapshotFromActorSnapshots(snapshots)
      : null;
    timeline.summary = {
      passed: false,
      completedRoundCount: diagnostic.completedRoundCount,
      protocolFailureClass: diagnostic.protocolFailureClass,
      firstMissingStage: diagnostic.firstMissingStage,
    };
    diagnostic.finalSnapshot = timeline.finalSnapshot;
    diagnostic.summary = timeline.summary;
    console.error(JSON.stringify(diagnostic, null, 2));
    if (timeoutId !== null) {
      globalThis.clearTimeout(timeoutId);
    }
    await browser.close().catch(() => undefined);
    process.exit(1);
  }

  const summary = rounds.map((round) => {
    const voterTicketSummary = Object.entries(round.state.voterStates).map(([key, value]) => ({
      voter: key,
      ticketReady: value.ticketReady,
      hasTicket: Boolean(value.ticketReady && value.ticketReady.ready >= value.ticketReady.required),
      ballotSubmitted: Boolean(value.voterDebug?.ballotSubmitted),
      ballotAccepted: Boolean(value.voterDebug?.ballotAccepted),
    }));
    const coordinatorStates = Object.values(round.state.coordinatorStates ?? {});
    const primaryCoordinatorQuestionnaireDebug = coordinatorStates[0]?.questionnaireCoordinatorDebug ?? null;
    const coordinatorAcceptedBallots = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state.coordinatorDebug?.acceptedBallotCount ?? 0)),
    );
    const coordinatorRejectedBallots = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state.coordinatorDebug?.rejectedBallotCount ?? 0)),
    );
    const coordinatorAcceptedByLineage = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state.coordinatorDebug?.voters?.filter((entry) => entry.ballotAccepted).length ?? 0)),
    );
    const primaryCoordinatorDebug = coordinatorStates[0]?.coordinatorDebug ?? null;
    const rowsWithoutAcceptedBallot = Array.isArray(primaryCoordinatorDebug?.rowsWithoutAcceptedBallot)
      ? primaryCoordinatorDebug.rowsWithoutAcceptedBallot
      : [];
    const acceptedBallotsByRequestId = Array.isArray(primaryCoordinatorDebug?.acceptedBallotsByRequestId)
      ? primaryCoordinatorDebug.acceptedBallotsByRequestId
      : [];
    const acceptedBallotsByTicketId = Array.isArray(primaryCoordinatorDebug?.acceptedBallotsByTicketId)
      ? primaryCoordinatorDebug.acceptedBallotsByTicketId
      : [];
    const acceptedRequestIds = new Set(
      acceptedBallotsByRequestId
        .map((entry) => (Array.isArray(entry) ? String(entry[0] ?? "").trim() : ""))
        .filter(Boolean),
    );
    const acceptedTicketIds = new Set(
      acceptedBallotsByTicketId
        .map((entry) => (Array.isArray(entry) ? String(entry[0] ?? "").trim() : ""))
        .filter(Boolean),
    );
    const voterStateByNpub = new Map(
      Object.values(round.state.voterStates)
        .map((value) => [
          typeof value?.voterDebug?.voterNpub === "string" ? value.voterDebug.voterNpub.trim() : "",
          value,
        ])
        .filter(([npub]) => Boolean(npub)),
    );
    const coordinatorVoterByNpub = new Map(
      Array.isArray(primaryCoordinatorDebug?.voters)
        ? primaryCoordinatorDebug.voters
          .map((entry) => [String(entry?.voterPubkey ?? ""), entry])
          .filter(([npub]) => Boolean(npub))
        : [],
    );
    const unmatchedRowDiagnostics = rowsWithoutAcceptedBallot.map((row) => {
      const voterPubkey = String(row?.voterPubkey ?? "");
      const requestId = typeof row?.requestId === "string" ? row.requestId.trim() : "";
      const requestMailboxId = typeof row?.requestMailboxId === "string" ? row.requestMailboxId.trim() : "";
      const ticketId = typeof row?.ticketId === "string" ? row.ticketId.trim() : "";
      const voterState = voterStateByNpub.get(voterPubkey);
      const coordinatorVoter = coordinatorVoterByNpub.get(voterPubkey);
      const ticketObserved = Boolean(voterState?.ticketReady && voterState.ticketReady.ready >= voterState.ticketReady.required);
      const ticketObservedLiveCount = Number(voterState?.voterDebug?.ticketObservedLiveCount ?? 0);
      const ticketObservedBackfillCount = Number(voterState?.voterDebug?.ticketObservedBackfillCount ?? 0);
      const ticketBackfillByRequestId = voterState?.voterDebug?.ticketBackfillByRequestId ?? {};
      const backfillDebugByRequestId = requestId ? ticketBackfillByRequestId[requestId] : null;
      const ticketBackfillAttemptCount = Number(
        backfillDebugByRequestId?.attemptCount
        ?? voterState?.voterDebug?.ticketBackfillAttemptCount
        ?? 0,
      );
      const ticketBackfillLastResultCount = Number(
        backfillDebugByRequestId?.lastResultCount
        ?? voterState?.voterDebug?.ticketBackfillLastResultCount
        ?? 0,
      );
      const ticketBackfillLastMatchedCount = Number(
        backfillDebugByRequestId?.lastMatchedCount
        ?? voterState?.voterDebug?.ticketBackfillLastMatchedCount
        ?? 0,
      );
      const ticketBackfillLastAttemptAt = backfillDebugByRequestId?.lastAttemptAt
        ?? voterState?.voterDebug?.ticketBackfillLastAttemptAt
        ?? null;
      const ticketBackfillLastSourceRelays = Array.isArray(backfillDebugByRequestId?.lastSourceRelays)
        ? backfillDebugByRequestId.lastSourceRelays
        : Array.isArray(voterState?.voterDebug?.ticketBackfillLastSourceRelays)
          ? voterState.voterDebug.ticketBackfillLastSourceRelays
          : [];
      const ticketBackfillFailureClass = ticketBackfillAttemptCount <= 0
        ? "backfill_not_triggered"
        : ticketBackfillLastResultCount <= 0
          ? "backfill_no_events_returned"
          : ticketBackfillLastMatchedCount <= 0
            ? "backfill_events_returned_no_match"
            : ticketObserved
              ? "backfill_match_found_observed"
              : "backfill_match_found_not_reconciled";
      const ticketLiveQuery = voterState?.voterDebug?.ticketLiveQuery ?? null;
      const ticketBackfillQuery = voterState?.voterDebug?.ticketBackfillQuery ?? null;
      const ticketPendingMailboxIds = Array.isArray(voterState?.voterDebug?.ticketPendingMailboxIds)
        ? voterState.voterDebug.ticketPendingMailboxIds
        : [];
      const ticketBackfillByRequestIdState = voterState?.voterDebug?.ticketBackfillByRequestId ?? {};
      const liveMailboxIds = Array.isArray(ticketLiveQuery?.mailboxIds) ? ticketLiveQuery.mailboxIds : [];
      const backfillMailboxIds = Array.isArray(ticketBackfillQuery?.mailboxIds) ? ticketBackfillQuery.mailboxIds : [];
      const ticketReadMailboxId = requestId
        ? ticketBackfillByRequestIdState?.[requestId]?.ticketReadMailboxId ?? null
        : null;
      const ticketBackfillMailboxId = requestId
        ? ticketBackfillByRequestIdState?.[requestId]?.ticketBackfillMailboxId ?? null
        : null;
      const ticketPublishMailboxId = typeof coordinatorVoter?.ticketPublishMailboxId === "string"
        ? coordinatorVoter.ticketPublishMailboxId.trim()
        : "";
      const liveMailboxFilterMatchesRequest = requestMailboxId
        ? liveMailboxIds.includes(requestMailboxId)
        : null;
      const backfillMailboxFilterMatchesRequest = requestMailboxId
        ? ticketPendingMailboxIds.includes(requestMailboxId) || backfillMailboxIds.includes(requestMailboxId)
        : null;
      const mailboxIdConsistent = Boolean(
        requestMailboxId
        && ticketPublishMailboxId
        && requestMailboxId === ticketPublishMailboxId
        && (ticketBackfillMailboxId ? ticketBackfillMailboxId === requestMailboxId : true)
        && (ticketReadMailboxId ? ticketReadMailboxId === requestMailboxId : true),
      );
      const mailboxIdConsistentReadRequest = requestMailboxId
        ? ticketReadMailboxId === requestMailboxId
        : null;
      const mailboxIdConsistentBackfillRequest = requestMailboxId
        ? ticketBackfillMailboxId === requestMailboxId
        : null;
      const ballotSubmitted = Boolean(voterState?.voterDebug?.ballotSubmitted);
      const ballotAccepted = Boolean(voterState?.voterDebug?.ballotAccepted);
      const ticketSent = Boolean(coordinatorVoter?.ticketSent || ticketObserved);
      const inAcceptedByRequestId = Boolean(requestId && acceptedRequestIds.has(requestId));
      const inAcceptedByTicketId = Boolean(ticketId && acceptedTicketIds.has(ticketId));
      const ticketPublishStartedAt = coordinatorVoter?.ticketPublishStartedAt ?? null;
      const ticketPublishSucceededAt = coordinatorVoter?.ticketPublishSucceededAt ?? null;
      const ticketResentCount = Number(coordinatorVoter?.ticketResentCount ?? 0);
      const recoveredByBackfill = !ticketObservedLiveCount && ticketObservedBackfillCount > 0;
      const recoveredByResend = ticketResentCount > 0 && (ticketObserved || inAcceptedByRequestId || inAcceptedByTicketId);
      const firstMissingStage = recoveredByResend
        ? "ticket_recovered_by_resend"
        : recoveredByBackfill
          ? "ticket_recovered_by_backfill"
          : !ticketSent
        ? "ticket_not_sent"
        : Boolean(ticketPublishStartedAt) && !Boolean(ticketPublishSucceededAt) && !ticketObserved
          ? "ticket_publish_unconfirmed"
          : Boolean(ticketPublishSucceededAt) && !ticketObserved
            ? (!mailboxIdConsistent ? "mailbox_id_mismatch" : ticketBackfillFailureClass)
        : !ticketObserved
          ? "ticket_not_observed"
          : ticketObserved && !inAcceptedByRequestId && !inAcceptedByTicketId
            ? "ticket_observed_unmapped"
          : !ballotSubmitted
            ? "ballot_not_submitted"
            : !inAcceptedByRequestId && !inAcceptedByTicketId
              ? "ballot_not_accepted_by_lineage"
              : "accepted_not_mapped";
      return {
        voterPubkey,
        requestId: requestId || null,
        requestMailboxId: requestMailboxId || null,
        ticketPublishMailboxId: ticketPublishMailboxId || null,
        ticketReadMailboxId,
        ticketBackfillMailboxId,
        mailboxIdConsistent,
        mailboxIdConsistentReadRequest,
        mailboxIdConsistentBackfillRequest,
        ticketId: ticketId || null,
        ticketSent,
        ticketObserved,
        ticketObservedLiveCount,
        ticketObservedBackfillCount,
        ticketObservedLiveAt: voterState?.voterDebug?.ticketObservedLiveAt ?? null,
        ticketObservedBackfillAt: voterState?.voterDebug?.ticketObservedBackfillAt ?? null,
        ballotSubmitted,
        ballotAccepted,
        ticketPublishStartedAt,
        ticketPublishSucceededAt,
        ticketPublishEventId: coordinatorVoter?.ticketPublishEventId ?? null,
        ticketPublishEventKind: coordinatorVoter?.ticketPublishEventKind ?? null,
        ticketPublishEventCreatedAt: coordinatorVoter?.ticketPublishEventCreatedAt ?? null,
        ticketPublishEventTags: Array.isArray(coordinatorVoter?.ticketPublishEventTags) ? coordinatorVoter.ticketPublishEventTags : [],
        ticketPublishEventContent: typeof coordinatorVoter?.ticketPublishEventContent === "string"
          ? coordinatorVoter.ticketPublishEventContent
          : null,
        ticketResentCount,
        ticketRelayTargets: Array.isArray(coordinatorVoter?.ticketRelayTargets) ? coordinatorVoter.ticketRelayTargets : [],
        ticketRelayResults: Array.isArray(coordinatorVoter?.ticketRelayResults) ? coordinatorVoter.ticketRelayResults : [],
        ticketRelaySuccessCount: Number(coordinatorVoter?.ticketRelaySuccessCount ?? 0),
        ticketBackfillAttemptCount,
        ticketBackfillLastAttemptAt,
        ticketBackfillLastResultCount,
        ticketBackfillLastMatchedCount,
        ticketBackfillLastSourceRelays,
        ticketBackfillFailureClass,
        ticketPendingMailboxIds,
        liveMailboxFilterMatchesRequest,
        backfillMailboxFilterMatchesRequest,
        ticketLiveQuery,
        ticketBackfillQuery,
        resendEligible: Boolean(coordinatorVoter?.resendEligible),
        resendBlockedReason: coordinatorVoter?.resendBlockedReason ?? null,
        inAcceptedByRequestId,
        inAcceptedByTicketId,
        firstMissingStage,
      };
    });
    const ticketObservedLiveCount = Object.values(round.state.voterStates).filter(
      (value) => Number(value?.voterDebug?.ticketObservedLiveCount ?? 0) > 0,
    ).length;
    const ticketObservedBackfillCount = Object.values(round.state.voterStates).filter(
      (value) => Number(value?.voterDebug?.ticketObservedBackfillCount ?? 0) > 0,
    ).length;
    const ticketRecoveredByResendCount = Array.isArray(primaryCoordinatorDebug?.voters)
      ? primaryCoordinatorDebug.voters.filter((entry) => (
        Number(entry?.ticketResentCount ?? 0) > 0
        && (Boolean(entry?.ballotAccepted) || Boolean(entry?.ticketAckSeen))
      )).length
      : 0;
    const ticketStillMissingCount = Number(primaryCoordinatorDebug?.ticketStillMissingCount ?? 0);
    const rowsWithPublishSuccessNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      Boolean(entry.ticketPublishSucceededAt)
      && !entry.ticketObserved
    )).length;
    const rowsWithFullRelaySuccessNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketObserved
      && Array.isArray(entry.ticketRelayTargets)
      && entry.ticketRelayTargets.length > 0
      && entry.ticketRelaySuccessCount >= entry.ticketRelayTargets.length
    )).length;
    const rowsWithPartialRelaySuccessNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketObserved
      && entry.ticketRelaySuccessCount > 0
      && Array.isArray(entry.ticketRelayTargets)
      && entry.ticketRelaySuccessCount < entry.ticketRelayTargets.length
    )).length;
    const rowsWithPublishUnconfirmedEventuallyObserved = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketPublishSucceededAt
      && entry.ticketObserved
    )).length;
    const rowsObservedOnlyAfterBackfill = unmatchedRowDiagnostics.filter((entry) => (
      Number(entry.ticketObservedBackfillCount ?? 0) > 0
      && Number(entry.ticketObservedLiveCount ?? 0) === 0
    )).length;
    const ticketPublishSucceededCount = Number(primaryCoordinatorDebug?.ticketPublishSucceededCount ?? 0);
    const backfillFailureClassCounts = unmatchedRowDiagnostics.reduce((acc, row) => {
      const key = String(row.ticketBackfillFailureClass ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const rowsWithRelayOverlapNoObservation = unmatchedRowDiagnostics.filter((entry) => {
      const writeRelays = Array.isArray(entry.ticketRelayTargets) ? entry.ticketRelayTargets : [];
      const readRelays = Array.from(new Set([
        ...(Array.isArray(entry.ticketLiveQuery?.relays) ? entry.ticketLiveQuery.relays : []),
        ...(Array.isArray(entry.ticketBackfillLastSourceRelays) ? entry.ticketBackfillLastSourceRelays : []),
      ]));
      if (entry.ticketObserved || writeRelays.length === 0 || readRelays.length === 0) {
        return false;
      }
      const overlap = writeRelays.filter((relay) => readRelays.includes(relay)).length;
      return overlap > 0;
    }).length;
    const rowsWithNoRelayOverlapNoObservation = unmatchedRowDiagnostics.filter((entry) => {
      const writeRelays = Array.isArray(entry.ticketRelayTargets) ? entry.ticketRelayTargets : [];
      const readRelays = Array.from(new Set([
        ...(Array.isArray(entry.ticketLiveQuery?.relays) ? entry.ticketLiveQuery.relays : []),
        ...(Array.isArray(entry.ticketBackfillLastSourceRelays) ? entry.ticketBackfillLastSourceRelays : []),
      ]));
      if (entry.ticketObserved || writeRelays.length === 0 || readRelays.length === 0) {
        return false;
      }
      const overlap = writeRelays.filter((relay) => readRelays.includes(relay)).length;
      return overlap === 0;
    }).length;
    const rowsWithReadRelaySetUnknown = unmatchedRowDiagnostics.filter((entry) => {
      const readRelays = Array.from(new Set([
        ...(Array.isArray(entry.ticketLiveQuery?.relays) ? entry.ticketLiveQuery.relays : []),
        ...(Array.isArray(entry.ticketBackfillLastSourceRelays) ? entry.ticketBackfillLastSourceRelays : []),
      ]));
      return !entry.ticketObserved && readRelays.length === 0;
    }).length;
    const rowsWithMailboxFilterMismatchNoObservation = unmatchedRowDiagnostics.filter((entry) => {
      if (entry.ticketObserved || !entry.requestMailboxId) {
        return false;
      }
      return entry.liveMailboxFilterMatchesRequest === false || entry.backfillMailboxFilterMatchesRequest === false;
    }).length;
    const rowsWithMailboxIdMismatchNoObservation = unmatchedRowDiagnostics.filter((entry) => (
      !entry.ticketObserved
      && entry.requestMailboxId
      && entry.mailboxIdConsistent === false
    )).length;
    const publishSuccessObservationGapRatio = rowsWithPublishSuccessNoObservation > 0
      ? Number((rowsWithPublishSuccessNoObservation / Math.max(1, ticketPublishSucceededCount)).toFixed(3))
      : 0;
    const fullRelaySuccessObservationGapRatio = rowsWithFullRelaySuccessNoObservation > 0
      ? Number((rowsWithFullRelaySuccessNoObservation / Math.max(1, rowsWithPublishSuccessNoObservation)).toFixed(3))
      : 0;
    const backfillObservationRecoveryRatio = rowsWithPublishSuccessNoObservation > 0
      ? Number((rowsObservedOnlyAfterBackfill / rowsWithPublishSuccessNoObservation).toFixed(3))
      : 0;
    const backfillTriggeredRatio = rowsWithPublishSuccessNoObservation > 0
      ? Number((
        (rowsWithPublishSuccessNoObservation - Number(backfillFailureClassCounts.backfill_not_triggered ?? 0))
        / rowsWithPublishSuccessNoObservation
      ).toFixed(3))
      : 0;
    const sendQueueEligibleCount = Number(primaryCoordinatorDebug?.sendQueueEligibleCount ?? 0);
    const sendQueueStartedCount = Number(primaryCoordinatorDebug?.sendQueueStartedCount ?? 0);
    const sendQueueBlockedCount = Number(primaryCoordinatorDebug?.sendQueueBlockedCount ?? 0);
    const sendQueueBlockedReasons = primaryCoordinatorDebug?.sendQueueBlockedReasons ?? {};
    const sendQueueInFlightCount = Number(primaryCoordinatorDebug?.sendQueueInFlightCount ?? 0);
    const sendQueueUnsentCount = Number(primaryCoordinatorDebug?.sendQueueUnsentCount ?? 0);
    const roundOpenAt = primaryCoordinatorDebug?.roundOpenAt ?? null;
    const lastTicketSendStartedAt = primaryCoordinatorDebug?.lastTicketSendStartedAt ?? null;
    const unsentRowsAtRoundTimeout = unmatchedRowDiagnostics.filter((entry) => (
      entry.firstMissingStage === "ticket_not_sent"
      || entry.firstMissingStage === "ticket_publish_unconfirmed"
    )).length;
    const stageMetrics = round.stageMetrics ?? {};
    const ticketSentCount = Number(stageMetrics.ticketSent?.count ?? 0);
    const ticketObservedCount = Number(stageMetrics.ticketObserved?.count ?? 0);
    const ballotSubmittedCount = Number(stageMetrics.ballotSubmitted?.count ?? 0);
    const ballotAcceptedCount = Number(stageMetrics.ballotAccepted?.count ?? 0);
    const ticketDeliveryConfirmedByAckCount = Number(stageMetrics.ticketDeliveryConfirmedByAck?.count ?? 0);
    const ticketDeliveryConfirmedByBallotCount = Number(stageMetrics.ticketDeliveryConfirmedByBallot?.count ?? 0);
    const ticketDeliveryConfirmedCount = Number(stageMetrics.ticketDeliveryConfirmed?.count ?? 0);
    const expectedPairs = Number(stageMetrics.ticketSent?.totalPairs ?? 0);
    const expectedAcceptedThreshold = round.state.voterStates ? Object.keys(round.state.voterStates).length : 0;
    const questionnaireOpenCount = Number(stageMetrics.questionnaireOpen?.count ?? 0);
    const voterPublishedBallots = voterTicketSummary.filter((entry) => entry.ballotSubmitted).length;
    const voterObservedTickets = voterTicketSummary.filter((entry) => entry.hasTicket).length;
    const questionnaireSeenCount = Object.values(round.state.voterStates).filter(
      (value) => Boolean(value?.questionnaireVoterDebug?.questionnaireSeen),
    ).length;
    const responsesPublishedCount = Object.values(round.state.voterStates).reduce(
      (total, value) => total + Number(value?.questionnaireVoterDebug?.responseSubmittedCount ?? 0),
      0,
    );
    const acceptedResponsesCount = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state?.questionnaireCoordinatorDebug?.latestAcceptedCount ?? 0)),
    );
    const rejectedResponsesCount = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state?.questionnaireCoordinatorDebug?.latestRejectedCount ?? 0)),
    );
    const resultSummaryPublished = coordinatorStates.some(
      (state) => Number(state?.questionnaireCoordinatorDebug?.latestResultAcceptedCount ?? -1) >= 0,
    );
    const coordinatorSummaryAcceptedCount = Math.max(
      -1,
      ...coordinatorStates.map((state) => Number(state?.questionnaireCoordinatorDebug?.latestResultAcceptedCount ?? -1)),
    );
    const definitionEventCount = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state?.questionnaireCoordinatorDebug?.definitionEventCount ?? 0)),
    );
    const resultEventCount = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state?.questionnaireCoordinatorDebug?.resultEventCount ?? 0)),
    );
    const responseEventCount = Math.max(
      0,
      ...coordinatorStates.map((state) => Number(state?.questionnaireCoordinatorDebug?.responseEventCount ?? 0)),
    );
    const localSummaryMatchesPublished = coordinatorStates.some(
      (state) => state?.questionnaireCoordinatorDebug?.localSummaryMatchesPublished === true,
    );
    const questionnaireIdsSeenByVoters = Array.from(
      new Set(
        Object.values(round.state.voterStates)
          .map((value) => String(value?.questionnaireVoterDebug?.loadedQuestionnaireId ?? "").trim())
          .filter(Boolean),
      ),
    );
    const questionCountsSeenByVoters = Array.from(
      new Set(
        Object.values(round.state.voterStates)
          .map((value) => Number(value?.questionnaireVoterDebug?.loadedQuestionCount ?? 0))
          .filter((value) => Number.isFinite(value) && value > 0),
      ),
    );
    const responsesPerVoter = Object.fromEntries(
      Object.entries(round.state.voterStates).map(([voterKey, value]) => [
        voterKey,
        Number(value?.questionnaireVoterDebug?.responseSubmittedCount ?? 0),
      ]),
    );
    const eachVoterPublishedExactlyOneResponse = Object.values(responsesPerVoter).length > 0
      && Object.values(responsesPerVoter).every((count) => count === 1);
    const acceptanceAccountingMatches = acceptedResponsesCount + rejectedResponsesCount === responseEventCount;
    const voterQuestionnaireReadDiagnostics = Object.fromEntries(
      Object.entries(round.state.voterStates).map(([voterKey, value]) => [voterKey, {
        questionnaireId: value?.questionnaireVoterDebug?.questionnaireId ?? null,
        loadedQuestionnaireId: value?.questionnaireVoterDebug?.loadedQuestionnaireId ?? null,
        loadedQuestionCount: value?.questionnaireVoterDebug?.loadedQuestionCount ?? null,
        questionnaireDefinitionsSeen: value?.questionnaireVoterDebug?.questionnaireDefinitionsSeen ?? null,
        questionnaireOpenEventsSeen: value?.questionnaireVoterDebug?.questionnaireOpenEventsSeen ?? null,
        definitionSeenLive: value?.questionnaireVoterDebug?.definitionSeenLive ?? null,
        definitionSeenBackfill: value?.questionnaireVoterDebug?.definitionSeenBackfill ?? null,
        openSeenLive: value?.questionnaireVoterDebug?.openSeenLive ?? null,
        openSeenBackfill: value?.questionnaireVoterDebug?.openSeenBackfill ?? null,
        definitionSeenLiveCount: value?.questionnaireVoterDebug?.definitionSeenLiveCount ?? null,
        definitionSeenBackfillCount: value?.questionnaireVoterDebug?.definitionSeenBackfillCount ?? null,
        openSeenLiveCount: value?.questionnaireVoterDebug?.openSeenLiveCount ?? null,
        openSeenBackfillCount: value?.questionnaireVoterDebug?.openSeenBackfillCount ?? null,
        lastQuestionnaireDefinitionId: value?.questionnaireVoterDebug?.lastQuestionnaireDefinitionId ?? null,
        lastQuestionnaireOpenId: value?.questionnaireVoterDebug?.lastQuestionnaireOpenId ?? null,
        lastQuestionnaireFilterUsed: value?.questionnaireVoterDebug?.lastQuestionnaireFilterUsed ?? null,
        lastQuestionnaireRejectReason: value?.questionnaireVoterDebug?.lastQuestionnaireRejectReason ?? null,
        tokenRequested: value?.questionnaireVoterDebug?.tokenRequested ?? null,
        tokenReceived: value?.questionnaireVoterDebug?.tokenReceived ?? null,
        responseReady: value?.questionnaireVoterDebug?.responseReady ?? null,
        submitHandlerEntered: value?.questionnaireVoterDebug?.submitHandlerEntered ?? null,
        submitClicked: value?.questionnaireVoterDebug?.submitClicked ?? null,
        submitButtonPresent: value?.questionnaireVoterDebug?.submitButtonPresent ?? null,
        submitButtonVisible: value?.questionnaireVoterDebug?.submitButtonVisible ?? null,
        submitButtonDisabled: value?.questionnaireVoterDebug?.submitButtonDisabled ?? null,
        submitButtonText: value?.questionnaireVoterDebug?.submitButtonText ?? null,
        submitButtonReasonBlocked: value?.questionnaireVoterDebug?.submitButtonReasonBlocked ?? null,
        responsePayloadBuilt: value?.questionnaireVoterDebug?.responsePayloadBuilt ?? null,
        responsePayloadValidated: value?.questionnaireVoterDebug?.responsePayloadValidated ?? null,
        responsePublishStarted: value?.questionnaireVoterDebug?.responsePublishStarted ?? null,
        responsePublishSucceeded: value?.questionnaireVoterDebug?.responsePublishSucceeded ?? null,
        responseSeenBackLocally: value?.questionnaireVoterDebug?.responseSeenBackLocally ?? null,
        responseSeenByCoordinator: value?.questionnaireVoterDebug?.responseSeenByCoordinator ?? null,
        lastResponseRejectReason: value?.questionnaireVoterDebug?.lastResponseRejectReason ?? null,
        lastResponsePublishError: value?.questionnaireVoterDebug?.lastResponsePublishError ?? null,
        lastResponseEventId: value?.questionnaireVoterDebug?.lastResponseEventId ?? null,
        lastResponseEventKind: value?.questionnaireVoterDebug?.lastResponseEventKind ?? null,
        lastResponseEventCreatedAt: value?.questionnaireVoterDebug?.lastResponseEventCreatedAt ?? null,
        lastResponseEventTags: value?.questionnaireVoterDebug?.lastResponseEventTags ?? null,
        lastResponseRelayTargets: value?.questionnaireVoterDebug?.lastResponseRelayTargets ?? null,
        lastResponseRelaySuccessCount: value?.questionnaireVoterDebug?.lastResponseRelaySuccessCount ?? null,
        selectorDiagnostics: value?.questionnaireVoterDebug?.selectorDiagnostics ?? null,
        questionnaireDefinitionLiveFilter: value?.questionnaireVoterDebug?.questionnaireDefinitionLiveFilter ?? null,
        questionnaireDefinitionBackfillFilter: value?.questionnaireVoterDebug?.questionnaireDefinitionBackfillFilter ?? null,
        questionnaireStateLiveFilter: value?.questionnaireVoterDebug?.questionnaireStateLiveFilter ?? null,
        questionnaireStateBackfillFilter: value?.questionnaireVoterDebug?.questionnaireStateBackfillFilter ?? null,
        questionnaireResultLiveFilter: value?.questionnaireVoterDebug?.questionnaireResultLiveFilter ?? null,
        questionnaireResultBackfillFilter: value?.questionnaireVoterDebug?.questionnaireResultBackfillFilter ?? null,
        questionnaireDefinitionLiveResultCount: value?.questionnaireVoterDebug?.questionnaireDefinitionLiveResultCount ?? null,
        questionnaireDefinitionBackfillResultCount: value?.questionnaireVoterDebug?.questionnaireDefinitionBackfillResultCount ?? null,
        questionnaireStateLiveResultCount: value?.questionnaireVoterDebug?.questionnaireStateLiveResultCount ?? null,
        questionnaireStateBackfillResultCount: value?.questionnaireVoterDebug?.questionnaireStateBackfillResultCount ?? null,
        questionnaireResultLiveResultCount: value?.questionnaireVoterDebug?.questionnaireResultLiveResultCount ?? null,
        questionnaireResultBackfillResultCount: value?.questionnaireVoterDebug?.questionnaireResultBackfillResultCount ?? null,
        discoverySubscriptionStartedAt: value?.questionnaireVoterDebug?.discoverySubscriptionStartedAt ?? null,
        firstDefinitionSeenAt: value?.questionnaireVoterDebug?.firstDefinitionSeenAt ?? null,
        firstOpenSeenAt: value?.questionnaireVoterDebug?.firstOpenSeenAt ?? null,
        discoveryBackfillStartedAt: value?.questionnaireVoterDebug?.discoveryBackfillStartedAt ?? null,
        discoveryBackfillCompletedAt: value?.questionnaireVoterDebug?.discoveryBackfillCompletedAt ?? null,
        discoveryBackfillAttemptCount: value?.questionnaireVoterDebug?.discoveryBackfillAttemptCount ?? null,
      }]),
    );
    const questionnaireRejectReasonCounts = Object.values(voterQuestionnaireReadDiagnostics).reduce((acc, entry) => {
      const reason = typeof entry?.lastQuestionnaireRejectReason === "string"
        ? entry.lastQuestionnaireRejectReason
        : null;
      if (!reason) {
        return acc;
      }
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});
    const submitButtonBlockReasonCounts = Object.values(voterQuestionnaireReadDiagnostics).reduce((acc, entry) => {
      const reason = typeof entry?.submitButtonReasonBlocked === "string"
        ? entry.submitButtonReasonBlocked
        : null;
      if (!reason || reason === "none") {
        return acc;
      }
      acc[reason] = (acc[reason] ?? 0) + 1;
      return acc;
    }, {});
    const responseStageCounts = Object.values(voterQuestionnaireReadDiagnostics).reduce((acc, entry) => {
      const toBool = (value) => value === true;
      if (toBool(entry?.definitionSeenLive)) acc.definitionSeenLive += 1;
      if (toBool(entry?.definitionSeenBackfill)) acc.definitionSeenBackfill += 1;
      if (toBool(entry?.openSeenLive)) acc.openSeenLive += 1;
      if (toBool(entry?.openSeenBackfill)) acc.openSeenBackfill += 1;
      if (toBool(entry?.tokenRequested)) acc.tokenRequested += 1;
      if (toBool(entry?.tokenReceived)) acc.tokenReceived += 1;
      if (toBool(entry?.responseReady)) acc.responseReady += 1;
      if (toBool(entry?.submitHandlerEntered)) acc.submitHandlerEntered += 1;
      if (toBool(entry?.submitClicked)) acc.submitClicked += 1;
      if (toBool(entry?.responsePayloadBuilt)) acc.responsePayloadBuilt += 1;
      if (toBool(entry?.responsePayloadValidated)) acc.responsePayloadValidated += 1;
      if (toBool(entry?.responsePublishStarted)) acc.responsePublishStarted += 1;
      if (toBool(entry?.responsePublishSucceeded)) acc.responsePublishSucceeded += 1;
      if (toBool(entry?.responseSeenBackLocally)) acc.responseSeenBackLocally += 1;
      if (toBool(entry?.responseSeenByCoordinator)) acc.responseSeenByCoordinator += 1;
      return acc;
    }, {
      definitionSeenLive: 0,
      definitionSeenBackfill: 0,
      openSeenLive: 0,
      openSeenBackfill: 0,
      tokenRequested: 0,
      tokenReceived: 0,
      responseReady: 0,
      submitHandlerEntered: 0,
      submitClicked: 0,
      responsePayloadBuilt: 0,
      responsePayloadValidated: 0,
      responsePublishStarted: 0,
      responsePublishSucceeded: 0,
      responseSeenBackLocally: 0,
      responseSeenByCoordinator: 0,
    });
    const coordinatorIdentityContinuity = {
      draftQuestionnaireId: primaryCoordinatorQuestionnaireDebug?.draftQuestionnaireId ?? null,
      builtDefinitionQuestionnaireId: primaryCoordinatorQuestionnaireDebug?.builtDefinitionQuestionnaireId ?? null,
      definitionPublishQuestionnaireIdTag: primaryCoordinatorQuestionnaireDebug?.definitionPublishQuestionnaireIdTag ?? null,
      definitionPublishStartedAt: primaryCoordinatorQuestionnaireDebug?.definitionPublishStartedAt ?? null,
      definitionPublishSucceededAt: primaryCoordinatorQuestionnaireDebug?.definitionPublishSucceededAt ?? null,
      statePublishQuestionnaireIdTag: primaryCoordinatorQuestionnaireDebug?.statePublishQuestionnaireIdTag ?? null,
      statePublishStartedAt: primaryCoordinatorQuestionnaireDebug?.statePublishStartedAt ?? null,
      statePublishSucceededAt: primaryCoordinatorQuestionnaireDebug?.statePublishSucceededAt ?? null,
      deploymentMode: primaryCoordinatorQuestionnaireDebug?.deploymentMode ?? null,
      courseFeedbackAcceptanceEnabled: primaryCoordinatorQuestionnaireDebug?.courseFeedbackAcceptanceEnabled ?? null,
      legacyRoundGatingBypassed: primaryCoordinatorQuestionnaireDebug?.legacyRoundGatingBypassed ?? null,
      responseAcceptedViaQuestionnairePlane: primaryCoordinatorQuestionnaireDebug?.responseAcceptedViaQuestionnairePlane ?? null,
      responseRejectedBecauseLegacyRoundRequired: primaryCoordinatorQuestionnaireDebug?.responseRejectedBecauseLegacyRoundRequired ?? null,
      responseEventsSeen: primaryCoordinatorQuestionnaireDebug?.responseEventsSeen ?? null,
      acceptedResponseCount: primaryCoordinatorQuestionnaireDebug?.acceptedResponseCount ?? null,
      rejectedResponseCount: primaryCoordinatorQuestionnaireDebug?.rejectedResponseCount ?? null,
      lastResponseSeenEventId: primaryCoordinatorQuestionnaireDebug?.lastResponseSeenEventId ?? null,
      lastResponseRejectReason: primaryCoordinatorQuestionnaireDebug?.lastResponseRejectReason ?? null,
      latestDefinitionId: primaryCoordinatorQuestionnaireDebug?.latestDefinitionId ?? null,
      continuityIds: primaryCoordinatorQuestionnaireDebug?.continuityIds ?? [],
      continuityOk: primaryCoordinatorQuestionnaireDebug?.questionnaireIdentityContinuityOk ?? null,
    };
    const responsePublishAttemptedCount = Number(responseStageCounts.responsePublishStarted ?? 0);
    const responsePublishSucceededCount = Number(responseStageCounts.responsePublishSucceeded ?? 0);
    const responseObservedByVoterBackfillCount = Number(responseStageCounts.responseSeenBackLocally ?? 0);
    const responseObservedByCoordinatorCount = Number(coordinatorIdentityContinuity.responseEventsSeen ?? responseEventCount ?? 0);
    const acceptedUniqueResponderCount = acceptedResponsesCount;
    const tokenRequestedCount = Number(responseStageCounts.tokenRequested ?? 0);
    const tokenReceivedCount = Number(responseStageCounts.tokenReceived ?? 0);
    const responseReadyCount = Number(responseStageCounts.responseReady ?? 0);
    const definitionSeenLiveCount = Number(responseStageCounts.definitionSeenLive ?? 0);
    const definitionSeenBackfillCount = Number(responseStageCounts.definitionSeenBackfill ?? 0);
    const openSeenLiveCount = Number(responseStageCounts.openSeenLive ?? 0);
    const openSeenBackfillCount = Number(responseStageCounts.openSeenBackfill ?? 0);
    const visibilityOnlySuccessCore = expectedAcceptedThreshold > 0
      && questionnaireSeenCount >= expectedAcceptedThreshold
      && questionnaireOpenCount >= expectedAcceptedThreshold;
    const roundSuccessCore = expectedAcceptedThreshold > 0
      && questionnaireSeenCount >= expectedAcceptedThreshold
      && questionnaireOpenCount >= expectedAcceptedThreshold
      && responsePublishAttemptedCount >= expectedAcceptedThreshold
      && responsePublishSucceededCount >= expectedAcceptedThreshold
      && responseObservedByVoterBackfillCount >= expectedAcceptedThreshold
      && responseObservedByCoordinatorCount >= expectedAcceptedThreshold
      && acceptedUniqueResponderCount >= expectedAcceptedThreshold
      && eachVoterPublishedExactlyOneResponse
      && acceptanceAccountingMatches
      && definitionEventCount >= 1
      && questionnaireIdsSeenByVoters.length === 1
      && questionCountsSeenByVoters.length === 1;
    const roundSuccess = isQuestionnaireFlowDeployment(deploymentMode)
      ? (visibilityOnly ? visibilityOnlySuccessCore : roundSuccessCore)
      : voterTicketSummary.length > 0 && voterTicketSummary.every((entry) => entry.hasTicket);
    return {
      round: round.round,
      prompt: round.prompt,
      deploymentMode,
      roundSuccess,
      sendCounts: round.sendCounts,
      votersWithTickets: voterTicketSummary.filter((entry) => entry.hasTicket).length,
      votersWithSubmittedBallots: voterTicketSummary.filter((entry) => entry.ballotSubmitted).length,
      votersWithAcceptedBallots: voterTicketSummary.filter((entry) => entry.ballotAccepted).length,
      voterPublishedBallots,
      voterObservedTickets,
      questionnaireSeenCount,
      questionnaireOpenCount,
      definitionSeenLiveCount,
      definitionSeenBackfillCount,
      openSeenLiveCount,
      openSeenBackfillCount,
      eligibilityRequestedCount: tokenRequestedCount,
      blindIssueReceivedCount: tokenReceivedCount,
      responseTokenReadyCount: responseReadyCount,
      responsesPublishedCount,
      acceptedResponsesCount,
      rejectedResponsesCount,
      responsePublishAttemptedCount,
      responsePublishSucceededCount,
      responseObservedByVoterBackfillCount,
      responseObservedByCoordinatorCount,
      acceptedUniqueResponderCount,
      duplicateNullifierCount: 0,
      resultSummaryPublished,
      resultSummaryDiagnostic: {
        resultSummaryPublished,
        localSummaryMatchesPublished,
        coordinatorSummaryAcceptedCount,
        resultEventCount,
      },
      questionnairePublishDiagnostics: {
        definition: primaryCoordinatorQuestionnaireDebug?.definitionPublishDiagnostic ?? null,
        state: primaryCoordinatorQuestionnaireDebug?.statePublishDiagnostic ?? null,
        result: primaryCoordinatorQuestionnaireDebug?.resultPublishDiagnostic ?? null,
      },
      questionnaireRejectReasonCounts,
      submitButtonBlockReasonCounts,
      responseStageCounts,
      coordinatorIdentityContinuity,
      voterQuestionnaireReadDiagnostics,
      definitionEventCount,
      resultEventCount,
      responseEventCount,
      coordinatorSummaryAcceptedCount,
      localSummaryMatchesPublished,
      acceptanceAccountingMatches,
      eachVoterPublishedExactlyOneResponse,
      questionnaireIdsSeenByVoters,
      questionCountsSeenByVoters,
      responsesPerVoter,
      coordinatorAcceptedBallots,
      coordinatorRejectedBallots,
      coordinatorAcceptedByLineage,
      coordinatorTicketPublishStartedCount: Number(primaryCoordinatorDebug?.ticketPublishStartedCount ?? 0),
      coordinatorTicketPublishSucceededCount: Number(primaryCoordinatorDebug?.ticketPublishSucceededCount ?? 0),
      coordinatorTicketStillMissingCount: Number(primaryCoordinatorDebug?.ticketStillMissingCount ?? 0),
      coordinatorTicketResentCount: Number(primaryCoordinatorDebug?.ticketResentCount ?? 0),
      ticketObservedLiveCount,
      ticketObservedBackfillCount,
      ticketRecoveredByResendCount,
      ticketStillMissingCount,
      sendQueueEligibleCount,
      sendQueueStartedCount,
      sendQueueBlockedCount,
      sendQueueBlockedReasons,
      sendQueueInFlightCount,
      sendQueueUnsentCount,
      roundOpenAt,
      lastTicketSendStartedAt,
      unsentRowsAtRoundTimeout,
      rowsWithPublishSuccessNoObservation,
      rowsWithFullRelaySuccessNoObservation,
      rowsWithPartialRelaySuccessNoObservation,
      rowsWithPublishUnconfirmedEventuallyObserved,
      rowsObservedOnlyAfterBackfill,
      rowsWithRelayOverlapNoObservation,
      rowsWithNoRelayOverlapNoObservation,
      rowsWithReadRelaySetUnknown,
      rowsWithMailboxFilterMismatchNoObservation,
      rowsWithMailboxIdMismatchNoObservation,
      backfillFailureClassCounts,
      publishSuccessObservationGapRatio,
      fullRelaySuccessObservationGapRatio,
      backfillObservationRecoveryRatio,
      backfillTriggeredRatio,
      rowsWithoutAcceptedBallotCount: rowsWithoutAcceptedBallot.length,
      unmatchedRowDiagnostics,
      totalVoters: voterTicketSummary.length,
      voterTicketSummary,
      stageMetrics,
      ticketSentCount,
      ticketObservedCount,
      ballotSubmittedCount,
      ballotAcceptedCount,
      ticketDeliveryConfirmedByAckCount,
      ticketDeliveryConfirmedByBallotCount,
      ticketDeliveryConfirmedCount,
      coordinatorFailureHints: Object.entries(round.state.coordinatorStates).map(([key, value]) => ({
        coordinator: key,
        waitingForRequests: value.diagnostics.filter((line) => line.includes("Waiting for this voter's blinded ticket request")).length,
        waitingForAcknowledgements: value.diagnostics.filter((line) => line.includes("acknowledgement")).length,
        waitingForCompletionConfirmation: value.diagnostics.filter((line) => line.includes("valid ballot submission")).length,
      })),
      startupJoinFailureBucket: primaryCoordinatorDebug?.startupDiagnostics?.startupJoinFailureBucket ?? null,
      startupDiagnostics: primaryCoordinatorDebug?.startupDiagnostics ?? null,
    };
  });

  for (const roundSummary of summary) {
    const diagnostics = Array.isArray(roundSummary.unmatchedRowDiagnostics)
      ? roundSummary.unmatchedRowDiagnostics
      : [];
    const candidate = diagnostics.find((entry) => (
      Boolean(entry.ticketPublishSucceededAt)
      && !entry.ticketObserved
      && Number(entry.ticketPublishEventKind ?? 0) > 0
      && Array.isArray(entry.ticketRelayResults)
      && entry.ticketRelayResults.some((result) => result?.success)
    ));
    if (!candidate) {
      roundSummary.phase10ObservationProbe = null;
    } else {
      const successfulRelay = candidate.ticketRelayResults.find((result) => result?.success)?.relay
        ?? candidate.ticketRelayTargets[0]
        ?? null;
      const ticketTags = Array.isArray(candidate.ticketPublishEventTags) ? candidate.ticketPublishEventTags : [];
      const publishedMailboxTag = ticketTags.find((tag) => tag?.[0] === "mailbox")?.[1] ?? null;
      const publishedEtypeTag = ticketTags.find((tag) => tag?.[0] === "etype")?.[1] ?? null;
      const publishedTicketTag = ticketTags.find((tag) => tag?.[0] === "ticket")?.[1] ?? null;
      const publishedRequestTag = ticketTags.find((tag) => tag?.[0] === "request")?.[1] ?? null;
      const liveQuery = candidate.ticketLiveQuery ?? null;
      const backfillQuery = candidate.ticketBackfillQuery ?? null;
      const relayProbe = successfulRelay
        ? await runRelayProbe({
          relay: successfulRelay,
          kind: candidate.ticketPublishEventKind,
          mailboxId: candidate.requestMailboxId ?? publishedMailboxTag,
          etype: publishedEtypeTag ?? "mailbox_ticket_envelope",
          eventId: candidate.ticketPublishEventId,
          ticketId: candidate.ticketId ?? publishedTicketTag,
          requestId: candidate.requestId ?? publishedRequestTag,
        })
        : null;

      roundSummary.phase10ObservationProbe = {
        voterPubkey: candidate.voterPubkey,
        requestId: candidate.requestId,
        requestMailboxId: candidate.requestMailboxId,
        ticketId: candidate.ticketId,
        published: {
          eventId: candidate.ticketPublishEventId,
          kind: candidate.ticketPublishEventKind,
          createdAt: candidate.ticketPublishEventCreatedAt,
          tags: ticketTags,
          mailboxTag: publishedMailboxTag,
          etypeTag: publishedEtypeTag,
          requestTag: publishedRequestTag,
          ticketTag: publishedTicketTag,
          relayTargets: candidate.ticketRelayTargets,
          relayResults: candidate.ticketRelayResults,
        },
        readerFilters: {
          live: liveQuery,
          backfill: backfillQuery,
        },
        filterComparison: {
          kindMatchesLive: Number(liveQuery?.kinds?.[0] ?? 0) === Number(candidate.ticketPublishEventKind ?? 0),
          kindMatchesBackfill: Number(backfillQuery?.kinds?.[0] ?? 0) === Number(candidate.ticketPublishEventKind ?? 0),
          publishedMailboxMatchesRequest: Boolean(candidate.requestMailboxId && publishedMailboxTag)
            ? candidate.requestMailboxId === publishedMailboxTag
            : null,
          mailboxMatchesLive: Boolean(candidate.requestMailboxId)
            ? Array.isArray(liveQuery?.mailboxIds) && liveQuery.mailboxIds.includes(candidate.requestMailboxId)
            : null,
          mailboxMatchesBackfill: Boolean(candidate.requestMailboxId)
            ? (
              (Array.isArray(backfillQuery?.mailboxIds) && backfillQuery.mailboxIds.includes(candidate.requestMailboxId))
              || (Array.isArray(candidate.ticketPendingMailboxIds) && candidate.ticketPendingMailboxIds.includes(candidate.requestMailboxId))
            )
            : null,
          etypeMatchesLive: Boolean(publishedEtypeTag)
            ? Array.isArray(liveQuery?.eventTypes) && liveQuery.eventTypes.includes(publishedEtypeTag)
            : null,
          etypeMatchesBackfill: Boolean(publishedEtypeTag)
            ? Array.isArray(backfillQuery?.eventTypes) && backfillQuery.eventTypes.includes(publishedEtypeTag)
            : null,
          relayOverlap: Array.isArray(candidate.ticketRelayTargets)
            ? candidate.ticketRelayTargets.filter((relay) => (
              Array.isArray(liveQuery?.relays) && liveQuery.relays.includes(relay)
            ) || (
              Array.isArray(backfillQuery?.relays) && backfillQuery.relays.includes(relay)
            ))
            : [],
        },
        relayProbe,
      };
    }

    if (!isQuestionnaireFlowDeployment(roundSummary.deploymentMode)) {
      roundSummary.phase22QuestionnaireProbe = null;
      continue;
    }

    const questionnaireId = Array.isArray(roundSummary.questionnaireIdsSeenByVoters)
      ? roundSummary.questionnaireIdsSeenByVoters[0] ?? null
      : null;
    const publishDiagnostics = roundSummary.questionnairePublishDiagnostics ?? {};
    const definitionPublish = publishDiagnostics.definition ?? null;
    const statePublish = publishDiagnostics.state ?? null;
    const resultPublish = publishDiagnostics.result ?? null;
    const definitionRelay = definitionPublish?.relayTargets?.[0] ?? null;
    const stateRelay = statePublish?.relayTargets?.[0] ?? null;
    const resultRelay = resultPublish?.relayTargets?.[0] ?? null;
    const voterResponsePublishEntry = Object.values(roundSummary.voterQuestionnaireReadDiagnostics ?? {})
      .find((entry) => entry?.lastResponseEventId);
    const responseRelay = Array.isArray(voterResponsePublishEntry?.lastResponseRelayTargets)
      ? voterResponsePublishEntry.lastResponseRelayTargets[0] ?? null
      : null;
    const responseKind = Number(voterResponsePublishEntry?.lastResponseEventKind ?? 0);
    const responseEventId = String(voterResponsePublishEntry?.lastResponseEventId ?? "");

    const probeQuestionnaireId = questionnaireId
      ?? definitionPublish?.tags?.find?.((tag) => Array.isArray(tag) && tag[0] === "questionnaire-id")?.[1]
      ?? roundSummary?.voterQuestionnaireReadDiagnostics?.voter1?.questionnaireId
      ?? null;

    const definitionRelayProbe = definitionRelay && probeQuestionnaireId
      ? await runQuestionnaireRelayProbe({
        relay: definitionRelay,
        kind: Number(definitionPublish?.kind ?? 0),
        questionnaireId: probeQuestionnaireId,
        tTag: "questionnaire_definition",
        eventId: definitionPublish?.eventId ?? "",
      })
      : null;
    const stateRelayProbe = stateRelay && probeQuestionnaireId
      ? await runQuestionnaireRelayProbe({
        relay: stateRelay,
        kind: Number(statePublish?.kind ?? 0),
        questionnaireId: probeQuestionnaireId,
        tTag: "questionnaire_state",
        eventId: statePublish?.eventId ?? "",
      })
      : null;
    const resultRelayProbe = resultRelay && probeQuestionnaireId
      ? await runQuestionnaireRelayProbe({
        relay: resultRelay,
        kind: Number(resultPublish?.kind ?? 0),
        questionnaireId: probeQuestionnaireId,
        tTag: "questionnaire_result_summary",
        eventId: resultPublish?.eventId ?? "",
      })
      : null;
    const responseRelayProbe = responseRelay && probeQuestionnaireId && responseKind > 0
      ? await runQuestionnaireRelayProbe({
        relay: responseRelay,
        kind: responseKind,
        questionnaireId: probeQuestionnaireId,
        tTag: "questionnaire_response_private",
        eventId: responseEventId,
      })
      : null;

    roundSummary.phase22QuestionnaireProbe = {
      questionnaireId,
      probeQuestionnaireId,
      definitionPublish,
      statePublish,
      resultPublish,
      responsePublish: voterResponsePublishEntry
        ? {
          eventId: voterResponsePublishEntry.lastResponseEventId ?? null,
          kind: voterResponsePublishEntry.lastResponseEventKind ?? null,
          createdAt: voterResponsePublishEntry.lastResponseEventCreatedAt ?? null,
          tags: voterResponsePublishEntry.lastResponseEventTags ?? [],
          relayTargets: voterResponsePublishEntry.lastResponseRelayTargets ?? [],
          relaySuccessCount: voterResponsePublishEntry.lastResponseRelaySuccessCount ?? null,
        }
        : null,
      voterReadDiagnostics: roundSummary.voterQuestionnaireReadDiagnostics ?? {},
      relayProbes: {
        definition: definitionRelayProbe,
        state: stateRelayProbe,
        result: resultRelayProbe,
        response: responseRelayProbe,
      },
    };
  }

  const completedRounds = summary.filter((roundSummary) => Boolean(roundSummary.roundSuccess)).length;
  const passed = summary.length > 0 && completedRounds === summary.length;
  const latestRoundState = rounds.at(-1)?.state ?? null;
  timeline.finalSnapshot = isQuestionnaireFlowDeployment(deploymentMode) && latestRoundState
    ? buildQuestionnaireFinalSnapshotFromRound(latestRoundState)
    : null;
  timeline.summary = {
    passed,
    completedRounds,
    totalRounds: summary.length,
  };

  console.log(JSON.stringify({
    runId: timeline.runId,
    startedAtMs: timeline.startedAtMs,
    config: {
      base,
      deploymentMode,
      visibilityOnly,
      nip65Mode,
      coordinatorCount,
      voterCount,
      roundCount,
      startupWaitMs,
      roundWaitMs,
      ticketWaitMs,
      questionnaireSubmitReadyWaitMs,
      harnessTimeoutMs,
      voterStartupStaggerMs,
      batchSize,
      checkpointFile,
      resumeFromCheckpoint,
      preflight,
    },
    passed,
    completedRounds,
    globalTimeline: timeline.globalTimeline,
    coordinatorTimeline: timeline.coordinatorTimeline,
    voterTimelines: timeline.voterTimelines,
    finalSnapshot: timeline.finalSnapshot,
    timelineSummary: timeline.summary,
    summary,
    rounds,
  }, null, 2));

  if (timeoutId !== null) {
    globalThis.clearTimeout(timeoutId);
  }
  relayProbePool.destroy?.();
  await browser.close();
}
void main();

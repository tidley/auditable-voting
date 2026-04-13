import { spawn } from "node:child_process";

function readIntEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function runHarness(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["scripts/live-simple-relay-check.js"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`live harness exited with code ${code}\n${stderr || stdout}`));
        return;
      }

      const trimmed = stdout.trim();
      try {
        resolve(JSON.parse(trimmed));
      } catch (error) {
        reject(new Error(`failed to parse harness JSON\n${trimmed}\n${stderr}\n${String(error)}`));
      }
    });
  });
}

function summariseRun(run) {
  const rounds = Array.isArray(run?.summary) ? run.summary : [];
  const deploymentMode = String(run?.config?.deploymentMode ?? process.env.LIVE_DEPLOYMENT_MODE ?? "course_feedback").trim().toLowerCase();
  const roundOutcomes = rounds.map((roundSummary) => {
    const round = Number(roundSummary.round ?? 0);
    const totalVoters = Number(roundSummary.totalVoters ?? 0);
    const votersWithTickets = Number(roundSummary.votersWithTickets ?? 0);
    const votersWithAcceptedBallots = Number(roundSummary.votersWithAcceptedBallots ?? 0);
    const coordinatorAcceptedBallots = Number(roundSummary.coordinatorAcceptedBallots ?? 0);
    const coordinatorRejectedBallots = Number(roundSummary.coordinatorRejectedBallots ?? 0);
    const coordinatorAcceptedByLineage = Number(roundSummary.coordinatorAcceptedByLineage ?? 0);
    const voterPublishedBallots = Number(roundSummary.voterPublishedBallots ?? 0);
    const voterObservedTickets = Number(roundSummary.voterObservedTickets ?? 0);
    const unmatchedRowDiagnostics = Array.isArray(roundSummary.unmatchedRowDiagnostics)
      ? roundSummary.unmatchedRowDiagnostics
      : [];
    const unmatchedStageCounts = unmatchedRowDiagnostics.reduce((acc, item) => {
      const key = String(item?.firstMissingStage ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    const ticketSent = Number(roundSummary.ticketSentCount ?? roundSummary.stageMetrics?.ticketSent?.count ?? 0);
    const totalPairs = Number(roundSummary.stageMetrics?.ticketSent?.totalPairs ?? 0);
    const success = deploymentMode === "course_feedback"
      ? totalVoters > 0 && coordinatorAcceptedBallots >= totalVoters
      : totalVoters > 0 && votersWithTickets === totalVoters;
    const stageMetrics = roundSummary.stageMetrics ?? {};
    return {
      round,
      success,
      deploymentMode,
      totalVoters,
      votersWithTickets,
      votersWithAcceptedBallots,
      coordinatorAcceptedBallots,
      coordinatorRejectedBallots,
      coordinatorAcceptedByLineage,
      voterPublishedBallots,
      voterObservedTickets,
      rowsWithoutAcceptedBallotCount: Number(roundSummary.rowsWithoutAcceptedBallotCount ?? unmatchedRowDiagnostics.length),
      unmatchedRowDiagnostics,
      unmatchedStageCounts,
      ticketSent,
      ballotSubmitted: Number(roundSummary.ballotSubmittedCount ?? stageMetrics.ballotSubmitted?.count ?? 0),
      ballotAccepted: Number(roundSummary.ballotAcceptedCount ?? stageMetrics.ballotAccepted?.count ?? 0),
      completionByBallot: Number(roundSummary.ticketDeliveryConfirmedByBallotCount ?? stageMetrics.ticketDeliveryConfirmedByBallot?.count ?? 0),
      ackSeen: Number(stageMetrics.receiptAcknowledged?.count ?? 0),
      totalPairs: Number(stageMetrics.receiptAcknowledged?.totalPairs ?? stageMetrics.ticketSent?.totalPairs ?? 0),
    };
  });

  return {
    passed: roundOutcomes.length > 0 && roundOutcomes.every((round) => round.success),
    roundOutcomes,
  };
}

async function main() {
  const repeatCount = readIntEnv("LIVE_REPEAT_COUNT", 10);
  const results = [];

  for (let index = 0; index < repeatCount; index += 1) {
    const run = await runHarness({});
    const summary = summariseRun(run);
    results.push(summary);
  }

  const roundsByNumber = new Map();
  for (const result of results) {
    for (const round of result.roundOutcomes) {
      const entry = roundsByNumber.get(round.round) ?? {
        round: round.round,
        successes: 0,
        failures: 0,
        votersWithTickets: [],
        ticketSent: [],
        votersWithAcceptedBallots: [],
        coordinatorAcceptedBallots: [],
        coordinatorRejectedBallots: [],
        coordinatorAcceptedByLineage: [],
        voterPublishedBallots: [],
        voterObservedTickets: [],
        rowsWithoutAcceptedBallotCount: [],
        unmatchedStageCounts: {},
        unmatchedRows: [],
        ballotSubmitted: [],
        ballotAccepted: [],
        completionByBallot: [],
        ackSeen: [],
        totalPairs: [],
      };
      if (round.success) {
        entry.successes += 1;
      } else {
        entry.failures += 1;
      }
      entry.votersWithTickets.push(round.votersWithTickets);
      entry.ticketSent.push(round.ticketSent);
      entry.votersWithAcceptedBallots.push(round.votersWithAcceptedBallots);
      entry.coordinatorAcceptedBallots.push(round.coordinatorAcceptedBallots);
      entry.coordinatorRejectedBallots.push(round.coordinatorRejectedBallots);
      entry.coordinatorAcceptedByLineage.push(round.coordinatorAcceptedByLineage);
      entry.voterPublishedBallots.push(round.voterPublishedBallots);
      entry.voterObservedTickets.push(round.voterObservedTickets);
      entry.rowsWithoutAcceptedBallotCount.push(round.rowsWithoutAcceptedBallotCount);
      for (const [stage, count] of Object.entries(round.unmatchedStageCounts ?? {})) {
        entry.unmatchedStageCounts[stage] = (entry.unmatchedStageCounts[stage] ?? 0) + Number(count ?? 0);
      }
      for (const row of round.unmatchedRowDiagnostics ?? []) {
        entry.unmatchedRows.push({
          voterPubkey: row.voterPubkey,
          firstMissingStage: row.firstMissingStage,
          requestId: row.requestId,
          ticketId: row.ticketId,
        });
      }
      entry.ballotSubmitted.push(round.ballotSubmitted);
      entry.ballotAccepted.push(round.ballotAccepted);
      entry.completionByBallot.push(round.completionByBallot);
      entry.ackSeen.push(round.ackSeen);
      entry.totalPairs.push(round.totalPairs);
      roundsByNumber.set(round.round, entry);
    }
  }

  const output = {
    repeatCount,
    passedRuns: results.filter((result) => result.passed).length,
    failedRuns: results.filter((result) => !result.passed).length,
    runs: results,
    rounds: Array.from(roundsByNumber.values()).sort((left, right) => left.round - right.round),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

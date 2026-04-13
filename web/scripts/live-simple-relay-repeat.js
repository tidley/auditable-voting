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
    const unmatchedLiveObserved = unmatchedRowDiagnostics.filter((entry) => Number(entry.ticketObservedLiveCount ?? 0) > 0).length;
    const unmatchedBackfillObserved = unmatchedRowDiagnostics.filter((entry) => Number(entry.ticketObservedBackfillCount ?? 0) > 0).length;
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
      unmatchedLiveObserved,
      unmatchedBackfillObserved,
      rowsWithoutAcceptedBallotCount: Number(roundSummary.rowsWithoutAcceptedBallotCount ?? unmatchedRowDiagnostics.length),
      coordinatorTicketPublishStartedCount: Number(roundSummary.coordinatorTicketPublishStartedCount ?? 0),
      coordinatorTicketPublishSucceededCount: Number(roundSummary.coordinatorTicketPublishSucceededCount ?? 0),
      coordinatorTicketStillMissingCount: Number(roundSummary.coordinatorTicketStillMissingCount ?? 0),
      coordinatorTicketResentCount: Number(roundSummary.coordinatorTicketResentCount ?? 0),
      rowsWithPublishSuccessNoObservation: Number(roundSummary.rowsWithPublishSuccessNoObservation ?? 0),
      rowsWithFullRelaySuccessNoObservation: Number(roundSummary.rowsWithFullRelaySuccessNoObservation ?? 0),
      rowsWithPartialRelaySuccessNoObservation: Number(roundSummary.rowsWithPartialRelaySuccessNoObservation ?? 0),
      rowsWithPublishUnconfirmedEventuallyObserved: Number(roundSummary.rowsWithPublishUnconfirmedEventuallyObserved ?? 0),
      rowsObservedOnlyAfterBackfill: Number(roundSummary.rowsObservedOnlyAfterBackfill ?? 0),
      rowsWithRelayOverlapNoObservation: Number(roundSummary.rowsWithRelayOverlapNoObservation ?? 0),
      rowsWithNoRelayOverlapNoObservation: Number(roundSummary.rowsWithNoRelayOverlapNoObservation ?? 0),
      rowsWithReadRelaySetUnknown: Number(roundSummary.rowsWithReadRelaySetUnknown ?? 0),
      rowsWithMailboxFilterMismatchNoObservation: Number(roundSummary.rowsWithMailboxFilterMismatchNoObservation ?? 0),
      rowsWithMailboxIdMismatchNoObservation: Number(roundSummary.rowsWithMailboxIdMismatchNoObservation ?? 0),
      backfillFailureClassCounts: roundSummary.backfillFailureClassCounts ?? {},
      publishSuccessObservationGapRatio: Number(roundSummary.publishSuccessObservationGapRatio ?? 0),
      fullRelaySuccessObservationGapRatio: Number(roundSummary.fullRelaySuccessObservationGapRatio ?? 0),
      backfillObservationRecoveryRatio: Number(roundSummary.backfillObservationRecoveryRatio ?? 0),
      backfillTriggeredRatio: Number(roundSummary.backfillTriggeredRatio ?? 0),
      startupJoinFailureBucket: roundSummary.startupJoinFailureBucket ?? null,
      ticketObservedLiveCount: Number(roundSummary.ticketObservedLiveCount ?? 0),
      ticketObservedBackfillCount: Number(roundSummary.ticketObservedBackfillCount ?? 0),
      ticketRecoveredByResendCount: Number(roundSummary.ticketRecoveredByResendCount ?? 0),
      ticketStillMissingCount: Number(roundSummary.ticketStillMissingCount ?? 0),
      sendQueueEligibleCount: Number(roundSummary.sendQueueEligibleCount ?? 0),
      sendQueueStartedCount: Number(roundSummary.sendQueueStartedCount ?? 0),
      sendQueueBlockedCount: Number(roundSummary.sendQueueBlockedCount ?? 0),
      sendQueueBlockedReasons: roundSummary.sendQueueBlockedReasons ?? {},
      sendQueueInFlightCount: Number(roundSummary.sendQueueInFlightCount ?? 0),
      sendQueueUnsentCount: Number(roundSummary.sendQueueUnsentCount ?? 0),
      unsentRowsAtRoundTimeout: Number(roundSummary.unsentRowsAtRoundTimeout ?? 0),
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
        unmatchedLiveObserved: [],
        unmatchedBackfillObserved: [],
        coordinatorTicketPublishStartedCount: [],
        coordinatorTicketPublishSucceededCount: [],
        coordinatorTicketStillMissingCount: [],
        coordinatorTicketResentCount: [],
        rowsWithPublishSuccessNoObservation: [],
        rowsWithFullRelaySuccessNoObservation: [],
        rowsWithPartialRelaySuccessNoObservation: [],
        rowsWithPublishUnconfirmedEventuallyObserved: [],
        rowsObservedOnlyAfterBackfill: [],
        rowsWithRelayOverlapNoObservation: [],
        rowsWithNoRelayOverlapNoObservation: [],
        rowsWithReadRelaySetUnknown: [],
        rowsWithMailboxFilterMismatchNoObservation: [],
        rowsWithMailboxIdMismatchNoObservation: [],
        backfillFailureClassCounts: {},
        publishSuccessObservationGapRatio: [],
        fullRelaySuccessObservationGapRatio: [],
        backfillObservationRecoveryRatio: [],
        backfillTriggeredRatio: [],
        startupJoinFailureBucketCounts: {},
        ticketObservedLiveCount: [],
        ticketObservedBackfillCount: [],
        ticketRecoveredByResendCount: [],
        ticketStillMissingCount: [],
        sendQueueEligibleCount: [],
        sendQueueStartedCount: [],
        sendQueueBlockedCount: [],
        sendQueueBlockedReasons: {},
        sendQueueInFlightCount: [],
        sendQueueUnsentCount: [],
        unsentRowsAtRoundTimeout: [],
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
      entry.unmatchedLiveObserved.push(round.unmatchedLiveObserved);
      entry.unmatchedBackfillObserved.push(round.unmatchedBackfillObserved);
      entry.coordinatorTicketPublishStartedCount.push(round.coordinatorTicketPublishStartedCount);
      entry.coordinatorTicketPublishSucceededCount.push(round.coordinatorTicketPublishSucceededCount);
      entry.coordinatorTicketStillMissingCount.push(round.coordinatorTicketStillMissingCount);
      entry.coordinatorTicketResentCount.push(round.coordinatorTicketResentCount);
      entry.rowsWithPublishSuccessNoObservation.push(round.rowsWithPublishSuccessNoObservation);
      entry.rowsWithFullRelaySuccessNoObservation.push(round.rowsWithFullRelaySuccessNoObservation);
      entry.rowsWithPartialRelaySuccessNoObservation.push(round.rowsWithPartialRelaySuccessNoObservation);
      entry.rowsWithPublishUnconfirmedEventuallyObserved.push(round.rowsWithPublishUnconfirmedEventuallyObserved);
      entry.rowsObservedOnlyAfterBackfill.push(round.rowsObservedOnlyAfterBackfill);
      entry.rowsWithRelayOverlapNoObservation.push(round.rowsWithRelayOverlapNoObservation);
      entry.rowsWithNoRelayOverlapNoObservation.push(round.rowsWithNoRelayOverlapNoObservation);
      entry.rowsWithReadRelaySetUnknown.push(round.rowsWithReadRelaySetUnknown);
      entry.rowsWithMailboxFilterMismatchNoObservation.push(round.rowsWithMailboxFilterMismatchNoObservation);
      entry.rowsWithMailboxIdMismatchNoObservation.push(round.rowsWithMailboxIdMismatchNoObservation);
      entry.publishSuccessObservationGapRatio.push(round.publishSuccessObservationGapRatio);
      entry.fullRelaySuccessObservationGapRatio.push(round.fullRelaySuccessObservationGapRatio);
      entry.backfillObservationRecoveryRatio.push(round.backfillObservationRecoveryRatio);
      entry.backfillTriggeredRatio.push(round.backfillTriggeredRatio);
      if (round.startupJoinFailureBucket) {
        const key = String(round.startupJoinFailureBucket);
        entry.startupJoinFailureBucketCounts[key] = (entry.startupJoinFailureBucketCounts[key] ?? 0) + 1;
      }
      entry.ticketObservedLiveCount.push(round.ticketObservedLiveCount);
      entry.ticketObservedBackfillCount.push(round.ticketObservedBackfillCount);
      entry.ticketRecoveredByResendCount.push(round.ticketRecoveredByResendCount);
      entry.ticketStillMissingCount.push(round.ticketStillMissingCount);
      entry.sendQueueEligibleCount.push(round.sendQueueEligibleCount);
      entry.sendQueueStartedCount.push(round.sendQueueStartedCount);
      entry.sendQueueBlockedCount.push(round.sendQueueBlockedCount);
      entry.sendQueueInFlightCount.push(round.sendQueueInFlightCount);
      entry.sendQueueUnsentCount.push(round.sendQueueUnsentCount);
      entry.unsentRowsAtRoundTimeout.push(round.unsentRowsAtRoundTimeout);
      for (const [reason, count] of Object.entries(round.sendQueueBlockedReasons ?? {})) {
        entry.sendQueueBlockedReasons[reason] = (entry.sendQueueBlockedReasons[reason] ?? 0) + Number(count ?? 0);
      }
      for (const [stage, count] of Object.entries(round.unmatchedStageCounts ?? {})) {
        entry.unmatchedStageCounts[stage] = (entry.unmatchedStageCounts[stage] ?? 0) + Number(count ?? 0);
      }
      for (const [reason, count] of Object.entries(round.backfillFailureClassCounts ?? {})) {
        entry.backfillFailureClassCounts[reason] = (entry.backfillFailureClassCounts[reason] ?? 0) + Number(count ?? 0);
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

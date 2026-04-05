import type { SimpleLiveVoteSession } from "./simpleVotingSession";
import type { SimpleShardResponse } from "./simpleShardDm";
import { parseSimpleShardCertificate } from "./simpleShardCertificate";
import {
  buildSimpleVoteTicketRowsRust,
  sortRecordsByCreatedAtDescRust,
} from "./wasm/auditableVotingCore";

export type SimpleVoteTicketRow = {
  votingId: string;
  prompt: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  countsByCoordinator: Record<string, number>;
};

export function buildSimpleVoteTicketRows(
  receivedShards: SimpleShardResponse[],
  configuredCoordinatorTargets: string[],
): SimpleVoteTicketRow[] {
  const entries: Array<{
    votingId: string;
    prompt: string;
    createdAt: string;
    thresholdT?: number;
    thresholdN?: number;
    coordinatorNpub: string;
  }> = [];
  for (const shard of receivedShards) {
    const parsed = shard.shardCertificate ? parseSimpleShardCertificate(shard.shardCertificate) : null;
    if (!parsed || !configuredCoordinatorTargets.includes(shard.coordinatorNpub) || !shard.votingPrompt) {
      continue;
    }
    entries.push({
      votingId: parsed.votingId,
      prompt: shard.votingPrompt,
      createdAt: shard.createdAt,
      thresholdT: parsed.thresholdT,
      thresholdN: parsed.thresholdN,
      coordinatorNpub: shard.coordinatorNpub,
    });
  }

  return buildSimpleVoteTicketRowsRust(entries, configuredCoordinatorTargets);
}

export function reconcileSimpleKnownRounds(input: {
  configuredCoordinatorTargets: string[];
  discoveredSessions: SimpleLiveVoteSession[];
  receivedShards: SimpleShardResponse[];
}) {
  const sessionsByVotingId = new Map<string, SimpleLiveVoteSession>();

  for (const session of input.discoveredSessions) {
    if (!input.configuredCoordinatorTargets.includes(session.coordinatorNpub)) {
      continue;
    }

    const existing = sessionsByVotingId.get(session.votingId);
    if (!existing || session.createdAt > existing.createdAt) {
      sessionsByVotingId.set(session.votingId, session);
    }
  }

  const ticketRows = buildSimpleVoteTicketRows(input.receivedShards, input.configuredCoordinatorTargets);

  for (const row of ticketRows) {
    const existing = sessionsByVotingId.get(row.votingId);
    if (!existing || row.createdAt > existing.createdAt) {
      const sourceShard = input.receivedShards.find((response) => {
        const parsed = response.shardCertificate ? parseSimpleShardCertificate(response.shardCertificate) : null;
        return parsed?.votingId === row.votingId && input.configuredCoordinatorTargets.includes(response.coordinatorNpub);
      });

      sessionsByVotingId.set(row.votingId, {
        votingId: row.votingId,
        prompt: row.prompt,
        coordinatorNpub: sourceShard?.coordinatorNpub ?? "",
        createdAt: row.createdAt,
        thresholdT: row.thresholdT,
        thresholdN: row.thresholdN,
        authorizedCoordinatorNpubs: [...input.configuredCoordinatorTargets],
        eventId: `ticket-row:${row.votingId}`,
      });
    }
  }

  return {
    ticketRows,
    knownRounds: sortRecordsByCreatedAtDescRust([...sessionsByVotingId.values()]),
  };
}

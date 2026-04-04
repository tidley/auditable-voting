import type { SimpleLiveVoteSession } from "./simpleVotingSession";
import type { SimpleShardResponse } from "./simpleShardDm";
import { parseSimpleShardCertificate } from "./simpleShardCertificate";

export type SimpleVoteTicketRow = {
  votingId: string;
  prompt: string;
  createdAt: string;
  thresholdT?: number;
  thresholdN?: number;
  countsByCoordinator: Record<string, number>;
};

function byCreatedAtDescending<T extends { createdAt: string }>(values: T[]) {
  return [...values].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function buildSimpleVoteTicketRows(
  receivedShards: SimpleShardResponse[],
  configuredCoordinatorTargets: string[],
): SimpleVoteTicketRow[] {
  const rows = new Map<string, SimpleVoteTicketRow>();

  for (const shard of receivedShards) {
    const parsed = shard.shardCertificate ? parseSimpleShardCertificate(shard.shardCertificate) : null;
    if (!parsed || !configuredCoordinatorTargets.includes(shard.coordinatorNpub) || !shard.votingPrompt) {
      continue;
    }

    const current = rows.get(parsed.votingId) ?? {
      votingId: parsed.votingId,
      prompt: shard.votingPrompt,
      createdAt: shard.createdAt,
      thresholdT: parsed.thresholdT,
      thresholdN: parsed.thresholdN,
      countsByCoordinator: {},
    };

    if (shard.createdAt > current.createdAt) {
      current.createdAt = shard.createdAt;
      current.prompt = shard.votingPrompt;
      current.thresholdT = parsed.thresholdT;
      current.thresholdN = parsed.thresholdN;
    }

    current.countsByCoordinator[shard.coordinatorNpub] = (current.countsByCoordinator[shard.coordinatorNpub] ?? 0) + 1;
    rows.set(parsed.votingId, current);
  }

  return byCreatedAtDescending([...rows.values()]);
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
    knownRounds: byCreatedAtDescending([...sessionsByVotingId.values()]),
  };
}

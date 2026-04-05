import type { SimpleSubmittedVote } from "./simpleVotingSession";
import {
  verifySimplePublicShardProof,
} from "./simpleShardCertificate";

export type SimpleValidatedVote = {
  vote: SimpleSubmittedVote;
  valid: boolean;
  reason: string;
};

export async function validateSimpleSubmittedVotes(
  votes: SimpleSubmittedVote[],
  requiredShardCount: number,
  authorizedCoordinatorNpubs: string[] = [],
): Promise<SimpleValidatedVote[]> {
  const seenTokenIds = new Set<string>();
  const allowedCoordinators = new Set(authorizedCoordinatorNpubs);
  const canonicallySortedVotes = [...votes].sort((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return left.eventId.localeCompare(right.eventId);
  });

  const results: SimpleValidatedVote[] = [];

  for (const vote of canonicallySortedVotes) {
    const shardProofs = Array.isArray(vote.shardProofs) ? vote.shardProofs : [];
    const parsedProofs = (
      await Promise.all(
        shardProofs.map(async (proof) => verifySimplePublicShardProof(proof)),
      )
    ).filter((proof) => proof !== null);

    if (parsedProofs.length < shardProofs.length) {
      results.push({ vote, valid: false, reason: "Invalid shard signature" });
      continue;
    }

    const uniqueCoordinators = Array.from(
      new Set(parsedProofs.map((proof) => proof.coordinatorNpub)),
    );
    if (uniqueCoordinators.length < requiredShardCount) {
      results.push({ vote, valid: false, reason: "Not enough valid shards" });
      continue;
    }

    if (
      allowedCoordinators.size > 0
      && uniqueCoordinators.some((coordinatorNpub) => !allowedCoordinators.has(coordinatorNpub))
    ) {
      results.push({ vote, valid: false, reason: "Unauthorized coordinator share" });
      continue;
    }

    const tokenCommitments = Array.from(
      new Set(parsedProofs.map((proof) => proof.tokenCommitment)),
    );
    if (tokenCommitments.length !== 1) {
      results.push({ vote, valid: false, reason: "Mismatched token commitment" });
      continue;
    }

    const votingIds = Array.from(
      new Set(parsedProofs.map((proof) => proof.votingId)),
    );
    if (votingIds.length !== 1 || votingIds[0] !== vote.votingId) {
      results.push({ vote, valid: false, reason: "Mismatched voting id" });
      continue;
    }

    if (uniqueCoordinators.length !== parsedProofs.length) {
      results.push({ vote, valid: false, reason: "Duplicate coordinator share" });
      continue;
    }

    if (!vote.tokenId) {
      results.push({ vote, valid: false, reason: "Missing combined token" });
      continue;
    }

    if (seenTokenIds.has(vote.tokenId)) {
      results.push({ vote, valid: false, reason: "Duplicate token" });
      continue;
    }

    seenTokenIds.add(vote.tokenId);

    results.push({ vote, valid: true, reason: "Valid" });
  }

  return results;
}

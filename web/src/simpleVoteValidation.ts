import type { SimpleSubmittedVote } from "./simpleVotingSession";
import { parseSimplePublicShardProof } from "./simpleShardCertificate";

export type SimpleValidatedVote = {
  vote: SimpleSubmittedVote;
  valid: boolean;
  reason: string;
};

export function validateSimpleSubmittedVotes(
  votes: SimpleSubmittedVote[],
  requiredShardCount: number,
  authorizedCoordinatorNpubs: string[] = [],
): SimpleValidatedVote[] {
  const seenTokenIds = new Set<string>();
  const allowedCoordinators = new Set(authorizedCoordinatorNpubs);
  const canonicallySortedVotes = [...votes].sort((left, right) => {
    const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    return left.eventId.localeCompare(right.eventId);
  });

  return canonicallySortedVotes.map((vote) => {
    const parsedProofs = vote.shardProofs
      .map((proof) => parseSimplePublicShardProof(proof))
      .filter((proof) => proof !== null);

    if (parsedProofs.length < vote.shardProofs.length) {
      return { vote, valid: false, reason: "Invalid shard signature" };
    }

    const uniqueCoordinators = Array.from(
      new Set(parsedProofs.map((proof) => proof.coordinatorNpub)),
    );
    if (uniqueCoordinators.length < requiredShardCount) {
      return { vote, valid: false, reason: "Not enough valid shards" };
    }

    if (
      allowedCoordinators.size > 0
      && uniqueCoordinators.some((coordinatorNpub) => !allowedCoordinators.has(coordinatorNpub))
    ) {
      return { vote, valid: false, reason: "Unauthorized coordinator share" };
    }

    const tokenCommitments = Array.from(
      new Set(parsedProofs.map((proof) => proof.tokenCommitment)),
    );
    if (tokenCommitments.length !== 1) {
      return { vote, valid: false, reason: "Mismatched token commitment" };
    }

    const votingIds = Array.from(
      new Set(parsedProofs.map((proof) => proof.votingId)),
    );
    if (votingIds.length !== 1 || votingIds[0] !== vote.votingId) {
      return { vote, valid: false, reason: "Mismatched voting id" };
    }

    if (uniqueCoordinators.length !== parsedProofs.length) {
      return { vote, valid: false, reason: "Duplicate coordinator share" };
    }

    if (!vote.tokenId) {
      return { vote, valid: false, reason: "Missing combined token" };
    }

    if (seenTokenIds.has(vote.tokenId)) {
      return { vote, valid: false, reason: "Duplicate token" };
    }

    seenTokenIds.add(vote.tokenId);

    return { vote, valid: true, reason: "Valid" };
  });
}

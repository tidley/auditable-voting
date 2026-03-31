import type { SimpleSubmittedVote } from "./simpleVotingSession";
import { parseSimpleShardCertificate } from "./simpleShardCertificate";

export type SimpleValidatedVote = {
  vote: SimpleSubmittedVote;
  valid: boolean;
  reason: string;
};

export function validateSimpleSubmittedVotes(
  votes: SimpleSubmittedVote[],
  requiredShardCount: number,
): SimpleValidatedVote[] {
  const seenTokenIds = new Set<string>();

  return votes.map((vote) => {
    const parsedCertificates = vote.shardCertificates
      .map((certificate) => parseSimpleShardCertificate(certificate))
      .filter((certificate) => certificate !== null);

    if (parsedCertificates.length < vote.shardCertificates.length) {
      return { vote, valid: false, reason: "Invalid shard signature" };
    }

    const uniqueShardIds = Array.from(new Set(parsedCertificates.map((certificate) => certificate.shardId)));
    if (uniqueShardIds.length < requiredShardCount) {
      return { vote, valid: false, reason: "Not enough valid shards" };
    }

    const tokenCommitments = Array.from(new Set(parsedCertificates.map((certificate) => certificate.tokenCommitment)));
    if (tokenCommitments.length !== 1) {
      return { vote, valid: false, reason: "Mismatched token commitment" };
    }

    const votingIds = Array.from(new Set(parsedCertificates.map((certificate) => certificate.votingId)));
    if (votingIds.length !== 1 || votingIds[0] !== vote.votingId) {
      return { vote, valid: false, reason: "Mismatched voting id" };
    }

    const uniqueCoordinators = Array.from(new Set(parsedCertificates.map((certificate) => certificate.coordinatorNpub)));
    if (uniqueCoordinators.length !== parsedCertificates.length) {
      return { vote, valid: false, reason: "Duplicate coordinator share" };
    }

    const uniqueShareIndexes = Array.from(new Set(parsedCertificates.map((certificate) => certificate.shareIndex)));
    if (uniqueShareIndexes.length !== parsedCertificates.length) {
      return { vote, valid: false, reason: "Duplicate share index" };
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

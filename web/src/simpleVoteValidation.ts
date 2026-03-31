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
  return votes.map((vote) => {
    const parsedCertificates = vote.shardCertificates
      .map((certificate) => parseSimpleShardCertificate(certificate, vote.coordinatorNpub))
      .filter((certificate) => certificate !== null);

    if (parsedCertificates.length < vote.shardCertificates.length) {
      return { vote, valid: false, reason: "Invalid shard signature" };
    }

    const uniqueShardIds = Array.from(new Set(parsedCertificates.map((certificate) => certificate.shardId)));
    if (uniqueShardIds.length < requiredShardCount) {
      return { vote, valid: false, reason: "Not enough valid shards" };
    }

    return { vote, valid: true, reason: "Valid" };
  });
}

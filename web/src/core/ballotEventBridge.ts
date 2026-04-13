import type { SimpleSubmittedVote } from "../simpleVotingSession";

export type ProtocolBallotEvent = {
  plane: "ballot";
  event: {
    event_type: "encrypted_ballot";
    schema_version: number;
    election_id: string;
    round_id: string;
    request_id?: string;
    ticket_id?: string;
    created_at: number;
    author_pubkey: string;
    event_id: string;
    choice: string;
    token_id: string | null;
    coordinator_shares: string[];
  };
};

function createdAtMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function ballotEventFromSubmittedVote(input: {
  electionId: string;
  vote: SimpleSubmittedVote;
}): ProtocolBallotEvent {
  return {
    plane: "ballot",
    event: {
      event_type: "encrypted_ballot",
      schema_version: 1,
      election_id: input.electionId,
      round_id: input.vote.votingId,
      request_id: input.vote.requestId,
      ticket_id: input.vote.ticketId,
      created_at: createdAtMs(input.vote.createdAt),
      author_pubkey: input.vote.voterNpub,
      event_id: input.vote.eventId,
      choice: input.vote.choice,
      token_id: input.vote.tokenId,
      coordinator_shares: Array.from(
        new Set(
          (input.vote.shardProofs ?? [])
            .map((proof) => proof.coordinatorNpub)
            .filter((value): value is string => typeof value === "string" && value.length > 0),
        ),
      ),
    },
  };
}

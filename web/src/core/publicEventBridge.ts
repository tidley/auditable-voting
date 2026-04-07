import type { SimpleLiveVoteSession } from "../simpleVotingSession";

export type ProtocolPublicEvent =
  | {
      plane: "public";
      event: {
        event_type: "election_definition";
        schema_version: number;
        election_id: string;
        created_at: number;
        author_pubkey: string;
        event_id: string;
        title: string;
      };
    }
  | {
      plane: "public";
      event: {
        event_type: "round_open";
        schema_version: number;
        election_id: string;
        round_id: string;
        created_at: number;
        author_pubkey: string;
        event_id: string;
        prompt: string | null;
        threshold_t: number | null;
        threshold_n: number | null;
        coordinator_roster: string[];
      };
    };

function createdAtMs(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildElectionDefinitionEvent(input: {
  electionId: string;
  eventId?: string;
  authorPubkey: string;
  title: string;
}): ProtocolPublicEvent {
  return {
    plane: "public",
    event: {
      event_type: "election_definition",
      schema_version: 1,
      election_id: input.electionId,
      created_at: 0,
      author_pubkey: input.authorPubkey,
      event_id: input.eventId ?? `election-definition:${input.electionId}`,
      title: input.title,
    },
  };
}

export function publicEventFromLiveVote(input: {
  electionId: string;
  session: SimpleLiveVoteSession;
}): ProtocolPublicEvent {
  return {
    plane: "public",
    event: {
      event_type: "round_open",
      schema_version: 1,
      election_id: input.electionId,
      round_id: input.session.votingId,
      created_at: createdAtMs(input.session.createdAt),
      author_pubkey: input.session.coordinatorNpub,
      event_id: input.session.eventId,
      prompt: input.session.prompt,
      threshold_t: input.session.thresholdT ?? null,
      threshold_n: input.session.thresholdN ?? null,
      coordinator_roster: input.session.authorizedCoordinatorNpubs,
    },
  };
}

import { generateSecretKey, getPublicKey, finalizeEvent, SimplePool } from "nostr-tools";

export type VotePayload = {
  electionId: string;
  voteChoice: string;
};

export async function publishVote(
  relayUrl: string,
  payload: VotePayload
) {
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);

  const eventTemplate = {
    kind: 38000,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["election", payload.electionId]],
    content: JSON.stringify({
      election_id: payload.electionId,
      vote_choice: payload.voteChoice,
      timestamp: Math.floor(Date.now() / 1000)
    }),
    pubkey: pk
  };

  const signedEvent = finalizeEvent(eventTemplate, sk);

  const pool = new SimplePool();
  await pool.publish([relayUrl], signedEvent);

  return {
    eventId: signedEvent.id,
    pubkey: pk,
    privateKey: sk,
    event: signedEvent
  };
}

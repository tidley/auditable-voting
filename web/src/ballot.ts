import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import type { CashuProof } from "./cashuMintApi";

export const DEFAULT_VOTE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net"
];

export const BALLOT_EVENT_KIND = 38000;

export async function hashProof(proof: CashuProof) {
  const canonicalProof = JSON.stringify({
    quoteId: proof.quoteId,
    npub: proof.npub,
    amount: proof.amount,
    secret: proof.secret,
    signature: proof.signature,
    mintUrl: proof.mintUrl,
    issuedAt: proof.issuedAt
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalProof));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function publishBallotEvent(input: {
  electionId: string;
  proof: CashuProof;
  relays?: string[];
  answers: Record<string, string>;
}) {
  const relays = input.relays && input.relays.length > 0 ? input.relays : DEFAULT_VOTE_RELAYS;
  const ballotSecretKey = generateSecretKey();
  const ballotPubkey = getPublicKey(ballotSecretKey);
  const ballotNpub = nip19.npubEncode(ballotPubkey);
  const proofHash = await hashProof(input.proof);
  const event = finalizeEvent(
    {
      kind: BALLOT_EVENT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["t", "auditable-vote"],
        ["election", input.electionId],
        ["proof_hash", proofHash],
        ["mint", input.proof.mintUrl]
      ],
      content: JSON.stringify({
        election_id: input.electionId,
        proof_hash: proofHash,
        ballot: input.answers
      })
    },
    ballotSecretKey
  );

  const pool = new SimplePool();

  try {
    const results = await Promise.allSettled(pool.publish(relays, event, { maxWait: 4000 }));

    return {
      eventId: event.id,
      ballotNpub,
      proofHash,
      relays,
      successes: results.filter((result) => result.status === "fulfilled").length,
      failures: results.filter((result) => result.status === "rejected").length
    };
  } finally {
    pool.destroy();
  }
}

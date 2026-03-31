import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import type { RelayPublishResult } from "./cashuMintApi";
import { logBallotDebug } from "./cashuMintApi";
import type { ElectionQuestion } from "./coordinatorApi";
import type { CoordinatorProof } from "./cashuWallet";
import { USE_MOCK } from "./config";
import { queueNostrPublish } from "./nostrPublishQueue";
import { deriveTokenIdFromProofSecrets } from "./tokenIdentity";

export const DEFAULT_VOTE_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net"
];

export const BALLOT_EVENT_KIND = 38000;

export type BallotResponse = {
  question_id: string;
  value?: string | number;
  values?: string[];
};

export function isBallotComplete(
  answers: Record<string, string | string[] | number>,
  questions: ElectionQuestion[]
): boolean {
  return questions.every((q) => {
    const a = answers[q.id];
    if (a === undefined) return false;
    if (q.type === "choice" && q.select === "multiple") {
      return Array.isArray(a) && a.length > 0;
    }
    return true;
  });
}

function formatAnswersAsResponses(
  answers: Record<string, string | string[] | number>,
  questions: ElectionQuestion[]
): BallotResponse[] {
  return questions.map((q) => {
    const answer = answers[q.id];
    if (answer === undefined) {
      return { question_id: q.id };
    }

    if (q.type === "choice" && q.select === "multiple") {
      if (Array.isArray(answer)) {
        return { question_id: q.id, values: answer };
      }
      return { question_id: q.id, values: [String(answer)] };
    }

    if (q.type === "scale" && typeof answer === "number") {
      return { question_id: q.id, value: answer };
    }

    return { question_id: q.id, value: String(answer) };
  });
}

export async function computeProofHash(proofSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(proofSecret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function publishBallotEvent(input: {
  electionId: string;
  relays?: string[];
  answers: Record<string, string | string[] | number>;
  questions: ElectionQuestion[];
  coordinatorProofs?: CoordinatorProof[];
}) {
  const relays = input.relays && input.relays.length > 0 ? input.relays : DEFAULT_VOTE_RELAYS;
  const ballotSecretKey = generateSecretKey();
  const ballotPubkey = getPublicKey(ballotSecretKey);
  const ballotNpub = nip19.npubEncode(ballotPubkey);

  const responses = formatAnswersAsResponses(input.answers, input.questions);
  const tokenId = await deriveTokenIdFromProofSecrets(
    input.coordinatorProofs?.map((cp) => cp.proofSecret) ?? [],
  );

  const tags: string[][] = [["election", input.electionId]];
  if (tokenId) {
    tags.push(["token-id", tokenId]);
  }

  if (input.coordinatorProofs && input.coordinatorProofs.length > 0) {
    for (const cp of input.coordinatorProofs) {
      const hash = await computeProofHash(cp.proofSecret);
      tags.push(["proof-hash", hash]);
    }
  }

  const event = finalizeEvent(
    {
      kind: BALLOT_EVENT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: JSON.stringify({
        election_id: input.electionId,
        token_id: tokenId,
        responses,
        timestamp: Math.floor(Date.now() / 1000)
      })
    },
    ballotSecretKey
  );

  const pool = new SimplePool();

  try {
    const results = await queueNostrPublish(() => Promise.allSettled(pool.publish(relays, event, { maxWait: 4000 })));
    const relayResults: RelayPublishResult[] = results.map((result, index) => (
      result.status === "fulfilled"
        ? { relay: relays[index], success: true }
        : {
            relay: relays[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          }
    ));

    if (USE_MOCK) {
      try {
        await logBallotDebug({
          electionId: input.electionId,
          relays,
          event: {
            id: event.id,
            pubkey: event.pubkey,
            kind: event.kind,
            created_at: event.created_at,
            content: event.content,
            tags: event.tags,
            sig: event.sig,
          },
          publishResult: {
            eventId: event.id,
            ballotNpub,
            successes: relayResults.filter((result) => result.success).length,
            failures: relayResults.filter((result) => !result.success).length,
            relayResults: relayResults.map((result) => ({
              relay: result.relay,
              success: result.success,
              error: result.error,
            })),
          },
        });
      } catch {
        // Demo logging should not block ballot publication.
      }
    }

    return {
      eventId: event.id,
      ballotNpub,
      ballotSecretKey,
      event,
      tokenId,
      relays,
      successes: relayResults.filter((result) => result.success).length,
      failures: relayResults.filter((result) => !result.success).length,
      relayResults
    };
  } finally {
    pool.destroy();
  }
}

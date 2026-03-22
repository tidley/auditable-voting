import { finalizeEvent, generateSecretKey, getPublicKey, nip19, SimplePool } from "nostr-tools";
import type { RelayPublishResult } from "./cashuMintApi";
import type { ElectionQuestion } from "./coordinatorApi";

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

export async function publishBallotEvent(input: {
  electionId: string;
  relays?: string[];
  answers: Record<string, string | string[] | number>;
  questions: ElectionQuestion[];
}) {
  const relays = input.relays && input.relays.length > 0 ? input.relays : DEFAULT_VOTE_RELAYS;
  const ballotSecretKey = generateSecretKey();
  const ballotPubkey = getPublicKey(ballotSecretKey);
  const ballotNpub = nip19.npubEncode(ballotPubkey);

  const responses = formatAnswersAsResponses(input.answers, input.questions);

  const event = finalizeEvent(
    {
      kind: BALLOT_EVENT_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["election", input.electionId]
      ],
      content: JSON.stringify({
        election_id: input.electionId,
        responses,
        timestamp: Math.floor(Date.now() / 1000)
      })
    },
    ballotSecretKey
  );

  const pool = new SimplePool();

  try {
    const results = await Promise.allSettled(pool.publish(relays, event, { maxWait: 4000 }));
    const relayResults: RelayPublishResult[] = results.map((result, index) => (
      result.status === "fulfilled"
        ? { relay: relays[index], success: true }
        : {
            relay: relays[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
          }
    ));

    return {
      eventId: event.id,
      ballotNpub,
      ballotSecretKey,
      event,
      relays,
      successes: relayResults.filter((result) => result.success).length,
      failures: relayResults.filter((result) => !result.success).length,
      relayResults
    };
  } finally {
    pool.destroy();
  }
}

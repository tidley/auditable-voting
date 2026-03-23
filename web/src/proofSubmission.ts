import { finalizeEvent, nip04, SimplePool } from "nostr-tools";
import { nip19 } from "nostr-tools";
import type { RelayPublishResult } from "./cashuMintApi";
import type { CashuProof } from "./cashuBlind";

export type DmPublishResult = {
  eventId: string;
  successes: number;
  failures: number;
  relayResults: RelayPublishResult[];
};

export type MultiCoordinatorDmResult = {
  coordinatorNpub: string;
  result: DmPublishResult;
};

export async function submitProofViaDm(input: {
  voterSecretKey: Uint8Array;
  coordinatorNpub: string;
  voteEventId: string;
  proof: CashuProof;
  relays: string[];
}): Promise<DmPublishResult> {
  const { voterSecretKey, coordinatorNpub, voteEventId, proof, relays } = input;

  const decoded = nip19.decode(coordinatorNpub);
  if (decoded.type !== "npub") {
    throw new Error("Coordinator value must be an npub.");
  }
  const coordinatorHexPubkey = decoded.data as string;

  const dmContent = JSON.stringify({
    vote_event_id: voteEventId,
    proof,
  });

  const encryptedContent = await nip04.encrypt(voterSecretKey, coordinatorHexPubkey, dmContent);

  const event = finalizeEvent(
    {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["p", coordinatorHexPubkey]],
      content: encryptedContent
    },
    voterSecretKey
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
      successes: relayResults.filter((r) => r.success).length,
      failures: relayResults.filter((r) => !r.success).length,
      relayResults
    };
  } finally {
    pool.destroy();
  }
}

export type CoordinatorProofPair = {
  coordinatorNpub: string;
  proof: CashuProof;
};

export async function submitProofsToAllCoordinators(input: {
  voterSecretKey: Uint8Array;
  voteEventId: string;
  coordinatorProofs: CoordinatorProofPair[];
  relays: string[];
}): Promise<MultiCoordinatorDmResult[]> {
  const results: MultiCoordinatorDmResult[] = [];

  for (const cp of input.coordinatorProofs) {
    try {
      const result = await submitProofViaDm({
        voterSecretKey: input.voterSecretKey,
        coordinatorNpub: cp.coordinatorNpub,
        voteEventId: input.voteEventId,
        proof: cp.proof,
        relays: input.relays,
      });
      results.push({ coordinatorNpub: cp.coordinatorNpub, result });
    } catch (error) {
      results.push({
        coordinatorNpub: cp.coordinatorNpub,
        result: {
          eventId: "",
          successes: 0,
          failures: 1,
          relayResults: [],
        },
      });
    }
  }

  return results;
}

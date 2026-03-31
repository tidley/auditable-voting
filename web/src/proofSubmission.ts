import { nip17, SimplePool } from "nostr-tools";
import { nip19 } from "nostr-tools";
import type { RelayPublishResult } from "./cashuMintApi";
import { logBallotDebug } from "./cashuMintApi";
import type { CashuProof } from "./cashuBlind";
import { computeProofHash } from "./ballot";
import { queueNostrPublish } from "./nostrPublishQueue";

export const DEFAULT_DM_RELAYS = [
  "wss://nos.lol",
  "wss://relay.0xchat.com",
  "wss://auth.nostr1.com",
  "wss://nip17.com",
  "wss://nip17.tomdwyer.uk",
  "wss://relay.snort.social",
  "wss://relay.nostr.band",
];

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

  const dmRelays = Array.from(
    new Set([
      ...DEFAULT_DM_RELAYS,
      ...relays,
    ].filter((relay) => relay.trim().length > 0))
  );

  const event = nip17.wrapEvent(
    voterSecretKey,
    {
      publicKey: coordinatorHexPubkey,
      relayUrl: dmRelays[0],
    },
    dmContent,
    "Proof submission",
    {
      eventId: voteEventId,
    }
  );

  const pool = new SimplePool();

  try {
    const results = await queueNostrPublish(() => Promise.allSettled(pool.publish(dmRelays, event, { maxWait: 4000 })));
    const relayResults: RelayPublishResult[] = results.map((result, index) => (
      result.status === "fulfilled"
        ? { relay: dmRelays[index], success: true }
        : {
            relay: dmRelays[index],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        }
    ));

    try {
      await logBallotDebug({
        proofHash: await computeProofHash(proof.secret),
        relays: dmRelays,
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
          successes: relayResults.filter((r) => r.success).length,
          failures: relayResults.filter((r) => !r.success).length,
          relayResults: relayResults.map((result) => ({
            relay: result.relay,
            success: result.success,
            error: result.error,
          })),
        },
      });
    } catch {
      // Demo/debug logging should not block proof delivery.
    }

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
  retries?: number;
}): Promise<MultiCoordinatorDmResult[]> {
  const results: MultiCoordinatorDmResult[] = [];

  const retries = Math.max(0, input.retries ?? 0);

  for (const cp of input.coordinatorProofs) {
    let attempt = 0;
    let completed = false;
    while (!completed) {
      try {
        const result = await submitProofViaDm({
          voterSecretKey: input.voterSecretKey,
          coordinatorNpub: cp.coordinatorNpub,
          voteEventId: input.voteEventId,
          proof: cp.proof,
          relays: input.relays,
        });
        results.push({ coordinatorNpub: cp.coordinatorNpub, result });
        completed = true;
      } catch (error) {
        if (attempt < retries) {
          attempt += 1;
          continue;
        }
        results.push({
          coordinatorNpub: cp.coordinatorNpub,
          result: {
            eventId: "",
            successes: 0,
            failures: 1,
            relayResults: [],
          },
        });
        completed = true;
      }
    }
  }

  return results;
}

import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import { publishToRelaysStaggered, queueNostrPublish } from "../nostrPublishQueue";
import { getSharedNostrPool } from "../sharedNostrPool";
import {
  SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS,
  SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS,
  SIMPLE_PUBLIC_PUBLISH_STAGGER_MS,
  SIMPLE_PUBLIC_RELAYS,
} from "../simpleVotingSession";
import { normalizeRelaysRust } from "../wasm/auditableVotingCore";
import {
  buildCoordinatorControlTags,
  SIMPLE_COORDINATOR_CONTROL_KIND,
} from "../core/coordinatorEventBridge";
import type { CoordinatorOutboundTransportMessage } from "../core/coordinatorCoreAdapter";

function buildControlRelays(relays?: string[]) {
  return normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]);
}

export async function publishCoordinatorControl(input: {
  coordinatorNsec: string;
  message: CoordinatorOutboundTransportMessage;
  relays?: string[];
}) {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Coordinator key must be an nsec.");
  }

  const secretKey = decoded.data as Uint8Array;
  const relays = buildControlRelays(input.relays);
  const event = finalizeEvent({
    kind: SIMPLE_COORDINATOR_CONTROL_KIND,
    created_at: Math.floor(input.message.created_at / 1000),
    tags: buildCoordinatorControlTags(input.message),
    content: input.message.content,
  }, secretKey);
  const expectedPubkey = getPublicKey(secretKey);
  if (event.pubkey !== expectedPubkey) {
    throw new Error("Coordinator control publish signer mismatch.");
  }

  const pool = getSharedNostrPool();
  const results = await queueNostrPublish(
    () => publishToRelaysStaggered(
      (relay) => pool.publish([relay], event, { maxWait: SIMPLE_PUBLIC_PUBLISH_MAX_WAIT_MS })[0],
      relays,
      { staggerMs: SIMPLE_PUBLIC_PUBLISH_STAGGER_MS },
    ),
    { channel: "coordinator-control", minIntervalMs: SIMPLE_PUBLIC_MIN_PUBLISH_INTERVAL_MS },
  );

  const relayResults = results.map((result, index) => (
    result.status === "fulfilled"
      ? { relay: relays[index], success: true }
      : {
          relay: relays[index],
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }
  ));

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
    rawEvent: event,
  };
}

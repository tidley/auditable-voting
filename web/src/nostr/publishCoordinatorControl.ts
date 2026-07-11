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
import { recordRelayOutcome, rankRelaysByBackoff, selectRelaysWithBackoff } from "../relayBackoff";
import {
  buildCoordinatorControlTags,
  SIMPLE_COORDINATOR_CONTROL_KIND,
} from "../core/coordinatorEventBridge";
import type { CoordinatorOutboundTransportMessage } from "../core/coordinatorCoreAdapter";

const COORDINATOR_CONTROL_PRIMARY_RELAYS_MAX = 5;

function buildControlRelays(relays?: string[]) {
  const normalized = rankRelaysByBackoff(normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]));
  return selectRelaysWithBackoff(normalized, COORDINATOR_CONTROL_PRIMARY_RELAYS_MAX);
}

export async function publishCoordinatorControl(input: {
  coordinatorNsec: string;
  message: CoordinatorOutboundTransportMessage;
  relays?: string[];
  onPrepared?: (prepared: {
    eventId: string;
    rawEvent: ReturnType<typeof finalizeEvent>;
  }) => void;
}) {
  const decoded = nip19.decode(input.coordinatorNsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Organiser key must be an nsec.");
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
    throw new Error("Organiser control publish signer mismatch.");
  }
  input.onPrepared?.({
    eventId: event.id,
    rawEvent: event,
  });

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
  for (const result of relayResults) {
    recordRelayOutcome(result.relay, result.success, result.success ? undefined : result.error);
  }

  return {
    eventId: event.id,
    successes: relayResults.filter((result) => result.success).length,
    failures: relayResults.filter((result) => !result.success).length,
    relayResults,
    rawEvent: event,
  };
}

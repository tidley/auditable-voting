import type { NostrEvent } from "nostr-tools";
import type {
  CoordinatorOutboundTransportMessage,
  CoordinatorTransportEvent,
} from "./coordinatorCoreAdapter";

export const SIMPLE_COORDINATOR_CONTROL_KIND = 38992;

export function buildCoordinatorControlTags(message: CoordinatorOutboundTransportMessage) {
  return [
    ["t", "auditable-voting-coordinator-control"],
    ["election", message.election_id],
    ...(message.round_id ? [["round", message.round_id]] : []),
    ["event-type", message.event_type],
    ["schema-version", String(message.schema_version)],
    ...(message.logical_epoch !== undefined && message.logical_epoch !== null
      ? [["logical-epoch", String(message.logical_epoch)]]
      : []),
  ];
}

export function transportEventFromNostrEvent(event: Pick<NostrEvent, "id" | "content">): CoordinatorTransportEvent {
  return {
    event_id: event.id,
    raw_content: event.content,
  };
}

export function matchesCoordinatorControlEvent(
  event: Pick<NostrEvent, "kind" | "tags">,
  electionId: string,
) {
  if (event.kind !== SIMPLE_COORDINATOR_CONTROL_KIND) {
    return false;
  }

  return event.tags.some((tag) => tag[0] === "election" && tag[1] === electionId);
}

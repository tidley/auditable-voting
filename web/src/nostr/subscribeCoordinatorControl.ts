import type { Filter, NostrEvent } from "nostr-tools";
import { getSharedNostrPool } from "../sharedNostrPool";
import { SIMPLE_PUBLIC_RELAYS } from "../simpleVotingSession";
import { normalizeRelaysRust } from "../wasm/auditableVotingCore";
import {
  matchesCoordinatorControlEvent,
  SIMPLE_COORDINATOR_CONTROL_KIND,
} from "../core/coordinatorEventBridge";

const COORDINATOR_CONTROL_READ_RELAYS_MAX = 2;

function buildReadRelays(relays?: string[]) {
  const normalized = normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]);
  return normalized.slice(0, Math.min(COORDINATOR_CONTROL_READ_RELAYS_MAX, normalized.length));
}

export async function fetchCoordinatorControlEvents(input: {
  electionId: string;
  coordinatorHexPubkeys?: string[];
  relays?: string[];
  limit?: number;
}) {
  const pool = getSharedNostrPool();
  const relays = buildReadRelays(input.relays);
  const filter: Filter = {
    kinds: [SIMPLE_COORDINATOR_CONTROL_KIND],
    authors: input.coordinatorHexPubkeys?.length ? input.coordinatorHexPubkeys : undefined,
    limit: input.limit ?? 200,
  };
  const events = await pool.querySync(relays, filter);
  return events.filter((event) => matchesCoordinatorControlEvent(event, input.electionId));
}

export function subscribeCoordinatorControl(input: {
  electionId: string;
  coordinatorHexPubkeys?: string[];
  relays?: string[];
  onEvents: (events: NostrEvent[]) => void;
}) {
  const pool = getSharedNostrPool();
  const relays = buildReadRelays(input.relays);
  const filter: Filter = {
    kinds: [SIMPLE_COORDINATOR_CONTROL_KIND],
    authors: input.coordinatorHexPubkeys?.length ? input.coordinatorHexPubkeys : undefined,
    limit: 200,
  };

  const subscription = pool.subscribeMany(
    relays,
    filter,
    {
      onevent(event) {
        if (matchesCoordinatorControlEvent(event, input.electionId)) {
          input.onEvents([event]);
        }
      },
    },
  );

  return () => subscription.close();
}

import type { Filter, NostrEvent } from "nostr-tools";
import { getSharedNostrPool } from "../sharedNostrPool";
import { SIMPLE_PUBLIC_RELAYS } from "../simpleVotingSession";
import { normalizeRelaysRust } from "../wasm/auditableVotingCore";
import {
  matchesCoordinatorControlEvent,
  SIMPLE_COORDINATOR_CONTROL_KIND,
} from "../core/coordinatorEventBridge";

const COORDINATOR_CONTROL_READ_RELAYS_MAX = 5;
export const COORDINATOR_CONTROL_DEFAULT_LIMIT = 200;

export type CoordinatorControlReadMode = "kind_only" | "kind_election" | "kind_election_group";

function buildReadRelays(relays?: string[]) {
  const normalized = normalizeRelaysRust([...(relays ?? []), ...SIMPLE_PUBLIC_RELAYS]);
  return normalized.slice(0, Math.min(COORDINATOR_CONTROL_READ_RELAYS_MAX, normalized.length));
}

function matchesCoordinatorControlReadMode(input: {
  event: NostrEvent;
  mode: CoordinatorControlReadMode;
  electionId: string;
  coordinatorHexPubkeys?: string[];
}) {
  const { event, mode, electionId, coordinatorHexPubkeys } = input;
  if (event.kind !== SIMPLE_COORDINATOR_CONTROL_KIND) {
    return false;
  }
  if (mode === "kind_only") {
    return true;
  }
  if (!matchesCoordinatorControlEvent(event, electionId)) {
    return false;
  }
  if (mode === "kind_election") {
    return true;
  }
  return !coordinatorHexPubkeys?.length || coordinatorHexPubkeys.includes(event.pubkey);
}

function buildBaseFilter(input?: { limit?: number; since?: number; until?: number }): Filter {
  return {
    kinds: [SIMPLE_COORDINATOR_CONTROL_KIND],
    limit: input?.limit ?? COORDINATOR_CONTROL_DEFAULT_LIMIT,
    ...(typeof input?.since === "number" ? { since: input.since } : {}),
    ...(typeof input?.until === "number" ? { until: input.until } : {}),
  };
}

export async function fetchCoordinatorControlEvents(input: {
  electionId: string;
  coordinatorHexPubkeys?: string[];
  relays?: string[];
  limit?: number;
  since?: number;
  until?: number;
  mode?: CoordinatorControlReadMode;
}) {
  const pool = getSharedNostrPool();
  const relays = buildReadRelays(input.relays);
  const filter = buildBaseFilter(input);
  const events = await pool.querySync(relays, filter);
  const mode = input.mode ?? "kind_election_group";
  return events.filter((event) => matchesCoordinatorControlReadMode({
    event,
    mode,
    electionId: input.electionId,
    coordinatorHexPubkeys: input.coordinatorHexPubkeys,
  }));
}

export function subscribeCoordinatorControl(input: {
  electionId: string;
  coordinatorHexPubkeys?: string[];
  relays?: string[];
  since?: number;
  until?: number;
  mode?: CoordinatorControlReadMode;
  onEvents: (events: NostrEvent[]) => void;
}) {
  const pool = getSharedNostrPool();
  const relays = buildReadRelays(input.relays);
  const filter = buildBaseFilter({
    limit: COORDINATOR_CONTROL_DEFAULT_LIMIT,
    since: input.since,
    until: input.until,
  });
  const mode = input.mode ?? "kind_election_group";

  const subscription = pool.subscribeMany(
    relays,
    filter,
    {
      onevent(event) {
        if (matchesCoordinatorControlReadMode({
          event,
          mode,
          electionId: input.electionId,
          coordinatorHexPubkeys: input.coordinatorHexPubkeys,
        })) {
          input.onEvents([event]);
        }
      },
    },
  );

  return () => subscription.close();
}

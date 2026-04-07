import { nip19 } from "nostr-tools";
import {
  CoordinatorCoreAdapter,
  type CoordinatorEngineSnapshot,
  type CoordinatorEngineView,
} from "../core/coordinatorCoreAdapter";
import { transportEventFromNostrEvent } from "../core/coordinatorEventBridge";
import { publishCoordinatorControl } from "../nostr/publishCoordinatorControl";

export type CoordinatorControlCache = {
  snapshot: CoordinatorEngineSnapshot;
};

function sortRoster(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function snapshotMatchesInput(input: {
  electionId: string;
  localPubkey: string;
  roster: string[];
  snapshot?: CoordinatorEngineSnapshot | null;
}) {
  if (!input.snapshot) {
    return false;
  }

  const expectedRoster = sortRoster(input.roster);
  const actualRoster = sortRoster(input.snapshot.config.coordinator_roster ?? []);

  return input.snapshot.config.election_id === input.electionId
    && input.snapshot.config.local_pubkey === input.localPubkey
    && expectedRoster.length === actualRoster.length
    && expectedRoster.every((value, index) => value === actualRoster[index]);
}

export class CoordinatorControlService {
  private constructor(private adapter: CoordinatorCoreAdapter) {}

  static async create(input: {
    electionId: string;
    localPubkey: string;
    roster: string[];
    snapshot?: CoordinatorEngineSnapshot | null;
  }) {
    const canRestore = snapshotMatchesInput(input);
    const adapter = canRestore && input.snapshot
      ? await CoordinatorCoreAdapter.restore(input.snapshot)
      : await CoordinatorCoreAdapter.create({
          election_id: input.electionId,
          local_pubkey: input.localPubkey,
          coordinator_roster: sortRoster(input.roster),
        });

    return new CoordinatorControlService(adapter);
  }

  snapshot(): CoordinatorControlCache {
    return { snapshot: this.adapter.snapshot() };
  }

  getState() {
    return this.adapter.getState();
  }

  ingestCoordinatorEvents(events: Array<{ id: string; content: string }>) {
    return this.adapter.replayTransportMessages(
      events.map((event) => transportEventFromNostrEvent({ id: event.id, content: event.content })),
    );
  }

  async publishRoundOpenFlow(input: {
    coordinatorNsec: string;
    roundId: string;
    prompt: string;
    thresholdT: number;
    thresholdN: number;
    roster: string[];
    relays?: string[];
  }) {
    const now = Date.now();
    const draft = this.adapter.recordRoundDraft({
      round_id: input.roundId,
      prompt: input.prompt,
      threshold_t: input.thresholdT,
      threshold_n: input.thresholdN,
      created_at: now,
      coordinator_roster: sortRoster(input.roster),
    });
    const proposal = this.adapter.proposeRoundOpen({
      round_id: input.roundId,
      prompt: input.prompt,
      threshold_t: input.thresholdT,
      threshold_n: input.thresholdN,
      created_at: now + 1,
      coordinator_roster: sortRoster(input.roster),
    });

    const draftPublish = await publishCoordinatorControl({
      coordinatorNsec: input.coordinatorNsec,
      message: draft,
      relays: input.relays,
    });
    this.adapter.applyTransportMessage({
      event_id: draftPublish.eventId,
      raw_content: draft.content,
    });

    const proposalPublish = await publishCoordinatorControl({
      coordinatorNsec: input.coordinatorNsec,
      message: proposal,
      relays: input.relays,
    });
    this.adapter.applyTransportMessage({
      event_id: proposalPublish.eventId,
      raw_content: proposal.content,
    });

    const leadCommitMessage = this.adapter.commitRoundOpen({
      round_id: input.roundId,
      proposal_event_id: proposalPublish.eventId,
      created_at: now + 2,
    });
    const leadCommitPublish = await publishCoordinatorControl({
      coordinatorNsec: input.coordinatorNsec,
      message: leadCommitMessage,
      relays: input.relays,
    });
    this.adapter.applyTransportMessage({
      event_id: leadCommitPublish.eventId,
      raw_content: leadCommitMessage.content,
    });

    return {
      draft: draftPublish,
      proposal: proposalPublish,
      leadCommit: leadCommitPublish,
      state: this.getState(),
    };
  }

  async maybeAutoApproveRoundOpen(input: {
    coordinatorNsec: string;
    relays?: string[];
  }) {
    const state = this.getState();
    const latestRound = state.latest_round ?? null;
    if (!latestRound || latestRound.phase !== "open_proposed") {
      return null;
    }

    if (!latestRound.coordinator_roster.includes(state.local_pubkey)) {
      return null;
    }

    if (!latestRound.missing_open_committers.includes(state.local_pubkey)) {
      return null;
    }

    const proposalEventId = latestRound.proposal_event_id ?? null;
    if (!proposalEventId) {
      return null;
    }

    const outbound = this.adapter.commitRoundOpen({
      round_id: latestRound.round_id,
      proposal_event_id: proposalEventId,
      created_at: Date.now(),
    });
    const published = await publishCoordinatorControl({
      coordinatorNsec: input.coordinatorNsec,
      message: outbound,
      relays: input.relays,
    });
    this.adapter.applyTransportMessage({
      event_id: published.eventId,
      raw_content: outbound.content,
    });
    return {
      published,
      state: this.getState(),
    };
  }
}

export function deriveCoordinatorElectionId(input: {
  coordinatorNpub: string;
  leadCoordinatorNpub?: string;
}) {
  const leadOrSelf = input.leadCoordinatorNpub?.trim() || input.coordinatorNpub.trim();
  return `simple-election:${leadOrSelf}`;
}

export function npubsToHexRoster(values: string[]) {
  return sortRoster(values)
    .map((value) => {
      try {
        const decoded = nip19.decode(value);
        return decoded.type === "npub" ? decoded.data : null;
      } catch {
        return null;
      }
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

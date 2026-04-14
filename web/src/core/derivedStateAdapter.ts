import { loadProtocolCoreModule } from "./wasmLoader";

export type DerivedReceipt = {
  election_id: string;
  round_id: string;
  ballot_commitment: string;
  receipt_hash: string;
  accepted_at: number;
};

export type PublicRoundPhase = "draft" | "open" | "closed" | "tallied" | "published" | "disputed";

export type PublicRoundState = {
  round_id: string;
  prompt: string;
  threshold_t: number;
  threshold_n: number;
  coordinator_roster: string[];
  phase: PublicRoundPhase;
  defined_at: number;
  opened_at?: number | null;
  closed_at?: number | null;
  receipts: DerivedReceipt[];
  final_result?: {
    event_id: string;
    yes_count: number;
    no_count: number;
    tally_input_hash: string;
    created_at: number;
  } | null;
  disputes: string[];
};

export type PublicState = {
  election_id: string;
  election_title?: string | null;
  rounds: PublicRoundState[];
  issues: Array<{ code: string; detail: string; event_id?: string | null }>;
};

export type AcceptedBallot = {
  event_id: string;
  round_id: string;
  voter_pubkey: string;
  choice: string;
  token_id: string;
  created_at: number;
  receipt_hash: string;
  ballot_id?: string;
  request_id?: string;
  ticket_id?: string;
  ticketDeliveryConfirmedByAck?: boolean;
  ticketDeliveryConfirmedByBallot?: boolean;
  ticketDeliveryConfirmed?: boolean;
};

export type RejectedBallot = {
  event_id: string;
  round_id: string;
  voter_pubkey: string;
  choice: string;
  created_at: number;
  reason: { code: string; detail: string; event_id?: string | null };
};

export type DerivedBallotState = {
  acceptance_rule: "first_valid_wins";
  accepted_ballots: AcceptedBallot[];
  rejected_ballots: RejectedBallot[];
  derived_receipts: DerivedReceipt[];
  round_summaries: Array<{
    round_id: string;
    accepted_ballot_count: number;
    rejected_ballot_count: number;
    yes_count: number;
    no_count: number;
    ticketDeliveryConfirmedByAck?: number;
    ticketDeliveryConfirmedByBallot?: number;
    ticketDeliveryConfirmed?: number;
    ballotAccepted?: number;
  }>;
};

export type DerivedState = {
  election_id: string;
  public_state: PublicState;
  ballot_state: DerivedBallotState;
  coordinator_event_count: number;
};

export type ProtocolSnapshot = {
  schema_version: number;
  election_id: string;
  events: unknown[];
  derived_state: DerivedState;
};

export type SnapshotCompatibilityStatus = "compatible" | "incompatible_version";

export type SnapshotMetadata = {
  snapshot_format_version: number;
  protocol_schema_version: number;
  election_id: string;
  event_count: number;
  compatibility: SnapshotCompatibilityStatus;
};

export type ReplayStatus = {
  total_events: number;
  unique_events: number;
  duplicate_events: number;
  last_event_id?: string | null;
};

export type ValidationIssueCount = {
  code: string;
  count: number;
};

export type ProtocolDiagnostics = {
  replay_status: ReplayStatus;
  public_issue_counts: ValidationIssueCount[];
  rejected_ballot_count: number;
  accepted_ballot_count: number;
  known_round_ids: string[];
  snapshot_status: SnapshotCompatibilityStatus;
};

export class DerivedStateAdapter {
  private constructor(
    private readonly module: any,
    private readonly engine: any,
  ) {}

  static async create(electionId: string) {
    const module: any = await loadProtocolCoreModule();
    const engine = new module.WasmAuditableVotingProtocolEngine(electionId);
    return new DerivedStateAdapter(module, engine);
  }

  static async restore(snapshot: ProtocolSnapshot) {
    const module: any = await loadProtocolCoreModule();
    const engine = module.WasmAuditableVotingProtocolEngine.restoreFromSnapshot(snapshot);
    return new DerivedStateAdapter(module, engine);
  }

  replayAll(events: unknown[]) {
    return this.engine.replayAll(events) as DerivedState;
  }

  applyEvents(events: unknown[]) {
    return this.engine.applyEvents(events) as DerivedState;
  }

  getDerivedState() {
    return this.engine.getDerivedState() as DerivedState;
  }

  exportSnapshot() {
    return this.engine.exportSnapshot() as ProtocolSnapshot;
  }

  getSnapshotMetadata() {
    return this.engine.getSnapshotMetadata() as SnapshotMetadata;
  }

  getReplayStatus() {
    return this.engine.getReplayStatus() as ReplayStatus;
  }

  getDiagnostics() {
    return this.engine.getDiagnostics() as ProtocolDiagnostics;
  }
}

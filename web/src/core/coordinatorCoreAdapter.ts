import { loadCoordinatorCoreModule } from "./wasmLoader";

export type CoordinatorEngineConfig = {
  election_id: string;
  local_pubkey: string;
  coordinator_roster: string[];
  engine_kind?: "deterministic" | "open_mls";
};

export type CoordinatorTransportEvent = {
  event_id: string;
  raw_content: string;
  sender_pubkey?: string | null;
};

export type CoordinatorOutboundTransportMessage = {
  schema_version: number;
  election_id: string;
  round_id?: string | null;
  event_type: string;
  created_at: number;
  sender_pubkey: string;
  logical_epoch?: number | null;
  content: string;
  local_echo: string;
};

export type CoordinatorRoundView = {
  round_id: string;
  prompt?: string | null;
  threshold_t?: number | null;
  threshold_n?: number | null;
  coordinator_roster: string[];
  proposal_event_id?: string | null;
  phase: string;
  open_committers: string[];
  missing_open_committers: string[];
  partial_tally_senders: string[];
  result_approval_senders: string[];
};

export type CoordinatorEngineView = {
  election_id: string;
  local_pubkey: string;
  coordinator_roster: string[];
  engine_kind: "deterministic" | "open_mls";
  logical_epoch: number;
  latest_round?: CoordinatorRoundView | null;
  rounds: CoordinatorRoundView[];
};

export type CoordinatorEngineStatus = {
  engine_kind: "deterministic" | "open_mls";
  group_ready: boolean;
};

export type CoordinatorEngineSnapshot = {
  config: CoordinatorEngineConfig;
  state: unknown;
  group_engine: {
    engine_kind: string;
  };
};

type CoordinatorCoreWasmModule = Awaited<ReturnType<typeof loadCoordinatorCoreModule>>;

export class CoordinatorCoreAdapter {
  private constructor(
    private readonly module: CoordinatorCoreWasmModule,
    private readonly engine: InstanceType<CoordinatorCoreWasmModule["WasmCoordinatorControlEngine"]>,
  ) {}

  static async create(config: CoordinatorEngineConfig) {
    const module = await loadCoordinatorCoreModule();
    const engine = new module.WasmCoordinatorControlEngine(config);
    return new CoordinatorCoreAdapter(module, engine);
  }

  static async restore(snapshot: CoordinatorEngineSnapshot) {
    const module = await loadCoordinatorCoreModule();
    const engine = module.WasmCoordinatorControlEngine.restoreFromSnapshot(snapshot);
    return new CoordinatorCoreAdapter(module, engine);
  }

  snapshot() {
    return this.engine.snapshot() as CoordinatorEngineSnapshot;
  }

  getState() {
    return this.engine.getState() as CoordinatorEngineView;
  }

  getEngineStatus() {
    return this.engine.getEngineStatus() as CoordinatorEngineStatus;
  }

  replayTransportMessages(events: CoordinatorTransportEvent[]) {
    return this.engine.replayTransportMessages(events) as Array<{
      event_id: string;
      event_type: string;
      round_id?: string | null;
      created_at: number;
    }>;
  }

  applyTransportMessage(event: CoordinatorTransportEvent) {
    return this.engine.applyTransportMessage(event) as Array<{
      event_id: string;
      event_type: string;
      round_id?: string | null;
      created_at: number;
    }>;
  }

  applyPublishedLocalMessage(eventId: string, localEcho: string) {
    return this.engine.applyPublishedLocalMessage(eventId, localEcho) as Array<{
      event_id: string;
      event_type: string;
      round_id?: string | null;
      created_at: number;
    }>;
  }

  recordRoundDraft(input: {
    round_id: string;
    prompt: string;
    threshold_t: number;
    threshold_n: number;
    created_at: number;
    coordinator_roster: string[];
  }) {
    return this.engine.recordRoundDraft(input) as CoordinatorOutboundTransportMessage;
  }

  proposeRoundOpen(input: {
    round_id: string;
    prompt: string;
    threshold_t: number;
    threshold_n: number;
    created_at: number;
    coordinator_roster: string[];
  }) {
    return this.engine.proposeRoundOpen(input) as CoordinatorOutboundTransportMessage;
  }

  commitRoundOpen(input: {
    round_id: string;
    proposal_event_id: string;
    created_at: number;
  }) {
    return this.engine.commitRoundOpen(input) as CoordinatorOutboundTransportMessage;
  }

  submitPartialTally(input: {
    round_id: string;
    yes_count: number;
    no_count: number;
    accepted_ballot_event_ids: string[];
    created_at: number;
  }) {
    return this.engine.submitPartialTally(input) as CoordinatorOutboundTransportMessage;
  }

  approveResult(input: {
    round_id: string;
    result_hash: string;
    created_at: number;
  }) {
    return this.engine.approveResult(input) as CoordinatorOutboundTransportMessage;
  }

  exportSupervisoryJoinPackage() {
    return this.engine.exportSupervisoryJoinPackage() as string | null;
  }

  bootstrapSupervisoryGroup(joinPackages: string[]) {
    return this.engine.bootstrapSupervisoryGroup(joinPackages) as string | null;
  }

  joinSupervisoryGroup(welcomeBundle: string) {
    return this.engine.joinSupervisoryGroup(welcomeBundle) as boolean;
  }
}

use wasm_bindgen::prelude::*;

use crate::coordinator_engine::{
    CoordinatorControlEngine, CoordinatorEngineConfig, CoordinatorEngineSnapshot,
};
use crate::reducer::AuditableVotingProtocolEngine;
use crate::event::ProtocolEvent;
use crate::snapshot::ProtocolSnapshot;
use crate::types::CoordinatorTransportEvent;

fn to_js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen]
pub struct WasmCoordinatorControlEngine {
    inner: CoordinatorControlEngine,
}

#[wasm_bindgen]
pub struct WasmAuditableVotingProtocolEngine {
    inner: AuditableVotingProtocolEngine,
}

#[wasm_bindgen]
impl WasmCoordinatorControlEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WasmCoordinatorControlEngine, JsValue> {
        let config = serde_wasm_bindgen::from_value::<CoordinatorEngineConfig>(config)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: CoordinatorControlEngine::new(config).map_err(to_js_error)?,
        })
    }

    #[wasm_bindgen(js_name = restoreFromSnapshot)]
    pub fn restore_from_snapshot(snapshot: JsValue) -> Result<WasmCoordinatorControlEngine, JsValue> {
        let snapshot = serde_wasm_bindgen::from_value::<CoordinatorEngineSnapshot>(snapshot)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: CoordinatorControlEngine::restore(snapshot).map_err(to_js_error)?,
        })
    }

    #[wasm_bindgen(js_name = snapshot)]
    pub fn snapshot_js(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.snapshot()).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getState)]
    pub fn get_state(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.view()).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getEngineStatus)]
    pub fn get_engine_status(&self) -> Result<JsValue, JsValue> {
        serde_wasm_bindgen::to_value(&self.inner.engine_status()).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = replayTransportMessages)]
    pub fn replay_transport_messages(&mut self, events: JsValue) -> Result<JsValue, JsValue> {
        let events = serde_wasm_bindgen::from_value::<Vec<CoordinatorTransportEvent>>(events)
            .map_err(to_js_error)?;
        let result = self.inner.replay_transport_messages(events).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = applyTransportMessage)]
    pub fn apply_transport_message(&mut self, event: JsValue) -> Result<JsValue, JsValue> {
        let event = serde_wasm_bindgen::from_value::<CoordinatorTransportEvent>(event)
            .map_err(to_js_error)?;
        let result = self.inner.apply_transport_message(event).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = applyPublishedLocalMessage)]
    pub fn apply_published_local_message(
        &mut self,
        event_id: String,
        local_echo: String,
    ) -> Result<JsValue, JsValue> {
        let result = self
            .inner
            .apply_published_local_message(event_id, local_echo)
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = recordRoundDraft)]
    pub fn record_round_draft(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize)]
        struct Input {
            round_id: String,
            prompt: String,
            threshold_t: u32,
            threshold_n: u32,
            created_at: i64,
            coordinator_roster: Vec<String>,
        }
        let input = serde_wasm_bindgen::from_value::<Input>(input).map_err(to_js_error)?;
        let result = self
            .inner
            .record_round_draft(
                input.round_id,
                input.prompt,
                input.threshold_t,
                input.threshold_n,
                input.created_at,
                input.coordinator_roster,
            )
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = proposeRoundOpen)]
    pub fn propose_round_open(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize)]
        struct Input {
            round_id: String,
            prompt: String,
            threshold_t: u32,
            threshold_n: u32,
            created_at: i64,
            coordinator_roster: Vec<String>,
        }
        let input = serde_wasm_bindgen::from_value::<Input>(input).map_err(to_js_error)?;
        let result = self
            .inner
            .propose_round_open(
                input.round_id,
                input.prompt,
                input.threshold_t,
                input.threshold_n,
                input.created_at,
                input.coordinator_roster,
            )
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = commitRoundOpen)]
    pub fn commit_round_open(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize)]
        struct Input {
            round_id: String,
            proposal_event_id: String,
            created_at: i64,
        }
        let input = serde_wasm_bindgen::from_value::<Input>(input).map_err(to_js_error)?;
        let result = self
            .inner
            .commit_round_open(input.round_id, input.proposal_event_id, input.created_at)
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = submitPartialTally)]
    pub fn submit_partial_tally(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize)]
        struct Input {
            round_id: String,
            yes_count: u32,
            no_count: u32,
            accepted_ballot_event_ids: Vec<String>,
            created_at: i64,
        }
        let input = serde_wasm_bindgen::from_value::<Input>(input).map_err(to_js_error)?;
        let result = self
            .inner
            .submit_partial_tally(
                input.round_id,
                input.yes_count,
                input.no_count,
                input.accepted_ballot_event_ids,
                input.created_at,
            )
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = approveResult)]
    pub fn approve_result(&mut self, input: JsValue) -> Result<JsValue, JsValue> {
        #[derive(serde::Deserialize)]
        struct Input {
            round_id: String,
            result_hash: String,
            created_at: i64,
        }
        let input = serde_wasm_bindgen::from_value::<Input>(input).map_err(to_js_error)?;
        let result = self
            .inner
            .approve_result(input.round_id, input.result_hash, input.created_at)
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = exportSupervisoryJoinPackage)]
    pub fn export_supervisory_join_package(&mut self) -> Result<JsValue, JsValue> {
        let result = self
            .inner
            .export_supervisory_join_package()
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = bootstrapSupervisoryGroup)]
    pub fn bootstrap_supervisory_group(&mut self, join_packages: JsValue) -> Result<JsValue, JsValue> {
        let join_packages = serde_wasm_bindgen::from_value::<Vec<String>>(join_packages)
            .map_err(to_js_error)?;
        let result = self
            .inner
            .bootstrap_supervisory_group(join_packages)
            .map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = joinSupervisoryGroup)]
    pub fn join_supervisory_group(&mut self, welcome_bundle: String) -> Result<bool, JsValue> {
        self.inner
            .join_supervisory_group(welcome_bundle)
            .map_err(to_js_error)
    }
}

#[wasm_bindgen]
impl WasmAuditableVotingProtocolEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(election_id: String) -> WasmAuditableVotingProtocolEngine {
        Self {
            inner: AuditableVotingProtocolEngine::new(election_id),
        }
    }

    #[wasm_bindgen(js_name = restoreFromSnapshot)]
    pub fn restore_from_snapshot(snapshot: JsValue) -> Result<WasmAuditableVotingProtocolEngine, JsValue> {
        let snapshot = serde_wasm_bindgen::from_value::<ProtocolSnapshot>(snapshot)
            .map_err(to_js_error)?;
        Ok(Self {
            inner: AuditableVotingProtocolEngine::restore(snapshot).map_err(to_js_error)?,
        })
    }

    #[wasm_bindgen(js_name = replayAll)]
    pub fn replay_all(&mut self, events: JsValue) -> Result<JsValue, JsValue> {
        let events = serde_wasm_bindgen::from_value::<Vec<ProtocolEvent>>(events)
            .map_err(to_js_error)?;
        let result = self.inner.replay_all(events).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = applyEvents)]
    pub fn apply_events(&mut self, events: JsValue) -> Result<JsValue, JsValue> {
        let events = serde_wasm_bindgen::from_value::<Vec<ProtocolEvent>>(events)
            .map_err(to_js_error)?;
        let result = self.inner.apply_events(events).map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getDerivedState)]
    pub fn get_derived_state(&self) -> Result<JsValue, JsValue> {
        let result = self.inner.current_state().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&result).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getSnapshotMetadata)]
    pub fn get_snapshot_metadata(&self) -> Result<JsValue, JsValue> {
        let metadata = self.inner.snapshot_metadata().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&metadata).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getReplayStatus)]
    pub fn get_replay_status(&self) -> Result<JsValue, JsValue> {
        let status = self.inner.replay_status();
        serde_wasm_bindgen::to_value(&status).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = getDiagnostics)]
    pub fn get_diagnostics(&self) -> Result<JsValue, JsValue> {
        let diagnostics = self.inner.diagnostics().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&diagnostics).map_err(to_js_error)
    }

    #[wasm_bindgen(js_name = exportSnapshot)]
    pub fn export_snapshot(&self) -> Result<JsValue, JsValue> {
        let snapshot = self.inner.snapshot().map_err(to_js_error)?;
        serde_wasm_bindgen::to_value(&snapshot).map_err(to_js_error)
    }
}

use crate::coordinator_messages::CoordinatorControlEnvelope;
use crate::coordinator_state::CoordinatorControlState;
use crate::openmls_engine::{CoordinatorGroupEngine, GroupEngineError};
use crate::order::{sort_coordinator_events, OrderedCoordinatorEvent};
use crate::types::{CoordinatorTransportEvent, ReplayAppliedEvent};

pub fn replay_transport_events(
    state: &mut CoordinatorControlState,
    group_engine: &mut dyn CoordinatorGroupEngine,
    events: Vec<CoordinatorTransportEvent>,
) -> Result<Vec<ReplayAppliedEvent>, GroupEngineError> {
    let mut ordered = events
        .into_iter()
        .map(|transport| {
            let envelope = group_engine.decode(&transport.raw_content)?;
            Ok(OrderedCoordinatorEvent { transport, envelope })
        })
        .collect::<Result<Vec<_>, GroupEngineError>>()?;

    sort_coordinator_events(&mut ordered);

    let mut applied = Vec::new();
    for event in ordered {
        if state.has_processed_event(&event.transport.event_id) {
            continue;
        }

        state.apply_envelope(&event.transport.event_id, &event.envelope);
        applied.push(ReplayAppliedEvent {
            event_id: event.transport.event_id,
            event_type: event.envelope.payload.event_type(),
            round_id: event.envelope.round_id.clone(),
            created_at: event.envelope.created_at,
        });
    }

    Ok(applied)
}

pub fn decode_transport_event(
    group_engine: &mut dyn CoordinatorGroupEngine,
    event: &CoordinatorTransportEvent,
) -> Result<CoordinatorControlEnvelope, GroupEngineError> {
    group_engine.decode(&event.raw_content)
}

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::coordinator_messages::CoordinatorControlEnvelope;

#[derive(Debug, Error)]
pub enum GroupEngineError {
    #[error("Invalid coordinator control payload: {0}")]
    InvalidPayload(String),
    #[error("OpenMLS engine is not available in this build")]
    OpenMlsUnavailable,
}

pub trait CoordinatorGroupEngine {
    fn encode(&mut self, envelope: &CoordinatorControlEnvelope) -> Result<String, GroupEngineError>;
    fn decode(&mut self, raw_content: &str) -> Result<CoordinatorControlEnvelope, GroupEngineError>;
    fn snapshot(&self) -> CoordinatorGroupEngineSnapshot;
    fn restore(&mut self, snapshot: CoordinatorGroupEngineSnapshot);
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CoordinatorGroupEngineSnapshot {
    pub engine_kind: String,
}

#[derive(Debug, Default)]
pub struct DeterministicCoordinatorGroupEngine;

impl CoordinatorGroupEngine for DeterministicCoordinatorGroupEngine {
    fn encode(&mut self, envelope: &CoordinatorControlEnvelope) -> Result<String, GroupEngineError> {
        serde_json::to_string(envelope).map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))
    }

    fn decode(&mut self, raw_content: &str) -> Result<CoordinatorControlEnvelope, GroupEngineError> {
        serde_json::from_str(raw_content).map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))
    }

    fn snapshot(&self) -> CoordinatorGroupEngineSnapshot {
        CoordinatorGroupEngineSnapshot {
            engine_kind: "deterministic_stub".to_owned(),
        }
    }

    fn restore(&mut self, _snapshot: CoordinatorGroupEngineSnapshot) {}
}

#[cfg(feature = "openmls-engine")]
pub struct OpenMlsCoordinatorGroupEngine {
    _placeholder: openmls::prelude::GroupId,
}

#[cfg(feature = "openmls-engine")]
impl OpenMlsCoordinatorGroupEngine {
    pub fn new() -> Self {
        Self {
            _placeholder: openmls::prelude::GroupId::from_slice(&[0_u8]),
        }
    }
}

#[cfg(feature = "openmls-engine")]
impl CoordinatorGroupEngine for OpenMlsCoordinatorGroupEngine {
    fn encode(&mut self, _envelope: &CoordinatorControlEnvelope) -> Result<String, GroupEngineError> {
        Err(GroupEngineError::OpenMlsUnavailable)
    }

    fn decode(&mut self, _raw_content: &str) -> Result<CoordinatorControlEnvelope, GroupEngineError> {
        Err(GroupEngineError::OpenMlsUnavailable)
    }

    fn snapshot(&self) -> CoordinatorGroupEngineSnapshot {
        CoordinatorGroupEngineSnapshot {
            engine_kind: "openmls_unavailable".to_owned(),
        }
    }

    fn restore(&mut self, _snapshot: CoordinatorGroupEngineSnapshot) {}
}

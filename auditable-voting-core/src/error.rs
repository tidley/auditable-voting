use thiserror::Error;

use crate::validation::ProtocolError;

#[derive(Debug, Error)]
pub enum ProtocolEngineError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error(
        "Incompatible protocol snapshot version: expected {expected}, received {actual}"
    )]
    IncompatibleSnapshotVersion { expected: u32, actual: u32 },
}


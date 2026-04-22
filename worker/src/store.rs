use crate::model::WorkerPersistentState;
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};

pub struct WorkerStore {
    path: PathBuf,
}

impl WorkerStore {
    pub fn open(base_dir: &Path) -> Result<Self> {
        fs::create_dir_all(base_dir)
            .with_context(|| format!("unable to create worker state dir: {}", base_dir.display()))?;
        Ok(Self {
            path: base_dir.join("state.json"),
        })
    }

    pub fn load(&self) -> Result<WorkerPersistentState> {
        if !self.path.exists() {
            return Ok(WorkerPersistentState::default());
        }
        let raw = fs::read_to_string(&self.path)
            .with_context(|| format!("unable to read worker state file: {}", self.path.display()))?;
        let parsed = serde_json::from_str::<WorkerPersistentState>(&raw)
            .with_context(|| format!("unable to parse worker state file: {}", self.path.display()))?;
        Ok(parsed)
    }

    pub fn save(&self, state: &WorkerPersistentState) -> Result<()> {
        let data = serde_json::to_vec_pretty(state)
            .context("unable to serialise worker state")?;
        fs::write(&self.path, data)
            .with_context(|| format!("unable to write worker state file: {}", self.path.display()))?;
        Ok(())
    }
}

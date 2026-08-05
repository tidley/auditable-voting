use crate::model::WorkerPersistentState;
use anyhow::{Context, Result};
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::{
    fs::{OpenOptions, Permissions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

#[cfg(unix)]
fn reject_insecure_permissions(path: &Path, allowed_mode: u32) -> Result<()> {
    let mode = fs::metadata(path)
        .with_context(|| format!("unable to inspect worker state path: {}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o7777 & !allowed_mode != 0 {
        anyhow::bail!(
            "worker state path has insecure permissions: {}",
            path.display()
        );
    }
    Ok(())
}

pub struct WorkerStore {
    path: PathBuf,
}

impl WorkerStore {
    pub fn open(base_dir: &Path) -> Result<Self> {
        #[cfg(unix)]
        if base_dir.exists() {
            reject_insecure_permissions(base_dir, 0o700)?;
        }
        fs::create_dir_all(base_dir).with_context(|| {
            format!("unable to create worker state dir: {}", base_dir.display())
        })?;
        #[cfg(unix)]
        fs::set_permissions(base_dir, Permissions::from_mode(0o700)).with_context(|| {
            format!("unable to secure worker state dir: {}", base_dir.display())
        })?;
        Ok(Self {
            path: base_dir.join("state.json"),
        })
    }

    pub fn load(&self) -> Result<WorkerPersistentState> {
        if !self.path.exists() {
            return Ok(WorkerPersistentState::default());
        }
        #[cfg(unix)]
        reject_insecure_permissions(&self.path, 0o600)?;
        let raw = fs::read_to_string(&self.path).with_context(|| {
            format!("unable to read worker state file: {}", self.path.display())
        })?;
        let parsed = serde_json::from_str::<WorkerPersistentState>(&raw).with_context(|| {
            format!("unable to parse worker state file: {}", self.path.display())
        })?;
        Ok(parsed)
    }

    pub fn save(&self, state: &WorkerPersistentState) -> Result<()> {
        let data = serde_json::to_vec_pretty(state).context("unable to serialise worker state")?;
        #[cfg(unix)]
        {
            if self.path.exists() {
                reject_insecure_permissions(&self.path, 0o600)?;
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&self.path)
                .with_context(|| {
                    format!("unable to write worker state file: {}", self.path.display())
                })?;
            fs::set_permissions(&self.path, Permissions::from_mode(0o600)).with_context(|| {
                format!("unable to secure worker state file: {}", self.path.display())
            })?;
            file.write_all(&data).with_context(|| {
                format!("unable to write worker state file: {}", self.path.display())
            })?;
        }
        #[cfg(not(unix))]
        fs::write(&self.path, data).with_context(|| {
            format!("unable to write worker state file: {}", self.path.display())
        })?;
        Ok(())
    }
}

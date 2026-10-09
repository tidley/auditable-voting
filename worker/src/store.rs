use crate::model::WorkerPersistentState;
use anyhow::{Context, Result};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::{
    fs::Permissions,
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
        if self.path.exists() {
            reject_insecure_permissions(&self.path, 0o600)?;
        }
        let temporary_path = self.path.with_extension("json.tmp");
        match fs::remove_file(&temporary_path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "unable to remove stale worker state temporary file: {}",
                        temporary_path.display()
                    )
                });
            }
        }

        let save_result = (|| -> Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            options.mode(0o600);
            let mut file = options.open(&temporary_path).with_context(|| {
                format!(
                    "unable to create worker state temporary file: {}",
                    temporary_path.display()
                )
            })?;
            #[cfg(unix)]
            fs::set_permissions(&temporary_path, Permissions::from_mode(0o600)).with_context(
                || {
                    format!(
                        "unable to secure worker state temporary file: {}",
                        temporary_path.display()
                    )
                },
            )?;
            file.write_all(&data).with_context(|| {
                format!(
                    "unable to write worker state temporary file: {}",
                    temporary_path.display()
                )
            })?;
            file.sync_all().with_context(|| {
                format!(
                    "unable to sync worker state temporary file: {}",
                    temporary_path.display()
                )
            })?;
            drop(file);
            fs::rename(&temporary_path, &self.path).with_context(|| {
                format!(
                    "unable to replace worker state file: {}",
                    self.path.display()
                )
            })?;
            #[cfg(unix)]
            {
                let parent = self
                    .path
                    .parent()
                    .context("worker state path has no parent")?;
                fs::File::open(parent)
                    .with_context(|| {
                        format!(
                            "unable to open worker state directory: {}",
                            parent.display()
                        )
                    })?
                    .sync_all()
                    .with_context(|| {
                        format!(
                            "unable to sync worker state directory: {}",
                            parent.display()
                        )
                    })?;
            }
            Ok(())
        })();

        if save_result.is_err() {
            let _ = fs::remove_file(&temporary_path);
        }
        save_result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_state_dir(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "auditable-voting-worker-store-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    #[test]
    fn save_round_trips_state_and_removes_stale_temporary_file() {
        let state_dir = unique_state_dir("atomic-save");
        let store = WorkerStore::open(&state_dir).expect("open worker store");
        let initial = WorkerPersistentState {
            coordinator_npub: "npub1coordinator".to_string(),
            worker_npub: "npub1worker".to_string(),
            ..WorkerPersistentState::default()
        };
        store.save(&initial).expect("save initial state");

        fs::write(state_dir.join("state.json.tmp"), b"stale temporary state")
            .expect("create stale temporary state");
        let mut updated = initial.clone();
        updated.relays.push("wss://relay.example.com".to_string());

        store.save(&updated).expect("save updated state");

        let loaded = store.load().expect("load updated state");
        assert_eq!(
            serde_json::to_value(loaded).expect("serialise loaded state"),
            serde_json::to_value(updated).expect("serialise updated state")
        );
        assert!(!state_dir.join("state.json.tmp").exists());
        fs::remove_dir_all(state_dir).expect("remove worker state directory");
    }
}

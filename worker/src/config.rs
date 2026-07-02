use anyhow::{anyhow, Context, Result};
use nostr_sdk::prelude::RelayUrl;
use std::env;
use std::path::PathBuf;

const DEFAULT_WORKER_RELAYS: &[&str] = &[
    "wss://vm-1734.lnvps.cloud/",
    "wss://relay.nostr.net",
    "wss://nos.lol",
    "wss://relay.nostr.info",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
];
const DEFAULT_WORKER_DM_RELAYS: &[&str] = &[
    "wss://vm-1734.lnvps.cloud/",
    "wss://relay.nostr.net",
    "wss://nos.lol",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
];

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub worker_nsec: String,
    pub coordinator_npub: String,
    pub worker_relays: Vec<RelayUrl>,
    pub worker_dm_relays: Vec<RelayUrl>,
    pub public_archive_relays: Vec<RelayUrl>,
    pub worker_relays_from_env: bool,
    pub worker_dm_relays_from_env: bool,
    pub worker_state_dir: PathBuf,
    pub heartbeat_seconds: u64,
    pub poll_seconds: u64,
    pub public_archive_interval_ms: u64,
    pub public_archive_queue_size: usize,
}

impl WorkerConfig {
    pub fn from_env() -> Result<Self> {
        let worker_nsec = env::var("WORKER_NSEC").context("WORKER_NSEC is required")?;
        let coordinator_npub =
            env::var("COORDINATOR_NPUB").context("COORDINATOR_NPUB is required")?;
        let (raw_relays, worker_relays_from_env) = match env::var("WORKER_RELAYS") {
            Ok(value) => (value, true),
            Err(_) => (DEFAULT_WORKER_RELAYS.join(","), false),
        };
        let (raw_dm_relays, worker_dm_relays_from_env) = match env::var("WORKER_DM_RELAYS") {
            Ok(value) => (value, true),
            Err(_) => (DEFAULT_WORKER_DM_RELAYS.join(","), false),
        };
        let raw_public_archive_relays =
            env::var("WORKER_PUBLIC_ARCHIVE_RELAYS").unwrap_or_default();
        let worker_state_dir = env::var("WORKER_STATE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./worker-state"));
        let heartbeat_seconds = env::var("WORKER_HEARTBEAT_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(30)
            .max(10);
        let poll_seconds = env::var("WORKER_POLL_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(5)
            .max(5);
        let public_archive_interval_ms = env::var("WORKER_PUBLIC_ARCHIVE_INTERVAL_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(500)
            .max(100);
        let public_archive_queue_size = env::var("WORKER_PUBLIC_ARCHIVE_QUEUE_SIZE")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(10_000)
            .max(1);

        let worker_relays = parse_relays("WORKER_RELAYS", &raw_relays)?;
        let worker_dm_relays = parse_relays("WORKER_DM_RELAYS", &raw_dm_relays)?;
        let public_archive_relays =
            parse_optional_relays("WORKER_PUBLIC_ARCHIVE_RELAYS", &raw_public_archive_relays)?;

        Ok(Self {
            worker_nsec,
            coordinator_npub,
            worker_relays,
            worker_dm_relays,
            public_archive_relays,
            worker_relays_from_env,
            worker_dm_relays_from_env,
            worker_state_dir,
            heartbeat_seconds,
            poll_seconds,
            public_archive_interval_ms,
            public_archive_queue_size,
        })
    }
}

fn parse_relays(env_name: &str, value: &str) -> Result<Vec<RelayUrl>> {
    let mut relays: Vec<RelayUrl> = Vec::new();
    for relay in value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let url = RelayUrl::parse(relay).with_context(|| format!("invalid relay URL: {relay}"))?;
        relays.push(url);
    }
    if relays.is_empty() {
        return Err(anyhow!("{env_name} resolved to an empty relay list"));
    }
    Ok(relays)
}

fn parse_optional_relays(env_name: &str, value: &str) -> Result<Vec<RelayUrl>> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    parse_relays(env_name, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_archive_relays_allow_empty_value() {
        assert!(parse_optional_relays("WORKER_PUBLIC_ARCHIVE_RELAYS", "")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn optional_archive_relays_parse_comma_list() {
        let relays = parse_optional_relays(
            "WORKER_PUBLIC_ARCHIVE_RELAYS",
            "wss://relay.nostr.net, wss://nos.lol",
        )
        .unwrap();
        assert_eq!(relays.len(), 2);
    }
}

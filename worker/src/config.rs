use anyhow::{anyhow, Context, Result};
use nostr_sdk::prelude::RelayUrl;
use std::env;
use std::path::PathBuf;

const DEFAULT_WORKER_RELAYS: &[&str] = &[
    "wss://relay.nostr.net",
    "wss://nos.lol",
    "wss://relay.nostr.info",
    "wss://nip17.com",
    "wss://relay.layer.systems",
    "wss://nostr.bond",
    "wss://auth.nostr1.com",
    "wss://inbox.nostr.wine",
    "wss://nostr-pub.wellorder.net",
    "wss://relay.0xchat.com",
];

#[derive(Debug, Clone)]
pub struct WorkerConfig {
    pub worker_nsec: String,
    pub coordinator_npub: String,
    pub worker_relays: Vec<RelayUrl>,
    pub worker_relays_from_env: bool,
    pub worker_state_dir: PathBuf,
    pub heartbeat_seconds: u64,
    pub poll_seconds: u64,
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
            .unwrap_or(15)
            .max(5);

        let worker_relays = parse_relays(&raw_relays)?;

        Ok(Self {
            worker_nsec,
            coordinator_npub,
            worker_relays,
            worker_relays_from_env,
            worker_state_dir,
            heartbeat_seconds,
            poll_seconds,
        })
    }
}

fn parse_relays(value: &str) -> Result<Vec<RelayUrl>> {
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
        return Err(anyhow!("WORKER_RELAYS resolved to an empty relay list"));
    }
    Ok(relays)
}

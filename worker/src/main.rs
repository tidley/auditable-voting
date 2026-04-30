mod config;
mod model;
mod store;

use crate::config::WorkerConfig;
use crate::model::{
    is_expired, now_iso, BlindBallotIssuance, BlindBallotIssuanceEnvelope, BlindBallotRequest,
    BlindBallotRequestEnvelope, ElectionRuntimeState, QuestionnaireBlindResponseEvent,
    QuestionnaireSubmissionDecisionEvent, WorkerCapability, WorkerDelegationCertificate,
    WorkerDelegationEnvelope, WorkerDelegationRevocation, WorkerElectionConfigEnvelope,
    WorkerElectionConfigSnapshot, WorkerPersistentState, WorkerRevocationEnvelope,
    WorkerStatusEnvelope, WorkerStatusSnapshot, IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND,
    IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY, IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE,
    IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION, OPTIONA_WORKER_DELEGATION_KIND,
    OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
};
use crate::store::WorkerStore;
use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use blind_rsa_signatures::SecretKeySha384PSSDeterministic;
use chrono::Utc;
use crypto_bigint::BoxedUint;
use nostr_sdk::prelude::*;
use rsa::RsaPrivateKey;
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{sleep, timeout};
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_DM_LOOKBACK_SECS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_PUBLIC_LOOKBACK_SECS: u64 = 12 * 60 * 60;
const CONTROL_DM_DEDUPE_RETENTION_SECS: i64 = 14 * 24 * 60 * 60;
const PRIVATE_DM_SEND_TIMEOUT_SECS: u64 = 12;
const COMPLETION_CLOSE_GRACE_SECS: u64 = 5;
const DISCOURAGED_WORKER_READ_RELAYS: &[&str] = &[
    "wss://strfry.bitsbytom.com",
    "wss://nip17.tomdwyer.uk",
    "wss://relay.nostr.band",
    "wss://offchain.pub",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nostr.mom",
    "wss://nostr.wine",
    "wss://eden.nostr.land",
    "wss://purplepag.es",
    "wss://nip17.com",
    "wss://relay.layer.systems",
    "wss://nostr.bond",
    "wss://auth.nostr1.com",
    "wss://inbox.nostr.wine",
    "wss://nostr-pub.wellorder.net",
    "wss://relay.0xchat.com",
];
const DISCOURAGED_RELAY_INITIAL_BACKOFF_SECS: u64 = 60;
const DISCOURAGED_RELAY_MAX_BACKOFF_SECS: u64 = 60 * 60;

fn parse_jwk_component(jwk: &serde_json::Value, key: &str) -> Result<BoxedUint> {
    let value = jwk
        .get(key)
        .and_then(|entry| entry.as_str())
        .with_context(|| format!("missing JWK component '{key}'"))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .with_context(|| format!("invalid base64url for JWK component '{key}'"))?;
    Ok(BoxedUint::from_be_slice_vartime(&decoded))
}

fn sign_blinded_message(blinded_hex: &str, private_jwk: &serde_json::Value) -> Result<String> {
    let clean = blinded_hex.trim();
    if clean.is_empty() || clean.len() % 2 != 0 {
        anyhow::bail!("invalid blinded message encoding");
    }
    let mut blinded_bytes = Vec::with_capacity(clean.len() / 2);
    for chunk in clean.as_bytes().chunks(2) {
        let pair = std::str::from_utf8(chunk).context("invalid blinded message bytes")?;
        let value = u8::from_str_radix(pair, 16).context("invalid blinded message hex")?;
        blinded_bytes.push(value);
    }
    let n = parse_jwk_component(private_jwk, "n")?;
    let e = parse_jwk_component(private_jwk, "e")?;
    let d = parse_jwk_component(private_jwk, "d")?;
    let p = parse_jwk_component(private_jwk, "p")?;
    let q = parse_jwk_component(private_jwk, "q")?;
    let mut key = RsaPrivateKey::from_components(n, e, d, vec![p, q])
        .context("unable to construct RSA private key from JWK")?;
    key.validate().context("invalid RSA private key")?;
    key.precompute().context("unable to precompute RSA key")?;
    let signing_key = SecretKeySha384PSSDeterministic::new(key);
    let signature = signing_key
        .blind_sign(&blinded_bytes)
        .context("blind signing failed")?;
    Ok(signature
        .0
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>())
}

fn random_suffix() -> String {
    format!(
        "{}{:08x}",
        Timestamp::now().as_secs(),
        rand::random::<u32>()
    )
}

fn apply_worker_election_config(
    election: &mut ElectionRuntimeState,
    snapshot: &WorkerElectionConfigSnapshot,
) {
    election.expected_invitee_count = snapshot.expected_invitee_count;
    if snapshot.blind_signing_private_key.is_some() {
        election.blind_signing_private_key = snapshot.blind_signing_private_key.clone();
    }
    if snapshot.definition.is_some() {
        election.definition = snapshot.definition.clone();
    }
}

fn build_blind_issuance(
    request: &BlindBallotRequest,
    election: &ElectionRuntimeState,
    blind_signature: String,
    issued_at: String,
) -> BlindBallotIssuance {
    BlindBallotIssuance {
        message_type: "blind_ballot_response".to_string(),
        schema_version: 1,
        election_id: request.election_id.clone(),
        request_id: request.request_id.clone(),
        issuance_id: format!("issuance_{}", random_suffix()),
        invited_npub: request.invited_npub.clone(),
        token_commitment: request.token_commitment.clone(),
        blind_signing_key_id: request.blind_signing_key_id.clone(),
        blind_signature,
        definition: election.definition.clone(),
        issued_at,
    }
}

#[derive(Clone)]
struct WorkerRuntime {
    config: WorkerConfig,
    client: Client,
    worker_pubkey: PublicKey,
    worker_npub: String,
    coordinator_pubkey: PublicKey,
    store: Arc<WorkerStore>,
    state: Arc<Mutex<WorkerPersistentState>>,
    relay_backoff: Arc<Mutex<HashMap<String, RelayBackoffState>>>,
}

#[derive(Clone, Debug, Default)]
struct RelayBackoffState {
    failures: u32,
    next_retry_at: Option<Instant>,
}

#[tokio::main]
async fn main() -> Result<()> {
    if env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("auditable-voting-worker {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(env_filter).init();

    let config = WorkerConfig::from_env()?;
    let keys = Keys::parse(&config.worker_nsec).context("WORKER_NSEC is not a valid nsec")?;
    let worker_pubkey = keys.public_key();
    let worker_npub = worker_pubkey.to_bech32()?;
    let coordinator_pubkey = PublicKey::from_bech32(&config.coordinator_npub)
        .context("COORDINATOR_NPUB is not a valid npub")?;

    let relay_strings = config
        .worker_relays
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    info!(
        "starting auditable-voting-worker v{}",
        env!("CARGO_PKG_VERSION")
    );
    info!(
        "worker startup config: coordinator_npub={}, relay_source={}, relay_count={}, relays={:?}, state_dir={}, heartbeat_seconds={}, poll_seconds={}",
        config.coordinator_npub,
        if config.worker_relays_from_env { "env" } else { "default" },
        relay_strings.len(),
        relay_strings,
        config.worker_state_dir.display(),
        config.heartbeat_seconds,
        config.poll_seconds,
    );

    let client = Client::new(keys);
    for relay in &config.worker_relays {
        client
            .add_relay(relay.clone())
            .await
            .with_context(|| format!("unable to add relay {}", relay))?;
    }
    client.connect().await;

    let store = Arc::new(WorkerStore::open(&config.worker_state_dir)?);
    let mut persistent = store.load()?;
    persistent.worker_npub = worker_npub.clone();
    persistent.coordinator_npub = config.coordinator_npub.clone();
    persistent.relays = config
        .worker_relays
        .iter()
        .map(ToString::to_string)
        .collect();
    store.save(&persistent)?;

    let runtime = WorkerRuntime {
        config,
        client,
        worker_pubkey,
        worker_npub: worker_npub.clone(),
        coordinator_pubkey,
        store,
        state: Arc::new(Mutex::new(persistent)),
        relay_backoff: Arc::new(Mutex::new(HashMap::new())),
    };

    info!("worker started as {}", worker_npub);

    let mut heartbeat_task = spawn_heartbeat_task(runtime.clone());
    let mut control_task = spawn_control_task(runtime.clone());
    let mut public_task = spawn_public_task(runtime.clone());

    loop {
        tokio::select! {
            result = &mut heartbeat_task => {
                log_task_exit("heartbeat", result);
                heartbeat_task = spawn_heartbeat_task(runtime.clone());
            },
            result = &mut control_task => {
                log_task_exit("control plane", result);
                control_task = spawn_control_task(runtime.clone());
            },
            result = &mut public_task => {
                log_task_exit("public plane", result);
                public_task = spawn_public_task(runtime.clone());
            },
        }
    }
}

fn spawn_heartbeat_task(runtime: WorkerRuntime) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = runtime.send_status_heartbeat().await {
                warn!("status heartbeat failed: {error}");
            }
            sleep(Duration::from_secs(runtime.config.heartbeat_seconds)).await;
        }
    })
}

fn spawn_control_task(runtime: WorkerRuntime) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = runtime.poll_control_plane().await {
                warn!("control plane poll failed: {error}");
            }
            sleep(Duration::from_secs(runtime.config.poll_seconds)).await;
        }
    })
}

fn spawn_public_task(runtime: WorkerRuntime) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = runtime.poll_public_plane().await {
                warn!("public plane poll failed: {error}");
            }
            sleep(Duration::from_secs(runtime.config.poll_seconds)).await;
        }
    })
}

fn log_task_exit(label: &str, result: std::result::Result<(), tokio::task::JoinError>) {
    match result {
        Ok(()) => error!("{label} task exited unexpectedly; restarting"),
        Err(error) if error.is_panic() => error!("{label} task panicked: {error}; restarting"),
        Err(error) => error!("{label} task failed: {error}; restarting"),
    }
}

impl WorkerRuntime {
    async fn fetch_events_best_effort(
        &self,
        label: &str,
        filter: Filter,
        timeout_secs: u64,
    ) -> Vec<Event> {
        let mut tasks = tokio::task::JoinSet::new();
        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;
        for relay in relays {
            let client = self.client.clone();
            let filter_for_task = filter.clone();
            tasks.spawn(async move {
                let result = client
                    .fetch_events_from(
                        [relay.clone()],
                        filter_for_task,
                        Duration::from_secs(timeout_secs),
                    )
                    .await;
                (relay, result)
            });
        }

        let mut events_by_id = BTreeMap::new();
        let mut successes = 0usize;
        let mut failures = Vec::new();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok((relay, Ok(events))) => {
                    self.record_relay_attempt_result(&relay, true, label).await;
                    successes = successes.saturating_add(1);
                    for event in events {
                        events_by_id.insert(event.id, event);
                    }
                    debug!("{label} relay read succeeded: {relay}");
                }
                Ok((relay, Err(error))) => {
                    self.record_relay_attempt_result(&relay, false, label).await;
                    failures.push(format!("{relay}: {error}"));
                }
                Err(error) => failures.push(format!("join error: {error}")),
            }
        }
        if !failures.is_empty() {
            warn!(
                "{label} relay read completed with {} successes and {} failures: {}",
                successes,
                failures.len(),
                failures.join("; ")
            );
        }
        events_by_id.into_values().collect()
    }

    async fn send_status_heartbeat(&self) -> Result<()> {
        let snapshot = {
            let state = self.state.lock().await;
            let mut active: Option<&ElectionRuntimeState> = None;
            for election in state.elections.values() {
                if election.revoked || is_expired(&election.expires_at) {
                    continue;
                }
                active = Some(election);
                break;
            }
            WorkerStatusSnapshot {
                message_type: "worker_status".to_string(),
                schema_version: 1,
                worker_npub: self.worker_npub.clone(),
                coordinator_npub: self.config.coordinator_npub.clone(),
                worker_version: env!("CARGO_PKG_VERSION").to_string(),
                state: if active.is_some() {
                    "active".to_string()
                } else {
                    "online".to_string()
                },
                heartbeat_at: now_iso(),
                active_election_id: active.map(|entry| entry.election_id.clone()),
                delegation_id: active.map(|entry| entry.delegation_id.clone()),
                delegation_state: active.map(|entry| {
                    if entry.revoked {
                        "revoked".to_string()
                    } else if is_expired(&entry.expires_at) {
                        "expired".to_string()
                    } else {
                        "active".to_string()
                    }
                }),
                last_blind_issuance_at: active
                    .and_then(|entry| entry.last_blind_issuance_at.clone()),
                last_vote_verification_at: active
                    .and_then(|entry| entry.last_vote_verification_at.clone()),
                last_decision_publish_at: active
                    .and_then(|entry| entry.last_decision_publish_at.clone()),
                supported_capabilities: vec![
                    WorkerCapability::IssueBlindTokens,
                    WorkerCapability::VerifyPublicSubmissions,
                    WorkerCapability::PublishSubmissionDecisions,
                    WorkerCapability::CloseQuestionnaire,
                    WorkerCapability::PublishResultSummary,
                ],
                advertised_relays: self
                    .config
                    .worker_relays
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
            }
        };
        let envelope = WorkerStatusEnvelope {
            message_type: "optiona_worker_status_dm".to_string(),
            schema_version: 1,
            snapshot,
            sent_at: now_iso(),
        };
        let content = serde_json::to_string(&envelope)?;
        self.send_private_msg_best_effort(self.coordinator_pubkey, content, "worker status")
            .await?;
        let mut state = self.state.lock().await;
        state.last_heartbeat_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn send_private_msg_best_effort(
        &self,
        recipient: PublicKey,
        content: String,
        label: &str,
    ) -> Result<usize> {
        let signer = self.client.signer().await?;
        let event =
            EventBuilder::private_msg(&signer, recipient, content, std::iter::empty::<Tag>())
                .await
                .with_context(|| format!("{label} gift-wrap construction failed"))?;
        let mut tasks = tokio::task::JoinSet::new();
        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;
        for relay in relays {
            let client = self.client.clone();
            let event_for_task = event.clone();
            tasks.spawn(async move {
                let result = timeout(
                    Duration::from_secs(PRIVATE_DM_SEND_TIMEOUT_SECS),
                    client.send_event_to([relay.clone()], &event_for_task),
                )
                .await;
                (relay, result)
            });
        }
        let mut successes = 0usize;
        let mut failures = Vec::new();
        while let Some(result) = tasks.join_next().await {
            match result {
                Ok((relay, Ok(Ok(output)))) => {
                    let relay_success = !output.success.is_empty();
                    self.record_relay_attempt_result(&relay, relay_success, label)
                        .await;
                    successes += output.success.len();
                    if !relay_success {
                        failures.push(format!("{}: {:?}", relay, output.failed));
                    }
                }
                Ok((relay, Ok(Err(error)))) => {
                    self.record_relay_attempt_result(&relay, false, label).await;
                    failures.push(format!("{relay}: {error}"));
                }
                Ok((relay, Err(_))) => {
                    self.record_relay_attempt_result(&relay, false, label).await;
                    failures.push(format!("{relay}: timed out"));
                }
                Err(error) => failures.push(format!("join error: {error}")),
            }
        }
        if successes == 0 {
            anyhow::bail!(
                "{label} private DM publish failed on all relays: {}",
                failures.join("; ")
            );
        }
        if !failures.is_empty() {
            debug!(
                "{label} private DM publish completed with {} successes and {} failures: {}",
                successes,
                failures.len(),
                failures.join("; ")
            );
        }
        Ok(successes)
    }

    async fn poll_control_plane(&self) -> Result<()> {
        let since_ts = fixed_lookback_timestamp(DEFAULT_DM_LOOKBACK_SECS);
        debug!(
            "control plane polling gift-wraps with fixed lookback: lookback_secs={}, since={}",
            DEFAULT_DM_LOOKBACK_SECS,
            since_ts.as_secs()
        );
        let filter = Filter::new()
            .kind(Kind::GiftWrap)
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::P),
                self.worker_pubkey.to_hex(),
            )
            .since(since_ts)
            .limit(250);
        let events = self
            .fetch_events_best_effort("control plane", filter, 8)
            .await;
        info!(
            "control plane poll fetched {} gift-wrapped events for worker",
            events.len()
        );
        let unseen_events = {
            let mut state = self.state.lock().await;
            prune_seen_control_events(&mut state.seen_control_event_ids, Utc::now());
            events
                .into_iter()
                .filter(|event| {
                    !state
                        .seen_control_event_ids
                        .contains_key(&event.id.to_string())
                })
                .collect::<Vec<_>>()
        };
        debug!(
            "control plane poll fetched {} unseen gift-wrapped events",
            unseen_events.len()
        );
        let mut seen_event_ids = Vec::with_capacity(unseen_events.len());
        for event in unseen_events {
            let unwrapped = match self.client.unwrap_gift_wrap(&event).await {
                Ok(unwrapped) => unwrapped,
                Err(error) => {
                    warn!("failed to unwrap control gift-wrap {}: {error}", event.id);
                    continue;
                }
            };
            let rumor_content = unwrapped.rumor.content;
            if rumor_content.trim().is_empty() {
                continue;
            }
            match self.process_control_message(&rumor_content).await {
                Ok(true) => seen_event_ids.push(event.id.to_string()),
                Ok(false) => {}
                Err(error) => {
                    warn!("control message from event {} failed: {error}", event.id);
                }
            }
        }
        let mut state = self.state.lock().await;
        let seen_at = now_iso();
        for event_id in seen_event_ids {
            state
                .seen_control_event_ids
                .insert(event_id, seen_at.clone());
        }
        prune_seen_control_events(&mut state.seen_control_event_ids, Utc::now());
        state.last_dm_scan_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn effective_worker_relays(&self) -> Vec<RelayUrl> {
        let mut relays = self.config.worker_relays.clone();
        let state = self.state.lock().await;
        for election in state.elections.values() {
            if election.revoked || is_expired(&election.expires_at) {
                continue;
            }
            for relay in &election.control_relays {
                match RelayUrl::parse(relay) {
                    Ok(parsed) => relays.push(parsed),
                    Err(error) => {
                        warn!("ignoring invalid delegated control relay {relay}: {error}")
                    }
                }
            }
        }
        drop(state);
        self.select_relay_retry_batch(dedupe_relays(relays)).await
    }

    async fn ensure_relays_connected(&self, relays: &[RelayUrl]) {
        for relay in relays {
            if let Err(error) = self.client.add_relay(relay.clone()).await {
                warn!("unable to add effective relay {relay}: {error}");
            }
        }
    }

    async fn select_relay_retry_batch(&self, relays: Vec<RelayUrl>) -> Vec<RelayUrl> {
        let now = Instant::now();
        let relay_backoff = self.relay_backoff.lock().await;
        let mut selected = Vec::with_capacity(relays.len());
        for relay in relays {
            if !is_discouraged_worker_relay(&relay.to_string()) {
                selected.push(relay);
                continue;
            }

            let key = normalize_relay_key(&relay.to_string());
            match relay_backoff
                .get(&key)
                .and_then(|state| state.next_retry_at)
            {
                Some(next_retry_at) if next_retry_at > now => {
                    let wait_secs = next_retry_at.saturating_duration_since(now).as_secs();
                    debug!(
                        "discouraged worker relay {relay} is in backoff; retrying in {wait_secs}s"
                    );
                }
                _ => {
                    debug!("trying discouraged worker relay {relay}");
                    selected.push(relay);
                }
            }
        }
        selected
    }

    async fn record_relay_attempt_result(&self, relay: &RelayUrl, success: bool, label: &str) {
        if !is_discouraged_worker_relay(&relay.to_string()) {
            return;
        }
        let key = normalize_relay_key(&relay.to_string());
        let mut relay_backoff = self.relay_backoff.lock().await;
        if success {
            if relay_backoff.remove(&key).is_some() {
                info!("{label} discouraged relay recovered and will be retried normally: {relay}");
            }
            return;
        }

        let entry = relay_backoff.entry(key).or_default();
        entry.failures = entry.failures.saturating_add(1);
        let delay = discouraged_relay_retry_delay(entry.failures);
        entry.next_retry_at = Some(Instant::now() + delay);
        warn!(
            "{label} discouraged relay failed; backing off for {}s before retrying {relay}",
            delay.as_secs()
        );
    }

    async fn process_control_message(&self, content: &str) -> Result<bool> {
        let value: serde_json::Value = match serde_json::from_str(content) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(true),
        };
        let message_type = value
            .get("type")
            .and_then(|entry| entry.as_str())
            .unwrap_or_default();
        info!("control message parsed: type={message_type}");
        match message_type {
            "optiona_worker_delegation_dm" => {
                let envelope: WorkerDelegationEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(true),
                };
                self.apply_delegation(envelope.delegation).await?;
            }
            "optiona_worker_delegation_revocation_dm" => {
                let envelope: WorkerRevocationEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(true),
                };
                self.apply_revocation(envelope.revocation).await?;
            }
            "optiona_worker_election_config_dm" => {
                let envelope: WorkerElectionConfigEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(true),
                };
                info!(
                    "worker election config received: election_id={}, delegation_id={}",
                    envelope.snapshot.election_id, envelope.snapshot.delegation_id
                );
                self.apply_election_config(envelope.snapshot).await?;
            }
            "optiona_blind_request_dm" => {
                let envelope: BlindBallotRequestEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(true),
                };
                info!(
                    "blind request received: election_id={}, request_id={}, invited_npub={}",
                    envelope.request.election_id,
                    envelope.request.request_id,
                    envelope.request.invited_npub
                );
                return self.handle_blind_request(envelope.request).await;
            }
            _ => return Ok(true),
        }
        Ok(true)
    }

    async fn poll_public_plane(&self) -> Result<()> {
        self.poll_public_delegations_and_revocations().await?;
        self.process_public_submissions().await?;
        let mut state = self.state.lock().await;
        state.last_public_scan_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn poll_public_delegations_and_revocations(&self) -> Result<()> {
        let since_ts = fixed_lookback_timestamp(DEFAULT_PUBLIC_LOOKBACK_SECS);
        let filter = Filter::new()
            .author(self.coordinator_pubkey)
            .kinds(vec![
                Kind::Custom(OPTIONA_WORKER_DELEGATION_KIND),
                Kind::Custom(OPTIONA_WORKER_DELEGATION_REVOCATION_KIND),
            ])
            .since(since_ts)
            .limit(300);
        let events = self
            .fetch_events_best_effort("delegation plane", filter, 8)
            .await;
        for event in events {
            match event.kind {
                Kind::Custom(kind) if kind == OPTIONA_WORKER_DELEGATION_KIND => {
                    if let Ok(delegation) =
                        serde_json::from_str::<WorkerDelegationCertificate>(&event.content)
                    {
                        self.apply_delegation(delegation).await?;
                    }
                }
                Kind::Custom(kind) if kind == OPTIONA_WORKER_DELEGATION_REVOCATION_KIND => {
                    if let Ok(revocation) =
                        serde_json::from_str::<WorkerDelegationRevocation>(&event.content)
                    {
                        self.apply_revocation(revocation).await?;
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }

    async fn process_public_submissions(&self) -> Result<()> {
        let elections_to_process = {
            let state = self.state.lock().await;
            state
                .elections
                .values()
                .filter(|entry| !entry.revoked && !is_expired(&entry.expires_at))
                .filter(|entry| {
                    entry
                        .capabilities
                        .contains(&WorkerCapability::VerifyPublicSubmissions)
                        || entry
                            .capabilities
                            .contains(&WorkerCapability::PublishSubmissionDecisions)
                        || entry
                            .capabilities
                            .contains(&WorkerCapability::CloseQuestionnaire)
                        || entry
                            .capabilities
                            .contains(&WorkerCapability::PublishResultSummary)
                })
                .map(|entry| entry.election_id.clone())
                .collect::<Vec<_>>()
        };
        if elections_to_process.is_empty() {
            return Ok(());
        }

        let since_ts = fixed_lookback_timestamp(DEFAULT_PUBLIC_LOOKBACK_SECS);
        let filter = Filter::new()
            .kind(Kind::Custom(
                IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND,
            ))
            .hashtag("questionnaire_response_blind")
            .since(since_ts)
            .limit(500);
        let events = self
            .fetch_events_best_effort("public plane", filter, 8)
            .await;
        info!(
            "public plane poll fetched {} blind response events",
            events.len()
        );

        let mut unrelated_response_count = 0usize;
        for event in events {
            let submission =
                match serde_json::from_str::<QuestionnaireBlindResponseEvent>(&event.content) {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        warn!("failed to parse blind response event {}: {error}", event.id);
                        continue;
                    }
                };
            if !elections_to_process.contains(&submission.questionnaire_id) {
                unrelated_response_count = unrelated_response_count.saturating_add(1);
                continue;
            }
            info!(
                "public blind response received: questionnaire_id={}, response_id={}",
                submission.questionnaire_id, submission.response_id
            );
            self.handle_submission(submission).await?;
        }
        if unrelated_response_count > 0 {
            debug!(
                "public plane skipped {} blind response events for unrelated questionnaires",
                unrelated_response_count
            );
        }
        self.finalize_completed_elections().await?;
        Ok(())
    }

    async fn handle_submission(&self, submission: QuestionnaireBlindResponseEvent) -> Result<()> {
        let mut state = self.state.lock().await;
        let Some(election) = state.elections.get_mut(&submission.questionnaire_id) else {
            return Ok(());
        };
        if election
            .processed_submission_ids
            .contains(&submission.response_id)
        {
            return Ok(());
        }

        let mut accepted = true;
        let mut reason = "accepted".to_string();

        if submission.event_type != "questionnaire_response_blind" {
            accepted = false;
            reason = "invalid_payload_shape".to_string();
        } else if submission.token_nullifier.trim().is_empty()
            || submission.response_id.trim().is_empty()
            || submission.author_pubkey.trim().is_empty()
        {
            accepted = false;
            reason = "invalid_payload_shape".to_string();
        } else if election
            .accepted_nullifiers
            .contains(&submission.token_nullifier)
        {
            accepted = false;
            reason = "duplicate_nullifier".to_string();
        }

        if accepted {
            election
                .accepted_nullifiers
                .insert(submission.token_nullifier.clone());
            election
                .accepted_response_authors
                .insert(submission.author_pubkey.clone());
            election.accepted_response_count = election.accepted_response_count.saturating_add(1);
        } else {
            election.rejected_response_count = election.rejected_response_count.saturating_add(1);
        }
        election
            .processed_submission_ids
            .insert(submission.response_id.clone());
        election.last_vote_verification_at = Some(now_iso());

        if election
            .capabilities
            .contains(&WorkerCapability::PublishSubmissionDecisions)
        {
            let decision = QuestionnaireSubmissionDecisionEvent {
                schema_version: 1,
                event_type: "questionnaire_submission_decision".to_string(),
                questionnaire_id: submission.questionnaire_id.clone(),
                submission_id: submission.response_id.clone(),
                token_nullifier: submission.token_nullifier.clone(),
                accepted,
                reason: reason.clone(),
                decided_at: Timestamp::now().as_secs() as i64,
                coordinator_pubkey: self.config.coordinator_npub.clone(),
                delegation_id: Some(election.delegation_id.clone()),
                worker_pubkey: Some(self.worker_npub.clone()),
            };
            let event_id = self.publish_submission_decision(&decision).await?;
            election
                .published_decisions
                .insert(decision.submission_id.clone(), event_id);
            election.last_decision_publish_at = Some(now_iso());
        }

        self.store.save(&state)?;
        Ok(())
    }

    async fn finalize_completed_elections(&self) -> Result<()> {
        #[derive(Debug, Clone)]
        struct CompletionAction {
            election_id: String,
            delegation_id: String,
            accepted_count: u64,
            rejected_count: u64,
            close_questionnaire: bool,
            publish_summary: bool,
        }

        let actions = {
            let state = self.state.lock().await;
            state
                .elections
                .values()
                .filter(|entry| !entry.revoked && !is_expired(&entry.expires_at))
                .filter_map(|entry| {
                    let expected = entry.expected_invitee_count.unwrap_or(0);
                    let accepted_unique = entry.accepted_response_authors.len() as u64;
                    if expected == 0 || accepted_unique < expected {
                        return None;
                    }
                    let close_questionnaire = entry
                        .capabilities
                        .contains(&WorkerCapability::CloseQuestionnaire)
                        && !entry.questionnaire_close_published;
                    let publish_summary = entry
                        .capabilities
                        .contains(&WorkerCapability::PublishResultSummary)
                        && !entry.summary_published;
                    if !close_questionnaire && !publish_summary {
                        return None;
                    }
                    Some(CompletionAction {
                        election_id: entry.election_id.clone(),
                        delegation_id: entry.delegation_id.clone(),
                        accepted_count: entry.accepted_response_count,
                        rejected_count: entry.rejected_response_count,
                        close_questionnaire,
                        publish_summary,
                    })
                })
                .collect::<Vec<_>>()
        };

        for action in actions {
            if action.close_questionnaire {
                sleep(Duration::from_secs(COMPLETION_CLOSE_GRACE_SECS)).await;
                let close_event_id = self
                    .publish_questionnaire_closed_state(&action.election_id, &action.delegation_id)
                    .await?;
                let mut state = self.state.lock().await;
                if let Some(election) = state.elections.get_mut(&action.election_id) {
                    election.questionnaire_close_published = true;
                    election.last_questionnaire_close_publish_at = Some(now_iso());
                }
                self.store.save(&state)?;
                info!(
                    "published delegated questionnaire close for election {} event_id={}",
                    action.election_id, close_event_id
                );
            }

            if action.publish_summary {
                let summary_event_id = self
                    .publish_result_summary(
                        &action.election_id,
                        action.accepted_count,
                        action.rejected_count,
                    )
                    .await?;
                let mut state = self.state.lock().await;
                if let Some(election) = state.elections.get_mut(&action.election_id) {
                    election.summary_published = true;
                    election.last_result_summary_publish_at = Some(now_iso());
                }
                self.store.save(&state)?;
                info!(
                    "published questionnaire result summary for election {} event_id={}",
                    action.election_id, summary_event_id
                );
            }
        }

        Ok(())
    }

    async fn publish_submission_decision(
        &self,
        decision: &QuestionnaireSubmissionDecisionEvent,
    ) -> Result<String> {
        let content = serde_json::to_string(decision)?;
        let mut builder = EventBuilder::new(
            Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION),
            content,
        );
        let tags = vec![
            vec![
                "t".to_string(),
                "questionnaire_submission_decision".to_string(),
            ],
            vec![
                "questionnaire".to_string(),
                decision.questionnaire_id.clone(),
            ],
            vec!["schema".to_string(), "1".to_string()],
            vec![
                "etype".to_string(),
                "questionnaire_submission_decision".to_string(),
            ],
            vec!["submission-id".to_string(), decision.submission_id.clone()],
            vec!["nullifier".to_string(), decision.token_nullifier.clone()],
            vec![
                "accepted".to_string(),
                if decision.accepted {
                    "1".to_string()
                } else {
                    "0".to_string()
                },
            ],
            vec!["reason".to_string(), decision.reason.clone()],
            vec![
                "coordinator".to_string(),
                decision.coordinator_pubkey.clone(),
            ],
            vec!["worker".to_string(), self.worker_npub.clone()],
            vec![
                "delegation-id".to_string(),
                decision.delegation_id.clone().unwrap_or_default(),
            ],
        ];
        for tag in tags {
            if let Ok(parsed) = Tag::parse(tag) {
                builder = builder.tag(parsed);
            }
        }
        let output = self.client.send_event_builder(builder).await?;
        Ok(output.val.to_hex())
    }

    async fn publish_questionnaire_closed_state(
        &self,
        election_id: &str,
        delegation_id: &str,
    ) -> Result<String> {
        let content = serde_json::json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_state",
            "questionnaireId": election_id,
            "state": "closed",
            "createdAt": Timestamp::now().as_secs() as i64,
            "coordinatorPubkey": self.config.coordinator_npub,
            "closedBy": "audit_proxy",
            "delegationId": delegation_id,
            "workerPubkey": self.worker_npub,
        })
        .to_string();
        let mut builder = EventBuilder::new(
            Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE),
            content,
        );
        let tags = vec![
            vec!["t".to_string(), "questionnaire_state".to_string()],
            vec!["questionnaire-id".to_string(), election_id.to_string()],
            vec!["state".to_string(), "closed".to_string()],
            vec!["closed-by".to_string(), "audit_proxy".to_string()],
            vec!["worker".to_string(), self.worker_npub.clone()],
            vec![
                "coordinator".to_string(),
                self.config.coordinator_npub.clone(),
            ],
            vec!["delegation-id".to_string(), delegation_id.to_string()],
        ];
        for tag in tags {
            if let Ok(parsed) = Tag::parse(tag) {
                builder = builder.tag(parsed);
            }
        }
        let output = self.client.send_event_builder(builder).await?;
        Ok(output.val.to_hex())
    }

    async fn publish_result_summary(
        &self,
        election_id: &str,
        accepted_count: u64,
        rejected_count: u64,
    ) -> Result<String> {
        let content = serde_json::json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_result_summary",
            "questionnaireId": election_id,
            "createdAt": Timestamp::now().as_secs() as i64,
            "coordinatorPubkey": self.config.coordinator_npub,
            "acceptedResponseCount": accepted_count,
            "rejectedResponseCount": rejected_count,
            "acceptedNullifierCount": accepted_count,
            "questionSummaries": [],
        })
        .to_string();
        let mut builder = EventBuilder::new(
            Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY),
            content,
        );
        let tags = vec![
            vec!["t".to_string(), "questionnaire_result_summary".to_string()],
            vec!["questionnaire-id".to_string(), election_id.to_string()],
            vec!["worker".to_string(), self.worker_npub.clone()],
            vec![
                "coordinator".to_string(),
                self.config.coordinator_npub.clone(),
            ],
        ];
        for tag in tags {
            if let Ok(parsed) = Tag::parse(tag) {
                builder = builder.tag(parsed);
            }
        }
        let output = self.client.send_event_builder(builder).await?;
        Ok(output.val.to_hex())
    }

    async fn apply_election_config(&self, snapshot: WorkerElectionConfigSnapshot) -> Result<()> {
        if snapshot.message_type != "worker_election_config" || snapshot.schema_version != 1 {
            return Ok(());
        }
        if snapshot.worker_npub != self.worker_npub {
            return Ok(());
        }
        if snapshot.coordinator_npub != self.config.coordinator_npub {
            return Ok(());
        }
        let mut state = self.state.lock().await;
        let election = state
            .elections
            .entry(snapshot.election_id.clone())
            .or_insert_with(ElectionRuntimeState::default);
        if election.election_id.is_empty() {
            election.election_id = snapshot.election_id.clone();
        }
        if election.delegation_id.is_empty() {
            election.delegation_id = snapshot.delegation_id.clone();
        }
        if election.delegation_id != snapshot.delegation_id {
            return Ok(());
        }
        apply_worker_election_config(election, &snapshot);
        self.store.save(&state)?;
        info!(
            "worker election config applied: election_id={}, delegation_id={}, expected_invitee_count={:?}, has_blind_signing_key={}, has_definition={}",
            snapshot.election_id,
            snapshot.delegation_id,
            snapshot.expected_invitee_count,
            snapshot.blind_signing_private_key.is_some(),
            snapshot.definition.is_some(),
        );
        Ok(())
    }

    async fn handle_blind_request(&self, request: BlindBallotRequest) -> Result<bool> {
        let election = {
            let state = self.state.lock().await;
            let Some(election) = state.elections.get(&request.election_id) else {
                info!(
                    "blind request deferred for election {} because no worker config is loaded yet",
                    request.election_id
                );
                return Ok(false);
            };
            if election.revoked || is_expired(&election.expires_at) {
                return Ok(true);
            }
            if !election
                .capabilities
                .contains(&WorkerCapability::IssueBlindTokens)
            {
                return Ok(true);
            }
            if election
                .seen_blind_request_ids
                .contains(&request.request_id)
            {
                info!(
                    "blind request replay received; re-publishing issuance: election_id={}, request_id={}",
                    request.election_id, request.request_id
                );
            }
            if election.blind_signing_private_key.is_none() {
                warn!(
                    "blind request deferred for election {} because no blind signing key is configured",
                    request.election_id
                );
                return Ok(false);
            }
            election.clone()
        };
        let private_key = election
            .blind_signing_private_key
            .clone()
            .expect("checked above");
        if private_key.key_id != request.blind_signing_key_id {
            warn!(
                "blind request ignored for election {} due to key-id mismatch request={} worker={}",
                request.election_id, request.blind_signing_key_id, private_key.key_id
            );
            return Ok(true);
        }
        let blind_signature =
            sign_blinded_message(&request.blinded_message, &private_key.private_jwk)?;
        let issuance = build_blind_issuance(&request, &election, blind_signature, now_iso());
        let envelope = BlindBallotIssuanceEnvelope {
            message_type: "optiona_blind_issuance_dm".to_string(),
            schema_version: 1,
            issuance,
            sent_at: now_iso(),
        };
        let content = serde_json::to_string(&envelope)?;
        let recipient = PublicKey::from_bech32(&request.invited_npub)
            .context("invalid invited npub on blind request")?;
        let successes = self
            .send_private_msg_best_effort(recipient, content, "blind issuance")
            .await?;
        info!(
            "blind issuance published: election_id={}, request_id={}, invited_npub={}, relay_successes={}",
            request.election_id,
            request.request_id,
            request.invited_npub,
            successes
        );
        let mut state = self.state.lock().await;
        let Some(election) = state.elections.get_mut(&request.election_id) else {
            return Ok(false);
        };
        election.seen_blind_request_ids.insert(request.request_id);
        election.last_blind_issuance_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(true)
    }

    async fn apply_delegation(&self, delegation: WorkerDelegationCertificate) -> Result<()> {
        if delegation.message_type != "worker_delegation" || delegation.schema_version != 1 {
            return Ok(());
        }
        if delegation.worker_npub != self.worker_npub {
            return Ok(());
        }
        if delegation.coordinator_npub != self.config.coordinator_npub {
            return Ok(());
        }
        if is_expired(&delegation.expires_at) {
            warn!(
                "ignoring expired delegation {} for election {}",
                delegation.delegation_id, delegation.election_id
            );
            return Ok(());
        }
        info!(
            "activating delegation {} for election {}",
            delegation.delegation_id, delegation.election_id
        );
        let sanitized_control_relays = sanitize_control_relay_strings(&delegation.control_relays);
        let control_relays = parse_control_relays(&sanitized_control_relays);
        let mut state = self.state.lock().await;
        state
            .known_delegations
            .insert(delegation.delegation_id.clone(), delegation.clone());
        let existing = state
            .elections
            .entry(delegation.election_id.clone())
            .or_insert_with(ElectionRuntimeState::default);
        let delegation_changed = existing.delegation_id != delegation.delegation_id;
        existing.election_id = delegation.election_id.clone();
        existing.delegation_id = delegation.delegation_id.clone();
        existing.capabilities = delegation.capabilities.clone();
        existing.control_relays = sanitized_control_relays;
        existing.revoked = false;
        existing.expires_at = delegation.expires_at.clone();
        if delegation_changed {
            existing.seen_blind_request_ids.clear();
            existing.accepted_response_authors.clear();
            existing.accepted_response_count = 0;
            existing.rejected_response_count = 0;
            existing.expected_invitee_count = None;
            existing.blind_signing_private_key = None;
            existing.definition = None;
            existing.summary_published = false;
            existing.last_result_summary_publish_at = None;
            existing.questionnaire_close_published = false;
            existing.last_questionnaire_close_publish_at = None;
        }
        self.store.save(&state)?;
        drop(state);
        self.ensure_relays_connected(&control_relays).await;
        Ok(())
    }

    async fn apply_revocation(&self, revocation: WorkerDelegationRevocation) -> Result<()> {
        if revocation.message_type != "worker_delegation_revocation"
            || revocation.schema_version != 1
        {
            return Ok(());
        }
        if revocation.worker_npub != self.worker_npub {
            return Ok(());
        }
        if revocation.coordinator_npub != self.config.coordinator_npub {
            return Ok(());
        }
        info!(
            "revoking delegation {} for election {}",
            revocation.delegation_id, revocation.election_id
        );
        let mut state = self.state.lock().await;
        state
            .revocations
            .insert(revocation.delegation_id.clone(), revocation.clone());
        if let Some(election) = state.elections.get_mut(&revocation.election_id) {
            if election.delegation_id == revocation.delegation_id {
                election.revoked = true;
            }
        }
        self.store.save(&state)?;
        Ok(())
    }
}

fn fixed_lookback_timestamp(lookback_secs: u64) -> Timestamp {
    let now = Timestamp::now().as_secs();
    Timestamp::from(now.saturating_sub(lookback_secs))
}

fn dedupe_relays(relays: Vec<RelayUrl>) -> Vec<RelayUrl> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(relays.len());
    for relay in relays {
        if seen.insert(normalize_relay_key(&relay.to_string())) {
            deduped.push(relay);
        }
    }
    deduped
}

fn normalize_relay_key(relay: &str) -> String {
    relay.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn is_discouraged_worker_relay(relay: &str) -> bool {
    let key = normalize_relay_key(relay);
    DISCOURAGED_WORKER_READ_RELAYS
        .iter()
        .any(|entry| normalize_relay_key(entry) == key)
}

fn discouraged_relay_retry_delay(failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(10);
    let secs = DISCOURAGED_RELAY_INITIAL_BACKOFF_SECS
        .saturating_mul(2u64.saturating_pow(exponent))
        .min(DISCOURAGED_RELAY_MAX_BACKOFF_SECS);
    Duration::from_secs(secs)
}

fn sanitize_control_relay_strings(relays: &[String]) -> Vec<String> {
    let mut relay_urls = Vec::new();
    for relay in relays {
        if is_discouraged_worker_relay(relay) {
            debug!(
                "delegated control relay {relay} is discouraged; worker will retry it with backoff"
            );
        }
        match RelayUrl::parse(relay) {
            Ok(parsed) => relay_urls.push(parsed),
            Err(error) => warn!("ignoring invalid delegated control relay {relay}: {error}"),
        }
    }
    dedupe_relays(relay_urls)
        .into_iter()
        .map(|relay| relay.to_string())
        .collect()
}

fn parse_control_relays(relays: &[String]) -> Vec<RelayUrl> {
    relays
        .iter()
        .filter_map(|relay| match RelayUrl::parse(relay) {
            Ok(parsed) => Some(parsed),
            Err(error) => {
                warn!("ignoring invalid delegation control relay {relay}: {error}");
                None
            }
        })
        .collect()
}

fn prune_seen_control_events(
    seen_control_event_ids: &mut std::collections::HashMap<String, String>,
    now: chrono::DateTime<Utc>,
) {
    seen_control_event_ids.retain(|_, seen_at| {
        chrono::DateTime::parse_from_rfc3339(seen_at)
            .map(|parsed| {
                now.signed_duration_since(parsed.with_timezone(&Utc))
                    .num_seconds()
                    < CONTROL_DM_DEDUPE_RETENTION_SECS
            })
            .unwrap_or(false)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration as ChronoDuration;
    use serde_json::json;
    use std::collections::HashMap;

    fn sample_request() -> BlindBallotRequest {
        BlindBallotRequest {
            message_type: "blind_ballot_request".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            request_id: "request_worker_definition".to_string(),
            invited_npub: "npub1invitee000000000000000000000000000000000000000000000000"
                .to_string(),
            blinded_message: "abcd".to_string(),
            token_commitment: "token_commitment".to_string(),
            blind_signing_key_id: "key_worker_definition".to_string(),
            client_nonce: "nonce_worker_definition".to_string(),
            created_at: now_iso(),
        }
    }

    #[test]
    fn apply_worker_election_config_stores_definition() {
        let definition = json!({
            "schemaVersion": 2,
            "eventType": "questionnaire_definition",
            "questionnaireId": "q_worker_definition",
            "title": "Delegated definition",
            "description": "Sent via worker config",
            "questions": [{
                "id": "q1",
                "prompt": "Question 1",
                "kind": "free_text"
            }]
        });
        let mut election = ElectionRuntimeState::default();
        let snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(3),
            blind_signing_private_key: None,
            definition: Some(definition.clone()),
            sent_at: now_iso(),
        };

        apply_worker_election_config(&mut election, &snapshot);

        assert_eq!(election.expected_invitee_count, Some(3));
        assert_eq!(election.definition, Some(definition));
    }

    #[test]
    fn build_blind_issuance_carries_worker_definition() {
        let definition = json!({
            "schemaVersion": 2,
            "eventType": "questionnaire_definition",
            "questionnaireId": "q_worker_definition",
            "title": "Delegated definition",
            "description": "Sent in blind issuance",
            "questions": [{
                "id": "q1",
                "prompt": "Question 1",
                "kind": "free_text"
            }]
        });
        let request = sample_request();
        let election = ElectionRuntimeState {
            definition: Some(definition.clone()),
            ..ElectionRuntimeState::default()
        };

        let issuance = build_blind_issuance(
            &request,
            &election,
            "blind_signature_worker_definition".to_string(),
            "2026-04-23T00:00:00Z".to_string(),
        );

        assert_eq!(issuance.election_id, request.election_id);
        assert_eq!(issuance.request_id, request.request_id);
        assert_eq!(issuance.invited_npub, request.invited_npub);
        assert_eq!(issuance.token_commitment, request.token_commitment);
        assert_eq!(issuance.blind_signing_key_id, request.blind_signing_key_id);
        assert_eq!(
            issuance.blind_signature,
            "blind_signature_worker_definition"
        );
        assert_eq!(issuance.definition, Some(definition));
        assert_eq!(issuance.issued_at, "2026-04-23T00:00:00Z");
    }

    #[test]
    fn fixed_lookback_timestamp_does_not_depend_on_last_scan_state() {
        let now = Timestamp::now().as_secs();
        let lookback = 600;
        let since = fixed_lookback_timestamp(lookback).as_secs();
        assert!(since <= now);
        assert!(now.saturating_sub(since) <= lookback + 1);
    }

    #[test]
    fn control_dm_lookback_covers_randomized_gift_wrap_timestamps() {
        assert!(DEFAULT_DM_LOOKBACK_SECS >= 7 * 24 * 60 * 60);
        assert!(CONTROL_DM_DEDUPE_RETENTION_SECS as u64 > DEFAULT_DM_LOOKBACK_SECS);
    }

    #[test]
    fn delegated_relay_sanitizer_keeps_discouraged_relays_for_backoff_retries() {
        let relays = sanitize_control_relay_strings(&[
            "wss://relay.nostr.net".to_string(),
            "wss://nos.lol".to_string(),
            "wss://strfry.bitsbytom.com".to_string(),
            "wss://nip17.tomdwyer.uk".to_string(),
            "wss://relay.nostr.band".to_string(),
            "wss://offchain.pub".to_string(),
            "wss://relay.nostr.info".to_string(),
            "wss://relay.nos.social".to_string(),
            "wss://relay.momostr.pink".to_string(),
            "wss://relay.azzamo.net".to_string(),
            "wss://nip17.com".to_string(),
            "wss://relay.layer.systems".to_string(),
            "wss://nostr.bond".to_string(),
            "wss://auth.nostr1.com".to_string(),
            "wss://inbox.nostr.wine".to_string(),
            "wss://nostr-pub.wellorder.net".to_string(),
            "wss://relay.0xchat.com".to_string(),
            "wss://relay.nostr.net/".to_string(),
        ]);

        assert_eq!(
            relays,
            vec![
                "wss://relay.nostr.net".to_string(),
                "wss://nos.lol".to_string(),
                "wss://strfry.bitsbytom.com".to_string(),
                "wss://nip17.tomdwyer.uk".to_string(),
                "wss://relay.nostr.band".to_string(),
                "wss://offchain.pub".to_string(),
                "wss://relay.nostr.info".to_string(),
                "wss://relay.nos.social".to_string(),
                "wss://relay.momostr.pink".to_string(),
                "wss://relay.azzamo.net".to_string(),
                "wss://nip17.com".to_string(),
                "wss://relay.layer.systems".to_string(),
                "wss://nostr.bond".to_string(),
                "wss://auth.nostr1.com".to_string(),
                "wss://inbox.nostr.wine".to_string(),
                "wss://nostr-pub.wellorder.net".to_string(),
                "wss://relay.0xchat.com".to_string()
            ]
        );
    }

    #[test]
    fn discouraged_relay_retry_delay_backs_off_to_cap() {
        assert_eq!(
            discouraged_relay_retry_delay(1),
            Duration::from_secs(DISCOURAGED_RELAY_INITIAL_BACKOFF_SECS)
        );
        assert_eq!(
            discouraged_relay_retry_delay(2),
            Duration::from_secs(DISCOURAGED_RELAY_INITIAL_BACKOFF_SECS * 2)
        );
        assert_eq!(
            discouraged_relay_retry_delay(20),
            Duration::from_secs(DISCOURAGED_RELAY_MAX_BACKOFF_SECS)
        );
    }

    #[test]
    fn prune_seen_control_events_removes_old_entries() {
        let now = Utc::now();
        let mut seen = HashMap::from([
            (
                "recent".to_string(),
                (now - ChronoDuration::hours(1)).to_rfc3339(),
            ),
            (
                "stale".to_string(),
                (now - ChronoDuration::days(30)).to_rfc3339(),
            ),
            ("invalid".to_string(), "not-a-timestamp".to_string()),
        ]);

        prune_seen_control_events(&mut seen, now);

        assert!(seen.contains_key("recent"));
        assert!(!seen.contains_key("stale"));
        assert!(!seen.contains_key("invalid"));
    }
}

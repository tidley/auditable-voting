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
    IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY, IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION,
    OPTIONA_WORKER_DELEGATION_KIND, OPTIONA_WORKER_DELEGATION_REVOCATION_KIND,
};
use crate::store::WorkerStore;
use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use blind_rsa_signatures::SecretKeySha384PSSDeterministic;
use crypto_bigint::BoxedUint;
use nostr_sdk::prelude::*;
use rsa::RsaPrivateKey;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::sleep;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const DEFAULT_DM_LOOKBACK_SECS: u64 = 12 * 60 * 60;
const DEFAULT_PUBLIC_LOOKBACK_SECS: u64 = 12 * 60 * 60;

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

#[derive(Clone)]
struct WorkerRuntime {
    config: WorkerConfig,
    client: Client,
    worker_pubkey: PublicKey,
    worker_npub: String,
    coordinator_pubkey: PublicKey,
    store: Arc<WorkerStore>,
    state: Arc<Mutex<WorkerPersistentState>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .init();

    let config = WorkerConfig::from_env()?;
    let keys = Keys::parse(&config.worker_nsec)
        .context("WORKER_NSEC is not a valid nsec")?;
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
        client.add_relay(relay.clone()).await
            .with_context(|| format!("unable to add relay {}", relay))?;
    }
    client.connect().await;

    let store = Arc::new(WorkerStore::open(&config.worker_state_dir)?);
    let mut persistent = store.load()?;
    persistent.worker_npub = worker_npub.clone();
    persistent.coordinator_npub = config.coordinator_npub.clone();
    persistent.relays = config.worker_relays.iter().map(ToString::to_string).collect();
    store.save(&persistent)?;

    let runtime = WorkerRuntime {
        config,
        client,
        worker_pubkey,
        worker_npub: worker_npub.clone(),
        coordinator_pubkey,
        store,
        state: Arc::new(Mutex::new(persistent)),
    };

    info!("worker started as {}", worker_npub);

    let heartbeat_runtime = runtime.clone();
    let heartbeat_task = tokio::spawn(async move {
        loop {
            if let Err(error) = heartbeat_runtime.send_status_heartbeat().await {
                warn!("status heartbeat failed: {error}");
            }
            sleep(Duration::from_secs(heartbeat_runtime.config.heartbeat_seconds)).await;
        }
    });

    let control_runtime = runtime.clone();
    let control_task = tokio::spawn(async move {
        loop {
            if let Err(error) = control_runtime.poll_control_plane().await {
                warn!("control plane poll failed: {error}");
            }
            sleep(Duration::from_secs(control_runtime.config.poll_seconds)).await;
        }
    });

    let public_runtime = runtime.clone();
    let public_task = tokio::spawn(async move {
        loop {
            if let Err(error) = public_runtime.poll_public_plane().await {
                warn!("public plane poll failed: {error}");
            }
            sleep(Duration::from_secs(public_runtime.config.poll_seconds)).await;
        }
    });

    tokio::select! {
        _ = heartbeat_task => {},
        _ = control_task => {},
        _ = public_task => {},
    }

    Ok(())
}

impl WorkerRuntime {
    async fn send_status_heartbeat(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        let mut active: Option<&ElectionRuntimeState> = None;
        for election in state.elections.values() {
            if election.revoked || is_expired(&election.expires_at) {
                continue;
            }
            active = Some(election);
            break;
        }
        let snapshot = WorkerStatusSnapshot {
            message_type: "worker_status".to_string(),
            schema_version: 1,
            worker_npub: self.worker_npub.clone(),
            coordinator_npub: self.config.coordinator_npub.clone(),
            worker_version: env!("CARGO_PKG_VERSION").to_string(),
            state: if active.is_some() { "active".to_string() } else { "online".to_string() },
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
            last_blind_issuance_at: active.and_then(|entry| entry.last_blind_issuance_at.clone()),
            last_vote_verification_at: active.and_then(|entry| entry.last_vote_verification_at.clone()),
            last_decision_publish_at: active.and_then(|entry| entry.last_decision_publish_at.clone()),
            supported_capabilities: vec![
                WorkerCapability::IssueBlindTokens,
                WorkerCapability::VerifyPublicSubmissions,
                WorkerCapability::PublishSubmissionDecisions,
                WorkerCapability::PublishResultSummary,
            ],
            advertised_relays: self.config.worker_relays.iter().map(ToString::to_string).collect(),
        };
        let envelope = WorkerStatusEnvelope {
            message_type: "optiona_worker_status_dm".to_string(),
            schema_version: 1,
            snapshot,
            sent_at: now_iso(),
        };
        let content = serde_json::to_string(&envelope)?;
        let _ = self.client.send_private_msg(self.coordinator_pubkey, content, []).await?;
        state.last_heartbeat_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn poll_control_plane(&self) -> Result<()> {
        let since_ts = {
            let state = self.state.lock().await;
            iso_or_default_to_timestamp(state.last_dm_scan_at.as_deref(), DEFAULT_DM_LOOKBACK_SECS)
        };
        let filter = Filter::new()
            .kind(Kind::GiftWrap)
            .pubkey(self.worker_pubkey)
            .since(since_ts)
            .limit(250);
        let events = self.client.fetch_events(filter, Duration::from_secs(8)).await?;
        for event in events {
            let Ok(unwrapped) = self.client.unwrap_gift_wrap(&event).await else {
                continue;
            };
            let rumor_content = unwrapped.rumor.content;
            if rumor_content.trim().is_empty() {
                continue;
            }
            self.process_control_message(&rumor_content).await?;
        }
        let mut state = self.state.lock().await;
        state.last_dm_scan_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn process_control_message(&self, content: &str) -> Result<()> {
        let value: serde_json::Value = match serde_json::from_str(content) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(()),
        };
        let message_type = value.get("type").and_then(|entry| entry.as_str()).unwrap_or_default();
        match message_type {
            "optiona_worker_delegation_dm" => {
                let envelope: WorkerDelegationEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(()),
                };
                self.apply_delegation(envelope.delegation).await?;
            }
            "optiona_worker_delegation_revocation_dm" => {
                let envelope: WorkerRevocationEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(()),
                };
                self.apply_revocation(envelope.revocation).await?;
            }
            "optiona_worker_election_config_dm" => {
                let envelope: WorkerElectionConfigEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(()),
                };
                self.apply_election_config(envelope.snapshot).await?;
            }
            "optiona_blind_request_dm" => {
                let envelope: BlindBallotRequestEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(()),
                };
                self.handle_blind_request(envelope.request).await?;
            }
            _ => {}
        }
        Ok(())
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
        let since_ts = {
            let state = self.state.lock().await;
            iso_or_default_to_timestamp(state.last_public_scan_at.as_deref(), DEFAULT_PUBLIC_LOOKBACK_SECS)
        };
        let filter = Filter::new()
            .author(self.coordinator_pubkey)
            .kinds(vec![
                Kind::Custom(OPTIONA_WORKER_DELEGATION_KIND),
                Kind::Custom(OPTIONA_WORKER_DELEGATION_REVOCATION_KIND),
            ])
            .since(since_ts)
            .limit(300);
        let events = self.client.fetch_events(filter, Duration::from_secs(8)).await?;
        for event in events {
            match event.kind {
                Kind::Custom(kind) if kind == OPTIONA_WORKER_DELEGATION_KIND => {
                    if let Ok(delegation) = serde_json::from_str::<WorkerDelegationCertificate>(&event.content) {
                        self.apply_delegation(delegation).await?;
                    }
                }
                Kind::Custom(kind) if kind == OPTIONA_WORKER_DELEGATION_REVOCATION_KIND => {
                    if let Ok(revocation) = serde_json::from_str::<WorkerDelegationRevocation>(&event.content) {
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
                    entry.capabilities.contains(&WorkerCapability::VerifyPublicSubmissions)
                        || entry.capabilities.contains(&WorkerCapability::PublishSubmissionDecisions)
                        || entry.capabilities.contains(&WorkerCapability::PublishResultSummary)
                })
                .map(|entry| entry.election_id.clone())
                .collect::<Vec<_>>()
        };
        if elections_to_process.is_empty() {
            return Ok(());
        }

        let since_ts = {
            let state = self.state.lock().await;
            iso_or_default_to_timestamp(state.last_public_scan_at.as_deref(), DEFAULT_PUBLIC_LOOKBACK_SECS)
        };
        let filter = Filter::new()
            .kind(Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND))
            .since(since_ts)
            .limit(500);
        let events = self.client.fetch_events(filter, Duration::from_secs(8)).await?;

        for event in events {
            let submission = match serde_json::from_str::<QuestionnaireBlindResponseEvent>(&event.content) {
                Ok(parsed) => parsed,
                Err(_) => continue,
            };
            if !elections_to_process.contains(&submission.questionnaire_id) {
                continue;
            }
            self.handle_submission(submission).await?;
        }
        Ok(())
    }

    async fn handle_submission(&self, submission: QuestionnaireBlindResponseEvent) -> Result<()> {
        let mut state = self.state.lock().await;
        let Some(election) = state.elections.get_mut(&submission.questionnaire_id) else {
            return Ok(());
        };
        if election.processed_submission_ids.contains(&submission.response_id) {
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
        } else if election.accepted_nullifiers.contains(&submission.token_nullifier) {
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

        if election.capabilities.contains(&WorkerCapability::PublishSubmissionDecisions) {
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

        let should_publish_summary = election.capabilities.contains(&WorkerCapability::PublishResultSummary)
            && !election.summary_published
            && election.expected_invitee_count.unwrap_or(0) > 0
            && (election.accepted_response_authors.len() as u64) >= election.expected_invitee_count.unwrap_or(0);
        if should_publish_summary {
            let summary_event_id = self
                .publish_result_summary(
                    &submission.questionnaire_id,
                    election.accepted_response_count,
                    election.rejected_response_count,
                )
                .await?;
            election.summary_published = true;
            election.last_result_summary_publish_at = Some(now_iso());
            info!(
                "published questionnaire result summary for election {} event_id={}",
                submission.questionnaire_id, summary_event_id
            );
        }

        self.store.save(&state)?;
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
            vec!["t".to_string(), "questionnaire_submission_decision".to_string()],
            vec!["questionnaire".to_string(), decision.questionnaire_id.clone()],
            vec!["schema".to_string(), "1".to_string()],
            vec!["etype".to_string(), "questionnaire_submission_decision".to_string()],
            vec!["submission-id".to_string(), decision.submission_id.clone()],
            vec!["nullifier".to_string(), decision.token_nullifier.clone()],
            vec!["accepted".to_string(), if decision.accepted { "1".to_string() } else { "0".to_string() }],
            vec!["reason".to_string(), decision.reason.clone()],
            vec!["coordinator".to_string(), decision.coordinator_pubkey.clone()],
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
        let mut builder =
            EventBuilder::new(Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY), content);
        let tags = vec![
            vec!["t".to_string(), "questionnaire_result_summary".to_string()],
            vec!["questionnaire-id".to_string(), election_id.to_string()],
            vec!["worker".to_string(), self.worker_npub.clone()],
            vec!["coordinator".to_string(), self.config.coordinator_npub.clone()],
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
        election.expected_invitee_count = snapshot.expected_invitee_count;
        if snapshot.blind_signing_private_key.is_some() {
            election.blind_signing_private_key = snapshot.blind_signing_private_key;
        }
        self.store.save(&state)?;
        Ok(())
    }

    async fn handle_blind_request(&self, request: BlindBallotRequest) -> Result<()> {
        let mut state = self.state.lock().await;
        let Some(election) = state.elections.get_mut(&request.election_id) else {
            return Ok(());
        };
        if election.revoked || is_expired(&election.expires_at) {
            return Ok(());
        }
        if !election.capabilities.contains(&WorkerCapability::IssueBlindTokens) {
            return Ok(());
        }
        if election.seen_blind_request_ids.contains(&request.request_id) {
            return Ok(());
        }
        let Some(private_key) = election.blind_signing_private_key.clone() else {
            warn!(
                "blind request ignored for election {} because no blind signing key is configured",
                request.election_id
            );
            return Ok(());
        };
        if private_key.key_id != request.blind_signing_key_id {
            warn!(
                "blind request ignored for election {} due to key-id mismatch request={} worker={}",
                request.election_id, request.blind_signing_key_id, private_key.key_id
            );
            return Ok(());
        }
        let blind_signature = sign_blinded_message(&request.blinded_message, &private_key.private_jwk)?;
        let issuance = BlindBallotIssuance {
            message_type: "blind_ballot_response".to_string(),
            schema_version: 1,
            election_id: request.election_id.clone(),
            request_id: request.request_id.clone(),
            issuance_id: format!("issuance_{}", random_suffix()),
            invited_npub: request.invited_npub.clone(),
            token_commitment: request.token_commitment.clone(),
            blind_signing_key_id: request.blind_signing_key_id.clone(),
            blind_signature,
            definition: None,
            issued_at: now_iso(),
        };
        let envelope = BlindBallotIssuanceEnvelope {
            message_type: "optiona_blind_issuance_dm".to_string(),
            schema_version: 1,
            issuance,
            sent_at: now_iso(),
        };
        let content = serde_json::to_string(&envelope)?;
        let recipient = PublicKey::from_bech32(&request.invited_npub)
            .context("invalid invited npub on blind request")?;
        let _ = self.client.send_private_msg(recipient, content, []).await?;
        election.seen_blind_request_ids.insert(request.request_id);
        election.last_blind_issuance_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
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
        existing.control_relays = delegation.control_relays.clone();
        existing.revoked = false;
        existing.expires_at = delegation.expires_at.clone();
        if delegation_changed {
            existing.seen_blind_request_ids.clear();
            existing.accepted_response_authors.clear();
            existing.accepted_response_count = 0;
            existing.rejected_response_count = 0;
            existing.expected_invitee_count = None;
            existing.blind_signing_private_key = None;
            existing.summary_published = false;
            existing.last_result_summary_publish_at = None;
        }
        self.store.save(&state)?;
        Ok(())
    }

    async fn apply_revocation(&self, revocation: WorkerDelegationRevocation) -> Result<()> {
        if revocation.message_type != "worker_delegation_revocation" || revocation.schema_version != 1 {
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

fn iso_or_default_to_timestamp(input: Option<&str>, fallback_lookback_secs: u64) -> Timestamp {
    if let Some(value) = input {
        if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(value) {
            let unix = parsed.timestamp();
            if unix > 0 {
                return Timestamp::from(unix as u64);
            }
        }
    }
    let now = Timestamp::now().as_secs();
    Timestamp::from(now.saturating_sub(fallback_lookback_secs))
}

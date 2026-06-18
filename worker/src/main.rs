mod config;
mod model;
mod store;

use crate::config::WorkerConfig;
use crate::model::{
    is_expired, now_iso, BearerInviteCodeEntry, BlindBallotIssuance,
    BlindBallotIssuanceBundleEnvelope, BlindBallotIssuanceEnvelope, BlindBallotRequest,
    BlindBallotRequestBundleEnvelope, BlindBallotRequestEnvelope, CompressedBundleEnvelope,
    ElectionRuntimeState, QuestionnaireBlindResponseEvent, QuestionnaireSubmissionDecisionEvent,
    WorkerCapability, WorkerDelegationCertificate, WorkerDelegationEnvelope,
    WorkerDelegationRevocation, WorkerElectionConfigEnvelope, WorkerElectionConfigSnapshot,
    WorkerPersistentState, WorkerRevocationEnvelope, WorkerStatusEnvelope, WorkerStatusSnapshot,
    IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION, IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND,
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
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use nostr_sdk::prelude::*;
use rsa::RsaPrivateKey;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::{interval, sleep, timeout};
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

const WORKER_DEFAULT_LOG_FILTER: &str = "info";
const WORKER_DEPENDENCY_LOG_OVERRIDES: &[&str] = &[
    "nostr_relay_pool=info",
    "nostr_sdk=info",
    "nostr=info",
    "tungstenite=info",
    "tokio_tungstenite=info",
];
const DEFAULT_DM_LOOKBACK_SECS: u64 = 7 * 24 * 60 * 60;
const DEFAULT_PUBLIC_LOOKBACK_SECS: u64 = 12 * 60 * 60;
const CONTROL_DM_DEDUPE_RETENTION_SECS: i64 = 14 * 24 * 60 * 60;
const PRIVATE_DM_SEND_TIMEOUT_SECS: u64 = 12;
const COMPLETION_CLOSE_GRACE_SECS: u64 = 5;
const COMPRESSED_BUNDLE_MESSAGE_TYPE: &str = "optiona_compressed_bundle_dm";
const COMPRESSED_BUNDLE_ENCODING: &str = "gzip+base64url";
const BUNDLE_COMPRESSION_THRESHOLD_BYTES: usize = 8 * 1024;
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

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(entry) => {
            if *entry {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(entry) => {
            serde_json::to_string(entry).unwrap_or_else(|_| "\"\"".to_string())
        }
        serde_json::Value::Array(entries) => format!(
            "[{}]",
            entries
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(entries) => {
            let mut keys = entries.keys().collect::<Vec<_>>();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .filter_map(|key| {
                        Some(format!(
                            "{}:{}",
                            serde_json::to_string(key).ok()?,
                            canonical_json(entries.get(key)?)
                        ))
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn sha256_hex(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn questionnaire_definition_hash(definition: &serde_json::Value) -> String {
    sha256_hex(&canonical_json(definition))
}

fn compressible_bundle_message_type(message_type: &str) -> bool {
    matches!(
        message_type,
        "optiona_blind_request_bundle_dm" | "optiona_blind_issuance_bundle_dm"
    )
}

fn maybe_compress_bundle_content(
    content: String,
    message_type: &str,
    sent_at: &str,
) -> Result<String> {
    if !compressible_bundle_message_type(message_type)
        || content.as_bytes().len() < BUNDLE_COMPRESSION_THRESHOLD_BYTES
    {
        return Ok(content);
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(content.as_bytes())?;
    let compressed = encoder.finish()?;
    let wrapper = serde_json::json!({
        "type": COMPRESSED_BUNDLE_MESSAGE_TYPE,
        "schemaVersion": 1,
        "encoding": COMPRESSED_BUNDLE_ENCODING,
        "innerType": message_type,
        "payload": URL_SAFE_NO_PAD.encode(&compressed),
        "originalLength": content.as_bytes().len(),
        "compressedLength": compressed.len(),
        "sentAt": sent_at,
    });
    let wrapped = serde_json::to_string(&wrapper)?;
    if wrapped.as_bytes().len() < content.as_bytes().len() {
        Ok(wrapped)
    } else {
        Ok(content)
    }
}

fn unwrap_compressed_bundle_value(value: serde_json::Value) -> Result<serde_json::Value> {
    if value.get("type").and_then(|entry| entry.as_str()) != Some(COMPRESSED_BUNDLE_MESSAGE_TYPE) {
        return Ok(value);
    }
    let envelope: CompressedBundleEnvelope =
        serde_json::from_value(value).context("invalid compressed bundle envelope")?;
    if envelope.schema_version != 1
        || envelope.encoding != COMPRESSED_BUNDLE_ENCODING
        || !compressible_bundle_message_type(&envelope.inner_type)
    {
        anyhow::bail!("unsupported compressed bundle envelope");
    }
    let compressed = URL_SAFE_NO_PAD
        .decode(envelope.payload.as_bytes())
        .context("invalid compressed bundle payload")?;
    if compressed.len() != envelope.compressed_length {
        anyhow::bail!("compressed bundle length mismatch");
    }
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut content = String::new();
    decoder
        .read_to_string(&mut content)
        .context("invalid compressed bundle gzip payload")?;
    if content.as_bytes().len() != envelope.original_length {
        anyhow::bail!("compressed bundle length mismatch");
    }
    let inner: serde_json::Value =
        serde_json::from_str(&content).context("invalid compressed bundle JSON payload")?;
    let inner_type = inner
        .get("type")
        .and_then(|entry| entry.as_str())
        .unwrap_or_default();
    if inner_type != envelope.inner_type {
        anyhow::bail!("compressed bundle inner type mismatch");
    }
    Ok(inner)
}

fn random_suffix() -> String {
    format!(
        "{}{:08x}",
        Timestamp::now().as_secs(),
        rand::random::<u32>()
    )
}

fn short_ascii(value: &str) -> String {
    if value.len() <= 24 {
        return value.to_string();
    }
    format!(
        "{}..{}",
        &value[..12],
        &value[value.len().saturating_sub(6)..]
    )
}

fn compact_preview(value: &str, max_chars: usize) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = compact.chars().take(max_chars).collect::<String>();
    if compact.chars().count() > max_chars {
        preview.push_str("...");
    }
    preview
}

fn rumor_message_type(content: &str) -> String {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|value| {
            if value.get("type").and_then(|entry| entry.as_str())
                == Some(COMPRESSED_BUNDLE_MESSAGE_TYPE)
            {
                return value
                    .get("innerType")
                    .and_then(|entry| entry.as_str())
                    .map(str::to_string);
            }
            value
                .get("type")
                .and_then(|entry| entry.as_str())
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "kind14_dm".to_string())
}

fn log_decrypted_worker_dm(event: &Event, rumor: &UnsignedEvent) {
    let message_type = rumor_message_type(&rumor.content);
    let sender_npub = rumor
        .pubkey
        .to_bech32()
        .unwrap_or_else(|_| rumor.pubkey.to_string());
    let recipient_tag_count = rumor
        .tags
        .iter()
        .filter(|tag| tag.kind().to_string() == "p")
        .count();
    let subject = rumor
        .tags
        .iter()
        .find(|tag| tag.kind().to_string() == "subject")
        .and_then(|tag| tag.content())
        .unwrap_or("");
    let preview = if message_type == "kind14_dm" {
        compact_preview(&rumor.content, 96)
    } else {
        String::new()
    };
    debug!(
        "decrypted worker DM received: event_id={}, rumor_kind={}, sender={}, type={}, recipients={}, subject={}, chars={}, preview={}",
        short_ascii(&event.id.to_string()),
        rumor.kind.as_u16(),
        short_ascii(&sender_npub),
        message_type,
        recipient_tag_count,
        compact_preview(subject, 48),
        rumor.content.chars().count(),
        preview
    );
}

fn build_worker_log_filter() -> EnvFilter {
    let mut filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(WORKER_DEFAULT_LOG_FILTER));
    for directive in WORKER_DEPENDENCY_LOG_OVERRIDES {
        filter = filter.add_directive(
            directive
                .parse()
                .expect("worker dependency log directive should be valid"),
        );
    }
    filter
}

fn apply_worker_election_config(
    election: &mut ElectionRuntimeState,
    snapshot: &WorkerElectionConfigSnapshot,
) -> bool {
    if is_stale_worker_election_config(election, snapshot)
        || is_empty_worker_election_config_without_eligibility(election, snapshot)
        || worker_election_config_has_blind_key_mismatch(snapshot)
    {
        return false;
    }
    if election.election_id.is_empty() {
        election.election_id = snapshot.election_id.clone();
    }
    let previous_expected_invitee_count = election.expected_invitee_count;
    election.expected_invitee_count = snapshot.expected_invitee_count;
    election.last_election_config_sent_at = Some(snapshot.sent_at.clone());
    if snapshot.whitelist_npubs.is_some()
        || snapshot.bearer_invite_codes.is_some()
        || snapshot.eligibility_required.is_some()
    {
        election.eligibility_configured = true;
        election.eligibility_required = snapshot.eligibility_required.unwrap_or(true);
    }
    if let Some(whitelist_npubs) = &snapshot.whitelist_npubs {
        election.whitelist_npubs = whitelist_npubs
            .iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
    }
    if let Some(codes) = &snapshot.bearer_invite_codes {
        merge_bearer_invite_codes(election, codes);
    }
    if snapshot.blind_signing_private_key.is_some() {
        election.blind_signing_private_key = snapshot.blind_signing_private_key.clone();
    }
    if let Some(reference) = &snapshot.definition_reference {
        if let Some(hash) = reference
            .definition_hash
            .as_ref()
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
        {
            election.definition_hash = Some(hash.to_string());
        }
        if let Some(event_id) = reference
            .definition_event_id
            .as_ref()
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
        {
            election.definition_event_id = Some(event_id.to_string());
        }
        if let Some(relays) = &reference.relays {
            election.definition_relays = relays
                .iter()
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect();
        }
    }
    if snapshot.definition.is_some() {
        election.definition = snapshot.definition.clone();
        if let Some(definition) = &election.definition {
            election.definition_hash = Some(questionnaire_definition_hash(definition));
        }
    }
    if completion_was_reopened_by_expected_count_change(
        previous_expected_invitee_count,
        election.expected_invitee_count,
        election.accepted_response_count,
    ) {
        election.summary_published = false;
        election.last_result_summary_publish_at = None;
        election.questionnaire_close_published = false;
        election.last_questionnaire_close_publish_at = None;
    }
    true
}

fn definition_value_blind_signing_key_id(definition: &serde_json::Value) -> Option<String> {
    definition
        .get("blindSigningPublicKey")?
        .get("keyId")?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn definition_blind_signing_key_id(definition: &Option<serde_json::Value>) -> Option<String> {
    definition
        .as_ref()
        .and_then(definition_value_blind_signing_key_id)
}

fn public_definition_matches_worker_private_key(
    definition: &serde_json::Value,
    election: &ElectionRuntimeState,
) -> bool {
    let Some(private_key) = election.blind_signing_private_key.as_ref() else {
        return false;
    };
    definition_value_blind_signing_key_id(definition).as_deref()
        == Some(private_key.key_id.as_str())
}

fn worker_election_config_has_blind_key_mismatch(snapshot: &WorkerElectionConfigSnapshot) -> bool {
    let Some(private_key) = snapshot.blind_signing_private_key.as_ref() else {
        return false;
    };
    let Some(definition_key_id) = definition_blind_signing_key_id(&snapshot.definition) else {
        return false;
    };
    private_key.key_id != definition_key_id
}

fn completion_was_reopened_by_expected_count_change(
    previous_expected: Option<u64>,
    next_expected: Option<u64>,
    accepted_count: u64,
) -> bool {
    match (previous_expected, next_expected) {
        (Some(previous), Some(next)) => next > previous && accepted_count < next,
        (None, Some(next)) => accepted_count < next,
        _ => false,
    }
}

fn normalize_invite_code_hash(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

fn merge_bearer_invite_codes(election: &mut ElectionRuntimeState, codes: &[BearerInviteCodeEntry]) {
    for incoming in codes {
        let Some(code_hash) = normalize_invite_code_hash(&incoming.code_hash) else {
            continue;
        };
        if incoming.election_id != election.election_id {
            continue;
        }
        let existing = election.bearer_invite_codes.get(&code_hash).cloned();
        let next = match (existing, incoming.state.as_str()) {
            (Some(existing), _) if existing.state == "redeemed" => existing,
            (_, "available" | "redeemed" | "revoked") => BearerInviteCodeEntry {
                code_hash: code_hash.clone(),
                ..incoming.clone()
            },
            _ => continue,
        };
        election.bearer_invite_codes.insert(code_hash, next);
    }
}

fn has_effective_eligibility_config(election: &ElectionRuntimeState) -> bool {
    election.eligibility_configured
        || election.eligibility_required
        || !election.whitelist_npubs.is_empty()
        || !election.bearer_invite_codes.is_empty()
}

fn definition_uses_per_question_credentials(definition: &serde_json::Value) -> bool {
    definition
        .get("ballotCredentialMode")
        .and_then(|entry| entry.as_str())
        == Some("per_question")
}

fn election_needs_legacy_control_replay(election: &ElectionRuntimeState) -> bool {
    if election.revoked || is_expired(&election.expires_at) {
        return false;
    }
    let has_config_without_eligibility = election.blind_signing_private_key.is_some()
        && election.definition.is_some()
        && !has_effective_eligibility_config(election);
    let has_scoped_requests_without_scope_records = election
        .definition
        .as_ref()
        .is_some_and(definition_uses_per_question_credentials)
        && !election.seen_blind_request_ids.is_empty()
        && election.issued_invited_scope_keys.is_empty();
    has_config_without_eligibility || has_scoped_requests_without_scope_records
}

fn election_has_public_submission_capability(election: &ElectionRuntimeState) -> bool {
    election
        .capabilities
        .contains(&WorkerCapability::VerifyPublicSubmissions)
        || election
            .capabilities
            .contains(&WorkerCapability::PublishSubmissionDecisions)
        || election
            .capabilities
            .contains(&WorkerCapability::CloseQuestionnaire)
        || election
            .capabilities
            .contains(&WorkerCapability::PublishResultSummary)
}

fn known_expected_invitee_count(election: &ElectionRuntimeState) -> Option<u64> {
    election.expected_invitee_count.filter(|count| *count > 0)
}

fn election_should_scan_public_submissions(election: &ElectionRuntimeState) -> bool {
    if election.revoked
        || is_expired(&election.expires_at)
        || !election_has_public_submission_capability(election)
        || election.definition.is_none()
    {
        return false;
    }
    known_expected_invitee_count(election)
        .is_some_and(|expected| election.accepted_response_count < expected)
}

fn election_has_pending_completion_work(election: &ElectionRuntimeState) -> bool {
    let Some(expected) = known_expected_invitee_count(election) else {
        return false;
    };
    if expected == 0
        || election.accepted_response_count < expected
        || !election.deferred_blind_request_ids.is_empty()
    {
        return false;
    }
    let publish_summary = election
        .capabilities
        .contains(&WorkerCapability::PublishResultSummary)
        && !election.summary_published;
    let close_questionnaire = election
        .capabilities
        .contains(&WorkerCapability::CloseQuestionnaire)
        && !election.questionnaire_close_published;
    publish_summary || close_questionnaire
}

fn election_has_pending_ballot_or_response_work(election: &ElectionRuntimeState) -> bool {
    let Some(expected) = known_expected_invitee_count(election) else {
        return false;
    };
    expected > 0
        && (election.accepted_response_count < expected
            || !election.deferred_blind_request_ids.is_empty())
        && election.definition.is_some()
        && election.blind_signing_private_key.is_some()
        && election
            .capabilities
            .contains(&WorkerCapability::IssueBlindTokens)
}

fn election_has_pending_worker_activity(election: &ElectionRuntimeState) -> bool {
    if election.revoked || is_expired(&election.expires_at) {
        return false;
    }
    election_should_scan_public_submissions(election)
        || election_has_pending_completion_work(election)
        || election_has_pending_ballot_or_response_work(election)
        || !election.deferred_blind_request_ids.is_empty()
}

#[cfg(test)]
fn worker_state_should_terminate_after_completion(state: &WorkerPersistentState) -> bool {
    fn is_complete_for_exit(election: &ElectionRuntimeState) -> bool {
        let Some(expected) = known_expected_invitee_count(election) else {
            return false;
        };
        if election.accepted_response_count < expected
            || !election.deferred_blind_request_ids.is_empty()
        {
            return false;
        }
        if election
            .capabilities
            .contains(&WorkerCapability::PublishResultSummary)
            && !election.summary_published
        {
            return false;
        }
        if election
            .capabilities
            .contains(&WorkerCapability::CloseQuestionnaire)
            && !election.questionnaire_close_published
        {
            return false;
        }
        true
    }

    let mut active_count = 0usize;

    for election in state.elections.values() {
        if election.revoked || is_expired(&election.expires_at) {
            continue;
        }
        active_count = active_count.saturating_add(1);
        if !is_complete_for_exit(election) {
            return false;
        }
    }

    active_count > 0
}

fn election_activity_timestamp_millis(election: &ElectionRuntimeState) -> i64 {
    [
        election.last_election_config_sent_at.as_deref(),
        election.last_blind_issuance_at.as_deref(),
        election.last_vote_verification_at.as_deref(),
        election.last_decision_publish_at.as_deref(),
        election.last_result_summary_publish_at.as_deref(),
        election.last_questionnaire_close_publish_at.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter_map(parsed_rfc3339_millis)
    .max()
    .unwrap_or_default()
}

fn election_config_timestamp_millis(election: &ElectionRuntimeState) -> i64 {
    election
        .last_election_config_sent_at
        .as_deref()
        .and_then(parsed_rfc3339_millis)
        .unwrap_or_else(|| election_activity_timestamp_millis(election))
}

fn select_status_active_election(state: &WorkerPersistentState) -> Option<&ElectionRuntimeState> {
    state
        .elections
        .values()
        .filter(|entry| election_has_pending_worker_activity(entry))
        .max_by_key(|entry| {
            (
                election_config_timestamp_millis(entry),
                election_activity_timestamp_millis(entry),
            )
        })
}

#[cfg(test)]
fn select_public_submission_election_ids(state: &WorkerPersistentState) -> Vec<String> {
    let mut selected: Vec<&ElectionRuntimeState> = state
        .elections
        .values()
        .filter(|entry| election_should_scan_public_submissions(entry))
        .collect();
    if selected.is_empty() {
        return Vec::new();
    }
    selected.sort_by(|left, right| {
        let left_ts = election_config_timestamp_millis(left);
        let right_ts = election_config_timestamp_millis(right);
        right_ts
            .cmp(&left_ts)
            .then_with(|| right.election_id.cmp(&left.election_id))
    });
    selected
        .into_iter()
        .map(|entry| entry.election_id.clone())
        .collect()
}

fn parsed_rfc3339_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn is_stale_delegation_replay(
    current: Option<&WorkerDelegationCertificate>,
    incoming: &WorkerDelegationCertificate,
) -> bool {
    let Some(current) = current else {
        return false;
    };
    if current.delegation_id == incoming.delegation_id {
        return false;
    }
    match (
        parsed_rfc3339_millis(&current.issued_at),
        parsed_rfc3339_millis(&incoming.issued_at),
    ) {
        (Some(current_issued_at), Some(incoming_issued_at)) => {
            incoming_issued_at < current_issued_at
        }
        _ => false,
    }
}

fn is_stale_worker_election_config(
    election: &ElectionRuntimeState,
    snapshot: &WorkerElectionConfigSnapshot,
) -> bool {
    let Some(current_sent_at) = election.last_election_config_sent_at.as_deref() else {
        return false;
    };
    match (
        parsed_rfc3339_millis(current_sent_at),
        parsed_rfc3339_millis(&snapshot.sent_at),
    ) {
        (Some(current_sent_at), Some(incoming_sent_at)) => incoming_sent_at < current_sent_at,
        _ => false,
    }
}

fn is_empty_worker_election_config_without_eligibility(
    election: &ElectionRuntimeState,
    snapshot: &WorkerElectionConfigSnapshot,
) -> bool {
    if snapshot.expected_invitee_count != Some(0) {
        return false;
    }
    let requires_eligibility = snapshot.eligibility_required == Some(true)
        || election
            .capabilities
            .contains(&WorkerCapability::IssueBlindTokens);
    if !requires_eligibility {
        return false;
    }
    let incoming_whitelist_count = snapshot
        .whitelist_npubs
        .as_ref()
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| !entry.trim().is_empty())
                .count()
        })
        .unwrap_or(0);
    let incoming_active_invite_code_count = snapshot
        .bearer_invite_codes
        .as_ref()
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| entry.state != "revoked")
                .count()
        })
        .unwrap_or(0);
    incoming_whitelist_count == 0 && incoming_active_invite_code_count == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlindRequestAuthorization {
    Authorized { state_changed: bool },
    Deferred,
    Rejected,
}

enum PreparedBlindIssuance {
    Deferred,
    Handled,
    Issuance {
        request: BlindBallotRequest,
        issuance: BlindBallotIssuance,
    },
}

fn authorize_blind_request(
    election: &mut ElectionRuntimeState,
    request: &BlindBallotRequest,
) -> BlindRequestAuthorization {
    if election.whitelist_npubs.contains(&request.invited_npub) {
        return BlindRequestAuthorization::Authorized {
            state_changed: false,
        };
    }

    let invite_code_hash = request
        .invite_code_hash
        .as_deref()
        .and_then(normalize_invite_code_hash);
    if let Some(code_hash) = invite_code_hash {
        let Some(entry) = election.bearer_invite_codes.get_mut(&code_hash) else {
            return BlindRequestAuthorization::Deferred;
        };
        match entry.state.as_str() {
            "available" => {
                let redeemed_at = now_iso();
                entry.state = "redeemed".to_string();
                entry.redeemed_at = Some(redeemed_at);
                entry.redeemed_npub = Some(request.invited_npub.clone());
                election
                    .whitelist_npubs
                    .insert(request.invited_npub.clone());
                return BlindRequestAuthorization::Authorized {
                    state_changed: true,
                };
            }
            "redeemed" if entry.redeemed_npub.as_deref() == Some(request.invited_npub.as_str()) => {
                let inserted = election
                    .whitelist_npubs
                    .insert(request.invited_npub.clone());
                return BlindRequestAuthorization::Authorized {
                    state_changed: inserted,
                };
            }
            _ => return BlindRequestAuthorization::Rejected,
        }
    }

    if election.eligibility_required {
        BlindRequestAuthorization::Deferred
    } else {
        BlindRequestAuthorization::Authorized {
            state_changed: false,
        }
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
        definition_hash: election.definition_hash.clone().or_else(|| {
            election
                .definition
                .as_ref()
                .map(questionnaire_definition_hash)
        }),
        definition_event_id: election.definition_event_id.clone(),
        ballot_scope: request.ballot_scope.clone(),
        definition: None,
        issued_at,
    }
}

fn build_blind_issuance_bundle_envelope(
    issuances: &[BlindBallotIssuance],
) -> BlindBallotIssuanceBundleEnvelope {
    let definition_hash = issuances
        .iter()
        .find_map(|issuance| issuance.definition_hash.clone());
    let definition_event_id = issuances
        .iter()
        .find_map(|issuance| issuance.definition_event_id.clone());
    BlindBallotIssuanceBundleEnvelope {
        message_type: "optiona_blind_issuance_bundle_dm".to_string(),
        schema_version: 1,
        definition_hash,
        definition_event_id,
        definition: None,
        issuances: issuances.to_vec(),
        sent_at: now_iso(),
    }
}

fn ballot_scope_text_field(scope: &serde_json::Value, key: &str) -> String {
    scope
        .get(key)
        .and_then(|entry| entry.as_str())
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn ballot_scope_positive_integer_field(scope: &serde_json::Value, key: &str) -> u64 {
    match scope.get(key) {
        Some(serde_json::Value::Number(number)) => number.as_u64().unwrap_or(0).max(1),
        _ => 0,
    }
}

fn ballot_scope_key(scope: &Option<serde_json::Value>) -> String {
    let Some(scope) = scope else {
        return "__questionnaire__".to_string();
    };
    let question_id = ballot_scope_text_field(scope, "questionId");
    let slot_id = ballot_scope_text_field(scope, "slotId");
    let version = ballot_scope_positive_integer_field(scope, "version");
    let slot_index = ballot_scope_positive_integer_field(scope, "slotIndex");
    if question_id.is_empty() && slot_id.is_empty() && version == 0 && slot_index == 0 {
        return "__questionnaire__".to_string();
    }
    if slot_index > 0 {
        return format!(
            "slot:{}:v{}",
            slot_index,
            if version == 0 { 1 } else { version }
        );
    }
    format!(
        "{}:{}:{}:v{}",
        if question_id.is_empty() {
            &slot_id
        } else {
            &question_id
        },
        slot_id,
        slot_index,
        if version == 0 { 1 } else { version }
    )
}

fn blind_request_issuance_scope_key(request: &BlindBallotRequest) -> String {
    format!(
        "{}|{}",
        request.invited_npub,
        ballot_scope_key(&request.ballot_scope)
    )
}

fn blind_request_uses_questionnaire_scope(request: &BlindBallotRequest) -> bool {
    ballot_scope_key(&request.ballot_scope) == "__questionnaire__"
}

fn has_existing_issuance_for_request(
    election: &ElectionRuntimeState,
    request: &BlindBallotRequest,
) -> bool {
    if election
        .issued_invited_scope_keys
        .contains(&blind_request_issuance_scope_key(request))
    {
        return true;
    }
    blind_request_uses_questionnaire_scope(request)
        && election
            .issued_invited_npubs
            .contains(&request.invited_npub)
}

fn record_issuance_for_request(election: &mut ElectionRuntimeState, request: &BlindBallotRequest) {
    election
        .issued_invited_scope_keys
        .insert(blind_request_issuance_scope_key(request));
    if blind_request_uses_questionnaire_scope(request) {
        election
            .issued_invited_npubs
            .insert(request.invited_npub.clone());
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
    completion_in_flight: Arc<Mutex<HashSet<String>>>,
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

    let env_filter = build_worker_log_filter();
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
        config.poll_seconds
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
        completion_in_flight: Arc::new(Mutex::new(HashSet::new())),
    };

    info!("worker started as {}", worker_npub);

    let mut heartbeat_task = spawn_heartbeat_task(runtime.clone());
    let mut control_task = spawn_control_task(runtime.clone());
    let mut public_task = spawn_public_task(runtime.clone());
    let mut housekeeping_task = spawn_housekeeping_task(runtime.clone());

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
            result = &mut housekeeping_task => {
                log_task_exit("housekeeping", result);
                housekeeping_task = spawn_housekeeping_task(runtime.clone());
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
            match runtime.run_control_subscription().await {
                Ok(should_continue) => {
                    if !should_continue {
                        break;
                    }
                }
                Err(error) => {
                    warn!("control plane subscription failed: {error}");
                    sleep(Duration::from_secs(runtime.config.poll_seconds)).await;
                }
            }
        }
    })
}

fn spawn_public_task(runtime: WorkerRuntime) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match runtime.run_public_subscription().await {
                Ok(should_continue) => {
                    if !should_continue {
                        break;
                    }
                }
                Err(error) => {
                    warn!("public plane subscription failed: {error}");
                    sleep(Duration::from_secs(runtime.config.poll_seconds)).await;
                }
            }
        }
    })
}

fn spawn_housekeeping_task(runtime: WorkerRuntime) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(runtime.config.poll_seconds));
        loop {
            ticker.tick().await;
            if let Err(error) = runtime.finalize_completed_elections().await {
                warn!("housekeeping completion check failed: {error}");
            }
            if let Err(error) = runtime.prune_local_state_cache().await {
                warn!("housekeeping cache prune failed: {error}");
            }
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
    async fn prune_local_state_cache(&self) -> Result<()> {
        let mut state = self.state.lock().await;
        prune_seen_control_events(&mut state.seen_control_event_ids, Utc::now());
        state.last_public_scan_at = Some(now_iso());
        state.last_dm_scan_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn send_status_heartbeat(&self) -> Result<()> {
        let snapshot = {
            let state = self.state.lock().await;
            let active = select_status_active_election(&state);
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

    async fn run_control_subscription(&self) -> Result<bool> {
        let since_ts = fixed_lookback_timestamp(DEFAULT_DM_LOOKBACK_SECS);
        let filter = Filter::new()
            .kind(Kind::GiftWrap)
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::P),
                self.worker_pubkey.to_hex(),
            )
            .since(since_ts)
            .limit(500);
        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;

        let output = self
            .client
            .subscribe_to(relays.clone(), filter, None)
            .await
            .context("failed to subscribe to control plane")?;
        if !output.failed.is_empty() {
            warn!(
                "control subscription rejected by {} relays: {}",
                output.failed.len(),
                output
                    .failed
                    .into_iter()
                    .map(|(relay, error)| format!("{relay}: {error}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }
        info!(
            "control plane subscription active: id={}, relays={}",
            output.val,
            relays.len()
        );
        let control_subscription_id = output.val;

        let mut notification_receiver = self.client.notifications();
        loop {
            match notification_receiver.recv().await {
                Ok(RelayPoolNotification::Event {
                    subscription_id: event_subscription_id,
                    event,
                    ..
                }) if event_subscription_id == control_subscription_id => {
                    if let Err(error) = self.process_control_plane_event(&event).await {
                        warn!("control plane event {} failed: {error}", event.id);
                    }
                }
                Ok(RelayPoolNotification::Event { .. }) => {}
                Ok(RelayPoolNotification::Shutdown) => {
                    info!(
                        "control plane notification channel closed; stopping control worker loop"
                    );
                    return Ok(false);
                }
                Err(RecvError::Closed) => {
                    info!(
                        "control plane notification receiver closed; stopping control worker loop"
                    );
                    return Ok(false);
                }
                Err(RecvError::Lagged(skipped)) => {
                    warn!("control plane subscription lagged by {skipped} events");
                }
                _ => {}
            }
        }
    }

    async fn process_control_plane_event(&self, event: &Event) -> Result<()> {
        let replay_seen_control_events = {
            let state = self.state.lock().await;
            !state.seen_control_event_ids.is_empty()
                && state
                    .elections
                    .values()
                    .any(election_needs_legacy_control_replay)
        };

        if replay_seen_control_events {
            debug!(
                "control plane replaying seen gift-wraps to recover legacy scoped-issuance state"
            );
        }

        let event_id = event.id.to_string();
        let replay_seen_event = {
            let state = self.state.lock().await;
            if state.seen_control_event_ids.contains_key(&event_id) {
                replay_seen_control_events
            } else {
                true
            }
        };
        if !replay_seen_event {
            return Ok(());
        }

        let unwrapped = self.client.unwrap_gift_wrap(event).await?;
        log_decrypted_worker_dm(event, &unwrapped.rumor);
        let rumor_content = unwrapped.rumor.content;
        if rumor_content.trim().is_empty() {
            return Ok(());
        }
        match self.process_control_message(&rumor_content).await {
            Ok(true) => {
                let mut state = self.state.lock().await;
                state.seen_control_event_ids.insert(event_id, now_iso());
                prune_seen_control_events(&mut state.seen_control_event_ids, Utc::now());
                state.last_dm_scan_at = Some(now_iso());
                self.store.save(&state)?;
            }
            Ok(false) => {
                if replay_seen_control_events {
                    let mut state = self.state.lock().await;
                    state.seen_control_event_ids.insert(event_id, now_iso());
                    prune_seen_control_events(&mut state.seen_control_event_ids, Utc::now());
                    state.last_dm_scan_at = Some(now_iso());
                    self.store.save(&state)?;
                }
            }
            Err(error) => return Err(error),
        }
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
            for relay in &election.definition_relays {
                match RelayUrl::parse(relay) {
                    Ok(parsed) => relays.push(parsed),
                    Err(error) => {
                        warn!("ignoring invalid definition relay {relay}: {error}")
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
        let raw_value: serde_json::Value = match serde_json::from_str(content) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(true),
        };
        let value = match unwrap_compressed_bundle_value(raw_value) {
            Ok(parsed) => parsed,
            Err(error) => {
                warn!("failed to decode compressed control message: {error}");
                return Ok(true);
            }
        };
        let message_type = value
            .get("type")
            .and_then(|entry| entry.as_str())
            .unwrap_or_default();
        debug!("control message parsed: type={message_type}");
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
                debug!(
                    "blind request received: election_id={}, request_id={}, invited_npub={}",
                    envelope.request.election_id,
                    envelope.request.request_id,
                    envelope.request.invited_npub
                );
                return self.handle_blind_request(envelope.request).await;
            }
            "optiona_blind_request_bundle_dm" => {
                let envelope: BlindBallotRequestBundleEnvelope = match serde_json::from_value(value)
                {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(true),
                };
                debug!(
                    "blind request bundle received: requests={}",
                    envelope.requests.len()
                );
                return self.handle_blind_request_bundle(envelope.requests).await;
            }
            _ => return Ok(true),
        }
        Ok(true)
    }

    async fn run_public_subscription(&self) -> Result<bool> {
        let since_ts = fixed_lookback_timestamp(DEFAULT_PUBLIC_LOOKBACK_SECS);
        let response_filter = Filter::new()
            .kind(Kind::Custom(
                IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND,
            ))
            .hashtag("questionnaire_response_blind")
            .since(since_ts)
            .limit(500);
        let delegation_filter = Filter::new()
            .author(self.coordinator_pubkey)
            .kinds(vec![
                Kind::Custom(OPTIONA_WORKER_DELEGATION_KIND),
                Kind::Custom(OPTIONA_WORKER_DELEGATION_REVOCATION_KIND),
            ])
            .since(since_ts)
            .limit(300);
        let definition_filter = Filter::new()
            .author(self.coordinator_pubkey)
            .kind(Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION))
            .hashtag("questionnaire_definition")
            .since(since_ts)
            .limit(300);

        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;

        let response_output = self
            .client
            .subscribe_to(relays.clone(), response_filter, None)
            .await
            .context("failed to subscribe to public response plane")?;
        let public_response_subscription_id = response_output.val.clone();
        let delegation_subscription_id = SubscriptionId::generate();
        let definition_subscription_id = SubscriptionId::generate();
        let delegation_output = self
            .client
            .subscribe_with_id_to(
                relays.clone(),
                delegation_subscription_id.clone(),
                delegation_filter,
                None,
            )
            .await
            .context("failed to subscribe to public delegation plane")?;
        let definition_output = self
            .client
            .subscribe_with_id_to(
                relays,
                definition_subscription_id.clone(),
                definition_filter,
                None,
            )
            .await
            .context("failed to subscribe to public definition plane")?;

        if !response_output.failed.is_empty() {
            warn!(
                "public response subscription rejected by {} relays: {}",
                response_output.failed.len(),
                response_output
                    .failed
                    .into_iter()
                    .map(|(relay, error)| format!("{relay}: {error}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }
        if !delegation_output.failed.is_empty() {
            warn!(
                "public delegation subscription rejected by {} relays: {}",
                delegation_output.failed.len(),
                delegation_output
                    .failed
                    .into_iter()
                    .map(|(relay, error)| format!("{relay}: {error}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }
        if !definition_output.failed.is_empty() {
            warn!(
                "public definition subscription rejected by {} relays: {}",
                definition_output.failed.len(),
                definition_output
                    .failed
                    .into_iter()
                    .map(|(relay, error)| format!("{relay}: {error}"))
                    .collect::<Vec<_>>()
                    .join("; ")
            );
        }

        info!(
            "public response subscription active: id={}, relays={}",
            response_output.val,
            response_output.success.len()
        );
        info!(
            "public delegation subscription active: id={}, relays={}",
            delegation_subscription_id,
            delegation_output.success.len()
        );
        info!(
            "public definition subscription active: id={}, relays={}",
            definition_subscription_id,
            definition_output.success.len()
        );

        let mut notification_receiver = self.client.notifications();
        loop {
            match notification_receiver.recv().await {
                Ok(RelayPoolNotification::Event {
                    subscription_id: event_subscription_id,
                    event,
                    ..
                }) if event_subscription_id == public_response_subscription_id => {
                    self.process_public_response_event(&event, &since_ts)
                        .await?;
                }
                Ok(RelayPoolNotification::Event {
                    subscription_id: event_subscription_id,
                    event,
                    ..
                }) if event_subscription_id == definition_subscription_id => {
                    self.process_public_definition_event(&event).await?;
                }
                Ok(RelayPoolNotification::Event {
                    subscription_id: event_subscription_id,
                    event,
                    ..
                }) if event_subscription_id == delegation_subscription_id => {
                    if event.kind == Kind::Custom(OPTIONA_WORKER_DELEGATION_KIND) {
                        if let Ok(delegation) =
                            serde_json::from_str::<WorkerDelegationCertificate>(&event.content)
                        {
                            self.apply_delegation(delegation).await?;
                        }
                    } else if event.kind == Kind::Custom(OPTIONA_WORKER_DELEGATION_REVOCATION_KIND)
                    {
                        if let Ok(revocation) =
                            serde_json::from_str::<WorkerDelegationRevocation>(&event.content)
                        {
                            self.apply_revocation(revocation).await?;
                        }
                    }
                    let mut state = self.state.lock().await;
                    state.last_public_scan_at = Some(now_iso());
                    self.store.save(&state)?;
                }
                Ok(RelayPoolNotification::Event { .. }) => {}
                Ok(RelayPoolNotification::Shutdown) => {
                    info!("public plane notification channel closed; stopping public worker loop");
                    return Ok(false);
                }
                Err(RecvError::Closed) => {
                    info!("public plane notification receiver closed; stopping public worker loop");
                    return Ok(false);
                }
                Err(RecvError::Lagged(skipped)) => {
                    warn!("public plane subscription lagged by {skipped} events");
                }
                _ => {}
            }
        }
    }

    async fn process_public_definition_event(&self, event: &Event) -> Result<bool> {
        if event.kind != Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION) {
            return Ok(false);
        }
        if event.pubkey != self.coordinator_pubkey {
            return Ok(false);
        }
        let definition = match serde_json::from_str::<serde_json::Value>(&event.content) {
            Ok(parsed) => parsed,
            Err(error) => {
                warn!(
                    "failed to parse questionnaire definition event {}: {error}",
                    event.id
                );
                return Ok(false);
            }
        };
        if definition.get("eventType").and_then(|entry| entry.as_str())
            != Some("questionnaire_definition")
        {
            return Ok(false);
        }
        let Some(questionnaire_id) = definition
            .get("questionnaireId")
            .and_then(|entry| entry.as_str())
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
        else {
            return Ok(false);
        };
        let definition_hash = questionnaire_definition_hash(&definition);
        let mut state = self.state.lock().await;
        let election = state
            .elections
            .entry(questionnaire_id.clone())
            .or_insert_with(ElectionRuntimeState::default);
        if election.election_id.is_empty() {
            election.election_id = questionnaire_id.clone();
        }
        if let Some(expected_hash) = election
            .definition_hash
            .as_ref()
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
        {
            if expected_hash != definition_hash {
                if public_definition_matches_worker_private_key(&definition, election) {
                    warn!(
                        "public questionnaire definition hash mismatch but blind signing key matches worker config; accepting public definition: election_id={}, expected={}, received={}",
                        questionnaire_id,
                        expected_hash,
                        definition_hash
                    );
                } else {
                    debug!(
                        "public questionnaire definition ignored due to hash mismatch: election_id={}, expected={}, received={}",
                        questionnaire_id,
                        expected_hash,
                        definition_hash
                    );
                    return Ok(false);
                }
            }
        }
        election.definition = Some(definition);
        election.definition_hash = Some(definition_hash);
        election.definition_event_id = Some(event.id.to_hex());
        state.last_public_scan_at = Some(now_iso());
        self.store.save(&state)?;
        debug!(
            "public questionnaire definition stored: election_id={}, event_id={}",
            questionnaire_id, event.id
        );
        Ok(true)
    }

    async fn process_public_response_event(
        &self,
        event: &Event,
        since_ts: &Timestamp,
    ) -> Result<bool> {
        if event.kind != Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND)
            || event.created_at < *since_ts
        {
            return Ok(false);
        }

        let submission =
            match serde_json::from_str::<QuestionnaireBlindResponseEvent>(&event.content) {
                Ok(parsed) => parsed,
                Err(error) => {
                    warn!("failed to parse blind response event {}: {error}", event.id);
                    return Ok(false);
                }
            };

        let should_handle = {
            let state = self.state.lock().await;
            if let Some(election) = state.elections.get(&submission.questionnaire_id) {
                election_should_scan_public_submissions(election)
            } else {
                false
            }
        };
        if !should_handle {
            return Ok(false);
        }

        let handled = self.handle_submission(submission).await?;
        if handled {
            info!(
                "public plane handled 1 new blind response event from {}",
                event.id
            );
        }
        if handled {
            self.finalize_completed_elections().await?;
        }

        let mut state = self.state.lock().await;
        state.last_public_scan_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(handled)
    }

    async fn handle_submission(&self, submission: QuestionnaireBlindResponseEvent) -> Result<bool> {
        let mut state = self.state.lock().await;
        let Some(election) = state.elections.get_mut(&submission.questionnaire_id) else {
            return Ok(false);
        };
        if election
            .processed_submission_ids
            .contains(&submission.response_id)
        {
            return Ok(false);
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
        Ok(true)
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
            let mut in_flight = self.completion_in_flight.lock().await;
            state
                .elections
                .values()
                .filter(|entry| !entry.revoked && !is_expired(&entry.expires_at))
                .filter_map(|entry| {
                    let expected = match known_expected_invitee_count(entry) {
                        Some(expected) => expected,
                        None => return None,
                    };
                    let accepted_unique = entry.accepted_response_count;
                    if accepted_unique < expected || !entry.deferred_blind_request_ids.is_empty() {
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
                    if in_flight.contains(&entry.election_id) {
                        return None;
                    }
                    in_flight.insert(entry.election_id.clone());
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
                let close_event_id = match self
                    .publish_questionnaire_closed_state(&action.election_id, &action.delegation_id)
                    .await
                {
                    Ok(event_id) => event_id,
                    Err(error) => {
                        let mut in_flight = self.completion_in_flight.lock().await;
                        in_flight.remove(&action.election_id);
                        return Err(error);
                    }
                };
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
                let summary_event_id = match self
                    .publish_result_summary(
                        &action.election_id,
                        action.accepted_count,
                        action.rejected_count,
                    )
                    .await
                {
                    Ok(event_id) => event_id,
                    Err(error) => {
                        let mut in_flight = self.completion_in_flight.lock().await;
                        in_flight.remove(&action.election_id);
                        return Err(error);
                    }
                };
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
            let mut in_flight = self.completion_in_flight.lock().await;
            in_flight.remove(&action.election_id);
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
        if worker_election_config_has_blind_key_mismatch(&snapshot) {
            warn!(
                "worker election config ignored because blind signing key does not match definition: election_id={}, delegation_id={}, private_key={}, definition_key={}",
                snapshot.election_id,
                snapshot.delegation_id,
                snapshot
                    .blind_signing_private_key
                    .as_ref()
                    .map(|key| key.key_id.as_str())
                    .unwrap_or("missing"),
                definition_blind_signing_key_id(&snapshot.definition).unwrap_or_else(|| "missing".to_string()),
            );
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
        if !apply_worker_election_config(election, &snapshot) {
            info!(
                "worker election config ignored as stale replay or empty no-eligibility config: election_id={}, delegation_id={}, incoming_expected_invitee_count={:?}, incoming_sent_at={}, current_expected_invitee_count={:?}, current_sent_at={}",
                snapshot.election_id,
                snapshot.delegation_id,
                snapshot.expected_invitee_count,
                snapshot.sent_at,
                election.expected_invitee_count,
                election
                    .last_election_config_sent_at
                    .as_deref()
                    .unwrap_or("unknown"),
            );
            return Ok(());
        }
        self.store.save(&state)?;
        let should_fetch_public_definition =
            snapshot.definition_reference.is_some() && snapshot.definition.is_none();
        drop(state);
        info!(
            "worker election config applied: election_id={}, delegation_id={}, expected_invitee_count={:?}, has_blind_signing_key={}, has_definition_reference={}, has_legacy_definition={}",
            snapshot.election_id,
            snapshot.delegation_id,
            snapshot.expected_invitee_count,
            snapshot.blind_signing_private_key.is_some(),
            snapshot.definition_reference.is_some(),
            snapshot.definition.is_some(),
        );
        if should_fetch_public_definition {
            self.fetch_public_definition_for_election(&snapshot.election_id)
                .await?;
        }
        Ok(())
    }

    async fn fetch_public_definition_for_election(&self, election_id: &str) -> Result<()> {
        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;
        let filter = Filter::new()
            .author(self.coordinator_pubkey)
            .kind(Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION))
            .hashtag("questionnaire_definition")
            .custom_tag(
                SingleLetterTag::lowercase(Alphabet::Q),
                election_id.to_string(),
            )
            .limit(100);
        let events = self
            .client
            .fetch_events(filter, Duration::from_secs(5))
            .await
            .context("failed to fetch public questionnaire definition")?;
        let mut handled = false;
        for event in events.into_iter() {
            if event.content.contains(election_id)
                && self.process_public_definition_event(&event).await?
            {
                handled = true;
            }
        }
        if !handled {
            debug!(
                "public questionnaire definition fetch found no matching definition: election_id={}",
                election_id
            );
        }
        Ok(())
    }

    async fn prepare_blind_issuance(
        &self,
        request: BlindBallotRequest,
    ) -> Result<PreparedBlindIssuance> {
        let election = {
            let mut state = self.state.lock().await;
            let Some(election) = state.elections.get_mut(&request.election_id) else {
                info!(
                    "blind request deferred for election {} because no worker config is loaded yet",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            };
            if election.revoked || is_expired(&election.expires_at) {
                return Ok(PreparedBlindIssuance::Handled);
            }
            if !election
                .capabilities
                .contains(&WorkerCapability::IssueBlindTokens)
            {
                return Ok(PreparedBlindIssuance::Handled);
            }
            if election
                .seen_blind_request_ids
                .contains(&request.request_id)
            {
                debug!(
                    "blind request replay received; re-publishing issuance: election_id={}, request_id={}",
                    request.election_id, request.request_id
                );
            }
            if election.blind_signing_private_key.is_none() {
                election
                    .deferred_blind_request_ids
                    .insert(request.request_id.clone());
                self.store.save(&state)?;
                warn!(
                    "blind request deferred for election {} because no blind signing key is configured",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if election.definition.is_none() {
                election
                    .deferred_blind_request_ids
                    .insert(request.request_id.clone());
                self.store.save(&state)?;
                warn!(
                    "blind request deferred for election {} because public questionnaire definition is not loaded yet",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if !has_effective_eligibility_config(election) {
                election
                    .deferred_blind_request_ids
                    .insert(request.request_id.clone());
                self.store.save(&state)?;
                warn!(
                    "blind request deferred for election {} because delegated eligibility config is not loaded yet",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if !election
                .seen_blind_request_ids
                .contains(&request.request_id)
                && has_existing_issuance_for_request(election, &request)
            {
                election
                    .deferred_blind_request_ids
                    .remove(&request.request_id);
                self.store.save(&state)?;
                warn!(
                    "blind request ignored because this invited npub/scope already has a delegated issuance: election_id={}, request_id={}, invited_npub={}, ballot_scope={}",
                    request.election_id,
                    request.request_id,
                    request.invited_npub,
                    ballot_scope_key(&request.ballot_scope)
                );
                return Ok(PreparedBlindIssuance::Handled);
            }
            let state_changed_by_authorization = match authorize_blind_request(election, &request) {
                BlindRequestAuthorization::Authorized { state_changed } => state_changed,
                BlindRequestAuthorization::Deferred => {
                    election
                        .deferred_blind_request_ids
                        .insert(request.request_id.clone());
                    self.store.save(&state)?;
                    info!(
                        "blind request deferred for election {} because delegated eligibility is not satisfied yet",
                        request.election_id
                    );
                    return Ok(PreparedBlindIssuance::Deferred);
                }
                BlindRequestAuthorization::Rejected => {
                    election
                        .deferred_blind_request_ids
                        .remove(&request.request_id);
                    self.store.save(&state)?;
                    warn!(
                        "blind request rejected by delegated eligibility: election_id={}, request_id={}, invited_npub={}",
                        request.election_id, request.request_id, request.invited_npub
                    );
                    return Ok(PreparedBlindIssuance::Handled);
                }
            };
            let cloned = election.clone();
            if state_changed_by_authorization {
                self.store.save(&state)?;
            }
            cloned
        };
        let private_key = election
            .blind_signing_private_key
            .clone()
            .expect("checked above");
        let definition_key_id = definition_blind_signing_key_id(&election.definition);
        if definition_key_id
            .as_deref()
            .is_some_and(|key_id| key_id != private_key.key_id)
        {
            warn!(
                "blind request ignored for election {} because public definition key does not match worker private key definition={} worker={}",
                request.election_id,
                definition_key_id.unwrap_or_else(|| "missing".to_string()),
                private_key.key_id
            );
            return Ok(PreparedBlindIssuance::Handled);
        }
        if private_key.key_id != request.blind_signing_key_id {
            let mut state = self.state.lock().await;
            if let Some(election) = state.elections.get_mut(&request.election_id) {
                election
                    .deferred_blind_request_ids
                    .remove(&request.request_id);
                self.store.save(&state)?;
            }
            warn!(
                "blind request ignored for election {} due to key-id mismatch request={} worker={}",
                request.election_id, request.blind_signing_key_id, private_key.key_id
            );
            return Ok(PreparedBlindIssuance::Handled);
        }
        let blind_signature =
            sign_blinded_message(&request.blinded_message, &private_key.private_jwk)?;
        let issuance = build_blind_issuance(&request, &election, blind_signature, now_iso());
        Ok(PreparedBlindIssuance::Issuance { request, issuance })
    }

    async fn mark_blind_issuances_published(&self, requests: &[BlindBallotRequest]) -> Result<()> {
        let mut state = self.state.lock().await;
        for request in requests {
            let Some(election) = state.elections.get_mut(&request.election_id) else {
                continue;
            };
            record_issuance_for_request(election, request);
            election
                .deferred_blind_request_ids
                .remove(&request.request_id);
            election
                .seen_blind_request_ids
                .insert(request.request_id.clone());
            election.last_blind_issuance_at = Some(now_iso());
        }
        self.store.save(&state)?;
        Ok(())
    }

    async fn publish_prepared_blind_issuances(
        &self,
        recipient_npub: &str,
        issuances: &[BlindBallotIssuance],
    ) -> Result<usize> {
        let recipient = PublicKey::from_bech32(recipient_npub)
            .context("invalid invited npub on blind request")?;
        let content = if issuances.len() == 1 {
            let envelope = BlindBallotIssuanceEnvelope {
                message_type: "optiona_blind_issuance_dm".to_string(),
                schema_version: 1,
                issuance: issuances[0].clone(),
                sent_at: now_iso(),
            };
            serde_json::to_string(&envelope)?
        } else {
            let envelope = build_blind_issuance_bundle_envelope(issuances);
            let message_type = envelope.message_type.clone();
            let sent_at = envelope.sent_at.clone();
            maybe_compress_bundle_content(
                serde_json::to_string(&envelope)?,
                &message_type,
                &sent_at,
            )?
        };
        self.send_private_msg_best_effort(recipient, content, "blind issuance")
            .await
    }

    async fn handle_blind_request(&self, request: BlindBallotRequest) -> Result<bool> {
        let (request, issuance) = match self.prepare_blind_issuance(request).await? {
            PreparedBlindIssuance::Deferred => return Ok(false),
            PreparedBlindIssuance::Handled => return Ok(true),
            PreparedBlindIssuance::Issuance { request, issuance } => (request, issuance),
        };
        let envelope = BlindBallotIssuanceEnvelope {
            message_type: "optiona_blind_issuance_dm".to_string(),
            schema_version: 1,
            issuance: issuance.clone(),
            sent_at: now_iso(),
        };
        let content = serde_json::to_string(&envelope)?;
        let recipient = PublicKey::from_bech32(&request.invited_npub)
            .context("invalid invited npub on blind request")?;
        let successes = self
            .send_private_msg_best_effort(recipient, content, "blind issuance")
            .await?;
        debug!(
            "blind issuance published: election_id={}, request_id={}, invited_npub={}, relay_successes={}",
            request.election_id,
            request.request_id,
            request.invited_npub,
            successes
        );
        self.mark_blind_issuances_published(&[request]).await?;
        Ok(true)
    }

    async fn handle_blind_request_bundle(&self, requests: Vec<BlindBallotRequest>) -> Result<bool> {
        let mut handled_any = false;
        let mut prepared_by_recipient: std::collections::HashMap<
            (String, String),
            Vec<(BlindBallotRequest, BlindBallotIssuance)>,
        > = std::collections::HashMap::new();
        let mut seen_bundle_scope_keys = std::collections::HashSet::new();
        for request in requests {
            let scope_key = blind_request_issuance_scope_key(&request);
            if !seen_bundle_scope_keys.insert(scope_key.clone()) {
                warn!(
                    "blind request bundle skipped duplicate voter/scope entry: election_id={}, request_id={}, invited_npub={}, ballot_scope={}",
                    request.election_id,
                    request.request_id,
                    request.invited_npub,
                    ballot_scope_key(&request.ballot_scope)
                );
                handled_any = true;
                continue;
            }
            match self.prepare_blind_issuance(request).await? {
                PreparedBlindIssuance::Deferred => {}
                PreparedBlindIssuance::Handled => handled_any = true,
                PreparedBlindIssuance::Issuance { request, issuance } => {
                    handled_any = true;
                    prepared_by_recipient
                        .entry((request.invited_npub.clone(), request.election_id.clone()))
                        .or_default()
                        .push((request, issuance));
                }
            }
        }
        for ((recipient_npub, election_id), entries) in prepared_by_recipient {
            let issuances = entries
                .iter()
                .map(|(_, issuance)| issuance.clone())
                .collect::<Vec<_>>();
            let successes = self
                .publish_prepared_blind_issuances(&recipient_npub, &issuances)
                .await?;
            debug!(
                "blind issuance bundle published: election_id={}, recipient_npub={}, issuances={}, relay_successes={}",
                election_id,
                recipient_npub,
                issuances.len(),
                successes
            );
            let requests = entries
                .into_iter()
                .map(|(request, _)| request)
                .collect::<Vec<_>>();
            self.mark_blind_issuances_published(&requests).await?;
        }
        Ok(handled_any)
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
        let sanitized_control_relays = sanitize_control_relay_strings(&delegation.control_relays);
        let control_relays = parse_control_relays(&sanitized_control_relays);
        let mut state = self.state.lock().await;
        let active_delegation_id = state
            .elections
            .get(&delegation.election_id)
            .map(|existing| existing.delegation_id.clone())
            .unwrap_or_default();
        let current_delegation = state.known_delegations.get(&active_delegation_id);
        if is_stale_delegation_replay(current_delegation, &delegation) {
            debug!(
                "ignoring stale delegation replay {} for election {}; active delegation is {}",
                delegation.delegation_id, delegation.election_id, active_delegation_id
            );
            return Ok(());
        }
        state
            .known_delegations
            .insert(delegation.delegation_id.clone(), delegation.clone());
        let existing = state
            .elections
            .entry(delegation.election_id.clone())
            .or_insert_with(ElectionRuntimeState::default);
        let delegation_changed = existing.delegation_id != delegation.delegation_id;
        if delegation_changed {
            info!(
                "activating delegation {} for election {}",
                delegation.delegation_id, delegation.election_id
            );
        }
        existing.election_id = delegation.election_id.clone();
        existing.delegation_id = delegation.delegation_id.clone();
        existing.capabilities = delegation.capabilities.clone();
        existing.control_relays = sanitized_control_relays;
        existing.revoked = false;
        existing.expires_at = delegation.expires_at.clone();
        if delegation_changed {
            existing.seen_blind_request_ids.clear();
            existing.deferred_blind_request_ids.clear();
            existing.issued_invited_npubs.clear();
            existing.issued_invited_scope_keys.clear();
            existing.whitelist_npubs.clear();
            existing.bearer_invite_codes.clear();
            existing.eligibility_configured = false;
            existing.eligibility_required = false;
            existing.accepted_response_authors.clear();
            existing.accepted_response_count = 0;
            existing.rejected_response_count = 0;
            existing.expected_invitee_count = None;
            existing.last_election_config_sent_at = None;
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
    use crate::model::QuestionnaireBlindPrivateKey;
    use chrono::Duration as ChronoDuration;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

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
            invite_code_hash: None,
            ballot_scope: None,
        }
    }

    fn unique_worker_state_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "auditable-voting-worker-{label}-{}-{nanos}",
            std::process::id()
        ))
    }

    fn test_runtime_with_state(
        coordinator_keys: &Keys,
        mut state: WorkerPersistentState,
    ) -> (WorkerRuntime, PathBuf) {
        let worker_keys = Keys::generate();
        let worker_npub = worker_keys.public_key().to_bech32().expect("worker npub");
        let coordinator_npub = coordinator_keys
            .public_key()
            .to_bech32()
            .expect("coordinator npub");
        let state_dir = unique_worker_state_dir("definition");
        let store = Arc::new(WorkerStore::open(&state_dir).expect("open worker store"));
        state.worker_npub = worker_npub.clone();
        state.coordinator_npub = coordinator_npub.clone();
        state.relays = vec!["wss://relay.example.com".to_string()];
        store.save(&state).expect("save initial worker state");

        let runtime = WorkerRuntime {
            config: WorkerConfig {
                worker_nsec: worker_keys.secret_key().to_bech32().expect("worker nsec"),
                coordinator_npub,
                worker_relays: vec![RelayUrl::parse("wss://relay.example.com").expect("relay")],
                worker_relays_from_env: true,
                worker_state_dir: state_dir.clone(),
                heartbeat_seconds: 30,
                poll_seconds: 5,
            },
            client: Client::new(worker_keys.clone()),
            worker_pubkey: worker_keys.public_key(),
            worker_npub,
            coordinator_pubkey: coordinator_keys.public_key(),
            store,
            state: Arc::new(Mutex::new(state)),
            relay_backoff: Arc::new(Mutex::new(HashMap::new())),
            completion_in_flight: Arc::new(Mutex::new(HashSet::new())),
        };
        (runtime, state_dir)
    }

    fn public_definition(questionnaire_id: &str, key_id: &str) -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_definition",
            "questionnaireId": questionnaire_id,
            "title": "Runtime definition",
            "description": "Loaded from a signed public event",
            "createdAt": 1781200000,
            "openAt": 1781200000,
            "closeAt": 1781203600,
            "coordinatorPubkey": "npub1coordinator",
            "coordinatorEncryptionPubkey": "npub1coordinator",
            "responseVisibility": "private",
            "eligibilityMode": "open",
            "blindSigningPublicKey": {
                "scheme": "rsa-blind-pss-sha384",
                "keyId": key_id,
                "jwk": {}
            },
            "questions": [{
                "questionId": "q1",
                "prompt": "Proceed?",
                "required": true,
                "type": "yes_no"
            }]
        })
    }

    fn public_definition_event(keys: &Keys, definition: &serde_json::Value) -> Event {
        let questionnaire_id = definition
            .get("questionnaireId")
            .and_then(|entry| entry.as_str())
            .expect("definition questionnaire id");
        EventBuilder::new(
            Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION),
            serde_json::to_string(definition).expect("serialize definition"),
        )
        .tags([
            Tag::parse(["t", "questionnaire_definition"]).expect("hashtag tag"),
            Tag::parse(["q", questionnaire_id]).expect("q tag"),
            Tag::parse(["questionnaire-id", questionnaire_id]).expect("questionnaire id tag"),
        ])
        .sign_with_keys(keys)
        .expect("sign definition event")
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
            whitelist_npubs: Some(vec!["npub1knownvoter".to_string()]),
            bearer_invite_codes: Some(vec![BearerInviteCodeEntry {
                election_id: "q_worker_definition".to_string(),
                code_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                created_at: now_iso(),
                state: "available".to_string(),
                redeemed_at: None,
                redeemed_npub: None,
                revoked_at: None,
            }]),
            eligibility_required: Some(true),
            blind_signing_private_key: None,
            definition_reference: None,
            definition: Some(definition.clone()),
            sent_at: now_iso(),
        };

        assert!(apply_worker_election_config(&mut election, &snapshot));

        assert_eq!(election.expected_invitee_count, Some(3));
        assert_eq!(
            election.last_election_config_sent_at.as_deref(),
            Some(snapshot.sent_at.as_str())
        );
        assert!(election.eligibility_configured);
        assert!(election.eligibility_required);
        assert!(election.whitelist_npubs.contains("npub1knownvoter"));
        assert!(election
            .bearer_invite_codes
            .contains_key("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert_eq!(election.definition, Some(definition.clone()));
        assert_eq!(
            election.definition_hash.as_deref(),
            Some(questionnaire_definition_hash(&definition).as_str())
        );
    }

    #[test]
    fn worker_election_config_rejects_mismatched_blind_private_key() {
        let mut election = ElectionRuntimeState::default();
        let snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(1),
            whitelist_npubs: Some(vec!["npub1knownvoter".to_string()]),
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(true),
            blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                scheme: "rsa-blind-pss-sha384".to_string(),
                key_id: "private-key-id".to_string(),
                jwk: json!({}),
                private_jwk: json!({}),
            }),
            definition_reference: None,
            definition: Some(json!({
                "schemaVersion": 1,
                "eventType": "questionnaire_definition",
                "questionnaireId": "q_worker_definition",
                "blindSigningPublicKey": {
                    "scheme": "rsa-blind-pss-sha384",
                    "keyId": "published-key-id",
                    "jwk": {}
                }
            })),
            sent_at: now_iso(),
        };

        assert!(worker_election_config_has_blind_key_mismatch(&snapshot));
        assert!(!apply_worker_election_config(&mut election, &snapshot));

        assert!(election.blind_signing_private_key.is_none());
        assert!(election.definition.is_none());
        assert_eq!(election.last_election_config_sent_at, None);
    }

    #[test]
    fn public_definition_hash_mismatch_is_recoverable_when_blind_key_matches() {
        let matching_definition = json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_definition",
            "questionnaireId": "q_worker_definition",
            "blindSigningPublicKey": {
                "scheme": "rsa-blind-pss-sha384",
                "keyId": "private-key-id",
                "jwk": {}
            }
        });
        let mismatched_definition = json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_definition",
            "questionnaireId": "q_worker_definition",
            "blindSigningPublicKey": {
                "scheme": "rsa-blind-pss-sha384",
                "keyId": "other-key-id",
                "jwk": {}
            }
        });
        let election = ElectionRuntimeState {
            blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                scheme: "rsa-blind-pss-sha384".to_string(),
                key_id: "private-key-id".to_string(),
                jwk: json!({}),
                private_jwk: json!({}),
            }),
            ..ElectionRuntimeState::default()
        };

        assert!(public_definition_matches_worker_private_key(
            &matching_definition,
            &election
        ));
        assert!(!public_definition_matches_worker_private_key(
            &mismatched_definition,
            &election
        ));
    }

    #[tokio::test]
    async fn public_definition_event_loads_when_no_expected_hash_is_configured() {
        let coordinator_keys = Keys::generate();
        let definition = public_definition("q_public_definition_no_hash", "key-live");
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_public_definition_no_hash".to_string(),
            ElectionRuntimeState {
                election_id: "q_public_definition_no_hash".to_string(),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);
        let event = public_definition_event(&coordinator_keys, &definition);

        assert!(runtime
            .process_public_definition_event(&event)
            .await
            .expect("process definition"));

        {
            let state = runtime.state.lock().await;
            let election = state
                .elections
                .get("q_public_definition_no_hash")
                .expect("election stored");
            assert_eq!(election.definition.as_ref(), Some(&definition));
            assert_eq!(
                election.definition_hash.as_deref(),
                Some(questionnaire_definition_hash(&definition).as_str())
            );
            assert_eq!(
                election.definition_event_id.as_deref(),
                Some(event.id.to_hex().as_str())
            );
        }
        let _ = fs::remove_dir_all(state_dir);
    }

    #[tokio::test]
    async fn public_definition_event_loads_when_expected_hash_matches() {
        let coordinator_keys = Keys::generate();
        let definition = public_definition("q_public_definition_matching_hash", "key-live");
        let expected_hash = questionnaire_definition_hash(&definition);
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_public_definition_matching_hash".to_string(),
            ElectionRuntimeState {
                election_id: "q_public_definition_matching_hash".to_string(),
                definition_hash: Some(expected_hash.clone()),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);
        let event = public_definition_event(&coordinator_keys, &definition);

        assert!(runtime
            .process_public_definition_event(&event)
            .await
            .expect("process definition"));

        {
            let state = runtime.state.lock().await;
            let election = state
                .elections
                .get("q_public_definition_matching_hash")
                .expect("election stored");
            assert_eq!(election.definition.as_ref(), Some(&definition));
            assert_eq!(
                election.definition_hash.as_deref(),
                Some(expected_hash.as_str())
            );
        }
        let _ = fs::remove_dir_all(state_dir);
    }

    #[tokio::test]
    async fn public_definition_event_recovers_stale_expected_hash_when_blind_key_matches() {
        let coordinator_keys = Keys::generate();
        let definition = public_definition("q_public_definition_stale_hash", "key-live");
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_public_definition_stale_hash".to_string(),
            ElectionRuntimeState {
                election_id: "q_public_definition_stale_hash".to_string(),
                definition_hash: Some("stale-definition-hash".to_string()),
                blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                    scheme: "rsa-blind-pss-sha384".to_string(),
                    key_id: "key-live".to_string(),
                    jwk: json!({}),
                    private_jwk: json!({}),
                }),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);
        let event = public_definition_event(&coordinator_keys, &definition);

        assert!(runtime
            .process_public_definition_event(&event)
            .await
            .expect("process definition"));

        {
            let state = runtime.state.lock().await;
            let election = state
                .elections
                .get("q_public_definition_stale_hash")
                .expect("election stored");
            assert_eq!(election.definition.as_ref(), Some(&definition));
            assert_eq!(
                election.definition_hash.as_deref(),
                Some(questionnaire_definition_hash(&definition).as_str())
            );
        }
        let _ = fs::remove_dir_all(state_dir);
    }

    #[tokio::test]
    async fn public_definition_event_rejects_stale_expected_hash_when_blind_key_differs() {
        let coordinator_keys = Keys::generate();
        let definition = public_definition("q_public_definition_wrong_key", "different-key");
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_public_definition_wrong_key".to_string(),
            ElectionRuntimeState {
                election_id: "q_public_definition_wrong_key".to_string(),
                definition_hash: Some("stale-definition-hash".to_string()),
                blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                    scheme: "rsa-blind-pss-sha384".to_string(),
                    key_id: "key-live".to_string(),
                    jwk: json!({}),
                    private_jwk: json!({}),
                }),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);
        let event = public_definition_event(&coordinator_keys, &definition);

        assert!(!runtime
            .process_public_definition_event(&event)
            .await
            .expect("process definition"));

        {
            let state = runtime.state.lock().await;
            let election = state
                .elections
                .get("q_public_definition_wrong_key")
                .expect("election stored");
            assert!(election.definition.is_none());
            assert_eq!(
                election.definition_hash.as_deref(),
                Some("stale-definition-hash")
            );
        }
        let _ = fs::remove_dir_all(state_dir);
    }

    #[tokio::test]
    async fn public_definition_event_rejects_non_coordinator_author() {
        let coordinator_keys = Keys::generate();
        let other_keys = Keys::generate();
        let definition = public_definition("q_public_definition_wrong_author", "key-live");
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_public_definition_wrong_author".to_string(),
            ElectionRuntimeState {
                election_id: "q_public_definition_wrong_author".to_string(),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);
        let event = public_definition_event(&other_keys, &definition);

        assert!(!runtime
            .process_public_definition_event(&event)
            .await
            .expect("process definition"));

        {
            let state = runtime.state.lock().await;
            let election = state
                .elections
                .get("q_public_definition_wrong_author")
                .expect("election stored");
            assert!(election.definition.is_none());
            assert!(election.definition_hash.is_none());
        }
        let _ = fs::remove_dir_all(state_dir);
    }

    #[test]
    fn stale_worker_election_config_does_not_clear_complete_config() {
        let mut election = ElectionRuntimeState::default();
        let newer_snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(3),
            whitelist_npubs: Some(vec!["npub1knownvoter".to_string()]),
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(true),
            blind_signing_private_key: None,
            definition_reference: None,
            definition: None,
            sent_at: "2026-06-15T12:41:49.000Z".to_string(),
        };
        let stale_snapshot = WorkerElectionConfigSnapshot {
            expected_invitee_count: Some(0),
            whitelist_npubs: Some(vec![]),
            sent_at: "2026-06-15T12:41:48.000Z".to_string(),
            ..newer_snapshot.clone()
        };

        assert!(apply_worker_election_config(&mut election, &newer_snapshot));
        assert!(!apply_worker_election_config(
            &mut election,
            &stale_snapshot
        ));

        assert_eq!(election.expected_invitee_count, Some(3));
        assert_eq!(
            election.last_election_config_sent_at.as_deref(),
            Some(newer_snapshot.sent_at.as_str())
        );
        assert!(election.whitelist_npubs.contains("npub1knownvoter"));
        assert!(election.eligibility_required);
    }

    #[test]
    fn newer_empty_worker_election_config_does_not_clear_nonzero_config() {
        let mut election = ElectionRuntimeState::default();
        let complete_snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(3),
            whitelist_npubs: Some(vec!["npub1knownvoter".to_string()]),
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(true),
            blind_signing_private_key: None,
            definition_reference: None,
            definition: None,
            sent_at: "2026-06-15T20:09:02.000Z".to_string(),
        };
        let newer_empty_snapshot = WorkerElectionConfigSnapshot {
            expected_invitee_count: Some(0),
            whitelist_npubs: Some(vec![]),
            sent_at: "2026-06-15T20:09:03.000Z".to_string(),
            ..complete_snapshot.clone()
        };

        assert!(apply_worker_election_config(
            &mut election,
            &complete_snapshot
        ));
        assert!(!apply_worker_election_config(
            &mut election,
            &newer_empty_snapshot
        ));

        assert_eq!(election.expected_invitee_count, Some(3));
        assert_eq!(
            election.last_election_config_sent_at.as_deref(),
            Some(complete_snapshot.sent_at.as_str())
        );
        assert!(election.whitelist_npubs.contains("npub1knownvoter"));
        assert!(election.eligibility_required);
    }

    #[test]
    fn increased_expected_count_reopens_completion_publications() {
        let mut election = ElectionRuntimeState {
            election_id: "q_worker_definition".to_string(),
            expected_invitee_count: Some(2),
            accepted_response_count: 2,
            summary_published: true,
            last_result_summary_publish_at: Some(now_iso()),
            questionnaire_close_published: true,
            last_questionnaire_close_publish_at: Some(now_iso()),
            ..ElectionRuntimeState::default()
        };
        let snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(3),
            whitelist_npubs: Some(vec!["npub1knownvoter".to_string()]),
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(true),
            blind_signing_private_key: None,
            definition_reference: None,
            definition: None,
            sent_at: "2026-06-16T11:32:05.000Z".to_string(),
        };

        assert!(apply_worker_election_config(&mut election, &snapshot));

        assert_eq!(election.expected_invitee_count, Some(3));
        assert!(!election.summary_published);
        assert!(election.last_result_summary_publish_at.is_none());
        assert!(!election.questionnaire_close_published);
        assert!(election.last_questionnaire_close_publish_at.is_none());
    }

    #[test]
    fn empty_worker_election_config_does_not_block_older_complete_config() {
        let mut election = ElectionRuntimeState::default();
        let complete_snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(3),
            whitelist_npubs: Some(vec!["npub1knownvoter".to_string()]),
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(true),
            blind_signing_private_key: None,
            definition_reference: None,
            definition: None,
            sent_at: "2026-06-15T20:09:02.000Z".to_string(),
        };
        let newer_empty_snapshot = WorkerElectionConfigSnapshot {
            expected_invitee_count: Some(0),
            whitelist_npubs: Some(vec![]),
            sent_at: "2026-06-15T20:09:03.000Z".to_string(),
            ..complete_snapshot.clone()
        };

        assert!(!apply_worker_election_config(
            &mut election,
            &newer_empty_snapshot
        ));
        assert_eq!(election.expected_invitee_count, None);
        assert_eq!(election.last_election_config_sent_at, None);

        assert!(apply_worker_election_config(
            &mut election,
            &complete_snapshot
        ));
        assert_eq!(election.expected_invitee_count, Some(3));
        assert_eq!(
            election.last_election_config_sent_at.as_deref(),
            Some(complete_snapshot.sent_at.as_str())
        );
        assert!(election.whitelist_npubs.contains("npub1knownvoter"));
        assert!(election.eligibility_required);
    }

    #[test]
    fn empty_non_issuance_worker_election_config_can_apply() {
        let mut election = ElectionRuntimeState::default();
        let snapshot = WorkerElectionConfigSnapshot {
            message_type: "worker_election_config".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator000000000000000000000000000000000000000000"
                .to_string(),
            worker_npub: "npub1worker000000000000000000000000000000000000000000000000".to_string(),
            expected_invitee_count: Some(0),
            whitelist_npubs: Some(vec![]),
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(false),
            blind_signing_private_key: None,
            definition_reference: None,
            definition: None,
            sent_at: "2026-06-15T20:09:03.000Z".to_string(),
        };

        assert!(apply_worker_election_config(&mut election, &snapshot));
        assert_eq!(election.expected_invitee_count, Some(0));
        assert_eq!(
            election.last_election_config_sent_at.as_deref(),
            Some(snapshot.sent_at.as_str())
        );
        assert!(election.eligibility_configured);
        assert!(!election.eligibility_required);
    }

    fn active_public_submission_election() -> ElectionRuntimeState {
        ElectionRuntimeState {
            election_id: "q_worker_definition".to_string(),
            delegation_id: "delegation_worker_definition".to_string(),
            capabilities: vec![
                WorkerCapability::VerifyPublicSubmissions,
                WorkerCapability::PublishSubmissionDecisions,
                WorkerCapability::CloseQuestionnaire,
                WorkerCapability::PublishResultSummary,
            ],
            expires_at: (Utc::now() + ChronoDuration::days(1)).to_rfc3339(),
            expected_invitee_count: Some(3),
            definition: Some(json!({
                "schemaVersion": 2,
                "eventType": "questionnaire_definition",
                "questionnaireId": "q_worker_definition",
                "questions": []
            })),
            ..ElectionRuntimeState::default()
        }
    }

    #[test]
    fn public_submission_scan_waits_for_usable_round_config() {
        let mut election = active_public_submission_election();
        assert!(election_should_scan_public_submissions(&election));

        election.expected_invitee_count = None;
        assert!(!election_should_scan_public_submissions(&election));

        election.expected_invitee_count = Some(0);
        assert!(!election_should_scan_public_submissions(&election));

        election.expected_invitee_count = Some(3);
        election.definition = None;
        assert!(!election_should_scan_public_submissions(&election));
    }

    #[test]
    fn public_submission_scan_stops_after_expected_acceptances() {
        let mut election = active_public_submission_election();
        election.accepted_response_count = 2;
        assert!(election_should_scan_public_submissions(&election));

        election.accepted_response_count = 3;
        assert!(!election_should_scan_public_submissions(&election));
    }

    #[test]
    fn deferred_blind_request_blocks_completion_and_termination() {
        let mut election = active_public_submission_election();
        election.accepted_response_count = 3;
        election.deferred_blind_request_ids = HashSet::from(["request_waiting".to_string()]);

        assert!(!election_has_pending_completion_work(&election));
        assert!(election_has_pending_worker_activity(&election));

        let mut state = WorkerPersistentState::default();
        state
            .elections
            .insert(election.election_id.clone(), election.clone());
        assert!(!worker_state_should_terminate_after_completion(&state));

        election.deferred_blind_request_ids.clear();
        election.summary_published = true;
        election.questionnaire_close_published = true;
        let mut state = WorkerPersistentState::default();
        state
            .elections
            .insert(election.election_id.clone(), election);
        assert!(worker_state_should_terminate_after_completion(&state));
    }

    #[test]
    fn worker_does_not_terminate_with_multi_session_work_remaining() {
        let mut completed_session = active_public_submission_election();
        completed_session.election_id = "q_completed_session".to_string();
        completed_session.accepted_response_count = 3;
        completed_session.summary_published = true;
        completed_session.questionnaire_close_published = true;

        let mut incomplete_session = active_public_submission_election();
        incomplete_session.election_id = "q_incomplete_session".to_string();
        incomplete_session.accepted_response_count = 2;

        let mut state = WorkerPersistentState::default();
        state
            .elections
            .insert(completed_session.election_id.clone(), completed_session);
        state
            .elections
            .insert(incomplete_session.election_id.clone(), incomplete_session);

        assert!(!worker_state_should_terminate_after_completion(&state));
    }

    #[test]
    fn worker_does_not_terminate_with_unknown_expected_count_session() {
        let mut completed_session = active_public_submission_election();
        completed_session.election_id = "q_completed_session".to_string();
        completed_session.accepted_response_count = 3;
        completed_session.summary_published = true;
        completed_session.questionnaire_close_published = true;

        let mut unknown_session = active_public_submission_election();
        unknown_session.election_id = "q_unknown_session".to_string();
        unknown_session.expected_invitee_count = None;
        unknown_session.accepted_response_count = 3;
        unknown_session.summary_published = true;
        unknown_session.questionnaire_close_published = true;

        let mut state = WorkerPersistentState::default();
        state
            .elections
            .insert(completed_session.election_id.clone(), completed_session);
        state
            .elections
            .insert(unknown_session.election_id.clone(), unknown_session);

        assert!(!worker_state_should_terminate_after_completion(&state));
    }

    #[test]
    fn public_submission_scan_ignores_revoked_and_expired_rounds() {
        let mut election = active_public_submission_election();
        election.revoked = true;
        assert!(!election_should_scan_public_submissions(&election));

        election.revoked = false;
        election.expires_at = (Utc::now() - ChronoDuration::minutes(1)).to_rfc3339();
        assert!(!election_should_scan_public_submissions(&election));
    }

    #[test]
    fn public_submission_scan_includes_all_configured_live_rounds() {
        let mut old_round = active_public_submission_election();
        old_round.election_id = "q_old_round".to_string();
        old_round.last_election_config_sent_at = Some("2026-06-15T22:00:00Z".to_string());
        old_round.last_vote_verification_at = Some("2026-06-15T22:10:00Z".to_string());

        let mut new_round = active_public_submission_election();
        new_round.election_id = "q_new_round".to_string();
        new_round.last_election_config_sent_at = Some("2026-06-15T22:05:00Z".to_string());

        let mut state = WorkerPersistentState::default();
        state
            .elections
            .insert(old_round.election_id.clone(), old_round);
        state
            .elections
            .insert(new_round.election_id.clone(), new_round);

        assert_eq!(
            select_public_submission_election_ids(&state),
            vec!["q_new_round".to_string(), "q_old_round".to_string()]
        );
    }

    #[test]
    fn status_active_election_ignores_completed_rounds() {
        let mut completed_round = active_public_submission_election();
        completed_round.election_id = "q_completed_round".to_string();
        completed_round.last_election_config_sent_at = Some("2026-06-15T22:00:00Z".to_string());
        completed_round.last_vote_verification_at = Some("2026-06-15T22:10:00Z".to_string());
        completed_round.accepted_response_count = 3;
        completed_round.questionnaire_close_published = true;
        completed_round.summary_published = true;

        let mut new_round = active_public_submission_election();
        new_round.election_id = "q_new_round".to_string();
        new_round.last_election_config_sent_at = Some("2026-06-15T22:05:00Z".to_string());

        let mut state = WorkerPersistentState::default();
        state
            .elections
            .insert(completed_round.election_id.clone(), completed_round);
        state
            .elections
            .insert(new_round.election_id.clone(), new_round);

        let active = select_status_active_election(&state);
        assert_eq!(
            active.map(|entry| entry.election_id.as_str()),
            Some("q_new_round")
        );

        let only_completed = active_public_submission_election();
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_completed_round".to_string(),
            ElectionRuntimeState {
                election_id: "q_completed_round".to_string(),
                accepted_response_count: 3,
                questionnaire_close_published: true,
                summary_published: true,
                last_election_config_sent_at: Some("2026-06-15T22:00:00Z".to_string()),
                ..only_completed
            },
        );

        assert!(select_status_active_election(&state).is_none());
    }

    #[test]
    fn private_invite_code_authorizes_first_claimant_only() {
        let code_hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut election = ElectionRuntimeState {
            election_id: "q_worker_definition".to_string(),
            eligibility_required: true,
            bearer_invite_codes: HashMap::from([(
                code_hash.to_string(),
                BearerInviteCodeEntry {
                    election_id: "q_worker_definition".to_string(),
                    code_hash: code_hash.to_string(),
                    created_at: now_iso(),
                    state: "available".to_string(),
                    redeemed_at: None,
                    redeemed_npub: None,
                    revoked_at: None,
                },
            )]),
            ..ElectionRuntimeState::default()
        };

        let mut request = sample_request();
        request.invite_code_hash = Some(code_hash.to_string());

        assert_eq!(
            authorize_blind_request(&mut election, &request),
            BlindRequestAuthorization::Authorized {
                state_changed: true
            }
        );
        assert!(election.whitelist_npubs.contains(&request.invited_npub));
        assert_eq!(
            election
                .bearer_invite_codes
                .get(code_hash)
                .and_then(|entry| entry.redeemed_npub.as_deref()),
            Some(request.invited_npub.as_str())
        );

        assert_eq!(
            authorize_blind_request(&mut election, &request),
            BlindRequestAuthorization::Authorized {
                state_changed: false
            }
        );

        let mut second_request = sample_request();
        second_request.invited_npub =
            "npub1secondinvitee0000000000000000000000000000000000000000".to_string();
        second_request.invite_code_hash = Some(code_hash.to_string());
        assert_eq!(
            authorize_blind_request(&mut election, &second_request),
            BlindRequestAuthorization::Rejected
        );
    }

    #[test]
    fn unknown_private_invite_code_defers_for_later_config() {
        let mut election = ElectionRuntimeState {
            election_id: "q_worker_definition".to_string(),
            eligibility_configured: true,
            eligibility_required: true,
            ..ElectionRuntimeState::default()
        };
        let mut request = sample_request();
        request.invite_code_hash =
            Some("cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_string());

        assert_eq!(
            authorize_blind_request(&mut election, &request),
            BlindRequestAuthorization::Deferred
        );
    }

    #[test]
    fn unlisted_general_invite_request_defers_for_later_authorisation() {
        let mut election = ElectionRuntimeState {
            election_id: "q_worker_definition".to_string(),
            eligibility_configured: true,
            eligibility_required: true,
            ..ElectionRuntimeState::default()
        };
        let request = sample_request();

        assert_eq!(
            authorize_blind_request(&mut election, &request),
            BlindRequestAuthorization::Deferred
        );
    }

    #[test]
    fn build_blind_issuance_carries_worker_definition_hash() {
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
        let mut request = sample_request();
        request.ballot_scope = Some(json!({
            "questionId": "q1",
            "slotId": "director-alice",
            "slotIndex": 1,
            "version": 1
        }));
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
        assert_eq!(issuance.ballot_scope, request.ballot_scope);
        assert_eq!(issuance.definition, None);
        assert_eq!(
            issuance.definition_hash.as_deref(),
            Some(questionnaire_definition_hash(&definition).as_str())
        );
        assert_eq!(issuance.definition_event_id, None);
        assert_eq!(issuance.issued_at, "2026-04-23T00:00:00Z");
    }

    #[test]
    fn blind_issuance_bundle_carries_definition_hash_without_definition() {
        let definition = json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_definition",
            "questionnaireId": "q_worker_definition",
            "title": "Delegated definition",
            "questions": [{
                "questionId": "q1",
                "prompt": "Question 1",
                "type": "yes_no"
            }]
        });
        let election = ElectionRuntimeState {
            definition: Some(definition.clone()),
            ..ElectionRuntimeState::default()
        };
        let mut first_request = sample_request();
        first_request.ballot_scope = Some(json!({
            "questionId": "q1",
            "slotId": "q1:1",
            "slotIndex": 1,
            "version": 1
        }));
        let mut second_request = sample_request();
        second_request.request_id = "request_worker_definition_q2".to_string();
        second_request.ballot_scope = Some(json!({
            "questionId": "q2",
            "slotId": "q2:1",
            "slotIndex": 2,
            "version": 1
        }));

        let envelope = build_blind_issuance_bundle_envelope(&[
            build_blind_issuance(
                &first_request,
                &election,
                "blind_signature_worker_definition_q1".to_string(),
                "2026-04-23T00:00:00Z".to_string(),
            ),
            build_blind_issuance(
                &second_request,
                &election,
                "blind_signature_worker_definition_q2".to_string(),
                "2026-04-23T00:00:01Z".to_string(),
            ),
        ]);

        assert_eq!(envelope.definition, None);
        assert_eq!(
            envelope.definition_hash.as_deref(),
            Some(questionnaire_definition_hash(&definition).as_str())
        );
        assert_eq!(envelope.issuances.len(), 2);
        assert!(envelope
            .issuances
            .iter()
            .all(|issuance| issuance.definition.is_none()));
        let serialized = serde_json::to_value(&envelope).expect("serialize bundle");
        assert!(serialized.get("definition").is_none());
        assert_eq!(
            serialized
                .get("definitionHash")
                .and_then(|entry| entry.as_str()),
            Some(questionnaire_definition_hash(&definition).as_str())
        );
        for issuance in serialized["issuances"]
            .as_array()
            .expect("serialized issuances")
        {
            assert!(issuance.get("definition").is_none());
            assert_eq!(
                issuance
                    .get("definitionHash")
                    .and_then(|entry| entry.as_str()),
                Some(questionnaire_definition_hash(&definition).as_str())
            );
        }
    }

    #[test]
    fn small_bundle_content_stays_plain_json() {
        let envelope = BlindBallotRequestBundleEnvelope {
            message_type: "optiona_blind_request_bundle_dm".to_string(),
            schema_version: 1,
            requests: vec![sample_request()],
            sent_at: "2026-04-23T00:00:00Z".to_string(),
        };
        let content = serde_json::to_string(&envelope).expect("serialize request bundle");
        let encoded = maybe_compress_bundle_content(
            content,
            "optiona_blind_request_bundle_dm",
            "2026-04-23T00:00:00Z",
        )
        .expect("encode bundle");
        let value: serde_json::Value =
            serde_json::from_str(&encoded).expect("parse encoded bundle");

        assert_eq!(
            value.get("type").and_then(|entry| entry.as_str()),
            Some("optiona_blind_request_bundle_dm")
        );
    }

    #[test]
    fn compressed_request_bundle_decodes_to_inner_envelope() {
        let mut request = sample_request();
        request.blinded_message = format!("blind_{}", "x".repeat(16_000));
        let envelope = BlindBallotRequestBundleEnvelope {
            message_type: "optiona_blind_request_bundle_dm".to_string(),
            schema_version: 1,
            requests: vec![request],
            sent_at: "2026-04-23T00:00:00Z".to_string(),
        };
        let content = serde_json::to_string(&envelope).expect("serialize request bundle");
        let encoded = maybe_compress_bundle_content(
            content,
            "optiona_blind_request_bundle_dm",
            "2026-04-23T00:00:00Z",
        )
        .expect("encode bundle");
        let wrapper: serde_json::Value =
            serde_json::from_str(&encoded).expect("parse encoded bundle");

        assert_eq!(
            wrapper.get("type").and_then(|entry| entry.as_str()),
            Some(COMPRESSED_BUNDLE_MESSAGE_TYPE)
        );

        let decoded = unwrap_compressed_bundle_value(wrapper).expect("decode compressed bundle");
        let decoded_envelope: BlindBallotRequestBundleEnvelope =
            serde_json::from_value(decoded).expect("decode request bundle");

        assert_eq!(
            decoded_envelope.message_type,
            "optiona_blind_request_bundle_dm"
        );
        assert_eq!(decoded_envelope.requests.len(), 1);
        assert!(decoded_envelope.requests[0].blinded_message.len() > 16_000);
    }

    #[test]
    fn delegated_issuance_duplicate_guard_is_scoped() {
        let mut election = ElectionRuntimeState::default();
        let mut first_request = sample_request();
        first_request.ballot_scope = Some(json!({
            "questionId": "q1",
            "slotId": "director-alice",
            "slotIndex": 1,
            "version": 1
        }));
        let mut second_request = sample_request();
        second_request.request_id = "request_worker_definition_q2".to_string();
        second_request.ballot_scope = Some(json!({
            "questionId": "q2",
            "slotId": "director-bob",
            "slotIndex": 2,
            "version": 1
        }));

        record_issuance_for_request(&mut election, &first_request);

        assert!(has_existing_issuance_for_request(&election, &first_request));
        assert!(!has_existing_issuance_for_request(
            &election,
            &second_request
        ));

        let mut grouped_request = sample_request();
        grouped_request.request_id = "request_worker_definition_grouped".to_string();
        grouped_request.ballot_scope = Some(json!({
            "questionId": "q2",
            "slotId": "director-alice",
            "slotIndex": 1,
            "version": 1
        }));

        assert!(has_existing_issuance_for_request(
            &election,
            &grouped_request
        ));
    }

    #[test]
    fn delegated_issuance_duplicate_guard_preserves_unscoped_legacy_block() {
        let mut election = ElectionRuntimeState::default();
        let first_request = sample_request();
        let mut duplicate_request = sample_request();
        duplicate_request.request_id = "request_worker_definition_duplicate".to_string();

        record_issuance_for_request(&mut election, &first_request);

        assert!(has_existing_issuance_for_request(
            &election,
            &duplicate_request
        ));
        assert!(election
            .issued_invited_npubs
            .contains(&first_request.invited_npub));
    }

    #[test]
    fn legacy_per_question_state_requests_control_replay() {
        let election = ElectionRuntimeState {
            expires_at: (Utc::now() + ChronoDuration::days(1)).to_rfc3339(),
            definition: Some(json!({
                "questionnaireId": "q_worker_definition",
                "ballotCredentialMode": "per_question",
                "questions": [{
                    "questionId": "q1",
                    "ballotSlot": {
                        "slotId": "q1",
                        "slotIndex": 1,
                        "version": 1
                    }
                }]
            })),
            blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                scheme: "rsabssa-sha384-pss-deterministic-v1".to_string(),
                key_id: "key_worker_definition".to_string(),
                jwk: serde_json::json!({}),
                private_jwk: serde_json::json!({}),
            }),
            seen_blind_request_ids: HashSet::from(["request_worker_definition".to_string()]),
            ..ElectionRuntimeState::default()
        };

        assert!(election_needs_legacy_control_replay(&election));
    }

    #[test]
    fn stale_delegation_replay_is_ignored_by_issued_at() {
        let current = WorkerDelegationCertificate {
            message_type: "worker_delegation".to_string(),
            schema_version: 1,
            delegation_id: "delegation_new".to_string(),
            election_id: "q_worker_definition".to_string(),
            coordinator_npub: "npub1coordinator".to_string(),
            worker_npub: "npub1worker".to_string(),
            capabilities: vec![WorkerCapability::IssueBlindTokens],
            control_relays: vec!["wss://relay.nostr.net".to_string()],
            issued_at: "2026-06-15T12:06:27.924Z".to_string(),
            expires_at: "2036-06-12T12:06:27.924Z".to_string(),
        };
        let incoming = WorkerDelegationCertificate {
            delegation_id: "delegation_old".to_string(),
            issued_at: "2026-06-15T12:05:59.424Z".to_string(),
            ..current.clone()
        };

        assert!(is_stale_delegation_replay(Some(&current), &incoming));
        assert!(!is_stale_delegation_replay(Some(&incoming), &current));
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
    fn worker_dependency_log_overrides_are_valid() {
        let _ = build_worker_log_filter();
        let mut filter = EnvFilter::new(WORKER_DEFAULT_LOG_FILTER);
        for directive in WORKER_DEPENDENCY_LOG_OVERRIDES {
            filter = filter.add_directive(directive.parse().unwrap());
        }
        drop(filter);
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

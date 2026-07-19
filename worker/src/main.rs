mod config;
mod model;
mod store;

use crate::config::WorkerConfig;
use crate::model::{
    is_expired, now_iso, BearerInviteCodeEntry, BlindBallotIssuance,
    BlindBallotIssuanceBundleEnvelope, BlindBallotIssuanceEnvelope, BlindBallotRequest,
    BlindBallotRequestBundleEnvelope, BlindBallotRequestEnvelope, BlindIssuanceAck,
    BlindIssuanceAckEnvelope, BlindTokenProof, CompressedBundleEnvelope, ElectionRuntimeState,
    GeneralInvitePowProof,
    OptionAParticipantStatus, OptionAParticipantStatusEnvelope, OptionAParticipantStatusState,
    QuestionnaireBlindResponseEvent, QuestionnairePublishedResponseRef,
    QuestionnaireSubmissionDecisionEvent, WorkerCapability, WorkerDelegationCertificate,
    WorkerDelegationEnvelope, WorkerDelegationRevocation, WorkerElectionConfigEnvelope,
    WorkerElectionConfigSnapshot, WorkerPersistentState, WorkerRevocationEnvelope,
    WorkerStatusEnvelope, WorkerStatusSnapshot,
    IMPLEMENTATION_KIND_QUESTIONNAIRE_RESPONSE_BLIND,
    IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY, IMPLEMENTATION_KIND_QUESTIONNAIRE_STATE,
    IMPLEMENTATION_KIND_QUESTIONNAIRE_SUBMISSION_DECISION,
};
#[cfg(test)]
use crate::model::IMPLEMENTATION_KIND_QUESTIONNAIRE_DEFINITION;
use crate::store::WorkerStore;
use anyhow::{Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use blind_rsa_signatures::{
    PublicKeySha384PSSDeterministic, SecretKeySha384PSSDeterministic, Signature,
};
use chrono::Utc;
use crypto_bigint::BoxedUint;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use nostr_sdk::prelude::*;
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE};
use rsa::{RsaPrivateKey, RsaPublicKey};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{mpsc, Mutex, Semaphore};
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
const WORKER_RELAY_CONNECT_TIMEOUT_SECS: u64 = 8;
const PRIVATE_DM_SEND_TIMEOUT_SECS: u64 = 12;
const PUBLIC_ARCHIVE_SEND_TIMEOUT_SECS: u64 = 10;
const BLOSSOM_AUTH_KIND: u16 = 24_242;
const BLOSSOM_RESULT_PACK_TARGET_UPLOADS: usize = 2;
const BLOSSOM_RESULT_PACK_CSV_CONTENT_TYPE: &str = "text/csv; charset=utf-8";
const BLOSSOM_RESULT_PACK_TYPE: &str = "text/csv";
const BLOSSOM_RESULT_PACK_UPLOAD_ENCODING: &str = "csv";
const BLOSSOM_RESULT_PACK_UPLOAD_TIMEOUT_SECS: u64 = 12;
const COMPLETION_CLOSE_GRACE_SECS: u64 = 5;
const COMPRESSED_BUNDLE_MESSAGE_TYPE: &str = "optiona_compressed_bundle_dm";
const COMPRESSED_BUNDLE_ENCODING: &str = "gzip+base64url";
const BUNDLE_COMPRESSION_THRESHOLD_BYTES: usize = 8 * 1024;
const GENERAL_INVITE_POW_DOMAIN: &str = "auditable-voting-general-invite-pow:v1";
const GENERAL_INVITE_POW_MAX_DIFFICULTY: u8 = 24;
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
    "wss://relay.layer.systems",
    "wss://nostr.bond",
    "wss://auth.nostr1.com",
    "wss://inbox.nostr.wine",
    "wss://nostr-pub.wellorder.net",
];
const PRIVATE_DM_REJECTING_RELAYS: &[&str] = &[
    // Public questionnaire relay. It currently rejects NIP-17 gift wraps with
    // "kind 1059 not permitted", so keep it out of worker private DM publish/read paths.
    "wss://relay.nostr.info",
    // These currently require unsupported browser read auth or reject worker connections.
    "wss://nip17.com",
    "wss://relay.0xchat.com",
];
const PRIVATE_DM_FALLBACK_RELAYS: &[&str] = &[
    "wss://vm-1734.lnvps.cloud/",
    "wss://relay.nostr.net",
    "wss://nos.lol",
];
const WORKER_RELAY_INITIAL_BACKOFF_SECS: u64 = 60;
const WORKER_RELAY_MAX_BACKOFF_SECS: u64 = 60 * 60;
const WORKER_RELAY_FAILURES_BEFORE_BACKOFF: u32 = 2;
#[cfg(test)]
const DISCOURAGED_RELAY_INITIAL_BACKOFF_SECS: u64 = WORKER_RELAY_INITIAL_BACKOFF_SECS;
#[cfg(test)]
const DISCOURAGED_RELAY_MAX_BACKOFF_SECS: u64 = WORKER_RELAY_MAX_BACKOFF_SECS;
const PUBLIC_RESPONSE_CONCURRENCY: usize = 16;
const CONTROL_BLIND_REQUEST_QUEUE_SIZE: usize = 1024;
const CONTROL_BLIND_REQUEST_BATCH_MAX_REQUESTS: usize = 128;
const CONTROL_BLIND_REQUEST_BATCH_INTERVAL_MS: u64 = 75;

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

fn decode_hex_bytes(input: &str, label: &str) -> Result<Vec<u8>> {
    let clean = input.trim();
    if clean.is_empty() || clean.len() % 2 != 0 {
        anyhow::bail!("invalid {label} encoding");
    }
    let mut bytes = Vec::with_capacity(clean.len() / 2);
    for chunk in clean.as_bytes().chunks(2) {
        let pair = std::str::from_utf8(chunk).with_context(|| format!("invalid {label} bytes"))?;
        let value = u8::from_str_radix(pair, 16).with_context(|| format!("invalid {label} hex"))?;
        bytes.push(value);
    }
    Ok(bytes)
}

fn sign_blinded_message(blinded_hex: &str, private_jwk: &serde_json::Value) -> Result<String> {
    let blinded_bytes = decode_hex_bytes(blinded_hex, "blinded message")?;
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

fn sha256_hex_bytes(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn questionnaire_definition_hash(definition: &serde_json::Value) -> String {
    sha256_hex(&canonical_json(definition))
}

fn get_scope_string(scope: &serde_json::Value, camel_key: &str, snake_key: &str) -> Option<String> {
    scope
        .get(camel_key)
        .or_else(|| scope.get(snake_key))?
        .as_str()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
}

fn get_scope_value<'a>(
    scope: &'a serde_json::Value,
    camel_key: &str,
    snake_key: &str,
) -> Option<&'a serde_json::Value> {
    scope.get(camel_key).or_else(|| scope.get(snake_key))
}

fn get_scope_positive_integer(
    scope: &serde_json::Value,
    camel_key: &str,
    snake_key: &str,
) -> Option<u64> {
    let value = scope.get(camel_key).or_else(|| scope.get(snake_key))?;
    let as_integer = value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|entry| u64::try_from(entry).ok()))
        .or_else(|| {
            value.as_f64().and_then(|entry| {
                if entry.is_finite() && entry >= 1.0 {
                    Some(entry.floor() as u64)
                } else {
                    None
                }
            })
        })?;
    (as_integer >= 1).then_some(as_integer)
}

fn normalize_scope_label(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "main" || normalized == "0" {
        return Some("0".to_string());
    }
    match normalized.as_str() {
        "a" => Some("1".to_string()),
        "b" => Some("2".to_string()),
        "c" => Some("3".to_string()),
        _ if valid_voter_group_id(&normalized) => Some(normalized),
        _ => None,
    }
}

fn valid_voter_group_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn normalize_allowed_scopes(
    value: Option<&serde_json::Value>,
    fallback_scope: Option<&str>,
) -> Vec<String> {
    let mut scopes = vec!["0".to_string()];
    if let Some(entries) = value.and_then(|entry| entry.as_array()) {
        for entry in entries {
            let Some(scope) = entry.as_str().and_then(normalize_scope_label) else {
                continue;
            };
            if !scopes.contains(&scope) {
                scopes.push(scope);
            }
        }
    }
    if let Some(scope) = fallback_scope.and_then(normalize_ballot_group) {
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    scopes[1..].sort();
    scopes
}

fn scope_allowed_scopes(scope: &Option<serde_json::Value>) -> Vec<String> {
    let Some(scope) = scope.as_ref() else {
        return vec!["0".to_string()];
    };
    let fallback = get_scope_string(scope, "ballotGroup", "ballot_group");
    normalize_allowed_scopes(
        get_scope_value(scope, "allowedScopes", "allowed_scopes"),
        fallback.as_deref(),
    )
}

fn normalise_blind_token_scope(scope: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let scope = scope?;
    let question_id = get_scope_string(scope, "questionId", "question_id");
    let slot_id = get_scope_string(scope, "slotId", "slot_id");
    let ballot_group = get_scope_string(scope, "ballotGroup", "ballot_group")
        .and_then(|value| normalize_ballot_group(&value));
    let allowed_scopes = normalize_allowed_scopes(
        get_scope_value(scope, "allowedScopes", "allowed_scopes"),
        ballot_group.as_deref(),
    );
    let include_allowed_scopes = get_scope_value(scope, "allowedScopes", "allowed_scopes")
        .is_some()
        || ballot_group.is_some();
    let slot_index = get_scope_positive_integer(scope, "slotIndex", "slot_index");
    let version = get_scope_positive_integer(scope, "version", "version");
    let credential_index = get_scope_positive_integer(scope, "credentialIndex", "credential_index");
    if question_id.is_none()
        && slot_id.is_none()
        && ballot_group.is_none()
        && slot_index.is_none()
        && version.is_none()
        && credential_index.is_none()
        && !include_allowed_scopes
    {
        return None;
    }
    let mut map = serde_json::Map::new();
    if let Some(value) = question_id {
        map.insert("question_id".to_string(), serde_json::Value::String(value));
    }
    if let Some(value) = slot_id {
        map.insert("slot_id".to_string(), serde_json::Value::String(value));
    }
    if include_allowed_scopes {
        map.insert(
            "allowed_scopes".to_string(),
            serde_json::Value::Array(
                allowed_scopes
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            ),
        );
    }
    if let Some(value) = slot_index {
        map.insert(
            "slot_index".to_string(),
            serde_json::Value::Number(serde_json::Number::from(value)),
        );
    }
    if let Some(value) = version {
        map.insert(
            "version".to_string(),
            serde_json::Value::Number(serde_json::Number::from(value)),
        );
    }
    if let Some(value) = credential_index.filter(|value| *value > 1) {
        map.insert(
            "credential_index".to_string(),
            serde_json::Value::Number(serde_json::Number::from(value)),
        );
    }
    Some(serde_json::Value::Object(map))
}

fn build_blind_token_signed_message(
    questionnaire_id: &str,
    token_commitment: &str,
    ballot_scope: Option<&serde_json::Value>,
) -> String {
    let mut map = serde_json::Map::new();
    map.insert(
        "questionnaire_id".to_string(),
        serde_json::Value::String(questionnaire_id.to_string()),
    );
    map.insert(
        "response_mode".to_string(),
        serde_json::Value::String("blind_token".to_string()),
    );
    map.insert(
        "schema_version".to_string(),
        serde_json::Value::Number(serde_json::Number::from(1_u64)),
    );
    map.insert(
        "token_secret_commitment".to_string(),
        serde_json::Value::String(token_commitment.to_string()),
    );
    if let Some(scope) = normalise_blind_token_scope(ballot_scope) {
        map.insert("ballot_scope".to_string(), scope);
    }
    canonical_json(&serde_json::Value::Object(map))
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

fn persistent_state_identity_mismatch(
    state: &WorkerPersistentState,
    worker_npub: &str,
    coordinator_npub: &str,
) -> bool {
    (!state.worker_npub.is_empty() && state.worker_npub != worker_npub)
        || (!state.coordinator_npub.is_empty() && state.coordinator_npub != coordinator_npub)
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
    if let Some(proxy_voter_npubs) = &snapshot.proxy_voter_npubs {
        election.proxy_voter_npubs = proxy_voter_npubs
            .iter()
            .map(|entry| entry.trim().to_string())
            .filter(|entry| !entry.is_empty())
            .collect();
    }
    if let Some(ballot_groups_by_npub) = &snapshot.ballot_groups_by_npub {
        election.ballot_groups_by_npub = ballot_groups_by_npub
            .iter()
            .filter_map(|(npub, group)| {
                let npub = npub.trim();
                normalize_ballot_group(group)
                    .map(|normalised_group| (npub.to_string(), normalised_group))
            })
            .filter(|(npub, _)| !npub.is_empty())
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

fn definition_general_invite_pow_difficulty(definition: &serde_json::Value) -> Option<u8> {
    match definition.get("generalInvitePowDifficulty") {
        None => Some(0),
        Some(value) => value
            .as_f64()
            .filter(|difficulty| {
                difficulty.is_finite()
                    && *difficulty >= 0.0
                    && *difficulty <= f64::from(GENERAL_INVITE_POW_MAX_DIFFICULTY)
                    && difficulty.fract() == 0.0
            })
            .map(|difficulty| difficulty as u8),
    }
}

fn is_decimal_nonce(nonce: &str) -> bool {
    nonce == "0"
        || (nonce
            .as_bytes()
            .first()
            .is_some_and(|byte| *byte >= b'1' && *byte <= b'9')
            && nonce.as_bytes().iter().all(u8::is_ascii_digit))
}

fn general_invite_pow_preimage(request: &BlindBallotRequest, nonce: &str) -> String {
    serde_json::to_string(&[
        GENERAL_INVITE_POW_DOMAIN,
        request.election_id.as_str(),
        request.request_id.as_str(),
        request.invited_npub.as_str(),
        request.blind_signing_key_id.as_str(),
        request.blinded_message.as_str(),
        request.client_nonce.as_str(),
        nonce,
    ])
    .expect("fixed general-invite PoW array serializes")
}

fn has_leading_zero_bits(digest: &[u8], difficulty: u8) -> bool {
    let full_bytes = (difficulty / 8) as usize;
    if digest.iter().take(full_bytes).any(|byte| *byte != 0) {
        return false;
    }
    let remaining_bits = difficulty % 8;
    remaining_bits == 0
        || digest
            .get(full_bytes)
            .is_some_and(|byte| *byte & (0xff << (8 - remaining_bits)) == 0)
}

fn verify_general_invite_pow(
    definition: &serde_json::Value,
    request: &BlindBallotRequest,
) -> bool {
    let Some(difficulty) = definition_general_invite_pow_difficulty(definition) else {
        return false;
    };
    if difficulty == 0
        || request
            .invite_code_hash
            .as_deref()
            .is_some_and(|hash| !hash.trim().is_empty())
    {
        return true;
    }
    let Some(GeneralInvitePowProof { nonce }) = request.general_invite_pow.as_ref() else {
        return false;
    };
    is_decimal_nonce(nonce)
        && has_leading_zero_bits(
            &Sha256::digest(general_invite_pow_preimage(request, nonce).as_bytes()),
            difficulty,
        )
}

fn definition_value_blind_signing_public_jwk(
    definition: &serde_json::Value,
) -> Option<&serde_json::Value> {
    definition.get("blindSigningPublicKey")?.get("jwk")
}

fn public_key_from_jwk(jwk: &serde_json::Value) -> Result<PublicKeySha384PSSDeterministic> {
    let n = parse_jwk_component(jwk, "n")?;
    let e = parse_jwk_component(jwk, "e")?;
    let key = RsaPublicKey::new(n, e).context("unable to construct RSA public key from JWK")?;
    Ok(PublicKeySha384PSSDeterministic::new(key))
}

fn blind_response_proofs(submission: &QuestionnaireBlindResponseEvent) -> Vec<&BlindTokenProof> {
    if submission.token_proofs.is_empty() {
        vec![&submission.token_proof]
    } else {
        submission.token_proofs.iter().collect()
    }
}

fn blind_response_nullifiers(submission: &QuestionnaireBlindResponseEvent) -> Vec<String> {
    let mut values = if submission.token_nullifiers.is_empty() {
        vec![submission.token_nullifier.trim().to_string()]
    } else {
        submission
            .token_nullifiers
            .iter()
            .map(|entry| entry.token_nullifier.trim().to_string())
            .collect::<Vec<_>>()
    };
    values.retain(|entry| !entry.is_empty());
    values
}

fn verify_blind_response_proof(
    public_key: &PublicKeySha384PSSDeterministic,
    submission: &QuestionnaireBlindResponseEvent,
    proof: &BlindTokenProof,
) -> bool {
    if proof.questionnaire_id.trim() != submission.questionnaire_id.trim()
        || proof.token_commitment.trim().is_empty()
        || proof.signature.trim().is_empty()
    {
        return false;
    }
    let signature = match decode_hex_bytes(&proof.signature, "blind token signature") {
        Ok(bytes) => Signature(bytes),
        Err(_) => return false,
    };
    let message = build_blind_token_signed_message(
        &submission.questionnaire_id,
        proof.token_commitment.trim(),
        proof.ballot_scope.as_ref(),
    );
    public_key
        .verify(&signature, None, message.as_bytes())
        .is_ok()
}

fn verify_blind_response_proofs(
    election: &ElectionRuntimeState,
    submission: &QuestionnaireBlindResponseEvent,
) -> bool {
    let Some(definition) = election.definition.as_ref() else {
        return false;
    };
    let Some(jwk) = definition_value_blind_signing_public_jwk(definition) else {
        return false;
    };
    let Ok(public_key) = public_key_from_jwk(jwk) else {
        return false;
    };
    let proofs = blind_response_proofs(submission);
    if proofs.is_empty() {
        return false;
    }
    proofs
        .iter()
        .all(|proof| verify_blind_response_proof(&public_key, submission, proof))
}

fn answer_question_ids(submission: &QuestionnaireBlindResponseEvent) -> Vec<String> {
    submission
        .answers
        .iter()
        .filter_map(|answer| answer.get("questionId").and_then(|entry| entry.as_str()))
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_string)
        .collect()
}

fn definition_question_required_scope(
    definition: &serde_json::Value,
    question_id: &str,
) -> Option<Option<String>> {
    definition
        .get("questions")?
        .as_array()?
        .iter()
        .find(|question| {
            question
                .get("questionId")
                .and_then(|entry| entry.as_str())
                .map(str::trim)
                == Some(question_id)
        })
        .map(|question| {
            question
                .get("requiredScope")
                .or_else(|| question.get("required_scope"))
                .or_else(|| question.get("ballotGroup"))
                .and_then(|entry| entry.as_str())
                .and_then(normalize_ballot_group)
        })
}

fn allowed_scopes_allow_question(allowed_scopes: &[String], required_scope: Option<&str>) -> bool {
    let required = required_scope
        .and_then(normalize_ballot_group)
        .unwrap_or_else(|| "0".to_string());
    required == "0" || allowed_scopes.iter().any(|entry| entry == &required)
}

fn submission_answers_authorized_for_proofs(
    election: &ElectionRuntimeState,
    submission: &QuestionnaireBlindResponseEvent,
) -> bool {
    let Some(definition) = election.definition.as_ref() else {
        return false;
    };
    let proof_allowed_scopes = blind_response_proofs(submission)
        .into_iter()
        .map(|proof| scope_allowed_scopes(&proof.ballot_scope))
        .collect::<Vec<_>>();
    if proof_allowed_scopes.is_empty() {
        return false;
    }
    for question_id in answer_question_ids(submission) {
        let Some(required_scope) = definition_question_required_scope(definition, &question_id)
        else {
            return false;
        };
        if !proof_allowed_scopes.iter().any(|allowed_scopes| {
            allowed_scopes_allow_question(allowed_scopes, required_scope.as_deref())
        }) {
            return false;
        }
    }
    true
}

fn blind_response_token_commitments(submission: &QuestionnaireBlindResponseEvent) -> Vec<String> {
    blind_response_proofs(submission)
        .into_iter()
        .map(|proof| proof.token_commitment.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
}

fn definition_blind_signing_key_id(definition: &Option<serde_json::Value>) -> Option<String> {
    definition
        .as_ref()
        .and_then(definition_value_blind_signing_key_id)
}

#[cfg(test)]
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

fn normalize_ballot_group(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "main" || normalized == "0" {
        return None;
    }
    match normalized.as_str() {
        "a" => Some("1".to_string()),
        "b" => Some("2".to_string()),
        "c" => Some("3".to_string()),
        _ if valid_voter_group_id(&normalized) => Some(normalized),
        _ => None,
    }
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
            (_, "available" | "redeemed" | "revoked") => {
                let mut next = incoming.clone();
                next.code_hash = code_hash.clone();
                next.ballot_group = next
                    .ballot_group
                    .as_deref()
                    .and_then(normalize_ballot_group);
                next
            }
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

fn deferred_blind_request_ready_for_retry(
    election: &ElectionRuntimeState,
    request: &BlindBallotRequest,
) -> bool {
    election.whitelist_npubs.contains(&request.invited_npub)
        || request
            .invite_code_hash
            .as_ref()
            .is_some_and(|code_hash| election.bearer_invite_codes.contains_key(code_hash))
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
    let carries_worker_material = snapshot.blind_signing_private_key.is_some()
        || snapshot.definition_reference.is_some()
        || snapshot.definition.is_some();
    let existing_has_eligibility = known_expected_invitee_count(election).is_some()
        || !election.whitelist_npubs.is_empty()
        || !election.bearer_invite_codes.is_empty();
    if carries_worker_material && !existing_has_eligibility {
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
        if !blind_request_ballot_group_authorized(election, request) {
            return BlindRequestAuthorization::Rejected;
        }
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
        let expected_ballot_group = entry.ballot_group.as_deref();
        let requested_ballot_group = ballot_scope_group(&request.ballot_scope);
        if !allowed_scope_request_matches(expected_ballot_group, &request.ballot_scope) {
            return BlindRequestAuthorization::Rejected;
        }
        match entry.state.as_str() {
            "available" => {
                let redeemed_at = now_iso();
                entry.state = "redeemed".to_string();
                entry.redeemed_at = Some(redeemed_at);
                entry.redeemed_npub = Some(request.invited_npub.clone());
                election
                    .whitelist_npubs
                    .insert(request.invited_npub.clone());
                if let Some(ballot_group) = requested_ballot_group.clone() {
                    election
                        .ballot_groups_by_npub
                        .insert(request.invited_npub.clone(), ballot_group);
                }
                if entry.credentials_per_voter.unwrap_or(1) >= 2 {
                    election
                        .proxy_voter_npubs
                        .insert(request.invited_npub.clone());
                }
                return BlindRequestAuthorization::Authorized {
                    state_changed: true,
                };
            }
            "redeemed" if entry.redeemed_npub.as_deref() == Some(request.invited_npub.as_str()) => {
                let inserted = election
                    .whitelist_npubs
                    .insert(request.invited_npub.clone());
                let group_inserted = if let Some(ballot_group) = requested_ballot_group.clone() {
                    election
                        .ballot_groups_by_npub
                        .insert(request.invited_npub.clone(), ballot_group)
                        .is_none()
                } else {
                    false
                };
                let proxy_inserted = if entry.credentials_per_voter.unwrap_or(1) >= 2 {
                    election
                        .proxy_voter_npubs
                        .insert(request.invited_npub.clone())
                } else {
                    false
                };
                return BlindRequestAuthorization::Authorized {
                    state_changed: inserted || proxy_inserted || group_inserted,
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

fn ballot_scope_key(scope: &Option<serde_json::Value>) -> String {
    let Some(scope) = scope else {
        return "__questionnaire__".to_string();
    };
    let question_id = get_scope_string(scope, "questionId", "question_id").unwrap_or_default();
    let slot_id = get_scope_string(scope, "slotId", "slot_id").unwrap_or_default();
    let allowed_scopes = scope_allowed_scopes(&Some(scope.clone()))
        .into_iter()
        .filter(|entry| entry != "0")
        .collect::<Vec<_>>();
    let version = get_scope_positive_integer(scope, "version", "version").unwrap_or(0);
    let slot_index = get_scope_positive_integer(scope, "slotIndex", "slot_index").unwrap_or(0);
    let credential_index =
        get_scope_positive_integer(scope, "credentialIndex", "credential_index").unwrap_or(1);
    let credential_suffix = if credential_index > 1 {
        format!(":c{credential_index}")
    } else {
        String::new()
    };
    let scope_prefix = if allowed_scopes.is_empty() {
        String::new()
    } else {
        format!("scopes:{}:", allowed_scopes.join("+"))
    };
    if question_id.is_empty()
        && slot_id.is_empty()
        && version == 0
        && slot_index == 0
        && credential_index <= 1
        && allowed_scopes.is_empty()
    {
        return "__questionnaire__".to_string();
    }
    if question_id.is_empty()
        && slot_id.is_empty()
        && version == 0
        && slot_index == 0
        && !allowed_scopes.is_empty()
    {
        return format!("{scope_prefix}questionnaire{credential_suffix}");
    }
    if slot_index > 0 {
        return format!(
            "{scope_prefix}slot:{}:v{}{}",
            slot_index,
            if version == 0 { 1 } else { version },
            credential_suffix
        );
    }
    format!(
        "{scope_prefix}{}:{}:{}:v{}{}",
        if question_id.is_empty() {
            &slot_id
        } else {
            &question_id
        },
        slot_id,
        slot_index,
        if version == 0 { 1 } else { version },
        credential_suffix
    )
}

fn ballot_scope_credential_index(scope: &Option<serde_json::Value>) -> u64 {
    scope
        .as_ref()
        .and_then(|entry| get_scope_positive_integer(entry, "credentialIndex", "credential_index"))
        .unwrap_or(1)
}

fn ballot_scope_group(scope: &Option<serde_json::Value>) -> Option<String> {
    scope_allowed_scopes(scope)
        .into_iter()
        .find(|entry| entry != "0")
}

fn expected_allowed_scopes(expected: Option<&str>) -> Vec<String> {
    normalize_allowed_scopes(None, expected)
}

fn allowed_scope_request_matches(
    expected: Option<&str>,
    requested_scope: &Option<serde_json::Value>,
) -> bool {
    expected_allowed_scopes(expected) == scope_allowed_scopes(requested_scope)
}

fn blind_request_ballot_group_authorized(
    election: &ElectionRuntimeState,
    request: &BlindBallotRequest,
) -> bool {
    let expected = election
        .ballot_groups_by_npub
        .get(&request.invited_npub)
        .map(String::as_str);
    allowed_scope_request_matches(expected, &request.ballot_scope)
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

fn blind_request_proxy_authorized(
    election: &ElectionRuntimeState,
    request: &BlindBallotRequest,
) -> bool {
    ballot_scope_credential_index(&request.ballot_scope) <= 1
        || election.proxy_voter_npubs.contains(&request.invited_npub)
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

fn blind_issuance_ack_matches(
    authenticated_sender: &str,
    ack: &BlindIssuanceAck,
    election: Option<&ElectionRuntimeState>,
) -> bool {
    if ack.message_type != "blind_ballot_issuance_ack"
        || ack.schema_version != 1
        || authenticated_sender != ack.invited_npub
    {
        return false;
    }
    election
        .and_then(|entry| entry.issued_issuances_by_request_id.get(&ack.request_id))
        .is_some_and(|issuance| {
            issuance.election_id == ack.election_id
                && issuance.request_id == ack.request_id
                && issuance.issuance_id == ack.issuance_id
                && issuance.invited_npub == ack.invited_npub
        })
}

fn build_participant_status_envelope(
    election_id: &str,
    invited_npub: &str,
    status_state: OptionAParticipantStatusState,
    request_id: Option<&str>,
    issuance_id: Option<&str>,
) -> OptionAParticipantStatusEnvelope {
    OptionAParticipantStatusEnvelope {
        message_type: "optiona_participant_status_dm".to_string(),
        schema_version: 1,
        status: OptionAParticipantStatus {
            message_type: "participant_status".to_string(),
            schema_version: 1,
            election_id: election_id.to_string(),
            invited_npub: invited_npub.to_string(),
            source: "issuer_proxy".to_string(),
            state: status_state,
            observed_at: now_iso(),
            request_id: request_id.map(str::to_string),
            issuance_id: issuance_id.map(str::to_string),
        },
        sent_at: now_iso(),
    }
}

fn remember_deferred_blind_request(
    election: &mut ElectionRuntimeState,
    request: &BlindBallotRequest,
) {
    election
        .deferred_blind_request_ids
        .insert(request.request_id.clone());
    election
        .deferred_blind_requests
        .insert(request.request_id.clone(), request.clone());
}

fn forget_deferred_blind_request(election: &mut ElectionRuntimeState, request_id: &str) {
    election.deferred_blind_request_ids.remove(request_id);
    election.deferred_blind_requests.remove(request_id);
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
    queued_control_event_ids: Arc<Mutex<HashSet<String>>>,
    public_response_permits: Arc<Semaphore>,
    public_archive_sender: Option<mpsc::Sender<PublicArchiveJob>>,
    control_blind_request_sender: mpsc::Sender<ControlBlindRequestJob>,
}

#[derive(Clone, Debug, Default)]
struct RelayBackoffState {
    failures: u32,
    next_retry_at: Option<Instant>,
}

struct PublicArchiveJob {
    relay: RelayUrl,
    event: Event,
    label: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BlossomResultPackMirror {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BlossomResultPackReference {
    url: String,
    sha256: String,
    size: usize,
    #[serde(rename = "type")]
    media_type: String,
    compression: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    upload_encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload_size: Option<usize>,
    uploaded_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    server: Option<String>,
    mirrors: Vec<BlossomResultPackMirror>,
}

#[derive(Debug, serde::Deserialize)]
struct BlossomBlobDescriptor {
    url: String,
    sha256: String,
    size: usize,
}

fn build_mirrored_blossom_result_pack_reference(
    uploads: Vec<BlossomResultPackReference>,
) -> Result<BlossomResultPackReference> {
    let first = uploads
        .first()
        .cloned()
        .context("missing primary Blossom result-pack upload")?;
    Ok(BlossomResultPackReference {
        mirrors: uploads
            .iter()
            .map(|upload| BlossomResultPackMirror {
                url: upload.url.clone(),
                server: upload.server.clone(),
            })
            .collect(),
        ..first
    })
}

#[derive(Debug)]
enum ControlMessageAction {
    Processed(bool),
    BlindRequests(Vec<BlindBallotRequest>),
}

struct ControlBlindRequestJob {
    event_id: String,
    requests: Vec<BlindBallotRequest>,
    mark_seen_on_deferred: bool,
    emit_requested_status: bool,
}

struct QueuedPreparedBlindIssuance {
    job_index: usize,
    request: BlindBallotRequest,
    issuance: BlindBallotIssuance,
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
    let dm_relay_strings = config
        .worker_dm_relays
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let public_archive_relay_strings = config
        .public_archive_relays
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    info!(
        "starting auditable-voting-worker v{}",
        env!("CARGO_PKG_VERSION")
    );
    info!(
        "worker startup config: coordinator_npub={}, relay_source={}, relay_count={}, relays={:?}, dm_relay_source={}, dm_relay_count={}, dm_relays={:?}, public_archive_relay_count={}, public_archive_relays={:?}, public_archive_interval_ms={}, public_archive_queue_size={}, blossom_result_pack_servers={:?}, state_dir={}, heartbeat_seconds={}, poll_seconds={}",
        config.coordinator_npub,
        if config.worker_relays_from_env { "env" } else { "default" },
        relay_strings.len(),
        relay_strings,
        if config.worker_dm_relays_from_env { "env" } else { "default" },
        dm_relay_strings.len(),
        dm_relay_strings,
        public_archive_relay_strings.len(),
        public_archive_relay_strings,
        config.public_archive_interval_ms,
        config.public_archive_queue_size,
        config.blossom_result_pack_servers,
        config.worker_state_dir.display(),
        config.heartbeat_seconds,
        config.poll_seconds
    );

    let public_archive_sender = if config.public_archive_relays.is_empty() {
        None
    } else {
        let (sender, receiver) = mpsc::channel(config.public_archive_queue_size);
        spawn_public_archive_task(
            Client::new(keys.clone()),
            config.public_archive_relays.clone(),
            receiver,
            Duration::from_millis(config.public_archive_interval_ms),
        );
        Some(sender)
    };
    let (control_blind_request_sender, control_blind_request_receiver) =
        mpsc::channel(CONTROL_BLIND_REQUEST_QUEUE_SIZE);

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
    if persistent_state_identity_mismatch(&persistent, &worker_npub, &config.coordinator_npub) {
        warn!(
            "worker state identity changed; resetting persisted election state: previous_worker={}, current_worker={}, previous_coordinator={}, current_coordinator={}",
            persistent.worker_npub,
            worker_npub,
            persistent.coordinator_npub,
            config.coordinator_npub,
        );
        persistent = WorkerPersistentState::default();
    }
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
        queued_control_event_ids: Arc::new(Mutex::new(HashSet::new())),
        public_response_permits: Arc::new(Semaphore::new(PUBLIC_RESPONSE_CONCURRENCY)),
        public_archive_sender,
        control_blind_request_sender,
    };

    info!("worker started as {}", worker_npub);

    let mut heartbeat_task = spawn_heartbeat_task(runtime.clone());
    let mut control_task = spawn_control_task(runtime.clone());
    let mut control_blind_request_task =
        spawn_control_blind_request_task(runtime.clone(), control_blind_request_receiver);
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
            result = &mut control_blind_request_task => {
                log_task_exit("control blind request queue", result);
                anyhow::bail!("control blind request queue task exited");
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

fn spawn_control_blind_request_task(
    runtime: WorkerRuntime,
    receiver: mpsc::Receiver<ControlBlindRequestJob>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(error) = runtime.run_control_blind_request_queue(receiver).await {
            error!("control blind request queue failed: {error}");
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
            if let Err(error) = runtime.process_eligible_deferred_blind_requests().await {
                warn!("housekeeping deferred blind request retry failed: {error}");
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

fn spawn_public_archive_task(
    client: Client,
    relays: Vec<RelayUrl>,
    mut receiver: mpsc::Receiver<PublicArchiveJob>,
    interval: Duration,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut relay_backoff: HashMap<String, RelayBackoffState> = HashMap::new();
        for relay in &relays {
            if let Err(error) = client.add_relay(relay.clone()).await {
                warn!("unable to add public archive relay {relay}: {error}");
                record_worker_relay_backoff_result(
                    &mut relay_backoff,
                    relay,
                    false,
                    "public archive relay add",
                    Some(&error.to_string()),
                );
            }
        }
        client.connect().await;
        info!(
            "public archive fanout active: relays={}, interval_ms={}",
            relays.len(),
            interval.as_millis()
        );

        while let Some(job) = receiver.recv().await {
            let event_id = job.event.id.to_hex();
            let relay_key = normalize_relay_key(&job.relay.to_string());
            if let Some(next_retry_at) = relay_backoff
                .get(&relay_key)
                .and_then(|state| state.next_retry_at)
            {
                if next_retry_at > Instant::now() {
                    let wait_secs = next_retry_at
                        .saturating_duration_since(Instant::now())
                        .as_secs();
                    debug!(
                        "public archive relay {} is in backoff for {}s; dropping {} event {} archive copy",
                        job.relay, wait_secs, job.label, event_id
                    );
                    sleep(interval).await;
                    continue;
                }
            }
            let result = timeout(
                Duration::from_secs(PUBLIC_ARCHIVE_SEND_TIMEOUT_SECS),
                client.send_event_to([job.relay.clone()], &job.event),
            )
            .await;
            match result {
                Ok(Ok(output)) if !output.success.is_empty() => {
                    record_worker_relay_backoff_result(
                        &mut relay_backoff,
                        &job.relay,
                        true,
                        "public archive publish",
                        None,
                    );
                    debug!("archived {} event {} to {}", job.label, event_id, job.relay);
                }
                Ok(Ok(output)) => {
                    let relay_error = output
                        .failed
                        .get(&job.relay)
                        .cloned()
                        .unwrap_or_else(|| format!("{:?}", output.failed));
                    record_worker_relay_backoff_result(
                        &mut relay_backoff,
                        &job.relay,
                        false,
                        "public archive publish",
                        Some(&relay_error),
                    );
                    warn!(
                        "public archive relay rejected {} event {} on {}: {:?}",
                        job.label, event_id, job.relay, output.failed
                    );
                }
                Ok(Err(error)) => {
                    record_worker_relay_backoff_result(
                        &mut relay_backoff,
                        &job.relay,
                        false,
                        "public archive publish",
                        Some(&error.to_string()),
                    );
                    warn!(
                        "public archive publish failed for {} event {} on {}: {error}",
                        job.label, event_id, job.relay
                    );
                }
                Err(_) => {
                    record_worker_relay_backoff_result(
                        &mut relay_backoff,
                        &job.relay,
                        false,
                        "public archive publish",
                        Some("timed out"),
                    );
                    warn!(
                        "public archive publish timed out for {} event {} on {}",
                        job.label, event_id, job.relay
                    );
                }
            }
            sleep(interval).await;
        }
    })
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
        let relays = self.effective_worker_private_relays().await;
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
                    let relay_error = output
                        .failed
                        .get(&relay)
                        .map(|error| error.as_str())
                        .or(Some("relay did not acknowledge private DM"));
                    self.record_relay_attempt_result(
                        &relay,
                        relay_success,
                        label,
                        if relay_success { None } else { relay_error },
                    )
                    .await;
                    successes += output.success.len();
                    if !relay_success {
                        failures.push(format!("{}: {:?}", relay, output.failed));
                    }
                }
                Ok((relay, Ok(Err(error)))) => {
                    self.record_relay_attempt_result(
                        &relay,
                        false,
                        label,
                        Some(&error.to_string()),
                    )
                    .await;
                    failures.push(format!("{relay}: {error}"));
                }
                Ok((relay, Err(_))) => {
                    self.record_relay_attempt_result(&relay, false, label, Some("timed out"))
                        .await;
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

    async fn send_participant_status(
        &self,
        election_id: &str,
        invited_npub: &str,
        status_state: OptionAParticipantStatusState,
        request_id: Option<&str>,
        issuance_id: Option<&str>,
    ) -> Result<usize> {
        let envelope = build_participant_status_envelope(
            election_id,
            invited_npub,
            status_state,
            request_id,
            issuance_id,
        );
        self.send_private_msg_best_effort(
            self.coordinator_pubkey,
            serde_json::to_string(&envelope)?,
            "participant status",
        )
        .await
    }

    fn enqueue_public_archive_event(&self, event: &Event, label: &str) {
        let Some(sender) = &self.public_archive_sender else {
            return;
        };
        for relay in &self.config.public_archive_relays {
            let job = PublicArchiveJob {
                relay: relay.clone(),
                event: event.clone(),
                label: label.to_string(),
            };
            match sender.try_send(job) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    warn!(
                        "public archive queue full; dropping archive copies for {} event {}",
                        label, event.id
                    );
                    break;
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    warn!(
                        "public archive queue closed; dropping archive copies for {} event {}",
                        label, event.id
                    );
                    break;
                }
            }
        }
    }

    async fn run_control_blind_request_queue(
        &self,
        mut receiver: mpsc::Receiver<ControlBlindRequestJob>,
    ) -> Result<()> {
        while let Some(first_job) = receiver.recv().await {
            let mut jobs = vec![first_job];
            let mut request_count = jobs
                .first()
                .map(|job| job.requests.len())
                .unwrap_or_default();
            let deadline =
                Instant::now() + Duration::from_millis(CONTROL_BLIND_REQUEST_BATCH_INTERVAL_MS);
            let mut receiver_open = true;

            while request_count < CONTROL_BLIND_REQUEST_BATCH_MAX_REQUESTS {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match timeout(remaining, receiver.recv()).await {
                    Ok(Some(job)) => {
                        request_count += job.requests.len();
                        jobs.push(job);
                    }
                    Ok(None) => {
                        receiver_open = false;
                        break;
                    }
                    Err(_) => break,
                }
            }

            let event_ids = jobs
                .iter()
                .map(|job| job.event_id.clone())
                .collect::<Vec<_>>();
            let job_count = jobs.len();
            match self.process_control_blind_request_jobs(jobs).await {
                Ok(()) => {
                    debug!(
                        "control blind request batch processed: jobs={}, requests={}",
                        job_count, request_count
                    );
                }
                Err(error) => {
                    warn!(
                        "control blind request batch failed and will remain retryable: jobs={}, requests={}, error={error}",
                        job_count, request_count
                    );
                }
            }
            self.clear_queued_control_events(&event_ids).await;
            if !receiver_open {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn process_control_blind_request_jobs(
        &self,
        jobs: Vec<ControlBlindRequestJob>,
    ) -> Result<()> {
        let mut handled_by_job = vec![false; jobs.len()];
        let mut prepared_by_recipient: HashMap<(String, String), Vec<QueuedPreparedBlindIssuance>> =
            HashMap::new();

        for (job_index, job) in jobs.iter().enumerate() {
            let mut seen_bundle_scope_keys = HashSet::new();
            for request in job.requests.iter().cloned() {
                if job.emit_requested_status {
                    if let Err(error) = self
                        .send_participant_status(
                            &request.election_id,
                            &request.invited_npub,
                            OptionAParticipantStatusState::BallotRequested,
                            Some(&request.request_id),
                            None,
                        )
                        .await
                    {
                        warn!(
                            "participant ballot-requested status delivery failed: election_id={}, request_id={}, error={error}",
                            request.election_id, request.request_id
                        );
                    }
                }
                let scope_key = blind_request_issuance_scope_key(&request);
                if !seen_bundle_scope_keys.insert(scope_key.clone()) {
                    warn!(
                        "blind request bundle skipped duplicate voter/scope entry: election_id={}, request_id={}, invited_npub={}, ballot_scope={}",
                        request.election_id,
                        request.request_id,
                        request.invited_npub,
                        ballot_scope_key(&request.ballot_scope)
                    );
                    handled_by_job[job_index] = true;
                    continue;
                }
                match self.prepare_blind_issuance(request).await? {
                    PreparedBlindIssuance::Deferred => {}
                    PreparedBlindIssuance::Handled => handled_by_job[job_index] = true,
                    PreparedBlindIssuance::Issuance { request, issuance } => {
                        handled_by_job[job_index] = true;
                        prepared_by_recipient
                            .entry((request.invited_npub.clone(), request.election_id.clone()))
                            .or_default()
                            .push(QueuedPreparedBlindIssuance {
                                job_index,
                                request,
                                issuance,
                            });
                    }
                }
            }
        }

        for ((recipient_npub, election_id), entries) in prepared_by_recipient {
            let issuances = entries
                .iter()
                .map(|entry| entry.issuance.clone())
                .collect::<Vec<_>>();
            let successes = match self
                .publish_prepared_blind_issuances(&recipient_npub, &issuances)
                .await
            {
                Ok(successes) => successes,
                Err(error) => {
                    warn!(
                        "blind issuance publish failed; recipient requests remain deferred: election_id={}, recipient_npub={}, issuances={}, error={error}",
                        election_id,
                        recipient_npub,
                        issuances.len(),
                    );
                    let mut state = self.state.lock().await;
                    if let Some(election) = state.elections.get_mut(&election_id) {
                        for entry in &entries {
                            remember_deferred_blind_request(election, &entry.request);
                        }
                        self.store.save(&state)?;
                    }
                    continue;
                }
            };
            debug!(
                "blind issuance batch published: election_id={}, recipient_npub={}, issuances={}, relay_successes={}",
                election_id,
                recipient_npub,
                issuances.len(),
                successes
            );
            let requests = entries
                .iter()
                .map(|entry| entry.request.clone())
                .collect::<Vec<_>>();
            for entry in &entries {
                handled_by_job[entry.job_index] = true;
            }
            self.mark_blind_issuances_published(&requests, &issuances)
                .await?;
            for issuance in &issuances {
                if let Err(error) = self
                    .send_participant_status(
                        &issuance.election_id,
                        &issuance.invited_npub,
                        OptionAParticipantStatusState::BallotIssued,
                        Some(&issuance.request_id),
                        Some(&issuance.issuance_id),
                    )
                    .await
                {
                    warn!(
                        "participant ballot-issued status delivery failed: election_id={}, request_id={}, error={error}",
                        issuance.election_id, issuance.request_id
                    );
                }
            }
        }

        for (job_index, job) in jobs.iter().enumerate() {
            if handled_by_job[job_index] || job.mark_seen_on_deferred {
                self.mark_control_event_processed(&job.event_id).await?;
            }
        }

        Ok(())
    }

    async fn process_eligible_deferred_blind_requests(&self) -> Result<()> {
        let election_ids = {
            let state = self.state.lock().await;
            state
                .elections
                .iter()
                .filter(|(_, election)| {
                    !election.revoked
                        && !is_expired(&election.expires_at)
                        && election.blind_signing_private_key.is_some()
                        && election.definition.is_some()
                        && election.deferred_blind_requests.values().any(|request| {
                            deferred_blind_request_ready_for_retry(election, request)
                        })
                })
                .map(|(election_id, _)| election_id.clone())
                .collect::<Vec<_>>()
        };
        for election_id in election_ids {
            if let Err(error) = self
                .process_deferred_blind_requests_for_election(&election_id)
                .await
            {
                warn!(
                    "periodic deferred blind request replay failed for election {election_id}: {error}"
                );
            }
        }
        Ok(())
    }

    async fn process_deferred_blind_requests_for_election(&self, election_id: &str) -> Result<()> {
        let requests = {
            let state = self.state.lock().await;
            let Some(election) = state.elections.get(election_id) else {
                return Ok(());
            };
            election
                .deferred_blind_request_ids
                .iter()
                .filter_map(|request_id| election.deferred_blind_requests.get(request_id).cloned())
                .collect::<Vec<_>>()
        };
        if requests.is_empty() {
            return Ok(());
        }
        debug!(
            "replaying deferred blind requests: election_id={}, requests={}",
            election_id,
            requests.len()
        );
        let jobs = requests
            .into_iter()
            .map(|request| ControlBlindRequestJob {
                event_id: format!("deferred:{}:{}", election_id, request.request_id),
                requests: vec![request],
                mark_seen_on_deferred: true,
                emit_requested_status: false,
            })
            .collect::<Vec<_>>();
        self.process_control_blind_request_jobs(jobs).await
    }

    async fn mark_control_event_processed(&self, event_id: &str) -> Result<()> {
        let mut state = self.state.lock().await;
        state
            .seen_control_event_ids
            .insert(event_id.to_string(), now_iso());
        prune_seen_control_events(&mut state.seen_control_event_ids, Utc::now());
        state.last_dm_scan_at = Some(now_iso());
        self.store.save(&state)?;
        Ok(())
    }

    async fn clear_queued_control_events(&self, event_ids: &[String]) {
        let mut queued = self.queued_control_event_ids.lock().await;
        for event_id in event_ids {
            queued.remove(event_id);
        }
    }

    async fn publish_public_event_builder(
        &self,
        builder: EventBuilder,
        label: &str,
    ) -> Result<String> {
        let event = self.client.sign_event_builder(builder).await?;
        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;
        let output = self.client.send_event_to(relays.clone(), &event).await?;
        for relay in output.success.iter() {
            self.record_relay_attempt_result(relay, true, label, None)
                .await;
        }
        for (relay, error) in output.failed.iter() {
            self.record_relay_attempt_result(relay, false, label, Some(error.as_str()))
                .await;
        }
        if output.success.is_empty() {
            anyhow::bail!(
                "{label} publish failed on all hot relays: {:?}",
                output.failed
            );
        }
        if !output.failed.is_empty() {
            debug!(
                "{label} publish had {} relay failure(s): {:?}",
                output.failed.len(),
                output.failed
            );
        }
        self.enqueue_public_archive_event(&event, label);
        Ok(event.id.to_hex())
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
        let relays = self.effective_worker_private_relays().await;
        self.ensure_relays_connected(&relays).await;

        let output = self
            .client
            .subscribe_to(relays.clone(), filter, None)
            .await
            .context("failed to subscribe to control plane")?;
        for relay in output.success.iter() {
            self.record_relay_attempt_result(relay, true, "control subscription", None)
                .await;
        }
        for (relay, error) in output.failed.iter() {
            self.record_relay_attempt_result(
                relay,
                false,
                "control subscription",
                Some(error.as_str()),
            )
            .await;
        }
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
        let already_queued = {
            let queued = self.queued_control_event_ids.lock().await;
            queued.contains(&event_id)
        };
        if already_queued {
            return Ok(());
        }

        let unwrapped = self.client.unwrap_gift_wrap(event).await?;
        log_decrypted_worker_dm(event, &unwrapped.rumor);
        let authenticated_sender = unwrapped
            .rumor
            .pubkey
            .to_bech32()
            .unwrap_or_else(|_| unwrapped.rumor.pubkey.to_string());
        let rumor_content = unwrapped.rumor.content;
        if rumor_content.trim().is_empty() {
            return Ok(());
        }
        match self
            .process_control_message(&rumor_content, &authenticated_sender)
            .await
        {
            Ok(ControlMessageAction::Processed(true)) => {
                self.mark_control_event_processed(&event_id).await?;
            }
            Ok(ControlMessageAction::Processed(false)) => {
                if replay_seen_control_events {
                    self.mark_control_event_processed(&event_id).await?;
                }
            }
            Ok(ControlMessageAction::BlindRequests(requests)) => {
                if requests.is_empty() {
                    return Ok(());
                }
                {
                    let mut queued = self.queued_control_event_ids.lock().await;
                    queued.insert(event_id.clone());
                }
                let job = ControlBlindRequestJob {
                    event_id: event_id.clone(),
                    requests,
                    mark_seen_on_deferred: replay_seen_control_events,
                    emit_requested_status: true,
                };
                if let Err(error) = self.control_blind_request_sender.send(job).await {
                    let mut queued = self.queued_control_event_ids.lock().await;
                    queued.remove(&event_id);
                    anyhow::bail!("control blind request queue closed: {error}");
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

    async fn effective_worker_private_relays(&self) -> Vec<RelayUrl> {
        let relays = self.config.worker_dm_relays.clone();

        let filtered = filter_private_dm_relays(dedupe_relays(relays));
        let fallback_relays = if filtered.is_empty() {
            warn!(
                "worker private DM relay set was empty after filtering NIP-17-incompatible relays; using default private DM relays"
            );
            PRIVATE_DM_FALLBACK_RELAYS
                .iter()
                .filter_map(|relay| RelayUrl::parse(*relay).ok())
                .collect()
        } else {
            filtered
        };
        filter_private_dm_relays(self.select_relay_retry_batch(fallback_relays).await)
    }

    async fn ensure_relays_connected(&self, relays: &[RelayUrl]) {
        for relay in relays {
            if let Err(error) = self.client.add_relay(relay.clone()).await {
                warn!("unable to add effective relay {relay}: {error}");
                self.record_relay_attempt_result(
                    relay,
                    false,
                    "relay add",
                    Some(&error.to_string()),
                )
                .await;
                continue;
            }
            if let Err(error) = self
                .client
                .try_connect_relay(
                    relay.clone(),
                    Duration::from_secs(WORKER_RELAY_CONNECT_TIMEOUT_SECS),
                )
                .await
            {
                warn!("unable to connect effective relay {relay}: {error}");
                self.record_relay_attempt_result(
                    relay,
                    false,
                    "relay connect",
                    Some(&error.to_string()),
                )
                .await;
            }
        }
    }

    async fn select_relay_retry_batch(&self, relays: Vec<RelayUrl>) -> Vec<RelayUrl> {
        let now = Instant::now();
        let relay_backoff = self.relay_backoff.lock().await;
        let mut selected = Vec::with_capacity(relays.len());
        let mut delayed: Vec<(RelayUrl, Instant)> = Vec::new();
        for relay in relays {
            let key = normalize_relay_key(&relay.to_string());
            match relay_backoff
                .get(&key)
                .and_then(|state| state.next_retry_at)
            {
                Some(next_retry_at) if next_retry_at > now => {
                    let wait_secs = next_retry_at.saturating_duration_since(now).as_secs();
                    debug!("worker relay {relay} is in backoff; retrying in {wait_secs}s");
                    delayed.push((relay, next_retry_at));
                }
                _ => {
                    if is_discouraged_worker_relay(&relay.to_string()) {
                        debug!("trying discouraged worker relay {relay}");
                    }
                    selected.push(relay);
                }
            }
        }
        if selected.is_empty() && !delayed.is_empty() {
            delayed.sort_by_key(|(_, next_retry_at)| *next_retry_at);
            if let Some((relay, next_retry_at)) = delayed.into_iter().next() {
                let wait_secs = next_retry_at.saturating_duration_since(now).as_secs();
                warn!(
                    "all worker relays are in backoff; trying earliest relay {relay} {wait_secs}s early"
                );
                selected.push(relay);
            }
        }
        selected
    }

    async fn record_relay_attempt_result(
        &self,
        relay: &RelayUrl,
        success: bool,
        label: &str,
        error: Option<&str>,
    ) {
        let mut relay_backoff = self.relay_backoff.lock().await;
        record_worker_relay_backoff_result(&mut relay_backoff, relay, success, label, error);
    }

    async fn process_control_message(
        &self,
        content: &str,
        authenticated_sender: &str,
    ) -> Result<ControlMessageAction> {
        let raw_value: serde_json::Value = match serde_json::from_str(content) {
            Ok(parsed) => parsed,
            Err(_) => return Ok(ControlMessageAction::Processed(true)),
        };
        let value = match unwrap_compressed_bundle_value(raw_value) {
            Ok(parsed) => parsed,
            Err(error) => {
                warn!("failed to decode compressed control message: {error}");
                return Ok(ControlMessageAction::Processed(true));
            }
        };
        let message_type = value
            .get("type")
            .and_then(|entry| entry.as_str())
            .unwrap_or_default();
        debug!("control message parsed: type={message_type}");
        match message_type {
            "optiona_worker_delegation_dm" => {
                if authenticated_sender != self.config.coordinator_npub {
                    return Ok(ControlMessageAction::Processed(true));
                }
                let envelope: WorkerDelegationEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(ControlMessageAction::Processed(true)),
                };
                self.apply_delegation(envelope.delegation).await?;
            }
            "optiona_worker_delegation_revocation_dm" => {
                if authenticated_sender != self.config.coordinator_npub {
                    return Ok(ControlMessageAction::Processed(true));
                }
                let envelope: WorkerRevocationEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(ControlMessageAction::Processed(true)),
                };
                self.apply_revocation(envelope.revocation).await?;
            }
            "optiona_worker_election_config_dm" => {
                if authenticated_sender != self.config.coordinator_npub {
                    return Ok(ControlMessageAction::Processed(true));
                }
                let envelope: WorkerElectionConfigEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(ControlMessageAction::Processed(true)),
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
                    Err(error) => {
                        warn!(
                            "blind request control message could not be decoded and will be retried: {error}"
                        );
                        return Ok(ControlMessageAction::Processed(false));
                    }
                };
                debug!(
                    "blind request received: election_id={}, request_id={}, invited_npub={}",
                    envelope.request.election_id,
                    envelope.request.request_id,
                    envelope.request.invited_npub
                );
                if authenticated_sender != envelope.request.invited_npub {
                    warn!(
                        "blind request ignored because authenticated sender does not match invited npub: election_id={}, request_id={}",
                        envelope.request.election_id, envelope.request.request_id
                    );
                    return Ok(ControlMessageAction::Processed(true));
                }
                return Ok(ControlMessageAction::BlindRequests(vec![envelope.request]));
            }
            "optiona_blind_request_bundle_dm" => {
                let envelope: BlindBallotRequestBundleEnvelope = match serde_json::from_value(value)
                {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        warn!(
                            "blind request bundle control message could not be decoded and will be retried: {error}"
                        );
                        return Ok(ControlMessageAction::Processed(false));
                    }
                };
                debug!(
                    "blind request bundle received: requests={}",
                    envelope.requests.len()
                );
                let requests = envelope
                    .requests
                    .into_iter()
                    .filter(|request| {
                        let accepted = authenticated_sender == request.invited_npub;
                        if !accepted {
                            warn!(
                                "blind request bundle entry ignored because authenticated sender does not match invited npub: election_id={}, request_id={}",
                                request.election_id, request.request_id
                            );
                        }
                        accepted
                    })
                    .collect::<Vec<_>>();
                if requests.is_empty() {
                    return Ok(ControlMessageAction::Processed(true));
                }
                return Ok(ControlMessageAction::BlindRequests(requests));
            }
            "optiona_blind_issuance_ack_dm" => {
                let envelope: BlindIssuanceAckEnvelope = match serde_json::from_value(value) {
                    Ok(parsed) => parsed,
                    Err(_) => return Ok(ControlMessageAction::Processed(true)),
                };
                if envelope.message_type != "optiona_blind_issuance_ack_dm"
                    || envelope.schema_version != 1
                {
                    return Ok(ControlMessageAction::Processed(true));
                }
                let valid = {
                    let state = self.state.lock().await;
                    blind_issuance_ack_matches(
                        authenticated_sender,
                        &envelope.ack,
                        state.elections.get(&envelope.ack.election_id),
                    )
                };
                if !valid {
                    debug!("ignored invalid blind issuance acknowledgement");
                }
            }
            _ => return Ok(ControlMessageAction::Processed(true)),
        }
        Ok(ControlMessageAction::Processed(true))
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
        let relays = self.effective_worker_relays().await;
        self.ensure_relays_connected(&relays).await;

        let response_output = self
            .client
            .subscribe_to(relays.clone(), response_filter, None)
            .await
            .context("failed to subscribe to public response plane")?;
        let public_response_subscription_id = response_output.val.clone();
        for relay in response_output.success.iter() {
            self.record_relay_attempt_result(relay, true, "public response subscription", None)
                .await;
        }
        for (relay, error) in response_output.failed.iter() {
            self.record_relay_attempt_result(
                relay,
                false,
                "public response subscription",
                Some(error.as_str()),
            )
            .await;
        }
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
        info!(
            "public response subscription active: id={}, relays={}",
            response_output.val,
            response_output.success.len()
        );
        let mut notification_receiver = self.client.notifications();
        loop {
            match notification_receiver.recv().await {
                Ok(RelayPoolNotification::Event {
                    subscription_id: event_subscription_id,
                    event,
                    ..
                }) if event_subscription_id == public_response_subscription_id => {
                    let runtime = self.clone();
                    let since_ts = since_ts;
                    let permit = runtime
                        .public_response_permits
                        .clone()
                        .acquire_owned()
                        .await
                        .context("public response semaphore closed")?;
                    tokio::spawn(async move {
                        let _permit = permit;
                        if let Err(error) = runtime
                            .process_public_response_event(&event, &since_ts)
                            .await
                        {
                            warn!("public response event {} failed: {error}", event.id);
                        }
                    });
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

    #[cfg(test)]
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
        let Some(election) = state.elections.get_mut(&questionnaire_id) else {
            debug!(
                "public questionnaire definition ignored for undelegated election: election_id={}, event_id={}",
                questionnaire_id, event.id
            );
            return Ok(false);
        };
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
        drop(state);
        debug!(
            "public questionnaire definition stored: election_id={}, event_id={}",
            questionnaire_id, event.id
        );
        if let Err(error) = self
            .process_deferred_blind_requests_for_election(&questionnaire_id)
            .await
        {
            warn!(
                "deferred blind request replay failed after public definition load for election {}; requests remain retryable: {error}",
                questionnaire_id
            );
        }
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
            self.enqueue_public_archive_event(event, "blind response");
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
        let decision = {
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
            let nullifiers = blind_response_nullifiers(&submission);
            let commitments = blind_response_token_commitments(&submission);
            let unique_nullifiers = nullifiers.iter().cloned().collect::<HashSet<_>>();
            let unique_commitments = commitments.iter().cloned().collect::<HashSet<_>>();

            if submission.event_type != "questionnaire_response_blind" {
                accepted = false;
                reason = "invalid_payload_shape".to_string();
            } else if nullifiers.is_empty()
                || commitments.is_empty()
                || nullifiers.len() != unique_nullifiers.len()
                || commitments.len() != unique_commitments.len()
                || submission.response_id.trim().is_empty()
                || submission.author_pubkey.trim().is_empty()
            {
                accepted = false;
                reason = "invalid_payload_shape".to_string();
            } else if !verify_blind_response_proofs(election, &submission) {
                accepted = false;
                reason = "invalid_token_proof".to_string();
            } else if !submission_answers_authorized_for_proofs(election, &submission) {
                accepted = false;
                reason = "invalid_ballot_group".to_string();
            } else if nullifiers
                .iter()
                .any(|nullifier| election.accepted_nullifiers.contains(nullifier))
                || commitments
                    .iter()
                    .any(|commitment| election.accepted_token_commitments.contains(commitment))
            {
                accepted = false;
                reason = "duplicate_nullifier".to_string();
            }

            if accepted {
                for nullifier in &nullifiers {
                    election.accepted_nullifiers.insert(nullifier.clone());
                }
                for commitment in &commitments {
                    election
                        .accepted_token_commitments
                        .insert(commitment.clone());
                }
                election
                    .accepted_response_authors
                    .insert(submission.author_pubkey.clone());
                election.accepted_response_count =
                    election.accepted_response_count.saturating_add(1);
            } else {
                election.rejected_response_count =
                    election.rejected_response_count.saturating_add(1);
            }
            election
                .processed_submission_ids
                .insert(submission.response_id.clone());
            election
                .published_response_refs
                .push(QuestionnairePublishedResponseRef {
                    response_id: submission.response_id.clone(),
                    author_pubkey: submission.author_pubkey.clone(),
                    submitted_at: submission.submitted_at,
                    accepted,
                    answers: submission.answers.clone(),
                    rejection_reason: if accepted { None } else { Some(reason.clone()) },
                });
            election.last_vote_verification_at = Some(now_iso());

            let decision = if election
                .capabilities
                .contains(&WorkerCapability::PublishSubmissionDecisions)
            {
                Some(QuestionnaireSubmissionDecisionEvent {
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
                })
            } else {
                None
            };

            self.store.save(&state)?;
            decision
        };

        if let Some(decision) = decision {
            let event_id = self.publish_submission_decision(&decision).await?;
            let mut state = self.state.lock().await;
            if let Some(election) = state.elections.get_mut(&decision.questionnaire_id) {
                election
                    .published_decisions
                    .insert(decision.submission_id.clone(), event_id);
                election.last_decision_publish_at = Some(now_iso());
                self.store.save(&state)?;
            }
        }
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
        let tags = submission_decision_tags(decision, &self.worker_npub);
        for tag in tags {
            if let Ok(parsed) = Tag::parse(tag) {
                builder = builder.tag(parsed);
            }
        }
        self.publish_public_event_builder(builder, "submission decision")
            .await
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
        self.publish_public_event_builder(builder, "questionnaire close")
            .await
    }

    async fn upload_result_pack(
        &self,
        election_id: &str,
        summary: &serde_json::Value,
        responses: &[QuestionnairePublishedResponseRef],
    ) -> Result<BlossomResultPackReference> {
        if self.config.blossom_result_pack_servers.len() < BLOSSOM_RESULT_PACK_TARGET_UPLOADS {
            anyhow::bail!("at least two Blossom result-pack servers are required");
        }
        if responses.is_empty() {
            anyhow::bail!("result pack has no responses");
        }

        let created_at = Timestamp::now().as_secs() as i64;
        let csv = build_result_pack_csv(election_id, created_at, summary, responses)?;
        let sha256 = sha256_hex_bytes(csv.as_bytes());
        let keys = Keys::parse(&self.config.worker_nsec)
            .context("WORKER_NSEC is not valid for Blossom upload auth")?;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(BLOSSOM_RESULT_PACK_UPLOAD_TIMEOUT_SECS))
            .connect_timeout(Duration::from_secs(BLOSSOM_RESULT_PACK_UPLOAD_TIMEOUT_SECS))
            .build()
            .context("failed to build Blossom upload client")?;
        let mut uploads = Vec::new();
        let mut errors = Vec::new();

        for server in &self.config.blossom_result_pack_servers {
            match self
                .upload_result_pack_to_server(&http, &keys, server, csv.as_bytes(), &sha256)
                .await
            {
                Ok(upload) => {
                    uploads.push(upload);
                    if uploads.len() >= BLOSSOM_RESULT_PACK_TARGET_UPLOADS {
                        break;
                    }
                }
                Err(error) => errors.push(format!("{server}: {error}")),
            }
        }

        if uploads.len() < BLOSSOM_RESULT_PACK_TARGET_UPLOADS {
            anyhow::bail!(
                "Blossom CSV result-pack upload failed to reach two mirrors: {}",
                errors.join("; ")
            );
        }

        build_mirrored_blossom_result_pack_reference(uploads)
    }

    async fn upload_result_pack_to_server(
        &self,
        http: &reqwest::Client,
        keys: &Keys,
        server: &str,
        body: &[u8],
        sha256: &str,
    ) -> Result<BlossomResultPackReference> {
        let descriptor = self
            .upload_result_pack_body_to_server(
                http,
                keys,
                server,
                body,
                sha256,
                BLOSSOM_RESULT_PACK_CSV_CONTENT_TYPE,
            )
            .await?;
        Ok(BlossomResultPackReference {
            url: descriptor.url,
            sha256: sha256.to_string(),
            size: descriptor.size,
            media_type: BLOSSOM_RESULT_PACK_TYPE.to_string(),
            compression: "none".to_string(),
            upload_encoding: Some(BLOSSOM_RESULT_PACK_UPLOAD_ENCODING.to_string()),
            payload_sha256: None,
            payload_size: None,
            uploaded_at: Timestamp::now().as_secs() as i64,
            server: Some(server.trim_end_matches('/').to_string()),
            mirrors: Vec::new(),
        })
    }

    async fn upload_result_pack_body_to_server(
        &self,
        http: &reqwest::Client,
        keys: &Keys,
        server: &str,
        body: &[u8],
        sha256: &str,
        content_type: &str,
    ) -> Result<BlossomBlobDescriptor> {
        let upload_url = format!("{}/upload", server.trim_end_matches('/'));
        let auth = self.blossom_upload_auth(keys, &upload_url, sha256)?;
        let response = http
            .put(&upload_url)
            .header(CONTENT_TYPE, content_type)
            .header(CONTENT_LENGTH, body.len().to_string())
            .header("X-SHA-256", sha256)
            .header(AUTHORIZATION, auth)
            .body(body.to_vec())
            .send()
            .await
            .with_context(|| format!("failed to upload result pack to {upload_url}"))?;
        let status = response.status();
        if status != reqwest::StatusCode::OK && status != reqwest::StatusCode::CREATED {
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!(
                "HTTP {status}: {}",
                body.chars().take(240).collect::<String>()
            );
        }
        let descriptor: BlossomBlobDescriptor = response
            .json()
            .await
            .context("failed to parse Blossom blob descriptor")?;
        if descriptor.sha256.to_lowercase() != sha256 {
            anyhow::bail!(
                "Blossom server returned mismatched sha256: expected {}, got {}",
                sha256,
                descriptor.sha256
            );
        }
        if descriptor.size != body.len() {
            anyhow::bail!(
                "Blossom server returned mismatched size: expected {}, got {}",
                body.len(),
                descriptor.size
            );
        }
        if !descriptor.url.starts_with("https://") {
            anyhow::bail!("Blossom server returned non-HTTPS blob URL");
        }
        Ok(descriptor)
    }

    fn blossom_upload_auth(&self, keys: &Keys, upload_url: &str, sha256: &str) -> Result<String> {
        let host = reqwest::Url::parse(upload_url)
            .context("invalid Blossom upload URL")?
            .host_str()
            .map(str::to_lowercase)
            .context("Blossom upload URL is missing a host")?;
        let expiration = Timestamp::now().as_secs() + 10 * 60;
        let tags = vec![
            Tag::parse(["t", "upload"])?,
            Tag::parse(["expiration", &expiration.to_string()])?,
            Tag::parse(["x", sha256])?,
            Tag::parse(["server", host.as_str()])?,
        ];
        let event = EventBuilder::new(
            Kind::Custom(BLOSSOM_AUTH_KIND),
            "Upload questionnaire result pack",
        )
        .tags(tags)
        .sign_with_keys(keys)
        .context("failed to sign Blossom upload auth")?;
        Ok(format!("Nostr {}", URL_SAFE_NO_PAD.encode(event.as_json())))
    }

    async fn publish_result_summary(
        &self,
        election_id: &str,
        accepted_count: u64,
        rejected_count: u64,
    ) -> Result<String> {
        let response_refs = {
            let state = self.state.lock().await;
            state
                .elections
                .get(election_id)
                .map(|entry| entry.published_response_refs.clone())
                .unwrap_or_default()
        };
        let mut summary = serde_json::json!({
            "schemaVersion": 1,
            "eventType": "questionnaire_result_summary",
            "questionnaireId": election_id,
            "createdAt": Timestamp::now().as_secs() as i64,
            "coordinatorPubkey": self.config.coordinator_npub,
            "acceptedResponseCount": accepted_count,
            "rejectedResponseCount": rejected_count,
            "acceptedNullifierCount": accepted_count,
            "questionSummaries": [],
        });
        let mut result_pack: Option<BlossomResultPackReference> = None;
        if !response_refs.is_empty() {
            match self
                .upload_result_pack(election_id, &summary, &response_refs)
                .await
            {
                Ok(reference) => {
                    info!(
                        "uploaded result pack for election {} to {} Blossom mirrors",
                        election_id,
                        reference.mirrors.len()
                    );
                    summary["resultPack"] = serde_json::to_value(&reference)?;
                    result_pack = Some(reference);
                }
                Err(error) => {
                    warn!("Blossom result-pack upload skipped for election {election_id}: {error}");
                }
            }
        }
        let content = summary.to_string();
        let mut builder = EventBuilder::new(
            Kind::Custom(IMPLEMENTATION_KIND_QUESTIONNAIRE_RESULT_SUMMARY),
            content,
        );
        let tags = result_summary_tags(
            election_id,
            &self.worker_npub,
            &self.config.coordinator_npub,
            result_pack.as_ref(),
        );
        for tag in tags {
            if let Ok(parsed) = Tag::parse(tag) {
                builder = builder.tag(parsed);
            }
        }
        self.publish_public_event_builder(builder, "result summary")
            .await
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
        if snapshot.definition.is_none() {
            warn!(
                "worker election config ignored because it does not include a questionnaire definition: election_id={}, delegation_id={}",
                snapshot.election_id, snapshot.delegation_id
            );
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
        if let Err(error) = self
            .process_deferred_blind_requests_for_election(&snapshot.election_id)
            .await
        {
            warn!(
                "deferred blind request replay failed after config load for election {}; requests remain retryable: {error}",
                snapshot.election_id
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
            let election = state
                .elections
                .entry(request.election_id.clone())
                .or_insert_with(ElectionRuntimeState::default);
            if election.election_id.is_empty() {
                election.election_id = request.election_id.clone();
            }
            if election.delegation_id.is_empty() && election.capabilities.is_empty() {
                remember_deferred_blind_request(election, &request);
                self.store.save(&state)?;
                info!(
                    "blind request deferred for election {} because no worker config is loaded yet",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if election.revoked || is_expired(&election.expires_at) {
                return Ok(PreparedBlindIssuance::Handled);
            }
            if !election
                .capabilities
                .contains(&WorkerCapability::IssueBlindTokens)
            {
                return Ok(PreparedBlindIssuance::Handled);
            }
            if election.definition.is_none() {
                remember_deferred_blind_request(election, &request);
                self.store.save(&state)?;
                warn!(
                    "blind request deferred for election {} because public questionnaire definition is not loaded yet",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if !verify_general_invite_pow(
                election.definition.as_ref().expect("checked above"),
                &request,
            ) {
                forget_deferred_blind_request(election, &request.request_id);
                self.store.save(&state)?;
                warn!(
                    "blind request rejected because general-invite proof of work is invalid: election_id={}, request_id={}, invited_npub={}",
                    request.election_id, request.request_id, request.invited_npub
                );
                return Ok(PreparedBlindIssuance::Handled);
            }
            if let Some(issuance) = election
                .issued_issuances_by_request_id
                .get(&request.request_id)
                .cloned()
            {
                if issuance.election_id == request.election_id
                    && issuance.request_id == request.request_id
                    && issuance.invited_npub == request.invited_npub
                    && issuance.blind_signing_key_id == request.blind_signing_key_id
                    && issuance.ballot_scope == request.ballot_scope
                {
                    debug!(
                        "blind request replay received; re-publishing persisted issuance: election_id={}, request_id={}, issuance_id={}",
                        request.election_id, request.request_id, issuance.issuance_id
                    );
                    return Ok(PreparedBlindIssuance::Issuance { request, issuance });
                }
                warn!(
                    "blind request ignored because request ID conflicts with persisted issuance: election_id={}, request_id={}",
                    request.election_id, request.request_id
                );
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
                remember_deferred_blind_request(election, &request);
                self.store.save(&state)?;
                warn!(
                    "blind request deferred for election {} because no blind signing key is configured",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if !has_effective_eligibility_config(election) {
                remember_deferred_blind_request(election, &request);
                self.store.save(&state)?;
                warn!(
                    "blind request deferred for election {} because delegated eligibility config is not loaded yet",
                    request.election_id
                );
                return Ok(PreparedBlindIssuance::Deferred);
            }
            if election.whitelist_npubs.contains(&request.invited_npub)
                && !blind_request_proxy_authorized(election, &request)
            {
                forget_deferred_blind_request(election, &request.request_id);
                self.store.save(&state)?;
                warn!(
                    "blind request rejected because proxy voting is not enabled for this voter: election_id={}, request_id={}, invited_npub={}, ballot_scope={}",
                    request.election_id,
                    request.request_id,
                    request.invited_npub,
                    ballot_scope_key(&request.ballot_scope)
                );
                return Ok(PreparedBlindIssuance::Handled);
            }
            if !election
                .seen_blind_request_ids
                .contains(&request.request_id)
                && has_existing_issuance_for_request(election, &request)
            {
                forget_deferred_blind_request(election, &request.request_id);
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
                    remember_deferred_blind_request(election, &request);
                    self.store.save(&state)?;
                    info!(
                        "blind request deferred for election {} because delegated eligibility is not satisfied yet",
                        request.election_id
                    );
                    return Ok(PreparedBlindIssuance::Deferred);
                }
                BlindRequestAuthorization::Rejected => {
                    forget_deferred_blind_request(election, &request.request_id);
                    self.store.save(&state)?;
                    warn!(
                        "blind request rejected by delegated eligibility: election_id={}, request_id={}, invited_npub={}",
                        request.election_id, request.request_id, request.invited_npub
                    );
                    return Ok(PreparedBlindIssuance::Handled);
                }
            };
            if !blind_request_proxy_authorized(election, &request) {
                forget_deferred_blind_request(election, &request.request_id);
                self.store.save(&state)?;
                warn!(
                    "blind request rejected because proxy voting is not enabled for this voter: election_id={}, request_id={}, invited_npub={}, ballot_scope={}",
                    request.election_id,
                    request.request_id,
                    request.invited_npub,
                    ballot_scope_key(&request.ballot_scope)
                );
                return Ok(PreparedBlindIssuance::Handled);
            }
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
                forget_deferred_blind_request(election, &request.request_id);
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

    async fn mark_blind_issuances_published(
        &self,
        requests: &[BlindBallotRequest],
        issuances: &[BlindBallotIssuance],
    ) -> Result<()> {
        let mut state = self.state.lock().await;
        for request in requests {
            let Some(election) = state.elections.get_mut(&request.election_id) else {
                continue;
            };
            record_issuance_for_request(election, request);
            forget_deferred_blind_request(election, &request.request_id);
            election
                .seen_blind_request_ids
                .insert(request.request_id.clone());
            if let Some(issuance) = issuances
                .iter()
                .find(|issuance| issuance.request_id == request.request_id)
            {
                election
                    .issued_issuances_by_request_id
                    .insert(request.request_id.clone(), issuance.clone());
            }
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
            existing.deferred_blind_requests.clear();
            existing.issued_invited_npubs.clear();
            existing.issued_invited_scope_keys.clear();
            existing.issued_issuances_by_request_id.clear();
            existing.whitelist_npubs.clear();
            existing.proxy_voter_npubs.clear();
            existing.ballot_groups_by_npub.clear();
            existing.bearer_invite_codes.clear();
            existing.eligibility_configured = false;
            existing.eligibility_required = false;
            existing.accepted_response_authors.clear();
            existing.accepted_response_count = 0;
            existing.rejected_response_count = 0;
            existing.published_response_refs.clear();
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

fn result_summary_tags(
    election_id: &str,
    worker_npub: &str,
    coordinator_npub: &str,
    result_pack: Option<&BlossomResultPackReference>,
) -> Vec<Vec<String>> {
    let mut tags = vec![
        vec!["t".to_string(), "questionnaire_result_summary".to_string()],
        vec!["q".to_string(), election_id.to_string()],
        vec!["questionnaire-id".to_string(), election_id.to_string()],
        vec!["worker".to_string(), worker_npub.to_string()],
        vec!["coordinator".to_string(), coordinator_npub.to_string()],
    ];
    if let Some(pack) = result_pack {
        tags.push(vec![
            "result-pack".to_string(),
            pack.sha256.clone(),
            pack.url.clone(),
        ]);
        tags.push(vec!["x".to_string(), pack.sha256.clone()]);
        for mirror in &pack.mirrors {
            tags.push(vec!["result-pack-mirror".to_string(), mirror.url.clone()]);
        }
    }
    tags
}

fn build_result_pack_csv(
    election_id: &str,
    created_at: i64,
    summary: &serde_json::Value,
    responses: &[QuestionnairePublishedResponseRef],
) -> Result<String> {
    let headers = [
        "questionnaire_id",
        "result_created_at",
        "coordinator_pubkey",
        "accepted_response_count",
        "rejected_response_count",
        "accepted_nullifier_count",
        "response_id",
        "submittor_pubkey",
        "submitted_at",
        "accepted",
        "rejection_reason",
        "answers_json",
    ];
    let mut csv = headers.join(",");
    csv.push_str("\r\n");
    for response in responses {
        let answers_json = serde_json::to_string(&response.answers)
            .context("failed to encode result-pack response answers")?;
        let row = [
            election_id.to_string(),
            created_at.to_string(),
            summary
                .get("coordinatorPubkey")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            summary
                .get("acceptedResponseCount")
                .and_then(|value| value.as_u64())
                .unwrap_or_default()
                .to_string(),
            summary
                .get("rejectedResponseCount")
                .and_then(|value| value.as_u64())
                .unwrap_or_default()
                .to_string(),
            summary
                .get("acceptedNullifierCount")
                .and_then(|value| value.as_u64())
                .map(|value| value.to_string())
                .unwrap_or_default(),
            response.response_id.clone(),
            response.author_pubkey.clone(),
            response.submitted_at.to_string(),
            response.accepted.to_string(),
            response.rejection_reason.clone().unwrap_or_default(),
            answers_json,
        ];
        csv.push_str(
            &row.iter()
                .map(|value| csv_cell(value))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    Ok(csv)
}

fn csv_cell(value: &str) -> String {
    if value
        .chars()
        .any(|ch| matches!(ch, ',' | '"' | '\r' | '\n'))
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn submission_decision_tags(
    decision: &QuestionnaireSubmissionDecisionEvent,
    worker_npub: &str,
) -> Vec<Vec<String>> {
    vec![
        vec![
            "t".to_string(),
            "questionnaire_submission_decision".to_string(),
        ],
        vec!["q".to_string(), decision.questionnaire_id.clone()],
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
        vec!["worker".to_string(), worker_npub.to_string()],
        vec![
            "delegation-id".to_string(),
            decision.delegation_id.clone().unwrap_or_default(),
        ],
    ]
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

fn is_private_dm_rejecting_relay(relay: &str) -> bool {
    let key = normalize_relay_key(relay);
    PRIVATE_DM_REJECTING_RELAYS
        .iter()
        .any(|entry| normalize_relay_key(entry) == key)
}

fn filter_private_dm_relays(relays: Vec<RelayUrl>) -> Vec<RelayUrl> {
    relays
        .into_iter()
        .filter(|relay| !is_private_dm_rejecting_relay(&relay.to_string()))
        .collect()
}

fn worker_relay_error_base_secs(error: Option<&str>) -> u64 {
    let Some(error) = error else {
        return WORKER_RELAY_INITIAL_BACKOFF_SECS;
    };
    let lower = error.to_ascii_lowercase();
    if lower.contains("initialized but not ready") || lower.contains("not ready") {
        return 120;
    }
    if lower.contains("insufficient resources")
        || lower.contains("rate")
        || lower.contains("throttle")
        || lower.contains("too many")
    {
        return 180;
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return 90;
    }
    WORKER_RELAY_INITIAL_BACKOFF_SECS
}

fn is_immediate_worker_relay_backoff_error(error: Option<&str>) -> bool {
    let Some(error) = error else {
        return false;
    };
    let lower = error.to_ascii_lowercase();
    lower.contains("initialized but not ready")
        || lower.contains("not ready")
        || lower.contains("insufficient resources")
        || lower.contains("rate")
        || lower.contains("throttle")
        || lower.contains("too many")
}

fn worker_relay_retry_delay(failures: u32, error: Option<&str>) -> Duration {
    let exponent = failures.saturating_sub(1).min(10);
    let secs = worker_relay_error_base_secs(error)
        .saturating_mul(2u64.saturating_pow(exponent))
        .min(WORKER_RELAY_MAX_BACKOFF_SECS);
    Duration::from_secs(secs)
}

fn record_worker_relay_backoff_result(
    relay_backoff: &mut HashMap<String, RelayBackoffState>,
    relay: &RelayUrl,
    success: bool,
    label: &str,
    error: Option<&str>,
) {
    let key = normalize_relay_key(&relay.to_string());
    if success {
        if relay_backoff.remove(&key).is_some() {
            info!("{label} relay recovered and will be retried normally: {relay}");
        }
        return;
    }

    let entry = relay_backoff.entry(key).or_default();
    entry.failures = entry.failures.saturating_add(1);
    if entry.failures < WORKER_RELAY_FAILURES_BEFORE_BACKOFF
        && !is_immediate_worker_relay_backoff_error(error)
    {
        debug!(
            "{label} relay failure recorded for {relay}; waiting for repeat failure before backoff"
        );
        return;
    }

    let delay = worker_relay_retry_delay(entry.failures, error);
    entry.next_retry_at = Some(Instant::now() + delay);
    let relay_kind = if is_discouraged_worker_relay(&relay.to_string()) {
        "discouraged "
    } else {
        ""
    };
    warn!(
        "{label} {relay_kind}relay failed; backing off for {}s before retrying {relay}",
        delay.as_secs()
    );
}

#[cfg(test)]
fn discouraged_relay_retry_delay(failures: u32) -> Duration {
    worker_relay_retry_delay(failures, None)
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
    use crate::model::{QuestionnaireBlindPrivateKey, QuestionnaireDefinitionReference};
    use blind_rsa_signatures::{DefaultRng, KeyPairSha384PSSDeterministic};
    use chrono::Duration as ChronoDuration;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};
    use std::fs;
    use std::path::PathBuf;
    use std::time::{Instant, SystemTime, UNIX_EPOCH};

    #[test]
    fn persisted_state_is_reset_when_worker_identity_changes() {
        let state = WorkerPersistentState {
            worker_npub: "npub1oldworker".to_string(),
            coordinator_npub: "npub1coordinator".to_string(),
            ..WorkerPersistentState::default()
        };

        assert!(persistent_state_identity_mismatch(
            &state,
            "npub1newworker",
            "npub1coordinator"
        ));
    }

    #[test]
    fn persisted_state_accepts_matching_or_legacy_identity() {
        let matching = WorkerPersistentState {
            worker_npub: "npub1worker".to_string(),
            coordinator_npub: "npub1coordinator".to_string(),
            ..WorkerPersistentState::default()
        };

        assert!(!persistent_state_identity_mismatch(
            &matching,
            "npub1worker",
            "npub1coordinator"
        ));
        assert!(!persistent_state_identity_mismatch(
            &WorkerPersistentState::default(),
            "npub1worker",
            "npub1coordinator"
        ));
    }

    fn sample_request() -> BlindBallotRequest {
        BlindBallotRequest {
            message_type: "blind_ballot_request".to_string(),
            schema_version: 1,
            election_id: "q_worker_definition".to_string(),
            request_id: "request_worker_definition".to_string(),
            invited_npub: "npub1invitee000000000000000000000000000000000000000000000000"
                .to_string(),
            blinded_message: "abcd".to_string(),
            blind_signing_key_id: "key_worker_definition".to_string(),
            client_nonce: "nonce_worker_definition".to_string(),
            created_at: now_iso(),
            invite_code_hash: None,
            general_invite_pow: None,
            ballot_scope: None,
        }
    }

    fn mine_general_invite_pow(request: &BlindBallotRequest, difficulty: u8) -> String {
        for candidate in 0_u64.. {
            let nonce = candidate.to_string();
            if has_leading_zero_bits(
                &Sha256::digest(general_invite_pow_preimage(request, &nonce).as_bytes()),
                difficulty,
            ) {
                return nonce;
            }
        }
        unreachable!("unbounded nonce search always finds a SHA-256 preimage")
    }

    #[test]
    fn general_invite_pow_accepts_canonical_valid_proof() {
        let definition = json!({ "generalInvitePowDifficulty": 8 });
        let mut request = sample_request();
        request.general_invite_pow = Some(GeneralInvitePowProof {
            nonce: mine_general_invite_pow(&request, 8),
        });

        assert!(verify_general_invite_pow(&definition, &request));
    }

    #[test]
    fn general_invite_pow_rejects_missing_or_request_mismatched_proofs() {
        let definition = json!({ "generalInvitePowDifficulty": 8 });
        let request = sample_request();
        assert!(!verify_general_invite_pow(&definition, &request));

        let mut request_with_proof = request.clone();
        loop {
            request_with_proof.general_invite_pow = Some(GeneralInvitePowProof {
                nonce: mine_general_invite_pow(&request_with_proof, 8),
            });
            let mut wrong_request = request_with_proof.clone();
            wrong_request.request_id.push_str("-wrong");
            if !verify_general_invite_pow(&definition, &wrong_request) {
                break;
            }
            request_with_proof.client_nonce.push('x');
        }
        let mut wrong_request = request_with_proof.clone();
        wrong_request.request_id.push_str("-wrong");
        assert!(!verify_general_invite_pow(&definition, &wrong_request));
    }

    #[test]
    fn general_invite_pow_exempts_private_invite_claims() {
        let definition = json!({ "generalInvitePowDifficulty": 24 });
        let mut request = sample_request();
        request.invite_code_hash = Some("a private invite-code claim".to_string());

        assert!(verify_general_invite_pow(&definition, &request));
    }

    #[tokio::test]
    async fn invalid_general_invite_pow_is_rejected_before_eligibility_or_signing() {
        let coordinator_keys = Keys::generate();
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());
        let request = sample_request();
        {
            let mut state = runtime.state.lock().await;
            state.elections.insert(
                request.election_id.clone(),
                ElectionRuntimeState {
                    election_id: request.election_id.clone(),
                    delegation_id: "delegation_pow".to_string(),
                    capabilities: vec![WorkerCapability::IssueBlindTokens],
                    eligibility_configured: true,
                    eligibility_required: true,
                    definition: Some(json!({
                        "generalInvitePowDifficulty": 8,
                        "blindSigningPublicKey": { "keyId": request.blind_signing_key_id }
                    })),
                    blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                        scheme: "rsabssa-sha384-pss-deterministic-v1".to_string(),
                        key_id: request.blind_signing_key_id.clone(),
                        jwk: json!({}),
                        private_jwk: json!({}),
                    }),
                    ..ElectionRuntimeState::default()
                },
            );
        }

        assert!(matches!(
            runtime.prepare_blind_issuance(request.clone()).await.expect("prepare request"),
            PreparedBlindIssuance::Handled
        ));
        let state = runtime.state.lock().await;
        let election = state.elections.get(&request.election_id).expect("configured election");
        assert!(!election.whitelist_npubs.contains(&request.invited_npub));
        assert!(election.issued_issuances_by_request_id.is_empty());
        drop(state);
        fs::remove_dir_all(state_dir).ok();
    }

    fn hex_bytes(bytes: &[u8]) -> String {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    }

    fn private_jwk_from_keypair(keypair: &KeyPairSha384PSSDeterministic) -> serde_json::Value {
        let components = keypair.sk.components();
        let primes = components.primes();
        json!({
            "kty": "RSA",
            "alg": "PS384",
            "ext": true,
            "n": URL_SAFE_NO_PAD.encode(components.n()),
            "e": URL_SAFE_NO_PAD.encode(components.e()),
            "d": URL_SAFE_NO_PAD.encode(components.d()),
            "p": URL_SAFE_NO_PAD.encode(&primes[0]),
            "q": URL_SAFE_NO_PAD.encode(&primes[1]),
        })
    }

    fn test_definition_and_keypair(
        questionnaire_id: &str,
    ) -> (serde_json::Value, KeyPairSha384PSSDeterministic) {
        let mut rng = DefaultRng;
        let keypair = KeyPairSha384PSSDeterministic::generate(&mut rng, 2048)
            .expect("generate blind rsa keypair");
        let components = keypair.pk.components();
        let jwk = json!({
            "kty": "RSA",
            "alg": "PS384",
            "ext": true,
            "n": URL_SAFE_NO_PAD.encode(components.n()),
            "e": URL_SAFE_NO_PAD.encode(components.e()),
        });
        let definition = json!({
            "schemaVersion": 2,
            "eventType": "questionnaire_definition",
            "questionnaireId": questionnaire_id,
            "title": "Delegated definition",
            "description": "Public definition",
            "blindSigningPublicKey": {
                "scheme": "rsabssa-sha384-pss-deterministic-v1",
                "keyId": "key_test_public",
                "jwk": jwk,
            },
            "questions": [{
                "questionId": "q1",
                "prompt": "Question 1",
                "type": "yes_no",
                "required": true
            }]
        });
        (definition, keypair)
    }

    fn sign_test_token(
        keypair: &KeyPairSha384PSSDeterministic,
        questionnaire_id: &str,
        token_commitment: &str,
        ballot_scope: Option<&serde_json::Value>,
    ) -> String {
        let mut rng = DefaultRng;
        let message =
            build_blind_token_signed_message(questionnaire_id, token_commitment, ballot_scope);
        let blinding = keypair
            .pk
            .blind(&mut rng, message.as_bytes())
            .expect("blind token message");
        let blind_signature = keypair
            .sk
            .blind_sign(&blinding.blind_message)
            .expect("blind sign token message");
        let signature = keypair
            .pk
            .finalize(&blind_signature, &blinding, message.as_bytes())
            .expect("finalize token signature");
        hex_bytes(&signature.0)
    }

    fn signed_submission(
        keypair: &KeyPairSha384PSSDeterministic,
        questionnaire_id: &str,
        response_id: &str,
        token_commitment: &str,
        token_nullifier: &str,
    ) -> QuestionnaireBlindResponseEvent {
        let signature = sign_test_token(keypair, questionnaire_id, token_commitment, None);
        QuestionnaireBlindResponseEvent {
            schema_version: 1,
            event_type: "questionnaire_response_blind".to_string(),
            questionnaire_id: questionnaire_id.to_string(),
            response_id: response_id.to_string(),
            submitted_at: 1_782_000_000,
            author_pubkey: format!("{response_id}_author"),
            token_nullifier: token_nullifier.to_string(),
            token_nullifiers: vec![],
            token_proof: BlindTokenProof {
                token_commitment: token_commitment.to_string(),
                questionnaire_id: questionnaire_id.to_string(),
                signature,
                question_id: None,
                ballot_scope: None,
            },
            token_proofs: vec![],
            answers: vec![json!({
                "questionId": "q1",
                "answerType": "yes_no",
                "answer": "yes"
            })],
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
        let (control_blind_request_sender, _control_blind_request_receiver) =
            mpsc::channel(CONTROL_BLIND_REQUEST_QUEUE_SIZE);

        let runtime = WorkerRuntime {
            config: WorkerConfig {
                worker_nsec: worker_keys.secret_key().to_bech32().expect("worker nsec"),
                coordinator_npub,
                worker_relays: vec![RelayUrl::parse("wss://relay.example.com").expect("relay")],
                worker_dm_relays: vec![RelayUrl::parse("wss://relay.example.com").expect("relay")],
                public_archive_relays: Vec::new(),
                worker_relays_from_env: true,
                worker_dm_relays_from_env: true,
                worker_state_dir: state_dir.clone(),
                heartbeat_seconds: 30,
                poll_seconds: 5,
                public_archive_interval_ms: 500,
                public_archive_queue_size: 10_000,
                blossom_result_pack_servers: Vec::new(),
            },
            client: Client::new(worker_keys.clone()),
            worker_pubkey: worker_keys.public_key(),
            worker_npub,
            coordinator_pubkey: coordinator_keys.public_key(),
            store,
            state: Arc::new(Mutex::new(state)),
            relay_backoff: Arc::new(Mutex::new(HashMap::new())),
            completion_in_flight: Arc::new(Mutex::new(HashSet::new())),
            queued_control_event_ids: Arc::new(Mutex::new(HashSet::new())),
            public_response_permits: Arc::new(Semaphore::new(PUBLIC_RESPONSE_CONCURRENCY)),
            public_archive_sender: None,
            control_blind_request_sender,
        };
        (runtime, state_dir)
    }

    #[tokio::test]
    async fn blind_request_before_worker_config_is_deferred_with_payload() {
        let coordinator_keys = Keys::generate();
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());
        let request = sample_request();

        let result = runtime
            .prepare_blind_issuance(request.clone())
            .await
            .expect("prepare blind issuance");

        assert!(matches!(result, PreparedBlindIssuance::Deferred));
        let state = runtime.state.lock().await;
        let election = state
            .elections
            .get(&request.election_id)
            .expect("deferred election");
        assert!(election
            .deferred_blind_request_ids
            .contains(&request.request_id));
        assert_eq!(
            election
                .deferred_blind_requests
                .get(&request.request_id)
                .expect("deferred request")
                .invited_npub,
            request.invited_npub
        );
        drop(state);
        fs::remove_dir_all(state_dir).ok();
    }

    #[test]
    fn deferred_blind_request_retry_waits_for_eligibility() {
        let request = sample_request();
        let mut election = ElectionRuntimeState::default();

        assert!(!deferred_blind_request_ready_for_retry(&election, &request));

        election
            .whitelist_npubs
            .insert(request.invited_npub.clone());
        assert!(deferred_blind_request_ready_for_retry(&election, &request));
    }

    #[tokio::test]
    async fn deferred_blind_request_can_issue_after_worker_config_arrives() {
        let coordinator_keys = Keys::generate();
        let (definition, keypair) = test_definition_and_keypair("q_worker_definition");
        let mut request = sample_request();
        request.blind_signing_key_id = "key_test_public".to_string();
        let mut rng = DefaultRng;
        let blinding = keypair
            .pk
            .blind(&mut rng, b"request-before-config")
            .expect("blind request token");
        request.blinded_message = hex_bytes(&blinding.blind_message.0);
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());

        assert!(matches!(
            runtime
                .prepare_blind_issuance(request.clone())
                .await
                .expect("defer request"),
            PreparedBlindIssuance::Deferred
        ));

        {
            let mut state = runtime.state.lock().await;
            let election = state
                .elections
                .get_mut(&request.election_id)
                .expect("deferred election");
            election.delegation_id = "delegation_worker_definition".to_string();
            election.capabilities = vec![WorkerCapability::IssueBlindTokens];
            election.expires_at = (Utc::now() + ChronoDuration::days(1)).to_rfc3339();
            election.expected_invitee_count = Some(1);
            election.eligibility_configured = true;
            election.definition = Some(definition);
            election.blind_signing_private_key = Some(QuestionnaireBlindPrivateKey {
                scheme: "rsabssa-sha384-pss-deterministic-v1".to_string(),
                key_id: "key_test_public".to_string(),
                jwk: json!({}),
                private_jwk: private_jwk_from_keypair(&keypair),
            });
            runtime.store.save(&state).expect("save configured state");
        }

        let stored_request = {
            let state = runtime.state.lock().await;
            state
                .elections
                .get(&request.election_id)
                .expect("configured election")
                .deferred_blind_requests
                .get(&request.request_id)
                .expect("stored deferred request")
                .clone()
        };
        let PreparedBlindIssuance::Issuance { request, issuance } = runtime
            .prepare_blind_issuance(stored_request)
            .await
            .expect("issue deferred request")
        else {
            panic!("expected deferred request to become issuable");
        };
        assert_eq!(issuance.request_id, request.request_id);
        runtime
            .mark_blind_issuances_published(&[request.clone()], &[issuance.clone()])
            .await
            .expect("mark issued");

        let state = runtime.state.lock().await;
        let election = state
            .elections
            .get(&request.election_id)
            .expect("issued election");
        assert!(!election
            .deferred_blind_request_ids
            .contains(&request.request_id));
        assert!(!election
            .deferred_blind_requests
            .contains_key(&request.request_id));
        assert!(election
            .seen_blind_request_ids
            .contains(&request.request_id));
        assert_eq!(
            election
                .issued_issuances_by_request_id
                .get(&request.request_id)
                .expect("persisted issuance")
                .issuance_id,
            issuance.issuance_id
        );
        drop(state);

        let PreparedBlindIssuance::Issuance {
            issuance: replayed, ..
        } = runtime
            .prepare_blind_issuance(request)
            .await
            .expect("prepare replayed issuance")
        else {
            panic!("expected persisted issuance replay");
        };
        assert_eq!(replayed.issuance_id, issuance.issuance_id);
        fs::remove_dir_all(state_dir).ok();
    }

    fn throughput_scoped_request(voter_index: usize, question_index: usize) -> BlindBallotRequest {
        let mut request = sample_request();
        let slot_index = question_index + 1;
        request.election_id = "q_throughput_bundle".to_string();
        request.request_id = format!("request_{voter_index:03}_{slot_index:02}");
        request.invited_npub = format!("npub1throughput{voter_index:048}");
        request.blinded_message =
            format!("blind_{voter_index:03}_{slot_index:02}_{}", "x".repeat(512));
        request.client_nonce = format!("nonce_{voter_index:03}_{slot_index:02}");
        request.ballot_scope = Some(json!({
            "questionId": format!("q{slot_index}"),
            "slotId": format!("q{slot_index}"),
            "slotIndex": slot_index,
            "version": 1
        }));
        request
    }

    fn stress_env_usize(name: &str, fallback: usize) -> usize {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(fallback)
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
    fn proxy_credential_scope_keys_are_distinct() {
        let first_scope = Some(json!({
            "questionId": "q1",
            "slotId": "director-alice",
            "slotIndex": 1,
            "version": 1
        }));
        let second_scope = Some(json!({
            "questionId": "q1",
            "slotId": "director-alice",
            "slotIndex": 1,
            "version": 1,
            "credentialIndex": 2
        }));
        assert_eq!(ballot_scope_key(&first_scope), "slot:1:v1");
        assert_eq!(ballot_scope_key(&second_scope), "slot:1:v1:c2");

        let first_message =
            build_blind_token_signed_message("q_proxy", "commitment", first_scope.as_ref());
        let second_message =
            build_blind_token_signed_message("q_proxy", "commitment", second_scope.as_ref());
        assert_ne!(first_message, second_message);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&second_message)
                .expect("valid message json")
                .pointer("/ballot_scope/credential_index"),
            Some(&json!(2))
        );

        let mut first_request = sample_request();
        first_request.ballot_scope = first_scope;
        let mut second_request = sample_request();
        second_request.ballot_scope = second_scope;
        assert_ne!(
            blind_request_issuance_scope_key(&first_request),
            blind_request_issuance_scope_key(&second_request)
        );
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
            bearer_invite_codes: Some(vec![BearerInviteCodeEntry {
                election_id: "q_worker_definition".to_string(),
                code_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
                created_at: now_iso(),
                state: "available".to_string(),
                credentials_per_voter: None,
                ballot_group: None,
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
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
    async fn public_definition_event_ignores_undelegated_election() {
        let coordinator_keys = Keys::generate();
        let definition = public_definition("q_public_definition_undelegated", "key-live");
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());
        let event = public_definition_event(&coordinator_keys, &definition);

        assert!(!runtime
            .process_public_definition_event(&event)
            .await
            .expect("process definition"));

        let state = runtime.state.lock().await;
        assert!(!state
            .elections
            .contains_key("q_public_definition_undelegated"));
        drop(state);
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
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
            proxy_voter_npubs: None,
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
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
            proxy_voter_npubs: None,
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
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
            proxy_voter_npubs: None,
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
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

    #[test]
    fn empty_blind_worker_election_config_with_key_material_can_apply_initially() {
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
            proxy_voter_npubs: None,
            ballot_groups_by_npub: None,
            bearer_invite_codes: Some(vec![]),
            eligibility_required: Some(true),
            blind_signing_private_key: Some(QuestionnaireBlindPrivateKey {
                scheme: "rsa-blind-pss-sha384".to_string(),
                key_id: "private-key-id".to_string(),
                jwk: json!({}),
                private_jwk: json!({}),
            }),
            definition_reference: Some(QuestionnaireDefinitionReference {
                questionnaire_id: "q_worker_definition".to_string(),
                coordinator_npub: Some(
                    "npub1coordinator000000000000000000000000000000000000000000".to_string(),
                ),
                relays: Some(vec!["wss://relay.nostr.net".to_string()]),
                definition_hash: Some("definition-hash".to_string()),
                definition_event_id: Some("definition-event".to_string()),
                created_at: Some(1_781_200_000),
            }),
            definition: None,
            sent_at: "2026-06-15T20:09:03.000Z".to_string(),
        };

        assert!(apply_worker_election_config(&mut election, &snapshot));
        assert_eq!(election.expected_invitee_count, Some(0));
        assert!(election.eligibility_configured);
        assert!(election.eligibility_required);
        assert_eq!(
            election
                .blind_signing_private_key
                .as_ref()
                .map(|key| key.key_id.as_str()),
            Some("private-key-id"),
        );
        assert_eq!(election.definition_hash.as_deref(), Some("definition-hash"));
        assert_eq!(
            election.definition_event_id.as_deref(),
            Some("definition-event")
        );
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
    fn blind_response_proof_verification_uses_public_definition_key() {
        let questionnaire_id = "q_verify_proof";
        let (definition, keypair) = test_definition_and_keypair(questionnaire_id);
        let election = ElectionRuntimeState {
            election_id: questionnaire_id.to_string(),
            definition: Some(definition),
            ..ElectionRuntimeState::default()
        };
        let submission = signed_submission(
            &keypair,
            questionnaire_id,
            "response_valid",
            "commitment_valid",
            "nullifier_valid",
        );

        assert!(verify_blind_response_proofs(&election, &submission));

        let mut tampered = submission.clone();
        tampered.token_proof.token_commitment = "commitment_tampered".to_string();
        assert!(!verify_blind_response_proofs(&election, &tampered));

        let mut tampered_scope = submission.clone();
        tampered_scope.token_proof.ballot_scope = Some(json!({
            "questionId": "q1",
            "slotId": "q1:2",
            "slotIndex": 2,
            "version": 1
        }));
        assert!(!verify_blind_response_proofs(&election, &tampered_scope));
    }

    #[tokio::test]
    async fn handle_submission_requires_valid_proof_and_rejects_commitment_replay() {
        let questionnaire_id = "q_handle_verified_submission";
        let (definition, keypair) = test_definition_and_keypair(questionnaire_id);
        let coordinator_keys = Keys::generate();
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            questionnaire_id.to_string(),
            ElectionRuntimeState {
                election_id: questionnaire_id.to_string(),
                delegation_id: "delegation_verified_submission".to_string(),
                definition: Some(definition),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);

        let mut invalid = signed_submission(
            &keypair,
            questionnaire_id,
            "response_invalid",
            "commitment_invalid",
            "nullifier_invalid",
        );
        invalid.token_proof.signature = "00".to_string();
        assert!(runtime
            .handle_submission(invalid)
            .await
            .expect("handle invalid"));
        {
            let state = runtime.state.lock().await;
            let election = state.elections.get(questionnaire_id).expect("election");
            assert_eq!(election.accepted_response_count, 0);
            assert_eq!(election.rejected_response_count, 1);
            assert!(election.accepted_token_commitments.is_empty());
        }

        let valid = signed_submission(
            &keypair,
            questionnaire_id,
            "response_valid",
            "commitment_replay_test",
            "nullifier_valid",
        );
        assert!(runtime
            .handle_submission(valid.clone())
            .await
            .expect("handle valid"));
        {
            let state = runtime.state.lock().await;
            let election = state.elections.get(questionnaire_id).expect("election");
            assert_eq!(election.accepted_response_count, 1);
            assert_eq!(election.rejected_response_count, 1);
            assert!(election
                .accepted_token_commitments
                .contains("commitment_replay_test"));
        }

        let replay_with_new_nullifier = QuestionnaireBlindResponseEvent {
            response_id: "response_replay".to_string(),
            token_nullifier: "nullifier_changed".to_string(),
            author_pubkey: "response_replay_author".to_string(),
            ..valid
        };
        assert!(runtime
            .handle_submission(replay_with_new_nullifier)
            .await
            .expect("handle replay"));
        {
            let state = runtime.state.lock().await;
            let election = state.elections.get(questionnaire_id).expect("election");
            assert_eq!(election.accepted_response_count, 1);
            assert_eq!(election.rejected_response_count, 2);
            assert!(!election.accepted_nullifiers.contains("nullifier_changed"));
        }

        let _ = fs::remove_dir_all(state_dir);
    }

    #[tokio::test]
    async fn handle_submission_rejects_answers_outside_required_scope() {
        let questionnaire_id = "q_handle_grouped_submission";
        let (mut definition, keypair) = test_definition_and_keypair(questionnaire_id);
        definition["questions"] = json!([
            {
                "questionId": "q1",
                "prompt": "Main question",
                "type": "yes_no",
                "required": true
            },
            {
                "questionId": "q_a",
                "prompt": "Scope 1 question",
                "type": "yes_no",
                "required": true,
                "requiredScope": "1"
            }
        ]);
        let coordinator_keys = Keys::generate();
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            questionnaire_id.to_string(),
            ElectionRuntimeState {
                election_id: questionnaire_id.to_string(),
                delegation_id: "delegation_grouped_submission".to_string(),
                definition: Some(definition),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);

        let wrong_scope = json!({ "allowedScopes": ["0", "2"] });
        let mut wrong_group = signed_submission(
            &keypair,
            questionnaire_id,
            "response_wrong_group",
            "commitment_wrong_group",
            "nullifier_wrong_group",
        );
        wrong_group.token_proof.signature = sign_test_token(
            &keypair,
            questionnaire_id,
            "commitment_wrong_group",
            Some(&wrong_scope),
        );
        wrong_group.token_proof.ballot_scope = Some(wrong_scope);
        wrong_group.answers = vec![json!({
            "questionId": "q_a",
            "answerType": "yes_no",
            "answer": "yes"
        })];
        assert!(runtime
            .handle_submission(wrong_group)
            .await
            .expect("handle wrong group"));

        let right_scope = json!({ "allowedScopes": ["0", "1"] });
        let mut right_group = signed_submission(
            &keypair,
            questionnaire_id,
            "response_right_group",
            "commitment_right_group",
            "nullifier_right_group",
        );
        right_group.token_proof.signature = sign_test_token(
            &keypair,
            questionnaire_id,
            "commitment_right_group",
            Some(&right_scope),
        );
        right_group.token_proof.ballot_scope = Some(right_scope);
        right_group.answers = vec![
            json!({
                "questionId": "q1",
                "answerType": "yes_no",
                "answer": "yes"
            }),
            json!({
                "questionId": "q_a",
                "answerType": "yes_no",
                "answer": "yes"
            }),
        ];
        assert!(runtime
            .handle_submission(right_group)
            .await
            .expect("handle right group"));

        {
            let state = runtime.state.lock().await;
            let election = state.elections.get(questionnaire_id).expect("election");
            assert_eq!(election.accepted_response_count, 1);
            assert_eq!(election.rejected_response_count, 1);
        }

        let _ = fs::remove_dir_all(state_dir);
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
                    credentials_per_voter: None,
                    ballot_group: None,
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
    fn private_invite_code_with_two_credentials_authorizes_proxy_voter() {
        let code_hash = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
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
                    credentials_per_voter: Some(2),
                    ballot_group: None,
                    redeemed_at: None,
                    redeemed_npub: None,
                    revoked_at: None,
                },
            )]),
            ..ElectionRuntimeState::default()
        };

        let mut first_request = sample_request();
        first_request.invite_code_hash = Some(code_hash.to_string());

        assert_eq!(
            authorize_blind_request(&mut election, &first_request),
            BlindRequestAuthorization::Authorized {
                state_changed: true
            }
        );
        assert!(election
            .whitelist_npubs
            .contains(&first_request.invited_npub));
        assert!(election
            .proxy_voter_npubs
            .contains(&first_request.invited_npub));

        let mut second_credential_request = first_request.clone();
        second_credential_request.request_id =
            "request_worker_definition_proxy_private".to_string();
        second_credential_request.ballot_scope = Some(json!({
            "slotIndex": 1,
            "version": 1,
            "credentialIndex": 2
        }));

        assert!(blind_request_proxy_authorized(
            &election,
            &second_credential_request
        ));
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

    #[tokio::test]
    #[ignore = "local throughput probe"]
    async fn throughput_stress_control_bundle_decode() {
        let voter_count = stress_env_usize("WORKER_THROUGHPUT_BUNDLE_VOTERS", 60);
        let question_count = stress_env_usize("WORKER_THROUGHPUT_BUNDLE_QUESTIONS", 23);
        let coordinator_keys = Keys::generate();
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());
        let mut compressed_count = 0usize;
        let bundles = (0..voter_count)
            .map(|voter_index| {
                let envelope = BlindBallotRequestBundleEnvelope {
                    message_type: "optiona_blind_request_bundle_dm".to_string(),
                    schema_version: 1,
                    requests: (0..question_count)
                        .map(|question_index| {
                            throughput_scoped_request(voter_index, question_index)
                        })
                        .collect(),
                    sent_at: "2026-07-02T00:00:00Z".to_string(),
                };
                let content = serde_json::to_string(&envelope).expect("serialize request bundle");
                let encoded = maybe_compress_bundle_content(
                    content,
                    "optiona_blind_request_bundle_dm",
                    "2026-07-02T00:00:00Z",
                )
                .expect("encode request bundle");
                let encoded_type = serde_json::from_str::<serde_json::Value>(&encoded)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("type")
                            .and_then(|entry| entry.as_str())
                            .map(str::to_string)
                    });
                if encoded_type.as_deref() == Some(COMPRESSED_BUNDLE_MESSAGE_TYPE) {
                    compressed_count += 1;
                }
                encoded
            })
            .collect::<Vec<_>>();
        let payload_bytes = bundles.iter().map(|bundle| bundle.len()).sum::<usize>();
        let started = Instant::now();
        let mut decoded_requests = 0usize;

        for (voter_index, bundle) in bundles.iter().enumerate() {
            let authenticated_sender = format!("npub1throughput{voter_index:048}");
            match runtime
                .process_control_message(bundle, &authenticated_sender)
                .await
                .expect("process bundled control message")
            {
                ControlMessageAction::BlindRequests(requests) => {
                    decoded_requests += requests.len();
                }
                other => panic!("expected blind request bundle, got {other:?}"),
            }
        }

        let elapsed = started.elapsed();
        assert_eq!(decoded_requests, voter_count * question_count);
        eprintln!(
            "throughput_stress_control_bundle_decode bundles={} requests={} compressed_bundles={} payload_bytes={} elapsed_ms={} requests_per_sec={:.1}",
            voter_count,
            decoded_requests,
            compressed_count,
            payload_bytes,
            elapsed.as_millis(),
            decoded_requests as f64 / elapsed.as_secs_f64().max(0.001)
        );
        fs::remove_dir_all(state_dir).ok();
    }

    #[test]
    #[ignore = "local throughput probe"]
    fn throughput_stress_worker_state_save_large_session() {
        let submission_count = stress_env_usize("WORKER_THROUGHPUT_STATE_SUBMISSIONS", 1_495);
        let iteration_count = stress_env_usize("WORKER_THROUGHPUT_STATE_SAVE_ITERATIONS", 25);
        let state_dir = unique_worker_state_dir("throughput-state-save");
        let store = WorkerStore::open(&state_dir).expect("open worker store");
        let mut state = WorkerPersistentState {
            coordinator_npub: "npub1coordinator".to_string(),
            worker_npub: "npub1worker".to_string(),
            relays: vec!["wss://vm-1734.lnvps.cloud/".to_string()],
            ..WorkerPersistentState::default()
        };
        state.seen_control_event_ids = (0..60)
            .map(|index| (format!("control_event_{index:03}"), now_iso()))
            .collect();
        let mut election = ElectionRuntimeState {
            election_id: "q_throughput_state".to_string(),
            delegation_id: "delegation_throughput_state".to_string(),
            capabilities: vec![
                WorkerCapability::IssueBlindTokens,
                WorkerCapability::VerifyPublicSubmissions,
                WorkerCapability::PublishSubmissionDecisions,
            ],
            control_relays: vec!["wss://vm-1734.lnvps.cloud/".to_string()],
            expires_at: (Utc::now() + ChronoDuration::days(1)).to_rfc3339(),
            expected_invitee_count: Some(65),
            accepted_response_count: submission_count as u64,
            eligibility_configured: true,
            ..ElectionRuntimeState::default()
        };
        for index in 0..65 {
            election
                .whitelist_npubs
                .insert(format!("npub1voter{index:056}"));
            election
                .accepted_response_authors
                .insert(format!("npub1voter{index:056}"));
            election
                .issued_invited_npubs
                .insert(format!("npub1voter{index:056}"));
        }
        for index in 0..submission_count {
            election
                .processed_submission_ids
                .insert(format!("submission_{index:04}"));
            election
                .accepted_nullifiers
                .insert(format!("nullifier_{index:04}"));
            election
                .accepted_token_commitments
                .insert(format!("commitment_{index:04}"));
            election.published_decisions.insert(
                format!("submission_{index:04}"),
                format!("decision_event_{index:04}"),
            );
            election
                .seen_blind_request_ids
                .insert(format!("request_{index:04}"));
            election.issued_invited_scope_keys.insert(format!(
                "npub1voter{:056}|q{}",
                index % 65,
                (index % 23) + 1
            ));
        }
        state
            .elections
            .insert(election.election_id.clone(), election);

        store.save(&state).expect("warm save worker state");
        let state_bytes = fs::metadata(state_dir.join("state.json"))
            .expect("state metadata")
            .len();
        let started = Instant::now();
        for _ in 0..iteration_count {
            store.save(&state).expect("save worker state");
        }
        let elapsed = started.elapsed();
        eprintln!(
            "throughput_stress_worker_state_save_large_session submissions={} iterations={} state_bytes={} elapsed_ms={} avg_save_ms={:.3}",
            submission_count,
            iteration_count,
            state_bytes,
            elapsed.as_millis(),
            elapsed.as_secs_f64() * 1000.0 / iteration_count as f64
        );
        fs::remove_dir_all(state_dir).ok();
    }

    #[tokio::test]
    #[ignore = "local throughput probe"]
    async fn throughput_stress_submission_update_without_publish() {
        let submission_count = stress_env_usize("WORKER_THROUGHPUT_SUBMISSIONS", 100);
        let questionnaire_id = "q_throughput_submission";
        let (definition, keypair) = test_definition_and_keypair(questionnaire_id);
        let coordinator_keys = Keys::generate();
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            questionnaire_id.to_string(),
            ElectionRuntimeState {
                election_id: questionnaire_id.to_string(),
                delegation_id: "delegation_throughput_submission".to_string(),
                capabilities: vec![WorkerCapability::VerifyPublicSubmissions],
                expires_at: (Utc::now() + ChronoDuration::days(1)).to_rfc3339(),
                definition: Some(definition),
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);
        let build_started = Instant::now();
        let submissions = (0..submission_count)
            .map(|index| {
                signed_submission(
                    &keypair,
                    questionnaire_id,
                    &format!("response_{index:04}"),
                    &format!("commitment_{index:04}"),
                    &format!("nullifier_{index:04}"),
                )
            })
            .collect::<Vec<_>>();
        let build_elapsed = build_started.elapsed();
        let started = Instant::now();

        for submission in submissions {
            assert!(runtime
                .handle_submission(submission)
                .await
                .expect("handle submission"));
        }

        let elapsed = started.elapsed();
        {
            let state = runtime.state.lock().await;
            let election = state
                .elections
                .get(questionnaire_id)
                .expect("throughput election");
            assert_eq!(election.accepted_response_count, submission_count as u64);
            assert_eq!(election.rejected_response_count, 0);
        }
        let state_bytes = fs::metadata(state_dir.join("state.json"))
            .expect("state metadata")
            .len();
        eprintln!(
            "throughput_stress_submission_update_without_publish submissions={} build_ms={} handle_ms={} handle_per_sec={:.1} state_bytes={}",
            submission_count,
            build_elapsed.as_millis(),
            elapsed.as_millis(),
            submission_count as f64 / elapsed.as_secs_f64().max(0.001),
            state_bytes
        );
        fs::remove_dir_all(state_dir).ok();
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
    fn proxy_second_credential_requires_per_voter_allowance() {
        let mut election = ElectionRuntimeState::default();
        let first_request = sample_request();
        let mut second_request = sample_request();
        second_request.request_id = "request_worker_definition_proxy".to_string();
        second_request.ballot_scope = Some(json!({
            "slotIndex": 1,
            "version": 1,
            "credentialIndex": 2
        }));

        assert!(blind_request_proxy_authorized(&election, &first_request));
        assert!(!blind_request_proxy_authorized(&election, &second_request));

        election
            .proxy_voter_npubs
            .insert(second_request.invited_npub.clone());

        assert!(blind_request_proxy_authorized(&election, &second_request));
    }

    #[test]
    fn whitelist_allowed_scope_restricts_blind_request_scope() {
        let mut election = ElectionRuntimeState::default();
        election.whitelist_npubs.insert("npub1voter".to_string());
        election
            .ballot_groups_by_npub
            .insert("npub1voter".to_string(), "group_north".to_string());

        let mut request = sample_request();
        request.invited_npub = "npub1voter".to_string();
        request.ballot_scope = Some(json!({ "allowedScopes": ["0", "group_north"] }));
        assert!(matches!(
            authorize_blind_request(&mut election, &request),
            BlindRequestAuthorization::Authorized { .. }
        ));

        let mut wrong_group_request = request.clone();
        wrong_group_request.request_id = "request_wrong_group".to_string();
        wrong_group_request.ballot_scope = Some(json!({ "allowedScopes": ["0", "group_south"] }));
        assert!(matches!(
            authorize_blind_request(&mut election, &wrong_group_request),
            BlindRequestAuthorization::Rejected
        ));

        let mut unscoped_request = request.clone();
        unscoped_request.request_id = "request_unscoped_group".to_string();
        unscoped_request.ballot_scope = None;
        assert!(matches!(
            authorize_blind_request(&mut election, &unscoped_request),
            BlindRequestAuthorization::Rejected
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
    fn private_dm_relay_filter_excludes_public_only_relays() {
        assert!(is_private_dm_rejecting_relay("wss://relay.nostr.info"));
        assert!(is_private_dm_rejecting_relay("wss://relay.nostr.info/"));
        assert!(!is_private_dm_rejecting_relay("wss://relay.nostr.net"));
        assert!(!is_private_dm_rejecting_relay("wss://nos.lol"));
    }

    #[test]
    fn result_summary_tags_include_q_index() {
        let pack = BlossomResultPackReference {
            url: "https://blossom.nostr.build/blob".to_string(),
            sha256: "a".repeat(64),
            size: 123,
            media_type: BLOSSOM_RESULT_PACK_TYPE.to_string(),
            compression: "none".to_string(),
            upload_encoding: Some(BLOSSOM_RESULT_PACK_UPLOAD_ENCODING.to_string()),
            payload_sha256: None,
            payload_size: None,
            uploaded_at: 1,
            server: Some("https://blossom.nostr.build".to_string()),
            mirrors: vec![
                BlossomResultPackMirror {
                    url: "https://blossom.nostr.build/blob".to_string(),
                    server: Some("https://blossom.nostr.build".to_string()),
                },
                BlossomResultPackMirror {
                    url: "https://blossom.primal.net/blob".to_string(),
                    server: Some("https://blossom.primal.net".to_string()),
                },
            ],
        };
        let tags = result_summary_tags(
            "q_summary_test",
            "npub1worker",
            "npub1coordinator",
            Some(&pack),
        );
        assert!(tags.contains(&vec!["q".to_string(), "q_summary_test".to_string(),]));
        assert!(tags.contains(&vec![
            "questionnaire-id".to_string(),
            "q_summary_test".to_string(),
        ]));
        assert!(tags.contains(&vec![
            "result-pack".to_string(),
            "a".repeat(64),
            "https://blossom.nostr.build/blob".to_string(),
        ]));
        assert!(tags.contains(&vec![
            "result-pack-mirror".to_string(),
            "https://blossom.primal.net/blob".to_string(),
        ]));
    }

    #[test]
    fn submission_decision_tags_include_q_index() {
        let decision = QuestionnaireSubmissionDecisionEvent {
            schema_version: 1,
            event_type: "questionnaire_submission_decision".to_string(),
            questionnaire_id: "q_decision_test".to_string(),
            submission_id: "submission_1".to_string(),
            token_nullifier: "nullifier_1".to_string(),
            accepted: true,
            reason: "accepted".to_string(),
            decided_at: 1_700_000_000,
            coordinator_pubkey: "npub1coordinator".to_string(),
            delegation_id: None,
            worker_pubkey: Some("npub1worker".to_string()),
        };
        let tags = submission_decision_tags(&decision, "npub1worker");
        assert!(tags.contains(&vec!["q".to_string(), "q_decision_test".to_string()]));
        assert!(tags.contains(&vec![
            "questionnaire".to_string(),
            "q_decision_test".to_string(),
        ]));
    }

    #[tokio::test]
    async fn effective_private_relays_do_not_inherit_delegated_control_relays() {
        let coordinator_keys = Keys::generate();
        let mut state = WorkerPersistentState::default();
        state.elections.insert(
            "q_worker_definition".to_string(),
            ElectionRuntimeState {
                election_id: "q_worker_definition".to_string(),
                expires_at: (Utc::now() + ChronoDuration::days(1)).to_rfc3339(),
                control_relays: vec![
                    "wss://relay.nostr.info".to_string(),
                    "wss://relay.nostr.net".to_string(),
                    "wss://nos.lol".to_string(),
                ],
                ..ElectionRuntimeState::default()
            },
        );
        let (runtime, state_dir) = test_runtime_with_state(&coordinator_keys, state);

        let relays = runtime
            .effective_worker_private_relays()
            .await
            .into_iter()
            .map(|relay| normalize_relay_key(&relay.to_string()))
            .collect::<Vec<_>>();

        assert!(!relays.contains(&"wss://relay.nostr.info".to_string()));
        assert!(relays.contains(&"wss://relay.example.com".to_string()));
        assert!(!relays.contains(&"wss://relay.nostr.net".to_string()));
        assert!(!relays.contains(&"wss://nos.lol".to_string()));

        fs::remove_dir_all(state_dir).ok();
    }

    #[tokio::test]
    async fn malformed_blind_request_control_messages_are_not_marked_handled() {
        let coordinator_keys = Keys::generate();
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());

        let single_handled = runtime
            .process_control_message(
                r#"{"type":"optiona_blind_request_dm","schemaVersion":1,"request":{"type":"blind_ballot_request"}}"#,
                "npub1voter",
            )
            .await
            .expect("process malformed single blind request");
        assert!(matches!(
            single_handled,
            ControlMessageAction::Processed(false)
        ));

        let bundle_handled = runtime
            .process_control_message(
                r#"{"type":"optiona_blind_request_bundle_dm","schemaVersion":1,"requests":[{"type":"blind_ballot_request"}]}"#,
                "npub1voter",
            )
            .await
            .expect("process malformed blind request bundle");
        assert!(matches!(
            bundle_handled,
            ControlMessageAction::Processed(false)
        ));

        fs::remove_dir_all(state_dir).ok();
    }

    #[tokio::test]
    async fn control_messages_enforce_authenticated_senders() {
        let coordinator_keys = Keys::generate();
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());
        let request = sample_request();
        let content = serde_json::to_string(&BlindBallotRequestEnvelope {
            message_type: "optiona_blind_request_dm".to_string(),
            schema_version: 1,
            request: request.clone(),
            sent_at: "2026-07-15T12:00:00Z".to_string(),
        })
        .expect("serialize request envelope");

        assert!(matches!(
            runtime
                .process_control_message(&content, "npub1different")
                .await
                .expect("reject mismatched sender"),
            ControlMessageAction::Processed(true)
        ));
        assert!(matches!(
            runtime
                .process_control_message(&content, &request.invited_npub)
                .await
                .expect("accept voter sender"),
            ControlMessageAction::BlindRequests(requests) if requests.len() == 1
        ));

        let delegation = WorkerDelegationEnvelope {
            message_type: "optiona_worker_delegation_dm".to_string(),
            schema_version: 1,
            delegation: WorkerDelegationCertificate {
                message_type: "worker_delegation".to_string(),
                schema_version: 1,
                delegation_id: "delegation_untrusted".to_string(),
                election_id: "election_untrusted".to_string(),
                coordinator_npub: runtime.config.coordinator_npub.clone(),
                worker_npub: runtime.worker_npub.clone(),
                capabilities: vec![WorkerCapability::IssueBlindTokens],
                control_relays: Vec::new(),
                issued_at: now_iso(),
                expires_at: (Utc::now() + ChronoDuration::days(1)).to_rfc3339(),
            },
            sent_at: now_iso(),
        };
        runtime
            .process_control_message(
                &serde_json::to_string(&delegation).expect("serialize delegation"),
                &request.invited_npub,
            )
            .await
            .expect("ignore untrusted delegation");
        assert!(!runtime
            .state
            .lock()
            .await
            .elections
            .contains_key("election_untrusted"));

        fs::remove_dir_all(state_dir).ok();
    }

    #[test]
    fn blind_issuance_ack_requires_sender_and_exact_persisted_issuance() {
        let request = sample_request();
        let issuance = BlindBallotIssuance {
            message_type: "blind_ballot_response".to_string(),
            schema_version: 1,
            election_id: request.election_id.clone(),
            request_id: request.request_id.clone(),
            issuance_id: "issuance_exact".to_string(),
            invited_npub: request.invited_npub.clone(),
            blind_signing_key_id: request.blind_signing_key_id.clone(),
            blind_signature: "signature".to_string(),
            definition_hash: None,
            definition_event_id: None,
            ballot_scope: request.ballot_scope.clone(),
            definition: None,
            issued_at: now_iso(),
        };
        let mut election = ElectionRuntimeState::default();
        election
            .issued_issuances_by_request_id
            .insert(request.request_id.clone(), issuance.clone());
        let mut ack = BlindIssuanceAck {
            message_type: "blind_ballot_issuance_ack".to_string(),
            schema_version: 1,
            election_id: issuance.election_id.clone(),
            request_id: issuance.request_id.clone(),
            issuance_id: issuance.issuance_id.clone(),
            invited_npub: issuance.invited_npub.clone(),
            acked_at: now_iso(),
        };

        assert!(blind_issuance_ack_matches(
            &ack.invited_npub,
            &ack,
            Some(&election)
        ));
        assert!(!blind_issuance_ack_matches(
            "npub1different",
            &ack,
            Some(&election)
        ));
        ack.issuance_id = "issuance_wrong".to_string();
        assert!(!blind_issuance_ack_matches(
            &ack.invited_npub,
            &ack,
            Some(&election)
        ));
    }

    #[test]
    fn ballot_requested_status_contains_request_identity() {
        let request = sample_request();
        let envelope = build_participant_status_envelope(
            &request.election_id,
            &request.invited_npub,
            OptionAParticipantStatusState::BallotRequested,
            Some(&request.request_id),
            None,
        );
        let value = serde_json::to_value(envelope).expect("serialize participant status");

        assert_eq!(value["type"], "optiona_participant_status_dm");
        assert_eq!(value["status"]["type"], "participant_status");
        assert_eq!(value["status"]["source"], "issuer_proxy");
        assert_eq!(value["status"]["state"], "ballot_requested");
        assert_eq!(value["status"]["electionId"], request.election_id);
        assert_eq!(value["status"]["invitedNpub"], request.invited_npub);
        assert_eq!(value["status"]["requestId"], request.request_id);
        assert!(value["status"].get("issuanceId").is_none());
        assert!(value["status"].get("submissionId").is_none());
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
    fn worker_relay_retry_delay_treats_not_ready_as_immediate_backoff() {
        assert!(is_immediate_worker_relay_backoff_error(Some(
            "relay is initialized but not ready"
        )));
        assert_eq!(
            worker_relay_retry_delay(1, Some("relay is initialized but not ready")),
            Duration::from_secs(120)
        );
    }

    #[tokio::test]
    async fn ensure_relays_connected_attempts_new_relay_connection() {
        let coordinator_keys = Keys::generate();
        let (runtime, state_dir) =
            test_runtime_with_state(&coordinator_keys, WorkerPersistentState::default());
        let relay = RelayUrl::parse("ws://127.0.0.1:9").expect("relay URL");

        runtime
            .ensure_relays_connected(std::slice::from_ref(&relay))
            .await;

        let status = runtime
            .client
            .relay(relay)
            .await
            .expect("added relay")
            .status();
        assert_ne!(status, RelayStatus::Initialized);
        fs::remove_dir_all(state_dir).ok();
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

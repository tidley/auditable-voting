use bech32::{self};
use chrono::DateTime;
use js_sys::{Array, Reflect};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

const TOKEN_FINGERPRINT_PALETTE_LEN: usize = 6;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenPatternCell {
    filled: bool,
    color_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TicketRowInput {
    voting_id: String,
    prompt: String,
    created_at: String,
    threshold_t: Option<u32>,
    threshold_n: Option<u32>,
    coordinator_npub: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimpleVoteTicketRow {
    voting_id: String,
    prompt: String,
    created_at: String,
    threshold_t: Option<u32>,
    threshold_n: Option<u32>,
    counts_by_coordinator: std::collections::BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryState {
    status: Option<String>,
    event_id: Option<String>,
    attempts: Option<u32>,
    last_attempt_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AckSummary {
    actor_npub: String,
    acked_action: String,
    acked_event_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingBlindRequestSummary {
    key: String,
    request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredRoundSource {
    coordinator_npub: String,
    voting_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoterCoordinatorDiagnosticsInput {
    configured_coordinator_targets: Vec<String>,
    active_voting_id: Option<String>,
    discovered_round_sources: Vec<DiscoveredRoundSource>,
    known_blind_key_ids: Vec<String>,
    follow_deliveries: std::collections::BTreeMap<String, DeliveryState>,
    request_deliveries: std::collections::BTreeMap<String, DeliveryState>,
    acknowledgements: Vec<AckSummary>,
    ticket_received_coordinator_npubs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryDiagnostic {
    tone: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoterCoordinatorDiagnostic {
    coordinator_npub: String,
    coordinator_index: usize,
    follow: DeliveryDiagnostic,
    round: DeliveryDiagnostic,
    blind_key: DeliveryDiagnostic,
    request: DeliveryDiagnostic,
    ticket: DeliveryDiagnostic,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FollowRetrySelectionInput {
    configured_coordinator_targets: Vec<String>,
    follow_deliveries: std::collections::BTreeMap<String, DeliveryState>,
    acknowledgements: Vec<AckSummary>,
    now_ms: i64,
    min_retry_age_ms: i64,
    max_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RequestRetrySelectionInput {
    pending_requests: Vec<PendingBlindRequestSummary>,
    request_deliveries: std::collections::BTreeMap<String, DeliveryState>,
    acknowledgements: Vec<AckSummary>,
    received_request_ids: Vec<String>,
    now_ms: i64,
    min_retry_age_ms: i64,
    max_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimpleCoordinatorFollowerSummary {
    id: String,
    voter_npub: String,
    voter_id: String,
    voting_id: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimpleRoundRequestSummary {
    voter_npub: String,
    voting_id: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorFollowerRowsInput {
    followers: Vec<SimpleCoordinatorFollowerSummary>,
    selected_published_voting_id: Option<String>,
    pending_requests: Vec<SimpleRoundRequestSummary>,
    ticket_deliveries: std::collections::BTreeMap<String, DeliveryState>,
    acknowledgements: Vec<AckSummary>,
    can_issue_tickets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorFollowerRow {
    id: String,
    voter_npub: String,
    voter_id: String,
    following_text: String,
    can_send_ticket: bool,
    send_label: String,
    follow: DeliveryDiagnostic,
    pending_request: DeliveryDiagnostic,
    ticket: DeliveryDiagnostic,
    receipt: Option<DeliveryDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TicketRetrySelectionInput {
    followers: Vec<SimpleCoordinatorFollowerSummary>,
    selected_published_voting_id: Option<String>,
    ticket_deliveries: std::collections::BTreeMap<String, DeliveryState>,
    acknowledgements: Vec<AckSummary>,
    now_ms: i64,
    min_retry_age_ms: i64,
    max_attempts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActorRelaySetInput {
    preferred_relays: Vec<String>,
    fallback_relays: Vec<String>,
    extra_relays: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRelaySetInput {
    recipient_inbox_relays: Vec<String>,
    sender_outbox_relays: Vec<String>,
    fallback_relays: Vec<String>,
}

fn js_error(message: impl ToString) -> JsValue {
    JsValue::from_str(&message.to_string())
}

fn serialize<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(|error| js_error(error.to_string()))
}

fn get_string_property(value: &JsValue, key: &str) -> Result<String, JsValue> {
    Reflect::get(value, &JsValue::from_str(key))
        .map_err(|_| js_error(format!("Missing property: {key}")))?
        .as_string()
        .ok_or_else(|| js_error(format!("Property {key} must be a string")))
}

fn hex_sha256(input: &[u8]) -> String {
    let digest = Sha256::digest(input);
    let mut output = String::with_capacity(digest.len() * 2);

    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }

    output
}

fn is_allowed_npub_char(character: char) -> bool {
    matches!(
        character,
        '0'
            | '2'
            | '3'
            | '4'
            | '5'
            | '6'
            | '7'
            | '8'
            | '9'
            | 'a'
            | 'c'
            | 'd'
            | 'e'
            | 'f'
            | 'g'
            | 'h'
            | 'j'
            | 'k'
            | 'l'
            | 'm'
            | 'n'
            | 'p'
            | 'q'
            | 'r'
            | 's'
            | 't'
            | 'u'
            | 'v'
            | 'w'
            | 'x'
            | 'y'
            | 'z'
    )
}

fn decode_npub(candidate: &str) -> bool {
    match bech32::decode(candidate) {
        Ok((hrp, _)) => hrp.as_str() == "npub",
        Err(_) => false,
    }
}

fn collect_npub_candidates(input: &str) -> Vec<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let mut candidates = Vec::new();

    let push_unique = |candidates: &mut Vec<String>, candidate: String| {
        if !candidate.is_empty() && !candidates.iter().any(|existing| existing == &candidate) {
            candidates.push(candidate);
        }
    };

    push_unique(&mut candidates, trimmed.to_string());

    if let Some(stripped) = trimmed.strip_prefix("nostr:").or_else(|| trimmed.strip_prefix("NOSTR:")) {
        push_unique(&mut candidates, stripped.trim().to_string());
    }

    let lowercase = trimmed.to_ascii_lowercase();
    let chars: Vec<(usize, char)> = lowercase.char_indices().collect();

    for index in 0..chars.len() {
        let byte_index = chars[index].0;
        if !lowercase[byte_index..].starts_with("npub1") {
            continue;
        }

        let mut end_byte = byte_index + 5;
        let mut cursor = index + 5;

        while cursor < chars.len() && is_allowed_npub_char(chars[cursor].1) {
            end_byte = chars[cursor].0 + chars[cursor].1.len_utf8();
            cursor += 1;
        }

        if end_byte > byte_index + 5 {
            push_unique(&mut candidates, lowercase[byte_index..end_byte].to_string());
        }
    }

    candidates
}

fn parse_hex_nibble(character: char) -> Option<u32> {
    character.to_digit(16)
}

fn compare_created_at_desc(left: &str, right: &str) -> Ordering {
    right.cmp(left)
}

fn normalize_trimmed_unique(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut normalized = Vec::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }

        if seen.insert(trimmed.to_string()) {
            normalized.push(trimmed.to_string());
        }
    }

    normalized
}

fn merge_relay_groups(groups: Vec<Vec<String>>) -> Vec<String> {
    normalize_trimmed_unique(groups.into_iter().flatten().collect())
}

fn diagnostic(tone: &str, text: impl Into<String>) -> DeliveryDiagnostic {
    DeliveryDiagnostic {
        tone: tone.to_string(),
        text: text.into(),
    }
}

fn status_is_failure(status: Option<&str>) -> bool {
    status
        .map(|value| value.to_ascii_lowercase().contains("failed"))
        .unwrap_or(false)
}

fn ack_exists(
    acknowledgements: &[AckSummary],
    action: &str,
    event_id: &str,
    actor_npub: Option<&str>,
) -> bool {
    acknowledgements.iter().any(|ack| {
        ack.acked_action == action
            && ack.acked_event_id == event_id
            && actor_npub.map(|value| ack.actor_npub == value).unwrap_or(true)
    })
}

fn parse_rfc3339_millis(value: Option<&str>) -> Option<i64> {
    let value = value?.trim();
    if value.is_empty() {
        return None;
    }

    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis())
}

fn latest_round_request_exists(
    requests: &[SimpleRoundRequestSummary],
    voter_npub: &str,
    voting_id: &str,
) -> bool {
    requests
        .iter()
        .any(|request| request.voter_npub == voter_npub && request.voting_id == voting_id)
}

fn build_voter_coordinator_diagnostics_inner(
    input: VoterCoordinatorDiagnosticsInput,
) -> Vec<VoterCoordinatorDiagnostic> {
    let active_voting_id = input.active_voting_id.unwrap_or_default();
    let ticket_received_set = input
        .ticket_received_coordinator_npubs
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let known_blind_key_ids = input
        .known_blind_key_ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();

    normalize_trimmed_unique(input.configured_coordinator_targets)
        .into_iter()
        .enumerate()
        .map(|(index, coordinator_npub)| {
            let follow_delivery = input.follow_deliveries.get(&coordinator_npub);
            let follow_ack = follow_delivery
                .and_then(|delivery| delivery.event_id.as_deref())
                .map(|event_id| {
                    ack_exists(
                        &input.acknowledgements,
                        "simple_coordinator_follow",
                        event_id,
                        Some(&coordinator_npub),
                    )
                })
                .unwrap_or(false);

            let round_seen = !active_voting_id.is_empty()
                && input.discovered_round_sources.iter().any(|session| {
                    session.coordinator_npub == coordinator_npub
                        && session.voting_id == active_voting_id
                });

            let blind_key_seen = !active_voting_id.is_empty()
                && known_blind_key_ids.contains(&format!("{coordinator_npub}:{active_voting_id}"));

            let request_delivery_key = if active_voting_id.is_empty() {
                String::new()
            } else {
                format!("{coordinator_npub}:{active_voting_id}")
            };
            let request_delivery = input.request_deliveries.get(&request_delivery_key);
            let request_ack = request_delivery
                .and_then(|delivery| delivery.event_id.as_deref())
                .map(|event_id| {
                    ack_exists(
                        &input.acknowledgements,
                        "simple_shard_request",
                        event_id,
                        Some(&coordinator_npub),
                    )
                })
                .unwrap_or(false);
            let ticket_received = ticket_received_set.contains(&coordinator_npub);

            VoterCoordinatorDiagnostic {
                coordinator_npub: coordinator_npub.clone(),
                coordinator_index: index + 1,
                follow: if follow_ack {
                    diagnostic("ok", "Follow request acknowledged.")
                } else if status_is_failure(follow_delivery.and_then(|delivery| delivery.status.as_deref())) {
                    diagnostic(
                        "error",
                        follow_delivery
                            .and_then(|delivery| delivery.status.clone())
                            .unwrap_or_else(|| "Follow request failed.".to_string()),
                    )
                } else {
                    diagnostic(
                        "waiting",
                        follow_delivery
                            .and_then(|delivery| delivery.status.clone())
                            .unwrap_or_else(|| "Follow request not sent yet.".to_string()),
                    )
                },
                round: if round_seen {
                    diagnostic("ok", "Live round seen.")
                } else {
                    diagnostic("waiting", "Waiting for live round.")
                },
                blind_key: if blind_key_seen {
                    diagnostic("ok", "Blind key seen.")
                } else {
                    diagnostic(
                        "waiting",
                        format!(
                            "Waiting for Coordinator {}'s key before preparing ticket request.",
                            index + 1
                        ),
                    )
                },
                request: if ticket_received || request_ack {
                    diagnostic("ok", "Blinded ticket request acknowledged.")
                } else if status_is_failure(request_delivery.and_then(|delivery| delivery.status.as_deref())) {
                    diagnostic(
                        "error",
                        request_delivery
                            .and_then(|delivery| delivery.status.clone())
                            .unwrap_or_else(|| "Blinded ticket request failed.".to_string()),
                    )
                } else {
                    diagnostic(
                        "waiting",
                        request_delivery
                            .and_then(|delivery| delivery.status.clone())
                            .unwrap_or_else(|| "Waiting to send blinded ticket request.".to_string()),
                    )
                },
                ticket: if ticket_received {
                    diagnostic("ok", "Ticket received.")
                } else {
                    diagnostic("waiting", "Waiting for ticket.")
                },
            }
        })
        .collect::<Vec<_>>()
}

fn select_follow_retry_targets_inner(input: FollowRetrySelectionInput) -> Vec<String> {
    let mut retry_targets = Vec::new();

    for coordinator_npub in normalize_trimmed_unique(input.configured_coordinator_targets) {
        let Some(delivery) = input.follow_deliveries.get(&coordinator_npub) else {
            continue;
        };
        let Some(event_id) = delivery.event_id.as_deref() else {
            continue;
        };
        if ack_exists(
            &input.acknowledgements,
            "simple_coordinator_follow",
            event_id,
            None,
        ) {
            continue;
        }
        if delivery.attempts.unwrap_or(0) >= input.max_attempts {
            continue;
        }
        let Some(last_attempt_ms) = parse_rfc3339_millis(delivery.last_attempt_at.as_deref()) else {
            continue;
        };
        if input.now_ms - last_attempt_ms >= input.min_retry_age_ms {
            retry_targets.push(coordinator_npub);
        }
    }

    retry_targets
}

fn select_request_retry_keys_inner(input: RequestRetrySelectionInput) -> Vec<String> {
    let received_request_ids = input
        .received_request_ids
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();

    let mut retry_keys = Vec::new();

    for request in input.pending_requests {
        let Some(delivery) = input.request_deliveries.get(&request.key) else {
            continue;
        };
        let Some(event_id) = delivery.event_id.as_deref() else {
            continue;
        };
        if ack_exists(
            &input.acknowledgements,
            "simple_shard_request",
            event_id,
            None,
        ) || received_request_ids.contains(&request.request_id)
        {
            continue;
        }
        if delivery.attempts.unwrap_or(0) >= input.max_attempts {
            continue;
        }
        let Some(last_attempt_ms) = parse_rfc3339_millis(delivery.last_attempt_at.as_deref()) else {
            continue;
        };
        if input.now_ms - last_attempt_ms >= input.min_retry_age_ms {
            retry_keys.push(request.key);
        }
    }

    retry_keys
}

fn merge_simple_followers_inner(
    current: Vec<SimpleCoordinatorFollowerSummary>,
    next: Vec<SimpleCoordinatorFollowerSummary>,
) -> Vec<SimpleCoordinatorFollowerSummary> {
    if next.is_empty() {
        return current;
    }

    let mut merged = std::collections::BTreeMap::new();
    for follower in current {
        merged.insert(follower.voter_npub.clone(), follower);
    }
    for follower in next {
        merged.insert(follower.voter_npub.clone(), follower);
    }

    let mut merged = merged.into_values().collect::<Vec<_>>();
    merged.sort_by(|left, right| compare_created_at_desc(&left.created_at, &right.created_at));
    merged
}

fn build_coordinator_follower_rows_inner(
    input: CoordinatorFollowerRowsInput,
) -> Vec<CoordinatorFollowerRow> {
    let selected_voting_id = input.selected_published_voting_id.unwrap_or_default();

    let mut visible_followers = if selected_voting_id.is_empty() {
        input.followers
    } else {
        input
            .followers
            .into_iter()
            .filter(|follower| {
                follower
                    .voting_id
                    .as_deref()
                    .map(|value| value == selected_voting_id)
                    .unwrap_or(true)
            })
            .collect::<Vec<_>>()
    };
    visible_followers.sort_by(|left, right| compare_created_at_desc(&left.created_at, &right.created_at));

    visible_followers
        .into_iter()
        .map(|follower| {
            let ticket_status_key = if selected_voting_id.is_empty() {
                String::new()
            } else {
                format!("{}:{}", follower.voter_npub, selected_voting_id)
            };
            let ticket_delivery = input.ticket_deliveries.get(&ticket_status_key);
            let ticket_was_sent = ticket_delivery
                .and_then(|delivery| delivery.status.as_deref())
                .map(|status| status == "Ticket sent.")
                .unwrap_or(false);
            let has_pending_request = if selected_voting_id.is_empty() {
                false
            } else {
                latest_round_request_exists(
                    &input.pending_requests,
                    &follower.voter_npub,
                    &selected_voting_id,
                )
            };
            let ticket_receipt_ack = ticket_delivery
                .and_then(|delivery| delivery.event_id.as_deref())
                .map(|event_id| {
                    ack_exists(
                        &input.acknowledgements,
                        "simple_round_ticket",
                        event_id,
                        None,
                    )
                })
                .unwrap_or(false);

            CoordinatorFollowerRow {
                id: follower.id.clone(),
                voter_npub: follower.voter_npub.clone(),
                voter_id: follower.voter_id.clone(),
                following_text: match follower.voting_id.as_deref() {
                    Some(voting_id) if !voting_id.is_empty() => format!(
                        "Voter {} is following this coordinator for {}",
                        follower.voter_id,
                        &voting_id[..12.min(voting_id.len())]
                    ),
                    _ => format!(
                        "Voter {} is following this coordinator and is waiting for the next live vote",
                        follower.voter_id
                    ),
                },
                can_send_ticket: !selected_voting_id.is_empty()
                    && input.can_issue_tickets
                    && has_pending_request,
                send_label: if ticket_was_sent {
                    "Resend".to_string()
                } else {
                    "Send ticket".to_string()
                },
                follow: diagnostic("ok", "Follow request received."),
                pending_request: if has_pending_request {
                    diagnostic("ok", "Blinded ticket request received.")
                } else {
                    diagnostic("waiting", "Waiting for this voter's blinded ticket request.")
                },
                ticket: if selected_voting_id.is_empty() {
                    diagnostic("waiting", "Waiting for a live round.")
                } else if status_is_failure(ticket_delivery.and_then(|delivery| delivery.status.as_deref())) {
                    diagnostic(
                        "error",
                        ticket_delivery
                            .and_then(|delivery| delivery.status.clone())
                            .unwrap_or_else(|| "Ticket send failed.".to_string()),
                    )
                } else if let Some(status) = ticket_delivery.and_then(|delivery| delivery.status.clone()) {
                    diagnostic("ok", status)
                } else {
                    diagnostic("waiting", "Ticket not sent yet.")
                },
                receipt: if !selected_voting_id.is_empty() && ticket_was_sent {
                    Some(if ticket_receipt_ack {
                        diagnostic("ok", "Voter acknowledged ticket receipt.")
                    } else {
                        diagnostic("waiting", "Waiting for voter ticket receipt acknowledgement.")
                    })
                } else {
                    None
                },
            }
        })
        .collect::<Vec<_>>()
}

fn select_ticket_retry_targets_inner(input: TicketRetrySelectionInput) -> Vec<String> {
    let selected_voting_id = input.selected_published_voting_id.unwrap_or_default();
    if selected_voting_id.is_empty() {
        return Vec::new();
    }

    let mut retry_targets = Vec::new();
    for follower in input.followers {
        if follower
            .voting_id
            .as_deref()
            .map(|value| value != selected_voting_id)
            .unwrap_or(false)
        {
            continue;
        }
        let ticket_status_key = format!("{}:{}", follower.voter_npub, selected_voting_id);
        let Some(delivery) = input.ticket_deliveries.get(&ticket_status_key) else {
            continue;
        };
        let Some(event_id) = delivery.event_id.as_deref() else {
            continue;
        };
        if delivery.attempts.unwrap_or(0) >= input.max_attempts {
            continue;
        }
        if ack_exists(
            &input.acknowledgements,
            "simple_round_ticket",
            event_id,
            None,
        ) {
            continue;
        }
        let Some(last_attempt_ms) = parse_rfc3339_millis(delivery.last_attempt_at.as_deref()) else {
            continue;
        };
        if input.now_ms - last_attempt_ms >= input.min_retry_age_ms {
            retry_targets.push(follower.id);
        }
    }

    retry_targets
}

fn derive_token_id_from_proof_secrets_inner(
    proof_secrets: Vec<String>,
    length: usize,
) -> Option<String> {
    let mut normalized = proof_secrets
        .into_iter()
        .map(|secret| secret.trim().to_string())
        .filter(|secret| !secret.is_empty())
        .collect::<Vec<_>>();

    normalized.sort();

    if normalized.is_empty() {
        return None;
    }

    let proof_hashes = normalized
        .iter()
        .map(|secret| hex_sha256(secret.as_bytes()))
        .collect::<Vec<_>>();
    let token_id = hex_sha256(proof_hashes.join(":").as_bytes());
    Some(token_id[..length.min(token_id.len())].to_string())
}

fn token_pattern_detail_inner(token_id: &str, size: usize) -> Vec<TokenPatternCell> {
    let normalized = token_id
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_hexdigit())
        .collect::<String>();

    if normalized.is_empty() {
        return vec![
            TokenPatternCell {
                filled: false,
                color_index: 0,
            };
            size * size
        ];
    }

    let mut seed: u32 = 0x811c9dc5;

    for character in normalized.chars() {
        seed ^= character as u32;
        seed = seed.wrapping_mul(0x0100_0193);
        seed ^= parse_hex_nibble(character).unwrap_or(0);
        seed = seed.wrapping_mul(0x85eb_ca6b);
    }

    let mut next_byte = |offset: u32| -> u8 {
        seed = seed.wrapping_add(0x6d2b79f5).wrapping_add(offset);
        let mut value = seed;
        value = (value ^ (value >> 15)).wrapping_mul(value | 1);
        value ^= value.wrapping_add((value ^ (value >> 7)).wrapping_mul(value | 61));
        ((value ^ (value >> 14)) & 0xff) as u8
    };

    (0..size * size)
        .map(|index| {
            let byte = next_byte((index * 2) as u32);
            let accent = next_byte((index * 2 + 1) as u32);

            TokenPatternCell {
                filled: (byte % 2) == 0,
                color_index: (accent as usize) % TOKEN_FINGERPRINT_PALETTE_LEN,
            }
        })
        .collect::<Vec<_>>()
}

#[wasm_bindgen]
pub fn derive_actor_display_id(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return "pending".to_string();
    }

    let mut hash: u32 = 0x811c9dc5;
    for character in normalized.chars() {
        hash ^= character as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }

    let hex = format!("{hash:08x}");
    hex[..7].to_string()
}

#[wasm_bindgen]
pub fn normalize_coordinator_npubs(values: JsValue) -> Result<JsValue, JsValue> {
    let values = serde_wasm_bindgen::from_value::<Vec<String>>(values)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&normalize_trimmed_unique(values))
}

#[wasm_bindgen]
pub fn normalize_relays(values: JsValue) -> Result<JsValue, JsValue> {
    let values = serde_wasm_bindgen::from_value::<Vec<String>>(values)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&normalize_trimmed_unique(values))
}

#[wasm_bindgen]
pub fn build_actor_relay_set(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<ActorRelaySetInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&merge_relay_groups(vec![
        input.preferred_relays,
        input.fallback_relays,
        input.extra_relays,
    ]))
}

#[wasm_bindgen]
pub fn build_conversation_relay_set(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<ConversationRelaySetInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&merge_relay_groups(vec![
        input.recipient_inbox_relays,
        input.sender_outbox_relays,
        input.fallback_relays,
    ]))
}

#[wasm_bindgen]
pub fn extract_npub_from_scan(value: &str) -> Option<String> {
    for candidate in collect_npub_candidates(value) {
        let normalized = candidate.trim().to_ascii_lowercase();
        if decode_npub(&normalized) {
            return Some(normalized);
        }
    }

    None
}

#[wasm_bindgen]
pub fn sha256_hex(input: &str) -> String {
    hex_sha256(input.as_bytes())
}

#[wasm_bindgen]
pub fn derive_token_id_from_proof_secrets(
    proof_secrets: JsValue,
    length: usize,
) -> Result<Option<String>, JsValue> {
    let proof_secrets = serde_wasm_bindgen::from_value::<Vec<String>>(proof_secrets)
        .map_err(|error| js_error(error.to_string()))?;
    Ok(derive_token_id_from_proof_secrets_inner(proof_secrets, length))
}

#[wasm_bindgen]
pub fn token_id_label(token_id: Option<String>) -> String {
    match token_id {
        Some(token_id) if !token_id.is_empty() => {
            if token_id.len() <= 14 {
                token_id
            } else {
                format!("{}...{}", &token_id[..8], &token_id[token_id.len() - 6..])
            }
        }
        _ => "Unavailable".to_string(),
    }
}

#[wasm_bindgen]
pub fn token_pattern_detail(token_id: &str, size: usize) -> Result<JsValue, JsValue> {
    serialize(&token_pattern_detail_inner(token_id, size))
}

#[wasm_bindgen]
pub fn token_pattern_cells(token_id: &str, size: usize) -> Result<JsValue, JsValue> {
    let cells = token_pattern_detail_inner(token_id, size);
    let filled = cells.into_iter().map(|cell| cell.filled).collect::<Vec<_>>();
    serialize(&filled)
}

#[wasm_bindgen]
pub fn token_qr_payload(token_id: &str) -> String {
    format!("auditable-voting:token:{token_id}")
}

#[wasm_bindgen]
pub fn sort_simple_votes_canonical(votes: JsValue) -> Result<JsValue, JsValue> {
    let array = Array::from(&votes);
    let mut entries = array
        .iter()
        .map(|value| {
            Ok::<_, JsValue>((
                get_string_property(&value, "createdAt")?,
                get_string_property(&value, "eventId")?,
                value,
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;

    entries.sort_by(|left, right| {
        let created_at_order = left.0.cmp(&right.0);
        if created_at_order == Ordering::Equal {
            left.1.cmp(&right.1)
        } else {
            created_at_order
        }
    });

    let sorted = entries
        .into_iter()
        .fold(Array::new(), |array, (_, _, value)| {
            array.push(&value);
            array
        });
    Ok(sorted.into())
}

#[wasm_bindgen]
pub fn sort_records_by_created_at_desc(values: JsValue) -> Result<JsValue, JsValue> {
    let array = Array::from(&values);
    let mut entries = array
        .iter()
        .map(|value| {
            Ok::<_, JsValue>((get_string_property(&value, "createdAt")?, value))
        })
        .collect::<Result<Vec<_>, _>>()?;

    entries.sort_by(|left, right| compare_created_at_desc(&left.0, &right.0));

    let sorted = entries.into_iter().fold(Array::new(), |array, (_, value)| {
        array.push(&value);
        array
    });
    Ok(sorted.into())
}

#[wasm_bindgen]
pub fn build_simple_vote_ticket_rows(
    entries: JsValue,
    configured_coordinator_targets: JsValue,
) -> Result<JsValue, JsValue> {
    let entries = serde_wasm_bindgen::from_value::<Vec<TicketRowInput>>(entries)
        .map_err(|error| js_error(error.to_string()))?;
    let configured_targets = serde_wasm_bindgen::from_value::<Vec<String>>(configured_coordinator_targets)
        .map_err(|error| js_error(error.to_string()))?;
    let configured_set = configured_targets
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();

    let mut rows = std::collections::BTreeMap::<String, SimpleVoteTicketRow>::new();

    for entry in entries {
        if !configured_set.contains(&entry.coordinator_npub) || entry.prompt.trim().is_empty() {
            continue;
        }

        let current = rows.entry(entry.voting_id.clone()).or_insert_with(|| SimpleVoteTicketRow {
            voting_id: entry.voting_id.clone(),
            prompt: entry.prompt.clone(),
            created_at: entry.created_at.clone(),
            threshold_t: entry.threshold_t,
            threshold_n: entry.threshold_n,
            counts_by_coordinator: std::collections::BTreeMap::new(),
        });

        if entry.created_at > current.created_at {
            current.created_at = entry.created_at.clone();
            current.prompt = entry.prompt.clone();
            current.threshold_t = entry.threshold_t;
            current.threshold_n = entry.threshold_n;
        }

        *current
            .counts_by_coordinator
            .entry(entry.coordinator_npub.clone())
            .or_insert(0) += 1;
    }

    let mut rows = rows.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| compare_created_at_desc(&left.created_at, &right.created_at));
    serialize(&rows)
}

#[wasm_bindgen]
pub fn build_voter_coordinator_diagnostics(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<VoterCoordinatorDiagnosticsInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&build_voter_coordinator_diagnostics_inner(input))
}

#[wasm_bindgen]
pub fn select_follow_retry_targets(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<FollowRetrySelectionInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&select_follow_retry_targets_inner(input))
}

#[wasm_bindgen]
pub fn select_request_retry_keys(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<RequestRetrySelectionInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&select_request_retry_keys_inner(input))
}

#[wasm_bindgen]
pub fn merge_simple_followers(current: JsValue, next: JsValue) -> Result<JsValue, JsValue> {
    let current = serde_wasm_bindgen::from_value::<Vec<SimpleCoordinatorFollowerSummary>>(current)
        .map_err(|error| js_error(error.to_string()))?;
    let next = serde_wasm_bindgen::from_value::<Vec<SimpleCoordinatorFollowerSummary>>(next)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&merge_simple_followers_inner(current, next))
}

#[wasm_bindgen]
pub fn build_coordinator_follower_rows(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<CoordinatorFollowerRowsInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&build_coordinator_follower_rows_inner(input))
}

#[wasm_bindgen]
pub fn select_ticket_retry_targets(input: JsValue) -> Result<JsValue, JsValue> {
    let input = serde_wasm_bindgen::from_value::<TicketRetrySelectionInput>(input)
        .map_err(|error| js_error(error.to_string()))?;
    serialize(&select_ticket_retry_targets_inner(input))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_actor_display_ids() {
        assert_eq!(derive_actor_display_id(" npub1example "), "8a132bd");
        assert_eq!(derive_actor_display_id(" "), "pending");
    }

    #[test]
    fn extracts_npub_from_plain_and_uri_forms() {
        let npub = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzqujme";
        assert_eq!(extract_npub_from_scan(npub), Some(npub.to_string()));
        assert_eq!(
            extract_npub_from_scan(&format!("nostr:{npub}")),
            Some(npub.to_string())
        );
    }

    #[test]
    fn produces_stable_token_pattern() {
        let cells = token_pattern_detail_inner("6ab4d7f1c925be102cd3", 5);

        assert_eq!(cells.len(), 25);
        assert_ne!(&cells[0..5], &cells[20..25]);
    }

    #[test]
    fn derives_token_ids_from_sorted_secrets() {
        let first = derive_token_id_from_proof_secrets_inner(
            vec!["secret-a".to_string(), "secret-b".to_string()],
            20,
        );
        let second = derive_token_id_from_proof_secrets_inner(
            vec!["secret-b".to_string(), "secret-a".to_string()],
            20,
        );

        assert_eq!(first, second);
        assert_eq!(first.expect("token").len(), 20);
    }

    #[test]
    fn normalizes_coordinator_npubs_preserving_order() {
        assert_eq!(
            normalize_trimmed_unique(vec![
                " npub-one ".to_string(),
                "".to_string(),
                "npub-two".to_string(),
                "npub-one".to_string(),
            ]),
            vec!["npub-one".to_string(), "npub-two".to_string()]
        );
    }

    #[test]
    fn selects_follow_retry_targets_by_age_and_ack() {
        let targets = select_follow_retry_targets_inner(FollowRetrySelectionInput {
            configured_coordinator_targets: vec!["npub-a".to_string(), "npub-b".to_string()],
            follow_deliveries: std::collections::BTreeMap::from([
                (
                    "npub-a".to_string(),
                    DeliveryState {
                        status: Some("Follow request sent.".to_string()),
                        event_id: Some("event-a".to_string()),
                        attempts: Some(1),
                        last_attempt_at: Some("2026-04-05T00:00:00.000Z".to_string()),
                    },
                ),
                (
                    "npub-b".to_string(),
                    DeliveryState {
                        status: Some("Follow request sent.".to_string()),
                        event_id: Some("event-b".to_string()),
                        attempts: Some(1),
                        last_attempt_at: Some("2026-04-05T00:00:09.000Z".to_string()),
                    },
                ),
            ]),
            acknowledgements: vec![AckSummary {
                actor_npub: "npub-b".to_string(),
                acked_action: "simple_coordinator_follow".to_string(),
                acked_event_id: "event-b".to_string(),
            }],
            now_ms: 1_775_347_212_000,
            min_retry_age_ms: 8_000,
            max_attempts: 3,
        });
        assert_eq!(targets, vec!["npub-a".to_string()]);
    }

    #[test]
    fn builds_coordinator_follower_rows() {
        let rows = build_coordinator_follower_rows_inner(CoordinatorFollowerRowsInput {
            followers: vec![SimpleCoordinatorFollowerSummary {
                id: "follower-1".to_string(),
                voter_npub: "npub-voter".to_string(),
                voter_id: "1234567".to_string(),
                voting_id: Some("vote-123456789abc".to_string()),
                created_at: "2026-04-05T00:00:00.000Z".to_string(),
            }],
            selected_published_voting_id: Some("vote-123456789abc".to_string()),
            pending_requests: vec![SimpleRoundRequestSummary {
                voter_npub: "npub-voter".to_string(),
                voting_id: "vote-123456789abc".to_string(),
                created_at: "2026-04-05T00:00:01.000Z".to_string(),
            }],
            ticket_deliveries: std::collections::BTreeMap::new(),
            acknowledgements: vec![],
            can_issue_tickets: true,
        });
        assert_eq!(rows.len(), 1);
        assert!(rows[0].can_send_ticket);
        assert_eq!(rows[0].pending_request.text, "Blinded ticket request received.");
    }
}

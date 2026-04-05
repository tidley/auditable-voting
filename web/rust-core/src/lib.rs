use bech32::{self};
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
}

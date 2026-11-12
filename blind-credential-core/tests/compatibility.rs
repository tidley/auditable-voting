use auditable_voting_blind_credentials::{decode_hex, encode_hex, sign, PublicKey};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/js-legacy.json")).unwrap()
}

#[test]
fn verifies_saved_javascript_credential_and_finalises_saved_inverse() {
    let f = fixture();
    let key = PublicKey::from_jwk(&f["publicJwk"]).unwrap();
    let message = f["message"].as_str().unwrap().as_bytes();
    let signature = decode_hex(f["signature"].as_str().unwrap()).unwrap();
    assert!(key.verify(message, &signature));
    assert_eq!(
        key.finalize(
            message,
            &decode_hex(f["blindSignature"].as_str().unwrap()).unwrap(),
            &decode_hex(f["blindingFactor"].as_str().unwrap()).unwrap()
        )
        .unwrap(),
        signature
    );
}

#[test]
fn native_signing_matches_saved_javascript_blind_signature() {
    let f = fixture();
    let signed = sign(
        &f["privateJwk"],
        &decode_hex(f["blindedMessage"].as_str().unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(encode_hex(&signed), f["blindSignature"].as_str().unwrap());
}

#[test]
fn native_roundtrip_and_negative_inputs() {
    let f = fixture();
    let key = PublicKey::from_jwk(&f["publicJwk"]).unwrap();
    let message = "saved credentials: café 🗳️\u{0} remain compatible".as_bytes();
    let request = key.blind(message).unwrap();
    let signed = sign(&f["privateJwk"], &request.blinded_message).unwrap();
    let signature = key
        .finalize(message, &signed, &request.blinding_factor)
        .unwrap();
    assert!(key.verify(message, &signature));
    assert!(!key.verify(b"wrong message", &signature));
    assert!(!key.verify(message, &signature[1..]));
    assert!(key
        .finalize(b"wrong message", &signed, &request.blinding_factor)
        .is_err());
    assert!(key
        .finalize(message, &signed[1..], &request.blinding_factor)
        .is_err());
    assert!(sign(&f["privateJwk"], &[0; 384]).is_err());
    assert!(sign(&f["privateJwk"], &[255; 384]).is_err());
    assert!(PublicKey::from_jwk(&serde_json::json!({"n": "AQ", "e": "AQAB"})).is_err());
    let mut bad = f["privateJwk"].clone();
    bad["p"] = serde_json::json!("Aw");
    assert!(sign(&bad, &request.blinded_message).is_err());
    assert!(decode_hex("zz").is_err());
    assert!(decode_hex("123").is_err());
    assert!(decode_hex("+a").is_err());
}

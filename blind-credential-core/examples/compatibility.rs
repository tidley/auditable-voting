//! Offline interoperability test driver. Use fictional fixture keys only.
use auditable_voting_blind_credentials::{decode_hex, encode_hex, sign, PublicKey};
use serde_json::{json, Value};
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin()
        .take(2 * 1024 * 1024)
        .read_to_string(&mut input)?;
    let input: Value = serde_json::from_str(&input)?;
    let field = |name: &str| input[name].as_str().ok_or("Missing test field");
    let message = input["message"].as_str().unwrap_or("").as_bytes();
    let result = match field("operation")? {
        "blind" => {
            let request = PublicKey::from_jwk(&input["jwk"])?.blind(message)?;
            json!({ "blindedMessage": encode_hex(&request.blinded_message), "blindingFactor": encode_hex(&request.blinding_factor) })
        }
        "sign" => json!(encode_hex(&sign(
            &input["jwk"],
            &decode_hex(field("blindedMessage")?)?
        )?)),
        "finalize" => json!(encode_hex(&PublicKey::from_jwk(&input["jwk"])?.finalize(
            message,
            &decode_hex(field("blindSignature")?)?,
            &decode_hex(field("blindingFactor")?)?
        )?)),
        "verify" => {
            json!(PublicKey::from_jwk(&input["jwk"])?
                .verify(message, &decode_hex(field("signature")?)?))
        }
        _ => return Err("Unknown offline test operation".into()),
    };
    println!("{result}");
    Ok(())
}

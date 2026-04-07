use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::coordinator_messages::CoordinatorControlEnvelope;

#[derive(Debug, Error)]
pub enum GroupEngineError {
    #[error("Invalid coordinator control payload: {0}")]
    InvalidPayload(String),
    #[error("OpenMLS engine is not available in this build")]
    OpenMlsUnavailable,
}

pub trait CoordinatorGroupEngine {
    fn encode(&mut self, envelope: &CoordinatorControlEnvelope) -> Result<String, GroupEngineError>;
    fn decode(&mut self, raw_content: &str) -> Result<CoordinatorControlEnvelope, GroupEngineError>;
    fn snapshot(&self) -> CoordinatorGroupEngineSnapshot;
    fn restore(&mut self, snapshot: CoordinatorGroupEngineSnapshot);
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct CoordinatorGroupEngineSnapshot {
    pub engine_kind: String,
    #[serde(default)]
    pub openmls_state: Option<OpenMlsCoordinatorStateSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OpenMlsCoordinatorStateSnapshot {
    pub storage_json: String,
    pub signer_json: String,
    pub credential_json: String,
    pub group_id_json: String,
}

#[derive(Debug, Default)]
pub struct DeterministicCoordinatorGroupEngine;

impl CoordinatorGroupEngine for DeterministicCoordinatorGroupEngine {
    fn encode(&mut self, envelope: &CoordinatorControlEnvelope) -> Result<String, GroupEngineError> {
        serde_json::to_string(envelope).map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))
    }

    fn decode(&mut self, raw_content: &str) -> Result<CoordinatorControlEnvelope, GroupEngineError> {
        serde_json::from_str(raw_content).map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))
    }

    fn snapshot(&self) -> CoordinatorGroupEngineSnapshot {
        CoordinatorGroupEngineSnapshot {
            engine_kind: "deterministic_stub".to_owned(),
            openmls_state: None,
        }
    }

    fn restore(&mut self, _snapshot: CoordinatorGroupEngineSnapshot) {}
}

#[cfg(feature = "openmls-engine")]
mod openmls_impl {
    use base64::Engine as _;
    use openmls::prelude::{
        tls_codec::{Deserialize as _, Serialize as _},
        CredentialWithKey, GroupId, MlsGroup, MlsMessageIn, ProcessedMessageContent,
    };
    #[cfg(test)]
    use openmls::prelude::{BasicCredential, KeyPackage, MlsGroupCreateConfig, StagedWelcome};
    use openmls_basic_credential::SignatureKeyPair;
    use openmls_rust_crypto::OpenMlsRustCrypto;
    use openmls_traits::OpenMlsProvider as _;
    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;

    use super::{CoordinatorControlEnvelope, GroupEngineError, OpenMlsCoordinatorStateSnapshot};

    #[cfg(test)]
    const CIPHERSUITE: openmls::prelude::Ciphersuite =
        openmls::prelude::Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;

    #[derive(Debug, Default, Serialize, Deserialize)]
    struct SerializableStore {
        values: HashMap<String, String>,
    }

    #[derive(Debug)]
    pub struct OpenMlsCoordinatorGroupEngine {
        provider: Option<OpenMlsRustCrypto>,
        signer: Option<SignatureKeyPair>,
        credential_with_key: Option<CredentialWithKey>,
        group_id: Option<GroupId>,
    }

    impl OpenMlsCoordinatorGroupEngine {
        pub fn new() -> Self {
            Self {
                provider: None,
                signer: None,
                credential_with_key: None,
                group_id: None,
            }
        }

        #[cfg(test)]
        pub fn create_lead(identity: &str) -> Result<Self, GroupEngineError> {
            let provider = OpenMlsRustCrypto::default();
            let credential = BasicCredential::new(identity.as_bytes().to_vec());
            let signer = SignatureKeyPair::new(CIPHERSUITE.signature_algorithm())
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            signer
                .store(provider.storage())
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            let credential_with_key = CredentialWithKey {
                credential: credential.into(),
                signature_key: signer.public().into(),
            };

            Ok(Self {
                provider: Some(provider),
                signer: Some(signer),
                credential_with_key: Some(credential_with_key),
                group_id: None,
            })
        }

        #[cfg(test)]
        pub fn create_member(identity: &str) -> Result<(Self, KeyPackage), GroupEngineError> {
            let engine = Self::create_lead(identity)?;
            let provider = engine.provider.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let signer = engine.signer.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let credential_with_key = engine
                .credential_with_key
                .clone()
                .ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let key_package = KeyPackage::builder()
                .build(
                    CIPHERSUITE,
                    provider,
                    signer,
                    credential_with_key,
                )
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;

            Ok((engine, key_package.key_package().clone()))
        }

        #[cfg(test)]
        pub fn signer_public_key(&self) -> Vec<u8> {
            self.signer
                .as_ref()
                .map(|signer| signer.public().to_vec())
                .unwrap_or_default()
        }

        #[cfg(test)]
        pub fn bootstrap_lead(
            &mut self,
            election_id: &str,
            member_key_packages: &[KeyPackage],
        ) -> Result<(Vec<u8>, Vec<u8>), GroupEngineError> {
            let provider = self.provider.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let signer = self.signer.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let credential = self
                .credential_with_key
                .clone()
                .ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let group_id = GroupId::from_slice(election_id.as_bytes());
            let create_config = MlsGroupCreateConfig::builder()
                .use_ratchet_tree_extension(true)
                .ciphersuite(CIPHERSUITE)
                .build();

            let mut group = MlsGroup::new_with_group_id(
                provider,
                signer,
                &create_config,
                group_id.clone(),
                credential,
            )
            .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;

            let add_refs = member_key_packages.iter().cloned().collect::<Vec<_>>();
            let (_, welcome, _) = group
                .add_members(provider, signer, &add_refs)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            group
                .merge_pending_commit(provider)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            self.group_id = Some(group_id);

            let welcome_bytes = welcome
                .tls_serialize_detached()
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            let ratchet_tree_bytes = group
                .export_ratchet_tree()
                .tls_serialize_detached()
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;

            Ok((welcome_bytes, ratchet_tree_bytes))
        }

        #[cfg(test)]
        pub fn join_from_welcome(
            &mut self,
            welcome_bytes: &[u8],
            ratchet_tree_bytes: &[u8],
        ) -> Result<(), GroupEngineError> {
            let provider = self.provider.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let mut welcome_slice = welcome_bytes;
            let welcome_message = MlsMessageIn::tls_deserialize(&mut welcome_slice)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            let welcome = match welcome_message.extract() {
                openmls::prelude::MlsMessageBodyIn::Welcome(welcome) => welcome,
                other => {
                    return Err(GroupEngineError::InvalidPayload(format!(
                        "Expected MLS welcome, got {other:?}"
                    )))
                }
            };
            let mut ratchet_tree_slice = ratchet_tree_bytes;
            let ratchet_tree = openmls::prelude::RatchetTreeIn::tls_deserialize(&mut ratchet_tree_slice)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            let join_config = openmls::prelude::MlsGroupJoinConfig::default();
            let group = StagedWelcome::new_from_welcome(
                provider,
                &join_config,
                welcome,
                Some(ratchet_tree.into()),
            )
            .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?
            .into_group(provider)
            .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            self.group_id = Some(group.group_id().clone());
            Ok(())
        }

        fn snapshot_state(&self) -> Result<Option<OpenMlsCoordinatorStateSnapshot>, GroupEngineError> {
            let Some(provider) = self.provider.as_ref() else {
                return Ok(None);
            };
            let Some(signer) = self.signer.as_ref() else {
                return Ok(None);
            };
            let Some(credential) = self.credential_with_key.as_ref() else {
                return Ok(None);
            };
            let Some(group_id) = self.group_id.as_ref() else {
                return Ok(None);
            };

            let mut serializable_storage = SerializableStore::default();
            for (key, value) in &*provider.storage().values.read().unwrap() {
                serializable_storage.values.insert(
                    base64::prelude::BASE64_STANDARD.encode(key),
                    base64::prelude::BASE64_STANDARD.encode(value),
                );
            }

            Ok(Some(OpenMlsCoordinatorStateSnapshot {
                storage_json: serde_json::to_string(&serializable_storage)
                    .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?,
                signer_json: serde_json::to_string(signer)
                    .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?,
                credential_json: serde_json::to_string(credential)
                    .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?,
                group_id_json: serde_json::to_string(group_id)
                    .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?,
            }))
        }

        fn restore_state(&mut self, snapshot: OpenMlsCoordinatorStateSnapshot) -> Result<(), GroupEngineError> {
            let serializable_storage = serde_json::from_str::<SerializableStore>(&snapshot.storage_json)
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;
            let signer = serde_json::from_str::<SignatureKeyPair>(&snapshot.signer_json)
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;
            let credential = serde_json::from_str::<CredentialWithKey>(&snapshot.credential_json)
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;
            let group_id = serde_json::from_str::<GroupId>(&snapshot.group_id_json)
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;

            let provider = OpenMlsRustCrypto::default();
            let mut values = provider.storage().values.write().unwrap();
            values.clear();
            for (key, value) in serializable_storage.values {
                values.insert(
                    base64::prelude::BASE64_STANDARD
                        .decode(key)
                        .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?,
                    base64::prelude::BASE64_STANDARD
                        .decode(value)
                        .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?,
                );
            }
            drop(values);

            self.provider = Some(provider);
            self.signer = Some(signer);
            self.credential_with_key = Some(credential);
            self.group_id = Some(group_id);
            Ok(())
        }

        fn group(&self) -> Result<MlsGroup, GroupEngineError> {
            let provider = self.provider.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let group_id = self.group_id.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            MlsGroup::load(provider.storage(), group_id)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?
                .ok_or(GroupEngineError::OpenMlsUnavailable)
        }
    }

    impl super::CoordinatorGroupEngine for OpenMlsCoordinatorGroupEngine {
        fn encode(&mut self, envelope: &CoordinatorControlEnvelope) -> Result<String, GroupEngineError> {
            let provider = self.provider.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let signer = self.signer.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let mut group = self.group()?;
            let payload = serde_json::to_vec(envelope)
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;
            let message = group
                .create_message(provider, signer, &payload)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            let encoded = message
                .tls_serialize_detached()
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;
            Ok(base64::prelude::BASE64_STANDARD.encode(encoded))
        }

        fn decode(&mut self, raw_content: &str) -> Result<CoordinatorControlEnvelope, GroupEngineError> {
            let provider = self.provider.as_ref().ok_or(GroupEngineError::OpenMlsUnavailable)?;
            let mut group = self.group()?;
            let encoded = base64::prelude::BASE64_STANDARD
                .decode(raw_content)
                .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))?;
            let mut encoded_slice = encoded.as_slice();
            let message = MlsMessageIn::tls_deserialize(&mut encoded_slice)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;
            let processed = group
                .process_message(provider, message.try_into_protocol_message().map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?)
                .map_err(|error| GroupEngineError::InvalidPayload(format!("{error:?}")))?;

            match processed.into_content() {
                ProcessedMessageContent::ApplicationMessage(application_message) => {
                    serde_json::from_slice::<CoordinatorControlEnvelope>(&application_message.into_bytes())
                        .map_err(|error| GroupEngineError::InvalidPayload(error.to_string()))
                }
                other => Err(GroupEngineError::InvalidPayload(format!(
                    "Expected MLS application message, got {other:?}"
                ))),
            }
        }

        fn snapshot(&self) -> super::CoordinatorGroupEngineSnapshot {
            super::CoordinatorGroupEngineSnapshot {
                engine_kind: "openmls".to_owned(),
                openmls_state: self.snapshot_state().ok().flatten(),
            }
        }

        fn restore(&mut self, snapshot: super::CoordinatorGroupEngineSnapshot) {
            if let Some(state) = snapshot.openmls_state {
                let _ = self.restore_state(state);
            }
        }
    }

    pub use OpenMlsCoordinatorGroupEngine as ExportedOpenMlsCoordinatorGroupEngine;
}

#[cfg(feature = "openmls-engine")]
pub use openmls_impl::ExportedOpenMlsCoordinatorGroupEngine as OpenMlsCoordinatorGroupEngine;

#[cfg(test)]
mod tests {
    use super::{CoordinatorGroupEngine, DeterministicCoordinatorGroupEngine};
    use crate::coordinator_messages::{CoordinatorControlEnvelope, CoordinatorControlPayload, RoundDraftPayload};

    #[test]
    fn deterministic_engine_round_trips_json_envelope() {
        let mut engine = DeterministicCoordinatorGroupEngine;
        let envelope = CoordinatorControlEnvelope::new(
            "election-1".to_owned(),
            Some("round-1".to_owned()),
            1,
            "coord-1".to_owned(),
            Some(1),
            CoordinatorControlPayload::RoundDraft(RoundDraftPayload {
                prompt: "Question?".to_owned(),
                threshold_t: 2,
                threshold_n: 2,
                coordinator_roster: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            }),
        );
        let encoded = engine.encode(&envelope).unwrap();
        let decoded = engine.decode(&encoded).unwrap();
        assert_eq!(decoded, envelope);
    }

    #[cfg(feature = "openmls-engine")]
    #[test]
    fn openmls_engine_round_trips_application_message_after_bootstrap() {
        let mut lead =
            super::openmls_impl::OpenMlsCoordinatorGroupEngine::create_lead("coord-1").unwrap();
        let (mut sub, sub_key_package) =
            super::openmls_impl::OpenMlsCoordinatorGroupEngine::create_member("coord-2").unwrap();
        assert_ne!(lead.signer_public_key(), sub.signer_public_key());

        let (welcome_for_others, ratchet_tree) = lead
            .bootstrap_lead("election-1", &[sub_key_package])
            .unwrap();
        sub.join_from_welcome(&welcome_for_others, &ratchet_tree).unwrap();

        let snapshot = lead.snapshot();
        let mut restored = super::openmls_impl::OpenMlsCoordinatorGroupEngine::new();
        restored.restore(snapshot.clone());
        assert_eq!(snapshot.engine_kind, "openmls");
        assert!(snapshot.openmls_state.is_some());
        assert_eq!(restored.snapshot().engine_kind, "openmls");
        assert!(restored.snapshot().openmls_state.is_some());

        let envelope = CoordinatorControlEnvelope::new(
            "election-1".to_owned(),
            Some("round-1".to_owned()),
            10,
            "coord-1".to_owned(),
            Some(1),
            CoordinatorControlPayload::RoundDraft(RoundDraftPayload {
                prompt: "Should the proposal pass?".to_owned(),
                threshold_t: 2,
                threshold_n: 2,
                coordinator_roster: vec!["coord-1".to_owned(), "coord-2".to_owned()],
            }),
        );
        let encoded = lead.encode(&envelope).unwrap();
        let decoded = sub.decode(&encoded).unwrap();
        assert_eq!(decoded, envelope);
    }
}

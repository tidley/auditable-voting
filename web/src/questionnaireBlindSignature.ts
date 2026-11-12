import { blindCredential, signBlindCredential, finalizeBlindCredential, verifyBlindCredential } from "./wasm/blindCredentials";
import { sha256HexRust } from "./wasm/auditableVotingCore";

const QUESTIONNAIRE_BLIND_SCHEME = "rsabssa-sha384-pss-deterministic-v1";

export type QuestionnaireBlindPublicKey = {
  scheme: typeof QUESTIONNAIRE_BLIND_SCHEME;
  keyId: string;
  jwk: JsonWebKey;
};

export type QuestionnaireBlindPrivateKey = QuestionnaireBlindPublicKey & {
  privateJwk: JsonWebKey;
};

export function toQuestionnaireBlindPublicKey(privateKey: QuestionnaireBlindPrivateKey): QuestionnaireBlindPublicKey {
  return {
    scheme: QUESTIONNAIRE_BLIND_SCHEME,
    keyId: privateKey.keyId,
    jwk: privateKey.jwk,
  };
}

export async function generateQuestionnaireBlindKeyPair(): Promise<QuestionnaireBlindPrivateKey> {
  const keyPair = await crypto.subtle.generateKey({
    name: "RSA-PSS",
    hash: "SHA-384",
    modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]),
  }, true, ["sign", "verify"]);
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", keyPair.publicKey),
    crypto.subtle.exportKey("jwk", keyPair.privateKey),
  ]);
  const keyId = sha256HexRust(JSON.stringify({ n: publicJwk.n, e: publicJwk.e })).slice(0, 24);
  return {
    scheme: QUESTIONNAIRE_BLIND_SCHEME,
    keyId,
    jwk: publicJwk,
    privateJwk,
  };
}

export async function blindQuestionnaireToken(input: {
  publicKey: QuestionnaireBlindPublicKey;
  message: string;
}) {
  return blindCredential(input.publicKey.jwk, new TextEncoder().encode(input.message));
}

export async function signBlindedQuestionnaireToken(input: {
  privateKey: QuestionnaireBlindPrivateKey;
  blindedMessage: string;
}) {
  return signBlindCredential(input.privateKey.privateJwk, input.blindedMessage);
}

export async function finalizeQuestionnaireBlindSignature(input: {
  publicKey: QuestionnaireBlindPublicKey;
  message: string;
  blindSignature: string;
  blindingFactor: string;
}) {
  return finalizeBlindCredential(input.publicKey.jwk, new TextEncoder().encode(input.message), input.blindSignature, input.blindingFactor);
}

export async function verifyQuestionnaireBlindSignature(input: {
  publicKey: QuestionnaireBlindPublicKey;
  message: string;
  signature: string;
}) {
  try {
    return verifyBlindCredential(input.publicKey.jwk, new TextEncoder().encode(input.message), input.signature);
  } catch {
    return false;
  }
}

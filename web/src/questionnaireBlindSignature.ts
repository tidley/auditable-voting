import { RSABSSA } from "@cloudflare/blindrsa-ts";
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

const suite = RSABSSA.SHA384.PSS.Deterministic();

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string) {
  const clean = hex.trim();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new Error("Expected hex bytes.");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeMessage(message: string) {
  return suite.prepare(new TextEncoder().encode(message));
}

async function importPublicKey(publicKey: QuestionnaireBlindPublicKey) {
  return crypto.subtle.importKey(
    "jwk",
    publicKey.jwk,
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["verify"],
  );
}

async function importPrivateKey(privateKey: QuestionnaireBlindPrivateKey) {
  return crypto.subtle.importKey(
    "jwk",
    privateKey.privateJwk,
    { name: "RSA-PSS", hash: "SHA-384" },
    true,
    ["sign"],
  );
}

export function toQuestionnaireBlindPublicKey(privateKey: QuestionnaireBlindPrivateKey): QuestionnaireBlindPublicKey {
  return {
    scheme: QUESTIONNAIRE_BLIND_SCHEME,
    keyId: privateKey.keyId,
    jwk: privateKey.jwk,
  };
}

export async function generateQuestionnaireBlindKeyPair(): Promise<QuestionnaireBlindPrivateKey> {
  const keyPair = await suite.generateKey({
    modulusLength: 3072,
    publicExponent: new Uint8Array([1, 0, 1]),
  });
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
  const publicKey = await importPublicKey(input.publicKey);
  const { blindedMsg, inv } = await suite.blind(publicKey, encodeMessage(input.message));
  return {
    blindedMessage: bytesToHex(blindedMsg),
    blindingFactor: bytesToHex(inv),
  };
}

export async function signBlindedQuestionnaireToken(input: {
  privateKey: QuestionnaireBlindPrivateKey;
  blindedMessage: string;
}) {
  const privateKey = await importPrivateKey(input.privateKey);
  const blindSignature = await suite.blindSign(privateKey, hexToBytes(input.blindedMessage));
  return bytesToHex(blindSignature);
}

export async function finalizeQuestionnaireBlindSignature(input: {
  publicKey: QuestionnaireBlindPublicKey;
  message: string;
  blindSignature: string;
  blindingFactor: string;
}) {
  const publicKey = await importPublicKey(input.publicKey);
  const signature = await suite.finalize(
    publicKey,
    encodeMessage(input.message),
    hexToBytes(input.blindSignature),
    hexToBytes(input.blindingFactor),
  );
  return bytesToHex(signature);
}

export async function verifyQuestionnaireBlindSignature(input: {
  publicKey: QuestionnaireBlindPublicKey;
  message: string;
  signature: string;
}) {
  try {
    const publicKey = await importPublicKey(input.publicKey);
    return suite.verify(publicKey, hexToBytes(input.signature), encodeMessage(input.message));
  } catch {
    return false;
  }
}

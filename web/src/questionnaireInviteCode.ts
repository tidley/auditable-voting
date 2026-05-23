const INVITE_CODE_BYTE_LENGTH = 20;
const INVITE_CODE_HASH_PATTERN = /^[0-9a-f]{64}$/;

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateQuestionnaireInviteCode() {
  const bytes = new Uint8Array(INVITE_CODE_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export function normaliseQuestionnaireInviteCode(code: string | null | undefined) {
  return (code ?? "").trim().toLowerCase();
}

export function isQuestionnaireInviteCodeHash(value: string | null | undefined) {
  return INVITE_CODE_HASH_PATTERN.test((value ?? "").trim().toLowerCase());
}

export async function hashQuestionnaireInviteCode(code: string) {
  const normalised = normaliseQuestionnaireInviteCode(code);
  if (!normalised) {
    return "";
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalised));
  return bytesToHex(new Uint8Array(digest));
}

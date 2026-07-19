import { sha256HexRust } from "./wasm/auditableVotingCore";

export const GENERAL_INVITE_POW_MAX_DIFFICULTY = 24;
const GENERAL_INVITE_POW_YIELD_INTERVAL = 4_096;

export type GeneralInvitePowProof = {
  nonce: string;
};

export type GeneralInvitePowRequest = {
  electionId: string;
  requestId: string;
  invitedNpub: string;
  blindSigningKeyId: string;
  blindedMessage: string;
  clientNonce: string;
};

function yieldToBrowserFrame() {
  return new Promise<void>((resolve) => {
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => resolve());
      return;
    }
    globalThis.setTimeout(resolve, 0);
  });
}

export function isGeneralInvitePowDifficulty(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= GENERAL_INVITE_POW_MAX_DIFFICULTY;
}

export function generalInvitePowPreimage(input: GeneralInvitePowRequest & GeneralInvitePowProof) {
  return JSON.stringify([
    "auditable-voting-general-invite-pow:v1",
    input.electionId,
    input.requestId,
    input.invitedNpub,
    input.blindSigningKeyId,
    input.blindedMessage,
    input.clientNonce,
    input.nonce,
  ]);
}

export function hasLeadingZeroBits(hexDigest: string, difficulty: number) {
  const fullNibbles = Math.floor(difficulty / 4);
  if (hexDigest.slice(0, fullNibbles) !== "0".repeat(fullNibbles)) {
    return false;
  }
  const remainingBits = difficulty % 4;
  return remainingBits === 0 || Number.parseInt(hexDigest[fullNibbles] ?? "f", 16) < (1 << (4 - remainingBits));
}

export function verifyGeneralInvitePow(input: GeneralInvitePowRequest & { difficulty: number; proof?: GeneralInvitePowProof | null }) {
  if (!isGeneralInvitePowDifficulty(input.difficulty) || input.difficulty === 0) {
    return input.difficulty === 0;
  }
  if (!input.proof || !/^(0|[1-9][0-9]*)$/.test(input.proof.nonce)) {
    return false;
  }
  return hasLeadingZeroBits(sha256HexRust(generalInvitePowPreimage({ ...input, nonce: input.proof.nonce })), input.difficulty);
}

export async function mineGeneralInvitePow(input: GeneralInvitePowRequest & {
  difficulty: number;
  onProgress?: (attempts: number) => void;
}) {
  if (!isGeneralInvitePowDifficulty(input.difficulty)) {
    throw new Error(`PoW difficulty must be an integer from 0 to ${GENERAL_INVITE_POW_MAX_DIFFICULTY}.`);
  }
  // Let the UI paint the initial progress state before starting synchronous hashes.
  input.onProgress?.(0);
  await yieldToBrowserFrame();
  for (let candidate = 0; ; candidate += 1) {
    const proof = { nonce: String(candidate) };
    if (verifyGeneralInvitePow({ ...input, proof })) {
      input.onProgress?.(candidate + 1);
      return proof;
    }
    // Yield periodically so a configured challenge does not make the UI unresponsive.
    if (candidate > 0 && candidate % GENERAL_INVITE_POW_YIELD_INTERVAL === 0) {
      input.onProgress?.(candidate + 1);
      await yieldToBrowserFrame();
    }
  }
}

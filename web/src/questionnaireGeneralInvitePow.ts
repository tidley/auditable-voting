import { sha256HexRust } from "./wasm/auditableVotingCore";

export const GENERAL_INVITE_POW_MAX_DIFFICULTY = 24;
const GENERAL_INVITE_POW_YIELD_INTERVAL = 4_096;
const GENERAL_INVITE_POW_WORKER_PROGRESS_INTERVAL = 128;

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

function canMineInWorker() {
  return typeof Worker !== "undefined"
    && typeof Blob !== "undefined"
    && typeof URL !== "undefined"
    && typeof URL.createObjectURL === "function"
    && typeof URL.revokeObjectURL === "function";
}

function mineGeneralInvitePowInWorker(input: GeneralInvitePowRequest & { difficulty: number; onProgress?: (attempts: number) => void }) {
  const source = `
    const progressInterval = ${GENERAL_INVITE_POW_WORKER_PROGRESS_INTERVAL};
    const encoder = new TextEncoder();
    function hasLeadingZeroBits(bytes, difficulty) {
      const fullBytes = Math.floor(difficulty / 8);
      for (let index = 0; index < fullBytes; index += 1) {
        if (bytes[index] !== 0) return false;
      }
      const remainingBits = difficulty % 8;
      return remainingBits === 0 || bytes[fullBytes] < (1 << (8 - remainingBits));
    }
    self.onmessage = async ({ data }) => {
      const { input } = data;
      for (let candidate = 0; ; candidate += 1) {
        const nonce = String(candidate);
        const preimage = JSON.stringify([
          "auditable-voting-general-invite-pow:v1",
          input.electionId,
          input.requestId,
          input.invitedNpub,
          input.blindSigningKeyId,
          input.blindedMessage,
          input.clientNonce,
          nonce,
        ]);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(preimage)));
        const attempts = candidate + 1;
        if (hasLeadingZeroBits(digest, input.difficulty)) {
          self.postMessage({ type: "complete", nonce, attempts });
          self.close();
          return;
        }
        if (attempts % progressInterval === 0) {
          self.postMessage({ type: "progress", attempts });
        }
      }
    };
  `;
  const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  let worker: Worker;
  try {
    worker = new Worker(workerUrl);
  } catch (error) {
    URL.revokeObjectURL(workerUrl);
    return Promise.reject(error);
  }

  return new Promise<GeneralInvitePowProof>((resolve, reject) => {
    let settled = false;
    const cleanUp = () => {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanUp();
      reject(error);
    };
    worker.onmessage = ({ data }: MessageEvent<{ type: string; attempts: number; nonce?: string }>) => {
      if (settled) return;
      if (data.type === "progress") {
        input.onProgress?.(data.attempts);
        return;
      }
      if (data.type === "complete" && data.nonce) {
        settled = true;
        cleanUp();
        input.onProgress?.(data.attempts);
        resolve({ nonce: data.nonce });
      }
    };
    worker.onerror = () => fail(new Error("Browser proof-of-work worker failed."));
    worker.postMessage({ input });
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
  if (canMineInWorker()) {
    return mineGeneralInvitePowInWorker(input);
  }
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

import { describe, expect, it, vi } from "vitest";
import {
  generalInvitePowPreimage,
  mineGeneralInvitePow,
  verifyGeneralInvitePow,
} from "./questionnaireGeneralInvitePow";

const request = {
  electionId: "q_pow",
  requestId: "request_1",
  invitedNpub: "npub1voter",
  blindSigningKeyId: "key_1",
  blindedMessage: "00aabb",
  clientNonce: "client_1",
};

describe("general invite proof of work", () => {
  it("uses a stable, request-bound canonical preimage", () => {
    expect(generalInvitePowPreimage({ ...request, nonce: "42" })).toBe(
      '["auditable-voting-general-invite-pow:v1","q_pow","request_1","npub1voter","key_1","00aabb","client_1","42"]',
    );
  });

  it("mines and verifies a proof while rejecting a changed bound field", async () => {
    const progress: number[] = [];
    const proof = await mineGeneralInvitePow({
      ...request,
      difficulty: 8,
      onProgress: (attempts) => progress.push(attempts),
    });
    expect(verifyGeneralInvitePow({ ...request, difficulty: 8, proof })).toBe(true);
    expect(verifyGeneralInvitePow({ ...request, blindedMessage: "changed", difficulty: 8, proof })).toBe(false);
    expect(progress[0]).toBe(0);
    expect(progress.at(-1)).toBe(Number(proof.nonce) + 1);
  });

  it("uses worker progress messages and releases browser worker resources", async () => {
    const terminate = vi.fn();
    const revokeObjectUrl = vi.fn();
    let worker: { onmessage: ((event: MessageEvent<{ type: string; attempts: number; nonce?: string }>) => void) | null } | undefined;
    class MockWorker {
      onmessage: ((event: MessageEvent<{ type: string; attempts: number; nonce?: string }>) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(_url: string) {
        worker = this;
      }

      postMessage(_message: unknown) {
        this.onmessage?.({ data: { type: "progress", attempts: 128 } } as MessageEvent<{ type: string; attempts: number }>);
        this.onmessage?.({ data: { type: "complete", attempts: 256, nonce: "255" } } as MessageEvent<{ type: string; attempts: number; nonce: string }>);
      }

      terminate = terminate;
    }

    vi.stubGlobal("Worker", MockWorker);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:pow-worker"),
      revokeObjectURL: revokeObjectUrl,
    });
    try {
      const progress: number[] = [];
      await expect(mineGeneralInvitePow({ ...request, difficulty: 8, onProgress: (attempts) => progress.push(attempts) }))
        .resolves.toEqual({ nonce: "255" });
      expect(progress).toEqual([0, 128, 256]);
      expect(terminate).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:pow-worker");
      expect(worker).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a missing proof and accepts disabled proof of work", () => {
    expect(verifyGeneralInvitePow({ ...request, difficulty: 1, proof: null })).toBe(false);
    expect(verifyGeneralInvitePow({ ...request, difficulty: 0, proof: null })).toBe(true);
  });
});

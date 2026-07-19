import { describe, expect, it } from "vitest";
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
    const proof = await mineGeneralInvitePow({ ...request, difficulty: 8 });
    expect(verifyGeneralInvitePow({ ...request, difficulty: 8, proof })).toBe(true);
    expect(verifyGeneralInvitePow({ ...request, blindedMessage: "changed", difficulty: 8, proof })).toBe(false);
  });

  it("rejects a missing proof and accepts disabled proof of work", () => {
    expect(verifyGeneralInvitePow({ ...request, difficulty: 1, proof: null })).toBe(false);
    expect(verifyGeneralInvitePow({ ...request, difficulty: 0, proof: null })).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { resolveQuestionnaireResponderNpub } from "./questionnaireResponderIdentity";

describe("questionnaireResponderIdentity", () => {
  it("uses stable questionnaire responder identity when available", () => {
    const secret = generateSecretKey();
    const responseNsec = nip19.nsecEncode(secret);
    const responseNpub = nip19.npubEncode(getPublicKey(secret));
    const fallbackSecret = generateSecretKey();
    const fallbackNpub = nip19.npubEncode(getPublicKey(fallbackSecret));

    const resolved = resolveQuestionnaireResponderNpub({
      questionnaireId: "q_abc",
      responseIdentityByQuestionnaireId: {
        q_abc: responseNsec,
      },
      fallbackVoterNpub: fallbackNpub,
    });

    expect(resolved).toBe(responseNpub);
  });

  it("falls back to voter npub when no questionnaire identity exists", () => {
    const fallbackSecret = generateSecretKey();
    const fallbackNpub = nip19.npubEncode(getPublicKey(fallbackSecret));

    const resolved = resolveQuestionnaireResponderNpub({
      questionnaireId: "q_missing",
      responseIdentityByQuestionnaireId: {},
      fallbackVoterNpub: fallbackNpub,
    });

    expect(resolved).toBe(fallbackNpub);
  });

  it("falls back to voter npub when stored questionnaire identity is invalid", () => {
    const fallbackSecret = generateSecretKey();
    const fallbackNpub = nip19.npubEncode(getPublicKey(fallbackSecret));

    const resolved = resolveQuestionnaireResponderNpub({
      questionnaireId: "q_invalid",
      responseIdentityByQuestionnaireId: {
        q_invalid: "not-an-nsec",
      },
      fallbackVoterNpub: fallbackNpub,
    });

    expect(resolved).toBe(fallbackNpub);
  });
});

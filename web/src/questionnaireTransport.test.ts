import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSecretKey, nip19, type NostrEvent } from "nostr-tools";
import { evaluateQuestionnaireBlindAdmissions } from "./questionnaireTransport";
import { parseQuestionnaireDefinitionEvent, publishQuestionnaireDefinition } from "./questionnaireNostr";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import {
  QUESTIONNAIRE_RESPONSE_BLIND_KIND,
  QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
  type QuestionnaireBlindResponseEvent,
  type QuestionnaireSubmissionDecisionEvent,
} from "./questionnaireResponsePublish";

const poolPublish = vi.fn();
const queueNostrPublish = vi.fn();
const publishToRelaysStaggered = vi.fn();

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({ publish: poolPublish, querySync: vi.fn() }),
}));

vi.mock("./nostrPublishQueue", () => ({
  queueNostrPublish: (...args: unknown[]) => queueNostrPublish(...args),
  publishToRelaysStaggered: (...args: unknown[]) => publishToRelaysStaggered(...args),
}));

function blindResponse(input: {
  responseId: string;
  nullifier: string;
  createdAt: number;
  eventId: string;
  submittedAt?: number;
  answerText?: string;
}): { event: NostrEvent; response: QuestionnaireBlindResponseEvent } {
  return {
    event: {
      id: input.eventId,
      kind: QUESTIONNAIRE_RESPONSE_BLIND_KIND,
      pubkey: "pubkey",
      created_at: input.createdAt,
      tags: [],
      content: "",
      sig: "sig",
    },
    response: {
      schemaVersion: 1,
      eventType: "questionnaire_response_blind",
      questionnaireId: "course_feedback_2026_term1",
      responseId: input.responseId,
      submittedAt: input.submittedAt ?? input.createdAt,
      authorPubkey: "npub1author",
      tokenNullifier: input.nullifier,
      tokenProof: {
        tokenCommitment: "commitment",
        questionnaireId: "course_feedback_2026_term1",
        signature: "signature",
      },
      answers: input.answerText
        ? [{ questionId: "q1", answerType: "free_text", text: input.answerText }]
        : [],
    },
  };
}

function submissionDecision(input: {
  submissionId: string;
  nullifier: string;
  accepted: boolean;
  reason?: QuestionnaireSubmissionDecisionEvent["reason"];
  createdAt: number;
  eventId: string;
}): { event: NostrEvent; decision: QuestionnaireSubmissionDecisionEvent } {
  return {
    event: {
      id: input.eventId,
      kind: QUESTIONNAIRE_SUBMISSION_DECISION_KIND,
      pubkey: "decision-pubkey",
      created_at: input.createdAt,
      tags: [],
      content: "",
      sig: "sig",
    },
    decision: {
      schemaVersion: 1,
      eventType: "questionnaire_submission_decision",
      questionnaireId: "course_feedback_2026_term1",
      submissionId: input.submissionId,
      tokenNullifier: input.nullifier,
      accepted: input.accepted,
      reason: input.reason ?? (input.accepted ? "accepted" : "invalid_token_proof"),
      decidedAt: input.createdAt,
      coordinatorPubkey: "npub1coordinator",
    },
  };
}

describe("questionnaireTransport blind admissions", () => {
  it("accepts first response and rejects later duplicate nullifier", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const second = blindResponse({
      responseId: "resp-2",
      nullifier: "nullifier-x",
      createdAt: 1712537201,
      eventId: "event-bbb",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [second, first],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.accepted[0].response.responseId).toBe("resp-1");
    expect(result.rejected[0].response.responseId).toBe("resp-2");
    expect(result.rejected[0].rejectionReason).toBe("duplicate_nullifier");
    expect(result.acceptedCountByNullifier["nullifier-x"]).toBe(1);
  });

  it("rejects a new nullifier that reuses an accepted token commitment", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const replay = blindResponse({
      responseId: "resp-2",
      nullifier: "nullifier-y",
      createdAt: 1712537201,
      eventId: "event-bbb",
    });

    const result = evaluateQuestionnaireBlindAdmissions({ entries: [first, replay] });

    expect(result.accepted.map((entry) => entry.response.responseId)).toEqual(["resp-1"]);
    expect(result.rejected[0].rejectionReason).toBe("duplicate_nullifier");
  });

  it("rejects bundled responses when any scoped nullifier was already accepted", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-q1",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    first.response.tokenNullifiers = [
      { questionId: "q1", tokenNullifier: "nullifier-q1", ballotScope: { questionId: "q1", slotId: "q1", slotIndex: 1, version: 1 } },
      { questionId: "q2", tokenNullifier: "nullifier-q2", ballotScope: { questionId: "q2", slotId: "q2", slotIndex: 2, version: 1 } },
    ];
    first.response.tokenProofs = [
      { ...first.response.tokenProof, questionId: "q1", ballotScope: { questionId: "q1", slotId: "q1", slotIndex: 1, version: 1 } },
      { ...first.response.tokenProof, tokenCommitment: "commitment-q2", questionId: "q2", ballotScope: { questionId: "q2", slotId: "q2", slotIndex: 2, version: 1 } },
    ];
    const second = blindResponse({
      responseId: "resp-2",
      nullifier: "nullifier-q2",
      createdAt: 1712537201,
      eventId: "event-bbb",
    });
    second.response.tokenNullifiers = [
      { questionId: "q2", tokenNullifier: "nullifier-q2", ballotScope: { questionId: "q2", slotId: "q2", slotIndex: 2, version: 1 } },
    ];

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [second, first],
    });

    expect(result.accepted.map((entry) => entry.response.responseId)).toEqual(["resp-1"]);
    expect(result.rejected.map((entry) => entry.response.responseId)).toEqual(["resp-2"]);
    expect(result.rejected[0].rejectionReason).toBe("duplicate_nullifier");
    expect(result.acceptedCountByNullifier).toMatchObject({
      "nullifier-q1": 1,
      "nullifier-q2": 1,
    });
  });

  it("does not reject the same relay event when it is returned more than once", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response, response],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].response.responseId).toBe("resp-1");
  });

  it("rejects unverified blind responses when proof verification is required", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      proofVerdicts: [],
      requireVerifiedProofs: true,
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectionReason).toBe("invalid_token_proof");
  });

  it("does not let an accepted decision override missing local proof verification", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const accepted = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: true,
      createdAt: 1712537300,
      eventId: "decision-accepted",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      decisionEntries: [accepted],
      proofVerdicts: [],
      requireVerifiedProofs: true,
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectionReason).toBe("invalid_token_proof");
    expect(result.rejected[0].decisionEventId).toBe(null);
  });

  it("treats a republished response id as one logical submission", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const republished = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537300,
      submittedAt: 1712537200,
      eventId: "event-bbb",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [republished, first],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].event.id).toBe("event-aaa");
  });

  it("rejects a repeated response id with a conflicting payload", () => {
    const first = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
      answerText: "Original answer",
    });
    const conflicting = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-y",
      createdAt: 1712537300,
      eventId: "event-bbb",
      answerText: "Changed answer",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [conflicting, first],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.accepted[0].event.id).toBe("event-aaa");
    expect(result.rejected[0].event.id).toBe("event-bbb");
    expect(result.rejected[0].rejectionReason).toBe("duplicate_response");
  });

  it("keeps a submission accepted when a later rejection conflicts with an accepted decision", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const accepted = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: true,
      createdAt: 1712537300,
      eventId: "decision-accepted",
    });
    const laterInvalid = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: false,
      reason: "invalid_token_proof",
      createdAt: 1712537400,
      eventId: "decision-invalid",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      decisionEntries: [accepted, laterInvalid],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].decisionEventId).toBe("decision-accepted");
    expect(result.accepted[0].rejectionReason).toBe(null);
  });

  it("ignores an invalid-token-proof decision for a locally verified response", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const invalid = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: false,
      reason: "invalid_token_proof",
      createdAt: 1712537300,
      eventId: "decision-invalid",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      decisionEntries: [invalid],
      proofVerdicts: [["resp-1", { verdict: "valid" as const, reason: null, component: "questionnaire_blind_token_proof" as const }]],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].decisionEventId).toBe(null);
    expect(result.accepted[0].rejectionReason).toBe(null);
  });
});

describe("questionnaireTransport tri-state proof fold (fail-closed)", () => {
  const validVerdict = {
    verdict: "valid" as const,
    reason: null,
    component: "questionnaire_blind_token_proof" as const,
  };
  const invalidVerdict = {
    verdict: "invalid" as const,
    reason: "token_proof_signature_invalid",
    component: "questionnaire_blind_token_proof" as const,
  };
  const unknownVerdict = {
    verdict: "unknown" as const,
    reason: "definition_blind_signing_public_key_absent",
    component: "questionnaire_blind_token_proof" as const,
  };

  it("rejects a response whose proof verdict is unknown (definition key absent) instead of admitting it", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      proofVerdicts: [["resp-1", unknownVerdict]],
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].response.responseId).toBe("resp-1");
    expect(result.rejected[0].rejectionReason).toBe("unknown_token_proof");
  });

  it("rejects a response whose proof verdict is invalid when the definition key is present", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      proofVerdicts: [["resp-1", invalidVerdict]],
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectionReason).toBe("invalid_token_proof");
  });

  it("admits a response whose proof verdict is valid", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      proofVerdicts: [["resp-1", validVerdict]],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted[0].response.responseId).toBe("resp-1");
  });

  it("cannot be overridden by a remote accepted decision when the proof verdict is unknown", () => {
    const response = blindResponse({
      responseId: "resp-1",
      nullifier: "nullifier-x",
      createdAt: 1712537200,
      eventId: "event-aaa",
    });
    const accepted = submissionDecision({
      submissionId: "resp-1",
      nullifier: "nullifier-x",
      accepted: true,
      createdAt: 1712537300,
      eventId: "decision-accepted",
    });

    const result = evaluateQuestionnaireBlindAdmissions({
      entries: [response],
      decisionEntries: [accepted],
      proofVerdicts: [["resp-1", unknownVerdict]],
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].rejectionReason).toBe("unknown_token_proof");
    expect(result.rejected[0].decisionEventId).toBe(null);
  });
});

function localisedDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: "q_multi_language_2026",
    title: { en: "Term 1 feedback", fr: "Retour du trimestre 1", ta: "முதல் தவணை கருத்து" },
    description: {
      en: "Tell us how term 1 went.",
      fr: "Dites-nous comment s'est passé le trimestre 1.",
      ta: "முதல் தவணை எப்படி இருந்தது எனக் கூறுங்கள்.",
    },
    createdAt: 1712530000,
    openAt: 1712531000,
    closeAt: 1712539999,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinator",
    responseVisibility: "private",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: {
          en: "Did you attend?",
          fr: "Avez-vous participé ?",
          ta: "நீங்கள் கலந்து கொண்டீர்களா?",
        },
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        multiSelect: false,
        prompt: { en: "Which session?", fr: "Quelle session ?", ta: "எந்த அமர்வு?" },
        required: false,
        options: [
          { optionId: "o1", label: { en: "Morning", fr: "Matin", ta: "காலை" } },
          { optionId: "o2", label: { en: "Afternoon", fr: "Après-midi", ta: "பிற்பகல்" } },
        ],
      },
    ],
  };
}

describe("questionnaireTransport multilingual definition serialisation", () => {
  beforeEach(() => {
    poolPublish.mockReset();
    queueNostrPublish.mockReset();
    publishToRelaysStaggered.mockReset();
    poolPublish.mockReturnValue([Promise.resolve(undefined)]);
    queueNostrPublish.mockImplementation(async (fn: () => Promise<PromiseSettledResult<unknown>[]>) => fn());
    publishToRelaysStaggered.mockImplementation(
      async (publishOne: (relay: string) => Promise<unknown>, relays: string[]) =>
        Promise.allSettled(relays.map((relay) => publishOne(relay))),
    );
  });

  it("round-trips a localised definition through publish and parse preserving every language", async () => {
    const coordinatorNsec = nip19.nsecEncode(generateSecretKey());
    const definition = localisedDefinition();

    const published = await publishQuestionnaireDefinition({
      coordinatorNsec,
      definition,
      relays: ["wss://relay.example"],
    });

    // The event that goes on the wire carries every locale, not just English.
    const wire = JSON.parse(published.event.content) as QuestionnaireDefinition;
    expect(wire.title).toEqual(definition.title);
    expect(wire.description).toEqual(definition.description);
    expect(wire.questions[0].prompt).toEqual(definition.questions[0].prompt);
    expect(wire.questions[1].prompt).toEqual(definition.questions[1].prompt);
    expect((wire.questions[1] as { options: { label: unknown }[] }).options.map((option) => option.label))
      .toEqual([
        { en: "Morning", fr: "Matin", ta: "காலை" },
        { en: "Afternoon", fr: "Après-midi", ta: "பிற்பகல்" },
      ]);

    const parsed = parseQuestionnaireDefinitionEvent({
      kind: published.event.kind,
      content: published.event.content,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.questionnaireId).toBe("q_multi_language_2026");
    expect(parsed?.title).toEqual(definition.title);
    expect(parsed?.description).toEqual(definition.description);
    expect(parsed?.questions[0].prompt).toEqual(definition.questions[0].prompt);
    expect(parsed?.questions[1].prompt).toEqual(definition.questions[1].prompt);
    expect((parsed?.questions[1] as { options: { label: unknown }[] }).options.map((option) => option.label))
      .toEqual([
        { en: "Morning", fr: "Matin", ta: "காலை" },
        { en: "Afternoon", fr: "Après-midi", ta: "பிற்பகல்" },
      ]);
  });

  it("publishes a definition built with plain English strings as English-only localised text", async () => {
    const coordinatorNsec = nip19.nsecEncode(generateSecretKey());
    const legacy = {
      ...localisedDefinition(),
      title: "Term 1 feedback",
      description: "Tell us how term 1 went.",
      questions: [
        { questionId: "q1", type: "yes_no" as const, prompt: "Did you attend?", required: true },
        {
          questionId: "q2",
          type: "multiple_choice" as const,
          multiSelect: false,
          prompt: "Which session?",
          required: false,
          options: [{ optionId: "o1", label: "Morning" }],
        },
      ],
    } as unknown as QuestionnaireDefinition;

    const published = await publishQuestionnaireDefinition({
      coordinatorNsec,
      definition: legacy,
      relays: ["wss://relay.example"],
    });

    const wire = JSON.parse(published.event.content) as QuestionnaireDefinition;
    expect(wire.title).toEqual({ en: "Term 1 feedback" });
    expect(wire.description).toEqual({ en: "Tell us how term 1 went." });
    expect(wire.questions[0].prompt).toEqual({ en: "Did you attend?" });
    expect((wire.questions[1] as { options: { label: unknown }[] }).options[0].label).toEqual({ en: "Morning" });

    // The in-memory definition the caller handed us is left untouched.
    expect(legacy.title).toBe("Term 1 feedback");
  });

  it("parses a definition event written before multi-language support as English-only localised text", () => {
    const legacyContent = JSON.stringify({
      ...localisedDefinition(),
      title: "Term 1 feedback",
      description: "Tell us how term 1 went.",
      questions: [
        { questionId: "q1", type: "yes_no", prompt: "Did you attend?", required: true },
        {
          questionId: "q2",
          type: "multiple_choice",
          multiSelect: false,
          prompt: "Which session?",
          required: false,
          options: [{ optionId: "o1", label: "Morning" }],
        },
      ],
    });

    const parsed = parseQuestionnaireDefinitionEvent({ kind: 6420, content: legacyContent });

    expect(parsed).not.toBeNull();
    expect(parsed?.title).toEqual({ en: "Term 1 feedback" });
    expect(parsed?.description).toEqual({ en: "Tell us how term 1 went." });
    expect(parsed?.questions[0].prompt).toEqual({ en: "Did you attend?" });
    expect((parsed?.questions[1] as { options: { label: unknown }[] }).options[0].label).toEqual({ en: "Morning" });
  });
});

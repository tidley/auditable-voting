import { describe, expect, it } from "vitest";
import {
  questionBallotCredentialScope,
  normaliseQuestionnaireAllowedScopes,
  normaliseQuestionnaireScope,
  normaliseQuestionBallotSlot,
  normalizeQuestionnaireDefinition,
  questionBallotScopeKey,
  validateQuestionnaireDefinition,
  validateQuestionnaireResponsePayload,
  type QuestionnaireDefinition,
  type QuestionnaireResponsePayload,
} from "./questionnaireProtocol";
import { QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN } from "./questionnaireProtocolConstants";
import { DEFAULT_QUESTIONNAIRE_RELAYS } from "./questionnaireRelays";

function buildDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: QUESTIONNAIRE_RESPONSE_MODE_BLIND_TOKEN,
    questionnaireId: "course_feedback_2026_term1",
    title: "Course feedback",
    description: "Please answer all required questions.",
    createdAt: 1712530000,
    openAt: 1712533600,
    closeAt: 1712619999,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinatorenc",
    responseVisibility: "private",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      {
        questionId: "q1",
        type: "yes_no",
        prompt: "Was the course material clear?",
        required: true,
      },
      {
        questionId: "q2",
        type: "multiple_choice",
        prompt: "How would you rate the pace?",
        required: true,
        multiSelect: false,
        options: [
          { optionId: "slow", label: "Too slow" },
          { optionId: "good", label: "About right" },
          { optionId: "fast", label: "Too fast" },
        ],
      },
      {
        questionId: "q3",
        type: "free_text",
        prompt: "What should be improved?",
        required: false,
        maxLength: 1000,
      },
    ],
  };
}

describe("questionnaireProtocol", () => {
  it("validates a well-formed questionnaire definition", () => {
    const result = validateQuestionnaireDefinition(buildDefinition());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("supports questionnaire-defined voter groups while preserving legacy aliases", () => {
    expect(normaliseQuestionnaireScope("A")).toBe("1");
    expect(normaliseQuestionnaireScope("North_District")).toBe("north_district");
    expect(normaliseQuestionnaireScope("invalid group")).toBeNull();
    expect(normaliseQuestionnaireAllowedScopes(["group_z", "group_a"])).toEqual(["0", "group_a", "group_z"]);

    const definition: QuestionnaireDefinition = {
      ...buildDefinition(),
      voterGroups: [{ id: "group_north", label: "North district" }],
      questions: buildDefinition().questions.map((question, index) => index === 0
        ? { ...question, requiredScope: "group_north", ballotGroup: "group_north" }
        : question),
    };
    expect(validateQuestionnaireDefinition(definition)).toEqual({ valid: true, errors: [] });
  });

  it("rejects unknown and duplicate voter groups", () => {
    const definition: QuestionnaireDefinition = {
      ...buildDefinition(),
      voterGroups: [
        { id: "group_north", label: "North district" },
        { id: "group_north", label: "North district copy" },
      ],
      questions: buildDefinition().questions.map((question, index) => index === 0
        ? { ...question, requiredScope: "group_missing" }
        : question),
    };
    const result = validateQuestionnaireDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("voter_group_id_duplicate:group_north");
    expect(result.errors).toContain("required_scope_unknown:q1");
  });

  it("accepts one hundred defined voter groups", () => {
    const voterGroups = Array.from({ length: 100 }, (_, index) => ({
      id: `group_${String(index + 1).padStart(3, "0")}`,
      label: `Group ${index + 1}`,
    }));
    expect(validateQuestionnaireDefinition({
      ...buildDefinition(),
      voterGroups,
      questions: [{
        ...buildDefinition().questions[0],
        requiredScope: voterGroups[99].id,
      }],
    }).valid).toBe(true);
  });

  it("allows one or two credentials per voter", () => {
    expect(validateQuestionnaireDefinition({
      ...buildDefinition(),
      credentialsPerVoter: 2,
    }).valid).toBe(true);

    const invalid = validateQuestionnaireDefinition({
      ...buildDefinition(),
      credentialsPerVoter: 3,
    } as QuestionnaireDefinition);

    expect(invalid.valid).toBe(false);
    expect(invalid.errors).toContain("credentials_per_voter_invalid");
  });

  it("accepts organiser-required free-text encryption", () => {
    const definition: QuestionnaireDefinition = {
      ...buildDefinition(),
      questions: buildDefinition().questions.map((question) => (
        question.type === "free_text"
          ? { ...question, encryptResponses: true }
          : question
      )),
    };

    const result = validateQuestionnaireDefinition(definition);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects malformed free-text encryption settings", () => {
    const definition = {
      ...buildDefinition(),
      questions: buildDefinition().questions.map((question) => (
        question.type === "free_text"
          ? { ...question, encryptResponses: "yes" }
          : question
      )),
    } as QuestionnaireDefinition;

    const result = validateQuestionnaireDefinition(definition);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("invalid_free_text_encrypt_responses:q3");
  });

  it("validates per-question ballot slots and allows grouped live slots", () => {
    const definition: QuestionnaireDefinition = {
      ...buildDefinition(),
      ballotCredentialMode: "per_question",
      questions: buildDefinition().questions.map((question, index) => ({
        ...question,
        ballotSlot: {
          slotId: question.questionId,
          slotIndex: index + 1,
          version: 1,
        },
      })),
    };

    expect(validateQuestionnaireDefinition(definition)).toMatchObject({ valid: true });
    expect(normaliseQuestionBallotSlot(definition.questions[0], 0)).toEqual({
      slotId: "q1",
      slotIndex: 1,
      version: 1,
    });
    expect(questionBallotScopeKey(definition.questions[0], 0)).toBe("slot:1:v1");

    const groupedSlot: QuestionnaireDefinition = {
      ...definition,
      questions: definition.questions.map((question, index) => ({
        ...question,
        ballotSlot: {
          slotId: index < 2 ? "shared-slot" : question.questionId,
          slotIndex: index < 2 ? 1 : index + 1,
          version: 1,
        },
      })),
    };
    const result = validateQuestionnaireDefinition(groupedSlot);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(questionBallotScopeKey(groupedSlot.questions[0], 0)).toBe(questionBallotScopeKey(groupedSlot.questions[1], 1));
    expect(questionBallotCredentialScope(groupedSlot.questions[0], 0)).toEqual({
      slotIndex: 1,
      version: 1,
    });
    expect(questionBallotCredentialScope(groupedSlot.questions[1], 1)).toEqual(questionBallotCredentialScope(groupedSlot.questions[0], 0));

    const bumpedSecondSlot: QuestionnaireDefinition = {
      ...groupedSlot,
      questions: groupedSlot.questions.map((question, index) => ({
        ...question,
        ballotSlot: {
          slotId: index < 2 ? "shared-slot" : question.questionId,
          slotIndex: index < 2 ? 1 : index + 1,
          version: index === 1 ? 2 : 1,
        },
      })),
    };
    expect(validateQuestionnaireDefinition(bumpedSecondSlot)).toMatchObject({ valid: true });
    expect(questionBallotScopeKey(bumpedSecondSlot.questions[0], 0)).not.toBe(questionBallotScopeKey(bumpedSecondSlot.questions[1], 1));
  });

  it("normalizes missing response mode to legacy compatibility mode", () => {
    const normalized = normalizeQuestionnaireDefinition({
      ...buildDefinition(),
      responseMode: undefined,
    });
    expect(normalized.responseMode).toBe("legacy_private_envelope");
  });

  it("keeps non-default questionnaire relay hints in metadata", () => {
    const normalized = normalizeQuestionnaireDefinition({
      ...buildDefinition(),
      questionnaireRelays: ["wss://relay.example.com"],
    });
    expect(normalized.questionnaireRelays).toEqual(["wss://relay.example.com"]);
  });

  it("omits default questionnaire relay hints from normalized metadata", () => {
    const normalized = normalizeQuestionnaireDefinition({
      ...buildDefinition(),
      questionnaireRelays: DEFAULT_QUESTIONNAIRE_RELAYS,
    });
    expect(normalized.questionnaireRelays).toBeUndefined();
  });

  it("rejects a malformed questionnaire definition", () => {
    const malformed: QuestionnaireDefinition = {
      ...buildDefinition(),
      openAt: 200,
      closeAt: 100,
      coordinatorPubkey: "",
      questions: [
        {
          questionId: "q1",
          type: "multiple_choice",
          prompt: "Broken",
          required: true,
          multiSelect: false,
          options: [{ optionId: "only", label: "Only one" }],
        },
      ],
    };
    const result = validateQuestionnaireDefinition(malformed);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("coordinator_pubkey_missing");
    expect(result.errors).toContain("invalid_open_close_window");
    expect(result.errors).toContain("multiple_choice_insufficient_options:q1");
  });

  it("validates a matching response payload", () => {
    const payload: QuestionnaireResponsePayload = {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: "course_feedback_2026_term1",
      responseId: "resp_1",
      submittedAt: 1712537200,
      answers: [
        { questionId: "q1", answerType: "yes_no", value: true },
        { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: ["good"] },
      ],
    };
    const result = validateQuestionnaireResponsePayload({
      definition: buildDefinition(),
      payload,
    });
    expect(result.valid).toBe(true);
  });

  it("validates ranked questions and enforces the configured minimum", () => {
    const definition: QuestionnaireDefinition = {
      ...buildDefinition(),
      questions: [
        {
          questionId: "rank1",
          type: "rank",
          prompt: "Rank the next priorities",
          required: true,
          minimumRanked: 2,
          options: [
            { optionId: "mobility", label: "Mobility" },
            { optionId: "water", label: "Water" },
            { optionId: "housing", label: "Housing" },
          ],
        },
      ],
    };

    expect(validateQuestionnaireDefinition(definition)).toMatchObject({ valid: true });

    expect(validateQuestionnaireResponsePayload({
      definition,
      payload: {
        schemaVersion: 1,
        kind: "questionnaire_response_payload",
        questionnaireId: definition.questionnaireId,
        responseId: "resp_rank_valid",
        submittedAt: 1712537200,
        answers: [{ questionId: "rank1", answerType: "rank", rankedOptionIds: ["water", "mobility"] }],
      },
    })).toMatchObject({ valid: true });

    const insufficient = validateQuestionnaireResponsePayload({
      definition,
      payload: {
        schemaVersion: 1,
        kind: "questionnaire_response_payload",
        questionnaireId: definition.questionnaireId,
        responseId: "resp_rank_short",
        submittedAt: 1712537200,
        answers: [{ questionId: "rank1", answerType: "rank", rankedOptionIds: ["water"] }],
      },
    });
    expect(insufficient.valid).toBe(false);
    expect(insufficient.errors).toContain("rank_selection_count:rank1");

    const duplicate = validateQuestionnaireResponsePayload({
      definition,
      payload: {
        schemaVersion: 1,
        kind: "questionnaire_response_payload",
        questionnaireId: definition.questionnaireId,
        responseId: "resp_rank_duplicate",
        submittedAt: 1712537200,
        answers: [{ questionId: "rank1", answerType: "rank", rankedOptionIds: ["water", "water"] }],
      },
    });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors).toContain("duplicate_ranked_option:rank1:water");
  });

  it("classifies response payload shape errors", () => {
    const payload: QuestionnaireResponsePayload = {
      schemaVersion: 1,
      kind: "questionnaire_response_payload",
      questionnaireId: "course_feedback_2026_term1",
      responseId: "resp_2",
      submittedAt: 1712537200,
      answers: [
        { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: ["invalid-option"] },
      ],
    };
    const result = validateQuestionnaireResponsePayload({
      definition: buildDefinition(),
      payload,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("invalid_option_id:q2:invalid-option");
    expect(result.errors).toContain("missing_required_answer:q1");
  });
});

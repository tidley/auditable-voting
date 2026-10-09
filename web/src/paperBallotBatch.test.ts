import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PAPER_BALLOT_BATCH,
  generatePaperBallotBatch,
  generateVoterKeypair,
} from "./paperBallotBatch";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { deriveNpubFromNsec } from "./nostrIdentity";

// The batch generator must survive an individual ballot failing: the
// interesting behaviour is that the rest of the batch is still produced and the
// failure is reported in `errors`.  Wrap the real generator so a single sentinel
// invite code blows up.
const mocks = vi.hoisted(() => ({ failInviteCode: null as string | null }));

vi.mock("./paperBallot", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./paperBallot")>();
  return {
    ...actual,
    generatePaperBallot: (input: Parameters<typeof actual.generatePaperBallot>[0]) => {
      if (mocks.failInviteCode !== null && input.inviteCode === mocks.failInviteCode) {
        throw new Error("simulated ballot failure");
      }
      return actual.generatePaperBallot(input);
    },
  };
});

beforeEach(() => {
  mocks.failInviteCode = null;
});

const minimalDefinition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  responseMode: "blind_token",
  questionnaireId: "q_batch_test",
  title: "Batch Test Election",
  createdAt: 1000,
  openAt: 1000,
  closeAt: 2000,
  coordinatorPubkey: "abc123",
  coordinatorEncryptionPubkey: "def456",
  responseVisibility: "public",
  eligibilityMode: "open",
  allowMultipleResponsesPerPubkey: false,
  questions: [
    { questionId: "q1", type: "yes_no", prompt: "Do you agree?", required: true },
    { questionId: "q2", type: "free_text", prompt: "Comments:", required: false, maxLength: 500 },
  ],
};

const localisedDefinition: QuestionnaireDefinition = {
  ...minimalDefinition,
  questionnaireId: "q_batch_localised",
  title: { en: "Localised Election", fr: "Élection localisée", ta: "மொழிபெயர்ப்பு தேர்தல்" },
  questions: [
    {
      questionId: "q1",
      type: "yes_no",
      prompt: { en: "Do you agree?", fr: "Êtes-vous d'accord ?", ta: "நீங்கள் ஒப்புக்கொள்கிறீர்களா?" },
      required: true,
    },
    {
      questionId: "q2",
      type: "multiple_choice",
      prompt: { en: "Pick one", fr: "Choisissez-en un", ta: "ஒன்றைத் தேர்ந்தெடுக்கவும்" },
      required: true,
      multiSelect: false,
      options: [
        { optionId: "opt_a", label: { en: "Option A", fr: "Option A (FR)", ta: "விருப்பம் அ" } },
        { optionId: "opt_b", label: { en: "Option B", fr: "Option B (FR)", ta: "விருப்பம் ஆ" } },
      ],
    },
  ],
};

describe("generateVoterKeypair", () => {
  it("returns an nsec/npub pair with the expected bech32 prefixes", () => {
    const keypair = generateVoterKeypair();

    expect(keypair.nsec.startsWith("nsec1")).toBe(true);
    expect(keypair.npub.startsWith("npub1")).toBe(true);
  });

  it("derives an npub that matches the generated nsec", () => {
    const keypair = generateVoterKeypair();

    expect(keypair.npub).toBe(deriveNpubFromNsec(keypair.nsec));
  });

  it("returns a fresh keypair on every call", () => {
    const nsecs = new Set(Array.from({ length: 20 }, () => generateVoterKeypair().nsec));

    expect(nsecs.size).toBe(20);
  });
});

describe("generatePaperBallotBatch", () => {
  it("generates paper ballots for a single voter", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 1 });

    expect(result.ballots).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("generates paper ballots for N voters", () => {
    const N = 5;
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: N });

    expect(result.ballots).toHaveLength(N);
    expect(result.errors).toHaveLength(0);
  });

  it("generates unique nsecs for each voter", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 10 });

    const nsecs = result.ballots.map((b) => b.voterNsec);
    const uniqueNsecs = new Set(nsecs);
    expect(uniqueNsecs.size).toBe(10);
  });

  it("generates unique npubs for each voter", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 10 });

    const npubs = result.ballots.map((b) => b.voterNpub);
    const uniqueNpubs = new Set(npubs);
    expect(uniqueNpubs.size).toBe(10);
  });

  it("correctly derives npub from each generated nsec", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 5 });

    for (const ballot of result.ballots) {
      const expectedNpub = deriveNpubFromNsec(ballot.voterNsec);
      expect(ballot.voterNpub).toBe(expectedNpub);
    }
  });

  it("all nsecs start with nsec1 prefix", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 3 });

    for (const ballot of result.ballots) {
      expect(ballot.voterNsec.startsWith("nsec1")).toBe(true);
    }
  });

  it("all npubs start with npub1 prefix", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 3 });

    for (const ballot of result.ballots) {
      expect(ballot.voterNpub.startsWith("npub1")).toBe(true);
    }
  });

  it("each ballot has the correct questionnaire metadata", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 3 });

    for (const ballot of result.ballots) {
      expect(ballot.questionnaireId).toBe("q_batch_test");
      expect(ballot.questionnaireTitle).toBe("Batch Test Election");
      expect(ballot.questions).toHaveLength(2);
    }
  });

  it("each ballot has a valid generatedAt timestamp", () => {
    const before = Date.now();
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 3 });
    const after = Date.now();

    for (const ballot of result.ballots) {
      expect(ballot.generatedAt).toBeGreaterThanOrEqual(before);
      expect(ballot.generatedAt).toBeLessThanOrEqual(after);
    }
  });

  it("includes invite codes when provided", () => {
    const inviteCodes = ["code1", "code2", "code3"];
    const result = generatePaperBallotBatch({
      definition: minimalDefinition,
      voterCount: 3,
      inviteCodes,
    });

    expect(result.ballots).toHaveLength(3);
    result.ballots.forEach((ballot, i) => {
      expect(ballot.inviteCode).toBe(inviteCodes[i]);
    });
  });

  it("omits invite codes when not provided", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 3 });

    for (const ballot of result.ballots) {
      expect(ballot.inviteCode).toBeUndefined();
    }
  });

  it("throws when inviteCodes length does not match voterCount", () => {
    expect(() =>
      generatePaperBallotBatch({
        definition: minimalDefinition,
        voterCount: 3,
        inviteCodes: ["only_one"],
      }),
    ).toThrow(/inviteCodes.*voterCount/);
  });

  it("throws when voterCount is zero", () => {
    expect(() =>
      generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 0 }),
    ).toThrow(/voterCount.*positive/);
  });

  it("throws when voterCount is negative", () => {
    expect(() =>
      generatePaperBallotBatch({ definition: minimalDefinition, voterCount: -1 }),
    ).toThrow(/voterCount.*positive/);
  });

  it("throws when voterCount is not a whole number", () => {
    expect(() =>
      generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 1.5 }),
    ).toThrow(/voterCount.*positive/);
  });

  it("throws when voterCount exceeds the batch cap", () => {
    expect(() =>
      generatePaperBallotBatch({
        definition: minimalDefinition,
        voterCount: MAX_PAPER_BALLOT_BATCH + 1,
      }),
    ).toThrow(new RegExp(`voterCount.*${MAX_PAPER_BALLOT_BATCH}`));
  });

  it("returns voter keypairs alongside ballots", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 3 });

    expect(result.keypairs).toHaveLength(3);
    result.keypairs.forEach((kp, i) => {
      expect(kp.nsec).toBe(result.ballots[i].voterNsec);
      expect(kp.npub).toBe(result.ballots[i].voterNpub);
    });
  });

  it("handles multiple choice questions correctly in batch", () => {
    const mcDefinition: QuestionnaireDefinition = {
      ...minimalDefinition,
      questionnaireId: "q_mc_batch",
      title: "MC Batch",
      questions: [
        {
          questionId: "q1",
          type: "multiple_choice",
          prompt: "Choose one:",
          required: true,
          multiSelect: false,
          options: [
            { optionId: "opt_a", label: "Option A" },
            { optionId: "opt_b", label: "Option B" },
          ],
        },
      ],
    };

    const result = generatePaperBallotBatch({ definition: mcDefinition, voterCount: 3 });

    for (const ballot of result.ballots) {
      expect(ballot.questions[0].type).toBe("multiple_choice");
      expect(ballot.questions[0].options).toHaveLength(2);
      expect(ballot.questions[0].options?.[0].label).toBe("Option A");
    }
  });

  it("generates large batch without errors", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 50 });

    expect(result.ballots).toHaveLength(50);
    expect(result.errors).toHaveLength(0);

    // Verify all unique
    const nsecs = result.ballots.map((b) => b.voterNsec);
    expect(new Set(nsecs).size).toBe(50);
  });

  it("echoes voter labels aligned with the generated ballots", () => {
    const voterLabels = ["alice", "bob", "carol"];
    const result = generatePaperBallotBatch({
      definition: minimalDefinition,
      voterCount: 3,
      voterLabels,
    });

    expect(result.labels).toEqual(voterLabels);
  });

  it("omits labels when they are not supplied", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 2 });

    expect(result.labels).toEqual([undefined, undefined]);
  });

  it("throws when voterLabels length does not match voterCount", () => {
    expect(() =>
      generatePaperBallotBatch({
        definition: minimalDefinition,
        voterCount: 3,
        voterLabels: ["only_one"],
      }),
    ).toThrow(/voterLabels.*voterCount/);
  });

  it("collects an error for a failing ballot and still generates the rest", () => {
    mocks.failInviteCode = "boom";

    const result = generatePaperBallotBatch({
      definition: minimalDefinition,
      voterCount: 3,
      inviteCodes: ["ok1", "boom", "ok2"],
    });

    expect(result.ballots).toHaveLength(2);
    expect(result.keypairs).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Voter 2");
    expect(result.errors[0]).toContain("simulated ballot failure");
  });

  it("reports the locale used for the batch", () => {
    const result = generatePaperBallotBatch({ definition: minimalDefinition, voterCount: 1 });

    expect(result.locale).toBe("en");
  });
});

describe("generatePaperBallotBatch localisation", () => {
  it("resolves a localised title and prompt into English by default", () => {
    const result = generatePaperBallotBatch({ definition: localisedDefinition, voterCount: 1 });

    expect(result.ballots[0].questionnaireTitle).toBe("Localised Election");
    expect(result.ballots[0].questions[0].prompt).toBe("Do you agree?");
  });

  it("prints ballots in the requested locale", () => {
    const result = generatePaperBallotBatch({
      definition: localisedDefinition,
      voterCount: 2,
      locale: "fr",
    });

    expect(result.locale).toBe("fr");
    for (const ballot of result.ballots) {
      expect(ballot.questionnaireTitle).toBe("Élection localisée");
      expect(ballot.questions[0].prompt).toBe("Êtes-vous d'accord ?");
      expect(ballot.questions[1].prompt).toBe("Choisissez-en un");
      expect(ballot.questions[1].options?.[0].label).toBe("Option A (FR)");
    }
  });

  it("prints ballots in Tamil when Tamil is requested", () => {
    const result = generatePaperBallotBatch({
      definition: localisedDefinition,
      voterCount: 1,
      locale: "ta",
    });

    expect(result.ballots[0].questionnaireTitle).toBe("மொழிபெயர்ப்பு தேர்தல்");
    expect(result.ballots[0].questions[0].prompt).toBe("நீங்கள் ஒப்புக்கொள்கிறீர்களா?");
    expect(result.ballots[0].questions[1].options?.[1].label).toBe("விருப்பம் ஆ");
  });

  it("falls back to English for locales a definition does not provide", () => {
    const englishOnly: QuestionnaireDefinition = {
      ...minimalDefinition,
      title: { en: "English Only" },
      questions: [
        { questionId: "q1", type: "yes_no", prompt: { en: "Agree?" }, required: true },
      ],
    };

    const result = generatePaperBallotBatch({
      definition: englishOnly,
      voterCount: 1,
      locale: "fr",
    });

    expect(result.ballots[0].questionnaireTitle).toBe("English Only");
    expect(result.ballots[0].questions[0].prompt).toBe("Agree?");
  });
});

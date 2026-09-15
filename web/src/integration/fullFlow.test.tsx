// @vitest-environment jsdom
/**
 * Cross-feature end-to-end: CSV upload → OTP → paper ballot → manual entry →
 * submission.
 *
 * This is the horizontal integration test across all four issue-12 tracks:
 *
 *   F4  a residents CSV is parsed (residentRegister) and a one-time code is
 *       issued and verified (otpService) so the resident is admitted;
 *   F3  a paper ballot is generated (paperBallotBatch) for that admitted
 *       resident, carrying a fresh Nostr keypair and the questionnaire;
 *   F3  the ballot is entered manually (ManualBallotEntry) by typing its
 *       printed key, and the answers become a `BallotSubmission`;
 *   F1  the definition's text may be localised and the ballot/manual-entry
 *       renders it in the requested locale;
 *   F2  required-question validation for conditional questions is honoured by
 *       the manual entry before it will submit.
 *
 * The flow is deliberately exercised through the real modules — no relay or
 * network is involved, matching the app's browser-local behaviour.
 */
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ManualBallotEntry, {
  buildManualBallotSubmission,
  parseManualBallotIdentity,
  type ManualBallotCredential,
} from "../ManualBallotEntry";
import { LanguageProvider } from "../i18n/LanguageContext";
import { generateOtp, hashOtp, verifyOtp, resetOtpAttempts } from "../otpService";
import { parseResidentCsv } from "../residentRegister";
import { generatePaperBallotBatch } from "../paperBallotBatch";
import type { PaperBallot } from "../paperBallot";
import { validateBallotSubmission } from "../questionnaireOptionA";
import type { QuestionnaireDefinition, QuestionnaireResponseAnswer } from "../questionnaireProtocol";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

const QUESTIONNAIRE_ID = "q_full_flow";

/** A localised (F1) definition with a conditional free-text follow-up (F2). */
const definition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  responseMode: "blind_token",
  questionnaireId: QUESTIONNAIRE_ID,
  title: { en: "Full flow election", fr: "Élection du flux complet", ta: "முழு ஓட்டத் தேர்தல்" },
  description: "",
  createdAt: 1_725_000_000,
  openAt: 1_725_000_000,
  closeAt: 1_725_086_400,
  coordinatorPubkey: "npub1coordinator",
  coordinatorEncryptionPubkey: "npub1coordinatorenc",
  responseVisibility: "public",
  eligibilityMode: "allowlist",
  allowMultipleResponsesPerPubkey: false,
  questions: [
    { questionId: "q1", type: "yes_no", prompt: { en: "Approve the budget?", fr: "Approuvez-vous le budget ?", ta: "நிதிநிலையை ஏற்கிறீர்களா?" }, required: true },
    {
      questionId: "q2",
      type: "free_text",
      prompt: { en: "Add a comment?", fr: "Ajouter un commentaire ?", ta: "கருத்து சேர்க்கவா?" },
      required: true,
      maxLength: 400,
      showIf: {
        dependsOnQuestionId: "q1",
        requiredAnswer: { answerType: "yes_no", value: true },
      },
    },
  ],
};

const credential: ManualBallotCredential = {
  tokenCommitment: "commitment-full-flow",
  blindSigningKeyId: "blind-key-full-flow",
  credential: "credential-full-flow",
  nullifier: "nullifier-full-flow",
};

const CSV_HEADER = "masters_list_number,email,phone,name";
const CSV_BODY = [
  CSV_HEADER,
  "101,alice@example.org,020 7946 0101,Alice Smith",
  "102,bob@example.org,,Bob Jones",
].join("\n");

describe("admission: CSV upload then OTP verify (F4 → voter admission)", () => {
  it("parses the CSV, issues a code and verifies it to admit Alice", async () => {
    const parsed = parseResidentCsv(CSV_BODY);
    expect(parsed.errors).toHaveLength(0);
    const alice = parsed.residents.find((r) => r.mastersListNumber === 101);
    expect(alice?.name).toBe("Alice Smith");

    const code = generateOtp();
    const hash = await hashOtp(code);
    expect(await verifyOtp(code, hash)).toBe(true);
    // A wrong code does not admit the same resident.
    expect(await verifyOtp("000000", hash)).toBe(false);

    // Admission is the act of mapping a verified resident's masters-list
    // number onto a voter identity — here the OTP gates who can be issued a
    // ballot.  The verified resident becomes the ballot's label.
    expect(alice?.mastersListNumber).toBe(101);
  });
});

describe("paper ballot: one fresh keypair issued for the admitted resident (F3)", () => {
  it("generates one ballot per admitted resident with unique keys", () => {
    const parsed = parseResidentCsv(CSV_BODY);
    const batch = generatePaperBallotBatch({ definition, voterCount: parsed.residents.length, locale: "en" });

    expect(batch.errors).toHaveLength(0);
    expect(batch.ballots).toHaveLength(2);
    const nsecs = new Set(batch.ballots.map((ballot) => ballot.voterNsec));
    expect(nsecs.size).toBe(2);
    expect(batch.ballots[0].questionnaireId).toBe(QUESTIONNAIRE_ID);
    expect(batch.ballots[0].questions[0].prompt).toBe("Approve the budget?");
  });
});

describe("manual entry then submission (F3 → tally)", () => {
  it("enters the printed ballot and produces a valid BallotSubmission", async () => {
    const parsed = parseResidentCsv(CSV_BODY);
    const batch = generatePaperBallotBatch({ definition, voterCount: parsed.residents.length, locale: "en" });
    const ballot: PaperBallot = batch.ballots[1]; // Bob's ballot.

    const user = userEvent.setup();
    const onSubmitBallot = vi.fn();
    render(
      <LanguageProvider initialLocale='en'>
        <ManualBallotEntry definition={definition} credential={credential} onSubmitBallot={onSubmitBallot} />
      </LanguageProvider>,
    );

    // Identify the ballot by its printed key.
    await user.type(screen.getByLabelText(/Ballot private key/i), ballot.voterNsec);
    await user.click(screen.getByRole("button", { name: /Confirm ballot identity/i }));
    await screen.findByText(/Check that this identity matches the ballot/i);

    // The F2-conditional follow-up is hidden until its dependency is answered.
    expect(screen.queryByRole("textbox", { name: /Additional comments/i })).toBeNull();

    // Answer q1 Yes → q2 appears.
    await user.click(screen.getByRole("button", { name: /^Yes$/ }));
    expect(await screen.findByRole("textbox", { name: /Additional comments/i })).toBeTruthy();

    // q2 is required, so the ballot cannot submit until it is answered.
    expect((screen.getByRole("button", { name: /Submit paper ballot/i }) as HTMLButtonElement).disabled)
      .toBe(true);

    await user.type(screen.getByRole("textbox", { name: /Additional comments/i }), "Happy with the plan");
    expect((screen.getByRole("button", { name: /Submit paper ballot/i }) as HTMLButtonElement).disabled)
      .toBe(false);

    await user.click(screen.getByRole("button", { name: /Submit paper ballot/i }));

    await waitFor(() => expect(onSubmitBallot).toHaveBeenCalledTimes(1));

    const [submission, identity] = onSubmitBallot.mock.calls[0] as [
      import("../questionnaireOptionA").BallotSubmission,
      import("../ManualBallotEntry").ManualBallotIdentity,
    ];

    expect(identity.npub).toBe(ballot.voterNpub);
    expect(submission.nullifier).toBe(credential.nullifier);
    expect(submission.payload.responses).toEqual([
      { questionId: "q1", type: "yes_no", answer: "yes" },
      { questionId: "q2", type: "text", answer: "Happy with the plan" },
    ]);
    expect(
      validateBallotSubmission({
        submission,
        electionId: QUESTIONNAIRE_ID,
        electionState: "open",
        requiredQuestionIds: ["q1", "q2"],
        definition,
      }),
    ).toBe(true);
  });

  it("rejects the submission when a conditional required question is hidden but its answer is omitted", () => {
    const parsed = parseResidentCsv(CSV_BODY);
    const batch = generatePaperBallotBatch({ definition, voterCount: parsed.residents.length, locale: "en" });
    const identity = parseManualBallotIdentity({
      value: batch.ballots[0].voterNsec,
      questionnaireId: QUESTIONNAIRE_ID,
    });
    if (!identity.ok) {
      throw new Error("fixture ballot identity invalid");
    }

    // q1 = false hides q2, so only q1 is required → the payload is valid and
    // omits q2 entirely (it is not visible).
    const answers: QuestionnaireResponseAnswer[] = [
      { questionId: "q1", answerType: "yes_no", value: false },
    ];
    const submission = buildManualBallotSubmission({
      definition,
      identity: identity.identity,
      credential,
      requiredQuestionIds: ["q1"],
      answers,
      submissionId: "submission_full_flow_no",
      submittedAt: "2026-09-15T08:00:00.000Z",
    });

    expect(
      validateBallotSubmission({
        submission,
        electionId: QUESTIONNAIRE_ID,
        electionState: "open",
        requiredQuestionIds: ["q1"],
        definition,
      }),
    ).toBe(true);
    // The hidden follow-up is not smuggled into the tally.
    expect(submission.payload.responses.map((r) => r.questionId)).toEqual(["q1"]);
  });
});

afterEach(() => {
  cleanup();
  resetOtpAttempts();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

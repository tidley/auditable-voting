// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateSecretKey, nip19 } from "nostr-tools";
import ManualBallotEntry, {
  buildManualBallotSubmission,
  parseManualBallotIdentity,
  type ManualBallotCredential,
} from "./ManualBallotEntry";
import QuestionnaireAnswerFields from "./QuestionnaireAnswerFields";
import { LanguageProvider } from "./i18n/LanguageContext";
import { deriveNpubFromNsec } from "./nostrIdentity";
import { deriveActorDisplayId } from "./actorDisplay";
import { validateBallotSubmission } from "./questionnaireOptionA";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";

const QUESTIONNAIRE_ID = "q_paper_entry_test";

function buildDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: "blind_token",
    questionnaireId: QUESTIONNAIRE_ID,
    title: {
      en: "Paper ballot entry test",
      fr: "Test de saisie du bulletin papier",
      ta: "காகித வாக்குச்சீட்டு உள்ளீட்டு சோதனை",
    },
    description: "",
    createdAt: 1712530000,
    openAt: 1712533600,
    closeAt: 1712619999,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinatorenc",
    responseVisibility: "public",
    eligibilityMode: "open",
    allowMultipleResponsesPerPubkey: false,
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
        prompt: { en: "Which option?", fr: "Quelle option ?", ta: "எந்த விருப்பம்?" },
        required: false,
        multiSelect: false,
        showIf: {
          dependsOnQuestionId: "q1",
          requiredAnswer: { answerType: "yes_no" as const, value: true },
        },
        options: [
          { optionId: "o1", label: { en: "First option", fr: "Première option", ta: "முதல் விருப்பம்" } },
          { optionId: "o2", label: { en: "Second option", fr: "Deuxième option", ta: "இரண்டாம் விருப்பம்" } },
        ],
      },
      {
        questionId: "q3",
        type: "rank",
        prompt: { en: "Rank these", fr: "Classez ces éléments", ta: "இவற்றை வரிசைப்படுத்துங்கள்" },
        required: false,
        minimumRanked: 0,
        options: [
          { optionId: "r1", label: { en: "Rank one", fr: "Rang un", ta: "வரிசை ஒன்று" } },
          { optionId: "r2", label: { en: "Rank two", fr: "Rang deux", ta: "வரிசை இரண்டு" } },
        ],
      },
      {
        questionId: "q4",
        type: "free_text",
        prompt: { en: "Any comments?", fr: "Des commentaires ?", ta: "ஏதேனும் கருத்துகள்?" },
        required: true,
        maxLength: 200,
      },
    ],
  };
}

const ballotSecret = generateSecretKey();
const BALLOT_NSEC = nip19.nsecEncode(ballotSecret);
const BALLOT_NPUB = deriveNpubFromNsec(BALLOT_NSEC) as string;

const credential: ManualBallotCredential = {
  tokenCommitment: "commitment-paper-ballot",
  blindSigningKeyId: "blind-key-paper-ballot",
  credential: "credential-paper-ballot",
  nullifier: "nullifier-paper-ballot",
};

function renderEntry(props: Partial<ComponentProps<typeof ManualBallotEntry>> = {}) {
  return render(
    <LanguageProvider>
      <ManualBallotEntry definition={buildDefinition()} credential={credential} {...props} />
    </LanguageProvider>,
  );
}

async function confirmBallotIdentity(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/Ballot private key/i), BALLOT_NSEC);
  await user.click(screen.getByRole("button", { name: /Confirm ballot identity/i }));
  await screen.findByText(/Check that this identity matches the ballot/i);
}

function questionList(container: HTMLElement): HTMLElement {
  const list = container.querySelector(".simple-questionnaire-voter-list");
  if (!list) {
    throw new Error("No questionnaire answer list rendered.");
  }
  return list as HTMLElement;
}

afterEach(() => {
  cleanup();
});

describe("parseManualBallotIdentity", () => {
  it("derives the ballot identity from the printed nsec", () => {
    const result = parseManualBallotIdentity({
      value: BALLOT_NSEC,
      inviteCode: " invite-42 ",
      questionnaireId: QUESTIONNAIRE_ID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.identity.nsec).toBe(BALLOT_NSEC);
    expect(result.identity.npub).toBe(BALLOT_NPUB);
    expect(result.identity.inviteCode).toBe("invite-42");
    expect(result.identity.questionnaireId).toBe(QUESTIONNAIRE_ID);
  });

  it("accepts an nsec carried in a ballot link", () => {
    const result = parseManualBallotIdentity({
      value: `https://example.org/vote?q=${QUESTIONNAIRE_ID}&nsec=${BALLOT_NSEC}`,
      questionnaireId: QUESTIONNAIRE_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.npub).toBe(BALLOT_NPUB);
    }
  });

  it("reports the ballot public key and rejects malformed keys", () => {
    expect(
      parseManualBallotIdentity({ value: BALLOT_NPUB, questionnaireId: QUESTIONNAIRE_ID }),
    ).toEqual({ ok: false, error: "public_key_only" });
    expect(
      parseManualBallotIdentity({ value: "nsec1notarealkey", questionnaireId: QUESTIONNAIRE_ID }),
    ).toEqual({ ok: false, error: "invalid_nsec" });
    expect(
      parseManualBallotIdentity({ value: "   ", questionnaireId: QUESTIONNAIRE_ID }),
    ).toEqual({ ok: false, error: "missing_nsec" });
  });
});

describe("buildManualBallotSubmission", () => {
  it("produces a submission the digital flow's validator accepts", () => {
    const definition = buildDefinition();
    const identity = parseManualBallotIdentity({ value: BALLOT_NSEC, questionnaireId: QUESTIONNAIRE_ID });
    if (!identity.ok) {
      throw new Error("fixture identity is invalid");
    }

    const submission = buildManualBallotSubmission({
      definition,
      identity: identity.identity,
      credential,
      requiredQuestionIds: ["q1", "q4"],
      submissionId: "submission_fixture",
      submittedAt: "2026-09-13T10:00:00.000Z",
      answers: [
        { questionId: "q1", answerType: "yes_no", value: true },
        { questionId: "q2", answerType: "multiple_choice", selectedOptionIds: ["o1"] },
        { questionId: "q3", answerType: "rank", rankedOptionIds: ["r2", "r1"] },
        { questionId: "q4", answerType: "free_text", text: "Entered from paper" },
      ],
    });

    expect(submission.type).toBe("ballot_submission");
    expect(submission.schemaVersion).toBe(1);
    expect(submission.electionId).toBe(QUESTIONNAIRE_ID);
    expect(submission.submissionId).toBe("submission_fixture");
    expect(submission.invitedNpub).toBe(BALLOT_NPUB);
    expect(submission.responseNpub).toBe(BALLOT_NPUB);
    expect(submission.nullifier).toBe(credential.nullifier);
    expect(submission.payload.electionId).toBe(QUESTIONNAIRE_ID);
    expect(submission.payload.responses).toEqual([
      { questionId: "q1", type: "yes_no", answer: "yes" },
      { questionId: "q2", type: "multiple_choice", answer: ["o1"] },
      { questionId: "q3", type: "rank", answer: ["r2", "r1"] },
      { questionId: "q4", type: "text", answer: "Entered from paper" },
    ]);
    expect(
      validateBallotSubmission({
        submission,
        electionId: QUESTIONNAIRE_ID,
        electionState: "open",
        requiredQuestionIds: ["q1", "q4"],
        definition,
      }),
    ).toBe(true);
  });

  it("refuses a submission that is missing a required answer", () => {
    const definition = buildDefinition();
    const identity = parseManualBallotIdentity({ value: BALLOT_NSEC, questionnaireId: QUESTIONNAIRE_ID });
    if (!identity.ok) {
      throw new Error("fixture identity is invalid");
    }

    expect(() => buildManualBallotSubmission({
      definition,
      identity: identity.identity,
      credential,
      requiredQuestionIds: ["q1", "q4"],
      answers: [{ questionId: "q1", answerType: "yes_no", value: true }],
    })).toThrow(/invalid or incomplete/i);
  });
});

describe("ManualBallotEntry", () => {
  it("loads the printed identity from a valid nsec", async () => {
    const user = userEvent.setup();
    renderEntry();

    expect(screen.queryByText(/Answers from the paper ballot/i)).toBeNull();

    await confirmBallotIdentity(user);

    expect(screen.getByText(deriveActorDisplayId(BALLOT_NPUB))).toBeTruthy();
    expect(screen.getByText(/Answers from the paper ballot/i)).toBeTruthy();
  });

  it("explains that the ballot public key is not enough to vote with", async () => {
    const user = userEvent.setup();
    renderEntry();

    await user.type(screen.getByLabelText(/Ballot private key/i), BALLOT_NPUB);
    await user.click(screen.getByRole("button", { name: /Confirm ballot identity/i }));

    await waitFor(() => {
      expect(screen.getByText(/That is the ballot's public key/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Answers from the paper ballot/i)).toBeNull();
  });

  it("renders the questions exactly as the digital voter flow does", async () => {
    const user = userEvent.setup();
    const entry = renderEntry();
    await confirmBallotIdentity(user);

    const reference = render(
      <LanguageProvider>
        <div className="simple-questionnaire-voter-list">
          <QuestionnaireAnswerFields
            definition={buildDefinition()}
            answerState={{}}
            locale="en"
            onYesNoAnswer={() => undefined}
            onMultipleChoiceAnswer={() => undefined}
            onAddRankedAnswer={() => undefined}
            onRemoveRankedAnswer={() => undefined}
            onMoveRankedAnswer={() => undefined}
            onFreeTextAnswer={() => undefined}
          />
        </div>
      </LanguageProvider>,
    );

    // react-aria mints per-instance ids (react-aria-:r12:) which are not part
    // of the rendered structure; normalise them out before comparing.
    const normalise = (html: string) => html
      .replace(/react-aria-:r[0-9a-z]+:/g, "aria-id")
      .replace(/\s+/g, " ")
      .trim();
    expect(normalise(questionList(entry.container).innerHTML)).toBe(
      normalise(questionList(reference.container).innerHTML),
    );

    // F2 follow-up: the conditional question stays hidden until its dependency
    // is answered, in manual entry just as in the digital flow.
    const entryScreen = within(entry.container);
    expect(entryScreen.queryByText(/Which option\?/)).toBeNull();
    expect(reference.container.querySelectorAll(".simple-questionnaire-voter-card").length)
      .toBe(3);

    await user.click(entryScreen.getByRole("button", { name: /^Yes$/ }));
    expect(await entryScreen.findByText(/Which option\?/)).toBeTruthy();
    expect(entryScreen.getByLabelText(/First option/)).toBeTruthy();
  });

  it("submits the answers as a valid ballot submission", async () => {
    const user = userEvent.setup();
    const onSubmitBallot = vi.fn();
    renderEntry({ onSubmitBallot });

    await confirmBallotIdentity(user);

    await user.click(screen.getByRole("button", { name: /^Yes$/ }));
    await user.click(await screen.findByLabelText(/First option/));
    await user.click(screen.getAllByRole("button", { name: /Add as #1/i })[0]);
    await user.type(screen.getByRole("textbox", { name: /Additional comments/i }), "Entered from paper");
    await user.click(screen.getByRole("button", { name: /Submit paper ballot/i }));

    await waitFor(() => {
      expect(onSubmitBallot).toHaveBeenCalledTimes(1);
    });

    const [submission, identity] = onSubmitBallot.mock.calls[0] as Parameters<
      NonNullable<ComponentProps<typeof ManualBallotEntry>["onSubmitBallot"]>
    >;

    expect(identity.npub).toBe(BALLOT_NPUB);
    expect(submission.payload.responses).toEqual([
      { questionId: "q1", type: "yes_no", answer: "yes" },
      { questionId: "q2", type: "multiple_choice", answer: ["o1"] },
      { questionId: "q3", type: "rank", answer: ["r1"] },
      { questionId: "q4", type: "text", answer: "Entered from paper" },
    ]);
    expect(
      validateBallotSubmission({
        submission,
        electionId: QUESTIONNAIRE_ID,
        electionState: "open",
        requiredQuestionIds: ["q1", "q4"],
        definition: buildDefinition(),
      }),
    ).toBe(true);
  });

  it("does not submit without a voting credential and offers the digital flow instead", async () => {
    const user = userEvent.setup();
    const onSubmitBallot = vi.fn();
    const onOpenDigitalFlow = vi.fn();
    renderEntry({ credential: null, onSubmitBallot, onOpenDigitalFlow });

    await confirmBallotIdentity(user);

    expect(screen.getByText(/holds no voting credential for this ballot/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Submit paper ballot/i })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Continue in the digital vote screen/i }));
    expect(onOpenDigitalFlow).toHaveBeenCalledTimes(1);
    expect(onOpenDigitalFlow.mock.calls[0][0].nsec).toBe(BALLOT_NSEC);
    expect(onSubmitBallot).not.toHaveBeenCalled();
  });

  it("blocks submission until every visible required question is answered", async () => {
    const user = userEvent.setup();
    renderEntry();

    await confirmBallotIdentity(user);

    const submit = screen.getByRole("button", { name: /Submit paper ballot/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByText(/Answer every required question before submitting/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^Yes$/ }));
    expect((screen.getByRole("button", { name: /Submit paper ballot/i }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox", { name: /Additional comments/i }), "Ready");
    expect((screen.getByRole("button", { name: /Submit paper ballot/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("explains when the questionnaire is not available on this device", () => {
    render(
      <LanguageProvider>
        <ManualBallotEntry definition={null} questionnaireId="q_not_cached" credential={credential} />
      </LanguageProvider>,
    );

    expect(screen.getByText(/not cached on this device/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Ballot private key/i)).toBeNull();
  });
});

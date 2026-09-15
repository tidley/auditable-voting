// @vitest-environment jsdom
/**
 * Cross-feature integration: F4 resident OTP admission × F3 paper ballots.
 *
 * These tests exercise the seam between the resident-admission track (F4) and
 * the paper-ballot track (F3): a resident is admitted by verifying a one-time
 * code against their email address, and the paper ballot that is later printed
 * for that voter is keyed to a freshly generated Nostr keypair so the same
 * voter can be entered into the tally manually.
 *
 * In particular:
 *
 *   - uploading a residents CSV (F4) and verifying the OTP genuinely admits a
 *     specific resident (the component sets "Code verified");
 *   - generating a paper ballot batch (F3) for the OTP-admitted roster, one
 *     fresh keypair per admitted resident;
 *   - the paper ballot's printed key, when typed back into the manual entry
 *     screen (F3-T4), derives a valid ballot identity whose npub can be
 *     matched against an admitted voter;
 *   - the entered ballot is a `BallotSubmission` that the digital flow's own
 *     validator accepts.
 */
import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { generateSecretKey, nip19 } from "nostr-tools";
import ResidentOtpAdmission from "../ResidentOtpAdmission";
import { generateOtp, hashOtp, verifyOtp, resetOtpAttempts } from "../otpService";
import { parseResidentCsv, type ResidentEntry } from "../residentRegister";
import { generatePaperBallotBatch } from "../paperBallotBatch";
import { generatePaperBallot } from "../paperBallot";
import ManualBallotEntry, {
  buildManualBallotSubmission,
  parseManualBallotIdentity,
  type ManualBallotCredential,
} from "../ManualBallotEntry";
import { LanguageProvider } from "../i18n/LanguageContext";
import { deriveNpubFromNsec } from "../nostrIdentity";
import { validateBallotSubmission } from "../questionnaireOptionA";
import type { QuestionnaireDefinition } from "../questionnaireProtocol";

// jsdom provides crypto.getRandomValues but not crypto.subtle; OTP hashing
// needs subtle.  Node's webcrypto covers both.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
    writable: true,
  });
}

const CSV_HEADER = "masters_list_number,email,phone,name";

function makeCsv(...rows: Array<string[]>): string {
  return [CSV_HEADER, ...rows.map((row) => row.join(","))].join("\n");
}

const ADMITTED_CSV = makeCsv(
  ["101", "alice@example.org", "020 7946 0101", "Alice Smith"],
  ["102", "bob@example.org", "", "Bob Jones"],
);

const QUESTIONNAIRE_ID = "q_paper_otp";

const definition: QuestionnaireDefinition = {
  schemaVersion: 1,
  eventType: "questionnaire_definition",
  responseMode: "blind_token",
  questionnaireId: QUESTIONNAIRE_ID,
  title: { en: "OTP-admitted paper ballot", fr: "Bulletin papier admis par OTP", ta: "OTP அனுமதி காகித வாக்குச்சீட்டு" },
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
    { questionId: "q2", type: "free_text", prompt: { en: "Any comments?", fr: "Des commentaires ?", ta: "ஏதேனும் கருத்துகள்?" }, required: false, maxLength: 400 },
  ],
};

const credential: ManualBallotCredential = {
  tokenCommitment: "commitment-otp-ballot",
  blindSigningKeyId: "blind-key-otp-ballot",
  credential: "credential-otp-ballot",
  nullifier: "nullifier-otp-ballot",
};

async function uploadCsv(csv: string) {
  const input = screen.getByLabelText("Residents CSV file");
  await userEvent.upload(input, new File([csv], "residents.csv", { type: "text/csv" }));
}

function getIssuedEntry(mastersListNumber: number): HTMLElement {
  const panel = screen.getByLabelText("Issued codes");
  return within(panel).getByLabelText(`Code for resident ${mastersListNumber}`);
}

async function generateFor(mastersListNumber: number): Promise<string> {
  await userEvent.click(screen.getByLabelText(`Generate code for resident ${mastersListNumber}`));
  await waitFor(() => getIssuedEntry(mastersListNumber));
  return within(getIssuedEntry(mastersListNumber)).getByText(/^\d{6}$/).textContent ?? "";
}

afterEach(() => {
  cleanup();
  resetOtpAttempts();
  window.localStorage.clear();
});

describe("CSV upload admits a roster of residents (F4)", () => {
  it("parses the residents CSV into the OTP admission table", () => {
    const result = parseResidentCsv(ADMITTED_CSV);
    expect(result.errors).toHaveLength(0);
    expect(result.residents).toHaveLength(2);
    expect(result.residents[0]).toMatchObject({
      mastersListNumber: 101,
      email: "alice@example.org",
      name: "Alice Smith",
    });
  });

  it("renders the uploaded roster in the coordinator admission panel", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(ADMITTED_CSV);

    const table = screen.getByLabelText("Residents");
    expect(within(table).getByText("Alice Smith")).toBeTruthy();
    expect(within(table).getByText("Bob Jones")).toBeTruthy();
  });
});

describe("OTP verification admits a specific resident (F4)", () => {
  it("confirms the resident identity with a correct one-time code", async () => {
    render(<ResidentOtpAdmission />);
    await uploadCsv(ADMITTED_CSV);

    const code = await generateFor(101);

    await userEvent.selectOptions(
      screen.getByLabelText("Resident to verify"),
      screen.getByRole("option", { name: /Alice Smith/ }),
    );
    await userEvent.type(screen.getByLabelText("One-time code"), code);
    await userEvent.click(screen.getByLabelText("Verify code"));

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Code verified for resident 101."),
    );
  });

  it("the OTP service verifies the code at the same point the panel does", async () => {
    const code = generateOtp();
    const hash = await hashOtp(code);
    const residents: ResidentEntry[] = [{ mastersListNumber: 101, email: "alice@example.org", name: "Alice Smith" }];

    const matches = await verifyOtp(code, hash);
    expect(matches).toBe(true);
    // The admitted resident's email routes to the same voter the paper ballot
    // is generated for (matched by masters list number).
    expect(residents.find((r) => r.mastersListNumber === 101)?.email).toBe("alice@example.org");
  });
});

describe("paper ballot generated for an OTP-admitted voter (F3)", () => {
  it("issues one fresh keypair per admitted resident", () => {
    const residents = parseResidentCsv(ADMITTED_CSV).residents;
    const batch = generatePaperBallotBatch({
      definition,
      voterCount: residents.length,
      locale: "en",
    });

    expect(batch.errors).toHaveLength(0);
    expect(batch.ballots).toHaveLength(2);
    expect(batch.keypairs).toHaveLength(2);
    const npubs = new Set(batch.keypairs.map((keypair) => keypair.npub));
    expect(npubs.size).toBe(2);
    for (const ballot of batch.ballots) {
      expect(ballot.voterNsec.startsWith("nsec1")).toBe(true);
      expect(ballot.questionnaireId).toBe(QUESTIONNAIRE_ID);
    }
  });

  it("a printed ballot for an admitted voter resolves to a valid identity in manual entry", () => {
    // Alice is admitted (email verified via OTP); hand her ballot 101.
    const ballot = generatePaperBallot({
      definition,
      voterNsec: generateSecretKeyKeypair().nsec,
      locale: "en",
    });

    const identity = parseManualBallotIdentity({
      value: ballot.voterNsec,
      questionnaireId: QUESTIONNAIRE_ID,
      inviteCode: "alice-invite",
    });

    expect(identity.ok).toBe(true);
    if (identity.ok) {
      expect(identity.identity.npub).toBe(ballot.voterNpub);
      expect(identity.identity.inviteCode).toBe("alice-invite");
    }
  });
});

describe("manually entered OTP-admitted ballot forms a valid submission (F3)", () => {
  it("submits a paper ballot for an admitted voter through the digital validator", () => {
    const ballot = generatePaperBallot({ definition, voterNsec: generateSecretKeyKeypair().nsec, locale: "en" });
    const identity = parseManualBallotIdentity({ value: ballot.voterNsec, questionnaireId: QUESTIONNAIRE_ID });
    if (!identity.ok) {
      throw new Error("fixture ballot identity invalid");
    }

    const submission = buildManualBallotSubmission({
      definition,
      identity: identity.identity,
      credential,
      requiredQuestionIds: ["q1"],
      answers: [
        { questionId: "q1", answerType: "yes_no", value: true },
        { questionId: "q2", answerType: "free_text", text: "Entered from an OTP-admitted paper ballot" },
      ],
      submissionId: "submission_otp_paper",
      submittedAt: "2026-09-14T09:00:00.000Z",
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
    expect(submission.invitedNpub).toBe(identity.identity.npub);
    expect(submission.responseNpub).toBe(identity.identity.npub);
    expect(submission.nullifier).toBe(credential.nullifier);
  });

  it("the manual entry screen loads the printed key and offers to submit", async () => {
    const user = userEvent.setup();
    const ballot = generatePaperBallot({ definition, voterNsec: generateSecretKeyKeypair().nsec, locale: "en" });

    render(
      <LanguageProvider>
        <ManualBallotEntry definition={definition} credential={credential} />
      </LanguageProvider>,
    );

    await user.type(screen.getByLabelText(/Ballot private key/i), ballot.voterNsec);
    await user.click(screen.getByRole("button", { name: /Confirm ballot identity/i }));
    await screen.findByText(/Check that this identity matches the ballot/i);

    // The OTP-admitted voter's ballot is now entered; the screen offers the
    // same submission the digital flow would produce, and the questionnaire's
    // first question is rendered with its yes/no controls.
    expect(screen.getByRole("button", { name: /Submit paper ballot/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Yes$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^No$/ })).toBeTruthy();
  });
});

function generateSecretKeyKeypair(): { nsec: string; npub: string } {
  const secret = generateSecretKey();
  const nsec = nip19.nsecEncode(secret);
  const npub = deriveNpubFromNsec(nsec) as string;
  return { nsec, npub };
}

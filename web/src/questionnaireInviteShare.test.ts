import { describe, expect, it } from "vitest";
import {
  buildQuestionnaireInviteUrl,
  hasVoterInviteContextInUrl,
  isGeneralVoterInviteUrl,
  parseInviteFromUrl,
  shouldAutoRequestBallotFromUrl,
} from "./questionnaireInvite";
import {
  buildQuestionnaireInviteShareSubject,
  buildQuestionnaireInviteShareText,
} from "./questionnaireInviteShare";

describe("questionnaire invite sharing", () => {
  it("builds a voter login link from the current app host", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
    });

    expect(url).toBe("https://vote.example/?login=1&role=voter&q=q_public_123");
  });

  it("can build a scan-to-request general invite link that opens Vote directly", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
      login: false,
      autoRequestBallot: true,
    });

    expect(url).toBe("https://vote.example/?role=voter&q=q_public_123&request_ballot=1");
    expect(shouldAutoRequestBallotFromUrl(new URL(url).search)).toBe(true);
  });

  it("can build a personalised link for a pre-whitelisted voter npub", () => {
    const coordinatorNpub = "npub1coordinator";
    const invitedNpub = "npub1invited";
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
      coordinatorNpub,
      invitedNpub,
    });
    const parsed = parseInviteFromUrl(new URL(url).search);

    expect(url).toBe("https://vote.example/?login=1&role=voter&q=q_public_123&coordinator=npub1coordinator&invited=npub1invited");
    expect(parsed.invite?.coordinatorNpub).toBe(coordinatorNpub);
    expect(parsed.invite?.invitedNpub).toBe(invitedNpub);
  });

  it("preserves proxy-voter credential count in personalised links", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
      coordinatorNpub: "npub1coordinator",
      invitedNpub: "npub1invited",
      credentialsPerVoter: 2,
    });
    const parsed = parseInviteFromUrl(new URL(url).search);

    expect(url).toBe("https://vote.example/?login=1&role=voter&q=q_public_123&coordinator=npub1coordinator&invited=npub1invited&credentials_per_voter=2");
    expect(parsed.invite?.credentialsPerVoter).toBe(2);
  });

  it("can build a private code link that opens the questionnaire directly", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
      inviteCode: "ABC123private",
      login: false,
      autoRequestBallot: true,
    });
    const parsed = parseInviteFromUrl(new URL(url).search);

    expect(url).toBe("https://vote.example/?role=voter&q=q_public_123&invite_code=abc123private&request_ballot=1");
    expect(parsed.electionId).toBe("q_public_123");
    expect(parsed.invite).toBeNull();
    expect(parsed.inviteCode).toBe("abc123private");
    expect(parsed.coordinatorNpub).toBeNull();
    expect(shouldAutoRequestBallotFromUrl(new URL(url).search)).toBe(true);
  });

  it("preserves proxy-voter credential count in private code links", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
      inviteCode: "ABC123private",
      login: false,
      autoRequestBallot: true,
      credentialsPerVoter: 2,
    });
    const parsed = parseInviteFromUrl(new URL(url).search);

    expect(url).toBe("https://vote.example/?role=voter&q=q_public_123&invite_code=abc123private&request_ballot=1&credentials_per_voter=2");
    expect(parsed.inviteCode).toBe("abc123private");
    expect(parsed.credentialsPerVoter).toBe(2);
  });

  it("still parses coordinator routing from older private code links", () => {
    const parsed = parseInviteFromUrl("?role=voter&q=q_public_123&coordinator=npub1coordinator&invite_code=abc123private");

    expect(parsed.electionId).toBe("q_public_123");
    expect(parsed.invite).toBeNull();
    expect(parsed.inviteCode).toBe("abc123private");
    expect(parsed.coordinatorNpub).toBe("npub1coordinator");
  });

  it("recognises legacy auto-request flags without enabling normal invite links", () => {
    expect(shouldAutoRequestBallotFromUrl("?role=voter&q=q_public_123")).toBe(false);
    expect(shouldAutoRequestBallotFromUrl("?role=voter&q=q_public_123&auto_request=1")).toBe(true);
    expect(shouldAutoRequestBallotFromUrl("?role=voter&q=q_public_123&request_ballot=yes")).toBe(true);
  });

  it("does not treat a bare voter role URL as an invite context", () => {
    expect(hasVoterInviteContextInUrl("?role=voter")).toBe(false);
    expect(hasVoterInviteContextInUrl("?role=voter&request_ballot=1")).toBe(false);
    expect(hasVoterInviteContextInUrl("?role=voter&q=q_public_123")).toBe(true);
    expect(hasVoterInviteContextInUrl("?role=voter&coordinator=npub1coordinator")).toBe(true);
    expect(hasVoterInviteContextInUrl("?role=voter&invite_code=abc123private")).toBe(true);
  });

  it("detects general voter invite links", () => {
    expect(isGeneralVoterInviteUrl("?role=voter&q=q_public_123")).toBe(true);
    expect(isGeneralVoterInviteUrl("?role=voter&request_ballot=1&election_id=q_public_123")).toBe(true);
    expect(isGeneralVoterInviteUrl("?role=voter&questionnaire=q_public_123&request_ballot=1")).toBe(true);
  });

  it("does not treat private invite links as general", () => {
    expect(isGeneralVoterInviteUrl("?role=voter&q=q_public_123&coordinator=npub1coordinator&invited=npub1invited")).toBe(false);
    expect(isGeneralVoterInviteUrl("?role=voter&q=q_public_123&invite_code=abc123private")).toBe(false);
    expect(isGeneralVoterInviteUrl("?role=voter&q=q_public_123&invite=%7B%22type%22%3A%22election_invite%22%7D")).toBe(false);
  });

  it("is not general without a questionnaire context", () => {
    expect(isGeneralVoterInviteUrl("?role=voter")).toBe(false);
    expect(isGeneralVoterInviteUrl("?role=voter&request_ballot=1")).toBe(false);
    expect(isGeneralVoterInviteUrl("?role=voter&coordinator=npub1coordinator")).toBe(false);
  });

  it("builds no-account share copy around the public questionnaire link", () => {
    const inviteUrl = "https://vote.example/?login=1&role=voter&q=q_public_123";
    const text = buildQuestionnaireInviteShareText({
      title: "Course feedback",
      description: "Please complete this before Friday.",
      inviteUrl,
    });

    expect(buildQuestionnaireInviteShareSubject({ title: "Course feedback" })).toBe("Invitation: Course feedback");
    expect(text).toContain("Course feedback");
    expect(text).toContain("Please complete this before Friday.");
    expect(text).toContain(inviteUrl);
  });
});

import { describe, expect, it } from "vitest";
import { buildQuestionnaireInviteUrl, parseInviteFromUrl } from "./questionnaireInvite";
import {
  buildQuestionnaireInviteMailtoHref,
  buildQuestionnaireInviteShareSubject,
  buildQuestionnaireInviteShareText,
  buildQuestionnaireInviteSmsHref,
  buildQuestionnaireInviteWhatsAppHref,
} from "./questionnaireInviteShare";

describe("questionnaire invite sharing", () => {
  it("builds a voter login link from the current app host", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
    });

    expect(url).toBe("https://vote.example/?login=1&role=voter&q=q_public_123");
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

  it("can build a private code link that opens the questionnaire directly", () => {
    const url = buildQuestionnaireInviteUrl({
      baseUrl: "https://vote.example/simple-coordinator.html?role=coordinator",
      electionId: "q_public_123",
      inviteCode: "ABC123private",
      login: false,
    });
    const parsed = parseInviteFromUrl(new URL(url).search);

    expect(url).toBe("https://vote.example/?role=voter&q=q_public_123&invite_code=abc123private");
    expect(parsed.electionId).toBe("q_public_123");
    expect(parsed.invite).toBeNull();
    expect(parsed.inviteCode).toBe("abc123private");
    expect(parsed.coordinatorNpub).toBeNull();
  });

  it("still parses coordinator routing from older private code links", () => {
    const parsed = parseInviteFromUrl("?role=voter&q=q_public_123&coordinator=npub1coordinator&invite_code=abc123private");

    expect(parsed.electionId).toBe("q_public_123");
    expect(parsed.invite).toBeNull();
    expect(parsed.inviteCode).toBe("abc123private");
    expect(parsed.coordinatorNpub).toBe("npub1coordinator");
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

  it("encodes email, SMS, and WhatsApp hrefs without provider credentials", () => {
    const inviteUrl = "https://vote.example/?login=1&role=voter&q=q_public_123";
    const input = {
      title: "Course feedback",
      description: "",
      inviteUrl,
    };

    expect(buildQuestionnaireInviteMailtoHref(input)).toContain("mailto:?");
    expect(decodeURIComponent(buildQuestionnaireInviteSmsHref(input))).toContain(inviteUrl);
    expect(decodeURIComponent(buildQuestionnaireInviteWhatsAppHref(input))).toContain(inviteUrl);
  });
});

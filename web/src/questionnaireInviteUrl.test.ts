// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  clearQuestionnaireInviteCodeUrlContext,
  consumeQuestionnaireInviteCodeFromUrl,
  isGeneralVoterInviteUrl,
  parseInviteFromUrl,
} from "./questionnaireInvite";

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("questionnaire invite URL consumption", () => {
  it("scrubs query and fragment aliases while retaining public context and history", () => {
    window.history.replaceState(
      { existing: "state" },
      "",
      "/vote?q=q_private&coordinator=npub1organiser&request_ballot=1&keep=query&invite_code=query-secret#section&keep=fragment&code=fragment-legacy&invite_code=fragment-secret",
    );

    expect(consumeQuestionnaireInviteCodeFromUrl()).toBe("fragment-secret");
    expect(window.location.pathname).toBe("/vote");
    expect(window.location.search).toBe("?q=q_private&coordinator=npub1organiser&request_ballot=1&keep=query");
    expect(window.location.hash).toBe("#section&keep=fragment");
    expect(window.history.state).toMatchObject({
      existing: "state",
      auditableVotingQuestionnaireInviteCode: {
        code: "fragment-secret",
        electionId: "q_private",
      },
    });
    expect(parseInviteFromUrl().inviteCode).toBe("fragment-secret");
  });

  it("is idempotent and keeps the consumed code available to the default parser", () => {
    window.history.replaceState({ existing: 1 }, "", "/?q=q_private#invite_code=Secret%20Code");

    expect(consumeQuestionnaireInviteCodeFromUrl()).toBe("secret code");
    const scrubbedUrl = window.location.href;
    const scrubbedState = window.history.state;
    expect(consumeQuestionnaireInviteCodeFromUrl()).toBe("secret code");
    expect(window.location.href).toBe(scrubbedUrl);
    expect(window.history.state).toEqual(scrubbedState);
    expect(parseInviteFromUrl().inviteCode).toBe("secret code");
  });

  it("does not let explicit parsing read the current page or consumed history", () => {
    window.history.replaceState(null, "", "/?q=current#invite_code=current-secret");
    consumeQuestionnaireInviteCodeFromUrl();

    expect(parseInviteFromUrl("?q=explicit", "").inviteCode).toBeNull();
    expect(parseInviteFromUrl("", "#code=explicit%20secret").inviteCode).toBe("explicit secret");
  });

  it("does not reuse consumed context when the same history entry changes questionnaire", () => {
    window.history.replaceState(null, "", "/?role=voter&q=q_private#invite_code=secret");
    consumeQuestionnaireInviteCodeFromUrl();

    window.history.replaceState(window.history.state, "", "/?role=voter&q=q_public");

    expect(parseInviteFromUrl().inviteCode).toBeNull();
    expect(isGeneralVoterInviteUrl()).toBe(true);
  });

  it("deletes stale consumed context when a new alias is empty", () => {
    window.history.replaceState(null, "", "/?q=q_private#invite_code=secret");
    consumeQuestionnaireInviteCodeFromUrl();
    window.history.replaceState(window.history.state, "", "/?q=q_private#invite_code=");

    expect(consumeQuestionnaireInviteCodeFromUrl()).toBeNull();
    expect(parseInviteFromUrl().inviteCode).toBeNull();
    expect(window.history.state).toEqual({});
  });

  it("consumes codes from previously issued query-string links", () => {
    window.history.replaceState(null, "", "/?q=q_private&invite_code=Old%20Secret");

    expect(consumeQuestionnaireInviteCodeFromUrl()).toBe("old secret");
    expect(window.location.search).toBe("?q=q_private");
    expect(parseInviteFromUrl().inviteCode).toBe("old secret");
  });

  it("preserves a bare code anchor", () => {
    window.history.replaceState(null, "", "/?q=q_public#code");

    expect(consumeQuestionnaireInviteCodeFromUrl()).toBeNull();
    expect(window.location.hash).toBe("#code");
  });

  it("clears the consumed history value and any URL aliases", () => {
    window.history.replaceState({ existing: true }, "", "/?q=q_private#invite_code=secret&anchor");
    consumeQuestionnaireInviteCodeFromUrl();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}#code=again&anchor`);

    clearQuestionnaireInviteCodeUrlContext();

    expect(parseInviteFromUrl().inviteCode).toBeNull();
    expect(window.location.hash).toBe("#anchor");
    expect(window.history.state).toEqual({ existing: true });
  });

  it("uses an explicit complete URL for a parsed invite vote URL", () => {
    const source = new URL("https://vote.example/path/?q=q_private&coordinator=npub1organiser&invited=npub1invited#section");

    expect(parseInviteFromUrl(source).invite?.voteUrl).toBe(source.toString());
  });
});

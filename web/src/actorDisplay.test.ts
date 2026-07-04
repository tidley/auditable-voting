import { describe, expect, it } from "vitest";
import { deriveActorDisplayId, formatQuestionnaireDisplayId } from "./actorDisplay";

describe("deriveActorDisplayId", () => {
  it("uses the first and last 3 chars after npub1", () => {
    expect(deriveActorDisplayId("npub1abcdeffedcba")).toBe("ABC-CBA");
  });

  it("falls back for non-npub inputs", () => {
    expect(deriveActorDisplayId("abcdefghi")).toBe("ABC-GHI");
    expect(deriveActorDisplayId("abcdef")).toBe("ABCDEF");
    expect(deriveActorDisplayId("")).toBe("unknown");
  });

  it("capitalises questionnaire ids for display", () => {
    expect(formatQuestionnaireDisplayId("q_9423f65327bf")).toBe("Q_9423F65327BF");
  });
});

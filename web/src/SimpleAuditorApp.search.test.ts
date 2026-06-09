import { describe, expect, it } from "vitest";
import {
  collectAuditorSubmissionSearchValues,
  matchesAuditorQuestionnaireSearch,
} from "./SimpleAuditorApp";

describe("SimpleAuditorApp search helpers", () => {
  it("matches questionnaire search by submission id and submittor identity", () => {
    const submittorNpub = "npub17rd9rq7855zltq0y7p50m2lv8mt8vt0xtfud3msm0ls89nrak06s5avju2";
    const responseSearchValues = collectAuditorSubmissionSearchValues([{
      responseId: "submission_3685d0f11eb84df387ee",
      authorPubkey: submittorNpub,
    }]);
    const questionnaire = {
      questionnaireId: "q_b02cd1f3f026",
      title: "Testing auditable voting",
      description: "Can you fill out this questionnaire without any further information",
      coordinatorNpub: "npub1rxq8kyw5jj4e67r4frg36q8rh99t00fk36sjz2y5twwkqkerje3sazpzn4",
      eventId: "event_q_b02cd1f3f026",
      responseSearchValues,
    };

    expect(matchesAuditorQuestionnaireSearch(questionnaire, "submission_3685d0f11eb84df387ee")).toBe(true);
    expect(matchesAuditorQuestionnaireSearch(questionnaire, "7rd9rq7")).toBe(true);
    expect(matchesAuditorQuestionnaireSearch(questionnaire, submittorNpub)).toBe(true);
    expect(matchesAuditorQuestionnaireSearch(questionnaire, "npub1not-present")).toBe(false);
  });
});

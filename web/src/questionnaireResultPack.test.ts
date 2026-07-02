import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { fetchQuestionnaireResultPack } from "./questionnaireResultPack";
import type { QuestionnaireResultPackReference } from "./questionnaireProtocol";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("questionnaire result packs", () => {
  it("verifies Blossom bytes before parsing and falls back to a valid mirror", async () => {
    const pack = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_result_pack" as const,
      questionnaireId: "q_pack",
      createdAt: 1_777_000_000,
      summary: {
        schemaVersion: 1 as const,
        eventType: "questionnaire_result_summary" as const,
        questionnaireId: "q_pack",
        createdAt: 1_777_000_000,
        coordinatorPubkey: "npub1organiser",
        acceptedResponseCount: 1,
        rejectedResponseCount: 0,
        acceptedNullifierCount: 1,
        questionSummaries: [],
      },
      responses: [{
        responseId: "submission_1",
        authorPubkey: "npub1submitter",
        submittedAt: 1_777_000_001,
        accepted: true,
        answers: [],
      }],
    };
    const goodBytes = gzipSync(strToU8(JSON.stringify(pack)));
    const badBytes = new Uint8Array(goodBytes);
    badBytes[badBytes.length - 1] = badBytes[badBytes.length - 1] ^ 1;
    const sha256 = createHash("sha256").update(goodBytes).digest("hex");
    const reference: QuestionnaireResultPackReference = {
      url: "https://blossom.invalid/bad",
      sha256,
      size: goodBytes.length,
      type: "application/vnd.auditable-voting.result-pack+json",
      compression: "gzip",
      uploadedAt: 1_777_000_002,
      mirrors: [{
        url: "https://blossom.invalid/good",
        server: "https://blossom.invalid",
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(badBytes))
      .mockResolvedValueOnce(new Response(goodBytes));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchQuestionnaireResultPack(reference)).resolves.toMatchObject({
      questionnaireId: "q_pack",
      responses: [{ responseId: "submission_1" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

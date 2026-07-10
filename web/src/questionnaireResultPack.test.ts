import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync, strToU8 } from "fflate";
import { buildQuestionnaireResultPackCsv, fetchQuestionnaireResultPack } from "./questionnaireResultPack";
import type { QuestionnaireResultPackReference } from "./questionnaireProtocol";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("questionnaire result packs", () => {
  it("reads Blossom CSV result packs with audit columns", async () => {
    const pack = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_result_pack" as const,
      questionnaireId: "q_csv",
      createdAt: 1_777_000_000,
      summary: {
        schemaVersion: 1 as const,
        eventType: "questionnaire_result_summary" as const,
        questionnaireId: "q_csv",
        createdAt: 1_777_000_000,
        coordinatorPubkey: "npub1organiser",
        acceptedResponseCount: 1,
        rejectedResponseCount: 1,
        acceptedNullifierCount: 1,
        questionSummaries: [],
      },
      responses: [{
        responseId: "submission_1",
        authorPubkey: "npub1submitter",
        submittedAt: 1_777_000_001,
        accepted: true,
        tokenNullifier: "nullifier_1",
        tokenProof: {
          tokenCommitment: "commitment_1",
          questionnaireId: "q_csv",
          signature: "blind_signature_1",
        },
        answers: [{ questionId: "q1", value: "Yes, with comma" }],
      }, {
        responseId: "submission_2",
        authorPubkey: "npub1submitter2",
        submittedAt: 1_777_000_002,
        accepted: false,
        rejectionReason: "duplicate_nullifier",
        answers: [],
      }],
    };
    const bytes = strToU8(buildQuestionnaireResultPackCsv(pack));
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes);
    expect(csv.split("\r\n")[0]).toBe(
      "questionnaire_id,result_created_at,coordinator_pubkey,accepted_response_count,rejected_response_count,accepted_nullifier_count,response_id,submittor_pubkey,submitted_at,accepted,rejection_reason,token_nullifier,token_nullifiers_json,token_commitment,token_signature,token_proofs_json,answers_json",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const reference: QuestionnaireResultPackReference = {
      url: "https://blossom.invalid/result.csv",
      sha256,
      size: bytes.length,
      type: "text/csv",
      compression: "none",
      uploadEncoding: "csv",
      uploadedAt: 1_777_000_003,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(bytes)));

    await expect(fetchQuestionnaireResultPack(reference)).resolves.toMatchObject({
      questionnaireId: "q_csv",
      summary: { coordinatorPubkey: "npub1organiser" },
      responses: [
        {
          responseId: "submission_1",
          authorPubkey: "npub1submitter",
          accepted: true,
          tokenNullifier: "nullifier_1",
          tokenProof: {
            tokenCommitment: "commitment_1",
            signature: "blind_signature_1",
          },
        },
        { responseId: "submission_2", rejectionReason: "duplicate_nullifier" },
      ],
    });
  });

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

  it("verifies JSON-wrapped gzip result packs before parsing", async () => {
    const pack = {
      schemaVersion: 1 as const,
      eventType: "questionnaire_result_pack" as const,
      questionnaireId: "q_wrapped",
      createdAt: 1_777_000_000,
      summary: {
        schemaVersion: 1 as const,
        eventType: "questionnaire_result_summary" as const,
        questionnaireId: "q_wrapped",
        createdAt: 1_777_000_000,
        coordinatorPubkey: "npub1organiser",
        acceptedResponseCount: 1,
        rejectedResponseCount: 0,
        acceptedNullifierCount: 1,
        questionSummaries: [],
      },
      responses: [{
        responseId: "submission_wrapped",
        authorPubkey: "npub1submitter",
        submittedAt: 1_777_000_001,
        accepted: true,
        answers: [],
      }],
    };
    const compressed = gzipSync(strToU8(JSON.stringify(pack)));
    const payloadSha256 = createHash("sha256").update(compressed).digest("hex");
    const wrapper = strToU8(JSON.stringify({
      schemaVersion: 1,
      eventType: "questionnaire_result_pack_blob",
      type: "application/vnd.auditable-voting.result-pack+json",
      compression: "gzip",
      sha256: payloadSha256,
      size: compressed.length,
      payloadEncoding: "base64url",
      payload: Buffer.from(compressed).toString("base64url"),
    }));
    const sha256 = createHash("sha256").update(wrapper).digest("hex");
    const reference: QuestionnaireResultPackReference = {
      url: "https://blossom.invalid/wrapped",
      sha256,
      size: wrapper.length,
      type: "application/vnd.auditable-voting.result-pack+json",
      compression: "gzip",
      uploadEncoding: "json+base64url-gzip",
      payloadSha256,
      payloadSize: compressed.length,
      uploadedAt: 1_777_000_002,
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(wrapper));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchQuestionnaireResultPack(reference)).resolves.toMatchObject({
      questionnaireId: "q_wrapped",
      responses: [{ responseId: "submission_wrapped" }],
    });
  });
});

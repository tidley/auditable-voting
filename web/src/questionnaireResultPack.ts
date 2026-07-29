import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { finalizeEvent, nip19 } from "nostr-tools";
import type {
  QuestionnairePublishedResponseRef,
  QuestionnaireResultPackReference,
  QuestionnaireResultSummary,
} from "./questionnaireProtocol";

const BLOSSOM_AUTH_KIND = 24_242;
const RESULT_PACK_JSON_TYPE = "application/vnd.auditable-voting.result-pack+json" as const;
const RESULT_PACK_CSV_TYPE = "text/csv" as const;
const RESULT_PACK_GZIP_COMPRESSION = "gzip" as const;
const RESULT_PACK_CSV_COMPRESSION = "none" as const;
const BLOSSOM_GZIP_UPLOAD_CONTENT_TYPE = "application/gzip";
const BLOSSOM_JSON_UPLOAD_CONTENT_TYPE = "application/json";
const BLOSSOM_CSV_UPLOAD_CONTENT_TYPE = "text/csv; charset=utf-8";
const RESULT_PACK_DIRECT_UPLOAD_ENCODING = "gzip" as const;
const RESULT_PACK_WRAPPED_UPLOAD_ENCODING = "json+base64url-gzip" as const;
const RESULT_PACK_CSV_UPLOAD_ENCODING = "csv" as const;
const BLOSSOM_UPLOAD_TIMEOUT_MS = 12_000;
const BLOSSOM_TARGET_UPLOAD_COUNT = 2;

export const DEFAULT_BLOSSOM_RESULT_PACK_SERVERS = [
  "https://blossom.nostr.build",
  "https://blossom.primal.net",
  "https://cdn.nostrcheck.me",
];

export type QuestionnaireResultPack = {
  schemaVersion: 1;
  eventType: "questionnaire_result_pack";
  questionnaireId: string;
  createdAt: number;
  summary: Omit<QuestionnaireResultSummary, "resultPack" | "publishedResponseRefs">;
  responses: QuestionnairePublishedResponseRef[];
};

type BlossomBlobDescriptor = {
  url?: string;
  sha256?: string;
  size?: number;
  type?: string;
};

type ResultPackUploadEnvelope = {
  schemaVersion: 1;
  eventType: "questionnaire_result_pack_blob";
  type: typeof RESULT_PACK_JSON_TYPE;
  compression: typeof RESULT_PACK_GZIP_COMPRESSION;
  sha256: string;
  size: number;
  payloadEncoding: "base64url";
  payload: string;
};

export async function uploadQuestionnaireResultPack(input: {
  publisherNsec: string;
  resultSummary: QuestionnaireResultSummary;
  responses?: QuestionnairePublishedResponseRef[];
  servers?: string[];
}): Promise<QuestionnaireResultPackReference> {
  const responses = input.responses ?? input.resultSummary.publishedResponseRefs ?? [];
  const pack = buildQuestionnaireResultPack({
    summary: input.resultSummary,
    responses,
  });
  const csv = strToU8(buildQuestionnaireResultPackCsv(pack));
  const sha256 = await sha256HexBytes(csv);
  const servers = sanitizeBlossomServers(input.servers);
  if (servers.length < BLOSSOM_TARGET_UPLOAD_COUNT) {
    throw new Error("At least two Blossom result-pack servers are required.");
  }
  const uploads: QuestionnaireResultPackReference[] = [];
  const errors: string[] = [];

  for (const server of servers) {
    try {
      const upload = await uploadPackBodyToBlossom({
        nsec: input.publisherNsec,
        server,
        body: csv,
        sha256,
        contentType: BLOSSOM_CSV_UPLOAD_CONTENT_TYPE,
        uploadEncoding: RESULT_PACK_CSV_UPLOAD_ENCODING,
      });
      uploads.push(upload);
      if (uploads.length >= BLOSSOM_TARGET_UPLOAD_COUNT) {
        break;
      }
    } catch (error) {
      errors.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (uploads.length < BLOSSOM_TARGET_UPLOAD_COUNT) {
    const compressed = gzipSync(strToU8(JSON.stringify(pack)));
    const payloadSha256 = await sha256HexBytes(compressed);
    const wrapped = buildJsonWrappedResultPack(compressed, payloadSha256);
    const wrappedSha256 = await sha256HexBytes(wrapped);
    for (const server of servers) {
      if (uploads.some((upload) => upload.server === server)) {
        continue;
      }
      try {
        uploads.push(await uploadPackBodyToBlossom({
          nsec: input.publisherNsec,
          server,
          body: wrapped,
          sha256: wrappedSha256,
          contentType: BLOSSOM_JSON_UPLOAD_CONTENT_TYPE,
          uploadEncoding: RESULT_PACK_WRAPPED_UPLOAD_ENCODING,
          payloadSha256,
          payloadSize: compressed.length,
        }));
        if (uploads.length >= BLOSSOM_TARGET_UPLOAD_COUNT) {
          break;
        }
      } catch (error) {
        errors.push(`${server}: JSON fallback ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (uploads.length < BLOSSOM_TARGET_UPLOAD_COUNT) {
      throw new Error(`Blossom result-pack upload failed: ${errors.join("; ")}`);
    }
  }

  return buildMirroredResultPackReference(uploads);
}

export async function fetchQuestionnaireResultPack(
  reference: QuestionnaireResultPackReference,
): Promise<QuestionnaireResultPack> {
  validateResultPackReference(reference);
  const uploadedBytes = await fetchVerifiedResultPackBytes(reference);
  if ((reference.uploadEncoding ?? resultPackDefaultUploadEncoding(reference)) === RESULT_PACK_CSV_UPLOAD_ENCODING) {
    return parseQuestionnaireResultPackCsv(strFromU8(uploadedBytes));
  }
  const compressedBytes = await unwrapVerifiedResultPackBytes(reference, uploadedBytes);
  const json = strFromU8(gunzipSync(compressedBytes));
  const parsed = JSON.parse(json) as QuestionnaireResultPack;
  if (
    parsed?.schemaVersion !== 1
    || parsed?.eventType !== "questionnaire_result_pack"
    || typeof parsed?.questionnaireId !== "string"
    || !Array.isArray(parsed?.responses)
  ) {
    throw new Error("Blossom result-pack payload is invalid.");
  }
  return parsed;
}

async function fetchVerifiedResultPackBytes(reference: QuestionnaireResultPackReference) {
  const urls = [
    reference.url,
    ...(reference.mirrors ?? []).map((mirror) => mirror.url),
  ].filter((url, index, entries) => (
    url.startsWith("https://") && entries.indexOf(url) === index
  ));
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const response = await fetchWithTimeout(url, { method: "GET" }, BLOSSOM_UPLOAD_TIMEOUT_MS);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== reference.size) {
        throw new Error(`size mismatch: expected ${reference.size}, got ${bytes.length}`);
      }
      const actualSha256 = await sha256HexBytes(bytes);
      if (actualSha256 !== reference.sha256.toLowerCase()) {
        throw new Error(`sha256 mismatch: expected ${reference.sha256}, got ${actualSha256}`);
      }
      return bytes;
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`No Blossom result-pack mirror passed verification: ${errors.join("; ")}`);
}

export function buildQuestionnaireResultPack(input: {
  summary: QuestionnaireResultSummary;
  responses: QuestionnairePublishedResponseRef[];
}): QuestionnaireResultPack {
  const { resultPack: _resultPack, publishedResponseRefs: _publishedResponseRefs, ...summary } = input.summary;
  return {
    schemaVersion: 1,
    eventType: "questionnaire_result_pack",
    questionnaireId: summary.questionnaireId,
    createdAt: Math.floor(Date.now() / 1000),
    summary,
    responses: input.responses,
  };
}

export function buildQuestionnaireResultPackCsv(pack: QuestionnaireResultPack) {
  const headers = [
    "questionnaire_id",
    "result_created_at",
    "coordinator_pubkey",
    "accepted_response_count",
    "rejected_response_count",
    "accepted_nullifier_count",
    "response_id",
    "submittor_pubkey",
    "submitted_at",
    "accepted",
    "rejection_reason",
    "token_nullifier",
    "token_nullifiers_json",
    "token_commitment",
    "token_signature",
    "token_proofs_json",
    "answers_json",
  ];
  const rows = pack.responses.map((response) => [
    pack.questionnaireId,
    String(pack.createdAt),
    pack.summary.coordinatorPubkey,
    String(pack.summary.acceptedResponseCount),
    String(pack.summary.rejectedResponseCount),
    String(pack.summary.acceptedNullifierCount ?? ""),
    response.responseId,
    response.authorPubkey,
    String(response.submittedAt),
    response.accepted ? "true" : "false",
    response.rejectionReason ?? "",
    response.tokenNullifier ?? "",
    JSON.stringify(response.tokenNullifiers ?? []),
    response.tokenProof?.tokenCommitment ?? "",
    response.tokenProof?.signature ?? "",
    JSON.stringify(response.tokenProofs?.length ? response.tokenProofs : (response.tokenProof ? [response.tokenProof] : [])),
    JSON.stringify(response.answers ?? []),
  ]);
  return "\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function parseQuestionnaireResultPackCsv(csv: string): QuestionnaireResultPack {
  const [headers, ...rows] = parseCsvRows(csv).filter((row) => row.some((cell) => cell.trim() !== ""));
  if (!headers) {
    throw new Error("Blossom CSV result-pack payload is empty.");
  }
  const column = Object.fromEntries(headers.map((header, index) => [header.replace(/^\ufeff/, ""), index]));
  const required = ["questionnaire_id", "result_created_at", "coordinator_pubkey", "accepted_response_count", "rejected_response_count", "response_id", "submittor_pubkey", "submitted_at", "accepted", "answers_json"];
  if (!required.every((name) => Number.isInteger(column[name]))) {
    throw new Error("Blossom CSV result-pack headers are invalid.");
  }
  const read = (row: string[], name: string) => row[column[name]] ?? "";
  const first = rows[0] ?? [];
  const responses = rows.map((row): QuestionnairePublishedResponseRef => ({
    responseId: read(row, "response_id"),
    authorPubkey: read(row, "submittor_pubkey"),
    submittedAt: Number(read(row, "submitted_at")) || 0,
    accepted: read(row, "accepted").toLowerCase() === "true",
    rejectionReason: read(row, "rejection_reason") || null,
    tokenNullifier: read(row, "token_nullifier") || undefined,
    tokenNullifiers: parseJsonColumn(read(row, "token_nullifiers_json"), []),
    tokenProof: parseTokenProofColumn(row, read),
    tokenProofs: parseJsonColumn(read(row, "token_proofs_json"), []),
    answers: JSON.parse(read(row, "answers_json") || "[]"),
  }));
  return {
    schemaVersion: 1,
    eventType: "questionnaire_result_pack",
    questionnaireId: read(first, "questionnaire_id"),
    createdAt: Number(read(first, "result_created_at")) || 0,
    summary: {
      schemaVersion: 1,
      eventType: "questionnaire_result_summary",
      questionnaireId: read(first, "questionnaire_id"),
      createdAt: Number(read(first, "result_created_at")) || 0,
      coordinatorPubkey: read(first, "coordinator_pubkey"),
      acceptedResponseCount: Number(read(first, "accepted_response_count")) || 0,
      rejectedResponseCount: Number(read(first, "rejected_response_count")) || 0,
      acceptedNullifierCount: Number(read(first, "accepted_nullifier_count")) || undefined,
      questionSummaries: [],
    },
    responses,
  };
}

function parseJsonColumn<T>(value: string, fallback: T): T {
  if (!value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseTokenProofColumn(
  row: string[],
  read: (row: string[], name: string) => string,
): QuestionnairePublishedResponseRef["tokenProof"] | undefined {
  const proofs = parseJsonColumn<NonNullable<QuestionnairePublishedResponseRef["tokenProof"]>[]>(
    read(row, "token_proofs_json"),
    [],
  );
  if (proofs[0]?.tokenCommitment && proofs[0]?.signature) {
    return proofs[0];
  }
  const tokenCommitment = read(row, "token_commitment");
  const signature = read(row, "token_signature");
  const questionnaireId = read(row, "questionnaire_id");
  if (!tokenCommitment || !signature) {
    return undefined;
  }
  return { tokenCommitment, signature, questionnaireId };
}

function sanitizeBlossomServers(servers?: string[]) {
  const values = (servers && servers.length > 0 ? servers : DEFAULT_BLOSSOM_RESULT_PACK_SERVERS)
    .map((server) => server.trim().replace(/\/+$/, ""))
    .filter((server, index, entries) => (
      server.startsWith("https://")
      && server.length > "https://".length
      && entries.indexOf(server) === index
    ));
  if (values.length === 0) {
    throw new Error("No usable Blossom result-pack servers configured.");
  }
  return values;
}

async function uploadCompressedPackToBlossom(input: {
  nsec: string;
  server: string;
  compressed: Uint8Array;
  sha256: string;
}): Promise<QuestionnaireResultPackReference> {
  return uploadPackBodyToBlossom({
    nsec: input.nsec,
    server: input.server,
    body: input.compressed,
    sha256: input.sha256,
    contentType: BLOSSOM_GZIP_UPLOAD_CONTENT_TYPE,
    uploadEncoding: RESULT_PACK_DIRECT_UPLOAD_ENCODING,
  });
}

async function uploadPackBodyToBlossom(input: {
  nsec: string;
  server: string;
  body: Uint8Array;
  sha256: string;
  contentType: string;
  uploadEncoding: QuestionnaireResultPackReference["uploadEncoding"];
  payloadSha256?: string;
  payloadSize?: number;
}): Promise<QuestionnaireResultPackReference> {
  const uploadUrl = `${input.server}/upload`;
  const auth = buildBlossomUploadAuth({
    nsec: input.nsec,
    uploadUrl,
    sha256: input.sha256,
  });
  const response = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": input.contentType,
      "X-SHA-256": input.sha256,
      "Authorization": auth,
    },
    body: new Uint8Array(input.body),
  }, BLOSSOM_UPLOAD_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  }
  const descriptor = await response.json() as BlossomBlobDescriptor;
  const descriptorSha = descriptor.sha256?.trim().toLowerCase() ?? "";
  if (descriptorSha !== input.sha256) {
    throw new Error(`server returned mismatched sha256 ${descriptor.sha256 ?? "(missing)"}`);
  }
  if (descriptor.size !== input.body.length) {
    throw new Error(`server returned mismatched size ${descriptor.size ?? "(missing)"}`);
  }
  const url = descriptor.url?.trim() ?? "";
  if (!url.startsWith("https://")) {
    throw new Error("server returned no HTTPS blob URL");
  }
  return {
    url,
    sha256: input.sha256,
    size: input.body.length,
    type: input.uploadEncoding === RESULT_PACK_CSV_UPLOAD_ENCODING ? RESULT_PACK_CSV_TYPE : RESULT_PACK_JSON_TYPE,
    compression: input.uploadEncoding === RESULT_PACK_CSV_UPLOAD_ENCODING ? RESULT_PACK_CSV_COMPRESSION : RESULT_PACK_GZIP_COMPRESSION,
    uploadEncoding: input.uploadEncoding,
    payloadSha256: input.payloadSha256,
    payloadSize: input.payloadSize,
    uploadedAt: Math.floor(Date.now() / 1000),
    server: input.server,
  };
}

function buildJsonWrappedResultPack(compressed: Uint8Array, sha256: string) {
  const envelope: ResultPackUploadEnvelope = {
    schemaVersion: 1,
    eventType: "questionnaire_result_pack_blob",
    type: RESULT_PACK_JSON_TYPE,
    compression: RESULT_PACK_GZIP_COMPRESSION,
    sha256,
    size: compressed.length,
    payloadEncoding: "base64url",
    payload: bytesToBase64Url(compressed),
  };
  return strToU8(JSON.stringify(envelope));
}

function buildMirroredResultPackReference(uploads: QuestionnaireResultPackReference[]) {
  const [primary] = uploads;
  if (!primary) {
    throw new Error("No Blossom result-pack uploads were produced.");
  }
  return {
    ...primary,
    mirrors: uploads.map((upload) => ({
      url: upload.url,
      server: upload.server,
    })),
  };
}

function buildBlossomUploadAuth(input: {
  nsec: string;
  uploadUrl: string;
  sha256: string;
}) {
  const decoded = nip19.decode(input.nsec.trim());
  if (decoded.type !== "nsec") {
    throw new Error("Expected nsec for Blossom upload auth.");
  }
  const host = new URL(input.uploadUrl).host.toLowerCase();
  const event = finalizeEvent({
    kind: BLOSSOM_AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["t", "upload"],
      ["expiration", String(Math.floor(Date.now() / 1000) + 10 * 60)],
      ["x", input.sha256],
      ["server", host],
    ],
    content: "Upload questionnaire result pack",
  }, decoded.data as Uint8Array);
  return `Nostr ${bytesToBase64Url(strToU8(JSON.stringify(event)))}`;
}

function validateResultPackReference(reference: QuestionnaireResultPackReference) {
  if (
    !reference
    || !reference.url?.startsWith("https://")
    || !/^[a-f0-9]{64}$/i.test(reference.sha256 ?? "")
    || !Number.isFinite(reference.size)
    || reference.size <= 0
    || ![RESULT_PACK_CSV_TYPE, RESULT_PACK_JSON_TYPE].includes(reference.type)
    || ![RESULT_PACK_CSV_COMPRESSION, RESULT_PACK_GZIP_COMPRESSION].includes(reference.compression)
  ) {
    throw new Error("Invalid Blossom result-pack reference.");
  }
  if (reference.type === RESULT_PACK_CSV_TYPE && reference.compression !== RESULT_PACK_CSV_COMPRESSION) {
    throw new Error("Invalid Blossom result-pack reference.");
  }
  if (reference.type === RESULT_PACK_JSON_TYPE && reference.compression !== RESULT_PACK_GZIP_COMPRESSION) {
    throw new Error("Invalid Blossom result-pack reference.");
  }
  if (
    reference.uploadEncoding
    && reference.uploadEncoding !== RESULT_PACK_CSV_UPLOAD_ENCODING
    && reference.uploadEncoding !== RESULT_PACK_DIRECT_UPLOAD_ENCODING
    && reference.uploadEncoding !== RESULT_PACK_WRAPPED_UPLOAD_ENCODING
  ) {
    throw new Error("Invalid Blossom result-pack reference.");
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}

async function sha256HexBytes(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function unwrapVerifiedResultPackBytes(reference: QuestionnaireResultPackReference, bytes: Uint8Array) {
  if ((reference.uploadEncoding ?? resultPackDefaultUploadEncoding(reference)) === RESULT_PACK_DIRECT_UPLOAD_ENCODING) {
    return bytes;
  }
  const envelope = JSON.parse(strFromU8(bytes)) as ResultPackUploadEnvelope;
  if (
    envelope?.schemaVersion !== 1
    || envelope?.eventType !== "questionnaire_result_pack_blob"
    || envelope?.type !== RESULT_PACK_JSON_TYPE
    || envelope?.compression !== RESULT_PACK_GZIP_COMPRESSION
    || envelope?.payloadEncoding !== "base64url"
    || typeof envelope?.payload !== "string"
  ) {
    throw new Error("Blossom result-pack wrapper is invalid.");
  }
  const compressed = base64UrlToBytes(envelope.payload);
  const expectedSha256 = (reference.payloadSha256 ?? envelope.sha256 ?? "").toLowerCase();
  const expectedSize = reference.payloadSize ?? envelope.size;
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || !Number.isFinite(expectedSize) || expectedSize <= 0) {
    throw new Error("Blossom result-pack wrapper verification data is invalid.");
  }
  if (compressed.length !== expectedSize) {
    throw new Error(`payload size mismatch: expected ${expectedSize}, got ${compressed.length}`);
  }
  const actualSha256 = await sha256HexBytes(compressed);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`payload sha256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
  }
  return compressed;
}

function resultPackDefaultUploadEncoding(reference: QuestionnaireResultPackReference) {
  return reference.type === RESULT_PACK_CSV_TYPE ? RESULT_PACK_CSV_UPLOAD_ENCODING : RESULT_PACK_DIRECT_UPLOAD_ENCODING;
}

function csvCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

function parseCsvRows(csv: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (quoted) {
      if (char === "\"" && csv[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = typeof atob === "function"
    ? atob(base64)
    : Buffer.from(base64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

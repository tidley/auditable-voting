import { gzipSync, gunzipSync, strFromU8, strToU8 } from "fflate";
import { finalizeEvent, nip19 } from "nostr-tools";
import type {
  QuestionnairePublishedResponseRef,
  QuestionnaireResultPackReference,
  QuestionnaireResultSummary,
} from "./questionnaireProtocol";

const BLOSSOM_AUTH_KIND = 24_242;
const RESULT_PACK_TYPE = "application/vnd.auditable-voting.result-pack+json" as const;
const RESULT_PACK_COMPRESSION = "gzip" as const;
const BLOSSOM_GZIP_UPLOAD_CONTENT_TYPE = "application/gzip";
const BLOSSOM_JSON_UPLOAD_CONTENT_TYPE = "application/json";
const RESULT_PACK_DIRECT_UPLOAD_ENCODING = "gzip" as const;
const RESULT_PACK_WRAPPED_UPLOAD_ENCODING = "json+base64url-gzip" as const;
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
  type: typeof RESULT_PACK_TYPE;
  compression: typeof RESULT_PACK_COMPRESSION;
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
  const payload = strToU8(JSON.stringify(pack));
  const compressed = gzipSync(payload, { level: 6 });
  const sha256 = await sha256HexBytes(compressed);
  const servers = sanitizeBlossomServers(input.servers);
  if (servers.length < BLOSSOM_TARGET_UPLOAD_COUNT) {
    throw new Error("At least two Blossom result-pack servers are required.");
  }
  const gzipUploads: QuestionnaireResultPackReference[] = [];
  const gzipErrors: string[] = [];

  for (const server of servers) {
    try {
      const upload = await uploadCompressedPackToBlossom({
        nsec: input.publisherNsec,
        server,
        compressed,
        sha256,
      });
      gzipUploads.push(upload);
      if (gzipUploads.length >= BLOSSOM_TARGET_UPLOAD_COUNT) {
        break;
      }
    } catch (error) {
      gzipErrors.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (gzipUploads.length >= BLOSSOM_TARGET_UPLOAD_COUNT) {
    return buildMirroredResultPackReference(gzipUploads);
  }

  const envelopeBytes = buildJsonWrappedResultPack(compressed, sha256);
  const envelopeSha256 = await sha256HexBytes(envelopeBytes);
  const wrappedUploads: QuestionnaireResultPackReference[] = [];
  const wrappedErrors: string[] = [];
  for (const server of servers) {
    try {
      const upload = await uploadPackBodyToBlossom({
        nsec: input.publisherNsec,
        server,
        body: envelopeBytes,
        sha256: envelopeSha256,
        contentType: BLOSSOM_JSON_UPLOAD_CONTENT_TYPE,
        uploadEncoding: RESULT_PACK_WRAPPED_UPLOAD_ENCODING,
        payloadSha256: sha256,
        payloadSize: compressed.length,
      });
      wrappedUploads.push(upload);
      if (wrappedUploads.length >= BLOSSOM_TARGET_UPLOAD_COUNT) {
        break;
      }
    } catch (error) {
      wrappedErrors.push(`${server}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (wrappedUploads.length < BLOSSOM_TARGET_UPLOAD_COUNT) {
    throw new Error(
      `Blossom result-pack upload failed: gzip: ${gzipErrors.join("; ")}; `
      + `JSON wrapper: ${wrappedErrors.join("; ")}`,
    );
  }

  return buildMirroredResultPackReference(wrappedUploads);
}

export async function fetchQuestionnaireResultPack(
  reference: QuestionnaireResultPackReference,
): Promise<QuestionnaireResultPack> {
  validateResultPackReference(reference);
  const uploadedBytes = await fetchVerifiedResultPackBytes(reference);
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
    body: input.body,
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
    type: RESULT_PACK_TYPE,
    compression: RESULT_PACK_COMPRESSION,
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
    type: RESULT_PACK_TYPE,
    compression: RESULT_PACK_COMPRESSION,
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
    || reference.type !== RESULT_PACK_TYPE
    || reference.compression !== RESULT_PACK_COMPRESSION
  ) {
    throw new Error("Invalid Blossom result-pack reference.");
  }
  if (
    reference.uploadEncoding
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
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function unwrapVerifiedResultPackBytes(reference: QuestionnaireResultPackReference, bytes: Uint8Array) {
  if ((reference.uploadEncoding ?? RESULT_PACK_DIRECT_UPLOAD_ENCODING) === RESULT_PACK_DIRECT_UPLOAD_ENCODING) {
    return bytes;
  }
  const envelope = JSON.parse(strFromU8(bytes)) as ResultPackUploadEnvelope;
  if (
    envelope?.schemaVersion !== 1
    || envelope?.eventType !== "questionnaire_result_pack_blob"
    || envelope?.type !== RESULT_PACK_TYPE
    || envelope?.compression !== RESULT_PACK_COMPRESSION
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

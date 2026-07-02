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
const BLOSSOM_UPLOAD_CONTENT_TYPE = "application/gzip";
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
  const uploads: QuestionnaireResultPackReference[] = [];
  const errors: string[] = [];

  for (const server of servers) {
    try {
      const upload = await uploadCompressedPackToBlossom({
        nsec: input.publisherNsec,
        server,
        compressed,
        sha256,
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
    throw new Error(`Blossom result-pack upload failed: ${errors.join("; ")}`);
  }

  return {
    ...uploads[0],
    mirrors: uploads.map((upload) => ({
      url: upload.url,
      server: upload.server,
    })),
  };
}

export async function fetchQuestionnaireResultPack(
  reference: QuestionnaireResultPackReference,
): Promise<QuestionnaireResultPack> {
  validateResultPackReference(reference);
  const bytes = await fetchVerifiedResultPackBytes(reference);
  const json = strFromU8(gunzipSync(bytes));
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
  const uploadUrl = `${input.server}/upload`;
  const auth = buildBlossomUploadAuth({
    nsec: input.nsec,
    uploadUrl,
    sha256: input.sha256,
  });
  const response = await fetchWithTimeout(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": BLOSSOM_UPLOAD_CONTENT_TYPE,
      "X-SHA-256": input.sha256,
      "Authorization": auth,
    },
    body: input.compressed,
  }, BLOSSOM_UPLOAD_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
  }
  const descriptor = await response.json() as BlossomBlobDescriptor;
  const descriptorSha = descriptor.sha256?.trim().toLowerCase() ?? "";
  if (descriptorSha !== input.sha256) {
    throw new Error(`server returned mismatched sha256 ${descriptor.sha256 ?? "(missing)"}`);
  }
  if (descriptor.size !== input.compressed.length) {
    throw new Error(`server returned mismatched size ${descriptor.size ?? "(missing)"}`);
  }
  const url = descriptor.url?.trim() ?? "";
  if (!url.startsWith("https://")) {
    throw new Error("server returned no HTTPS blob URL");
  }
  return {
    url,
    sha256: input.sha256,
    size: input.compressed.length,
    type: RESULT_PACK_TYPE,
    compression: RESULT_PACK_COMPRESSION,
    uploadedAt: Math.floor(Date.now() / 1000),
    server: input.server,
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

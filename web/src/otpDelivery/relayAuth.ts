import type { SignerService } from "../services/signerService";

export interface EmailSenderEndpoints {
  base: string;
  health: string;
  send: string;
  remote: boolean;
}

export function normaliseRelayUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function emailSenderEndpoints(relayUrl: string): EmailSenderEndpoints {
  const base = normaliseRelayUrl(relayUrl);
  if (!base) {
    return { base: "", health: "/__email/health", send: "/__email/send", remote: false };
  }
  return { base, health: `${base}/health`, send: `${base}/send`, remote: true };
}

export async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable in this browser.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Ascii(value: string): string {
  if (typeof btoa === "function") return btoa(value);
  const buffer = (globalThis as { Buffer?: { from: (input: string, encoding: string) => { toString: (encoding: string) => string } } }).Buffer;
  if (buffer) return buffer.from(value, "utf8").toString("base64");
  throw new Error("Base64 encoding is unavailable in this browser.");
}

export function extractBundleVoteUrl(csv: string): string {
  const match = csv.match(/https?:\/\/[^,"\r\n]+/);
  return match?.[0] ?? "";
}

export function extractBundleElectionId(csv: string): string {
  const match = csv.match(/[?&]q=([^&,"\r\n]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export async function nip98Authorization(
  signer: SignerService,
  url: string,
  body: string,
  nowMs = Date.now(),
): Promise<string> {
  const payload = await sha256Hex(body);
  const event = {
    kind: 27235,
    created_at: Math.floor(nowMs / 1000),
    tags: [
      ["u", url],
      ["method", "POST"],
      ["payload", payload],
    ],
    content: "",
  };
  const signed = await signer.signEvent(event);
  return `Nostr ${base64Ascii(JSON.stringify(signed))}`;
}

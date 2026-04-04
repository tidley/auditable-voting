import { nip19 } from "nostr-tools";

const NPUB_PATTERN = /npub1[023456789acdefghjklmnpqrstuvwxyz]+/gi;

function tryDecodeNpub(value: string) {
  try {
    const decoded = nip19.decode(value);
    return decoded.type === "npub" ? value : null;
  } catch {
    return null;
  }
}

export function extractNpubFromScan(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const candidates = Array.from(
    new Set([
      trimmed,
      trimmed.replace(/^nostr:/i, ""),
      ...(trimmed.match(NPUB_PATTERN) ?? []),
    ]),
  );

  for (const candidate of candidates) {
    const decoded = tryDecodeNpub(candidate);
    if (decoded) {
      return decoded;
    }
  }

  return null;
}

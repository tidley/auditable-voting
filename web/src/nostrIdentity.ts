import { getPublicKey, nip19 } from "nostr-tools";

export function decodeNsec(value: string): Uint8Array | null {
  try {
    const decoded = nip19.decode(value.trim());
    return decoded.type === "nsec" ? decoded.data : null;
  } catch {
    return null;
  }
}

export function deriveNpubFromNsec(value: string): string | null {
  const secretKey = decodeNsec(value);

  if (!secretKey) {
    return null;
  }

  return nip19.npubEncode(getPublicKey(secretKey));
}

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type TokenPatternCell = {
  filled: boolean;
  colorIndex: number;
};

export const TOKEN_FINGERPRINT_PALETTE = [
  "#d96a2b",
  "#d14e44",
  "#bc8744",
  "#6f8f5d",
  "#497f8f",
  "#7d5fa8",
] as const;

export async function deriveTokenIdFromProofSecrets(
  proofSecrets: string[],
  length = 20,
): Promise<string | null> {
  const normalized = proofSecrets
    .map((secret) => secret.trim())
    .filter((secret) => secret.length > 0)
    .sort();

  if (normalized.length === 0) {
    return null;
  }

  const proofHashes = await Promise.all(normalized.map((secret) => sha256Hex(secret)));
  const tokenId = await sha256Hex(proofHashes.join(":"));
  return tokenId.slice(0, length);
}

export function tokenIdLabel(tokenId: string | null | undefined): string {
  if (!tokenId) {
    return "Unavailable";
  }

  if (tokenId.length <= 14) {
    return tokenId;
  }

  return `${tokenId.slice(0, 8)}...${tokenId.slice(-6)}`;
}

export function tokenPatternDetail(tokenId: string, size = 5): TokenPatternCell[] {
  const normalized = tokenId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!normalized) {
    return Array.from({ length: size * size }, () => ({ filled: false, colorIndex: 0 }));
  }

  let seed = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    seed ^= normalized.charCodeAt(index);
    seed = Math.imul(seed, 0x01000193) >>> 0;
    seed ^= Number.parseInt(normalized[index] ?? "0", 16);
    seed = Math.imul(seed, 0x85ebca6b) >>> 0;
  }

  function nextByte(offset: number): number {
    seed = (seed + 0x6d2b79f5 + offset) >>> 0;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) & 0xff;
  }

  return Array.from({ length: size * size }, (_, index) => {
    const byte = nextByte(index * 2);
    const accent = nextByte(index * 2 + 1);

    return {
      filled: (byte % 2) === 0,
      colorIndex: accent % TOKEN_FINGERPRINT_PALETTE.length,
    };
  });
}

export function tokenPatternCells(tokenId: string, size = 5): boolean[] {
  return tokenPatternDetail(tokenId, size).map((cell) => cell.filled);
}

export function tokenQrPayload(tokenId: string): string {
  return `auditable-voting:token:${tokenId}`;
}

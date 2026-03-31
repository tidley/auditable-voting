export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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

export function tokenPatternCells(tokenId: string, size = 5): boolean[] {
  const normalized = tokenId.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (!normalized) {
    return Array.from({ length: size * size }, () => false);
  }

  const cells: boolean[] = [];
  const halfWidth = Math.ceil(size / 2);
  let cursor = 0;

  for (let row = 0; row < size; row += 1) {
    const rowValues: boolean[] = [];
    for (let column = 0; column < halfWidth; column += 1) {
      const nibble = Number.parseInt(normalized[cursor % normalized.length] ?? "0", 16);
      rowValues.push((nibble % 2) === 0);
      cursor += 1;
    }

    const mirrored = rowValues.slice(0, size % 2 === 0 ? halfWidth : halfWidth - 1).reverse();
    cells.push(...rowValues, ...mirrored);
  }

  return cells;
}

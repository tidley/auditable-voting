import {
  deriveTokenIdFromProofSecretsRust,
  sha256HexRust,
  tokenIdLabelRust,
  tokenPatternCellsRust,
  tokenPatternDetailRust,
  tokenQrPayloadRust,
} from "./wasm/auditableVotingCore";

export async function sha256Hex(input: string): Promise<string> {
  return sha256HexRust(input);
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
  return deriveTokenIdFromProofSecretsRust(proofSecrets, length) ?? null;
}

export function tokenIdLabel(tokenId: string | null | undefined): string {
  return tokenIdLabelRust(tokenId);
}

export function tokenPatternDetail(tokenId: string, size = 5): TokenPatternCell[] {
  return tokenPatternDetailRust(tokenId, size);
}

export function tokenPatternCells(tokenId: string, size = 5): boolean[] {
  return tokenPatternCellsRust(tokenId, size);
}

export function tokenQrPayload(tokenId: string): string {
  return tokenQrPayloadRust(tokenId);
}

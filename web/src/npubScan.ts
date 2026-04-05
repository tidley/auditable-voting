import { extractNpubFromScanRust } from "./wasm/auditableVotingCore";

export function extractNpubFromScan(value: string) {
  return extractNpubFromScanRust(value);
}

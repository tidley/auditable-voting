import { describe, expect, it } from "vitest";
import {
  deriveTokenIdFromProofSecrets,
  tokenIdLabel,
  tokenPatternCells,
  tokenPatternDetail,
  tokenQrPayload,
} from "./tokenIdentity";

describe("tokenIdentity", () => {
  it("derives a deterministic token id from proof secrets", async () => {
    const first = await deriveTokenIdFromProofSecrets(["secret-a", "secret-b"]);
    const second = await deriveTokenIdFromProofSecrets(["secret-b", "secret-a"]);

    expect(first).toBeTruthy();
    expect(first).toHaveLength(20);
    expect(first).toBe(second);
  });

  it("creates a deterministic full-grid pattern without mirroring", () => {
    const cells = tokenPatternCells("6ab4d7f1c925be102cd3", 5);

    expect(cells).toHaveLength(25);
    expect(cells.slice(0, 5)).not.toEqual(cells.slice(20, 25));
  });

  it("creates distinct color metadata without axis mirroring", () => {
    const cells = tokenPatternDetail("6ab4d7f1c925be102cd3", 5);

    expect(cells).toHaveLength(25);
    expect(cells.slice(0, 5)).not.toEqual(cells.slice(20, 25));
    expect(cells[0]).not.toEqual(cells[20]);
  });

  it("formats token id labels compactly", () => {
    expect(tokenIdLabel("1234567890abcdef")).toBe("12345678...abcdef");
    expect(tokenIdLabel(null)).toBe("Unavailable");
  });

  it("creates a stable QR payload", () => {
    expect(tokenQrPayload("abcdef")).toBe("auditable-voting:token:abcdef");
  });
});

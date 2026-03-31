import { describe, expect, it } from "vitest";
import { deriveTokenIdFromProofSecrets, tokenIdLabel, tokenPatternCells } from "./tokenIdentity";

describe("tokenIdentity", () => {
  it("derives a deterministic token id from proof secrets", async () => {
    const first = await deriveTokenIdFromProofSecrets(["secret-a", "secret-b"]);
    const second = await deriveTokenIdFromProofSecrets(["secret-b", "secret-a"]);

    expect(first).toBeTruthy();
    expect(first).toHaveLength(20);
    expect(first).toBe(second);
  });

  it("creates a mirrored pattern grid", () => {
    const cells = tokenPatternCells("abcdef1234567890", 5);

    expect(cells).toHaveLength(25);
    expect(cells[0]).toBe(cells[4]);
    expect(cells[5]).toBe(cells[9]);
  });

  it("formats token id labels compactly", () => {
    expect(tokenIdLabel("1234567890abcdef")).toBe("12345678...abcdef");
    expect(tokenIdLabel(null)).toBe("Unavailable");
  });
});

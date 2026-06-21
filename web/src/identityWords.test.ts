import { wordlist as bip39EnglishWordlist } from "@scure/bip39/wordlists/english.js";
import { describe, expect, it } from "vitest";
import { deriveIdentityWords, formatIdentityWordsForFilename } from "./identityWords";

describe("identityWords", () => {
  it("derives a deterministic three-word label from the BIP39 English word list", () => {
    const words = deriveIdentityWords(" nsec1example ");
    const parts = words.split(" ");

    expect(parts).toHaveLength(3);
    for (const word of parts) {
      expect(bip39EnglishWordlist).toContain(word);
    }
    expect(deriveIdentityWords("nsec1example")).toBe(words);
    expect(deriveIdentityWords("nsec1different")).not.toBe(words);
  });

  it("formats identity words for backup filenames", () => {
    expect(formatIdentityWordsForFilename("abandon ability able")).toBe("abandon-ability-able");
    expect(formatIdentityWordsForFilename("  abandon / ability / able  ")).toBe("abandon-ability-able");
  });
});

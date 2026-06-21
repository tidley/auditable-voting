import { wordlist as bip39EnglishWordlist } from "@scure/bip39/wordlists/english.js";
import { sha256HexRust } from "./wasm/auditableVotingCore";

export function deriveIdentityWords(secretOrIdentity: string) {
  const normalised = secretOrIdentity.trim();
  if (!normalised) {
    return "";
  }
  const digest = sha256HexRust(`auditable-voting identity words v1:${normalised}`);
  const words = [0, 8, 16].map((offset) => {
    const chunk = Number.parseInt(digest.slice(offset, offset + 8), 16);
    return bip39EnglishWordlist[chunk % bip39EnglishWordlist.length];
  });
  return words.join(" ");
}

export function formatIdentityWordsForFilename(words: string) {
  return words.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

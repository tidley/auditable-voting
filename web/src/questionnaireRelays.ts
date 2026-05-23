import { SIMPLE_PUBLIC_RELAYS } from "./simpleVotingSession";
import { normalizeRelaysRust } from "./wasm/auditableVotingCore";

export const DEFAULT_QUESTIONNAIRE_RELAYS = normalizeRelaysRust(SIMPLE_PUBLIC_RELAYS);

function splitRelayInput(value: string) {
  return value
    .split(/[\n,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isRelayUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "wss:" || url.protocol === "ws:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function relaySetKey(relays: string[]) {
  return [...new Set(relays)].sort((left, right) => left.localeCompare(right)).join("\n");
}

export function normalizeQuestionnaireRelays(value: unknown): string[] {
  const entries = typeof value === "string"
    ? splitRelayInput(value)
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
  return normalizeRelaysRust(entries.map((entry) => entry.trim()).filter(isRelayUrl));
}

export function questionnaireRelaysMatchDefault(relays: string[]) {
  return relaySetKey(normalizeQuestionnaireRelays(relays)) === relaySetKey(DEFAULT_QUESTIONNAIRE_RELAYS);
}

export function questionnaireRelaysForMetadata(relays: string[]) {
  const normalized = normalizeQuestionnaireRelays(relays);
  if (normalized.length === 0 || questionnaireRelaysMatchDefault(normalized)) {
    return undefined;
  }
  return normalized;
}

export function mergeQuestionnaireRelayHints(...relaySets: Array<string[] | null | undefined>) {
  return normalizeRelaysRust(relaySets.flatMap((relays) => relays ?? []));
}

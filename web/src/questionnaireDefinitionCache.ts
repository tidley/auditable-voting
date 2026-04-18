import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { buildSimpleNamespacedLocalStorageKey } from "./simpleLocalState";

const QUESTIONNAIRE_DEFINITION_CACHE_KEY = "questionnaire:definitions:v1";

function storageKey() {
  return buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DEFINITION_CACHE_KEY);
}

function readCache() {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(storageKey());
    return raw ? JSON.parse(raw) as Record<string, QuestionnaireDefinition> : {};
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, QuestionnaireDefinition>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(cache));
  } catch {
    // Cache writes must never block the voting flow.
  }
}

export function storeCachedQuestionnaireDefinition(definition: QuestionnaireDefinition) {
  const id = definition.questionnaireId.trim();
  if (!id) {
    return;
  }
  writeCache({
    ...readCache(),
    [id]: definition,
  });
}

export function readCachedQuestionnaireDefinition(questionnaireId: string) {
  const id = questionnaireId.trim();
  if (!id) {
    return null;
  }
  return readCache()[id] ?? null;
}

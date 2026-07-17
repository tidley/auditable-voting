import type { QuestionnaireDefinition, QuestionnaireDefinitionReference } from "./questionnaireProtocol";
import { buildNamespacedLocalStorageKey as buildSimpleNamespacedLocalStorageKey } from "./appStorageNamespace";

const QUESTIONNAIRE_DEFINITION_CACHE_KEY = "questionnaire:definitions:v1";
const QUESTIONNAIRE_DEFINITION_REFERENCE_CACHE_KEY = "questionnaire:definition-references:v1";

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
    return null;
  }
  const cache = readCache();
  const existing = cache[id] ?? null;
  if (
    existing
    && Number.isFinite(existing.createdAt)
    && Number.isFinite(definition.createdAt)
    && existing.createdAt > definition.createdAt
  ) {
    return existing;
  }
  writeCache({
    ...cache,
    [id]: definition,
  });
  return definition;
}

export function readCachedQuestionnaireDefinition(questionnaireId: string) {
  const id = questionnaireId.trim();
  if (!id) {
    return null;
  }
  return readCache()[id] ?? null;
}

function referenceStorageKey() {
  return buildSimpleNamespacedLocalStorageKey(QUESTIONNAIRE_DEFINITION_REFERENCE_CACHE_KEY);
}

export function storeCachedQuestionnaireDefinitionReference(reference: QuestionnaireDefinitionReference) {
  const questionnaireId = reference.questionnaireId.trim();
  const definitionEventId = reference.definitionEventId?.trim() ?? "";
  const definitionHash = reference.definitionHash?.trim() ?? "";
  if (!questionnaireId || !definitionEventId || !definitionHash || typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(referenceStorageKey());
    const cache = raw ? JSON.parse(raw) as Record<string, QuestionnaireDefinitionReference> : {};
    cache[questionnaireId] = { ...reference, questionnaireId, definitionEventId, definitionHash };
    window.localStorage.setItem(referenceStorageKey(), JSON.stringify(cache));
    return cache[questionnaireId];
  } catch {
    return null;
  }
}

export function readCachedQuestionnaireDefinitionReference(questionnaireId: string) {
  const id = questionnaireId.trim();
  if (!id || typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(referenceStorageKey());
    const reference = raw
      ? (JSON.parse(raw) as Record<string, QuestionnaireDefinitionReference>)[id] ?? null
      : null;
    return reference?.definitionEventId?.trim() && reference.definitionHash?.trim() ? reference : null;
  } catch {
    return null;
  }
}

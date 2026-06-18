import type {
  QuestionnaireDefinition,
  QuestionnaireDefinitionReference,
} from "./questionnaireProtocol";
import { sha256HexRust } from "./wasm/auditableVotingCore";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

function stableJsonStringify(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot hash a questionnaire definition with a non-finite number.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}
export function questionnaireDefinitionHash(definition: QuestionnaireDefinition) {
  return sha256HexRust(stableJsonStringify(definition as unknown as JsonValue));
}

export function selectNewestMatchingQuestionnaireDefinition(
  questionnaireId: string,
  definitions: Array<QuestionnaireDefinition | null | undefined>,
) {
  const targetId = questionnaireId.trim();
  if (!targetId) {
    return null;
  }
  return definitions
    .filter((definition): definition is QuestionnaireDefinition => (
      Boolean(definition)
      && definition.questionnaireId === targetId
    ))
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))[0] ?? null;
}

export function buildQuestionnaireDefinitionReference(input: {
  definition: QuestionnaireDefinition;
  definitionEventId?: string | null;
  relays?: string[] | null;
}): QuestionnaireDefinitionReference {
  const relays = input.relays ?? input.definition.questionnaireRelays ?? [];
  return {
    questionnaireId: input.definition.questionnaireId,
    coordinatorNpub: input.definition.coordinatorPubkey,
    relays: relays.length > 0 ? relays : undefined,
    definitionHash: questionnaireDefinitionHash(input.definition),
    definitionEventId: input.definitionEventId?.trim() || null,
    createdAt: Number.isFinite(input.definition.createdAt) ? input.definition.createdAt : null,
  };
}

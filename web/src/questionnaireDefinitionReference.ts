import type {
  QuestionnaireDefinition,
  QuestionnaireDefinitionReference,
} from "./questionnaireProtocol";
import { canonicaliseQuestionnaireDefinitionText } from "./questionnaireProtocol";
import { readCachedQuestionnaireDefinitionReference } from "./questionnaireDefinitionCache";
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

/**
 * Canonical JSON for a questionnaire definition event payload.
 *
 * This string - not the in-memory object - is what the definition hash covers. It must
 * stay byte-identical to `canonical_json` in worker/src/main.rs: object keys sorted
 * ascending, no insignificant whitespace, JSON string escaping, non-ASCII emitted raw as
 * UTF-8. `web/src/fixtures/questionnaireDefinitionHashVectors.json` carries vectors that
 * both implementations are asserted against.
 */
export function questionnaireDefinitionCanonicalJson(value: unknown): string {
  return stableJsonStringify(value as JsonValue | undefined);
}

/**
 * The wire hash: `sha256(canonicalJson(definition))`.
 *
 * This MUST agree with the Rust worker, which hashes
 * `canonical_json(JSON.parse(event.content))` of the definition event it receives
 * (worker/src/main.rs::questionnaire_definition_hash) and compares that with the hash the
 * ballot plan / issuance / worker config pinned. The definition is therefore hashed
 * exactly as it appears on the wire and is deliberately NOT canonicalised here:
 * canonicalising would make the two sides disagree for every definition published before
 * multilingual `LocalisedText` text fields existed, because the worker keeps hashing the
 * bare-string bytes while this function would return the digest of the upgraded shape.
 *
 * Shape stability lives in `questionnaireDefinitionShapeHashV2` (exposed as the separate
 * `definitionHashV2` reference field) so that this field never changes meaning.
 */
export function questionnaireDefinitionHash(definition: QuestionnaireDefinition) {
  return sha256HexRust(questionnaireDefinitionCanonicalJson(definition));
}

/**
 * Shape-stable companion hash (B1 v2), surfaced as `QuestionnaireDefinitionReference
 * .definitionHashV2`.
 *
 * This is the hash that survives the "bare string" -> `LocalisedText` upgrade: a
 * definition published before multi-language support and the same definition republished
 * with `{ en: "..." }` fields produce the same digest. It is NOT the value to compare with
 * the Rust worker, which only ever sees the raw event content - use
 * `questionnaireDefinitionHash` / `resolveQuestionnaireDefinitionHash` for that.
 */
export function questionnaireDefinitionShapeHashV2(definition: QuestionnaireDefinition) {
  return sha256HexRust(
    questionnaireDefinitionCanonicalJson(
      canonicaliseQuestionnaireDefinitionText(definition) as unknown as JsonValue,
    ),
  );
}

export function questionnaireDefinitionEventHash(content: string) {
  const parsed = JSON.parse(content) as JsonValue;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Questionnaire definition event content must be a JSON object.");
  }
  return sha256HexRust(questionnaireDefinitionCanonicalJson(parsed));
}

/**
 * Every definition hash that legitimately identifies `definition`, in the order the
 * caller should trust them:
 *
 * 1. the hash captured from the definition event's wire content at ingest
 *    (`storeCachedQuestionnaireDefinitionReference`, written by questionnaireTransport.ts
 *    and by the runtime's definition ingest), and
 * 2. the hash recomputed from the in-memory object.
 *
 * Ingest canonicalises text fields (questionnaireNostr.ts:302,766;
 * questionnaireDefinitionCache.ts:21,55), so for a definition published with bare strings
 * the in-memory object is NOT the document the Rust worker hashed: (2) diverges from (1).
 * Comparisons against a worker / plan / issuance pin must therefore accept either witness,
 * and producers must publish the wire witness (`resolveQuestionnaireDefinitionHash`).
 */
export function questionnaireDefinitionWitnessHashes(
  questionnaireId: string | null | undefined,
  definition: QuestionnaireDefinition | null | undefined,
): string[] {
  const hashes: string[] = [];
  const id = questionnaireId?.trim() || definition?.questionnaireId?.trim() || "";
  const carried = id
    ? readCachedQuestionnaireDefinitionReference(id)?.definitionHash?.trim() ?? ""
    : "";
  if (carried) {
    hashes.push(carried);
  }
  if (definition) {
    const recomputed = questionnaireDefinitionHash(definition);
    if (!hashes.includes(recomputed)) {
      hashes.push(recomputed);
    }
  }
  return hashes;
}

/**
 * The hash to pin for `definition`: the carried wire hash when one was captured at ingest,
 * otherwise the hash recomputed from the object.
 *
 * "Carry the wire hash instead of recomputing" is what keeps TS and Rust in agreement for
 * definitions whose on-disk object shape differs from their wire shape.
 */
export function resolveQuestionnaireDefinitionHash(
  questionnaireId: string | null | undefined,
  definition: QuestionnaireDefinition | null | undefined,
): string | null {
  return questionnaireDefinitionWitnessHashes(questionnaireId, definition)[0] ?? null;
}

/** True when `candidate` pins `definition` under any of its witness hashes. */
export function questionnaireDefinitionHashMatches(
  candidate: string | null | undefined,
  questionnaireId: string | null | undefined,
  definition: QuestionnaireDefinition | null | undefined,
): boolean {
  const expected = candidate?.trim() ?? "";
  if (!expected) {
    return false;
  }
  return questionnaireDefinitionWitnessHashes(questionnaireId, definition).includes(expected);
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
      definition !== null
      && definition !== undefined
      && definition.questionnaireId === targetId
    ))
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))[0] ?? null;
}

export function buildQuestionnaireDefinitionReference(input: {
  definition: QuestionnaireDefinition;
  definitionEventId?: string | null;
  definitionHash?: string | null;
  relays?: string[] | null;
}): QuestionnaireDefinitionReference {
  const relays = input.relays ?? input.definition.questionnaireRelays ?? [];
  return {
    questionnaireId: input.definition.questionnaireId,
    coordinatorNpub: input.definition.coordinatorPubkey,
    relays: relays.length > 0 ? relays : undefined,
    definitionHash: input.definitionHash?.trim() || questionnaireDefinitionHash(input.definition),
    definitionHashV2: questionnaireDefinitionShapeHashV2(input.definition),
    definitionEventId: input.definitionEventId?.trim() || null,
    createdAt: Number.isFinite(input.definition.createdAt) ? input.definition.createdAt : null,
  };
}

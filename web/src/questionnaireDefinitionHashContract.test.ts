// @vitest-environment jsdom
/**
 * Cross-language contract for the questionnaire definition hash (Track B / B1).
 *
 * The Rust worker pins a definition with
 * `sha256_hex(canonical_json(JSON.parse(event.content)))` - a real SHA-256 over the *wire*
 * document. The web app has to agree with it, and it has two ways to reach a hash:
 *
 *   1. from the wire bytes (`questionnaireDefinitionEventHash(content)`), which is what the
 *      worker hashed, and
 *   2. from an in-memory object (`questionnaireDefinitionHash(definition)`).
 *
 * Correctness of (2) depends on the object still being the document that was published.
 * Ingest canonicalises bare-string text fields to `LocalisedText`
 * (questionnaireNostr.ts:302,766; questionnaireDefinitionCache.ts:21,55), so for a definition
 * published in the pre-multilingual shape the in-memory object is a DIFFERENT document from
 * the one the worker hashed. Consumers must therefore read the wire hash that ingest carried
 * forward (`resolveQuestionnaireDefinitionHash`) rather than re-deriving it from the object.
 *
 * Vitest cannot verify the *digest* through the app: vite.config.ts aliases
 * `./wasm/auditableVotingCore` to a mock whose `sha256HexRust` is an FNV-1a stand-in
 * (auditableVotingCore.mock.ts:73-81). This suite therefore asserts the digest twice over:
 *
 *   - the committed fixture carries the real SHA-256 of each canonical pre-image and is
 *     asserted independently by `node:crypto` here, and
 *   - the same fixture is asserted by the worker's real SHA-256 in
 *     worker/src/main.rs (`definition_hash_vectors_match_the_shared_fixture`).
 *
 * Together those two assertions are the contract: same pre-image, same digest, both sides.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import vectorsFixture from "./fixtures/questionnaireDefinitionHashVectors.json";
import {
  buildQuestionnaireDefinitionReference,
  questionnaireDefinitionCanonicalJson,
  questionnaireDefinitionEventHash,
  questionnaireDefinitionHash,
  questionnaireDefinitionHashMatches,
  questionnaireDefinitionShapeHashV2,
  resolveQuestionnaireDefinitionHash,
} from "./questionnaireDefinitionReference";
import {
  storeCachedQuestionnaireDefinitionReference,
} from "./questionnaireDefinitionCache";
import type { QuestionnaireDefinition } from "./questionnaireProtocol";
import { canonicaliseQuestionnaireDefinitionText } from "./questionnaireProtocol";

type VectorForm = { content: string; canonical: string; sha256: string };
type Vector = { name: string; note: string; sha256: string; forms: VectorForm[] };

const vectors = (vectorsFixture as { vectors: Vector[] }).vectors;

function vectorNamed(name: string): Vector {
  const found = vectors.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`fixture vector ${name} is missing`);
  }
  return found;
}

function realSha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A definition in the pre-multilingual wire shape: every text field is a bare string. */
function legacyWireDefinition(): QuestionnaireDefinition {
  return {
    schemaVersion: 1,
    eventType: "questionnaire_definition",
    responseMode: "blind_token",
    questionnaireId: "q_legacy_wire",
    title: "Municipal budget 2026",
    description: "Choose the projects to fund.",
    createdAt: 1_774_310_400,
    openAt: 1_774_310_400,
    closeAt: 1_774_396_800,
    coordinatorPubkey: "npub1coordinator",
    coordinatorEncryptionPubkey: "npub1coordinator",
    responseVisibility: "public",
    eligibilityMode: "allowlist",
    allowMultipleResponsesPerPubkey: false,
    questions: [
      { questionId: "q1", type: "yes_no", prompt: "Fund the bike lane?", required: true },
    ],
  } as unknown as QuestionnaireDefinition;
}

describe("questionnaire definition hash contract", () => {
  it("produces the canonical JSON the Rust worker hashes, for every committed wire form", () => {
    for (const vector of vectors) {
      for (const form of vector.forms) {
        expect(
          questionnaireDefinitionCanonicalJson(JSON.parse(form.content)),
          `${vector.name}: canonical JSON`,
        ).toBe(form.canonical);
      }
    }
  });

  it("keeps the fixture self-consistent (canonical form is the same document)", () => {
    for (const vector of vectors) {
      for (const form of vector.forms) {
        expect(JSON.parse(form.canonical), `${vector.name}: canonical document`).toEqual(
          JSON.parse(form.content),
        );
      }
    }
  });

  it("reproduces every committed fixture digest with a real SHA-256", () => {
    // The fixture digests were generated outside this repo (independent Python) and are
    // asserted from the Rust side too. Recomputing them here proves the fixture is the
    // genuine SHA-256 of the canonical string this module emits - not a snapshot of the
    // FNV mock - so a drift in `questionnaireDefinitionCanonicalJson` fails the build.
    let checked = 0;
    for (const vector of vectors) {
      expect(vector.sha256, `${vector.name}: fixture digest is a sha256`).toMatch(/^[0-9a-f]{64}$/);
      for (const form of vector.forms) {
        const canonical = questionnaireDefinitionCanonicalJson(JSON.parse(form.content));
        expect(realSha256(canonical), `${vector.name}: real sha256 of the pre-image`).toBe(
          vector.sha256,
        );
        checked += 1;
      }
    }
    expect(checked, "expected at least three wire forms in the fixture").toBeGreaterThanOrEqual(3);
  });

  it("canonicalises key order and whitespace but never array order", () => {
    const vector = vectorNamed("canonical-multilingual");
    expect(vector.forms).toHaveLength(2);
    const [canonicalForm, scrambledForm] = vector.forms;
    expect(canonicalForm.content).not.toBe(scrambledForm.content);
    expect(questionnaireDefinitionCanonicalJson(JSON.parse(scrambledForm.content))).toBe(
      questionnaireDefinitionCanonicalJson(JSON.parse(canonicalForm.content)),
    );
  });

  it("hashes the raw wire bytes, not the canonicalised in-memory definition", () => {
    const legacy = vectorNamed("legacy-plain-string");
    const form = legacy.forms[0];
    const parsed = JSON.parse(form.content) as unknown as QuestionnaireDefinition;

    // Same bytes through either entry point must produce the same hash: this is what lets
    // the TS side compare itself with the hash the Rust worker derives from the event.
    expect(questionnaireDefinitionEventHash(form.content)).toBe(questionnaireDefinitionHash(parsed));
    expect(questionnaireDefinitionCanonicalJson(parsed)).toBe(form.canonical);

    // Ingest upgrades bare-string text fields to `LocalisedText` (questionnaireNostr.ts:302,
    // questionnaireDefinitionCache.ts:21). That upgraded object is a DIFFERENT document on the
    // wire, so it must NOT hash to the same value as the bytes the worker received - otherwise
    // a client that ingests an older definition would silently disagree with the Rust worker
    // about which definition the ballot pins.
    const canonicalised = canonicaliseQuestionnaireDefinitionText(parsed) as unknown as QuestionnaireDefinition;
    expect(questionnaireDefinitionCanonicalJson(canonicalised)).not.toBe(form.canonical);
    expect(questionnaireDefinitionHash(canonicalised)).not.toBe(questionnaireDefinitionHash(parsed));
  });

  it("agrees with the worker on non-ASCII and escaped text", () => {
    const vector = vectorNamed("unicode-escaping-parity");
    const form = vector.forms[0];
    expect(questionnaireDefinitionCanonicalJson(JSON.parse(form.content))).toBe(form.canonical);
    // Non-ASCII must stay raw UTF-8 (exactly what `serde_json::to_string` emits); an escaped
    // form would be a different byte sequence and therefore a different hash.
    expect(form.canonical).toContain("é");
    expect(form.canonical).toContain("இது தமிழ்");
    expect(form.canonical).not.toContain("\\u00e9");
  });
});

describe("definition hash consumers carry the wire hash (object vs wire audit)", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("prefers the wire hash ingest carried forward over the canonicalised object hash", () => {
    const definition = legacyWireDefinition();
    const questionnaireId = definition.questionnaireId;
    const wireContent = JSON.stringify(definition);
    const wireHash = questionnaireDefinitionEventHash(wireContent);
    const canonicalised = canonicaliseQuestionnaireDefinitionText(definition);

    // Precondition - the divergence the B1 correction is about really exists: the ingested
    // object no longer hashes to the bytes the worker hashed.
    const objectHash = questionnaireDefinitionHash(canonicalised);
    expect(objectHash).not.toBe(wireHash);
    // Same bytes, either entry point, in unit tests: `questionnaireDefinitionEventHash` and
    // `questionnaireDefinitionHash` must not disagree because one of them canonicalised first.
    expect(questionnaireDefinitionHash(JSON.parse(wireContent) as unknown as QuestionnaireDefinition))
      .toBe(wireHash);

    // With no carried hash the object-derived comparison would reject the worker's hash.
    expect(resolveQuestionnaireDefinitionHash(questionnaireId, canonicalised)).toBe(objectHash);
    expect(questionnaireDefinitionHashMatches(wireHash, questionnaireId, canonicalised)).toBe(false);

    // Ingest (questionnaireOptionARuntime.ts `cacheQuestionnaireDefinitionForRuntime`) records
    // the wire hash of the event it parsed. From then on every consumer that asks "what hash is
    // this questionnaire?" gets the worker's hash, and the false mismatch is gone.
    const reference = buildQuestionnaireDefinitionReference({
      definition: canonicalised,
      definitionEventId: "event-legacy-1",
      definitionHash: wireHash,
    });
    expect(reference?.definitionHash).toBe(wireHash);
    expect(storeCachedQuestionnaireDefinitionReference(reference!)).not.toBeNull();

    expect(resolveQuestionnaireDefinitionHash(questionnaireId, canonicalised)).toBe(wireHash);
    expect(questionnaireDefinitionHashMatches(wireHash, questionnaireId, canonicalised)).toBe(true);
    // A genuinely different definition is still rejected: the check is not simply disabled.
    expect(
      questionnaireDefinitionHashMatches(
        realSha256("a different definition"),
        questionnaireId,
        canonicalised,
      ),
    ).toBe(false);
    // And an empty/missing pin never matches.
    expect(questionnaireDefinitionHashMatches("", questionnaireId, canonicalised)).toBe(false);
    expect(questionnaireDefinitionHashMatches(null, questionnaireId, canonicalised)).toBe(false);
  });

  it("keeps a multi-locale publish agreeing with its own wire hash", () => {
    const definition = canonicaliseQuestionnaireDefinitionText(legacyWireDefinition());
    const wireContent = JSON.stringify(definition);
    const wireHash = questionnaireDefinitionEventHash(wireContent);

    // Canonicalising an already-canonical definition is idempotent, so for a definition this
    // client published itself the object hash and the wire hash coincide. That is why the
    // object-derived fallback stays safe wherever no wire hash was carried.
    expect(questionnaireDefinitionHash(definition)).toBe(wireHash);
    expect(canonicaliseQuestionnaireDefinitionText(definition)).toEqual(definition);
  });

  it("keeps shape stability on the versioned hash instead of the wire hash", () => {
    const bare = legacyWireDefinition();
    const canonicalised = canonicaliseQuestionnaireDefinitionText(bare);

    // The wire hash is deliberately byte-exact (it must equal what Rust computed)...
    expect(questionnaireDefinitionHash(bare)).not.toBe(questionnaireDefinitionHash(canonicalised));
    // ...so the "same questionnaire, only re-localised" identity lives on the new versioned
    // hash, which is never used as the wire pin.
    expect(questionnaireDefinitionShapeHashV2(bare)).toBe(questionnaireDefinitionShapeHashV2(canonicalised));
  });
});

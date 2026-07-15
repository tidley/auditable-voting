// @vitest-environment jsdom
import { nip19, type Filter, type NostrEvent } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const querySync = vi.hoisted(() => vi.fn());

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({
    querySync,
  }),
}));

import { fetchLatestQuestionnaireDefinitionByCoordinator, fetchQuestionnaireActiveWorkerDelegationForCapability } from "./questionnaireTransport";
import { questionnaireDefinitionEventHash } from "./questionnaireDefinitionReference";
import { readCachedQuestionnaireDefinitionReference } from "./questionnaireDefinitionCache";
import { OPTIONA_WORKER_DELEGATION_KIND, type WorkerDelegationCertificate } from "./questionnaireWorkerDelegation";
import { buildIssueBlindTokensWorkerRouting, mergeBlindRequestRoutingRelays } from "./questionnaireWorkerRouting";

function eventForDelegation(input: {
  id: string;
  coordinatorHex: string;
  delegation: WorkerDelegationCertificate;
  tags?: string[][];
  createdAt?: number;
}): NostrEvent {
  return {
    id: input.id,
    kind: OPTIONA_WORKER_DELEGATION_KIND,
    pubkey: input.coordinatorHex,
    created_at: input.createdAt ?? 1781311216,
    tags: input.tags ?? [["t", "optiona_worker_delegation"]],
    content: JSON.stringify(input.delegation),
    sig: "sig",
  };
}

describe("questionnaire worker routing", () => {
  const coordinatorHex = "a".repeat(64);
  const coordinatorNpub = nip19.npubEncode(coordinatorHex);
  const workerNpub = nip19.npubEncode("b".repeat(64));

  beforeEach(() => {
    querySync.mockReset();
    window.localStorage.clear();
  });

  it("finds old worker delegations by organiser author when they lack a questionnaire tag", async () => {
    const delegation: WorkerDelegationCertificate = {
      type: "worker_delegation",
      schemaVersion: 1,
      delegationId: "delegation_legacy_without_q_tag",
      electionId: "q_legacy",
      coordinatorNpub,
      workerNpub,
      capabilities: ["issue_blind_tokens"],
      controlRelays: ["wss://relay.nostr.net", "wss://nos.lol"],
      issuedAt: "2026-06-13T00:40:16.219Z",
      expiresAt: "2036-06-10T00:40:16.219Z",
    };
    const legacyEvent = eventForDelegation({
      id: "legacy-delegation-event",
      coordinatorHex,
      delegation,
    });

    querySync.mockImplementation(async (_relays: string[], filter: Filter) => {
      if (filter.authors?.includes(coordinatorHex)) {
        return [legacyEvent];
      }
      return [];
    });

    const found = await fetchQuestionnaireActiveWorkerDelegationForCapability({
      questionnaireId: "q_legacy",
      capability: "issue_blind_tokens",
      relays: ["wss://relay.nostr.net"],
      coordinatorNpub,
    });

    expect(found?.workerNpub).toBe(workerNpub);
    expect(found?.delegationId).toBe("delegation_legacy_without_q_tag");
    expect(querySync).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        authors: [coordinatorHex],
        kinds: [OPTIONA_WORKER_DELEGATION_KIND],
      }),
    );
  });

  it("does not route to a newer delegation from another organiser using the same questionnaire ID", async () => {
    const otherCoordinatorHex = "c".repeat(64);
    const otherCoordinatorNpub = nip19.npubEncode(otherCoordinatorHex);
    const otherWorkerNpub = nip19.npubEncode("d".repeat(64));
    const ownDelegation: WorkerDelegationCertificate = {
      type: "worker_delegation",
      schemaVersion: 1,
      delegationId: "delegation_own_worker",
      electionId: "q_shared",
      coordinatorNpub,
      workerNpub,
      capabilities: ["issue_blind_tokens"],
      controlRelays: ["wss://relay.nostr.net"],
      issuedAt: "2026-06-13T00:40:16.219Z",
      expiresAt: "2036-06-10T00:40:16.219Z",
    };
    const otherDelegation: WorkerDelegationCertificate = {
      ...ownDelegation,
      delegationId: "delegation_other_worker",
      coordinatorNpub: otherCoordinatorNpub,
      workerNpub: otherWorkerNpub,
      issuedAt: "2026-06-13T00:41:16.219Z",
    };
    const forgedDelegation: WorkerDelegationCertificate = {
      ...ownDelegation,
      delegationId: "delegation_forged_author",
      workerNpub: otherWorkerNpub,
      issuedAt: "2026-06-13T00:42:16.219Z",
    };
    const ownEvent = eventForDelegation({
      id: "own-delegation-event",
      coordinatorHex,
      delegation: ownDelegation,
      createdAt: 20,
    });
    const otherEvent = eventForDelegation({
      id: "other-delegation-event",
      coordinatorHex: otherCoordinatorHex,
      delegation: otherDelegation,
      createdAt: 30,
    });
    const forgedEvent = eventForDelegation({
      id: "forged-delegation-event",
      coordinatorHex: otherCoordinatorHex,
      delegation: forgedDelegation,
      createdAt: 40,
    });
    querySync.mockResolvedValue([forgedEvent, otherEvent, ownEvent]);

    const found = await fetchQuestionnaireActiveWorkerDelegationForCapability({
      questionnaireId: "q_shared",
      capability: "issue_blind_tokens",
      relays: ["wss://relay.nostr.net"],
      coordinatorNpub,
    });

    expect(found?.delegationId).toBe("delegation_own_worker");
    expect(found?.workerNpub).toBe(workerNpub);
  });

  it("uses explicit worker DM relays before public control relays for blind requests", () => {
    const routing = buildIssueBlindTokensWorkerRouting({
      delegationId: "delegation_dm_relays",
      workerNpub,
      controlRelays: ["wss://nos.lol", "wss://relay.damus.io"],
      dmRelays: ["wss://vm-1734.lnvps.cloud/", "wss://relay.nostr.net"],
    });

    const relays = mergeBlindRequestRoutingRelays(["wss://fallback.example"], routing);

    expect(relays).toEqual([
      "wss://vm-1734.lnvps.cloud/",
      "wss://relay.nostr.net",
      "wss://fallback.example",
    ]);
  });

  it("selects the latest definition signed and declared by the organiser", async () => {
    const otherHex = "c".repeat(64);
    const definition = {
      schemaVersion: 1,
      eventType: "questionnaire_definition",
      questionnaireId: "q_public",
      coordinatorPubkey: coordinatorNpub,
      questions: [],
    };
    const validEvent = {
      id: "valid-definition",
      kind: 6420,
      pubkey: coordinatorHex,
      created_at: 20,
      tags: [["q", "q_public"]],
      content: JSON.stringify(definition),
      sig: "sig",
    } as NostrEvent;
    const wrongAuthorEvent = {
      ...validEvent,
      id: "wrong-author-definition",
      pubkey: otherHex,
      created_at: 30,
    };
    querySync.mockResolvedValue([wrongAuthorEvent, validEvent]);

    const found = await fetchLatestQuestionnaireDefinitionByCoordinator({
      questionnaireId: "q_public",
      coordinatorNpub,
      relays: ["wss://relay.nostr.net"],
    });

    expect(found?.event.id).toBe("valid-definition");
    expect(found?.definitionHash).toBe(questionnaireDefinitionEventHash(validEvent.content));
    expect(readCachedQuestionnaireDefinitionReference("q_public")).toMatchObject({
      definitionEventId: "valid-definition",
      definitionHash: questionnaireDefinitionEventHash(validEvent.content),
    });
  });

  it("does not fall back to public control relays for blind request DMs", () => {
    const routing = buildIssueBlindTokensWorkerRouting({
      delegationId: "delegation_legacy_public_relays",
      workerNpub,
      controlRelays: ["wss://nos.lol", "wss://relay.damus.io"],
    });

    const relays = mergeBlindRequestRoutingRelays(["wss://vm-1734.lnvps.cloud/"], routing);

    expect(relays).toEqual(["wss://vm-1734.lnvps.cloud/"]);
  });
});

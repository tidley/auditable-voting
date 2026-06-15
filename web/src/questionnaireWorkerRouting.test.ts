// @vitest-environment jsdom
import { nip19, type Filter, type NostrEvent } from "nostr-tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const querySync = vi.hoisted(() => vi.fn());

vi.mock("./sharedNostrPool", () => ({
  getSharedNostrPool: () => ({
    querySync,
  }),
}));

import { fetchQuestionnaireActiveWorkerDelegationForCapability } from "./questionnaireTransport";
import { OPTIONA_WORKER_DELEGATION_KIND, type WorkerDelegationCertificate } from "./questionnaireWorkerDelegation";

function eventForDelegation(input: {
  id: string;
  coordinatorHex: string;
  delegation: WorkerDelegationCertificate;
  tags?: string[][];
}): NostrEvent {
  return {
    id: input.id,
    kind: OPTIONA_WORKER_DELEGATION_KIND,
    pubkey: input.coordinatorHex,
    created_at: 1781311216,
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
});

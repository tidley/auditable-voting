// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  loadStoredWorkerDelegation,
  upsertStoredWorkerDelegation,
  type WorkerDelegationCertificate,
} from "./questionnaireWorkerDelegation";

function delegation(delegationId: string, issuedAt: string): WorkerDelegationCertificate {
  return {
    type: "worker_delegation",
    schemaVersion: 1,
    delegationId,
    electionId: "q_storage_race",
    coordinatorNpub: "npub1coordinator",
    workerNpub: "npub1worker",
    capabilities: ["issue_blind_tokens"],
    controlRelays: ["wss://relay.example"],
    issuedAt,
    expiresAt: "2026-07-14T12:00:00.000Z",
  };
}

describe("worker delegation storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("does not let an older async confirmation replace a newer delegation", () => {
    const newer = delegation("delegation_newer", "2026-07-13T11:47:50.000Z");
    const older = delegation("delegation_older", "2026-07-13T11:47:48.000Z");

    upsertStoredWorkerDelegation({
      electionId: newer.electionId,
      mode: "delegated_worker",
      activeDelegation: newer,
      lastRevocation: null,
      lastUpdatedAt: newer.issuedAt,
    });
    const stored = upsertStoredWorkerDelegation({
      electionId: older.electionId,
      mode: "delegated_worker",
      activeDelegation: older,
      lastRevocation: null,
      lastUpdatedAt: older.issuedAt,
    });

    expect(stored?.activeDelegation?.delegationId).toBe(newer.delegationId);
    expect(loadStoredWorkerDelegation(newer.electionId)?.activeDelegation?.delegationId).toBe(newer.delegationId);
  });
});

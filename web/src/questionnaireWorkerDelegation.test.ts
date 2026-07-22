// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  loadStoredWorkerDelegation,
  nextWorkerElectionConfigVersion,
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

  it("monotonically versions rapid proxy and ballot-group config updates", () => {
    const active = delegation("delegation_active", "2026-07-13T11:47:50.000Z");
    upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "delegated_worker",
      activeDelegation: active,
      lastRevocation: null,
      lastUpdatedAt: active.issuedAt,
    });

    const proxyUpdateVersion = nextWorkerElectionConfigVersion({
      electionId: active.electionId,
      delegationId: active.delegationId,
    });
    const ballotGroupUpdateVersion = nextWorkerElectionConfigVersion({
      electionId: active.electionId,
      delegationId: active.delegationId,
    });

    expect(proxyUpdateVersion).toBe(1);
    expect(ballotGroupUpdateVersion).toBe(2);
    expect(loadStoredWorkerDelegation(active.electionId)?.lastConfigVersion).toBe(2);
  });

  it("retains the config version when recording a successful config sync", () => {
    const active = delegation("delegation_active", "2026-07-13T11:47:50.000Z");
    upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "delegated_worker",
      activeDelegation: active,
      lastRevocation: null,
      lastUpdatedAt: active.issuedAt,
    });
    expect(nextWorkerElectionConfigVersion({ electionId: active.electionId, delegationId: active.delegationId })).toBe(1);

    upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "delegated_worker",
      activeDelegation: active,
      lastRevocation: null,
      lastUpdatedAt: "2026-07-13T11:48:00.000Z",
      lastConfigSyncKey: "sent-config",
    });

    expect(nextWorkerElectionConfigVersion({ electionId: active.electionId, delegationId: active.delegationId })).toBe(2);
  });
});

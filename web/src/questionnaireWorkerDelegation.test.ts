// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  loadStoredWorkerDelegation,
  nextWorkerElectionConfigVersion,
  selectWorkerDelegationForConfig,
  upsertStoredWorkerDelegation,
  type WorkerDelegationCertificate,
  type WorkerDelegationRevocation,
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

function revocation(active: WorkerDelegationCertificate): WorkerDelegationRevocation {
  return {
    type: "worker_delegation_revocation",
    schemaVersion: 1,
    delegationId: active.delegationId,
    electionId: active.electionId,
    coordinatorNpub: active.coordinatorNpub,
    workerNpub: active.workerNpub,
    revokedAt: "2026-07-13T12:00:00.000Z",
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

  it("does not let a non-revoking browser-only write erase an active delegation", () => {
    const active = delegation("delegation_active", "2026-07-13T11:47:50.000Z");
    upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "delegated_worker",
      activeDelegation: active,
      lastRevocation: null,
      lastUpdatedAt: active.issuedAt,
    });
    expect(nextWorkerElectionConfigVersion({ electionId: active.electionId, delegationId: active.delegationId })).toBe(1);

    const stored = upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "browser_only",
      activeDelegation: null,
      lastRevocation: null,
      lastUpdatedAt: "2026-07-13T12:00:00.000Z",
    });

    expect(stored).toMatchObject({
      mode: "delegated_worker",
      activeDelegation: { delegationId: active.delegationId },
      lastConfigVersion: 1,
    });
    expect(nextWorkerElectionConfigVersion({ electionId: active.electionId, delegationId: active.delegationId })).toBe(2);
  });

  it("clears an active delegation when the write contains its explicit revocation", () => {
    const active = delegation("delegation_active", "2026-07-13T11:47:50.000Z");
    upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "delegated_worker",
      activeDelegation: active,
      lastRevocation: null,
      lastUpdatedAt: active.issuedAt,
    });
    nextWorkerElectionConfigVersion({ electionId: active.electionId, delegationId: active.delegationId });

    const stored = upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "browser_only",
      activeDelegation: null,
      lastRevocation: revocation(active),
      lastUpdatedAt: "2026-07-13T12:00:00.000Z",
    });

    expect(stored?.activeDelegation).toBeNull();
    expect(stored?.lastConfigVersion).toBeUndefined();
  });

  it("recovers a missing selected delegation with an epoch-based version floor", () => {
    const active = delegation("delegation_recovered", "2026-07-13T11:47:50.000Z");
    upsertStoredWorkerDelegation({
      electionId: active.electionId,
      mode: "browser_only",
      activeDelegation: null,
      lastRevocation: null,
      lastUpdatedAt: active.issuedAt,
    });

    const recoveredVersion = nextWorkerElectionConfigVersion({
      electionId: active.electionId,
      delegationId: active.delegationId,
      recoveryDelegation: active,
    });
    const subsequentVersion = nextWorkerElectionConfigVersion({
      electionId: active.electionId,
      delegationId: active.delegationId,
      recoveryDelegation: active,
    });

    expect(recoveredVersion).not.toBeNull();
    expect(recoveredVersion!).toBeGreaterThan(1);
    expect(subsequentVersion).toBe(recoveredVersion! + 1);
    expect(loadStoredWorkerDelegation(active.electionId)?.activeDelegation?.delegationId).toBe(active.delegationId);
  });

  it("does not recover over another active delegation or an explicit revocation", () => {
    const selected = delegation("delegation_selected", "2026-07-13T11:47:50.000Z");
    const different = delegation("delegation_different", "2026-07-13T11:48:00.000Z");
    upsertStoredWorkerDelegation({
      electionId: selected.electionId,
      mode: "delegated_worker",
      activeDelegation: different,
      lastRevocation: null,
      lastUpdatedAt: different.issuedAt,
    });

    expect(nextWorkerElectionConfigVersion({
      electionId: selected.electionId,
      delegationId: selected.delegationId,
      recoveryDelegation: selected,
    })).toBeNull();
    expect(loadStoredWorkerDelegation(selected.electionId)?.activeDelegation?.delegationId).toBe(different.delegationId);

    window.localStorage.clear();
    upsertStoredWorkerDelegation({
      electionId: selected.electionId,
      mode: "browser_only",
      activeDelegation: null,
      lastRevocation: revocation(selected),
      lastUpdatedAt: "2026-07-13T12:00:00.000Z",
    });
    expect(nextWorkerElectionConfigVersion({
      electionId: selected.electionId,
      delegationId: selected.delegationId,
      recoveryDelegation: selected,
    })).toBeNull();
    expect(loadStoredWorkerDelegation(selected.electionId)?.activeDelegation).toBeNull();
  });

  it("uses only a valid stored delegation while recovered parent state has not rendered", () => {
    const active = delegation("delegation_recovered", "2026-07-13T11:47:50.000Z");
    const staleSelected = delegation("delegation_stale_render", "2026-07-13T11:47:40.000Z");
    const stored = {
      electionId: active.electionId,
      mode: "delegated_worker" as const,
      activeDelegation: active,
      lastRevocation: null,
      lastUpdatedAt: active.issuedAt,
    };

    expect(selectWorkerDelegationForConfig({
      electionId: active.electionId,
      selectedDelegation: staleSelected,
      storedDelegation: stored,
      now: new Date("2026-07-13T12:00:00.000Z"),
    })).toBe(active);
    expect(selectWorkerDelegationForConfig({
      electionId: "q_other",
      selectedDelegation: null,
      storedDelegation: stored,
      now: new Date("2026-07-13T12:00:00.000Z"),
    })).toBeNull();
    expect(selectWorkerDelegationForConfig({
      electionId: active.electionId,
      selectedDelegation: null,
      storedDelegation: { ...stored, mode: "browser_only" },
      now: new Date("2026-07-13T12:00:00.000Z"),
    })).toBeNull();
    expect(selectWorkerDelegationForConfig({
      electionId: active.electionId,
      selectedDelegation: null,
      storedDelegation: { ...stored, lastRevocation: revocation(active) },
      now: new Date("2026-07-13T12:00:00.000Z"),
    })).toBeNull();
    expect(selectWorkerDelegationForConfig({
      electionId: active.electionId,
      selectedDelegation: null,
      storedDelegation: stored,
      now: new Date(active.expiresAt),
    })).toBeNull();
    expect(selectWorkerDelegationForConfig({
      electionId: active.electionId,
      selectedDelegation: { ...active, electionId: "q_wrong" },
      storedDelegation: null,
      now: new Date("2026-07-13T12:00:00.000Z"),
    })).toBeNull();
  });
});

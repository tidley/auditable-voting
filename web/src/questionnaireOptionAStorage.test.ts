// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  loadAdmittedVoters,
  saveAdmittedVoters,
  type AdmittedVoterRecord,
} from "./questionnaireOptionAStorage";

describe("admitted voter storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("keeps legacy auto-ballot opt-outs in the roster without preserving the opt-out", () => {
    const coordinatorNpub = "npub1coordinator";
    const legacyRecord = {
      npub: "npub1voter",
      admittedAt: "2026-07-13T00:00:00.000Z",
      autoApply: false,
      lastUpdatedAt: "2026-07-13T00:00:00.000Z",
    } as AdmittedVoterRecord & { autoApply: boolean };

    saveAdmittedVoters({
      coordinatorNpub,
      voters: { [legacyRecord.npub]: legacyRecord },
    });

    const loaded = loadAdmittedVoters({ coordinatorNpub });
    expect(loaded[legacyRecord.npub]?.npub).toBe(legacyRecord.npub);
    expect(loaded[legacyRecord.npub]).not.toHaveProperty("autoApply");
  });
});

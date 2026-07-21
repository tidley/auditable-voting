// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  createEmptyVoterElectionLocalState,
  type BlindBallotPlan,
} from "./questionnaireOptionA";
import {
  loadAdmittedVoters,
  loadVoterState,
  saveAdmittedVoters,
  saveVoterState,
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

  it("preserves a custom voter-group assignment", () => {
    const coordinatorNpub = "npub1coordinator";
    const record: AdmittedVoterRecord = {
      npub: "npub1groupedvoter",
      admittedAt: "2026-07-13T00:00:00.000Z",
      source: "private_invite",
      ballotGroup: "group_north",
      lastUpdatedAt: "2026-07-13T00:00:00.000Z",
    };

    saveAdmittedVoters({ coordinatorNpub, voters: { [record.npub]: record } });

    expect(loadAdmittedVoters({ coordinatorNpub })[record.npub]?.ballotGroup).toBe("group_north");
  });
});

describe("voter blind ballot plan storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("restores a sanitised received plan after voter recovery", () => {
    const voterNpub = "npub1voter";
    const electionId = "election_1";
    const plan: BlindBallotPlan & { unexpected?: string } = {
      type: "blind_ballot_plan",
      schemaVersion: 1,
      planId: "plan_1",
      electionId,
      invitedNpub: voterNpub,
      issuerNpub: "npub1issuer",
      initialRequestId: "request_1",
      blindSigningKeyId: "key_1",
      credentialCount: 2,
      ballotScopes: [{ credentialIndex: 1 }, { credentialIndex: 2 }],
      issuedAt: "2026-07-21T00:00:00.000Z",
      unexpected: "discard me",
    };
    const state = createEmptyVoterElectionLocalState({
      electionId,
      invitedNpub: voterNpub,
      coordinatorNpub: "npub1coordinator",
      now: "2026-07-21T00:00:00.000Z",
    });

    saveVoterState({ voterNpub, state: { ...state, blindBallotPlan: plan } });

    const recovered = loadVoterState({ voterNpub, electionId });
    expect(recovered?.blindBallotPlan).toMatchObject({
      type: "blind_ballot_plan",
      schemaVersion: 1,
      planId: "plan_1",
      electionId,
      invitedNpub: voterNpub,
      issuerNpub: "npub1issuer",
      initialRequestId: "request_1",
      blindSigningKeyId: "key_1",
      credentialCount: 2,
      ballotScopes: [null, { credentialIndex: 2 }],
      issuedAt: "2026-07-21T00:00:00.000Z",
    });
    expect(recovered?.blindBallotPlan).not.toHaveProperty("unexpected");
  });

  it("discards an invalid persisted plan", () => {
    const voterNpub = "npub1voter";
    const electionId = "election_1";
    const state = createEmptyVoterElectionLocalState({
      electionId,
      invitedNpub: voterNpub,
      coordinatorNpub: "npub1coordinator",
      now: "2026-07-21T00:00:00.000Z",
    });

    saveVoterState({
      voterNpub,
      state: { ...state, blindBallotPlan: { type: "blind_ballot_plan", credentialCount: 3 } as never },
    });

    expect(loadVoterState({ voterNpub, electionId })).toBeNull();
  });
});

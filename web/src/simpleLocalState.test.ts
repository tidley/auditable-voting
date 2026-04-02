import { describe, expect, it } from "vitest";
import {
  buildSimpleActorBackupBundle,
  parseSimpleActorBackupBundle,
} from "./simpleLocalState";

describe("simpleLocalState", () => {
  it("builds and parses a voter backup bundle", () => {
    const bundle = buildSimpleActorBackupBundle("voter", {
      npub: "npub1example",
      nsec: "nsec1example",
    }, {
      manualCoordinators: ["npub1coord"],
      selectedVotingId: "round-1",
    });

    expect(bundle.role).toBe("voter");
    expect(bundle.type).toBe("auditable-voting.simple-backup");

    const parsed = parseSimpleActorBackupBundle(JSON.stringify(bundle));
    expect(parsed).toEqual(bundle);
    expect(parsed?.cache).toEqual({
      manualCoordinators: ["npub1coord"],
      selectedVotingId: "round-1",
    });
  });

  it("rejects malformed backup bundles", () => {
    expect(parseSimpleActorBackupBundle("{}")).toBeNull();
    expect(parseSimpleActorBackupBundle("{not-json")).toBeNull();
    expect(parseSimpleActorBackupBundle(JSON.stringify({
      version: 1,
      type: "wrong-type",
      role: "voter",
      keypair: {
        npub: "npub1example",
        nsec: "nsec1example",
      },
    }))).toBeNull();
  });
});

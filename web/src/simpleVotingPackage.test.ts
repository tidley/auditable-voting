import { describe, expect, it } from "vitest";
import { parseSimpleVotingPackage, serializeSimpleVotingPackage } from "./simpleVotingPackage";

describe("simpleVotingPackage", () => {
  it("serializes to a human-readable voting details block", () => {
    const value = serializeSimpleVotingPackage({
      votingId: "1357a6d0-8eb",
      coordinatorNpub: "npub1examplecoordinator000000000000000000000000000000000000000",
      prompt: "Should the proposal pass?",
      thresholdT: 3,
      thresholdN: 5,
    });

    expect(value).toContain("Voting ID: 1357a6d0-8eb");
    expect(value).toContain("Coordinator npubs:");
    expect(value).toContain("Threshold: 3 of 5");
  });

  it("parses loose text with a voting id and multiple coordinator npubs", () => {
    const parsed = parseSimpleVotingPackage(`
Voting ID: 1357a6d0-8eb
Coordinator npubs:
- npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsssh7m
- npub1pppppppppppppppppppppppppppppppppppppppppppppppppppp6dkdzc
    `);

    expect(parsed?.votingId).toBe("1357a6d0-8eb");
    expect(parsed?.coordinators).toEqual([
      "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsssh7m",
      "npub1pppppppppppppppppppppppppppppppppppppppppppppppppppp6dkdzc",
    ]);
    expect(parsed?.coordinatorNpub).toBe("npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsssh7m");
  });
});

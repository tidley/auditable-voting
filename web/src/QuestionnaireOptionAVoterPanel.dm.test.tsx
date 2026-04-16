// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./questionnaireInvite", () => ({
  parseInviteFromUrl: () => ({ electionId: null, invite: null }),
}));

vi.mock("./questionnaireTransport", () => ({
  fetchQuestionnaireDefinitions: vi.fn().mockResolvedValue([]),
}));

vi.mock("./services/signerService", () => ({
  createSignerService: () => ({
    isAvailable: async () => true,
    getPublicKey: async () => "f".repeat(64),
    signMessage: async () => "sig",
    signEvent: async <T extends Record<string, unknown>>(event: T) => event,
  }),
  SignerServiceError: class SignerServiceError extends Error {},
}));

vi.mock("./questionnaireOptionAStorage", () => ({
  listInvitesFromMailbox: () => [],
  publishInviteToMailbox: () => undefined,
}));

vi.mock("./questionnaireOptionAInviteDm", () => ({
  fetchOptionAInviteDms: vi.fn().mockResolvedValue([
    {
      type: "election_invite",
      schemaVersion: 1,
      electionId: "election_test_1",
      title: "Test Invite",
      description: "",
      voteUrl: "https://example.test/vote",
      invitedNpub: "npub1" + "a".repeat(58),
      coordinatorNpub: "npub1" + "b".repeat(58),
      expiresAt: null,
    },
  ]),
}));

import QuestionnaireOptionAVoterPanel from "./QuestionnaireOptionAVoterPanel";

describe("QuestionnaireOptionAVoterPanel DM retrieval", () => {
  it("shows Check invites action and loads pending invites", async () => {
    const user = userEvent.setup();
    render(<QuestionnaireOptionAVoterPanel />);

    const getDmsButton = screen.getByRole("button", { name: "Check invites" });
    expect(getDmsButton).toBeTruthy();
    await user.click(getDmsButton);

    await screen.findByText(/Checked relays\. Found 1 pending invite/i);
    expect(screen.getByText("Pending invites")).toBeTruthy();
    expect(screen.getByText("Test Invite")).toBeTruthy();
  });
});

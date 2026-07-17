// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SimpleMessagesPanel from "./SimpleMessagesPanel";
import type { HelplineDmMessage } from "./simpleHelplineDm";

const simpleHelplineDmMocks = vi.hoisted(() => ({
  sendHelplineDmMessage: vi.fn(),
  subscribeHelplineDmMessages: vi.fn<typeof import("./simpleHelplineDm").subscribeHelplineDmMessages>(() => () => undefined),
}));

vi.mock("./simpleHelplineDm", () => ({
  latestHelplineMessageByPeer: (messages: HelplineDmMessage[]) => {
    const byPeer = new Map<string, HelplineDmMessage>();
    for (const message of [...messages].reverse()) {
      if (!byPeer.has(message.peerNpub)) {
        byPeer.set(message.peerNpub, message);
      }
    }
    return byPeer;
  },
  mergeHelplineDmMessages: (messages: HelplineDmMessage[]) => {
    const byId = new Map<string, HelplineDmMessage>();
    for (const message of messages) {
      byId.set(message.id, message);
    }
    return [...byId.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  },
  sendHelplineDmMessage: simpleHelplineDmMocks.sendHelplineDmMessage,
  subscribeHelplineDmMessages: simpleHelplineDmMocks.subscribeHelplineDmMessages,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  simpleHelplineDmMocks.sendHelplineDmMessage.mockReset();
  simpleHelplineDmMocks.subscribeHelplineDmMessages.mockReset();
  simpleHelplineDmMocks.subscribeHelplineDmMessages.mockReturnValue(() => undefined);
});

describe("SimpleMessagesPanel", () => {
  it("shows loading instead of an empty organiser inbox before relay history arrives", async () => {
    render(
      <SimpleMessagesPanel
        role='coordinator'
        actorNpub='npub1coordinator'
        actorNsec='nsec1coordinator'
      />,
    );

    expect(await screen.findByText("Loading messages...")).toBeTruthy();
    expect(screen.queryByText("No voter messages have arrived yet.")).toBeNull();
  });

  it("does not subscribe voter messages until an organiser target is known", () => {
    render(
      <SimpleMessagesPanel
        role='voter'
        actorNpub='npub1voter'
        actorNsec='nsec1voter'
        targetNpubs={[]}
      />,
    );

    expect(simpleHelplineDmMocks.subscribeHelplineDmMessages).not.toHaveBeenCalled();
    expect(screen.getByText("Add or open an organiser before sending a message.")).toBeTruthy();
  });

  it("hides the contacts list for one voter organiser and sends with Enter", async () => {
    const user = userEvent.setup();
    const coordinatorNpub = "npub1coordinator";
    simpleHelplineDmMocks.sendHelplineDmMessage.mockResolvedValue({
      eventIds: ["event_sent"],
      successes: 1,
      failures: 0,
      relayResults: [{ relay: "wss://relay.example", eventId: "event_sent", success: true }],
      message: {
        id: "message_sent",
        dmEventId: "event_sent",
        senderNpub: "npub1voter",
        recipientNpubs: [coordinatorNpub],
        peerNpub: coordinatorNpub,
        direction: "sent",
        body: "Hello organiser",
        subject: "Auditable Voting helpline",
        createdAt: "2026-06-12T00:00:00.000Z",
      },
    });

    render(
      <SimpleMessagesPanel
        role='voter'
        actorNpub='npub1voter'
        actorNsec='nsec1voter'
        targetNpubs={[coordinatorNpub]}
      />,
    );

    expect(screen.queryByLabelText("Conversations")).toBeNull();

    await user.type(screen.getByPlaceholderText("Type a message to the organiser..."), "Hello organiser{Enter}");

    await waitFor(() => {
      expect(simpleHelplineDmMocks.sendHelplineDmMessage).toHaveBeenCalledWith({
        senderNsec: "nsec1voter",
        recipientNpub: coordinatorNpub,
        message: "Hello organiser",
      });
    });
    expect(await screen.findByText("Hello organiser")).toBeTruthy();
  });

  it("renders hyperlinks in message bodies as clickable links", async () => {
    const coordinatorNpub = "npub1coordinator";
    simpleHelplineDmMocks.subscribeHelplineDmMessages.mockImplementation(
      (input: { onMessages: (messages: HelplineDmMessage[]) => void }) => {
        input.onMessages([
          {
            id: "message_link",
            dmEventId: "event_link",
            senderNpub: coordinatorNpub,
            recipientNpubs: ["npub1voter"],
            peerNpub: coordinatorNpub,
            direction: "received",
            body: "Open https://tidley.github.io/auditable-voting/?q=q123 or www.example.com/help.",
            subject: "Auditable Voting helpline",
            createdAt: "2026-06-12T00:00:00.000Z",
          },
        ]);
        return () => undefined;
      },
    );

    render(
      <SimpleMessagesPanel
        role='voter'
        actorNpub='npub1voter'
        actorNsec='nsec1voter'
        targetNpubs={[coordinatorNpub]}
      />,
    );

    const questionnaireLink = await screen.findByRole("link", {
      name: "https://tidley.github.io/auditable-voting/?q=q123",
    });
    expect(questionnaireLink.getAttribute("href")).toBe("https://tidley.github.io/auditable-voting/?q=q123");
    expect(questionnaireLink.getAttribute("target")).toBe("_blank");
    expect(questionnaireLink.getAttribute("rel")).toBe("noopener noreferrer");

    const shorthandLink = screen.getByRole("link", { name: "www.example.com/help" });
    expect(shorthandLink.getAttribute("href")).toBe("https://www.example.com/help");
  });
});

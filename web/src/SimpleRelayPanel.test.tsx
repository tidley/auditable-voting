// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./simpleVotingSession", () => ({
  SIMPLE_PUBLIC_RELAYS: ["wss://relay.example/"],
}));

vi.mock("./simpleShardDm", () => ({
  SIMPLE_DM_RELAYS: [],
}));

vi.mock("./simpleMailbox", () => ({
  SIMPLE_MAILBOX_RELAYS: [],
}));

vi.mock("./questionnaireRelays", () => ({
  DEFAULT_QUESTIONNAIRE_RELAYS: ["wss://relay.example/"],
  normalizeQuestionnaireRelays: (value?: string) => (value ? [value] : []),
  questionnaireRelaysForMetadata: (relays: string[]) => relays,
}));

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  cleanup();
  globalThis.WebSocket = originalWebSocket;
  vi.restoreAllMocks();
});

describe("SimpleRelayPanel", () => {
  it("retries a failed browser relay probe before showing the relay offline", async () => {
    let attempts = 0;

    class MockWebSocket {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { code: number; reason: string }) => void) | null = null;

      constructor() {
        attempts += 1;
        window.setTimeout(() => {
          if (attempts === 1) {
            this.onerror?.();
            return;
          }
          this.onopen?.();
        }, 0);
      }

      close() {
        this.onclose?.({ code: 1000, reason: "" });
      }
    }

    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    const { default: SimpleRelayPanel } = await import("./SimpleRelayPanel");

    render(<SimpleRelayPanel standalone />);

    await waitFor(() => {
      expect(screen.getByText((text) => text.startsWith("Good"))).toBeTruthy();
    });
    expect(screen.queryByText("Offline")).toBeNull();
    expect(attempts).toBe(2);
  });
});

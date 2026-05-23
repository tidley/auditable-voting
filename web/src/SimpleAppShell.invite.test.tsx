// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./SimpleUiApp", () => ({
  default: () => <div data-testid='simple-voter-app'>Voter app</div>,
}));

vi.mock("./SimpleCoordinatorApp", () => ({
  default: () => <div>Coordinator app</div>,
}));

vi.mock("./SimpleAuditorApp", () => ({
  default: () => <div>Observer app</div>,
}));

vi.mock("./SimpleRelayPanel", () => ({
  default: () => <div>Relay panel</div>,
}));

vi.mock("./services/signerService", () => ({
  createAmberConnectBundle: async () => ({
    nostrConnectUri: "nostrconnect://mock",
    nsecBunkerUri: "bunker://mock",
  }),
  createSignerService: () => ({
    getPublicKey: async () => "npub1" + "a".repeat(58),
  }),
  SignerServiceError: class SignerServiceError extends Error {},
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.pushState(null, "", "/");
  vi.resetModules();
});

describe("SimpleAppShell invite-link login", () => {
  it("defaults the landing page to Observer with Observer first in the role order", async () => {
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);

    expect(screen.getByRole("button", { name: "Continue as Observer" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Observer",
      "Coordinator",
      "Voter",
    ]);
  });

  it("enters the voter app immediately after signer login on a linked questionnaire", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/?login=1&role=voter&q=q_public_link");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);
    await user.click(screen.getByRole("button", { name: "NOS2X-FOX" }));

    expect(await screen.findByTestId("simple-voter-app")).toBeTruthy();
  });
});

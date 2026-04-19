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
  default: () => <div>Auditor app</div>,
}));

vi.mock("./SimpleRelayPanel", () => ({
  default: () => <div>Relay panel</div>,
}));

vi.mock("./services/signerService", () => ({
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
  it("enters the voter app immediately after signer login on a linked questionnaire", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/?login=1&role=voter&q=q_public_link");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);
    await user.click(screen.getByRole("button", { name: "Login via signer" }));

    expect(await screen.findByTestId("simple-voter-app")).toBeTruthy();
  });
});

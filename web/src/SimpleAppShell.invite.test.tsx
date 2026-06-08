// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./SimpleUiApp", () => ({
  default: (props: { activeTab?: string }) => <div data-testid='simple-voter-app'>Voter app {props.activeTab ?? "none"}</div>,
}));

vi.mock("./SimpleCoordinatorApp", () => ({
  default: () => <div>Organiser app</div>,
}));

vi.mock("./SimpleAuditorApp", () => ({
  default: () => <div>Observer app</div>,
}));

vi.mock("./SimpleRelayPanel", () => ({
  default: () => <div>Relay panel</div>,
}));

vi.mock("./simpleAppVersion", () => ({
  SIMPLE_APP_VERSION: "test",
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
      "Organiser",
      "Voter",
    ]);
  });

  it("keeps role switcher controls immediately reusable after clicking", async () => {
    const user = userEvent.setup();
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);

    const coordinatorTab = screen.getByRole("tab", { name: "Organiser" });
    await user.click(coordinatorTab);
    expect(coordinatorTab.getAttribute("aria-disabled")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue as Organiser" }));
    expect(screen.queryByRole("button", { name: "Login" })).toBeNull();

    const menuButton = screen.getByRole("button", { name: "Menu" });
    await user.click(menuButton);
    expect(menuButton.getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("tab", { name: "Organiser" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("closes the role switcher when clicking outside of it", async () => {
    const user = userEvent.setup();
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);

    await user.click(screen.getByRole("button", { name: "Continue as Observer" }));
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("tablist", { name: "Simple role switch" })).toBeTruthy();

    await user.click(screen.getByText("Observer app"));

    await waitFor(() => {
      expect(screen.queryByRole("tablist", { name: "Simple role switch" })).toBeNull();
    });
  });

  it("reactivates async buttons when UI feedback arrives", async () => {
    const user = userEvent.setup();
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const copyButton = screen.getByRole("button", { name: "Copy nostr-connect URL" });
    await user.click(copyButton);

    expect(await screen.findByText(/copy nostr-connect url/i)).toBeTruthy();
    await waitFor(() => {
      expect(copyButton.getAttribute("aria-disabled")).toBeNull();
      expect(copyButton.dataset.pressFeedbackActive).toBeUndefined();
    });
  });

  it("enters the voter app immediately after signer login on a linked questionnaire", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/?login=1&role=voter&q=q_public_link");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);
    await user.click(screen.getByRole("button", { name: "NOS2X-FOX" }));

    expect(await screen.findByTestId("simple-voter-app")).toBeTruthy();
  });

  it("opens direct questionnaire links on the Vote section without the gateway", async () => {
    window.history.pushState(null, "", "/?role=voter&q=q_public_link&request_ballot=1");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);

    expect(screen.getByTestId("simple-voter-app").textContent).toContain("vote");
    expect(screen.queryByRole("button", { name: "Continue as Voter" })).toBeNull();
    expect(screen.getByText("Voter pending")).toBeTruthy();
  });

  it("keeps voter section navigation in the top menu", async () => {
    const user = userEvent.setup();
    window.history.pushState(null, "", "/?role=voter");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");
    let loginEvents = 0;
    const handleLogin = () => {
      loginEvents += 1;
    };
    window.addEventListener("auditable-voting:voter-login", handleLogin);

    try {
      render(<SimpleAppShell />);

      expect(screen.getByTestId("simple-voter-app").textContent).toContain("configure");
      expect(screen.getByText("Voter pending")).toBeTruthy();
      expect(screen.queryByText(/Voter \//)).toBeNull();
      expect(screen.queryByRole("tablist", { name: "Voter sections" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "How it works" })).toBeNull();
      expect(screen.queryByText("vtest")).toBeNull();

      await user.click(screen.getByRole("button", { name: "Menu" }));
      const voterSections = screen.getByRole("tablist", { name: "Voter sections" });
      expect(voterSections).toBeTruthy();
      expect(screen.getByText("vtest")).toBeTruthy();
      const howItWorksLink = screen.getByRole("menuitem", { name: "How it works" });
      expect(howItWorksLink.getAttribute("href")).toBe("project-explainer.html");
      expect(howItWorksLink.getAttribute("target")).toBe("_blank");
      expect(howItWorksLink.getAttribute("rel")).toBe("noopener noreferrer");
      const demoGuideLink = screen.getByRole("menuitem", { name: "Demo guide" });
      expect(demoGuideLink.getAttribute("href")).toBe("demo-guide.html");
      expect(demoGuideLink.getAttribute("target")).toBe("_blank");
      expect(demoGuideLink.getAttribute("rel")).toBe("noopener noreferrer");
      await user.click(screen.getByRole("menuitem", { name: "Login" }));
      expect(loginEvents).toBe(1);

      await user.click(screen.getByRole("button", { name: "Menu" }));
      await user.click(screen.getByRole("tab", { name: "Settings" }));

      expect(screen.getByTestId("simple-voter-app").textContent).toContain("settings");
      expect(screen.queryByRole("tablist", { name: "Voter sections" })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Menu" }));
      expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");
    } finally {
      window.removeEventListener("auditable-voting:voter-login", handleLogin);
    }
  });
});

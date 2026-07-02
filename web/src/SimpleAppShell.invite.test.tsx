// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./SimpleUiApp", () => ({
  default: (props: { activeTab?: string }) => <div data-testid='simple-voter-app'>Voter app {props.activeTab ?? "none"}</div>,
}));

vi.mock("./SimpleCoordinatorApp", () => ({
  default: (props: { accountMenu?: ReactNode }) => (
    <div>
      {props.accountMenu}
      Organiser app
    </div>
  ),
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

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mock-qr"),
  },
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

    const menuButton = screen.getByRole("button", { name: /organiser profile menu/i });
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

  it("does not artificially disable copy buttons while feedback settles", async () => {
    const user = userEvent.setup();
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);

    await user.click(screen.getByRole("button", { name: "Advanced" }));
    const copyButton = screen.getByRole("button", { name: "Copy nostr-connect URL" });
    await user.click(copyButton);

    expect(copyButton.getAttribute("aria-disabled")).toBeNull();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Copy nostr-connect URL" })).toBeTruthy();
    }, { timeout: 2200 });
    expect(copyButton.getAttribute("aria-disabled")).toBeNull();
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

  it("uses the voter identity label as the profile menu trigger", async () => {
    const user = userEvent.setup();
    const voterNpub = "npub1" + "b".repeat(58);
    window.history.pushState(null, "", "/?role=voter");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);
    window.dispatchEvent(new CustomEvent("auditable-voting:identity-updated", {
      detail: { role: "voter", npub: voterNpub },
    }));

    expect(screen.queryByRole("button", { name: "Show full voter npub QR" })).toBeNull();
    const identityButton = await screen.findByRole("button", { name: /voter profile menu/i });
    expect(identityButton.textContent).toMatch(/^Voter /);
    expect(identityButton.querySelector(".simple-account-menu-trigger-icon")).toBeTruthy();

    await user.click(identityButton);

    const menu = screen.getByRole("menu", { name: "App menu" });
    expect([...menu.querySelectorAll(".simple-account-menu-kicker")].map((node) => node.textContent)).toEqual([
      "Change View",
      "Identity",
      "About",
    ]);
    expect(screen.queryByText("Identity words")).toBeNull();
    expect(screen.queryByText("Colour ID")).toBeNull();
    expect(screen.getByText("QR code")).toBeTruthy();
    expect([...menu.querySelectorAll(".simple-account-menu-identity-grid [role='menuitem']")].map((node) => node.textContent)).toEqual([
      "QR code",
      "Copy identity",
      "New identity",
    ]);

    await user.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("menu", { name: "App menu" })).toBeNull();
  });

  it("uses an in-app confirmation before creating a new identity", async () => {
    const user = userEvent.setup();
    const voterNpub = "npub1" + "d".repeat(58);
    const confirmSpy = vi.spyOn(window, "confirm");
    const newIdentityEvents: string[] = [];
    const handleNewIdentity = () => {
      newIdentityEvents.push("voter");
    };
    window.history.pushState(null, "", "/?role=voter");
    window.addEventListener("auditable-voting:voter-new", handleNewIdentity);
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    try {
      render(<SimpleAppShell />);
      window.dispatchEvent(new CustomEvent("auditable-voting:identity-updated", {
        detail: { role: "voter", npub: voterNpub },
      }));

      await user.click(screen.getByRole("button", { name: /voter profile menu/i }));
      await user.click(screen.getByRole("menuitem", { name: "New identity" }));

      expect(confirmSpy).not.toHaveBeenCalled();
      expect(await screen.findByRole("dialog", { name: "Are you sure?" })).toBeTruthy();
      expect(screen.getByText(/Make sure you have backed up this profile/i)).toBeTruthy();
      expect(newIdentityEvents).toEqual([]);

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog", { name: "Are you sure?" })).toBeNull();
      expect(newIdentityEvents).toEqual([]);

      await user.click(screen.getByRole("button", { name: /voter profile menu/i }));
      await user.click(screen.getByRole("menuitem", { name: "New identity" }));
      await user.click(await screen.findByRole("button", { name: "Create new identity" }));

      expect(newIdentityEvents).toEqual(["voter"]);
    } finally {
      window.removeEventListener("auditable-voting:voter-new", handleNewIdentity);
      confirmSpy.mockRestore();
    }
  });

  it("downloads a profile backup from the new identity confirmation", async () => {
    const user = userEvent.setup();
    const voterNpub = "npub1" + "e".repeat(58);
    const voterNsec = "nsec1" + "f".repeat(58);
    const downloadBackup = vi.fn(async () => undefined);
    vi.doMock("./simpleLocalState", () => ({
      loadSimpleActorState: vi.fn(async (role: string) => (role === "voter"
        ? {
            role: "voter",
            keypair: { npub: voterNpub, nsec: voterNsec },
            updatedAt: "2026-07-01T00:00:00.000Z",
            cache: { selectedVotingId: "q_test" },
          }
        : null)),
      saveSimpleActorState: vi.fn(async () => undefined),
      downloadSimpleActorBackup: downloadBackup,
    }));
    window.history.pushState(null, "", "/?role=voter");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    try {
      render(<SimpleAppShell />);

      await user.click(await screen.findByRole("button", { name: /voter profile menu/i }));
      await user.click(screen.getByRole("menuitem", { name: "New identity" }));
      await user.click(await screen.findByRole("button", { name: "Download backup" }));

      await waitFor(() => {
        expect(downloadBackup).toHaveBeenCalledWith(
          "voter",
          { npub: voterNpub, nsec: voterNsec },
          { selectedVotingId: "q_test" },
        );
      });
      expect(await screen.findByText("Backup downloaded.")).toBeTruthy();
    } finally {
      vi.doUnmock("./simpleLocalState");
    }
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
      expect(screen.queryByRole("tablist", { name: "Main actions" })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: "How it works" })).toBeNull();
      expect(screen.queryByText("vtest")).toBeNull();

      await user.click(screen.getByRole("button", { name: /voter profile menu/i }));
      const voterSections = screen.getByRole("tablist", { name: "Main actions" });
      expect(voterSections).toBeTruthy();
      expect(screen.queryByRole("tab", { name: "Join" })).toBeNull();
      expect(screen.getByRole("tab", { name: "Find organiser" })).toBeTruthy();
      expect(screen.getByText("vtest")).toBeTruthy();
      const howItWorksLink = screen.getByRole("menuitem", { name: "How it works" });
      expect(howItWorksLink.getAttribute("href")).toBe("project-explainer.html");
      expect(howItWorksLink.getAttribute("target")).toBe("_blank");
      expect(howItWorksLink.getAttribute("rel")).toBe("noopener noreferrer");
      const demoGuideLink = screen.getByRole("menuitem", { name: "Demo guide" });
      expect(demoGuideLink.getAttribute("href")).toBe("demo-guide.html");
      expect(demoGuideLink.getAttribute("target")).toBe("_blank");
      expect(demoGuideLink.getAttribute("rel")).toBe("noopener noreferrer");
      expect(screen.queryByRole("menuitem", { name: "Login" })).toBeNull();
      expect(loginEvents).toBe(0);

      await user.click(screen.getByRole("tab", { name: "Settings" }));

      expect(screen.getByTestId("simple-voter-app").textContent).toContain("settings");
      expect(screen.queryByRole("tablist", { name: "Main actions" })).toBeNull();

      await user.click(screen.getByRole("button", { name: /voter profile menu/i }));
      expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");
    } finally {
      window.removeEventListener("auditable-voting:voter-login", handleLogin);
    }
  });

  it("keeps organiser identity QR in the top menu without duplicating sidebar navigation", async () => {
    const user = userEvent.setup();
    const organiserNpub = "npub1" + "c".repeat(58);
    window.history.pushState(null, "", "/?role=coordinator");
    const { default: SimpleAppShell } = await import("./SimpleAppShell");

    render(<SimpleAppShell />);
    window.dispatchEvent(new CustomEvent("auditable-voting:identity-updated", {
      detail: { role: "coordinator", npub: organiserNpub },
    }));

    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.queryByText("Profile")).toBeNull();
    await user.click(screen.getByRole("button", { name: /organiser profile menu/i }));

    expect(screen.queryByRole("tablist", { name: "Organiser sections" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Questionnaire" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Session" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Messages" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Identity words")).toBeNull();
    expect(screen.queryByText("Colour ID")).toBeNull();
    expect(screen.getByText("QR code")).toBeTruthy();
    const organiserMenu = screen.getByRole("menu", { name: "App menu" });
    expect([...organiserMenu.querySelectorAll(".simple-account-menu-identity-grid [role='menuitem']")].map((node) => node.textContent)).toEqual([
      "QR code",
      "Copy identity",
      "New identity",
    ]);
  });
});

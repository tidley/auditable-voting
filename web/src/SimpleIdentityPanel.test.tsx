// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SimpleIdentityPanel from "./SimpleIdentityPanel";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,mock-qr"),
  },
}));

afterEach(() => {
  cleanup();
});

describe("SimpleIdentityPanel", () => {
  it("places Login in settings under nsec restore and avoids Hide copy", async () => {
    const user = userEvent.setup();
    const onLogin = vi.fn();

    render(
      <SimpleIdentityPanel
        npub={`npub1${"a".repeat(58)}`}
        nsec={`nsec1${"b".repeat(58)}`}
        onRestoreNsec={() => undefined}
        onLogin={onLogin}
      />,
    );

    expect(screen.getByText("Restore from nsec")).toBeTruthy();
    const loginButton = screen.getByRole("button", { name: "Login" });
    expect(loginButton).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Click to reveal" }));
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
    expect(screen.getByRole("button", { name: "Conceal" })).toBeTruthy();

    await user.click(loginButton);
    expect(onLogin).toHaveBeenCalledTimes(1);
  });
});

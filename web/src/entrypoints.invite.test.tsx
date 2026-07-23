// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInviteFromUrl } from "./questionnaireInvite";

const mocks = vi.hoisted(() => ({
  codesAtCreateRoot: [] as Array<string | null>,
  render: vi.fn(),
}));

vi.mock("react-dom/client", () => ({
  default: {
    createRoot: vi.fn(() => {
      mocks.codesAtCreateRoot.push(parseInviteFromUrl().inviteCode);
      return { render: mocks.render };
    }),
  },
}));

vi.mock("./SimpleAppShell", () => ({ default: () => null }));
vi.mock("./dynamicImportRecovery", () => ({ installDynamicImportRecovery: vi.fn() }));

afterEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  window.history.replaceState(null, "", "/");
});

describe("shipped React entrypoints", () => {
  it("consume private invite fragments before creating each React root", async () => {
    const entrypoints = [
      () => import("./main"),
      () => import("./vote"),
      () => import("./simple"),
      () => import("./simpleCoordinator"),
      () => import("./dashboard"),
    ];

    for (const [index, loadEntrypoint] of entrypoints.entries()) {
      document.body.innerHTML = '<div id="root"></div>';
      window.history.replaceState(null, "", `/?q=q_${index}#invite_code=secret_${index}`);
      await loadEntrypoint();
      expect(window.location.hash).toBe("");
    }

    expect(mocks.codesAtCreateRoot).toEqual([
      "secret_0",
      "secret_1",
      "secret_2",
      "secret_3",
      "secret_4",
    ]);
    expect(mocks.render).toHaveBeenCalledTimes(5);
  });
});

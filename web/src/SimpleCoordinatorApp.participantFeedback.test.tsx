// @vitest-environment jsdom
import { useCallback, useState } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,test"),
  },
}));

import { InviteQrButton, InviteQrOverlay, ParticipantBallotGroupSelect } from "./SimpleCoordinatorApp";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("organiser participant feedback", () => {
  it("keeps an enlarged invite QR open when its table cell remounts", async () => {
    function Harness() {
      const [cellKey, setCellKey] = useState(0);
      const [preview, setPreview] = useState<Parameters<typeof InviteQrOverlay>[0]["preview"]>(null);
      const closePreview = useCallback(() => setPreview(null), []);
      return (
        <>
          <div key={cellKey}>
            <InviteQrButton
              value='https://example.test/private-invite'
              label='private invite link'
              title='Private invite link'
              onExpand={setPreview}
            />
          </div>
          <button type='button' onClick={() => setCellKey((value) => value + 1)}>Refresh row</button>
          <InviteQrOverlay preview={preview} onClose={closePreview} />
        </>
      );
    }

    render(<Harness />);
    const qrButton = await screen.findByRole("button", { name: "Show large QR for private invite link" });
    await act(async () => undefined);
    await userEvent.click(qrButton);
    expect(screen.getByRole("dialog", { name: "Private invite link QR" })).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close QR preview" }));
    });
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close QR preview" }));

    await userEvent.click(screen.getByRole("button", { name: "Refresh row" }));
    expect(screen.getByRole("dialog", { name: "Private invite link QR" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Close QR preview" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show large QR for private invite link" }));
  });

  it("selects a voter group before starting persistence", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const onCommit = vi.fn();
    const onSavingChange = vi.fn();

    render(
      <ParticipantBallotGroupSelect
        id='participant-group'
        value=''
        options={[
          { value: "", label: "Main (everyone)" },
          { value: "group_north", label: "North district" },
        ]}
        onCommit={onCommit}
        onFocusStateChange={() => undefined}
        onSavingChange={onSavingChange}
      />,
    );

    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Voter group" }), "group_north");

    expect((screen.getByRole("combobox", { name: "Voter group, saving" }) as HTMLSelectElement).value).toBe("group_north");
    expect(onCommit).not.toHaveBeenCalled();
    expect(onSavingChange).toHaveBeenCalledWith(true);

    act(() => frames.shift()?.(0));
    expect(onCommit).toHaveBeenCalledWith("group_north");
    expect(onSavingChange).not.toHaveBeenCalledWith(false);

    act(() => frames.shift()?.(0));
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });
});

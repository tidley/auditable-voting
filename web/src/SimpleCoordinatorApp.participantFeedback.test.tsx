// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticipantBallotGroupSelect } from "./SimpleCoordinatorApp";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("organiser participant feedback", () => {
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

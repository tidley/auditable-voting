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

import {
  hasAcknowledgedBlindIssuanceForNpub,
  InviteQrButton,
  InviteQrOverlay,
  ParticipantBallotGroupSelect,
  preserveParticipantBallotGroupCellWhileFocused,
  runVoterApprovalLocked,
  settleWorkerConfigSyncEntries,
  voterApprovalWorkerConfigSyncOptions,
} from "./SimpleCoordinatorApp";
import { buildPrivateInviteCreationFeedback } from "./simpleCoordinatorFeedback";
import { storeBlindIssuanceAckRecord } from "./questionnaireOptionAStorage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("organiser participant feedback", () => {
  it("settles rejected worker config waiters and continues with later elections", async () => {
    const firstWaiter = vi.fn();
    const secondWaiter = vi.fn();
    const onFailure = vi.fn();
    const secondSync = vi.fn(async () => true);

    await settleWorkerConfigSyncEntries([
      {
        electionId: "q_rejected",
        waiters: [firstWaiter],
        sync: async () => { throw new Error("relay unavailable"); },
      },
      {
        electionId: "q_next",
        waiters: [secondWaiter],
        sync: secondSync,
      },
    ], onFailure);

    expect(firstWaiter).toHaveBeenCalledWith(false);
    expect(secondWaiter).toHaveBeenCalledWith(true);
    expect(secondSync).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("q_rejected", expect.any(Error));
  });

  it("builds private invite feedback without opening a QR preview", () => {
    expect(buildPrivateInviteCreationFeedback({
      credentialsPerVoter: 1,
      copied: false,
    })).toEqual({
      status: "Private link created. Use Copy link from the participant row.",
    });
    expect(buildPrivateInviteCreationFeedback({
      credentialsPerVoter: 2,
      copied: true,
    })).toMatchObject({
      status: "Proxy private link copied.",
    });
  });

  it("requires a forced worker config sync containing the newly approved voter for the current delegation", () => {
    expect(voterApprovalWorkerConfigSyncOptions({
      selectedDelegation: { electionId: "q_current" },
      electionId: "q_current",
      approvedVoterNpub: "npub1newlyapproved",
    })).toEqual({
      force: true,
      approvedVoterNpub: "npub1newlyapproved",
    });

    expect(voterApprovalWorkerConfigSyncOptions({
      selectedDelegation: { electionId: "q_other" },
      electionId: "q_current",
      approvedVoterNpub: "npub1newlyapproved",
    })).toBeNull();
  });

  it("serialises approval by election and voter and releases the lock after failure", async () => {
    const inFlight = new Set<string>();
    let finishFirst!: () => void;
    const firstAction = vi.fn(() => new Promise<void>((resolve) => {
      finishFirst = resolve;
    }));
    const duplicateAction = vi.fn(async () => undefined);

    const first = runVoterApprovalLocked(inFlight, "q_test:npub1voter", firstAction);
    expect(await runVoterApprovalLocked(inFlight, "q_test:npub1voter", duplicateAction)).toBeUndefined();
    expect(duplicateAction).not.toHaveBeenCalled();
    finishFirst();
    await first;

    await expect(runVoterApprovalLocked(inFlight, "q_test:npub1voter", async () => {
      throw new Error("approval failed");
    })).rejects.toThrow("approval failed");
    expect(await runVoterApprovalLocked(inFlight, "q_test:npub1voter", async () => "retried")).toBe("retried");
  });

  it("waits for every proxy credential acknowledgement before showing ballot received", () => {
    const electionId = "q_proxy_ack";
    const invitedNpub = "npub1proxyack";
    const pendingRequests = Object.fromEntries([1, 2].map((credentialIndex) => [
      `request-${credentialIndex}`,
      {
        type: "blind_ballot_request" as const,
        schemaVersion: 1 as const,
        electionId,
        requestId: `request-${credentialIndex}`,
        invitedNpub,
        blindedMessage: `blinded-${credentialIndex}`,
        blindSigningKeyId: "blind-key",
        clientNonce: `nonce-${credentialIndex}`,
        createdAt: "2026-07-15T21:00:00.000Z",
        ballotScope: { credentialIndex },
      },
    ]));
    storeBlindIssuanceAckRecord({
      requestId: "request-1",
      electionId,
      invitedNpub,
      issuanceId: "issuance-1",
      ackedAt: "2026-07-15T21:01:00.000Z",
    });

    expect(hasAcknowledgedBlindIssuanceForNpub({}, pendingRequests, invitedNpub, electionId)).toBe(false);

    storeBlindIssuanceAckRecord({
      requestId: "request-2",
      electionId,
      invitedNpub,
      issuanceId: "issuance-2",
      ackedAt: "2026-07-15T21:02:00.000Z",
    });
    expect(hasAcknowledgedBlindIssuanceForNpub({}, pendingRequests, invitedNpub, electionId)).toBe(true);
  });

  it("keeps only the voter group cell stable while its selector is focused", () => {
    const existingGroupCell = () => "existing group";
    const replacementGroupCell = () => "replacement group";
    const existingActionCell = () => "existing action";
    const replacementActionCell = () => "replacement action";
    const previousColumns = [
      { id: "ballotGroup", cell: existingGroupCell },
      { id: "actions", cell: existingActionCell },
    ];
    const refreshedColumns = [
      { id: "ballotGroup", cell: replacementGroupCell },
      { id: "actions", cell: replacementActionCell },
    ];

    const focusedColumns = preserveParticipantBallotGroupCellWhileFocused(
      refreshedColumns,
      previousColumns,
      "participant-group",
    );
    expect(focusedColumns.find((column) => column.id === "ballotGroup")?.cell).toBe(existingGroupCell);
    expect(focusedColumns.find((column) => column.id === "actions")?.cell).toBe(replacementActionCell);
    expect(preserveParticipantBallotGroupCellWhileFocused(
      refreshedColumns,
      previousColumns,
      null,
    )).toBe(refreshedColumns);
  });

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
          { value: "", label: "Main" },
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

    await act(async () => {
      await Promise.resolve();
    });
    act(() => frames.shift()?.(0));
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });
});

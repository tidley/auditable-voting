import { describe, expect, it } from "vitest";
import { nip19 } from "nostr-tools";
import {
  selectPublicQuestionnaireAnnouncementIds,
  selectQuestionnaireVoterIdentity,
} from "./SimpleUiApp";
import { QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND } from "./questionnaireNostr";

describe("SimpleUiApp private invite identity selection", () => {
  it("uses the browser-local voter keypair for private code links", () => {
    const identity = selectQuestionnaireVoterIdentity({
      privateInviteCode: "private-code",
      signerNpub: "npub1rememberedsigner",
      voterKeypair: {
        npub: "npub1localvoter",
        nsec: "nsec1localvoter",
      },
    });

    expect(identity).toEqual({
      activeVoterNpub: "npub1localvoter",
      localVoterNsec: "nsec1localvoter",
      autoSignerLogin: false,
    });
  });

  it("does not claim a private code with a remembered signer before local identity is ready", () => {
    const identity = selectQuestionnaireVoterIdentity({
      privateInviteCode: "private-code",
      signerNpub: "npub1rememberedsigner",
      voterKeypair: null,
    });

    expect(identity).toEqual({
      activeVoterNpub: "",
      localVoterNsec: "",
      autoSignerLogin: false,
    });
  });

  it("keeps normal signer login behaviour outside private code links", () => {
    const identity = selectQuestionnaireVoterIdentity({
      signerNpub: "npub1rememberedsigner",
      voterKeypair: {
        npub: "npub1localvoter",
        nsec: "nsec1localvoter",
      },
    });

    expect(identity).toEqual({
      activeVoterNpub: "npub1rememberedsigner",
      localVoterNsec: "",
      autoSignerLogin: true,
    });
  });

  it("selects open public questionnaire announcements for configured organisers", () => {
    const coordinatorHex = "11".repeat(32);
    const otherCoordinatorHex = "22".repeat(32);
    const coordinatorNpub = nip19.npubEncode(coordinatorHex);
    const otherCoordinatorNpub = nip19.npubEncode(otherCoordinatorHex);

    const ids = selectPublicQuestionnaireAnnouncementIds({
      coordinatorNpubs: [coordinatorNpub],
      events: [
        {
          id: "older",
          pubkey: coordinatorHex,
          kind: QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND,
          created_at: 10,
          content: JSON.stringify({
            schemaVersion: 1,
            eventType: "questionnaire_admission_announcement",
            questionnaireId: "q_first",
            coordinatorPubkey: coordinatorNpub,
            title: "First",
            state: "open",
            createdAt: 10,
          }),
        },
        {
          id: "other",
          pubkey: otherCoordinatorHex,
          kind: QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND,
          created_at: 20,
          content: JSON.stringify({
            schemaVersion: 1,
            eventType: "questionnaire_admission_announcement",
            questionnaireId: "q_other",
            coordinatorPubkey: otherCoordinatorNpub,
            title: "Other",
            state: "open",
            createdAt: 20,
          }),
        },
        {
          id: "newer",
          pubkey: coordinatorHex,
          kind: QUESTIONNAIRE_ADMISSION_ANNOUNCEMENT_KIND,
          created_at: 30,
          content: JSON.stringify({
            schemaVersion: 1,
            eventType: "questionnaire_admission_announcement",
            questionnaireId: "q_second",
            coordinatorPubkey: coordinatorNpub,
            title: "Second",
            state: "published",
            createdAt: 30,
          }),
        },
      ],
    });

    expect(ids).toEqual(["q_first", "q_second"]);
  });
});

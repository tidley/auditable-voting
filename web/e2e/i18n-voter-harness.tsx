import React from "react";
import { createRoot } from "react-dom/client";
import { getPublicKey, nip19 } from "nostr-tools";
import QuestionnaireOptionAVoterPanel from "../src/QuestionnaireOptionAVoterPanel";
import { LanguageProvider, LanguageSwitcher } from "../src/i18n";
import { storeCachedQuestionnaireDefinition } from "../src/questionnaireDefinitionCache";
import { createEmptyVoterElectionLocalState } from "../src/questionnaireOptionA";
import { saveVoterState } from "../src/questionnaireOptionAStorage";
import type { QuestionnaireDefinition } from "../src/questionnaireProtocol";
import { questionnaireDefinitionEventHash } from "../src/questionnaireDefinitionReference";
import "../src/styles.css";

const voterNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(1)));
const coordinatorNpub = nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(2)));
const definition: QuestionnaireDefinition = {
  schemaVersion: 1, eventType: "questionnaire_definition", responseMode: "blind_token",
  questionnaireId: "locale-browser-test", title: "English title", description: "English description",
  translations: { title: { en: "English title", fr: "Titre français", ta: "தமிழ் தலைப்பு" } },
  createdAt: 1, openAt: 1, closeAt: 9999999999,
  coordinatorPubkey: coordinatorNpub, coordinatorEncryptionPubkey: coordinatorNpub,
  responseVisibility: "private", eligibilityMode: "open", allowMultipleResponsesPerPubkey: false,
  questions: [
    { questionId: "q1", type: "yes_no", prompt: "English question", required: true,
      translations: { prompt: { en: "English question", fr: "Question française", ta: "தமிழ் கேள்வி" } } },
    { questionId: "q2", type: "multiple_choice", prompt: "English follow-up", required: true, multiSelect: false,
      translations: { prompt: { en: "English follow-up", fr: { length: 1 } } } as never,
      showIf: { dependsOnQuestionId: "q1", requiredAnswer: { answerType: "yes_no", value: true } },
      options: [{ optionId: "one", label: "One", translations: { label: { en: "One", fr: ["bad"] } } as never }, { optionId: "two", label: "Two" }] },
  ],
};
storeCachedQuestionnaireDefinition(definition);
saveVoterState({ voterNpub, state: createEmptyVoterElectionLocalState({
  electionId: definition.questionnaireId, invitedNpub: voterNpub, coordinatorNpub, now: new Date().toISOString(),
}) });
createRoot(document.getElementById("root")!).render(
  <LanguageProvider initialLocale="en"><LanguageSwitcher />
    <output aria-label="Legacy definition hash">{questionnaireDefinitionEventHash('{"description":"","questions":[{"options":[{"label":"One"}],"prompt":"Proceed?"}],"title":"Legacy"}')}</output>
    <output aria-label="Translated definition hash">{questionnaireDefinitionEventHash('{"description":"","questions":[{"options":[{"label":"One"}],"prompt":"Proceed?"}],"title":"Legacy","translations":{"title":{"en":"Legacy","fr":"Ancien","ta":"பழைய"}}}')}</output>
    <QuestionnaireOptionAVoterPanel announcedQuestionnaireIds={[definition.questionnaireId]} localVoterNpub={voterNpub} />
  </LanguageProvider>,
);

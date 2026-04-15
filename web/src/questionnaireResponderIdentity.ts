import { deriveNpubFromNsec } from "./nostrIdentity";

export function resolveQuestionnaireResponderNpub(input: {
  questionnaireId: string;
  responseIdentityByQuestionnaireId: Record<string, string>;
  fallbackVoterNpub: string;
}) {
  const questionnaireId = input.questionnaireId.trim();
  if (!questionnaireId) {
    return input.fallbackVoterNpub.trim();
  }
  const responseNsec = input.responseIdentityByQuestionnaireId[questionnaireId]?.trim() ?? "";
  if (!responseNsec) {
    return input.fallbackVoterNpub.trim();
  }
  const derived = deriveNpubFromNsec(responseNsec);
  return derived || input.fallbackVoterNpub.trim();
}


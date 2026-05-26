const DEFAULT_INVITE_TITLE = "Questionnaire";

function normaliseTitle(title?: string | null) {
  const trimmed = title?.trim() ?? "";
  return trimmed || DEFAULT_INVITE_TITLE;
}

export function buildQuestionnaireInviteShareSubject(input: {
  title?: string | null;
}) {
  return `Invitation: ${normaliseTitle(input.title)}`;
}

export function buildQuestionnaireInviteShareText(input: {
  title?: string | null;
  description?: string | null;
  inviteUrl: string;
}) {
  const title = normaliseTitle(input.title);
  const description = input.description?.trim() ?? "";
  return [
    `You've been invited to complete ${title === DEFAULT_INVITE_TITLE ? "a questionnaire" : `"${title}"`}.`,
    description,
    "Open this link to sign in and request a ballot:",
    input.inviteUrl,
  ].filter((part) => part.length > 0).join("\n\n");
}

export function buildPrivateInviteCreationFeedback(input: {
  credentialsPerVoter: 1 | 2;
  copied: boolean;
}) {
  const isProxy = input.credentialsPerVoter === 2;
  return {
    status: input.copied
      ? (isProxy ? "Proxy private link copied." : "Private link copied.")
      : (isProxy ? "Proxy private link created. Use Copy link from the participant row." : "Private link created. Use Copy link from the participant row."),
  };
}

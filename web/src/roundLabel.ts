function shortVotingId(votingId: string) {
  return votingId.slice(0, 12);
}

export function formatRoundTimestamp(createdAt: string) {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function formatRoundOptionLabel(input: {
  votingId: string;
  prompt: string;
  createdAt: string;
}) {
  return `${formatRoundTimestamp(input.createdAt)} - ${shortVotingId(input.votingId)} - ${input.prompt}`;
}

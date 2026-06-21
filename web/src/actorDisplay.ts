export function deriveActorDisplayId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  let displaySource = trimmed;
  if (trimmed.startsWith("npub1") && trimmed.length > 12) {
    displaySource = trimmed.slice(5);
  } else if (trimmed.startsWith("npub") && trimmed.length > 11) {
    displaySource = trimmed.slice(4);
  }
  if (displaySource.length <= 6) {
    return displaySource;
  }
  return `${displaySource.slice(0, 3)}-${displaySource.slice(-3)}`;
}

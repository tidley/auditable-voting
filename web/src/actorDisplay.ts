export function deriveActorDisplayId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "unknown";
  }
  if (trimmed.startsWith("npub1") && trimmed.length > 12) {
    return trimmed.slice(5, 12);
  }
  if (trimmed.startsWith("npub") && trimmed.length > 11) {
    return trimmed.slice(4, 11);
  }
  if (trimmed.length <= 7) {
    return trimmed;
  }
  return trimmed.slice(0, 7);
}

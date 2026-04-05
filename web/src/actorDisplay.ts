export function deriveActorDisplayId(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "pending";
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0").slice(0, 7);
}

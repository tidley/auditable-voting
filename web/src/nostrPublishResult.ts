export type RelayPublishResult = {
  relay: string;
  success: boolean;
  error?: string;
};

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isRelayPublishFailureReason(value: unknown) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("connection failure:")
    || normalized.startsWith("connection skipped by allowconnectingtorelay")
    || normalized.startsWith("duplicate url")
  );
}

export function mapRelayPublishResult(result: PromiseSettledResult<unknown>, relay: string): RelayPublishResult {
  if (result.status === "rejected") {
    return {
      relay,
      success: false,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    };
  }

  const reason = typeof result.value === "string" ? result.value : undefined;
  if (isRelayPublishFailureReason(result.value)) {
    return {
      relay,
      success: false,
      error: reason ?? "Relay publish failed.",
    };
  }

  return { relay, success: true };
}

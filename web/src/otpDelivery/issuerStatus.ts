export type IssuerMode = "browser_only" | "delegated_worker";

export interface IssuerStatus {
  mode: IssuerMode;
  workerNpub?: string | null;
  heartbeatAt?: string | null;
  delegationId?: string | null;
  summaryIssuerNpub?: string | null;
}

export type IssuerReadinessLevel = "green" | "amber" | "red";

export interface IssuerReadiness {
  level: IssuerReadinessLevel;
  title: string;
  detail: string;
}

export const ISSUER_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function deriveIssuerReadiness(status: IssuerStatus | null | undefined, nowMs = Date.now()): IssuerReadiness {
  if (!status) {
    return {
      level: "amber",
      title: "Issuer status unavailable",
      detail: "Open Guardian to confirm Browser only or a live Guardian before sending.",
    };
  }
  const summaryIssuerNpub = status.summaryIssuerNpub?.trim() ?? "";
  const workerNpub = status.workerNpub?.trim() ?? "";
  if (status.mode === "browser_only") {
    if (summaryIssuerNpub) {
      return {
        level: "red",
        title: "Active Guardian still routes voters",
        detail: "The election summary still points to a Guardian. Open Guardian and click Revoke delegation before using Browser only.",
      };
    }
    return {
      level: "amber",
      title: "Browser only",
      detail: "Keep this coordinator tab open while voters request ballots. Closing it stops credential issuance.",
    };
  }
  if (!status.delegationId || !workerNpub) {
    return {
      level: "red",
      title: "Guardian mode has no active delegation",
      detail: "Open Guardian and confirm a live Guardian, or switch to Browser only.",
    };
  }
  if (summaryIssuerNpub && summaryIssuerNpub !== workerNpub) {
    return {
      level: "red",
      title: "Guardian routing mismatch",
      detail: "The election summary points to a different Guardian. Revoke and reconfirm the live Guardian.",
    };
  }
  const heartbeatMs = Date.parse(status.heartbeatAt ?? "");
  if (!Number.isFinite(heartbeatMs)) {
    return {
      level: "red",
      title: "Guardian has no heartbeat",
      detail: "The Guardian is not reporting. Confirm the live Guardian in Guardian → Connection details, or switch to Browser only.",
    };
  }
  if (nowMs - heartbeatMs > ISSUER_HEARTBEAT_STALE_MS) {
    return {
      level: "red",
      title: "Guardian heartbeat is stale",
      detail: "The Guardian has not reported recently. Confirm it is running, or switch to Browser only.",
    };
  }
  return {
    level: "green",
    title: "Guardian ready",
    detail: `Heartbeat received ${new Date(heartbeatMs).toLocaleString()}.`,
  };
}

export function isLoopbackVoterUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

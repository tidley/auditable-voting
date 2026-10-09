/**
 * Batch-send ledger and planning for the coordinator email script
 * (AV-DELIVERY-1b).
 *
 * PURE MODULE: no network, no DOM, no globals — time arrives as `now`. It
 * answers three questions for `scripts/otp-send-email.mjs`:
 *
 * 1. which recipients still need a send — the results CSV *is* the ledger, so a
 *    crashed or day-capped run resumes by re-planning from it;
 * 2. which of those can reuse the code from the codes CSV and which need a
 *    fresh code because the 24h admission TTL elapsed;
 * 3. what a partially completed batch cost and what is left over.
 *
 * Ledger columns are `mastersListNumber,ok,detail,ref,sentAt`. The first four
 * are exactly what the in-app results importer expects (`parseResultsCsv` reads
 * them positionally and ignores trailing columns), so the same file is both the
 * script's resume ledger and the app's import.
 */

import { ADMISSION_TTL_MS } from "../otpService";
import type { ResidentEntry } from "../residentRegister";
import { escapeCsvField, parseCsvLine } from "./csv";

/** Postage charged by nomail.name for one email, in sats. */
export const EMAIL_COST_SATS = 100;

/** Hard daily sending cap per nomail account. */
export const DAILY_SEND_CAP = 100;

export interface CodeRow {
  name: string;
  code: string;
  mastersListNumber?: string;
  email?: string;
  issuedAt?: number;
}

export interface LedgerRow {
  mastersListNumber: string;
  ok: boolean;
  detail: string;
  ref?: string;
  /** Epoch ms of the attempt; absent on hand-written/legacy rows. */
  sentAt?: number;
}

export interface SkippedSend {
  mastersListNumber?: string;
  name: string;
  email?: string;
  kind: "already-sent" | "unresolved";
  reason: string;
}

export interface PlannedSend {
  mastersListNumber: string;
  email: string;
  name: string;
  /** Code to send, or null when the script must generate a fresh one. */
  code: string | null;
  issuedAt: number | null;
  reuseCsvCode: boolean;
}

export interface SendPlan {
  sends: PlannedSend[];
  skipped: SkippedSend[];
  notes: string[];
}

export interface PlanSendsInput {
  codeRows: CodeRow[];
  /** Roster from the app's residents CSV; empty when code rows are keyed. */
  roster: ResidentEntry[];
  ledger: LedgerRow[];
  now: number;
  ttlMs?: number;
}

export interface CapStatus {
  remaining: number;
  blocked: boolean;
  warning?: string;
}

export interface BatchAccounting {
  planned: number;
  sent: number;
  failed: number;
  notAttempted: number;
  skippedAlreadySent: number;
  satsSpent: number;
  capUsedToday: number;
  capRemaining: number;
  partial: boolean;
  summaryLine: string;
}

const LEDGER_HEADER = ["mastersListNumber", "ok", "detail", "ref", "sentAt"];

function splitLines(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/** Normalise a header cell: lowercase and strip separators. */
function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Parse an epoch-ms number or an ISO-8601 timestamp. */
function parseTimestamp(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) {
    return undefined;
  }
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse a codes CSV.
 *
 * Two shapes are accepted:
 * - the app's `name,code` export (AV-DELIVERY-1a) — no key and no timestamp,
 *   so the roster is needed to resolve recipients and the code is assumed to be
 *   inside its TTL;
 * - a keyed export `masters_list_number,email,name,code[,issued_at]` — fully
 *   self-describing, which is what a resumable day-2 rollover wants.
 */
export function parseCodeCsv(content: string): CodeRow[] {
  const lines = splitLines(content);
  if (lines.length <= 1) {
    return [];
  }

  const header = parseCsvLine(lines[0]).map(normalizeHeader);
  const indexOf = (name: string): number => header.indexOf(name);
  const codeIndex = indexOf("code");
  if (codeIndex === -1) {
    throw new Error("codes CSV must have a `code` column");
  }

  const keyIndex = indexOf("masterslistnumber");
  const emailIndex = indexOf("email");
  const nameIndex = indexOf("name");
  const issuedAtIndex = indexOf("issuedat");
  const keyed = keyIndex !== -1 || emailIndex !== -1;

  const rows: CodeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const code = (fields[codeIndex] ?? "").trim();
    if (!code) {
      continue;
    }
    if (!keyed) {
      rows.push({ name: (fields[0] ?? "").trim(), code });
      continue;
    }
    const row: CodeRow = {
      name: nameIndex === -1 ? "" : (fields[nameIndex] ?? "").trim(),
      code,
    };
    const key = keyIndex === -1 ? "" : (fields[keyIndex] ?? "").trim();
    if (key) {
      row.mastersListNumber = key;
    }
    const email = emailIndex === -1 ? "" : (fields[emailIndex] ?? "").trim();
    if (email) {
      row.email = email;
    }
    const issuedAt = issuedAtIndex === -1 ? undefined : parseTimestamp(fields[issuedAtIndex]);
    if (issuedAt !== undefined) {
      row.issuedAt = issuedAt;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Parse the results ledger. Tolerant about header spelling
 * (`mastersListNumber`/`masters_list_number`, `sentAt`/`sent_at`) and about
 * rows without a key, which are skipped.
 */
export function parseLedgerCsv(content: string): LedgerRow[] {
  const lines = splitLines(content);
  if (lines.length <= 1) {
    return [];
  }

  const header = parseCsvLine(lines[0]).map(normalizeHeader);
  const indexOf = (name: string): number => header.indexOf(name);
  const keyIndex = indexOf("masterslistnumber");
  const okIndex = indexOf("ok");
  const detailIndex = indexOf("detail");
  const refIndex = indexOf("ref");
  const sentAtIndex = indexOf("sentat");

  const rows: LedgerRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const mastersListNumber = (keyIndex === -1 ? fields[0] : fields[keyIndex])?.trim() ?? "";
    if (!mastersListNumber) {
      continue;
    }
    const row: LedgerRow = {
      mastersListNumber,
      ok: (okIndex === -1 ? fields[1] : fields[okIndex])?.trim().toLowerCase() === "true",
      detail: (detailIndex === -1 ? fields[2] : fields[detailIndex])?.trim() ?? "",
    };
    const ref = (refIndex === -1 ? fields[3] : fields[refIndex])?.trim();
    if (ref) {
      row.ref = ref;
    }
    const sentAt = sentAtIndex === -1 ? undefined : parseTimestamp(fields[sentAtIndex]);
    if (sentAt !== undefined) {
      row.sentAt = sentAt;
    }
    rows.push(row);
  }
  return rows;
}

/** Serialise the ledger; the first four columns stay app-importable. */
export function buildLedgerCsv(rows: LedgerRow[]): string {
  const lines = [LEDGER_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        escapeCsvField(row.mastersListNumber),
        row.ok ? "true" : "false",
        escapeCsvField(row.detail),
        escapeCsvField(row.ref ?? ""),
        row.sentAt === undefined ? "" : String(row.sentAt),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * How much of the daily sending budget is left. `sentToday` is an estimate
 * derived from the ledger — the authoritative signal is the service's 429
 * response, which {@link isDailyLimitError} recognises.
 */
export function capStatus(sentToday: number, cap: number = DAILY_SEND_CAP): CapStatus {
  const remaining = Math.max(0, cap - sentToday);
  if (remaining === 0) {
    return {
      remaining,
      blocked: true,
      warning: `Daily send limit reached (${cap}/day). Resume after the day cap resets — a re-run on day 2 sends only the outstanding recipients.`,
    };
  }
  if (remaining <= 1) {
    return {
      remaining,
      blocked: false,
      warning: `Only ${remaining} of today's ${cap} sends left — the next send after that fails with the day limit.`,
    };
  }
  return { remaining, blocked: false, warning: undefined };
}

function sameUtcDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate()
  );
}

/**
 * Count successful sends recorded today (UTC), used for the cap estimate.
 * Rows without a timestamp cannot be attributed to a day and are not counted.
 */
export function countSentToday(ledger: LedgerRow[], now: number): number {
  return ledger.filter(
    (row) => row.ok && row.sentAt !== undefined && sameUtcDay(row.sentAt, now),
  ).length;
}

/**
 * Work out what still needs sending.
 *
 * - a successful ledger row means "already delivered": skipped, never resent;
 * - a failed ledger row is retried;
 * - a code whose `issuedAt` is older than `ttlMs` (default: the 24h admission
 *   TTL) is regenerated at send time;
 * - a code without `issuedAt` (the 1a `name,code` export) is reused and a note
 *   is emitted, because the script cannot know its age;
 * - when a code row carries no key or email, it is resolved against the roster
 *   by exact name — an ambiguous or missing name is reported, never guessed.
 */
export function planSends({
  codeRows,
  roster,
  ledger,
  now,
  ttlMs = ADMISSION_TTL_MS,
}: PlanSendsInput): SendPlan {
  const delivered = new Set(
    ledger.filter((row) => row.ok).map((row) => row.mastersListNumber.trim()),
  );

  const byName = new Map<string, ResidentEntry[]>();
  for (const resident of roster) {
    const key = (resident.name ?? "").trim().toLowerCase();
    if (!key) {
      continue;
    }
    const bucket = byName.get(key);
    if (bucket) {
      bucket.push(resident);
    } else {
      byName.set(key, [resident]);
    }
  }

  const sends: PlannedSend[] = [];
  const skipped: SkippedSend[] = [];
  const notes = new Set<string>();
  let regenerated = 0;
  let assumedFresh = 0;

  for (const row of codeRows) {
    const name = row.name.trim();
    let mastersListNumber = row.mastersListNumber?.trim() ?? "";
    let email = row.email?.trim() ?? "";

    if (!mastersListNumber || !email) {
      const candidates = byName.get(name.toLowerCase()) ?? [];
      if (candidates.length === 0) {
        skipped.push({
          name,
          kind: "unresolved",
          reason: `no roster entry matches name "${name}" — pass the roster CSV or use the keyed codes export`,
        });
        continue;
      }
      if (candidates.length > 1) {
        skipped.push({
          name,
          kind: "unresolved",
          reason: `name "${name}" is ambiguous — ${candidates.length} roster entries share it, use the keyed codes export`,
        });
        continue;
      }
      const match = candidates[0];
      mastersListNumber = mastersListNumber || String(match.mastersListNumber);
      email = email || match.email;
    }

    if (!email) {
      skipped.push({
        mastersListNumber,
        name,
        kind: "unresolved",
        reason: "no email address for this recipient",
      });
      continue;
    }

    if (delivered.has(mastersListNumber)) {
      skipped.push({
        mastersListNumber,
        name,
        email,
        kind: "already-sent",
        reason: "already sent (ledger row ok=true) — skipped on resume",
      });
      continue;
    }

    const issuedAt = row.issuedAt ?? null;
    let reuseCsvCode = row.code.length > 0;
    if (issuedAt === null) {
      if (reuseCsvCode) {
        assumedFresh += 1;
      }
    } else if (now > issuedAt + ttlMs) {
      reuseCsvCode = false;
    }
    if (!reuseCsvCode) {
      regenerated += 1;
    }

    sends.push({
      mastersListNumber,
      email,
      name,
      code: reuseCsvCode ? row.code : null,
      issuedAt,
      reuseCsvCode,
    });
  }

  if (regenerated > 0) {
    notes.add(
      `${regenerated} code(s) are older than the 24h admission TTL and will be regenerated at send time — the fresh codes are written to the regenerated-codes CSV for re-import into the app.`,
    );
  }
  if (assumedFresh > 0) {
    notes.add(
      `${assumedFresh} code(s) have no issued_at column and are assumed to be inside the 24h TTL; use the keyed codes export (masters_list_number,email,name,code,issued_at) to make expiry explicit.`,
    );
  }

  return { sends, skipped, notes: Array.from(notes) };
}

/**
 * End-of-run accounting for a (possibly partial) batch. `results` holds the
 * ledger rows produced by this run only.
 */
export function summarizeBatch({
  plan,
  results,
  sentTodayBefore,
}: {
  plan: SendPlan;
  results: LedgerRow[];
  sentTodayBefore: number;
}): BatchAccounting {
  const planned = plan.sends.length;
  const sent = results.filter((row) => row.ok).length;
  const failed = results.length - sent;
  const notAttempted = Math.max(0, planned - results.length);
  const skippedAlreadySent = plan.skipped.filter((skip) => skip.kind === "already-sent").length;
  const satsSpent = sent * EMAIL_COST_SATS;
  const capUsedToday = sentTodayBefore + sent;
  const capRemaining = Math.max(0, DAILY_SEND_CAP - capUsedToday);
  const partial = failed > 0 || notAttempted > 0;

  const summaryLine =
    `${sent} sent, ${failed} failed, ${notAttempted} not attempted, ` +
    `${skippedAlreadySent} already sent; ${satsSpent} sats spent ` +
    `(${sent} x ${EMAIL_COST_SATS} sats); ${capUsedToday}/${DAILY_SEND_CAP} sends used today` +
    (partial
      ? " — partial batch: re-run to resume on day 2, which resends only the outstanding recipients and regenerates expired codes"
      : "");

  return {
    planned,
    sent,
    failed,
    notAttempted,
    skippedAlreadySent,
    satsSpent,
    capUsedToday,
    capRemaining,
    partial,
    summaryLine,
  };
}

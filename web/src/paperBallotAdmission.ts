import { hashQuestionnaireInviteCode } from "./questionnaireInviteCode";
import { buildNamespacedLocalStorageKey } from "./appStorageNamespace";

// Crockford Base32 avoids ambiguous printed glyphs such as I, L, O, and U.
export const PAPER_BALLOT_CODE_PATTERN = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{10}$/;

const PAPER_BALLOT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAPER_BALLOT_ADMISSIONS_STORAGE_KEY = "optiona:paper-ballot-admissions";

export type PaperBallotAdmissionEntry = {
  electionId: string;
  registryKey: string;
  masterlistKey?: string;
  expiresAt: string;
  state: "available" | "redeemed" | "revoked";
  redeemedAt?: string | null;
  redeemedRequestId?: string | null;
  redeemedIssuanceId?: string | null;
};

type PaperBallotAdmissionRegistry = Record<string, PaperBallotAdmissionEntry>;

export function isPaperBallotAdmissionEntry(value: unknown): value is PaperBallotAdmissionEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.electionId === "string"
    && typeof entry.registryKey === "string"
    && /^[0-9a-f]{64}$/.test(entry.registryKey)
    && typeof entry.expiresAt === "string"
    && (entry.masterlistKey === undefined || (typeof entry.masterlistKey === "string" && /^[0-9a-f]{64}$/.test(entry.masterlistKey)))
    && (entry.state === "available" || entry.state === "redeemed" || entry.state === "revoked")
    // Old records reveal a master-list number, so never load or rewrite them.
    && !("masterlistNumber" in entry)
    && !("codeHash" in entry);
}

export function sanitisePaperBallotAdmissions(
  entries: Record<string, unknown> | null | undefined,
): Record<string, PaperBallotAdmissionEntry> {
  return Object.fromEntries(
    Object.entries(entries ?? {}).filter(([registryKey, entry]) =>
      /^[0-9a-f]{64}$/.test(registryKey) && isPaperBallotAdmissionEntry(entry) && entry.registryKey === registryKey,
    ),
  ) as Record<string, PaperBallotAdmissionEntry>;
}

function readPaperBallotAdmissionRegistry(): PaperBallotAdmissionRegistry {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const stored = JSON.parse(window.localStorage.getItem(
      buildNamespacedLocalStorageKey(PAPER_BALLOT_ADMISSIONS_STORAGE_KEY),
    ) ?? "{}") as Record<string, unknown>;
    return sanitisePaperBallotAdmissions(stored);
  } catch {
    return {};
  }
}

export function savePaperBallotAdmission(entry: PaperBallotAdmissionEntry) {
  if (typeof window === "undefined") {
    return;
  }
  const electionId = entry.electionId.trim();
  const registryKey = entry.registryKey.trim().toLowerCase();
  if (!electionId || !/^[0-9a-f]{64}$/.test(registryKey)) {
    return;
  }
  const registry = readPaperBallotAdmissionRegistry();
  registry[registryKey] = {
    electionId,
    registryKey,
    ...(typeof entry.masterlistKey === "string" && /^[0-9a-f]{64}$/.test(entry.masterlistKey)
      ? { masterlistKey: entry.masterlistKey }
      : {}),
    expiresAt: entry.expiresAt,
    state: entry.state,
    redeemedAt: entry.redeemedAt ?? null,
    redeemedRequestId: entry.redeemedRequestId ?? null,
    redeemedIssuanceId: entry.redeemedIssuanceId ?? null,
  };
  window.localStorage.setItem(
    buildNamespacedLocalStorageKey(PAPER_BALLOT_ADMISSIONS_STORAGE_KEY),
    JSON.stringify(registry),
  );
}

export function loadPaperBallotAdmission(input: { registryKey: string }) {
  const registryKey = input.registryKey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(registryKey)) {
    return null;
  }
  return readPaperBallotAdmissionRegistry()[registryKey] ?? null;
}

export function normalisePaperBallotCode(code: string | null | undefined) {
  return (code ?? "").trim().toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
}

export function normalisePaperBallotMasterlistNumber(masterlistNumber: string | null | undefined) {
  return (masterlistNumber ?? "").trim().toUpperCase();
}

export function createPaperBallotCode(randomValues = (bytes: Uint8Array) => crypto.getRandomValues(bytes)) {
  const bytes = new Uint8Array(10);
  bytes.set(randomValues(bytes));
  return [...bytes].map((byte) => PAPER_BALLOT_ALPHABET[byte % PAPER_BALLOT_ALPHABET.length]).join("");
}

export function hashPaperBallotAdmissionKey(input: { electionId: string; masterlistNumber: string; code: string }) {
  const electionId = input.electionId.trim();
  const masterlistNumber = normalisePaperBallotMasterlistNumber(input.masterlistNumber);
  const code = normalisePaperBallotCode(input.code);
  if (!electionId || !masterlistNumber || !PAPER_BALLOT_CODE_PATTERN.test(code)) {
    return Promise.resolve("");
  }
  return hashQuestionnaireInviteCode(`paper-ballot-admission:v1:${JSON.stringify([electionId, masterlistNumber, code])}`);
}

export function hashPaperBallotMasterlistKey(input: { electionId: string; masterlistNumber: string }) {
  const electionId = input.electionId.trim();
  const masterlistNumber = normalisePaperBallotMasterlistNumber(input.masterlistNumber);
  if (!electionId || !masterlistNumber) {
    return Promise.resolve("");
  }
  return hashQuestionnaireInviteCode(`paper-ballot-masterlist:v1:${JSON.stringify([electionId, masterlistNumber])}`);
}

export function paperBallotExpiryToIsoUtc(value: string | null | undefined) {
  const timestamp = Date.parse(value?.trim() ?? "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

export type PrintablePaperBallotAdmission = {
  masterlistNumber: string;
  code: string;
  admission: PaperBallotAdmissionEntry;
};

export async function createPaperBallotAdmissionSheet(input: {
  electionId: string;
  masterlistNumbers: string[];
  expiresAt: string;
  randomValues?: (bytes: Uint8Array) => Uint8Array;
}): Promise<PrintablePaperBallotAdmission[]> {
  const electionId = input.electionId.trim();
  const expiresAt = input.expiresAt.trim();
  const expiresAtMs = Date.parse(expiresAt);
  if (!electionId || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    return [];
  }
  const masterlistNumbers = [...new Set(input.masterlistNumbers
    .map(normalisePaperBallotMasterlistNumber)
    .filter(Boolean))];
  const codes = new Set<string>();
  const sheet: PrintablePaperBallotAdmission[] = [];
  for (const masterlistNumber of masterlistNumbers) {
    let code = createPaperBallotCode(input.randomValues);
    while (codes.has(code)) {
      code = createPaperBallotCode(input.randomValues);
    }
    codes.add(code);
    const registryKey = await hashPaperBallotAdmissionKey({ electionId, masterlistNumber, code });
    const masterlistKey = await hashPaperBallotMasterlistKey({ electionId, masterlistNumber });
    sheet.push({
      masterlistNumber,
      code,
      admission: { electionId, registryKey, masterlistKey, expiresAt, state: "available" },
    });
  }
  return sheet;
}

export function validatePaperBallotAdmission(
  entry: PaperBallotAdmissionEntry | null | undefined,
  input: { electionId: string; registryKey: string; now?: string },
) {
  if (!entry || entry.state !== "available") {
    return { ok: false as const, reason: "unavailable" as const };
  }
  if (entry.electionId !== input.electionId || entry.registryKey !== input.registryKey.trim().toLowerCase()) {
    return { ok: false as const, reason: "mismatch" as const };
  }
  const expiresAt = Date.parse(entry.expiresAt);
  const now = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) {
    return { ok: false as const, reason: "expired" as const };
  }
  return { ok: true as const };
}

export function redeemPaperBallotAdmission(
  entry: PaperBallotAdmissionEntry | null | undefined,
  input: { electionId: string; registryKey: string; requestId: string; now?: string },
) {
  if (entry?.state === "redeemed" && entry.redeemedRequestId === input.requestId) {
    return { ok: true as const, replay: true as const, entry };
  }
  const valid = validatePaperBallotAdmission(entry, input);
  if (!valid.ok) {
    return valid;
  }
  if (!entry) {
    return { ok: false as const, reason: "unavailable" as const };
  }
  return {
    ok: true as const,
    replay: false as const,
    entry: {
      ...entry,
      state: "redeemed" as const,
      redeemedAt: input.now ?? new Date().toISOString(),
      redeemedRequestId: input.requestId,
    },
  };
}

/**
 * Persistent issued-hash roster for the resident OTP admission flow.
 *
 * The coordinator issues one-time codes out of band; the resident may only
 * redeem theirs hours later. The salted hashes used for verification must
 * therefore outlive the coordinator tab. They are persisted here in
 * `localStorage` under the same per-election key pattern as the delivery
 * channel selector (`otp-delivery-channel:` — see
 * `otpDelivery/selectorStorage.ts`).
 *
 * Security invariant: only the salted `saltHex:hashHex` string is stored.
 * The plaintext code is never written to storage, so a compromise of
 * `localStorage` cannot recover a resident's code.
 */

export interface IssuedOtpRecord {
  /** The resident's integer masters-list number. */
  mastersListNumber: number;
  /** The salted `saltHex:hashHex` value produced by `hashOtp`. Never plaintext. */
  saltHash: string;
  /** Unix timestamp in milliseconds when the code was issued. */
  issuedAt: number;
  /** The election the code was issued for. Empty string = unassigned/demo. */
  electionId: string;
}

/** Prefix for the per-election issued-hash roster. */
export const OTP_ADMISSION_ROSTER_PREFIX = "otp-admission-roster:";
/** Prefix for the per-election redeemed-masters-list-number set. */
export const OTP_ADMISSION_REDEEMED_PREFIX = "otp-admission-redeemed:";

function rosterStorageKey(electionId: string): string {
  return `${OTP_ADMISSION_ROSTER_PREFIX}${electionId}`;
}

function redeemedStorageKey(electionId: string): string {
  return `${OTP_ADMISSION_REDEEMED_PREFIX}${electionId}`;
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort; verification still works in-memory when
    // storage is unavailable (private browsing / quota exceeded).
  }
}

/**
 * Validate and normalise a single issued-OTP record from untrusted storage.
 * Returns `null` for malformed entries so they are dropped rather than
 * trusted for verification.
 */
function normaliseIssuedOtpRecord(value: unknown): IssuedOtpRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const mastersListNumber = record.mastersListNumber;
  const saltHash = record.saltHash;
  const issuedAt = record.issuedAt;
  const electionId = record.electionId;
  if (
    typeof mastersListNumber !== "number"
    || !Number.isInteger(mastersListNumber)
    || mastersListNumber <= 0
  ) {
    return null;
  }
  if (typeof saltHash !== "string" || saltHash.length === 0) {
    return null;
  }
  if (typeof issuedAt !== "number" || !Number.isFinite(issuedAt)) {
    return null;
  }
  return {
    mastersListNumber,
    saltHash,
    issuedAt,
    electionId: typeof electionId === "string" ? electionId : "",
  };
}

/** Load the issued-hash roster for one election (empty when none stored). */
export function loadIssuedOtpRoster(electionId: string): IssuedOtpRecord[] {
  const raw = readJson<unknown>(rosterStorageKey(electionId), []);
  if (!Array.isArray(raw)) {
    return [];
  }
  const roster: IssuedOtpRecord[] = [];
  for (const entry of raw) {
    const record = normaliseIssuedOtpRecord(entry);
    if (record) {
      roster.push(record);
    }
  }
  return roster;
}

/** Persist the whole issued-hash roster for one election. */
export function saveIssuedOtpRoster(
  electionId: string,
  records: IssuedOtpRecord[],
): void {
  writeJson(rosterStorageKey(electionId), records);
}

/**
 * Insert or replace a single issued-OTP record for its election, keyed by
 * masters-list number. Returns the updated roster for that election.
 */
export function upsertIssuedOtpRecord(record: IssuedOtpRecord): IssuedOtpRecord[] {
  const electionId = record.electionId ?? "";
  const current = loadIssuedOtpRoster(electionId);
  const next = [
    ...current.filter((entry) => entry.mastersListNumber !== record.mastersListNumber),
    record,
  ];
  saveIssuedOtpRoster(electionId, next);
  return next;
}

/** All election ids that currently have an issued-hash roster stored. */
export function listIssuedOtpElectionIds(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  const ids: string[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) ?? "";
      if (key.startsWith(OTP_ADMISSION_ROSTER_PREFIX)) {
        ids.push(key.slice(OTP_ADMISSION_ROSTER_PREFIX.length));
      }
    }
  } catch {
    return [];
  }
  return ids;
}

/**
 * Find the issued-OTP record for a masters-list number.
 *
 * When `electionId` is omitted, every stored roster is searched so a voter
 * (who may not know the election id up front) can still redeem their code.
 *
 * @returns The matching record, or `undefined` when none exists.
 */
export function findIssuedOtpRecord(
  mastersListNumber: number,
  electionId?: string,
): IssuedOtpRecord | undefined {
  if (electionId !== undefined) {
    return loadIssuedOtpRoster(electionId).find(
      (entry) => entry.mastersListNumber === mastersListNumber,
    );
  }
  for (const id of listIssuedOtpElectionIds()) {
    const match = loadIssuedOtpRoster(id).find(
      (entry) => entry.mastersListNumber === mastersListNumber,
    );
    if (match) {
      return match;
    }
  }
  return undefined;
}

/** Load the redeemed masters-list numbers for one election. */
export function loadRedeemedOtpNumbers(electionId: string): number[] {
  const raw = readJson<unknown>(redeemedStorageKey(electionId), []);
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value > 0,
  );
}

/**
 * Record that a resident's code has been redeemed for an election. Idempotent.
 */
export function markOtpRedeemed(
  electionId: string,
  mastersListNumber: number,
): void {
  const current = loadRedeemedOtpNumbers(electionId);
  if (current.includes(mastersListNumber)) {
    return;
  }
  writeJson(redeemedStorageKey(electionId), [...current, mastersListNumber]);
}

/** The admission flag: whether a resident has redeemed their OTP. */
export function isOtpRedeemed(
  electionId: string,
  mastersListNumber: number,
): boolean {
  return loadRedeemedOtpNumbers(electionId).includes(mastersListNumber);
}

// ---------- Resident → voter-npub binding ----------

/**
 * A link between a resident's redeemed OTP and the voter identity that will
 * cast their ballot. The OTP proves the resident is on the masters list; the
 * binding attaches that eligibility to a voter npub so the coordinator can
 * push it into the npub-keyed voting roster (`admitVotersToRoster`).
 */
export interface ResidentNpubBinding {
  mastersListNumber: number;
  npub: string;
  boundAt: number;
  electionId: string;
}

/** Prefix for the per-election resident→npub binding set. */
export const OTP_ADMISSION_BINDING_PREFIX = "otp-admission-binding:";

function bindingStorageKey(electionId: string): string {
  return `${OTP_ADMISSION_BINDING_PREFIX}${electionId}`;
}

function normaliseResidentNpubBinding(value: unknown): ResidentNpubBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const binding = value as Record<string, unknown>;
  if (
    typeof binding.mastersListNumber !== "number"
    || !Number.isInteger(binding.mastersListNumber)
    || binding.mastersListNumber <= 0
  ) {
    return null;
  }
  if (typeof binding.npub !== "string" || binding.npub.trim().length === 0) {
    return null;
  }
  if (typeof binding.boundAt !== "number" || !Number.isFinite(binding.boundAt)) {
    return null;
  }
  return {
    mastersListNumber: binding.mastersListNumber,
    npub: binding.npub.trim(),
    boundAt: binding.boundAt,
    electionId: typeof binding.electionId === "string" ? binding.electionId : "",
  };
}

/** Load the resident→npub bindings for one election. */
export function loadResidentNpubBindings(electionId: string): ResidentNpubBinding[] {
  const raw = readJson<unknown>(bindingStorageKey(electionId), []);
  if (!Array.isArray(raw)) {
    return [];
  }
  const bindings: ResidentNpubBinding[] = [];
  for (const entry of raw) {
    const binding = normaliseResidentNpubBinding(entry);
    if (binding) {
      bindings.push(binding);
    }
  }
  return bindings;
}

/**
 * Record a resident→npub binding for an election, keyed by masters-list
 * number. Idempotent per resident: a later binding replaces the earlier one.
 */
export function recordResidentNpubBinding(binding: ResidentNpubBinding): ResidentNpubBinding[] {
  const electionId = binding.electionId ?? "";
  const current = loadResidentNpubBindings(electionId);
  const next = [
    ...current.filter((entry) => entry.mastersListNumber !== binding.mastersListNumber),
    binding,
  ];
  writeJson(bindingStorageKey(electionId), next);
  return next;
}

/**
 * Find the voter npub bound to a resident's redeemed OTP, if any.
 */
export function findResidentNpubBinding(
  electionId: string,
  mastersListNumber: number,
): ResidentNpubBinding | undefined {
  return loadResidentNpubBindings(electionId).find(
    (entry) => entry.mastersListNumber === mastersListNumber,
  );
}

import { describe, expect, it } from "vitest";
import { parseResultsCsv } from "./csv";
import { ADMISSION_TTL_MS } from "../otpService";
import {
  DAILY_SEND_CAP,
  EMAIL_COST_SATS,
  buildLedgerCsv,
  capStatus,
  countSentToday,
  parseCodeCsv,
  parseLedgerCsv,
  planSends,
  summarizeBatch,
  type CodeRow,
  type LedgerRow,
} from "./sendLedger";

const NOW = Date.parse("2026-09-12T10:00:00.000Z");
const ONE_HOUR = 60 * 60 * 1000;

function ledgerRow(overrides: Partial<LedgerRow> & { mastersListNumber: string }): LedgerRow {
  return { ok: true, detail: "Sent", sentAt: NOW - ONE_HOUR, ...overrides };
}

describe("parseCodeCsv", () => {
  it("parses the 1a name,code export", () => {
    const rows = parseCodeCsv("name,code\nAlice Smith,123456\n\"Smith, Alice\",654321\n");
    expect(rows).toEqual<CodeRow[]>([
      { name: "Alice Smith", code: "123456" },
      { name: "Smith, Alice", code: "654321" },
    ]);
  });

  it("parses the extended keyed export with email and issued_at", () => {
    const rows = parseCodeCsv(
      "masters_list_number,email,name,code,issued_at\n" +
        "101,alice@example.com,Alice Smith,123456,1757670000000\n",
    );
    expect(rows).toEqual<CodeRow[]>([
      {
        name: "Alice Smith",
        code: "123456",
        mastersListNumber: "101",
        email: "alice@example.com",
        issuedAt: 1757670000000,
      },
    ]);
  });

  it("returns an empty list for empty input and header-only input", () => {
    expect(parseCodeCsv("")).toEqual([]);
    expect(parseCodeCsv("name,code\n")).toEqual([]);
  });

  it("skips rows without a code", () => {
    const rows = parseCodeCsv("name,code\nAlice,123456\nBob,\n");
    expect(rows).toHaveLength(1);
  });
});

describe("parseLedgerCsv / buildLedgerCsv", () => {
  it("round-trips a ledger including the sentAt timestamp", () => {
    const rows: LedgerRow[] = [
      ledgerRow({ mastersListNumber: "101", ref: "msg-1" }),
      ledgerRow({
        mastersListNumber: "102",
        ok: false,
        detail: "Swap failed",
        ref: undefined,
        sentAt: NOW,
      }),
    ];
    const parsed = parseLedgerCsv(buildLedgerCsv(rows));
    expect(parsed).toEqual(rows);
  });

  it("escapes commas and quotes in the detail column", () => {
    const csv = buildLedgerCsv([
      ledgerRow({ mastersListNumber: "101", ok: false, detail: 'Rejected, "bad token"' }),
    ]);
    const parsed = parseLedgerCsv(csv);
    expect(parsed[0].detail).toBe('Rejected, "bad token"');
    expect(parsed[0].ok).toBe(false);
  });

  it("emits a header the 1a results importer still understands", () => {
    const csv = buildLedgerCsv([ledgerRow({ mastersListNumber: "101", ref: "msg-1" })]);
    const imported = parseResultsCsv(csv);
    expect(imported).toEqual<{ mastersListNumber: string; ok: boolean; detail: string; ref?: string }[]>([
      { mastersListNumber: "101", ok: true, detail: "Sent", ref: "msg-1" },
    ]);
  });

  it("returns an empty list for empty input", () => {
    expect(parseLedgerCsv("")).toEqual([]);
  });
});

describe("capStatus", () => {
  it("reports a full budget when nothing has been sent today", () => {
    expect(capStatus(0)).toEqual({ remaining: DAILY_SEND_CAP, blocked: false, warning: undefined });
  });

  it("allows the next send at 99 sent but warns about the day limit", () => {
    const status = capStatus(99);
    expect(status.blocked).toBe(false);
    expect(status.remaining).toBe(1);
    expect(status.warning).toMatch(/day/i);
  });

  it("blocks further sends at the 100/day cap", () => {
    const status = capStatus(DAILY_SEND_CAP);
    expect(status.blocked).toBe(true);
    expect(status.remaining).toBe(0);
    expect(status.warning).toMatch(/day/i);
  });
});

describe("countSentToday", () => {
  it("counts only successful rows from the same UTC day", () => {
    const ledger: LedgerRow[] = [
      ledgerRow({ mastersListNumber: "1", sentAt: Date.parse("2026-09-12T00:05:00.000Z") }),
      ledgerRow({ mastersListNumber: "2", sentAt: Date.parse("2026-09-12T23:55:00.000Z") }),
      ledgerRow({ mastersListNumber: "3", sentAt: Date.parse("2026-09-11T23:55:00.000Z") }),
      ledgerRow({ mastersListNumber: "4", ok: false, detail: "boom", sentAt: NOW }),
      ledgerRow({ mastersListNumber: "5", sentAt: undefined }),
    ];
    expect(countSentToday(ledger, NOW)).toBe(2);
  });
});

describe("planSends", () => {
  const roster = [
    { mastersListNumber: 101, email: "alice@example.com", name: "Alice Smith" },
    { mastersListNumber: 102, email: "bob@example.com", name: "Bob Jones" },
    { mastersListNumber: 103, email: "cleo@example.com", name: "Cleo" },
  ];

  it("pairs the 1a name,code CSV with the roster and reuses unexpired codes", () => {
    const plan = planSends({
      codeRows: [
        { name: "Alice Smith", code: "111111" },
        { name: "Bob Jones", code: "222222" },
      ],
      roster,
      ledger: [],
      now: NOW,
    });

    expect(plan.sends).toEqual([
      {
        mastersListNumber: "101",
        email: "alice@example.com",
        name: "Alice Smith",
        code: "111111",
        issuedAt: null,
        reuseCsvCode: true,
      },
      {
        mastersListNumber: "102",
        email: "bob@example.com",
        name: "Bob Jones",
        code: "222222",
        issuedAt: null,
        reuseCsvCode: true,
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it("skips recipients whose ledger row already succeeded (resume)", () => {
    const plan = planSends({
      codeRows: [
        { name: "Alice Smith", code: "111111" },
        { name: "Bob Jones", code: "222222" },
      ],
      roster,
      ledger: [ledgerRow({ mastersListNumber: "101" })],
      now: NOW,
    });

    expect(plan.sends.map((s) => s.mastersListNumber)).toEqual(["102"]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({
      mastersListNumber: "101",
      kind: "already-sent",
    });
  });

  it("retries recipients whose ledger row failed", () => {
    const plan = planSends({
      codeRows: [{ name: "Alice Smith", code: "111111" }],
      roster,
      ledger: [ledgerRow({ mastersListNumber: "101", ok: false, detail: "Swap failed" })],
      now: NOW,
    });

    expect(plan.sends).toHaveLength(1);
    expect(plan.sends[0].mastersListNumber).toBe("101");
    expect(plan.skipped).toEqual([]);
  });

  it("regenerates a code that is older than the 24h admission TTL", () => {
    const issuedAt = NOW - ADMISSION_TTL_MS - ONE_HOUR;
    const plan = planSends({
      codeRows: [
        { name: "Alice Smith", code: "111111", mastersListNumber: "101", email: "alice@example.com", issuedAt },
      ],
      roster: [],
      ledger: [],
      now: NOW,
    });

    expect(plan.sends[0].reuseCsvCode).toBe(false);
    expect(plan.sends[0].code).toBeNull();
    expect(plan.sends[0].issuedAt).toBe(issuedAt);
    expect(plan.notes.join(" ")).toMatch(/regenerat/i);
  });

  it("still reuses a code issued just inside the 24h TTL", () => {
    const plan = planSends({
      codeRows: [
        {
          name: "Alice Smith",
          code: "111111",
          mastersListNumber: "101",
          email: "alice@example.com",
          issuedAt: NOW - ADMISSION_TTL_MS + ONE_HOUR,
        },
      ],
      roster: [],
      ledger: [],
      now: NOW,
    });

    expect(plan.sends[0].reuseCsvCode).toBe(true);
    expect(plan.sends[0].code).toBe("111111");
  });

  it("rolls every expired code over on day 2 of a capped batch", () => {
    const issuedAt = NOW - 25 * ONE_HOUR;
    const codeRows: CodeRow[] = roster.map((r) => ({
      name: r.name,
      code: "111111",
      mastersListNumber: String(r.mastersListNumber),
      email: r.email,
      issuedAt,
    }));
    const plan = planSends({
      codeRows,
      roster: [],
      ledger: [ledgerRow({ mastersListNumber: "101", sentAt: NOW - 24 * ONE_HOUR })],
      now: NOW,
    });

    expect(plan.sends.map((s) => s.mastersListNumber)).toEqual(["102", "103"]);
    expect(plan.sends.every((s) => s.reuseCsvCode === false && s.code === null)).toBe(true);
    expect(plan.notes.join(" ")).toMatch(/regenerat/i);
  });

  it("uses the email and key carried on the code row when present", () => {
    const plan = planSends({
      codeRows: [
        {
          name: "Alice Smith",
          code: "111111",
          mastersListNumber: "101",
          email: "alice@example.com",
        },
      ],
      roster: [],
      ledger: [],
      now: NOW,
    });
    expect(plan.sends).toHaveLength(1);
    expect(plan.sends[0].email).toBe("alice@example.com");
  });

  it("reports a name that is not in the roster as unresolved instead of guessing", () => {
    const plan = planSends({
      codeRows: [{ name: "Nobody Here", code: "999999" }],
      roster,
      ledger: [],
      now: NOW,
    });
    expect(plan.sends).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ kind: "unresolved", name: "Nobody Here" });
    expect(plan.skipped[0].reason).toMatch(/roster/i);
  });

  it("reports an ambiguous (duplicated) roster name rather than picking one", () => {
    const plan = planSends({
      codeRows: [{ name: "Alice Smith", code: "999999" }],
      roster: [
        { mastersListNumber: 101, email: "alice@example.com", name: "Alice Smith" },
        { mastersListNumber: 201, email: "alice2@example.com", name: "Alice Smith" },
      ],
      ledger: [],
      now: NOW,
    });
    expect(plan.sends).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/ambiguous/i);
  });

  it("keeps the input order of the code rows", () => {
    const plan = planSends({
      codeRows: [
        { name: "Cleo", code: "333333" },
        { name: "Alice Smith", code: "111111" },
      ],
      roster,
      ledger: [],
      now: NOW,
    });
    expect(plan.sends.map((s) => s.mastersListNumber)).toEqual(["103", "101"]);
  });
});

describe("summarizeBatch", () => {
  const plan = planSends({
    codeRows: [
      { name: "Alice Smith", code: "111111" },
      { name: "Bob Jones", code: "222222" },
      { name: "Cleo", code: "333333" },
    ],
    roster: [
      { mastersListNumber: 101, email: "alice@example.com", name: "Alice Smith" },
      { mastersListNumber: 102, email: "bob@example.com", name: "Bob Jones" },
      { mastersListNumber: 103, email: "cleo@example.com", name: "Cleo" },
    ],
    ledger: [ledgerRow({ mastersListNumber: "101", sentAt: NOW - ONE_HOUR })],
    now: NOW,
  });

  it("accounts for a partially completed batch and the cost", () => {
    const summary = summarizeBatch({
      plan,
      results: [
        ledgerRow({ mastersListNumber: "102", ref: "msg-2" }),
        ledgerRow({ mastersListNumber: "103", ok: false, detail: "Swap failed" }),
      ],
      sentTodayBefore: 99,
    });

    expect(summary.planned).toBe(2);
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.notAttempted).toBe(0);
    expect(summary.satsSpent).toBe(EMAIL_COST_SATS);
    expect(summary.skippedAlreadySent).toBe(1);
    expect(summary.capUsedToday).toBe(100);
    expect(summary.capRemaining).toBe(0);
    expect(summary.partial).toBe(true);
    expect(summary.summaryLine).toMatch(/1 sent/);
    expect(summary.summaryLine).toMatch(/1 failed/);
    expect(summary.summaryLine).toMatch(/day 2|next day/i);
  });

  it("flags a clean batch as not partial and rolls nothing over", () => {
    const summary = summarizeBatch({
      plan,
      results: [
        ledgerRow({ mastersListNumber: "102", ref: "msg-2" }),
        ledgerRow({ mastersListNumber: "103", ref: "msg-3" }),
      ],
      sentTodayBefore: 10,
    });

    expect(summary.partial).toBe(false);
    expect(summary.notAttempted).toBe(0);
    expect(summary.satsSpent).toBe(2 * EMAIL_COST_SATS);
    expect(summary.summaryLine).toMatch(/2 sent/);
  });

  it("counts recipients never attempted once the daily cap stops the batch", () => {
    const summary = summarizeBatch({
      plan,
      results: [ledgerRow({ mastersListNumber: "102", ref: "msg-2" })],
      sentTodayBefore: 99,
    });

    expect(summary.notAttempted).toBe(1);
    expect(summary.partial).toBe(true);
    expect(summary.summaryLine).toMatch(/1 not attempted/);
  });
});

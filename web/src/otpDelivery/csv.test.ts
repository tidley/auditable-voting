import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  buildNameCodeCsv,
  parseResultsCsv,
  type DeliveryResultRow,
} from "./csv";

describe("escapeCsvField", () => {
  it("leaves a plain field unchanged", () => {
    expect(escapeCsvField("Alice Smith")).toBe("Alice Smith");
  });

  it("quotes a field containing a comma", () => {
    expect(escapeCsvField("Smith, Alice")).toBe('"Smith, Alice"');
  });

  it("quotes a field containing a double quote and doubles the quote", () => {
    expect(escapeCsvField('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes a field containing a newline", () => {
    expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("buildNameCodeCsv", () => {
  it("emits a header and one row per pair with proper escaping", () => {
    const csv = buildNameCodeCsv([
      { name: "Alice Smith", code: "123456" },
      { name: "Smith, Alice", code: "654321" },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("name,code");
    expect(lines[1]).toBe("Alice Smith,123456");
    expect(lines[2]).toBe('"Smith, Alice",654321');
  });

  it("escapes a name containing a double quote", () => {
    const csv = buildNameCodeCsv([{ name: 'O"Brien', code: "111111" }]);
    expect(csv).toContain('"O""Brien",111111');
  });
});

describe("parseResultsCsv", () => {
  it("parses a results CSV with the expected columns", () => {
    const rows = parseResultsCsv(
      "mastersListNumber,ok,detail,ref\n101,true,Sent,abc123\n102,false,Rejected,\n",
    );
    expect(rows).toEqual<DeliveryResultRow[]>([
      { mastersListNumber: "101", ok: true, detail: "Sent", ref: "abc123" },
      { mastersListNumber: "102", ok: false, detail: "Rejected", ref: undefined },
    ]);
  });

  it("handles quoted fields and commas inside detail", () => {
    const rows = parseResultsCsv(
      'mastersListNumber,ok,detail,ref\n101,true,"Sent, with note",ref1\n',
    );
    expect(rows[0].detail).toBe("Sent, with note");
  });

  it("returns an empty list for an empty or header-only input", () => {
    expect(parseResultsCsv("")).toEqual([]);
    expect(parseResultsCsv("mastersListNumber,ok,detail,ref\n")).toEqual([]);
  });

  it("skips rows that do not have a mastersListNumber", () => {
    const rows = parseResultsCsv(
      "mastersListNumber,ok,detail,ref\n,true,no key,\n101,true,ok,\n",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].mastersListNumber).toBe("101");
  });
});

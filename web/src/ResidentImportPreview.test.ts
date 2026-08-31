import { describe, expect, it } from "vitest";
import { DEMO_RESIDENTS, parseResidentRecords } from "./ResidentImportPreview";

describe("resident import preview", () => {
  it("provides five local demo residents", () => {
    expect(DEMO_RESIDENTS).toHaveLength(5);
    expect(new Set(DEMO_RESIDENTS.map((record) => record.residentNumber)).size).toBe(5);
  });

  it("accepts a CSV with required and optional columns", () => {
    expect(parseResidentRecords([
      "resident number,email,name,phone",
      "1001,alex@example.test,Alex Morgan,07123456789",
    ].join("\n"))).toEqual({
      records: [{
        residentNumber: "1001",
        email: "alex@example.test",
        name: "Alex Morgan",
        phone: "07123456789",
      }],
      error: null,
    });
  });

  it("rejects missing required columns and duplicate resident numbers", () => {
    expect(parseResidentRecords("email\nalex@example.test").error).toMatch(/resident number and email/i);
    expect(parseResidentRecords([
      "resident number,email",
      "1001,alex@example.test",
      "1001,blair@example.test",
    ].join("\n")).error).toMatch(/appears more than once/i);
  });
});

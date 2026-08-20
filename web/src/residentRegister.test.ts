import { describe, expect, it } from "vitest";
import { parseResidentCsv } from "./residentRegister";

describe("parseResidentCsv", () => {
  it("parses a valid CSV with header and returns correct entries", () => {
    const csv = "masters_list_number,email,phone,name\n1,alice@example.com,555-0101,Alice\n2,bob@test.org,555-0102,Bob\n3,carol@demo.com,,Carol";
    const result = parseResidentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.residents).toHaveLength(3);
    expect(result.residents[0]).toEqual({
      mastersListNumber: 1,
      email: "alice@example.com",
      phone: "555-0101",
      name: "Alice",
    });
    expect(result.residents[1]).toEqual({
      mastersListNumber: 2,
      email: "bob@test.org",
      phone: "555-0102",
      name: "Bob",
    });
    expect(result.residents[2]).toEqual({
      mastersListNumber: 3,
      email: "carol@demo.com",
      phone: undefined,
      name: "Carol",
    });
  });

  it("reports an error for duplicate masters_list_number", () => {
    const csv = "masters_list_number,email,phone,name\n1,alice@example.com,555-0101,Alice\n1,bob@test.org,555-0102,Bob";
    const result = parseResidentCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/duplicate/i);
    expect(result.residents).toHaveLength(0);
  });

  it("reports an error for missing email", () => {
    const csv = "masters_list_number,email,phone,name\n1,,555-0101,Alice";
    const result = parseResidentCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/email/i);
    expect(result.residents).toHaveLength(0);
  });

  it("reports an error for an invalid email format", () => {
    const csv = "masters_list_number,email,phone,name\n1,not-an-email,555-0101,Alice";
    const result = parseResidentCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/email/i);
    expect(result.residents).toHaveLength(0);
  });

  it("reports an error for empty CSV content", () => {
    const result = parseResidentCsv("");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/empty|no header|csv/i);
    expect(result.residents).toHaveLength(0);
  });

  it("reports an error for CSV with header only and no data rows", () => {
    const csv = "masters_list_number,email,phone,name";
    const result = parseResidentCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/no data|empty/i);
    expect(result.residents).toHaveLength(0);
  });

  it("ignores extra columns beyond the standard four", () => {
    const csv = "masters_list_number,email,phone,name,extra1,extra2\n1,alice@example.com,555-0101,Alice,ignored,alsoignored";
    const result = parseResidentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.residents).toHaveLength(1);
    expect(result.residents[0]).toEqual({
      mastersListNumber: 1,
      email: "alice@example.com",
      phone: "555-0101",
      name: "Alice",
    });
  });

  it("handles quoted fields containing commas", () => {
    const csv = 'masters_list_number,email,phone,name\n1,"alice@example.com","555-0101","Alice, Smith"';
    const result = parseResidentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.residents).toHaveLength(1);
    expect(result.residents[0]).toEqual({
      mastersListNumber: 1,
      email: "alice@example.com",
      phone: "555-0101",
      name: "Alice, Smith",
    });
  });

  it("rejects CSV with missing header row", () => {
    const csv = "1,alice@example.com,555-0101,Alice";
    const result = parseResidentCsv(csv);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/header/i);
    expect(result.residents).toHaveLength(0);
  });

  it("accumulates multiple errors across rows", () => {
    const csv = "masters_list_number,email,phone,name\n1,alice@example.com,555-0101,Alice\n2,,555-0102,Bob\n2,bob@test.org,,Bob";
    const result = parseResidentCsv(csv);
    // row 2: missing email; row 3: duplicate number + missing email
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.residents).toHaveLength(0);
  });

  it("trims whitespace from field values", () => {
    const csv = "masters_list_number,email,phone,name\n 1 , alice@example.com , 555-0101 , Alice ";
    const result = parseResidentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.residents).toHaveLength(1);
    expect(result.residents[0]).toEqual({
      mastersListNumber: 1,
      email: "alice@example.com",
      phone: "555-0101",
      name: "Alice",
    });
  });

  it("accepts rows without phone and name columns", () => {
    const csv = "masters_list_number,email,phone,name\n2,bob@test.org,,";
    const result = parseResidentCsv(csv);
    expect(result.errors).toEqual([]);
    expect(result.residents).toHaveLength(1);
    expect(result.residents[0]).toEqual({
      mastersListNumber: 2,
      email: "bob@test.org",
      phone: undefined,
      name: undefined,
    });
  });

  describe("CSV formula injection neutralization", () => {
    it("stores a name cell starting with '=' prefixed by an apostrophe", () => {
      const csv = "masters_list_number,email,phone,name\n1,alice@example.com,555-0101,=SUM(A1)";
      const result = parseResidentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.residents).toHaveLength(1);
      expect(result.residents[0].name).toBe("'=SUM(A1)");
      // sibling fields untouched
      expect(result.residents[0].email).toBe("alice@example.com");
      expect(result.residents[0].phone).toBe("555-0101");
    });

    it("neutralizes cells starting with '+', '-', and '@'", () => {
      const csv =
        "masters_list_number,email,phone,name\n" +
        "1,alice@example.com,+cmd,-2+3\n" +
        "2,bob@test.org,+1,@lookup";
      const result = parseResidentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.residents).toHaveLength(2);
      expect(result.residents[0].phone).toBe("'+cmd");
      expect(result.residents[0].name).toBe("'-2+3");
      expect(result.residents[1].name).toBe("'@lookup");
    });

    it("neutralizes an email cell starting with a dangerous character", () => {
      const csv = "masters_list_number,email,phone,name\n1,=evil@example.com,,Alice";
      const result = parseResidentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.residents).toHaveLength(1);
      expect(result.residents[0].email).toBe("'=evil@example.com");
    });

    it("leaves ordinary values untouched", () => {
      const csv = "masters_list_number,email,phone,name\n1,a@b.com,555-0101,Auroville";
      const result = parseResidentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.residents).toHaveLength(1);
      expect(result.residents[0]).toEqual({
        mastersListNumber: 1,
        email: "a@b.com",
        phone: "555-0101",
        name: "Auroville",
      });
    });

    it("still counts a neutralized optional field as non-empty", () => {
      const csv = "masters_list_number,email,phone,name\n1,alice@example.com,=555,=John";
      const result = parseResidentCsv(csv);
      expect(result.errors).toEqual([]);
      expect(result.residents).toHaveLength(1);
      expect(result.residents[0].phone).toBe("'=555");
      expect(result.residents[0].name).toBe("'=John");
    });
  });
});
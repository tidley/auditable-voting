export interface ResidentEntry {
  mastersListNumber: number;
  email: string;
  phone?: string;
  name?: string;
}

export interface ParseResult {
  residents: ResidentEntry[];
  errors: string[];
}

/**
 * Characters that, when they start a spreadsheet cell, cause applications
 * like Excel, Google Sheets, and LibreOffice Calc to evaluate the cell
 * content as a formula (CSV formula injection / CSV injection).
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@"];

/**
 * Leading Unicode format characters (Cf category) that are invisible but are
 * NOT removed by String.trim() — e.g. zero-width space U+200B and word
 * joiner U+2060. Stripping them prevents "\u200B=SUM(A1)" from smuggling a
 * formula prefix past neutralization if a downstream renderer or exporter
 * discards invisible characters.
 */
const INVISIBLE_PREFIX =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/;

/**
 * Neutralise a CSV cell value that could be interpreted as a spreadsheet
 * formula. If the (already trimmed) value starts with one of the formula
 * prefix characters (=, +, -, @), a single apostrophe is prepended so the
 * value is stored and displayed as literal text instead of being executed.
 *
 * Leading invisible format characters (zero-width space, word joiner, bidi
 * marks, soft hyphen, BOM) are stripped first, so they cannot disguise a
 * formula prefix.
 *
 * Undefined and empty-string inputs are returned unchanged so "field is
 * empty" validation is unaffected.
 *
 * Mirrors the `csv_cell` hardening applied by the maintainer in PR #10
 * (security-hardening-review branch).
 */
export function neutralizeCsvFormula(
  value: string | undefined,
): string | undefined {
  if (value === undefined || value === "") {
    return value;
  }
  let v = value;
  while (v.length > 0 && INVISIBLE_PREFIX.test(v[0])) {
    v = v.slice(1);
  }
  if (v === "") {
    return v;
  }
  return FORMULA_PREFIXES.includes(v[0]) ? `'${v}` : v;
}

/**
 * Parse a CSV string containing resident contact information.
 *
 * Expected CSV format (header required):
 *   masters_list_number,email,phone,name
 *
 * Validation:
 * - masters_list_number must be unique and parseable as a positive integer
 * - email must be present and in a valid format
 * - phone is optional (SMS channel)
 * - name is optional
 * - Extra columns beyond the standard 4 are ignored
 * - Fields may be quoted (RFC 4180 style)
 * - String fields (email, phone, name) whose value starts with a formula
 *   prefix character (=, +, -, @) are neutralised with a leading apostrophe
 *   so they cannot execute as formulas in spreadsheet applications
 */
export function parseResidentCsv(csvContent: string): ParseResult {
  const errors: string[] = [];
  const seenNumbers = new Set<number>();

  if (!csvContent || csvContent.trim().length === 0) {
    errors.push("CSV content is empty");
    return { residents: [], errors };
  }

  const lines = csvContent.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) {
    errors.push("CSV content is empty");
    return { residents: [], errors };
  }

  // Validate header
  const headerFields = parseCsvLine(nonEmptyLines[0]);
  const expectedHeader = ["masters_list_number", "email", "phone", "name"];
  const headerMatch =
    headerFields.length >= 4 &&
    headerFields[0].trim().toLowerCase() === expectedHeader[0] &&
    headerFields[1].trim().toLowerCase() === expectedHeader[1] &&
    headerFields[2].trim().toLowerCase() === expectedHeader[2] &&
    headerFields[3].trim().toLowerCase() === expectedHeader[3];

  if (!headerMatch) {
    errors.push("CSV must have a header row: masters_list_number,email,phone,name");
    return { residents: [], errors };
  }

  if (nonEmptyLines.length === 1) {
    errors.push("CSV has no data rows");
    return { residents: [], errors };
  }

  // Collect all errors first — any error means no residents returned (all-or-nothing)
  const validatedEntries: { entry: ResidentEntry; rowIndex: number }[] = [];

  for (let i = 1; i < nonEmptyLines.length; i++) {
    const fields = parseCsvLine(nonEmptyLines[i]);

    if (fields.length < 2) {
      errors.push(`Row ${i}: insufficient fields`);
      continue;
    }

    const mastersListNumberStr = fields[0]?.trim() ?? "";
    // Neutralise formula injection on string fields after trimming and
    // BEFORE any validation, so stored values can never execute as
    // spreadsheet formulas (mirrors the maintainer's csv_cell hardening).
    const email = neutralizeCsvFormula(fields[1]?.trim() ?? "") ?? "";
    const phone = neutralizeCsvFormula(fields[2]?.trim() || undefined);
    const name = neutralizeCsvFormula(fields[3]?.trim() || undefined);

    // Validate masters_list_number
    if (!mastersListNumberStr) {
      errors.push(`Row ${i}: missing masters_list_number`);
      continue;
    }

    const mastersListNumber = Number(mastersListNumberStr);
    if (!Number.isInteger(mastersListNumber) || mastersListNumber <= 0 || isNaN(mastersListNumber)) {
      errors.push(`Row ${i}: masters_list_number must be a positive integer, got "${mastersListNumberStr}"`);
      continue;
    }

    // Validate uniqueness
    if (seenNumbers.has(mastersListNumber)) {
      errors.push(`Row ${i}: duplicate masters_list_number "${mastersListNumber}"`);
      continue;
    }

    // Validate email (required)
    if (!email) {
      errors.push(`Row ${i}: email is required`);
      continue;
    }
    if (!isValidEmail(email)) {
      errors.push(`Row ${i}: invalid email "${email}"`);
      continue;
    }

    seenNumbers.add(mastersListNumber);
    validatedEntries.push({ entry: { mastersListNumber, email, phone, name }, rowIndex: i });
  }

  // All-or-nothing: return residents only if no errors
  if (errors.length > 0) {
    return { residents: [], errors };
  }

  return {
    residents: validatedEntries.map((v) => v.entry),
    errors: [],
  };
}

/**
 * Parse a single CSV line, handling quoted fields (RFC 4180).
 * Returns an array of field values (quotes stripped).
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped quote ("")
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        current += ch;
      }
      i++;
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
        i++;
      } else {
        current += ch;
        i++;
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Basic email validation — checks the string has the general shape of an email address.
 */
function isValidEmail(email: string): boolean {
  // RFC 5322 simplified: at least one char before @, at least one char after @ with a dot
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
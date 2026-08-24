/**
 * CSV helpers for the OTP delivery flow.
 *
 * The export side (name+code pairs) must escape quotes, commas and newlines
 * properly — the formula-injection neutralisation in residentRegister.ts is
 * import-side only and does not protect a naive exporter from corrupting
 * names that contain commas or quotes.
 */

export interface NameCodePair {
  name: string;
  code: string;
}

export interface DeliveryResultRow {
  mastersListNumber: string;
  ok: boolean;
  detail: string;
  ref?: string;
}

/**
 * Escape a single CSV field per RFC 4180: if it contains a comma, double
 * quote or newline, wrap it in double quotes and double any embedded quotes.
 */
export function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Build a name+code CSV for out-of-band distribution. The header is
 * `name,code` and every name is escaped on the export side.
 */
export function buildNameCodeCsv(pairs: NameCodePair[]): string {
  const header = "name,code";
  const rows = pairs.map(
    (pair) => `${escapeCsvField(pair.name)},${escapeCsvField(pair.code)}`,
  );
  return [header, ...rows].join("\n");
}

/**
 * Parse a results CSV produced by the coordinator batch script
 * (columns `mastersListNumber,ok,detail,ref`). Rows without a
 * mastersListNumber are skipped. `ok` is parsed as a boolean.
 */
export function parseResultsCsv(csvContent: string): DeliveryResultRow[] {
  if (!csvContent || csvContent.trim().length === 0) {
    return [];
  }
  const lines = csvContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= 1) {
    return [];
  }
  const rows: DeliveryResultRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const mastersListNumber = fields[0]?.trim() ?? "";
    if (!mastersListNumber) {
      continue;
    }
    const ok = (fields[1]?.trim() ?? "").toLowerCase() === "true";
    const detail = fields[2]?.trim() ?? "";
    const ref = fields[3]?.trim() || undefined;
    rows.push({ mastersListNumber, ok, detail, ref });
  }
  return rows;
}

/**
 * Parse a single CSV line, handling quoted fields (RFC 4180).
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

# Resident Register — CSV Formula Injection Protection

## Overview

The resident register parser (`web/src/residentRegister.ts`) ingests CSV files
containing resident contact information (masters list number, email, phone,
name). Because these CSVs originate from spreadsheets and parsed values are
later exported back out, a malicious cell value such as `=SUM(A1)` or
`@lookup(...)` could execute as a formula when an administrator opens an
exported file in Excel, Google Sheets, or LibreOffice Calc — a class of attack
known as **CSV formula injection** (CWE-1236).

## Threat model

An attacker with control over any free-text field in the resident register
(email, phone, name) crafts a value beginning with a formula prefix character.
When the register is later exported to CSV and opened in a spreadsheet
application, the cell is evaluated as a formula, which can lead to data
exfiltration (e.g. `=WEBSERVICE(...)`), arbitrary command execution via
DDE-style payloads, or workbook corruption.

## Mitigation

`neutralizeCsvFormula()` is applied to every string field (email, phone, name)
at parse time:

1. The field is trimmed.
2. If the value starts with one of the formula prefix characters
   `=` `+` `-` `@`, a single apostrophe (`'`) is prepended.
3. Neutralisation happens **before** validation, so the stored value — and any
   value later re-exported — can never begin with a formula prefix.

The apostrophe prefix is the standard mitigation recommended by OWASP: it
forces spreadsheet applications to treat the cell as literal text while
preserving the original content for human readers.

`masters_list_number` is not neutralised because it is validated as a positive
integer; a value failing that validation is rejected as a row error rather
than stored.

Empty and undefined fields pass through unchanged, so "field is empty"
validation semantics are unaffected.

This mirrors the `csv_cell` hardening applied by the maintainer in PR #10
(security-hardening-review branch).

## API

| Function | Signature | Description |
|---|---|---|
| `neutralizeCsvFormula` | `(value: string \| undefined) => string \| undefined` | Prefixes `'` when the value starts with `=`, `+`, `-`, or `@`; otherwise returns the value unchanged. |

## Testing

`residentRegister.test.ts` covers the neutralisation through the public
`parseResidentCsv` API with 5 dedicated tests (17 total for the module):

- `=` prefixed name cells are stored with a leading apostrophe
- `+`, `-`, `@` prefixed cells are neutralised across phone and name
- email cells starting with a dangerous character are neutralised
- ordinary values (including emails containing `@` in non-initial position)
  pass through untouched
- neutralised optional fields still count as present (non-empty)

Run tests:

```bash
cd web && npx vitest run src/residentRegister.test.ts
```

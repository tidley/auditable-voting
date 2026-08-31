import { useEffect, useRef, useState } from "react";
import { UiButton, UiTextArea } from "./ui/DesignLayer";

export type ResidentRecord = {
  residentNumber: string;
  email: string;
  name: string;
  phone: string;
};

const STORAGE_KEY = "auditable-voting:resident-import-preview:v1";

export const DEMO_RESIDENTS: ResidentRecord[] = [
  { residentNumber: "1001", email: "alex.morgan@example.test", name: "Alex Morgan", phone: "" },
  { residentNumber: "1002", email: "blair.taylor@example.test", name: "Blair Taylor", phone: "" },
  { residentNumber: "1003", email: "casey.jordan@example.test", name: "Casey Jordan", phone: "" },
  { residentNumber: "1004", email: "devon.lee@example.test", name: "Devon Lee", phone: "" },
  { residentNumber: "1005", email: "finley.shaw@example.test", name: "Finley Shaw", phone: "" },
];

function normaliseHeader(value: string) {
  return value.trim().toLowerCase().replace(/[ _-]+/g, "");
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

export function parseResidentRecords(text: string) {
  const rows = text.trim().split(/\r?\n/).filter(Boolean).map(parseCsvLine);
  if (rows.length < 2) {
    return { records: [] as ResidentRecord[], error: "Add a header row and at least one resident." };
  }
  const headers = rows[0].map(normaliseHeader);
  const residentNumberIndex = headers.findIndex((header) => header === "residentnumber" || header === "residentno");
  const emailIndex = headers.findIndex((header) => header === "email" || header === "emailaddress");
  const nameIndex = headers.findIndex((header) => header === "name" || header === "fullname");
  const phoneIndex = headers.findIndex((header) => header === "phone" || header === "phonenumber");
  if (residentNumberIndex < 0 || emailIndex < 0) {
    return { records: [] as ResidentRecord[], error: "Resident number and email address columns are required." };
  }
  const records = rows.slice(1).map((row) => ({
    residentNumber: row[residentNumberIndex]?.trim() ?? "",
    email: row[emailIndex]?.trim() ?? "",
    name: nameIndex >= 0 ? row[nameIndex]?.trim() ?? "" : "",
    phone: phoneIndex >= 0 ? row[phoneIndex]?.trim() ?? "" : "",
  }));
  const seen = new Set<string>();
  for (const record of records) {
    if (!record.residentNumber || !record.email) {
      return { records: [] as ResidentRecord[], error: "Every resident needs a resident number and email address." };
    }
    if (seen.has(record.residentNumber)) {
      return { records: [] as ResidentRecord[], error: `Resident number ${record.residentNumber} appears more than once.` };
    }
    seen.add(record.residentNumber);
  }
  return { records, error: null as string | null };
}

export default function ResidentImportPreview() {
  const [records, setRecords] = useState<ResidentRecord[]>([]);
  const [pasteValue, setPasteValue] = useState("");
  const [status, setStatus] = useState("No resident records loaded.");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : null;
      if (Array.isArray(parsed)) {
        setRecords(parsed.filter((entry): entry is ResidentRecord => (
          entry && typeof entry.residentNumber === "string" && typeof entry.email === "string"
        )));
      }
    } catch {
      // Local import recovery is optional.
    }
  }, []);

  function applyText(text: string) {
    const result = parseResidentRecords(text);
    if (result.error) {
      setStatus(result.error);
      return;
    }
    setRecords(result.records);
    setStatus(`${result.records.length} resident records loaded locally.`);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result.records));
    } catch {
      setStatus(`${result.records.length} resident records loaded for this session only.`);
    }
  }

  return (
    <section id='demo-resident-import' className='simple-resident-import-preview' aria-label='Resident invitation preview'>
      <div>
        <h3 className='simple-voter-question simple-invite-section-title'>Resident invitation preview</h3>
        <p className='simple-voter-note'>Import resident numbers and email addresses for a future OTP invitation flow. Records stay in this browser and are not published to Nostr.</p>
      </div>
      <div className='simple-voter-action-row simple-voter-action-row-inline'>
        <UiButton icon='users' className='simple-voter-secondary' onPress={() => {
          setRecords(DEMO_RESIDENTS);
          setStatus("5 demo resident records loaded locally.");
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(DEMO_RESIDENTS));
          } catch {
            setStatus("5 demo resident records loaded for this session only.");
          }
        }} data-demo-action='resident-import'>
          Load 5 demo residents
        </UiButton>
        <UiButton icon='add' className='simple-voter-secondary' onPress={() => fileInputRef.current?.click()}>
          Import CSV
        </UiButton>
        <input
          ref={fileInputRef}
          type='file'
          accept='.csv,text/csv'
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void file.text().then(applyText).catch(() => setStatus("Could not read that CSV file."));
            }
            event.currentTarget.value = "";
          }}
        />
      </div>
      <UiTextArea
        label='Paste resident table'
        textAreaClassName='simple-voter-input'
        textAreaProps={{
          value: pasteValue,
          rows: 4,
          placeholder: 'resident number,email,name,phone\n1001,alex@example.test,Alex Morgan,',
          onChange: (event) => setPasteValue(event.target.value),
        }}
      />
      <UiButton icon='check' className='simple-voter-secondary' onPress={() => applyText(pasteValue)} isDisabled={!pasteValue.trim()}>
        Use pasted residents
      </UiButton>
      <p className='simple-voter-note'>{status}</p>
      {records.length > 0 ? (
        <p className='simple-voter-note'>Resident access links and email OTP verification are not available yet. No resident can register or vote through this preview.</p>
      ) : null}
    </section>
  );
}

#!/usr/bin/env node
// Run on the trusted coordinator machine, never in the browser or a public CI job.
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { open } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import { deliverBatch, readPrivateFile, smtpOptions, validateBatch } from './smtpDelivery.mjs';

try {
  const { values } = parseArgs({ options: {
    batch: { type: 'string' }, ledger: { type: 'string' }, results: { type: 'string' }, send: { type: 'boolean', default: false },
  } });
  if (!values.batch || !values.ledger || !values.results) throw new Error('Usage: node scripts/otp-send-email.mjs --batch PRIVATE.json --ledger PRIVATE_DIR/ledger.json --results NEW_RESULTS.json [--send]');
  const batch = validateBatch(JSON.parse(await readPrivateFile(resolve(values.batch))));
  if (!values.send) {
    console.log(`Validated ${batch.invitations.length} invitations. Dry run: no connection, email or quota reservation. Add --send only with authorisation.`);
  } else {
    const month = new Date().toISOString().slice(0, 7);
    if (process.env.SMTP_QUOTA_MONTH !== month || !/^\d+$/.test(process.env.SMTP_MONTHLY_BASELINE ?? '')) {
      throw new Error('Set SMTP_QUOTA_MONTH to the current UTC month and SMTP_MONTHLY_BASELINE to prior usage, including all tests and other senders.');
    }
    const paths = [values.batch, values.ledger, values.results].map(p => resolve(p));
    if (new Set(paths).size !== paths.length) throw new Error('Batch, ledger and results paths must differ.');
    // Reserve output before sending: never overwrite existing evidence or source files.
    const output = await open(paths[2], 'wx', 0o600);
    let transport;
    try {
      const password = process.env.SMTP_PASSWORD ?? await readPrivateFile(process.env.SMTP_PASSWORD_FILE ?? `${homedir()}/.config/auditable-voting/smtp-password`);
      if (!password) throw new Error('SMTP password is empty.');
      transport = nodemailer.createTransport(smtpOptions(password));
      const result = await deliverBatch({ batch, ledgerPath: paths[1], month, baseline: Number(process.env.SMTP_MONTHLY_BASELINE), transport });
      await output.writeFile(JSON.stringify(result, null, 2));
      await output.sync();
      for (const row of result.results) console.log(`Resident ${row.mastersListNumber}: ${row.status} — ${row.detail}`);
      console.log(`Reserved monthly usage: ${result.used}/${result.limit}. Results contain no invitation secrets.`);
      if (result.results.length !== batch.invitations.length || result.results.some(row => row.status !== 'accepted')) process.exitCode = 1;
    } finally { transport?.close(); await output.close(); }
  }
} catch (error) {
  // Never print SMTP errors, response strings, configuration objects or credentials.
  const safe = error instanceof Error && !['EAUTH', 'ESOCKET', 'ETIMEDOUT', 'ECONNECTION'].includes(error.code);
  console.error(error instanceof SyntaxError ? 'Private batch JSON is invalid.' : safe ? error.message : 'SMTP operation failed. Inspect the private ledger; do not blindly retry.');
  process.exitCode = 1;
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import nodemailer from 'nodemailer';
import { deliverBatch, smtpOptions, validateBatch } from './smtpDelivery.mjs';

const code = 'a'.repeat(40);
const id = createHash('sha256').update(code).digest('hex');
const batch = { version: 1, electionId: 'election-test', invitations: [{
  mastersListNumber: 101, email: 'alice@example.org', name: 'Alice', id,
  inviteUrl: `https://example.org/vote.html?q=election-test#invite_code=${code}`,
}] };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'av-smtp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { ledgerPath: join(directory, 'ledger.json'), month: '2026-11', baseline: 2, batch,
    transport: { sendMail: async () => ({ accepted: ['alice@example.org'], rejected: [] }) },
    sleep: async () => {} };
}

test('SMTP2GO requires validated STARTTLS, fixed sender configuration, no logging', () => {
  const options = smtpOptions('private-password');
  assert.equal(options.host, 'mail-eu.smtp2go.com');
  assert.equal(options.port, 587);
  assert.equal(options.secure, false);
  assert.equal(options.requireTLS, true);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.auth.user, 'organiser');
  assert.equal(options.logger, false);
  assert.equal(options.debug, false);
});
test('validates all batch entries before sending; rejects duplicate IDs and header injection', () => {
  assert.equal(validateBatch(batch).invitations.length, 1);
  assert.throws(() => validateBatch({ ...batch, invitations: [...batch.invitations, ...batch.invitations] }));
  assert.throws(() => validateBatch({ ...batch, invitations: [{ ...batch.invitations[0], email: 'a@example.org\r\nBcc: other@example.org' }] }));
  assert.throws(() => validateBatch({ ...batch, electionId: 'another-election' }));
  assert.throws(() => validateBatch({ ...batch, invitations: [{ ...batch.invitations[0], id: 'b'.repeat(64) }] }));
});
test('acceptance is durable and re-running the same batch does not send again', async t => {
  const input = await fixture(t);
  let calls = 0;
  input.transport.sendMail = async message => {
    calls++;
    assert.equal(message.from.address, 'organiser@voting.bitsbytom.com');
    assert.match(message.text, /no receiving inbox/i);
    assert.match(message.text, /invite_code=/);
    assert.match(message.text, /can automatically request/);
    assert.ok(!message.text.includes('Opening the page alone does not redeem'));
    return { accepted: ['alice@example.org'], rejected: [] };
  };
  const first = await deliverBatch(input);
  assert.equal(first.results[0].status, 'accepted');
  assert.equal(first.used, 3);
  await deliverBatch(input);
  assert.equal(calls, 1);
  const ledger = await readFile(input.ledgerPath, 'utf8');
  assert.ok(!ledger.includes(code));
  assert.ok(!JSON.stringify(first).includes(code));
});
test('same invitation with changed content fails closed', async t => {
  const input = await fixture(t);
  await deliverBatch(input);
  await assert.rejects(deliverBatch({ ...input, batch: { ...batch, invitations: [{ ...batch.invitations[0], email: 'other@example.org' }] } }), /conflict/i);
});
test('reserves quota before send and never exceeds 250 including baseline', async t => {
  const input = await fixture(t);
  let called = false;
  input.transport.sendMail = async () => { called = true; };
  const result = await deliverBatch({ ...input, baseline: 250 });
  assert.equal(called, false);
  assert.equal(result.results[0].status, 'quota_exhausted');
  assert.equal(result.used, 250);
});
test('ambiguous DATA failure is never retried, including after restart', async t => {
  const input = await fixture(t);
  let calls = 0;
  input.transport.sendMail = async () => { calls++; throw Object.assign(new Error('secret server diagnostics'), { code: 'ETIMEDOUT', command: 'DATA' }); };
  const result = await deliverBatch(input);
  assert.equal(result.results[0].status, 'uncertain');
  assert.ok(!JSON.stringify(result).includes('secret server diagnostics'));
  await deliverBatch(input);
  assert.equal(calls, 1);
});
test('authentication errors are explicit, redacted and not automatically retried', async t => {
  const input = await fixture(t);
  let calls = 0;
  input.transport.sendMail = async () => { calls++; throw Object.assign(new Error('password=secret'), { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 }); };
  const result = await deliverBatch(input);
  assert.equal(result.results[0].status, 'failed');
  assert.match(result.results[0].detail, /authentication/i);
  assert.ok(!JSON.stringify(result).includes('password='));
  assert.equal(calls, 1);
});
test('retries confirmed pre-DATA transient failures once, charging each attempt', async t => {
  const input = await fixture(t);
  let calls = 0;
  input.transport.sendMail = async () => {
    if (++calls === 1) throw Object.assign(new Error('rate limited'), { responseCode: 451, command: 'RCPT TO' });
    return { accepted: ['alice@example.org'], rejected: [] };
  };
  const result = await deliverBatch(input);
  assert.equal(calls, 2);
  assert.equal(result.used, 4);
  assert.equal(result.results[0].status, 'accepted');
});
test('concurrent sender cannot enter the same ledger', async t => {
  const input = await fixture(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  input.transport.sendMail = async () => { entered(); await blocked; return { accepted: ['alice@example.org'], rejected: [] }; };
  const first = deliverBatch(input);
  await ready;
  try { await assert.rejects(deliverBatch(input), /locked/i); }
  finally { release(); await first; }
});
test('invalid ledger and stale month/baseline configuration fail closed', async t => {
  const input = await fixture(t);
  await assert.rejects(deliverBatch({ ...input, baseline: -1 }));
  await assert.rejects(deliverBatch({ ...input, month: '2026-99' }));
  await writeFile(input.ledgerPath, '{}', { mode: 0o600 });
  await assert.rejects(deliverBatch(input), /ledger/i);
});
test('real SMTP client refuses to authenticate/send without STARTTLS', async t => {
  const commands = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.write('220 localhost test SMTP\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        commands.push(line.split(' ')[0]);
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (line === 'STARTTLS') socket.write('454 TLS unavailable\r\n');
        else socket.write('500 unexpected command\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const transport = nodemailer.createTransport({ ...smtpOptions('fake-test-password'), host: '127.0.0.1', port: server.address().port });
  t.after(() => transport.close());
  await assert.rejects(transport.sendMail({ from: 'organiser@voting.bitsbytom.com', to: 'alice@example.org', text: 'offline test' }));
  assert.ok(commands.includes('STARTTLS'));
  assert.ok(!commands.includes('AUTH'));
  assert.ok(!commands.includes('MAIL'));
});
test('interrupted reservation is uncertain and never submitted again', async t => {
  const input = await fixture(t);
  await deliverBatch(input);
  const ledger = JSON.parse(await readFile(input.ledgerPath, 'utf8'));
  ledger.entries[id].status = 'reserved';
  await writeFile(input.ledgerPath, JSON.stringify(ledger));
  input.transport.sendMail = async () => assert.fail('must not resend');
  assert.equal((await deliverBatch(input)).results[0].status, 'uncertain');
});
test('quota counts survive restart and a retry cannot exceed remaining budget', async t => {
  const input = await fixture(t);
  let calls = 0;
  input.transport.sendMail = async () => { calls++; throw Object.assign(new Error('rate limit'), { responseCode: 451, command: 'MAIL FROM' }); };
  const result = await deliverBatch({ ...input, baseline: 249 });
  assert.equal(result.used, 250);
  assert.equal(calls, 1);
  await deliverBatch({ ...input, baseline: 249 });
  assert.equal(calls, 1);
});

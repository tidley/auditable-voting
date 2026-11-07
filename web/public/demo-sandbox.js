import { createDemo, stepDemo, PAPER_CODE, MASTER_NUMBER } from './demo-model.js';

const chapters = [
  { title: 'Prepare the election', role: 'organiser', goal: 'Set up a fictional neighbourhood vote without creating anything in the live app.', lesson: 'The signed definition fixes the questions and private-worker release policy. Preparation and publication are different operations.', boundary: 'Everything on this page is an in-memory simulation. It never loads a real identity, signs an event or contacts a relay.' },
  { title: 'Open and invite', role: 'organiser', goal: 'Review the question, paper invitation and private release policy, then open the example election.', lesson: 'Configure issuer and release authority before sharing invitations. A paper code admits a voter; it is not itself a vote.', boundary: 'Real paper admission stores only the combined election/number/code hash plus lifecycle metadata. This fixture uses a clearly fictional admission record, not a real cryptographic hash.' },
  { title: 'Admit a paper voter', role: 'voter', goal: 'Use the fictional printed invitation. Try a wrong value first if you want to see correction.', lesson: 'A valid code and number immediately request a blind credential from the configured issuer. No further manual approval is needed for valid paper access.', boundary: 'Paper details stay on the admission path. An admitted identity may recover its credential bundle; a different identity cannot reuse the code.' },
  { title: 'Answer the questionnaire', role: 'voter', goal: 'Answer Yes or No. A location follow-up becomes required only after Yes.', lesson: 'Admission, credential receipt and answer submission are separate milestones. Hidden conditional answers must be removed from the ballot.', boundary: 'The public ballot contains the anonymous response and proof, not a master-list number or paper code. This demo uses a fictional credential, not a real blind signature.' },
  { title: 'Understand the private receipt', role: 'worker', goal: 'Inspect the queued ballot and the distinction between durable intake and a received acknowledgement.', lesson: 'A lost receipt does not mean the ballot was lost. Retrying the same submission returns the existing result rather than creating another vote.', boundary: 'Queued privately is not public inclusion. The issuer knows eligibility; the queue worker can observe arrival metadata. An operator doing both has both views.' },
  { title: 'Release at the threshold', role: 'worker', goal: 'Add two anonymous example ballots. Three queued ballots trigger the first release.', lesson: 'Nothing becomes public below threshold. The batch uses a common release time, excluding original arrival timestamps.', boundary: 'The shuffle here is a reproducible example permutation. Real workers need proper randomness. No original voter identity is included in the displayed public records.' },
  { title: 'Deadline and recovery', role: 'worker', goal: 'Queue one more ballot, advance to the deadline, and optionally rehearse a publication failure and restart.', lesson: 'The deadline releases an underfilled batch. Prepared signed event IDs must survive a real restart so retries do not create new public events.', boundary: 'This demo restores a JSON snapshot in memory. It does not test actual disk durability, worker process restart, relay acknowledgement or wire-level exactly-once delivery.' },
  { title: 'Audit the released records', role: 'observer', goal: 'Try a late or duplicate example, then reconcile the four accepted records and two batches.', lesson: 'An Observer checks records, uniqueness and tally independently. A receipt is not a substitute for public evidence.', boundary: 'These checks validate fixture structure and arithmetic only. Real cryptographic proofs are not verified here. The live Observer does not yet display aggregate batch records; external protocol inspection is required.' },
  { title: 'Reconcile and repeat', role: 'observer', goal: 'Review the simulated result, revisit role views, or reset to repeat the exact same starting election.', lesson: 'The final tally counts accepted released ballots, not requests, issued credentials, retries or rejected submissions.', boundary: 'Real paper rounds require organiser-controlled closure. Signed reusable admission grants and automated OTP admission remain future work. This demo does not make those features live.' },
];
const roles = {
  organiser: { name: 'Organiser', text: 'Sees eligibility, credential delivery and aggregate queue progress. Before release, no per-ballot answers or queue arrival identities are shown here.' },
  voter: { name: 'Voter', text: 'Sees this fictional voter’s admission, answers and receipt. Credential receipt is not submission; a queue receipt is not final inclusion.' },
  worker: { name: 'Worker', text: 'Sees anonymous ballot payloads and operational queue state. In real operation this service can observe arrival metadata; only aggregate progress goes to the organiser.' },
  observer: { name: 'Observer', text: 'Sees released public records only, plus this demo’s illustrative batch inspector. No admission roster or private queue entries are visible in this view.' },
};
let state = createDemo();
let view = 'organiser';
let codeInput = '';
let numberInput = '';
let loseReceipt = false;
let failRelease = true;
const root = document.getElementById('demo-root');
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = minute => `10:${String(minute).padStart(2, '0')}`;
const actionButton = (action, text, secondary = false) => `<button type="button" data-action="${action}"${secondary ? ' class="secondary"' : ''}>${text}</button>`;

function counts() {
  return `<div class="counts" aria-label="Simulated aggregate progress">${[
    [state.accepted, 'Accepted privately'], [state.queue.length, 'Queued'], [state.released.length, 'Publicly released'], [state.rejected, 'Rejected examples'],
  ].map(([value, label]) => `<div class="count"><strong>${value}</strong><span>${label}</span></div>`).join('')}</div>`;
}
function invitation() {
  return `<div class="invitation"><strong>Sample paper invitation · demo only</strong><code>${PAPER_CODE}</code><span>Master-list number: <strong>${MASTER_NUMBER}</strong> · expires 10:12</span></div>`;
}
function publicRecords() {
  if (!state.released.length) return '<div class="inset"><strong>No public ballots yet.</strong><p>Waiting for batch release.</p></div>';
  return `<div class="table-wrap"><table><caption>Released fictional ballots — no paper identifiers</caption><thead><tr><th scope="col">Anonymous ballot</th><th scope="col">${escape(state.questionnaire.questions[0].prompt)}</th><th scope="col">${escape(state.questionnaire.questions[1].prompt)}</th>${state.questionnaire.questions.slice(2).map(question => `<th scope="col">${escape(question.prompt)}</th>`).join('')}<th scope="col">Release time</th></tr></thead><tbody>${state.released.map(event => `<tr><td><code>${event.id}</code></td><td>${event.choice === 'yes' ? 'Yes' : 'No'}</td><td>${event.location ?? 'Not applicable'}</td>${state.questionnaire.questions.slice(2).map(question => `<td>${event.answers[question.id] === 'yes' ? 'Yes' : 'No'}</td>`).join('')}<td>${time(event.releasedAt)}</td></tr>`).join('')}</tbody></table></div>`;
}
function questionEditor() {
  const locked = state.stage >= 2;
  return `<label class="field"><span>Name</span><input id="questionnaire-name" aria-label="Questionnaire title" type="text" maxlength="160" value="${escape(state.questionnaire.title)}"${locked ? ' readonly' : ''}></label>
    ${state.questionnaire.questions.map((question, index) => `<div class="question-preview">
      <label class="field"><span>Question ${index + 1}</span><input id="question-${question.id}" data-question="${question.id}" aria-label="Question ${index + 1}" type="text" maxlength="300" value="${escape(question.prompt)}"${locked ? ' readonly' : ''}></label>
      <span class="muted">${index === 1 ? 'North / South · only when question 1 is Yes' : 'Yes / No · required'}</span>
      ${!locked && index >= 2 ? `<button type="button" class="secondary" data-action="REMOVE_QUESTION" data-question="${question.id}" aria-label="Remove question ${index + 1}">Remove</button>` : ''}
    </div>`).join('')}
    ${!locked ? `<div class="actions">${actionButton('ADD_QUESTION', 'Add question', true)}</div><p class="muted editor-note">Edit before Go Live. Added questions use Yes / No; the second question follows Yes to question 1.</p>` : ''}`;
}
function answerForm() {
  return `<form id="answer-form">
    ${state.questionnaire.questions.map((question, index) => {
      if (index === 1) return state.draft.choice === 'yes' ? `<label class="field"><span>${escape(question.prompt)} (required after Yes)</span><select id="plot" name="location"><option value="">Choose a plot</option><option value="north"${state.draft.location === 'north' ? ' selected' : ''}>North plot</option><option value="south"${state.draft.location === 'south' ? ' selected' : ''}>South plot</option></select></label>` : '';
      const value = index === 0 ? state.draft.choice : state.draft.answers[question.id];
      return `<fieldset><legend>${escape(question.prompt)} (required)</legend>${['yes', 'no'].map(choice => `<label class="choice"><input id="answer-${question.id}-${choice}" type="radio" name="${index === 0 ? 'choice' : question.id}"${index === 0 ? '' : ` data-answer="${question.id}"`} value="${choice}"${value === choice ? ' checked' : ''}>${choice === 'yes' ? 'Yes' : 'No'}</label>`).join('')}</fieldset>`;
    }).join('')}
    <label class="check"><input type="checkbox" id="lose-receipt"${loseReceipt ? ' checked' : ''}>Deliberately lose the intake receipt to practise recovery</label><div class="actions"><button type="submit">Submit response</button></div></form>`;
}
function perspective() {
  if (view === 'organiser') return `
    ${state.stage >= 4 ? counts() : ''}
    ${questionEditor()}
    <details class="settings-preview"${state.stage === 1 ? ' open' : ''}><summary>Admission and worker settings</summary>
      <dl class="details-grid"><div><dt>Access</dt><dd>Paper code · Main ballot</dd></div><div><dt>Issuer</dt><dd>Demo Linux worker</dd></div><div><dt>Batch threshold</dt><dd>3 ballots</dd></div><div><dt>Deadline</dt><dd>10:12 (simulated)</dd></div></dl>
      ${state.stage >= 2 ? `<p class="muted">Paper credential: ${state.credential ? 'issued to the admitted demo identity' : 'not yet issued'}.</p>` : ''}
    </details>`;
  if (view === 'voter') return `
    <p class="receipt-status">${!state.credential ? 'Ballot access required' : state.receipt === 'queued' ? 'Queued privately' : state.receipt === 'lost' ? 'Awaiting worker receipt' : 'Ballot received'}</p>
    ${state.stage === 2 ? invitation() : ''}
    ${state.stage >= 4 ? `<div class="inset"><strong>Your response: ${state.draft.choice === 'yes' ? 'Yes' : 'No'}</strong><p>${escape(state.questionnaire.questions[0].prompt)}</p>${state.draft.choice === 'yes' ? `<p>${escape(state.questionnaire.questions[1].prompt)} — ${state.draft.location}.</p>` : ''}${state.questionnaire.questions.slice(2).map(question => `<p>${escape(question.prompt)} — ${state.draft.answers[question.id] === 'yes' ? 'Yes' : 'No'}</p>`).join('')}</div>` : ''}`;
  if (view === 'worker') return `${counts()}<h3>Private queue</h3>
    ${state.queue.length ? `<ul>${state.queue.map(event => `<li><code>${event.id}</code> · queued</li>`).join('')}</ul>` : '<p class="muted">No ballots waiting.</p>'}
    ${state.prepared ? `<div class="inset"><strong>Publication pending retry</strong><p><code>${escape(state.prepared.events[0].eventId)}</code></p></div>` : ''}`;
  return `${publicRecords()}
    ${state.batches.length ? `<details class="settings-preview"><summary>Batch inspector — demo only</summary><p class="muted">Not yet available in the live Observer.</p><ul>${state.batches.map(batch => `<li><code>${batch.id}</code>: ${batch.count} ballot${batch.count === 1 ? '' : 's'}, ${batch.reason}, ${time(batch.releasedAt)}.</li>`).join('')}</ul></details>` : ''}
    ${state.audit ? `<h3>Record checks</h3><ul class="checks">${state.audit.checks.map(check => `<li>${check.ok ? '✓ Pass' : '✕ Failed'} — ${check.name}</li>`).join('')}</ul><h3>${escape(state.questionnaire.questions[0].prompt)}</h3><p class="result">Yes ${state.audit.yes} · No ${state.audit.no}</p>${state.questionnaire.questions.slice(2).map(question => `<p>${escape(question.prompt)} — Yes ${state.released.filter(event => event.answers[question.id] === 'yes').length} · No ${state.released.filter(event => event.answers[question.id] === 'no').length}</p>`).join('')}` : ''}`;
}
function controls() {
  if (view !== chapters[state.stage].role) return `<div class="actions"><button type="button" data-role="${chapters[state.stage].role}">Continue as ${roles[chapters[state.stage].role].name}</button></div>`;
  switch (state.stage) {
    case 0: return `<div class="actions">${actionButton('PREPARE', 'Review questionnaire')}</div>`;
    case 1: return `<div class="actions">${actionButton('OPEN', 'Go Live')}</div>`;
    case 2: return `<form id="admission-form"><label class="field"><span>Paper code</span><input id="paper-code" name="code" type="text" value="${escape(codeInput)}" autocomplete="off" spellcheck="false" aria-describedby="paper-help"></label><label class="field"><span>Master-list number</span><input id="master-number" name="number" type="text" value="${escape(numberInput)}" autocomplete="off"></label><p id="paper-help" class="muted">Use the sample invitation above.</p><div class="actions"><button type="submit">Request ballot</button>${actionButton('FILL', 'Fill example values', true)}</div></form>`;
    case 3: return answerForm();
    case 4: return `<div class="actions">${actionButton('RETRY_RECEIPT', state.receipt === 'lost' ? 'Retry same submission / recover receipt' : 'Retry same submission (no duplicate)', true)}${actionButton('CONTINUE', 'Explore threshold release')}</div>`;
    case 5: return `<div class="actions">${actionButton('ADD_PEER', 'Add next anonymous example ballot')}</div>`;
    case 6:
      if (state.prepared) return `<div class="actions">${actionButton('RESTART', state.restarted ? 'Repeat simulated restart' : 'Simulate worker restart', true)}${actionButton('RETRY_RELEASE', 'Retry prepared batch')}</div>`;
      if (state.accepted === 3) return `<div class="actions">${actionButton('ADD_FINAL', 'Queue final anonymous ballot')}</div>`;
      return `<label class="check"><input type="checkbox" id="fail-release"${failRelease ? ' checked' : ''}>Fail the next publication to rehearse restart and retry</label><div class="actions">${actionButton('DEADLINE', 'Advance clock to deadline')}</div>`;
    case 7: return `<div class="actions">${actionButton('TRY_LATE', 'Try a late ballot', true)}${actionButton('TRY_DUPLICATE', 'Try a duplicate ballot', true)}${actionButton('AUDIT', 'Check simulated records')}</div>`;
    case 8: return `<div class="actions">${actionButton('RESET', 'Reset and repeat the demo')}</div>`;
    default: return '';
  }
}
function render(focusHeading = false) {
  const chapter = chapters[state.stage];
  const status = state.audit?.ok ? 'Result checked' : state.stage >= 7 ? 'Released' : state.stage >= 4 ? 'Voting open' : state.stage >= 2 ? 'Open' : 'Draft';
  const journal = state.log.filter(event => event.audience === view || event.audience === 'public');
  root.innerHTML = `
    <div class="layout">
      <aside class="chapters" aria-label="Guided chapters">
        <details class="chapter-navigation"${window.matchMedia('(min-width: 761px)').matches ? ' open' : ''}>
          <summary class="sidebar-title">Walkthrough <span>${state.stage + 1}/${chapters.length}</span></summary>
          <ol>${chapters.map((item, index) => `<li${index === state.stage ? ' aria-current="step"' : ''}><span class="step-number">${index < state.stage ? '✓' : index + 1}</span><span>${item.title}</span></li>`).join('')}</ol>
        </details>
      </aside>
      <div class="body">
        <header class="hero">
          <div><h1 id="questionnaire-title">${escape(state.questionnaire.title)}</h1><p class="session-meta"><span class="session-status">${status}</span>${state.questionnaire.questions.length} questions · Main ballot</p></div>
          <div class="clock"><span>Demo time</span> <strong>${time(state.clock)}</strong></div>
        </header>
        <div class="role-tabs" role="group" aria-label="Explore a role">${Object.entries(roles).map(([key, role]) => `<button type="button" class="role-tab" data-role="${key}" aria-pressed="${view === key}" aria-controls="workspace">${role.name}</button>`).join('')}</div>
        <section class="workbench" id="workspace" aria-label="${roles[view].name} demo workspace" tabindex="-1">
          ${perspective()}
          <div class="chapter">
            <h2 id="chapter-title" tabindex="-1">${chapter.title}</h2>
            <p class="step-hint">${chapter.goal}</p>
            ${controls()}
          </div>
          ${state.log.length || state.notice !== createDemo().notice ? `<p class="notice" role="status" aria-live="polite">${escape(state.notice)}</p>` : ''}
        </section>
        <details class="step-help"><summary>Help for this step</summary><p>${chapter.lesson}</p><p>${roles[view].text}</p><p>${chapter.boundary}</p></details>
        <details class="records"><summary>${roles[view].name} event journal (${journal.length})</summary><ol>${journal.map(event => `<li><code>${time(event.minute)}</code> — ${event.text}</li>`).join('') || '<li>No events yet.</li>'}</ol></details>
      </div>
    </div>`;
  if (focusHeading) document.getElementById('chapter-title').focus({ preventScroll: true });
}
function dispatch(action) {
  const active = document.activeElement;
  const selector = active?.dataset.action
    ? `[data-action="${active.dataset.action}"]`
    : active?.id ? `#${active.id}` : active?.form?.id ? `#${active.form.id} button[type="submit"]` : null;
  const previous = state.stage;
  state = stepDemo(state, action);
  if (state.stage !== previous) view = state.role;
  render(state.stage !== previous);
  if (state.stage === previous && selector) {
    (root.querySelector(selector) ?? document.getElementById('chapter-title')).focus({ preventScroll: true });
  }
}
function reset() {
  state = createDemo(); view = 'organiser'; codeInput = ''; numberInput = ''; loseReceipt = false; failRelease = true;
  render(true);
}
document.getElementById('reset').addEventListener('click', reset);
root.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('button') : null;
  if (!target) return;
  if (target.dataset.role && roles[target.dataset.role]) {
    view = target.dataset.role; render(); document.querySelector(`.role-tab[data-role="${view}"]`).focus(); return;
  }
  const type = target.dataset.action;
  if (type === 'RESET') { reset(); return; }
  if (type === 'FILL') { codeInput = PAPER_CODE; numberInput = MASTER_NUMBER; render(); document.getElementById('paper-code').focus(); return; }
  if (type) dispatch({ type, id: target.dataset.question, fail: failRelease });
});
root.addEventListener('input', event => {
  const target = event.target;
  if (target.id === 'paper-code') codeInput = target.value;
  if (target.id === 'master-number') numberInput = target.value;
  // Preserve the caret while editing; structural actions render from this state.
  if (target.id === 'questionnaire-name' || target.dataset.question) {
    state = stepDemo(state, target.id === 'questionnaire-name' ? { type: 'EDIT_TITLE', value: target.value } : { type: 'EDIT_QUESTION', id: target.dataset.question, value: target.value });
    document.getElementById('questionnaire-title').textContent = state.questionnaire.title;
  }
});
root.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'lose-receipt') { loseReceipt = target.checked; return; }
  if (target.id === 'fail-release') { failRelease = target.checked; return; }
  if (target.dataset.answer) {
    dispatch({ type: 'ANSWER_EXTRA', id: target.dataset.answer, value: target.value });
    return;
  }
  if (target.name === 'choice' || target.name === 'location') {
    const selector = target.name === 'choice' ? `input[name="choice"][value="${target.value}"]` : '#plot';
    dispatch({ type: 'DRAFT', [target.name]: target.value });
    root.querySelector(selector)?.focus();
  }
});
root.addEventListener('submit', event => {
  event.preventDefault();
  if (event.target.id === 'admission-form') dispatch({ type: 'ADMIT', code: codeInput, number: numberInput });
  if (event.target.id === 'answer-form') dispatch({ type: 'SUBMIT', loseReceipt });
});
render();

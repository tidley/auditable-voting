export const PAPER_CODE = '7K3M9T2X4R';
export const MASTER_NUMBER = '1042';

// Teaching fixtures only. No signing, encryption, persistence or transport.
export function createDemo() {
  return {
    stage: 0, role: 'organiser', clock: 0, credential: false,
    questionnaire: { title: 'Community garden consultation', questions: [
      { id: 'choice', prompt: 'Do you support creating a shared community garden?' },
      { id: 'location', prompt: 'Which plot would you prefer?' },
    ] },
    nextQuestionId: 3,
    draft: { choice: '', location: '', answers: {} }, receipt: 'none',
    queue: [], released: [], batches: [], prepared: null,
    accepted: 0, rejected: 0, restarted: false, audit: null,
    notice: 'Welcome. Prepare the fictional election to begin.',
    log: [],
  };
}

function record(state, text, audience) {
  state.log.push({ minute: state.clock, text, audience });
}

function ballot(state, id, choice, location = null) {
  const answers = Object.fromEntries(state.questionnaire.questions.slice(2).map(question => [question.id, id % 2 ? 'yes' : 'no']));
  return { id: `demo-ballot-00${id}`, nullifier: `fictional-nullifier-00${id}`, choice, location, answers };
}

function prepare(state, reason) {
  const batchId = `demo-batch-${state.batches.length + 1}`;
  // Reproducible example permutation, not a production random shuffle.
  const order = state.queue.length === 3 ? [2, 0, 1] : state.queue.map((_, index) => index);
  state.prepared = {
    id: batchId, reason,
    events: order.map(index => ({
      ...state.queue[index],
      eventId: `fictional-event-${batchId}-${state.queue[index].id}`,
      releasedAt: state.clock,
    })),
  };
}

function release(state) {
  if (!state.prepared) return;
  const { id, reason, events } = state.prepared;
  state.released.push(...events);
  state.batches.push({ id, reason, count: events.length, releasedAt: events[0].releasedAt });
  const ids = new Set(events.map(event => event.id));
  state.queue = state.queue.filter(entry => !ids.has(entry.id));
  state.prepared = null;
  record(state, `${id}: ${events.length} public ballot${events.length === 1 ? '' : 's'} released (${reason}).`, 'public');
}

export function stepDemo(previous, action) {
  const state = structuredClone(previous);
  switch (action.type) {
    case 'EDIT_TITLE':
      if (state.stage < 2) state.questionnaire.title = String(action.value).slice(0, 160);
      break;
    case 'EDIT_QUESTION': {
      const question = state.questionnaire.questions.find(question => question.id === action.id);
      if (state.stage < 2 && question) question.prompt = String(action.value).slice(0, 300);
      break;
    }
    case 'ADD_QUESTION':
      if (state.stage < 2) state.questionnaire.questions.push({ id: `q${state.nextQuestionId++}`, prompt: 'Would you like to take part?' });
      break;
    case 'REMOVE_QUESTION':
      if (state.stage < 2 && !['choice', 'location'].includes(action.id)) state.questionnaire.questions = state.questionnaire.questions.filter(question => question.id !== action.id);
      break;
    case 'PREPARE':
      if (state.stage !== 0) break;
      if (!validQuestionnaire(state)) break;
      state.stage = 1;
      state.notice = 'Fictional questionnaire prepared. No draft or identity was created in the live app.';
      record(state, 'Prepared questions, paper admission and private release policy.', 'organiser');
      break;
    case 'OPEN':
      if (state.stage !== 1) break;
      if (!validQuestionnaire(state)) break;
      state.stage = 2; state.role = 'voter';
      state.notice = 'Simulated election open. Try a wrong paper code, then use the printed example.';
      record(state, 'Simulated definition is public; election open from 10:00 to 10:12.', 'public');
      break;
    case 'ADMIT': {
      if (state.stage !== 2) break;
      const code = String(action.code ?? '').trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
      if (code !== PAPER_CODE || String(action.number ?? '').trim() !== MASTER_NUMBER) {
        state.notice = 'Admission refused: the code and master-list number do not match. Correct them and try again.';
        break;
      }
      state.clock = 1; state.credential = true; state.stage = 3;
      state.notice = 'Simulated credential received. Admission is complete; no answers have been submitted.';
      record(state, 'Example paper admission consumed and bound to this demo voter; credential returned.', 'organiser');
      record(state, 'Fictional blind credential received. It is not a real signature.', 'voter');
      break;
    }
    case 'DRAFT':
      if (state.stage !== 3) break;
      if (['yes', 'no'].includes(action.choice)) state.draft.choice = action.choice;
      if (['', 'north', 'south'].includes(action.location)) state.draft.location = action.location;
      if (state.draft.choice !== 'yes') state.draft.location = '';
      break;
    case 'ANSWER_EXTRA':
      if (state.stage === 3 && state.questionnaire.questions.slice(2).some(question => question.id === action.id) && ['yes', 'no'].includes(action.value)) state.draft.answers[action.id] = action.value;
      break;
    case 'SUBMIT':
      if (state.stage !== 3 || !state.credential) break;
      if (!state.draft.choice || (state.draft.choice === 'yes' && !state.draft.location) || state.questionnaire.questions.slice(2).some(question => !['yes', 'no'].includes(state.draft.answers[question.id]))) {
        state.notice = 'Please complete each visible required question. The location is required only after Yes.';
        break;
      }
      state.clock = 2; state.stage = 4; state.role = 'worker';
      state.queue.push({ ...ballot(state, 1, state.draft.choice, state.draft.choice === 'yes' ? state.draft.location : null), answers: { ...state.draft.answers } });
      state.accepted = 1; state.receipt = action.loseReceipt ? 'lost' : 'queued';
      state.notice = action.loseReceipt
        ? 'Ballot queued, but the receipt was deliberately lost. The voter cannot yet confirm intake. Retry the same submission.'
        : 'Queued privately. Durable intake is simulated; public release and final tally are still pending.';
      record(state, 'Anonymous ballot validated and placed in the simulated private queue.', 'worker');
      record(state, action.loseReceipt ? 'Receipt lost; awaiting confirmation.' : 'Queued privately receipt received.', 'voter');
      record(state, 'Aggregate progress: accepted 1, queued 1, public 0.', 'organiser');
      break;
    case 'RETRY_RECEIPT':
      if (state.stage < 4 || state.receipt === 'none') break;
      state.receipt = 'queued';
      state.notice = 'The same submission returns its existing receipt. Accepted count stays unchanged.';
      record(state, 'Existing intake receipt replayed; no second ballot created.', 'voter');
      break;
    case 'CONTINUE':
      if (state.stage === 4) { state.stage = 5; state.role = 'worker'; }
      break;
    case 'ADD_PEER':
      if (![4, 5].includes(state.stage) || state.queue.length >= 3) break;
      state.stage = 5; state.clock = state.queue.length + 2;
      state.queue.push(ballot(state, state.accepted + 1, state.accepted === 1 ? 'no' : 'yes', state.accepted === 2 ? 'south' : null));
      state.accepted += 1;
      if (state.queue.length === 3) {
        prepare(state, 'threshold'); release(state); state.stage = 6;
        state.notice = 'Threshold reached: three ballots released in a fixed example shuffle, all with the release time.';
      } else state.notice = 'Two accepted ballots remain private. Nothing is publicly released below the threshold.';
      record(state, `Aggregate progress: accepted ${state.accepted}, queued ${state.queue.length}, public ${state.released.length}.`, 'organiser');
      break;
    case 'ADD_FINAL':
      if (state.stage !== 6 || state.accepted !== 3) break;
      state.clock = 8; state.queue.push(ballot(state, 4, 'yes', 'north')); state.accepted = 4;
      state.notice = 'One final ballot is queued below threshold. Advance the simulated clock to release it at the deadline.';
      record(state, 'Aggregate progress: accepted 4, queued 1, public 3.', 'organiser');
      break;
    case 'DEADLINE':
      if (state.stage !== 6 || state.queue.length !== 1 || state.prepared) break;
      state.clock = 12; prepare(state, 'deadline');
      if (action.fail) {
        state.notice = 'Simulated publication failure. The prepared batch and exact event IDs are retained for retry.';
        record(state, 'Prepared final batch; simulated relay failure before completion.', 'worker');
      } else {
        release(state); state.stage = 7; state.role = 'observer';
        state.notice = 'Deadline batch released below threshold. Public records are now ready for simulated audit.';
      }
      break;
    case 'RESTART':
      if (!state.prepared) break;
      state.restarted = true;
      state.notice = 'Simulated worker restarted from the in-memory snapshot. Prepared event IDs are unchanged. This is not a real process restart.';
      record(state, 'Restored prepared batch from an in-memory teaching snapshot.', 'worker');
      break;
    case 'RETRY_RELEASE':
      if (!state.prepared) break;
      release(state); state.stage = 7; state.role = 'observer';
      state.notice = 'Retry completed with identical prepared event IDs. No additional ballot was created.';
      break;
    case 'TRY_LATE':
      if (state.clock < 12) break;
      state.rejected += 1;
      state.notice = 'Late example refused: the submission deadline has passed. The tally is unchanged.';
      record(state, 'Late example refused without adding a public ballot.', 'worker');
      break;
    case 'TRY_DUPLICATE':
      if (!state.accepted) break;
      state.rejected += 1;
      state.notice = 'Duplicate example refused: the fictional nullifier is already used. The tally is unchanged.';
      record(state, 'Duplicate example refused without adding a public ballot.', 'worker');
      break;
    case 'AUDIT':
      if (state.stage !== 7) break;
      state.audit = verifyDemo(state);
      state.stage = state.audit.ok ? 8 : 7;
      state.notice = state.audit.ok
        ? 'Simulated records reconcile. This checks the fixture data, not real signatures, encryption or relay delivery.'
        : 'Simulated reconciliation failed. Inspect the checks below.';
      break;
  }
  return state;
}

function validQuestionnaire(state) {
  if (state.questionnaire.title.trim() && state.questionnaire.questions.every(question => question.prompt.trim())) return true;
  state.notice = 'Enter a questionnaire title and wording for every question, then try again.';
  return false;
}

export function verifyDemo(state) {
  const ids = new Set(state.released.map(event => event.eventId));
  const nullifiers = new Set(state.released.map(event => event.nullifier));
  const checks = [
    { name: 'All four accepted example ballots are released; none remain queued', ok: state.accepted === 4 && state.released.length === 4 && state.queue.length === 0 && !state.prepared },
    { name: 'Public event IDs and fictional nullifiers are unique', ok: ids.size === 4 && nullifiers.size === 4 },
    { name: 'Every simulated batch count matches its released records', ok: state.batches.length === 2 && state.batches.every(batch => state.released.filter(event => event.eventId.startsWith(`fictional-event-${batch.id}-`)).length === batch.count) },
    { name: 'No paper code, number or admission field is attached to public ballots', ok: state.released.every(event => Object.keys(event).every(key => ['id', 'nullifier', 'choice', 'location', 'answers', 'eventId', 'releasedAt'].includes(key)) && Object.keys(event.answers ?? {}).every(key => state.questionnaire.questions.slice(2).some(question => question.id === key))) },
    { name: 'Conditional answers match the visible question path', ok: state.released.every(event => ['yes', 'no'].includes(event.choice) && (event.choice === 'yes' ? ['north', 'south'].includes(event.location) : event.location === null)) },
    { name: 'Every added question has a valid answer', ok: state.released.every(event => state.questionnaire.questions.slice(2).every(question => ['yes', 'no'].includes(event.answers?.[question.id]))) },
  ];
  return { ok: checks.every(check => check.ok), checks, yes: state.released.filter(event => event.choice === 'yes').length, no: state.released.filter(event => event.choice === 'no').length };
}

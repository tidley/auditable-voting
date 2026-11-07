import { describe, expect, it } from 'vitest';
import { createDemo, stepDemo, verifyDemo, PAPER_CODE, MASTER_NUMBER } from '../public/demo-model.js';

function admit() {
  let state = stepDemo(createDemo(), { type: 'PREPARE' });
  state = stepDemo(state, { type: 'OPEN' });
  return stepDemo(state, { type: 'ADMIT', code: PAPER_CODE, number: MASTER_NUMBER });
}
function queued(lost = false) {
  let state = admit();
  state = stepDemo(state, { type: 'DRAFT', choice: 'yes', location: 'north' });
  return stepDemo(state, { type: 'SUBMIT', loseReceipt: lost });
}
function threshold() {
  let state = queued();
  state = stepDemo(state, { type: 'ADD_PEER' });
  return stepDemo(state, { type: 'ADD_PEER' });
}

describe('offline voting sandbox', () => {
  it('edits pre-filled questions, adds and removes questions only before opening', () => {
    const original = createDemo();
    let state = stepDemo(original, { type: 'EDIT_TITLE', value: 'Our consultation' });
    state = stepDemo(state, { type: 'EDIT_QUESTION', id: 'choice', value: 'Do you agree?' });
    state = stepDemo(state, { type: 'ADD_QUESTION' });
    expect(state.questionnaire.title).toBe('Our consultation');
    expect(state.questionnaire.questions[0].prompt).toBe('Do you agree?');
    expect(state.questionnaire.questions).toHaveLength(3);
    expect(original.questionnaire.questions).toHaveLength(2);
    state = stepDemo(state, { type: 'REMOVE_QUESTION', id: 'q3' });
    expect(state.questionnaire.questions).toHaveLength(2);
    state = stepDemo(stepDemo(state, { type: 'PREPARE' }), { type: 'OPEN' });
    expect(stepDemo(state, { type: 'ADD_QUESTION' }).questionnaire).toEqual(state.questionnaire);
    expect(stepDemo(state, { type: 'EDIT_TITLE', value: 'Changed' }).questionnaire).toEqual(state.questionnaire);
  });
  it('requires non-empty title and question wording before review or opening', () => {
    let state = stepDemo(createDemo(), { type: 'EDIT_TITLE', value: ' ' });
    expect(stepDemo(state, { type: 'PREPARE' }).stage).toBe(0);
    state = stepDemo(createDemo(), { type: 'PREPARE' });
    state = stepDemo(state, { type: 'EDIT_QUESTION', id: 'choice', value: '' });
    expect(stepDemo(state, { type: 'OPEN' }).stage).toBe(1);
  });
  it('carries added required answers through release and checks them during audit', () => {
    let state = stepDemo(createDemo(), { type: 'ADD_QUESTION' });
    state = stepDemo(stepDemo(state, { type: 'PREPARE' }), { type: 'OPEN' });
    state = stepDemo(state, { type: 'ADMIT', code: PAPER_CODE, number: MASTER_NUMBER });
    state = stepDemo(state, { type: 'DRAFT', choice: 'no' });
    expect(stepDemo(state, { type: 'SUBMIT' }).stage).toBe(3);
    state = stepDemo(state, { type: 'ANSWER_EXTRA', id: 'q3', value: 'yes' });
    state = stepDemo(state, { type: 'SUBMIT' });
    expect(state.queue[0].answers).toEqual({ q3: 'yes' });
    state = stepDemo(stepDemo(state, { type: 'ADD_PEER' }), { type: 'ADD_PEER' });
    state = stepDemo(stepDemo(state, { type: 'ADD_FINAL' }), { type: 'DEADLINE' });
    expect(verifyDemo(state).ok).toBe(true);
    state.released[0].answers = {};
    expect(verifyDemo(state).ok).toBe(false);
  });
  it('always resets to the same fictional starting state without storage', () => {
    expect(createDemo()).toEqual(createDemo());
    expect(createDemo().stage).toBe(0);
    expect(createDemo().released).toEqual([]);
  });
  it('requires setup and admission before a submission', () => {
    const state = stepDemo(createDemo(), { type: 'SUBMIT' });
    expect(state.queue).toHaveLength(0);
    expect(state.stage).toBe(0);
  });
  it('keeps invalid paper entry correctable without issuing a credential', () => {
    const open = stepDemo(stepDemo(createDemo(), { type: 'PREPARE' }), { type: 'OPEN' });
    const bad = stepDemo(open, { type: 'ADMIT', code: 'INVALID', number: MASTER_NUMBER });
    expect(bad.credential).toBe(false);
    expect(bad.stage).toBe(2);
    expect(stepDemo(bad, { type: 'ADMIT', code: PAPER_CODE.toLowerCase(), number: MASTER_NUMBER }).credential).toBe(true);
  });
  it('requires visible answers and removes hidden follow-up answers', () => {
    let state = stepDemo(admit(), { type: 'DRAFT', choice: 'yes' });
    expect(stepDemo(state, { type: 'SUBMIT' }).queue).toHaveLength(0);
    state = stepDemo(state, { type: 'DRAFT', choice: 'no', location: 'north' });
    state = stepDemo(state, { type: 'SUBMIT' });
    expect(state.queue[0].location).toBeNull();
    expect(JSON.stringify(state.queue)).not.toContain(PAPER_CODE);
    expect(JSON.stringify(state.queue)).not.toContain(MASTER_NUMBER);
  });
  it('clears a previously selected required plot when the placeholder is selected', () => {
    let state = stepDemo(admit(), { type: 'DRAFT', choice: 'yes', location: 'north' });
    state = stepDemo(state, { type: 'DRAFT', location: '' });
    expect(state.draft.location).toBe('');
    expect(stepDemo(state, { type: 'SUBMIT' }).queue).toHaveLength(0);
  });
  it('distinguishes sent, durable intake and received acknowledgement', () => {
    let state = queued(true);
    expect(state.receipt).toBe('lost');
    expect(state.queue).toHaveLength(1);
    expect(state.released).toHaveLength(0);
    state = stepDemo(state, { type: 'RETRY_RECEIPT' });
    expect(state.receipt).toBe('queued');
    expect(state.queue).toHaveLength(1);
  });
  it('withholds public ballots until threshold then shuffles a fixed batch', () => {
    const one = queued();
    const two = stepDemo(one, { type: 'ADD_PEER' });
    expect(two.released).toHaveLength(0);
    const three = stepDemo(two, { type: 'ADD_PEER' });
    expect(three.queue).toHaveLength(0);
    expect(three.released.map(ballot => ballot.id)).toEqual(['demo-ballot-003', 'demo-ballot-001', 'demo-ballot-002']);
    expect(new Set(three.released.map(ballot => ballot.releasedAt)).size).toBe(1);
    expect(three.batches[0].reason).toBe('threshold');
  });
  it('releases a below-threshold final batch at the simulated deadline', () => {
    let state = stepDemo(threshold(), { type: 'ADD_FINAL' });
    expect(state.queue).toHaveLength(1);
    state = stepDemo(state, { type: 'DEADLINE' });
    expect(state.released).toHaveLength(4);
    expect(state.batches[1].reason).toBe('deadline');
  });
  it('preserves prepared event IDs through simulated restart and retry', () => {
    let state = stepDemo(threshold(), { type: 'ADD_FINAL' });
    state = stepDemo(state, { type: 'DEADLINE', fail: true });
    const ids = state.prepared.events.map(event => event.eventId);
    const snapshot = JSON.parse(JSON.stringify(state));
    state = stepDemo(snapshot, { type: 'RESTART' });
    expect(state.prepared.events.map(event => event.eventId)).toEqual(ids);
    state = stepDemo(state, { type: 'RETRY_RELEASE' });
    expect(state.released.slice(-1).map(event => event.eventId)).toEqual(ids);
    expect(stepDemo(state, { type: 'RETRY_RELEASE' }).released).toHaveLength(4);
  });
  it('rejects late and duplicate ballots without changing the tally', () => {
    let state = stepDemo(stepDemo(threshold(), { type: 'ADD_FINAL' }), { type: 'DEADLINE' });
    state = stepDemo(state, { type: 'TRY_LATE' });
    state = stepDemo(state, { type: 'TRY_DUPLICATE' });
    expect(state.released).toHaveLength(4);
    expect(state.rejected).toBe(2);
  });
  it('checks actual simulated data, not a hard-coded pass', () => {
    const state = stepDemo(stepDemo(threshold(), { type: 'ADD_FINAL' }), { type: 'DEADLINE' });
    expect(verifyDemo(state).ok).toBe(true);
    expect(verifyDemo({ ...state, released: [...state.released, state.released[0]] }).ok).toBe(false);
    expect(verifyDemo({ ...state, queue: [state.released[0]] }).ok).toBe(false);
  });
});

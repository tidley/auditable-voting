import { describe, expect, it } from 'vitest';
import { buildQuestionEditorTree } from './questionnaireEditorTree';

const question = (questionId: string, parent?: string) => ({
  questionId,
  showIf: parent ? { dependsOnQuestionId: parent, requiredAnswer: { answerType: 'yes_no' as const, value: true } } : null,
});

describe('questionnaire editor hierarchy', () => {
  it('numbers standalone questions separately and nests their follow-ups', () => {
    const questions = [question('q1'), question('q2', 'q1'), question('q3', 'q1'), question('q4')];
    const tree = buildQuestionEditorTree(questions);
    expect(tree.map(node => node.label)).toEqual(['1', '2']);
    expect(tree[0].children.map(node => node.label)).toEqual(['1-A', '1-B']);
    expect(tree[0].children[0].index).toBe(1);
    expect(questions.map(entry => entry.questionId)).toEqual(['q1', 'q2', 'q3', 'q4']);
  });
  it('supports deeper follow-ups and alphabetic labels beyond Z', () => {
    const tree = buildQuestionEditorTree([question('root'), ...Array.from({ length: 27 }, (_, i) => question(`q${i}`, 'root')), question('nested', 'q0')]);
    expect(tree[0].children[26].label).toBe('1-AA');
    expect(tree[0].children[0].children[0].label).toBe('1-A-A');
  });
  it('keeps missing, forward and self-linked questions visible for correction', () => {
    const tree = buildQuestionEditorTree([question('q1', 'q2'), question('q2', 'q2'), question('q3', 'missing')]);
    expect(tree.map(node => node.question.questionId)).toEqual(['q1', 'q2', 'q3']);
    expect(tree.every(node => node.children.length === 0)).toBe(true);
  });
});

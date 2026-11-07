import type { QuestionnaireQuestionBase } from './questionnaireProtocol';

export type QuestionEditorNode<T> = {
  question: T;
  index: number;
  label: string;
  children: QuestionEditorNode<T>[];
};

/** A presentation-only tree. Keep source order, IDs and saved conditions intact. */
export function buildQuestionEditorTree<T extends Pick<QuestionnaireQuestionBase, 'questionId' | 'showIf'>>(questions: T[]): QuestionEditorNode<T>[] {
  const roots: QuestionEditorNode<T>[] = [];
  const seen = new Map<string, QuestionEditorNode<T>>();
  questions.forEach((question, index) => {
    const node: QuestionEditorNode<T> = { question, index, label: '', children: [] };
    // Only earlier parents are valid. Keep broken links visible at root level.
    const parent = question.showIf && question.showIf.dependsOnQuestionId !== question.questionId
      ? seen.get(question.showIf.dependsOnQuestionId) : null;
    (parent ? parent.children : roots).push(node);
    seen.set(question.questionId, node);
  });
  function letter(index: number): string {
    let result = '';
    for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
      result = String.fromCharCode(65 + (value - 1) % 26) + result;
    }
    return result;
  }
  function number(nodes: QuestionEditorNode<T>[], parent = '') {
    nodes.forEach((node, index) => {
      node.label = parent ? `${parent}-${letter(index)}` : String(index + 1);
      number(node.children, node.label);
    });
  }
  number(roots);
  return roots;
}

/** Use the same display labels in results, independent of filtering or summary order. */
export function buildQuestionLabelMap<T extends Pick<QuestionnaireQuestionBase, 'questionId' | 'showIf'>>(questions: T[]): Map<string, string> {
  const labels = new Map<string, string>();
  function collect(nodes: QuestionEditorNode<T>[]) {
    nodes.forEach(node => {
      labels.set(node.question.questionId, node.label);
      collect(node.children);
    });
  }
  collect(buildQuestionEditorTree(questions));
  return labels;
}

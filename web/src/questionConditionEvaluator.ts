/**
 * Condition evaluator for follow-up / conditional questions.
 *
 * Given a question and a map of answers collected so far, determines whether
 * the question should be visible to the voter.
 *
 * Visibility rules:
 * 1. No `showIf` → always visible.
 * 2. `showIf` present but the dependency question has not been answered → hidden.
 * 3. `showIf` present and the dependency has been answered → evaluate the condition:
 *    - yes_no: compare boolean value.
 *    - multiple_choice: every required option id must be present in the selected set.
 * 4. If the condition's answer type does not match the actual answer type → hidden.
 * 5. A self-referential (circular) `showIf` throws `CircularDependencyError`.
 */

import type {
  QuestionnaireQuestion,
  QuestionnaireResponseAnswer,
} from "./questionnaireProtocol";

/**
 * Thrown when a question's `showIf` chain contains a cycle (e.g. a question
 * that depends on itself, directly or transitively).
 */
export class CircularDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircularDependencyError";
    Object.setPrototypeOf(this, CircularDependencyError.prototype);
  }
}

/**
 * Determine whether a question should be shown given the answers collected so far.
 *
 * @param question          The question to evaluate.
 * @param answeredQuestions Map of questionId → answer for all questions answered so far.
 * @param allQuestions      Optional map of all questions in the definition (for cycle detection).
 *                          When provided, transitive `showIf` chains are checked for cycles.
 * @returns `true` if the question should be visible, `false` if it should be hidden.
 * @throws  {CircularDependencyError} If a circular dependency is detected.
 */
export function shouldShowQuestion(
  question: QuestionnaireQuestion,
  answeredQuestions: Map<string, QuestionnaireResponseAnswer>,
  allQuestions?: Map<string, QuestionnaireQuestion>,
): boolean {
  const condition = question.showIf;
  if (condition === undefined || condition === null) {
    return true;
  }

  // Cycle detection: if the question depends on itself directly, or (when we
  // have the full question map) transitively, throw.
  const visited = new Set<string>();
  checkForCycle(question.questionId, condition.dependsOnQuestionId, allQuestions, visited);

  const depAnswer = answeredQuestions.get(condition.dependsOnQuestionId);
  if (depAnswer === undefined) {
    // Dependency not yet answered → hide.
    return false;
  }

  return evaluateCondition(condition.requiredAnswer, depAnswer);
}

/* ------------------------------------------------------------------ */
/* internal helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Walk the `showIf` chain from `currentId` → `dependsOnId` and detect cycles.
 *
 * We follow the chain: starting from the original question, we check whether
 * its dependency points back to it. When `allQuestions` is available we can
 * walk transitively; otherwise we only catch the direct self-reference.
 */
function checkForCycle(
  originalId: string,
  dependsOnId: string,
  allQuestions: Map<string, QuestionnaireQuestion> | undefined,
  visited: Set<string>,
): void {
  // Direct self-reference.
  if (dependsOnId === originalId) {
    throw new CircularDependencyError(
      `Circular dependency detected: question "${originalId}" depends on itself.`,
    );
  }

  // Without the full question map we can only catch direct self-references.
  if (!allQuestions) {
    return;
  }

  // Transitive cycle detection: walk the chain.
  let currentId = dependsOnId;
  while (currentId !== undefined) {
    if (currentId === originalId) {
      throw new CircularDependencyError(
        `Circular dependency detected: question "${originalId}" is part of a showIf cycle.`,
      );
    }
    if (visited.has(currentId)) {
      // Already traversed this node from a different branch — not a cycle
      // involving originalId, so stop.
      break;
    }
    visited.add(currentId);

    const depQuestion = allQuestions.get(currentId);
    if (!depQuestion || !depQuestion.showIf) {
      break;
    }
    currentId = depQuestion.showIf.dependsOnQuestionId;
  }
}

/**
 * Evaluate whether the actual answer satisfies the required answer.
 *
 * Returns `false` (hidden) when the answer types don't match — this is a
 * data inconsistency that the protocol validator should catch at definition
 * time, but at runtime we fail safe by hiding the question.
 */
function evaluateCondition(
  required: QuestionnaireResponseAnswer | { answerType: "yes_no"; value: boolean } | { answerType: "multiple_choice"; selectedOptionIds: string[] },
  actual: QuestionnaireResponseAnswer,
): boolean {
  if (required.answerType === "yes_no" && actual.answerType === "yes_no") {
    return required.value === actual.value;
  }

  if (required.answerType === "multiple_choice" && actual.answerType === "multiple_choice") {
    const requiredSet = new Set(required.selectedOptionIds);
    // Every required option must be present in the actual selection.
    for (const reqId of requiredSet) {
      if (!actual.selectedOptionIds.includes(reqId)) {
        return false;
      }
    }
    return true;
  }

  // Answer type mismatch → fail safe (hide).
  return false;
}
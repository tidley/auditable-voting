// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { buildPaperBallotDocument } from './paperBallotDocument';
import { generatePaperBallot } from './paperBallot';
import type { QuestionnaireDefinition } from './questionnaireProtocol';

it('builds a self-contained printable document and escapes untrusted content', () => {
  const definition = { questionnaireId: 'q-paper', title: '<script>alert(1)</script>', questions: [
    { questionId: 'q1', type: 'yes_no', prompt: '<img src=x onerror=alert(1)>', required: true },
    { questionId: 'q2', type: 'free_text', prompt: 'Explain', required: true, showIf: { dependsOnQuestionId: 'q1', requiredAnswer: { answerType: 'yes_no', value: true } } },
  ] } as QuestionnaireDefinition;
  const html = buildPaperBallotDocument([generatePaperBallot({ definition, masterlistNumber: 'ML-001', code: '7K3M9T2X4R', expiresAt: '2030-01-01T00:00:00Z' })]);
  const document = new DOMParser().parseFromString(html, 'text/html');
  expect(document.querySelectorAll('script, img, link, iframe')).toHaveLength(0);
  expect(document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'");
  expect(document.body.textContent).toContain('7K3M9-T2X4R');
  expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(document.body.textContent).toContain('1-A. Explain');
  expect(document.querySelector('style')?.textContent).toContain('@page');
});

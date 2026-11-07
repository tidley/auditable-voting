import { renderToStaticMarkup } from 'react-dom/server';
import PaperBallotPrint from './PaperBallotPrint';
import type { PaperBallot } from './paperBallot';

const printStyles = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #eee; color: #111; font: 11pt/1.5 Arial, sans-serif; }
  .paper-document-help { max-width: 210mm; margin: 20px auto; padding: 0 20px; }
  .ballot-print { width: min(210mm, 100%); margin: 20px auto; padding: clamp(16px, 4vw, 18mm); background: white; border: 1px solid #ccc; }
  .ballot-header { border-bottom: 1px solid #333; margin-bottom: 20px; padding-bottom: 12px; }
  .ballot-title { margin: 0 0 8px; font-size: 20pt; line-height: 1.2; overflow-wrap: anywhere; }
  .ballot-id { font-size: 9pt; overflow-wrap: anywhere; }
  .ballot-section-title { font-size: 14pt; }
  .ballot-info { padding-bottom: 12px; border-bottom: 1px solid #aaa; margin-bottom: 20px; }
  .ballot-info code { font: bold 16pt monospace; letter-spacing: .1em; }
  .ballot-question { margin: 20px 0; break-inside: avoid; }
  .ballot-question-prompt { font-weight: bold; overflow-wrap: anywhere; }
  .ballot-condition { border: 1px solid #aaa; padding: 8px 10px; font-size: 10pt; }
  .ballot-option { margin: 8px 0 8px 12px; overflow-wrap: anywhere; }
  .ballot-blank-line { height: 8mm; border-bottom: 1px solid #aaa; }
  @page { size: A4; margin: 15mm; }
  @media print {
    body { background: white; }
    .paper-document-help { display: none; }
    .ballot-print { width: auto; margin: 0; padding: 0; border: 0; break-after: page; }
    .ballot-print:last-child { break-after: auto; }
  }
`;

/** Local, self-contained document. Never load scripts, fonts, relays or remote assets. */
export function buildPaperBallotDocument(ballots: PaperBallot[]): string {
  return '<!doctype html>' + renderToStaticMarkup(
    <html lang='en-GB'>
      <head>
        <meta charSet='utf-8' />
        <meta name='viewport' content='width=device-width, initial-scale=1' />
        <meta httpEquiv='Content-Security-Policy' content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" />
        <title>Paper ballots — {ballots[0]?.questionnaireTitle ?? 'Questionnaire'}</title>
        <style>{printStyles}</style>
      </head>
      <body>
        <aside className='paper-document-help'>
          <p><strong>Print or save these paper ballots</strong></p>
          <p>Use your browser’s Print command (Ctrl+P or ⌘P). Choose Save as PDF to keep a PDF copy.</p>
          <p>This document contains admission codes and master-list numbers. Keep it private and store any downloaded copy securely.</p>
        </aside>
        <main>{ballots.map(ballot => <PaperBallotPrint key={ballot.code} ballot={ballot} />)}</main>
      </body>
    </html>,
  );
}

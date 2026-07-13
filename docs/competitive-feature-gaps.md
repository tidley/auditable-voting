# Competitive Feature Gaps

Reviewed on 2026-06-11 against:

- The CX Lead, "10 Best Polling Software Of 2026: Reviewed & Compared": https://thecxlead.com/tools/best-polling-software/
- Capterra, "Best Voting Software 2026": https://www.capterra.com/voting-software/

## Current position

Auditable Voting is differentiated by public verification, blind ballot credentials, anonymous submission identities, organiser-controlled admission, observer-side result checking, and a browser-local Nostr-first architecture.

The main commercial gap is not the core cryptographic model. It is the surrounding product surface that non-technical organisers expect when running a real vote or live questionnaire session.

## High-priority missing features

### Questionnaire creation

- Template library for common votes, meetings, surveys, AGMs, board decisions, course feedback, and quick yes/no questions.
- Duplicate or clone questionnaire, including cloning questions from a previous questionnaire in the same organiser session.
- Question bank for reusing common questions across a sequence of votes.
- Batch import of questions from CSV, Markdown, or pasted numbered lists.
- Preview/test mode that lets an organiser walk through the voter experience before publishing.
- More question types: rating scale, ranking, score, matrix/grid, numeric, date, image choice, and optional file/media prompts.
- Conditional logic and branching, especially for survey-style use cases where later questions depend on earlier answers.
- Clearer support for "made on the spot" questions during a live session.

### Voter and roster management

- Import voters from CSV or pasted lists.
- Persistent member/voter database per organiser identity, with labels, internal notes, groups, and eligibility rules.
- Voter groups or segments so only a subset of admitted voters can access a specific questionnaire.
- Turnout tracking by questionnaire and by admitted voter.
- Scheduled and manual reminders for voters who have not yet requested a ballot or submitted.
- Optional authentication modes for less technical groups, such as email one-time codes, membership numbers, or SSO, while preserving the current privacy-preserving Nostr identity path.
- Clear attendee capacity guidance and stress-tested flows for 60+ voters and 20+ questionnaires.

### Election and meeting workflows

- Candidate profile support for election-style ballots.
- Nomination workflow for candidates, motions, or options before voting opens.
- Agenda/motion workflow for live meetings, including amendments and sequential questions.
- Weighted voting for organisations where members have different vote weights.
- Additional counting methods: ranked choice, STV, approval voting, score voting, quorum thresholds, abstentions, undervotes, and overvotes.
- Proxy or delegated voting as a formal workflow, distinct from the technical relay/proxy behaviour.
- Printed or offline fallback materials for hybrid meetings.

### Live session experience

- Presentation mode for displaying active question, QR code, turnout, and final result on a shared screen.
- Live audience tools: Q&A, moderated questions, word clouds, quizzes, and quick sentiment checks.
- "Next question" orchestration for organisers, with voters automatically guided through a sequence.
- Better mobile-first live flow for voters joining by QR code.
- Offline or poor-connectivity behaviour that clearly explains whether the vote is queued, pending relay delivery, or not yet submitted.

### Results, audit, and reporting

- Turnout dashboard with live counts: invited, ballot requested, ballot issued, submitted, accepted, invalid.
- Report builder for non-technical stakeholders.
- Export formats beyond current raw/public data views: CSV, XLSX, PDF, and printable summary.
- Audit package export containing questionnaire definition, accepted submissions, invalid submissions with reasons, result calculation, relay metadata, and verification instructions.
- Plain-English verification receipt for voters.
- Result publication preview before publishing final results.
- Cross-questionnaire reporting for a sequence of related votes.
- Charts suitable for presentation, not only inspection.

### Distribution and integrations

- Email and SMS distribution for invitations, reminders, receipts, and final result notices.
- Calendar links for scheduled votes or meeting sessions.
- Slack, Microsoft Teams, Zoom, PowerPoint, Google Slides, and LMS integrations for meeting and education use cases.
- Webhooks or API for organisations that want to integrate with member databases or internal systems.
- CRM/member-system import paths, especially for associations and non-profits.

### Branding, accessibility, and administration

- Custom branding: logo, colours, fonts, ballot theme, and custom domains.
- Multiple organiser/admin accounts with roles and permissions.
- Workspace or organisation model so a group can manage votes without sharing one browser identity.
- Accessibility review for screen reader use, keyboard navigation, colour contrast, and plain-language copy.
- Multilingual voter UI and organiser-defined translations for questionnaire text.
- Mobile app-like polish for iPhone and Android browsers.
- Help centre material, demo scripts, screenshots, training videos, and troubleshooting guides.

### Compliance and trust material

- Clear privacy policy and data-retention explanation for the browser-local/Nostr model.
- GDPR-oriented documentation, including what personal data is and is not stored.
- Security model document for non-technical buyers.
- Operational risk guidance: relay availability, browser storage loss, organiser key loss, and recovery limits.
- Formal accessibility and security claims only after testing supports them.

## Lower-priority or context-dependent features

- Payment/order forms are common in form builders, but are only relevant if the product expands into paid events or membership workflows.
- Gamification and leaderboards may help live engagement, but should not bleed into serious elections where they could make the vote feel less formal.
- Heavy CRM automation is useful for customer-feedback products, but less central for auditable voting unless targeting associations with established member systems.
- Biometric authentication conflicts with the current privacy-minimising direction and should not be a default path.
- On-premise deployment is attractive to some buyers, but it changes the support and security model substantially.

## Near-term product recommendations

For the likely near-term use case of around 60 voters answering around 20 questions, prioritise:

1. Clone/duplicate questionnaire and batch question import.
2. Persistent admitted-voter roster with CSV import, labels, groups, and automatic carry-forward until removal.
3. Organiser live-session controls: publish current question, move to next question, and show voter progress.
4. Voter sequence navigation that clearly shows current question, completed questions, and next unanswered questionnaire.
5. Turnout dashboard covering invited, requested, issued, submitted, accepted, and invalid states.
6. Non-technical observer report export showing final counts, invalid reasons, and how to verify the result.
7. Mobile QR join flow tested against repeated questionnaire changes during a live session.
8. Relay-efficiency hardening for 60 voters and repeated questionnaire announcements.

## Preserve as deliberate differentiators

- Public observer verification should remain a first-class workflow, not a hidden export.
- Blind ballot credentials and anonymous submission identities should remain central.
- The system should avoid requiring email, phone number, or a central account unless introduced as an optional organiser-selected mode.
- Auditability should remain explainable to non-technical people in plain English.
- Any admin convenience feature should be checked against the privacy and verifiability model before implementation.

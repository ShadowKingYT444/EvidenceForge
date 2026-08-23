# EvidenceForge frontend system

## Design thesis

EvidenceForge is a calm forensic research instrument: pull-request review for evidence-backed claims, joined with a scientific source table and an auditable notebook. The interface makes the chain from question to human decision visible without presenting itself as chat, a generic AI dashboard, or a decorative terminal.

## Layout model

The live workbench uses a compact global header and a three-region desktop grid: a quiet 184-220 px stage rail, a `minmax(0, 1fr)` working surface, and a 256-320 px contextual inspector. Below 1248 px the inspector is available as a modal drawer. Below 928 px the stage rail becomes a horizontally scrollable stage control. Page-level horizontal overflow is prohibited; comparative source tables own their internal overflow.

## Typography

Geist Sans is the primary reading face and Geist Mono is limited to identifiers, stage counters, provider metadata, and technical state labels. Body text is 14-15 px with 1.45-1.6 line height. Claims, questions, and passages use the reading face and are never line-clamped. Workspace titles scale from 28-44 px; the landing title scales from 52-64 px.

## Color roles

- Ink background: `--ef-bg`
- Raised work surface: `--ef-bg-raised` and `--ef-surface`
- Interactive/selected surface: `--ef-surface-raised`
- Divider: `--ef-line` and `--ef-line-strong`
- Primary accent/focus/current stage: `--ef-primary`
- Active operation: `--ef-cyan`
- Verified/ready: `--ef-success`
- Uncertain/review: `--ef-warning`
- Failed/rejected: `--ef-danger`
- Not started/unavailable: muted gray text and neutral borders

Semantic color is always paired with text, an icon, or a state label.

## Spacing and radius

Spacing follows a 4 px-derived scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, and 64 px. Controls use a 6-8 px radius; bounded working surfaces use 10-12 px. Rows use dividers and alignment rather than nested cards.

## Surface hierarchy

The page background establishes the instrument. The main working surface is the only elevated desktop surface. Stage content uses open sections, table rows, and ledger dividers. Drawers are reserved for provenance, exact passages, activity, source details, and object-level review.

## State language

Use operational labels: Start investigation, Review claim contract, Search scholarly sources, Verify exact passages, Independent review, Evidence shortfall, Provider unavailable, Freeze evidence packet, Record decision, and Export canonical record. Unavailable fields render as an em dash or “Not started.” Failures and retries remain in the activity record.

## Responsive behavior

At 1280 px and above, content remains dominant and the inspector is shown when space permits. At 1024 px the inspector is a drawer and the stage control is horizontal. Tables may scroll internally. The primary question wraps at every viewport. Controls retain practical touch targets.

## Interaction patterns

Selecting a claim, source, passage, or objection opens its contextual record. Drawers close with Escape and return focus to the trigger. Stage advancement is explicit and follows the existing state machine. Loading states expose the active pipeline substage; they never show a second action for the same in-flight operation.

## Accessibility expectations

Target WCAG AA contrast, visible `:focus-visible` treatment, logical heading order, explicit form labels, named tables, `aria-current` stage state, `aria-live` pipeline state, non-color status text, reduced-motion support, modal focus containment, Escape-to-close, trigger focus return, and no page-level horizontal overflow.

## Known workflow boundary

Claim text is reviewable but immutable because the current live API exposes no claim-edit action. The UI states this limitation and does not render a fake edit control. Provider-dependent live stages use deterministic browser fixtures for visual regression coverage when credentials are unavailable.

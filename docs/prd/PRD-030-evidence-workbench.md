# PRD-030 — Evidence Workbench

## Lane mission

Build one polished, accessible product route that makes the workflow’s value legible in seconds and lets a user inspect every claim, source relationship, experiment objection, revision, and execution state.

Start entirely from the golden fixture. Switch to the live run API only after the fixture journey is complete and keep fixture mode available for deterministic recording.

## Non-goals

- Rebuilding orchestration or retrieval in the browser.
- Editing shared contracts or API routes.
- Adding dashboards, authentication, settings, collaboration, or general chat.
- Using a graph as decoration without source traceability.

## Owned paths

- `src/app/(product)/**`
- `src/features/**`
- Lane-owned UI tests, styles, and assets.

## Product routes

The product has an intake/scope route and one run workbench route. It has no dashboard, settings area, account surface, or generic chat.

### Intake and scope

- Structured question/application/constraint fields and at most three clarifications.
- Editable claim contract with operational definitions.
- Keyboard-accessible add, edit, remove, and approval actions.
- A clearly labeled option to open the golden fixture.

### Run workbench

Use a focused workbench rather than multiple disconnected pages:

- **Top:** research question, resolved application/scope, run state, and evidence-mode badge.
- **Left:** testable claim tree with strength and disagreement labels.
- **Center:** evidence matrix showing support, contradiction, and unresolved relationships; claims are rows, sources are columns, and every relationship cell is a labeled control.
- **Lower center or drawer:** selected source ledger row with exact excerpt, location, content scope, and verification layers.
- **Right:** selected research gap, experiment protocol, adversarial objections, decisions, revisions, and unresolved risk.
- **Expandable audit rail:** actual workflow nodes with provider/model, prompt version, timing, usage, failure, and evidence mode.

The matrix/list is P0 and is the accessible source of truth. A selectable evidence graph is P1 only after the matrix journey passes. The layout may adapt for smaller screens, but the recording target is a common laptop resolution. Do not shrink everything into unreadable columns; allow a focused panel/drawer for detail.

## Core interactions

### Intake and scope checkpoint

- Enter the research question and available constraints.
- Render proposed claims as editable rows/tree nodes.
- Approve, edit, add, or remove claims.
- Make the blocked/awaiting-approval state clear and keyboard accessible.

### Evidence inspection

- Select a claim to filter its evidence.
- Select a source or relationship to reveal the exact source chunk and location.
- Show content scope: abstract, user excerpt, or full text.
- Show DOI resolution, metadata check, model entailment, and human review as separate labeled fields.
- Show limitation and overclaiming warnings adjacent to the evidence.
- Provide text/icon/shape distinctions in addition to color.
- Return focus to the selected matrix cell when its detail drawer closes.

### Experiment and revision

- Present the experiment in scannable fields, not a prose wall.
- Pair each reviewer objection with severity, target field, decision, original value, revised value, and residual risk.
- Let a human accept, reject, or leave an objection unresolved when the run is awaiting a decision.
- Make clear what the experiment can and cannot establish.
- Show safety/qualified-review requirements and stopping criteria.

### Audit trail

- Highlight the currently running node only when it is actually running.
- Show failed/retried attempts without replacing them with the later success.
- Distinguish fixture, mocked, simulated, live, and unverified nodes.
- Show model and prompt IDs without exposing secrets or dumping private full prompts by default.

## Visual model

The matrix uses deterministic source columns and claim rows. Each cell exposes a relationship label, evidence count, and warning state without implying probability.

If the P1 graph is built, use fixed semantic columns for deterministic screenshots:

- supporting sources;
- subclaims;
- contradictory sources;
- unresolved evidence.

Use equal-weight edges unless a documented rubric exists. Each edge must be selectable, backed by an evidence-card ID, and synchronized with the matrix and evidence drawer.

Suggested visual language:

- support: positive icon/solid edge plus label;
- contradiction: opposing icon/dashed or distinct edge plus label;
- unresolved: neutral icon/dotted edge plus label;
- failed lookup/model node: warning shape plus explicit error text;
- human override: person icon plus decision label.

Use `@xyflow/react` or an equally lightweight renderer. Do not add automatic graph-layout infrastructure unless fixed positioning proves insufficient.

## State honesty

The interface must handle:

- empty intake;
- awaiting scope approval;
- collecting/extracting/running;
- fixture playback;
- partial evidence;
- source not found or metadata mismatch;
- provider timeout/refusal/invalid output;
- retry with preserved failure;
- awaiting reviewer dispositions;
- awaiting final approval;
- approved, rejected, and failed runs.

Never use a generic “verified” badge for model-assessed entailment. Never display generated sample data as a live run.

## Accessibility and responsiveness

- Full core journey works by keyboard.
- Visible focus states and logical focus order.
- Labels and accessible names for graph nodes/relationships and controls.
- Color contrast meets WCAG AA for normal text and meaningful UI.
- Status is not communicated by color alone.
- Evidence detail has a non-canvas/list representation for screen readers.
- Workflow animation respects reduced-motion preferences and announces only genuine state changes.
- The core route remains usable at 200% zoom and 1280x720 without clipping essential controls.
- At the target demo resolution, no required control or source excerpt is clipped.

## Acceptance criteria

Using the golden fixture, a user can:

- inspect and approve the claim scope;
- distinguish support, contradiction, unresolved, mismatch, and failure without relying only on color;
- click every relationship and reach its exact source excerpt, location, content scope, and verification layers;
- identify why each subclaim has its categorical strength;
- inspect the selected research gap and the evidence that motivated it;
- compare original experiment fields, reviewer objections, decisions, revisions, and residual risks;
- inspect actual node execution metadata and preserved failed attempts;
- complete the final approval/rejection decision;
- export or trigger export through the shared API contract.

Verification:

- Component/route tests cover primary state variants.
- Keyboard-only manual check passes.
- Automated accessibility smoke check has no critical violations.
- Browser test covers the complete golden journey.
- Screenshots are captured at the agreed demo resolution in fixture and at least one honest failure state.
- A Windows screen-reader smoke check is recorded when NVDA is available; if not installed, the check remains explicitly blocked.
- Live API hookup does not remove fixture mode.

## Required handoff

List routes/components, fixture used, viewport tested, keyboard/accessibility/browser checks, screenshot paths, evidence mode, live integration state, visual limitations, and any contract field requests. Static screenshots alone are not acceptance.

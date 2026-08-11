# Featherless reviewer-model research

Research date: August 11, 2026.

## Scope and evidence boundary

This note ranks no more than two exact candidates for the adversarial experiment-review node. A candidate must be an instruction/chat model rather than a reasoning-output model, use a developer/base family distinct from the Mistral primary, fit the existing Featherless chat-completions transport, and have a published context window comfortably above the preserved request.

Public documentation can establish catalogue identity, published context, and a plausible JSON transport path. It cannot establish this account's current entitlement, deployment-time output cap, latency, or reliable conformance to the application's nested review schema. Those remain live-gate questions. No completion request or credential was used for this research.

Featherless documents fixed subscription entitlements separately from metered request pricing and credits. A fixed-plan authorization can establish that no incremental paid spend is permitted for this diagnostic, but it does not establish zero per-token rates. [Featherless plans](https://featherless.ai/docs/plans) [Featherless request pricing and credits](https://featherless.ai/docs/request-pricing-and-credits)

## Preserved request and failure boundary

The sanitized r11 artifact records two live reviewer attempts against `deepseek-ai/DeepSeek-V4-Flash`. Both returned the requested provider/model identity and `finishReason: stop`; neither timed out, refused, or fell back. Attempt 1 used 3,758 input and 1,302 output tokens and failed because the response was not valid JSON. The one permitted repair used 5,089 input and 1,302 output tokens and failed the same way.

A local reconstruction from the preserved canonical run and the exact application request builder produced this request shape:

- two chat messages;
- `temperature: 0`, `stream: false`, `max_tokens: 2048`;
- `response_format: {"type":"json_object"}`;
- the prompt-guided, locally validated review JSON Schema appended to the final message;
- 17,348 JSON-serialized characters (17,355 UTF-8 bytes), including 16,120 message-content characters and a 923-character provider schema.

This is a deterministic local reconstruction, not a captured provider payload. The live token counts above are the authoritative provider-reported size evidence. Both candidates' published 32K Featherless context windows exceed the larger 5,089-token repair input plus the 2,048-token output ceiling.

## Ranked candidates

### 1. `Qwen/Qwen2.5-72B-Instruct`

Qwen's first-party card identifies the exact model as instruction-tuned and specifically reports improved instruction following and structured-output generation, especially JSON. It publishes a 131,072-token full context and 8,192-token generation capability, while noting that the default configuration is 32,768 tokens unless YaRN is enabled. [Qwen model card](https://huggingface.co/Qwen/Qwen2.5-72B-Instruct)

Featherless's exact model page currently reports a warm FP8 deployment, 32K context, tool-calling support, and a concurrent-unit cost of four. It also describes structured JSON output. [Featherless model page](https://featherless.ai/models/Qwen/Qwen2.5-72B-Instruct)

Why first: it has the strongest model-specific public JSON evidence and ample hosted context. Its Qwen developer/base family is heterogeneous from the `mistralai` / `mistral-large` primary. The non-reasoning classification is bounded: this is the conventional Qwen2.5 instruction/chat variant, not a thinking- or reasoning-output variant, but its older card does not use the later explicit “non-thinking” terminology.

Uncertainty: the public page does not prove `available_on_current_plan` for this account, the exact hosted maximum completion setting, or successful conformance to the application's review schema under JSON-object mode.

### 2. `meta-llama/Llama-3.3-70B-Instruct`

Meta's first-party card identifies the exact model as an instruction-tuned, text-only generative model optimized for multilingual dialogue, developed by Meta, with a 128K model context. [Meta model card](https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct)

Featherless's exact model page currently reports a warm FP8 deployment, 32K hosted context, tool-calling support, and a concurrent-unit cost of four. [Featherless model page](https://featherless.ai/models/meta-llama/Llama-3.3-70B-Instruct)

Featherless documents `response_format={"type":"json_object"}` plus explicit schema prompting as its workaround for instruction-following models without native function calling, and links a Llama-specific cookbook example. [Featherless tool-calling guide](https://featherless.ai/docs/tool-calling)

Why second: it adds a second genuinely independent reviewer family—Meta/Llama, distinct from both the Mistral primary and the first-ranked Qwen candidate—while retaining ample hosted context and provider-documented Llama JSON-object guidance. It is a conventional dialogue/instruction model rather than a reasoning-output model.

Uncertainty: Meta's card does not make a model-specific JSON-conformance claim. Featherless's JSON-object guidance is provider-wide, not proof that this exact deployment will satisfy the nested local schema. Current account entitlement and the exact hosted output cap are also unverified.

## Transport compatibility and recommendation

Featherless documents `POST /v1/chat/completions` with `model`, `messages`, sampling fields, and `max_tokens`. [Featherless completions reference](https://featherless.ai/docs/completions) Its JSON-object guide says the technique depends on the selected model following instructions and producing JSON, so application-side JSON parsing, Zod validation, invariants, and the single bounded repair remain required; provider mode is not schema proof.

For the bounded operator gate:

1. Authenticate only to query exact account/plan metadata for both IDs and reject any candidate that is unavailable or cannot accept the 2,048-token ceiling within the fixed plan.
2. Probe `Qwen/Qwen2.5-72B-Instruct` first with the exact preserved reviewer prompt/settings/schema.
3. Stop if it returns exact identity, valid JSON, and a locally valid review. Probe `meta-llama/Llama-3.3-70B-Instruct` only if Qwen fails the preflight or bounded completion gate.

Do not freeze either ID from public research alone. The ranking reflects evidence completeness and family diversity, not a claim about comparative quality.

## Bounded live compatibility result

The authenticated fixed-plan diagnostic selected
`Qwen/Qwen2.5-72B-Instruct` after the first-ranked candidate passed both
sequential gates. The account reported `available_on_current_plan=true` and a
32,768-token hosted context. The catalogue did not report a maximum completion
field, so the 2,048-token output bound continues to rely on the first-party
8,192-token generation capability cited above.

The adapter-equivalent small JSON-object probe used two messages,
`temperature: 0`, `stream: false`, `max_tokens: 256`, and
`response_format: {"type":"json_object"}`. It returned the exact requested
model with `finish_reason: stop`, valid JSON, and a valid local schema result
in about 10.68 seconds (77 input and 5 output tokens).

The representative frozen reviewer probe used the unchanged application
review schema and prompt path: two messages, `temperature: 0`,
`stream: false`, `max_tokens: 2048`, and JSON-object mode. Its sanitized
request measurement was 24,560 serialized characters / 24,568 UTF-8 bytes.
It returned the exact Qwen model with `finish_reason: stop`, valid JSON, and
a valid application review schema in about 64.90 seconds (5,270 input and 764
output tokens). No incremental paid spend was authorized or incurred under the
already subscribed fixed plan. Per-token rates and estimated token cost were
not established and are recorded as unavailable.

After independent review, the locally derived pricing fields in the two probe
artifacts were corrected offline from zero to unavailable (`null`). No provider
request was rerun, and the recorded request shape, response identity, usage,
latency, and JSON/schema classifications were not changed.

The diagnostic stopped after Qwen passed; no Llama completion was sent. The
Mistral/Qwen pair remains heterogeneous by exact developer and base family.
Sanitized evidence is under
`artifacts/submission/reviewer-probes/2026-08-11-a`; it contains request
shape and response metadata/classification, not credentials, prompts, raw
responses, or source content.

This is one bounded live transport/schema compatibility result. It is not a
benchmark, reliability rate, quality comparison, quota guarantee, or
authorization to change production configuration.

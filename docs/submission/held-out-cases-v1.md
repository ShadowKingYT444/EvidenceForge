# Held-out benchmark cases v1

Version `1.0.0` freezes six authored evaluation cases across three benign
domains. The cases are inputs for a later preserved benchmark; they are not
provider outputs, live measurements, human grades, or benchmark results.

Set hash:
`1087a4596753bba0352d1faa2d00ae7f694ed53e45cb24ba217f223b73bd8b7e`

## Frozen inventory

| Case | Domain | Case hash | Packet fingerprint | Rights approval hash | Model-input hash |
|---|---|---|---|---|---|
| `cache-rollout-error-rate` | software reliability | `1e2a31df348ac0b9fbd14d5bd47283532a9fc5c7911ef9d27a7469bdf79e2539` | `31c82dcaa2f799051927900fc3b0135feb9f841655e5f998072865f7f9654016` | `a61908df84ecce9609319badf3b8a3d9c589bbe417ba64e3e5b6ba896ae83042` | `544e38ac303a8e8078cea66ee6e4e2a6e94657100faba9f4eb363cd5537c1aa8` |
| `coating-abrasion-durability` | materials engineering | `5b60e2fd9c5105257ba135dbc63e2eb3f5cb24bfa567e07085e14a0d2d84e773` | `249affd11cb0a33ed90c61f5e916afa5aaf0be0b9b5176f0fde0df439460e560` | `35fd4b291bb634749af1b04016a4055ac1a21855289303d765168f949e161b3f` | `2ca8fabe54faf5eb52f888b4b9dd9994eed920de6853c51a7bfef67260b5409c` |
| `office-thermostat-schedule` | environmental sustainability | `8de375a41c326b62161e92cff977797dbfa9c88c126c0e447b6ddf66f028af8f` | `3ab171b37fc6db6a2cd65e31ca22d9b213aea7f6b0f3172033c6e60ac571c712` | `e37128e4f2f436ccf2cb60c9d91e00c3e6007dddf5e700837c95b694f75fedfd` | `61f358b42b21074871162c14535b1876cdc278a44b763699acbb461d9ec317ca` |
| `queue-backpressure-stability` | software reliability | `10fa32d51c01f60064d2907deeb602b61cc6851d40f07267307a36d9b9f5ccc5` | `38efecfa67e71806111a4012470b4411fbf3d50b7273fe5d227ef3dad5b64a56` | `206e8142a3d8e154d5dbe90ae24af1e84c597a21cc0bd756ec225c1a507cfe4f` | `7d0015d42d84467f379bd77f58bb1140e367bfc3b5913c2ad1925c764be3d038` |
| `rain-garden-runoff` | environmental sustainability | `a482bbce234f5202149dda887d9c7b767bf6aafe8f2e5bdad88c545bfdd905f3` | `8436b847dc993ff4c8457504bca838153792436042b8a0c3a47e1a9620c7c05c` | `8ff138e67f0f5381368920bed18b07d0107019479c33922c8daf3709512385b6` | `806c9ae6071da92cf48c5e9489117215a816719aec8551da11a909df69713d0d` |
| `recycled-composite-strength` | materials engineering | `e7a6d31d46b7d3e957c0deec9e6c71f52d1bc648eed71d771a7c8533de8e3fb1` | `a7f12674dbc61e9d4e5cb99e1d2198d66d031697a4b139f219b20ea15091163d` | `346f7268f76f31d20dd7d865a08e8312e93ecdd4432a6535e795e81437765f36` | `1f91f5c26628b0cb8106b53ea06d3268dd46f9f86110891468bb07cbd6671b2b` |

Every case is classified as `fixture`, `heldout_case`, `unmeasured`, and
`headlineEligible=false`. The later benchmark and human-grading work must
preserve this status until measured-run eligibility and grading are complete.

## Rights and safety

Every source and exact chunk is original project-authored fixture content
dedicated under CC0-1.0. Each source records a separate approved decision for
storage, display, and model sending, plus a deterministic rights-decision hash.
There is no external citation, paywalled or restricted text, external authority
claim, medical material, hazardous procedure, private packet, or live-provider
content in this set.

The numeric observations are synthetic reasoning inputs. They must not be
presented as real measurements or as evidence about an external product,
facility, material, or service.

## Coverage and hidden scoring boundary

Collectively, the set satisfies the benchmark contract's required evidence
patterns. The exact scoring taxonomy and case assignments live only in a
separately stored, ignored private pack and are intentionally absent here.

Model-visible projections contain the bounded question, scope, approved source
records, and exact chunks. Private evaluation data is omitted from tracked
source, model input, the exported inventory, runner artifacts, and this
document. A generic server-side loader validates the ignored pack against the
public set and fails closed when it is absent, malformed, changed, or bound to
another set. A public checkout can inspect and smoke-test the cases but cannot
score them. A later measured evaluation must use a separately reviewed private
boundary without changing the frozen case, packet, rights, or model-input
hashes. This is an application boundary, not cryptographic or operating-system
access control.

## Development separation

The two accepted development fixtures are excluded from the held-out registry
and all future headline results. Their identities and bytes remain internal to
the ignored private pack and are intentionally absent from public manifests,
artifacts, and documentation. The public set hash binds only the six held-out
case projections; the private pack separately binds the exclusion and
evaluation identities.

## Deterministic smoke boundary

Fixture-only smoke materialization writes the accepted public case and one
explicit failed/no-output attempt through the immutable evaluation runner. It
performs no model or provider call, produces no quality metric, and refuses to
overwrite an existing deterministic run. Private evaluation data is not written
to model-visible, runner, or documentation artifacts.

Human graders, verified grader expertise, provider trials, measured comparison
results, costs, latencies, and any headline claim remain unavailable and must
be reported as unverified until later gates produce their own evidence.

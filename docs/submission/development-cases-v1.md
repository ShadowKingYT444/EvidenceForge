# Development cases v1

These two cases are deterministic development fixtures for EvidenceForge's
benchmark tooling. They are not held-out cases, live-provider runs, measured
benchmark results, or headline evidence. Both are fixed to:

- benchmark protocol `1.0.0`;
- protocol schema hash
  `caa468800f311a214cc71a360b4720f07e8fa77ada926ba2869e8f705bb08015`;
- condition matrix hash
  `6256e3c2235b9becf9c2a2d197900d91c5b1bdd45f3e12ed9db14b79d7453b89`;
- evidence mode `fixture`;
- reporting use `development`; and
- `headlineEligible=false`.

Every source passage is original project-authored fixture text dedicated under
CC0-1.0. No passage is presented as an external publication, official record,
real measurement, provider result, or citation. The numeric observations are
synthetic test inputs only.

## Case inventory

| Case | Safe domain | Coverage |
|---|---|---|
| `library-lighting-schedule@1.0.0` | environmental sustainability | straightforward support, conflicting energy observations, missing illumination evidence, and occupancy/daylight/co-change limitations |
| `bounded-retry-reliability@1.0.0` | software reliability | straightforward failure-count support, a latency contradiction, insufficient fault coverage, an experiment limitation, and instruction-like source text that must remain untrusted |

Both scopes forbid broad generalization. The lighting case requires abstention
on illumination preservation and causal attribution. The retry case requires
abstention on universal safety, production readiness, and omitted fault
classes. Proposed experiments remain offline or observational and require human
review.

## Frozen identities

| Case | Case hash | Packet fingerprint | Bundle hash |
|---|---|---|---|
| library lighting | `6bf705daa37f5dae86818e4e4d8977d8d25f5d30b8319e7370128fd8e1f63d5b` | `c860e70e96e0047ac49337a39efac457c9e1a1d5d0cdaef25caa304dc4d2c4f6` | `3f17e25de19d2f8b81fb9f340b78e5902505159706cb0b1242f3ed328eebd636` |
| bounded retry | `7b2f9b1e2b7ac24297471d252743dfc042935f020325702e6f675299ebe03cdf` | `eaa7ae4635230b920a085a994ed6c82adb871963909f993175390a39b64012b1` | `1587778311ff0454260b533fbdc12ef11a23d653a9f70e04241e0a2ee9c16a10` |

The lighting packet freezes these sorted source hashes:

- `59fdb7d33af004d60b536a9ed6349f6510351f8e563ccb15aa8bfe8e62c5369c`
- `64dd3c6c45e7603d153b15a5d27fc4ae9f034e8a908b65f016cdf13cd02ee14b`
- `e9560f140f037782c5a336daacfeb838fd1c04e22761123eacf6d1334cae4bd4`

and sorted chunk hashes:

- `39461531b6356c7209ceac341ad1b9769d6bf40735fa6f9de04af64e4526aaa4`
- `3f58ee46da2b953b1a315f0fe630bfc44dd7637e8fc4ba422964d81abbcd863c`
- `d5cce9b9f0978a162d8360fd8ecb079d2874c27feb38acccfe52900cdc03a6c3`

The retry packet freezes these sorted source hashes:

- `43c90d014d5caaeaa3e134dcef4048fe30e32f4413bc0854550ec8a6f40196fb`
- `6ab2ead9a9b28bd3cc2d89793db6c352cc29519b0a1e4dc79af332a54304524e`
- `75f0d769c65f866772b1a11fcd1e6aea658bdd042de6de47364c67395d5db97b`
- `f8b88af0b93926dcdb1ef39e40ca3683b15b76b7be63561494723f30f94c9d22`

and sorted chunk hashes:

- `125a421eb8a6b04c96c28cb39426fe1c8c30a3e67af554e88e7f48422140d566`
- `2fac069f8a860ef04fc6411693ed3377705f7ebf45ee68da0f62be1bc3cff240`
- `5181f5971e4a7ffde660950bfa418ca41251f14809b4cb7041fe903e8b3eaac8`
- `57464bc962e56942ea6fb61cffad2a906aa94740dd060da9e321923d1558dd9e`

## Model-input and scoring boundary

The model-visible projection contains the bounded question, resolved scope,
claims, permission and safety notes, source records, and exact chunks. It
excludes:

- expected relationships and coverage labels;
- known contradiction keys;
- expected abstentions;
- experiment-limit scoring keys; and
- grader instructions.

The instruction-like retry log remains visible as untrusted source content. It
cannot grant authority, alter the workflow, skip validation, or determine its
own score. The private scoring key requires graders to reject those
instructions.

## Deterministic smoke materialization

The accepted artifact runner materializes each frozen case and one explicit
`fixture_failure` attempt. No model or provider executes, raw output is null,
and the reason says that the run is case-materialization smoke only. Generated
metrics contain structural attempt counts, not quality scores. The runner
retains `development`, `smoke_only`, and
`headlineEligible=false`, and refuses a second write to the same run ID
without changing existing bytes.

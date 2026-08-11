# Golden fixture provenance ledger

This ledger describes the deterministic demonstration packet frozen as fixture `0.1`, ID `golden-biodegradable-sensor-72h-v0.1`, at accepted repository commit `59803f1132017e0c3f4ae4ee63317c813bf2fba5`.

## Frozen identities

| Record | Exact value |
| --- | --- |
| Canonical fixture SHA-256 | `f9e0d79353a38e20925d7d21246f817d6764a5befd89051627982c993ac3b0b7` |
| Packet fingerprint | `944a84680c5ac72267e90537fb20aaee8ef80a0180b1d10ab30eb2acc6be167e` |
| Rights-approval SHA-256 | `9a0ffe668eb7562ee576d443a7c00c5d73cdf0727b09a661de460cbeb9efb8f5` |
| Rights approved | `2026-08-06T14:31:38.000Z` |
| Packet frozen | `2026-08-06T21:43:00.000Z` |
| Fixture completed | `2026-08-06T21:44:30.000Z` |

The canonical fixture hash binds the full accepted deterministic run. The packet fingerprint binds ordered source/chunk identities and hashes. Neither proves that an external source is authentic, current, complete, or legally reusable. The rights hash binds a human-recorded decision for these exact excerpts and this packet only.

## Source and excerpt ledger

Every row represents one source and one immutable chunk. The excerpt SHA-256 is used as both source content hash and chunk content hash in this bounded packet.

| ID | Canonical source and packet scope | Exact approved excerpt | SHA-256 | Fixture interpretation and boundary |
| --- | --- | --- | --- | --- |
| `gf-source-01` / `gf-chunk-01` | Poulin, Aeby, and Nyström (2022), *Water activated disposable paper battery*, Scientific Reports, [DOI 10.1038/s41598-022-15900-5](https://doi.org/10.1038/s41598-022-15900-5), publisher full text | “After 1 h of discharge (and the additional power capability measurements), performance significantly decreases due to drying of the paper substrate.” | `9c2819492aebf688f659453d7aecbe2c797ffc410d4caae1f3ec15cf193c7050` | Contradicts the loaded-duration claim. The supplied title intentionally mismatches canonical metadata; that mismatch is not entailment. |
| `gf-source-02` / `gf-chunk-02` | Janićijević et al. (2024), *Design and Development of Transient Sensing Devices for Healthcare Applications*, Advanced Science, [DOI 10.1002/advs.202307232](https://doi.org/10.1002/advs.202307232), archived full text | “Under ambient conditions, mechanically and electrically unloaded batteries could sustain a voltage above 1.5 V for 77 h.” | `26637262fbf4de761f483a56d4905b3db0cfb574e63e4f9bebff64c75a9ce8be` | Insufficient for a loaded 72-hour target because the cited battery was unloaded. Publisher retrieval returned HTTP 403; DOI existence and archival text are separate facts. |
| `gf-source-03` / `gf-chunk-03` | Tsang et al. (2015), *Biodegradable magnesium/iron batteries with polycaprolactone encapsulation*, Microsystems & Nanoengineering, [DOI 10.1038/micronano.2015.24](https://doi.org/10.1038/micronano.2015.24), publisher full text | “PCL-coated Mg/Fe batteries discharged in PBS achieved an average discharge power and lifetime of approximately 30 µW and 100 h, respectively.” | `dc7ee32cfbcb25a1b9383eba4f9bf6954ae58ddbf447c5caea44f0bc01033d42` | Partial duration support in a different electrolyte/application; it does not establish environmental-sensor fit. |
| `gf-source-04` / `gf-chunk-04` | Falco et al. (2022), *Paper and Salt: Biodegradable NaCl-Based Humidity Sensors for Sustainable Electronics*, Frontiers in Electronics, [DOI 10.3389/felec.2022.838472](https://doi.org/10.3389/felec.2022.838472), abstract | “Our sensors and the fabrication techniques employed, such as dip and spray coating, provide a biodegradable, low cost, and highly reproducible device.” | `b832e77f36e948d20835ffcfb9325d30d0cdab4d51047c665e2e0e931af3ae07` | Partial integration-feasibility support only; it does not prove battery integration or loaded runtime. “Low cost” is a source excerpt, not a measured project cost claim. |
| `gf-source-05` / `gf-chunk-05` | Amodio and Lightman (2025), *A Review of Button Battery Ingestions in Children—Diagnosis and Management*, Children, [DOI 10.3390/children12121678](https://doi.org/10.3390/children12121678), archived full text | “Spent, used, or ‘dead’ batteries can still cause significant tissue damage if swallowed and should be properly discarded.” | `caa79bef324cac532c50dababd87e6571b9fe6d1898773aac0eab59cd362f6f8` | Full support for a bounded ingestion-hazard statement only; not comparative lifecycle evidence or universal packaged-sensor exposure. |
| `gf-source-06` / `gf-chunk-06` | Gopalakrishnan (2023), doctoral dissertation, Purdue University Graduate School, [DOI 10.25394/pgs.23496710.v1](https://doi.org/10.25394/pgs.23496710.v1), DataCite abstract | “In this pursuit, the first study explores combining the SLAM process with 3D printing to develop a miniaturized, biodegradable, chipless sensor for soil moisture monitoring.” | `4e97cdbca2eb8851e6dea80008515f6fd3b74215af36b992c70f090a82c6838e` | Partial integration-feasibility support only. DOI agency and deposited license metadata were checked live at `2026-08-06T21:42:38.499Z`; the fixture rights decision remains fixture evidence, not legal clearance. |
| `gf-source-07` / `gf-chunk-07` | Shin et al. (2022), *Micro-/Nano-Structured Biodegradable Pressure Sensors for Biomedical Applications*, Biosensors, [DOI 10.3390/bios12110952](https://doi.org/10.3390/bios12110952), archived full text | “These materials are required to satisfy designated dissolution rates, electrical/mechanical properties, and other demands depending on the desired application of the device.” | `60dfe7d5fad5d2a834f56fd6b67005964242ba345de956ba1b2278ab26328ca9` | Insufficient integration evidence; application-specific degradation, electrical, and mechanical requirements remain unmeasured. |

## Rights and access boundary

For these seven exact chunks, the frozen fixture records `mayStore`, `mayDisplay`, and `maySendToModel` as `allowed`. The recorded basis is CC BY 4.0, attribution required, exact human-approved excerpt reproduced without textual changes, and provenance retained. Source 6 additionally attributes Sarath Gopalakrishnan and records the official DataCite/repository license metadata.

This is a bounded human decision in a deterministic fixture. It is not legal advice, universal reuse permission, or proof that an upstream page remains available. It does not authorize neighboring text, a full work beyond the recorded scope, a different packet, or private/paywalled/restricted content. Any changed excerpt or source requires a new rights review, new content hashes, and a new packet freeze. A denied or missing store/display/model-use right must fail closed before the affected operation.

## Verification, assessment, and human review

The fixture keeps three layers separate:

1. **Application verification:** DOI syntax/resolution state, registration agency, metadata differences, source/chunk linkage, rights, literal substring equality, and content hashes.
2. **Model-assisted assessment:** categorical entailment relationship/strength, rationale, and overclaiming flags. No confidence percentages are used.
3. **Human review:** confirmation or correction of evidence assessments, scope and packet approvals, objection dispositions, and final approval/rejection.

The deliberate supplied-title mismatch for source 1 demonstrates why metadata verification cannot stand in for entailment. A separate supplied DOI, `10.1002/open.209900999`, is recorded as nonexistent; no source, passage, or entailment record is fabricated for it.

## Fixture result provenance

The approved question concerns a biodegradable power source for a single-use humidity sensor with a 72-hour target. The frozen packet supports three bounded conclusions:

- **Loaded duration is conflicting:** the packet includes a one-hour drying limitation, a 77-hour unloaded observation, and a 100-hour PBS observation, but no target loaded case.
- **Sensor integration is insufficient:** biodegradable sensor examples do not establish the proposed battery/sensor combination under the intended conditions.
- **Spent coin-cell ingestion is a bounded hazard:** the clinical excerpt supports harm after ingestion, not a comparative lifecycle or exposure-frequency claim.

The selected gap is loaded duration. The fixture proposes a randomized blocked bench comparison as an educational pilot. The reviewer raises independent load verification and degradation-safety objections. Human review accepts the calibration-related objection and leaves degradation safety unresolved; revision applies only the accepted item. Final fixture approval is limited to the educational pilot and does not authorize real-world deployment or hazardous procedures.

## Execution and historical identity boundary

The fixture preserves its own historical prompt versions, fixture provider/model identities, generation settings, and retry records. It includes an invalid first planning response before a successful fixture repair and a reviewer provider failure before a successful fixture retry. Those records are append-only and labeled `fixture`.

Current executable live configuration instead uses Mistral primary, Qwen reviewer, compact `2.0.0` prompts where listed in the [node reference](workflow-node-reference.md), 2,048 output tokens, and per-attempt 120-second deadlines. Updating current configuration must not relabel or reinterpret the historical fixture.

The integrated workflow image is derived from `docs/architecture/workflow.mmd` with `@mermaid-js/mermaid-cli@11.16.0` using `node scripts/export-workflow.mjs`. Its source SHA-256 is `9d8ec3ddb64eeb59f7d20902e732f7bd34d5107313ee4f42265f505a9a9875cf`; the [PNG](../../artifacts/submission/workflow-v1.png) SHA-256 is `3440e08d00f403a323e2fd26a8e37e8cab8755d04cecbc2a54a3d37c236a3a5c`.

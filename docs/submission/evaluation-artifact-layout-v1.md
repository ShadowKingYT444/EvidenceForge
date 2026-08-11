# Evaluation artifact layout v1

Runner version: `1.0.0`

This document describes a fixture-first artifact writer. It contains no
benchmark score, measured comparison, provider result, or headline claim. The
writer accepts already-recorded attempts; it does not call a model or scholarly
provider.

## Frozen protocol boundary

Every accepted runner configuration is bound to:

- benchmark protocol `1.0.0`;
- protocol schema hash
  `caa468800f311a214cc71a360b4720f07e8fa77ada926ba2869e8f705bb08015`;
- condition matrix hash
  `6256e3c2235b9becf9c2a2d197900d91c5b1bdd45f3e12ed9db14b79d7453b89`;
- prompt manifest hash
  `4c1b43c47903cd899e02a2586c1c136d373a2ec90b5f4ddd16efa9ceb355901e`;
- the benchmark case and condition configuration hashes; and
- one frozen trial identifier and seed.

The current writer accepts only `fixture`, `mocked`, or `simulated` evidence,
with reporting use fixed to `development`, result class fixed to `smoke_only`,
and headline eligibility fixed to `false`. It has no live or headline-result
writer. Before creating the artifact root, it also requires every valid parsed
canonical run and each execution in that run to use the same non-live evidence
mode as the outer attempt and runner configuration. A `live` canonical run,
`live` execution, or other envelope mismatch is rejected before any artifact
root, run directory, or file is created. This runner-level rule does not change
the shared research-run schema.

## Layout

```text
<artifact-root>/
  cases/
    <case-id>/
      <case-version>/
        case.json
  runs/
    1.0.0/
      <run-id>/
        raw/
          attempt-<sequence>-<attempt-id>.json
        parsed/
          attempt-<sequence>-<attempt-id>.json
        metrics/
          smoke.json
          smoke.csv
        annotations/
          placeholder.json
        manifest.json
```

The raw envelope preserves the exact recorded provider payload, request
identity, model request, generation settings, timing, evidence mode, and any
failure. The corresponding parsed envelope contains either a validated
canonical research run or explicit parse issues. Raw payloads are never copied
into parsed artifacts, and canonical runs are never copied into raw artifacts.

Smoke metrics are structural counts only: attempts, successes, failures, parse
states, and recorded latency. Human annotation files begin as empty,
unrandomized placeholders. Neither artifact can accept an undeclared result
field.

## Required workspace threat model

The artifact root must be a trusted, local, single-writer workspace. **It is
not a security boundary. Do not place it in an untrusted directory or a
directory writable by other users or processes.**

The runner validates lexical descendants and rejects pre-existing symbolic
links, Windows directory junctions, and other redirects exposed by Node's
`lstat` as symbolic links. After those direct checks, it also fails closed when
canonical resolution reveals a checked path change. That canonical mismatch is
an observation after resolution, not proof that every Windows reparse category
can be identified without following it. These checks protect ordinary local
operation and cooperative runner concurrency.

They do not protect against a hostile process with the same filesystem
permissions. Same-account hard-linking of a named temporary file, concurrent
ancestor replacement, and copying artifacts after publication are explicitly
out of scope. In particular, a same-permission process can create another hard
link to a temporary inode before the runner writes it; that alias receives the
later bytes. This is a known excluded threat, not a passing containment or
outside-empty check. Use a private, single-writer artifact root.

## Immutability and completion

Files are written to a temporary sibling, synchronized, and published through
an atomic no-replace hard link. This prevents cooperative writers from
overwriting an existing artifact; it does not create an operating-system
sandbox. Frozen case content may be reused only when its bytes are identical.
A different case at the same ID and version is rejected. A run directory is
claimed once; reusing a run ID is rejected.

Before creating a missing artifact root, the writer walks lexical components
from the filesystem root. It probes only the direct next component, rejects a
Node-exposed symbolic-link or junction redirect before resolving or probing
beneath it, and stops probing at the first missing component. Missing
components are then created non-recursively, one at a time, beneath the last
validated canonical directory. A canonical mismatch observed after direct
redirect checks is reported as an observed path change. Recursive creation is
not used to cross an unchecked ancestor.

The writer continues to validate that artifact paths are canonical descendants
and checks paths around directory creation, temporary-file creation, and
hard-link publication. Path validation failures use a structured
`ArtifactPathValidationError` with the requested root, operation, offending
path, reason, and resolved path when available. Under the required trusted
single-writer model, pre-existing redirects fail before publication and cannot
produce a success manifest through the redirected location.

`manifest.json` is written last. Its presence and strict validation are the
completion marker. It indexes every other run artifact by normalized relative
path and byte hash.

A rerun receives a new run ID and names a complete parent run. The writer
verifies that the parent uses the same benchmark configuration and trial, then
creates a separate directory. It does not edit the parent.

If materialization fails, any partial directory remains incomplete and
addressable rather than being rewritten into apparent success. A later run must
use a new ID.

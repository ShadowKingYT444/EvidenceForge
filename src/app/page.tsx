import { readRuntimeEnvironment } from "@/server/environment";

export default function Home() {
  const runtime = readRuntimeEnvironment();

  return (
    <main>
      <section aria-labelledby="product-title" className="shell">
        <p className="eyebrow">Auditable claim-to-experiment workflow</p>
        <h1 id="product-title">EvidenceForge</h1>
        <p className="summary">
          Review a bounded source packet, keep evidence states distinct, and
          pause for human decisions before proposing an experiment.
        </p>

        <dl className="runtime">
          <div>
            <dt>Runtime evidence</dt>
            <dd data-evidence-mode={runtime.evidenceMode}>
              {runtime.evidenceMode === "fixture"
                ? "Fixture mode"
                : "Live mode"}
            </dd>
          </div>
          <div>
            <dt>Credential requirement</dt>
            <dd>
              {runtime.evidenceMode === "fixture"
                ? "No live provider credentials required"
                : "Server-only provider credentials validated"}
            </dd>
          </div>
        </dl>

        <p className="notice">
          Fixture mode is deterministic and does not represent live provider
          evidence.
        </p>
      </section>
    </main>
  );
}

import type { ExperimentProtocolModel } from "./experiment-protocol-state";
import styles from "./experiment-protocol-inspector.module.css";

type ReviewStats = {
  objectionCount: number;
  revisionCount: number;
  unresolvedObjectionCount: number;
};

type ExperimentProtocolInspectorProps = {
  model: ExperimentProtocolModel;
  reviewStats: ReviewStats;
};

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function TextList({ items, empty }: { items: string[]; empty: string }) {
  return items.length > 0 ? (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  ) : (
    <span className={styles.empty}>{empty}</span>
  );
}

export function ExperimentProtocolInspector({
  model,
  reviewStats,
}: ExperimentProtocolInspectorProps) {
  return (
    <section
      className={styles.surface}
      id="experiment"
      aria-label="Experiment protocol inspector"
      data-state={model.state}
    >
      <header className={styles.header}>
        <div>
          <span className={styles.index}>05 · Experiment</span>
          <h2>
            {model.state === "proposal"
              ? "Experiment protocol"
              : model.heading}
          </h2>
        </div>
        <span className={styles.mode} data-mode={model.evidenceMode}>
          {model.evidenceMode}
        </span>
      </header>

      {model.state === "proposal" ? (
        <Proposal model={model} reviewStats={reviewStats} />
      ) : model.state === "abstention" ? (
        <Abstention model={model} />
      ) : (
        <div
          className={model.state === "error" ? styles.error : styles.pending}
          role={model.state === "error" ? "alert" : "status"}
        >
          <strong>{model.heading}</strong>
          <p>{model.message}</p>
        </div>
      )}
    </section>
  );
}

function Proposal({
  model,
  reviewStats,
}: {
  model: Extract<ExperimentProtocolModel, { state: "proposal" }>;
  reviewStats: ReviewStats;
}) {
  return (
    <div className={styles.body}>
      <div className={styles.objective}>
        <span>Bounded objective</span>
        <strong>{model.objective}</strong>
        <div className={styles.protocolMeta}>
          <span>{model.designType}</span>
          <code>{model.selectedGapId}</code>
        </div>
      </div>

      <section className={styles.section} aria-labelledby="hypothesis-title">
        <h3 id="hypothesis-title">Hypothesis & null</h3>
        <dl className={styles.definitionGrid}>
          <div>
            <dt>Hypothesis</dt>
            <dd>{model.hypothesis.alternative}</dd>
          </div>
          <div>
            <dt>Null hypothesis</dt>
            <dd>{model.hypothesis.null}</dd>
          </div>
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="variables-title">
        <h3 id="variables-title">Variables & controls</h3>
        <dl className={styles.compactGrid}>
          <Field label="Experimental unit" value={model.variables.experimentalOrObservationalUnit} />
          <Field label="Unit of analysis" value={model.variables.unitOfAnalysis} />
          <Field label="Intervention / exposure" value={model.variables.interventionOrExposure} />
          <Field label="Comparator" value={model.variables.comparator} />
          <ListField label="Independent variables" items={model.variables.independent} />
          <ListField label="Dependent variables" items={model.variables.dependent} />
          <ListField label="Primary outcomes" items={model.variables.primaryOutcomes} />
          <ListField label="Secondary outcomes" items={model.variables.secondaryOutcomes} />
          <ListField label="Controls" items={model.variables.controls} />
          <ListField label="Comparison groups" items={model.variables.comparisonGroups} />
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="validity-title">
        <h3 id="validity-title">Validity & allocation</h3>
        <dl className={styles.compactGrid}>
          <Field label="Measurement validity" value={model.validity.measurement} />
          <Field label="Randomization" value={model.validity.allocation.randomization} />
          <Field label="Blocking" value={model.validity.allocation.blocking} />
          <Field label="Blinding" value={model.validity.allocation.blinding} />
          <Field label="Allocation rationale" value={model.validity.allocation.rationale} />
          <Field label="Replication" value={model.validity.replication} />
          <Field label="Repeated measures" value={model.validity.repeatedMeasurement} />
          <ListField label="Inclusion criteria" items={model.validity.inclusionCriteria} />
          <ListField label="Exclusion criteria" items={model.validity.exclusionCriteria} />
          <Field label="Attrition" value={model.validity.attrition} />
          <Field label="Missing data" value={model.validity.missingData} />
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="power-title">
        <h3 id="power-title">Power & sample size</h3>
        {model.power.warning ? (
          <div className={styles.warning} role="alert">
            <strong>Missing power assumptions</strong>
            <span>{model.power.warning}</span>
          </div>
        ) : null}
        <p className={styles.fieldCopy}>{model.power.basis}</p>
        <div className={styles.subfield}>
          <strong>Missing inputs</strong>
          <TextList
            items={model.power.missingAssumptions}
            empty="No missing power assumption is recorded."
          />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="analysis-title">
        <h3 id="analysis-title">Metrics & analysis</h3>
        <dl className={styles.compactGrid}>
          <Field label="Estimand" value={model.analysis.estimand} />
          <ListField label="Metrics" items={model.analysis.metrics} />
          <Field label="Analysis plan" value={model.analysis.plan} />
          <ListField label="Assumption checks" items={model.analysis.assumptionChecks} />
        </dl>
      </section>

      <section className={styles.section} aria-labelledby="bias-title">
        <h3 id="bias-title">Confounders & mitigation</h3>
        <div className={styles.splitList}>
          <div>
            <strong>Confounders</strong>
            <TextList items={model.bias.confounders} empty="None recorded." />
          </div>
          <div>
            <strong>Mitigations</strong>
            <TextList items={model.bias.mitigations} empty="None recorded." />
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="feasibility-title">
        <h3 id="feasibility-title">Feasibility</h3>
        <p className={styles.fieldCopy}>{model.feasibility.assessment}</p>
        <div className={styles.splitList}>
          <div>
            <strong>Required resources</strong>
            <TextList items={model.feasibility.requiredResources} empty="None recorded." />
          </div>
          <div>
            <strong>Constraints</strong>
            <TextList items={model.feasibility.constraints} empty="None recorded." />
          </div>
        </div>
      </section>

      <section className={styles.safety} aria-labelledby="safety-title">
        <div className={styles.safetyHeader}>
          <h3 id="safety-title">Safety & qualified review</h3>
          {model.safety.qualifiedReviewRequired ? (
            <span>Qualified human review required</span>
          ) : null}
        </div>
        <p className={styles.nonExecution}>
          Review record only · not executable instructions or authorization for real-world use.
        </p>
        <div className={styles.splitList}>
          <div>
            <strong>Hazards</strong>
            <TextList items={model.safety.hazards} empty="No hazards recorded." />
          </div>
          <div>
            <strong>Ethics</strong>
            <TextList items={model.safety.ethics} empty="No ethics notes recorded." />
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="criteria-title">
        <h3 id="criteria-title">Stopping & failure criteria</h3>
        <div className={styles.splitList}>
          <div>
            <strong>Stop when</strong>
            <TextList items={model.criteria.stopping} empty="None recorded." />
          </div>
          <div>
            <strong>Count as failure</strong>
            <TextList items={model.criteria.failure} empty="None recorded." />
          </div>
        </div>
      </section>

      <section className={styles.inference} aria-labelledby="inference-title">
        <h3 id="inference-title">Inferential limits</h3>
        <ol className={styles.outcomes}>
          {model.inference.branches.map((branch) => (
            <li key={branch.outcome}>
              <strong>{branch.outcome}</strong>
              <dl>
                <div>
                  <dt>What this outcome establishes</dt>
                  <dd>{branch.establishes}</dd>
                </div>
                <div>
                  <dt>What this outcome does not establish</dt>
                  <dd>{branch.doesNotEstablish}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
        <div className={styles.boundary}>
          <strong>External-validity boundary</strong>
          <p>{model.inference.externalValidityBoundary}</p>
        </div>
      </section>

      <section className={styles.review} aria-label="Protocol review record">
        <h3>Review record</h3>
        <dl>
          <div><dt>Objections</dt><dd>{reviewStats.objectionCount}</dd></div>
          <div><dt>Revisions</dt><dd>{reviewStats.revisionCount}</dd></div>
          <div><dt>Unresolved</dt><dd>{reviewStats.unresolvedObjectionCount}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function Abstention({
  model,
}: {
  model: Extract<ExperimentProtocolModel, { state: "abstention" }>;
}) {
  return (
    <div className={styles.abstention} role="status">
      <p className={styles.abstentionReason}>{model.reason}</p>
      <div className={styles.categories}>
        {model.safetyCategories.map((category) => (
          <span key={category}>{humanize(category)}</span>
        ))}
      </div>
      <section>
        <h3>Missing inputs</h3>
        <TextList items={model.missingInputs} empty="No missing input recorded." />
      </section>
      <section>
        <h3>Allowed next step</h3>
        <p>{model.allowedNextStep}</p>
      </section>
      {model.qualifiedReviewRequired ? (
        <p className={styles.qualified}>Qualified human review required.</p>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function ListField({ label, items }: { label: string; items: string[] }) {
  return <div><dt>{label}</dt><dd><TextList items={items} empty="None recorded." /></dd></div>;
}

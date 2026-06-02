import { describe, it, expect } from 'vitest';
import { createConceptExtractNode } from '../../src/agent/nodes/02-concept-extract.js';
import { makeFakeLlm } from '../../src/llm/structured-llm.js';
import { ecommerceSchema, makeGoldenLlm } from '../fixtures.js';
import type { OntologyState } from '../../src/agent/state.js';
import type { ValidationError } from '../../src/types/ontology.js';

describe('createConceptExtractNode', () => {
  it('emits one Class + one DatatypeProperty per column for every table', async () => {
    const node = createConceptExtractNode(makeGoldenLlm());
    const update = await node({ canonicalSchema: ecommerceSchema, validationErrors: null, retryCount: 0 } as OntologyState);
    const candidates = update.conceptCandidates ?? [];

    const classes = candidates.filter((c) => c.ontologyKind === 'Class');
    const props = candidates.filter((c) => c.ontologyKind === 'DatatypeProperty');
    const totalColumns = ecommerceSchema.tables.reduce((n, t) => n + t.columns.length, 0);

    expect(classes).toHaveLength(4);
    expect(props).toHaveLength(totalColumns);
    const customer = classes.find((c) => c.source.table === 'customers');
    expect(customer?.prefLabel).toBe('Customer');
    expect(customer?.altLabel).toContain('client');
  });

  it('synthesizes a property for a column the model omitted', async () => {
    // Fake returns a class with NO properties; the node must backfill all columns.
    const llm = makeFakeLlm([
      {
        when: () => true,
        respond: () => ({ classPrefLabel: 'X', classAltLabels: [], classComment: 'x', properties: [] }),
      },
    ]);
    const node = createConceptExtractNode(llm);
    const single = { ...ecommerceSchema, tables: [ecommerceSchema.tables[0]!] };
    const update = await node({ canonicalSchema: single, validationErrors: null, retryCount: 0 } as OntologyState);
    const props = (update.conceptCandidates ?? []).filter((c) => c.ontologyKind === 'DatatypeProperty');
    expect(props).toHaveLength(single.tables[0]!.columns.length);
    // synthesized label is humanized from the column name
    expect(props.find((p) => p.source.column === 'created_at')?.prefLabel).toBe('Created At');
  });

  it('counts a retry when re-entered with prior validation errors', async () => {
    const node = createConceptExtractNode(makeGoldenLlm());
    const priorErrors: ValidationError[] = [{ rule: 'orphan-class', subject: 'qsl:class/x', message: 'orphan' }];
    const update = await node({ canonicalSchema: ecommerceSchema, validationErrors: priorErrors, retryCount: 0 } as OntologyState);
    expect(update.retryCount).toBe(1);
  });

  it('does not count a retry on the first pass (no prior errors)', async () => {
    const node = createConceptExtractNode(makeGoldenLlm());
    const update = await node({ canonicalSchema: ecommerceSchema, validationErrors: null, retryCount: 0 } as OntologyState);
    expect(update.retryCount).toBeUndefined();
  });
});

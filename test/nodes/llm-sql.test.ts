import { describe, it, expect } from 'vitest';
import { isIntentWeak, generateSqlWithLlm, LlmSqlSchema } from '../../src/query/llm-sql.js';
import { linkQuestion } from '../../src/query/schema-linker.js';
import { makeFakeLlm } from '../../src/llm/structured-llm.js';
import { f1Index, ecommerceIndex } from '../fixtures/golden-questions.js';

describe('isIntentWeak', () => {
  it('is true when a content token is left unresolved', () => {
    expect(isIntentWeak(linkQuestion('total points and gibberishtoken', f1Index))).toBe(true);
  });
  it('is false for a clean aggregate that linked fully', () => {
    expect(isIntentWeak(linkQuestion('order count by currency', ecommerceIndex))).toBe(false);
  });
});

describe('generateSqlWithLlm', () => {
  it('feeds the model the focused grounding and returns validated SQL + token stats', async () => {
    let seenUser = '';
    const llm = makeFakeLlm([
      {
        when: (user) => {
          seenUser = user;
          return user.includes('Tables:') && user.includes('drivers');
        },
        respond: () => ({ sql: 'SELECT driverref FROM drivers;', tables: ['drivers'], rationale: 'list driver refs' }),
      },
    ]);
    const out = await generateSqlWithLlm('list driver references', f1Index, llm);
    expect(() => LlmSqlSchema.parse({ sql: out.sql, tables: out.tables, rationale: out.rationale })).not.toThrow();
    expect(out.tables).toContain('drivers');
    // Focused, not a full dump — and the pre-resolved joins actually reached the model.
    expect(out.stats.sliceTokens).toBeLessThanOrEqual(out.stats.fullTokens);
    expect(seenUser).toContain('Foreign keys');
  });
});

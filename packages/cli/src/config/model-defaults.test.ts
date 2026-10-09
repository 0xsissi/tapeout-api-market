import { describe, expect, it } from 'vitest';
import { defaultSellerModels, reconcileSellerModels } from './schema.js';

describe('seller model defaults', () => {
  it('prefers Sol without selecting every upstream catalog entry', () => {
    expect(defaultSellerModels('codex')).toEqual(['gpt-6.1-sol']);
    expect(reconcileSellerModels('codex', [], ['gpt-5.4', 'gpt-6-luna', 'gpt-6.1-sol'])).toEqual(['gpt-6.1-sol']);
  });
  it('keeps explicit supported selections, including older models', () => {
    expect(reconcileSellerModels('codex', ['gpt-5.4'], ['gpt-6.1-sol', 'gpt-5.4'])).toEqual(['gpt-5.4']);
    expect(reconcileSellerModels('codex', ['gpt-6-luna'], ['gpt-6.1-sol', 'gpt-6-luna'])).toEqual(['gpt-6-luna']);
  });
  it('uses only models advertised by the account when the selected model is unavailable', () => {
    expect(reconcileSellerModels('codex', ['gpt-5.4'], ['gpt-6-luna'])).toEqual(['gpt-6-luna']);
    expect(defaultSellerModels('codex', ['private-model'])).toEqual(['private-model']);
  });
  it('preserves the selection when discovery returns no catalog', () => {
    expect(reconcileSellerModels('codex', ['custom-model'], [])).toEqual(['custom-model']);
    expect(reconcileSellerModels('codex', [], [])).toEqual(['gpt-6.1-sol']);
  });
});

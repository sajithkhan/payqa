// Runs Chaos Mode scenarios one by one and reports progress through onUpdate()

import { createStoreClient } from '../lib/storeClient.mjs';
import { SCENARIOS } from './scenarios.mjs';

const WEIGHTS = { critical: 5, high: 3, medium: 2, low: 1 };

export function scoreChecks(checks) {
  const total = checks.reduce((s, c) => s + WEIGHTS[c.severity], 0);
  const passed = checks.filter((c) => c.passed).reduce((s, c) => s + WEIGHTS[c.severity], 0);
  return total ? Math.round((passed / total) * 100) : 0;
}

export function summarize(results) {
  const allChecks = results.flatMap((r) => r.checks || []);
  return {
    scenarios: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    checksPassed: allChecks.filter((c) => c.passed).length,
    checksTotal: allChecks.length,
    bugsFound: [...new Set(allChecks.filter((c) => !c.passed).map((c) => c.bug))],
    score: scoreChecks(allChecks),
  };
}

// Ask the store's adapter what it supports and which products to use
export async function loadStoreContext(store) {
  const health = await store.health();
  if (!health.ok) {
    throw new Error(
      health.status === 401
        ? 'The store rejected PayQA\'s token. Check the store token.'
        : `The store's PayQA adapter didn't respond (HTTP ${health.status}). Is it mounted at /payqa and enabled?`
    );
  }
  const products = await store.products();
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error('The store\'s PayQA adapter returned no products to test with.');
  }
  return { capabilities: health.body.capabilities || {}, products };
}

export async function runChaos({ storeUrl, storeToken, onUpdate = () => {} }) {
  const store = createStoreClient(storeUrl, { token: storeToken });
  const { capabilities, products } = await loadStoreContext(store);
  const ctx = { store, capabilities, products };

  const results = SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    category: s.category,
    description: s.description,
    mockCode: s.mockCode || null,
    status: 'pending',
    checks: [],
  }));
  onUpdate(results);

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    const result = results[i];
    result.status = 'running';
    onUpdate(results);

    const started = Date.now();
    try {
      const out = await scenario.run(ctx);
      if (out.skipped) {
        result.status = 'skipped';
        result.skipReason = out.skipped;
      } else {
        result.checks = out.checks;
        result.evidence = out.evidence;
        result.status = out.checks.every((c) => c.passed) ? 'passed' : 'failed';
      }
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
    }
    result.durationMs = Date.now() - started;
    onUpdate(results);
  }

  await store.reset().catch(() => {});
  return { results, summary: summarize(results) };
}

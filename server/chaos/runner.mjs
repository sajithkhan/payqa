// Runs Chaos Mode scenarios one by one and reports progress through onUpdate()

import { createStoreClient } from '../lib/storeClient.mjs';
import { SCENARIOS } from './scenarios.mjs';

const WEIGHTS = { critical: 5, high: 3, medium: 2, low: 1 };

export function scoreChecks(checks) {
  const total = checks.reduce((s, c) => s + WEIGHTS[c.severity], 0);
  const passed = checks.filter((c) => c.passed).reduce((s, c) => s + WEIGHTS[c.severity], 0);
  return total ? Math.round((passed / total) * 100) : 0;
}

export async function runChaos({ storeUrl, onUpdate = () => {} }) {
  const store = createStoreClient(storeUrl);

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
      const { checks, evidence } = await scenario.run(store);
      result.checks = checks;
      result.evidence = evidence;
      result.status = checks.every((c) => c.passed) ? 'passed' : 'failed';
    } catch (err) {
      result.status = 'error';
      result.error = err.message;
    }
    result.durationMs = Date.now() - started;
    onUpdate(results);
  }

  await store.reset().catch(() => {});

  const allChecks = results.flatMap((r) => r.checks);
  const bugsFound = [...new Set(allChecks.filter((c) => !c.passed).map((c) => c.bug))];

  return {
    results,
    summary: {
      scenarios: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      errors: results.filter((r) => r.status === 'error').length,
      checksPassed: allChecks.filter((c) => c.passed).length,
      checksTotal: allChecks.length,
      bugsFound,
      score: scoreChecks(allChecks),
    },
  };
}

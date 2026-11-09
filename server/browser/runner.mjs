// Runs Browser Mode scenarios in a real Chromium browser with Playwright.
// Each scenario gets a fresh browser context (clean cookies, so PayPal always asks to log in).

import fs from 'node:fs';
import { chromium } from 'playwright';
import { createStoreClient } from '../lib/storeClient.mjs';
import { scoreChecks } from '../chaos/runner.mjs';
import { SCENARIOS } from './scenarios.mjs';

export async function runBrowser({
  storeUrl,
  runId,
  screenshotDir,
  headless = true,
  onUpdate = () => {},
  onContext = null, // optional hook to customise each browser context (used by tests)
}) {
  const store = createStoreClient(storeUrl);
  const buyer = {
    email: process.env.SANDBOX_BUYER_EMAIL,
    password: process.env.SANDBOX_BUYER_PASSWORD,
  };
  if (!buyer.email || !buyer.password) {
    throw new Error('SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD must be set in .env');
  }
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  const results = SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    category: s.category,
    description: s.description,
    status: 'pending',
    checks: [],
  }));
  onUpdate(results);

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 150,
    // optional: use a specific Chrome/Chromium install (handy on servers)
    executablePath: process.env.PAYQA_CHROMIUM_PATH || undefined,
  });

  try {
    for (let i = 0; i < SCENARIOS.length; i++) {
      const result = results[i];
      result.status = 'running';
      onUpdate(results);

      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      if (onContext) await onContext(context);
      const page = await context.newPage();
      const started = Date.now();

      try {
        const { checks, evidence } = await SCENARIOS[i].run({ page, store, buyer, runId, screenshotDir });
        result.checks = checks;
        result.evidence = evidence;
        result.status = checks.every((c) => c.passed) ? 'passed' : 'failed';
      } catch (err) {
        result.status = 'error';
        result.error = err.message.split('\n')[0];
        if (screenshotDir) {
          const file = `${runId || 'cli'}-${result.id}-error.png`;
          await page.screenshot({ path: `${screenshotDir}/${file}` }).catch(() => {});
          result.evidence = { screenshot: file };
        }
      }

      result.durationMs = Date.now() - started;
      await context.close();
      onUpdate(results);
    }
  } finally {
    await browser.close();
    await store.reset().catch(() => {});
  }

  const allChecks = results.flatMap((r) => r.checks);
  return {
    results,
    summary: {
      scenarios: results.length,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      errors: results.filter((r) => r.status === 'error').length,
      checksPassed: allChecks.filter((c) => c.passed).length,
      checksTotal: allChecks.length,
      bugsFound: [...new Set(allChecks.filter((c) => !c.passed).map((c) => c.bug))],
      score: scoreChecks(allChecks),
    },
  };
}

// Runs Browser Mode scenarios in a real Chromium browser with Playwright.
// Each scenario gets a fresh browser context (clean cookies, so PayPal always asks to log in).

import fs from 'node:fs';
import { chromium } from 'playwright';
import { createStoreClient } from '../lib/storeClient.mjs';
import { summarize } from '../chaos/runner.mjs';
import { SCENARIOS } from './scenarios.mjs';

export async function runBrowser({
  storeUrl,
  storeToken,
  runId,
  screenshotDir,
  headless = true,
  onUpdate = () => {},
  onContext = null, // optional hook to customise each browser context (used by tests)
}) {
  const store = createStoreClient(storeUrl, { token: storeToken });
  const buyer = {
    email: process.env.SANDBOX_BUYER_EMAIL,
    password: process.env.SANDBOX_BUYER_PASSWORD,
  };
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });

  // Browser Mode drives the shop's web pages, so the store must say it supports it
  const health = await store.health();
  const browserReady = Boolean(health.body?.capabilities?.browserMode);

  const results = SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    category: s.category,
    description: s.description,
    status: 'pending',
    checks: [],
  }));
  onUpdate(results);

  if (!browserReady) {
    for (const r of results) {
      r.status = 'skipped';
      r.skipReason = "This store doesn't support Browser Mode (no shop page PayQA can drive). Use Chaos Mode.";
      r.durationMs = 0;
    }
    onUpdate(results);
    return { results, summary: summarize(results) };
  }

  if (!buyer.email || !buyer.password) {
    throw new Error('SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD must be set in .env');
  }

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

      const started = Date.now();

      // The PayPal sandbox is sometimes slow, so a scenario that errors gets one retry
      for (let attempt = 1; attempt <= 2; attempt++) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        if (onContext) await onContext(context);
        const page = await context.newPage();

        const ctx = { page, store, buyer, runId, screenshotDir, popup: null };
        try {
          const { checks, evidence } = await SCENARIOS[i].run(ctx);
          result.checks = checks;
          result.evidence = evidence;
          result.status = checks.every((c) => c.passed) ? 'passed' : 'failed';
          result.attempts = attempt;
          delete result.error;
        } catch (err) {
          result.status = 'error';
          result.error = err.message.split('\n')[0];
          result.attempts = attempt;
          if (screenshotDir) {
            const file = `${runId || 'cli'}-${result.id}-error.png`;
            // screenshot the PayPal popup if it's still open: that's usually where things got stuck
            const target = ctx.popup && !ctx.popup.isClosed() ? ctx.popup : page;
            await target.screenshot({ path: `${screenshotDir}/${file}` }).catch(() => {});
            result.evidence = { screenshot: file };
          }
        }
        await context.close();
        if (result.status !== 'error') break;
      }

      result.durationMs = Date.now() - started;
      onUpdate(results);
    }
  } finally {
    await browser.close();
    await store.reset().catch(() => {});
  }

  return { results, summary: summarize(results) };
}

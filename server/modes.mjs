// One entry point for every test mode: "chaos", "browser", or "full" (both)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChaos, scoreChecks } from './chaos/runner.mjs';
import { runBrowser } from './browser/runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = path.join(__dirname, 'data', 'screenshots');
export const MODES = ['chaos', 'browser', 'full'];

// Fail fast with a clear message if the store isn't reachable
export async function checkStore(storeUrl) {
  try {
    const res = await fetch(`${storeUrl.replace(/\/$/, '')}/api/products`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Can't reach the store at ${storeUrl}. Check it's running and has the PayQA adapter (${err.message}).`,
    };
  }
}

export async function runMode({ mode, storeUrl, runId, headless = true, onUpdate = () => {} }) {
  const reach = await checkStore(storeUrl);
  if (!reach.ok) throw new Error(reach.error);

  if (mode === 'chaos') return runChaos({ storeUrl, onUpdate });

  if (mode === 'browser') {
    return runBrowser({ storeUrl, runId, headless, screenshotDir: SCREENSHOT_DIR, onUpdate });
  }

  if (mode === 'full') {
    let chaosResults = [];
    const chaos = await runChaos({
      storeUrl,
      onUpdate: (r) => {
        chaosResults = r.map((x) => ({ ...x, mode: 'chaos' }));
        onUpdate(chaosResults);
      },
    });
    chaosResults = chaos.results.map((x) => ({ ...x, mode: 'chaos' }));

    const browser = await runBrowser({
      storeUrl,
      runId,
      headless,
      screenshotDir: SCREENSHOT_DIR,
      onUpdate: (r) => onUpdate([...chaosResults, ...r.map((x) => ({ ...x, mode: 'browser' }))]),
    });

    const results = [...chaosResults, ...browser.results.map((x) => ({ ...x, mode: 'browser' }))];
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

  throw new Error(`Unknown mode "${mode}". Use one of: ${MODES.join(', ')}`);
}

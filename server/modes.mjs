// One entry point for every test mode: "chaos", "browser", or "full" (both)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChaos, summarize } from './chaos/runner.mjs';
import { runBrowser } from './browser/runner.mjs';
import { createStoreClient } from './lib/storeClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = path.join(__dirname, 'data', 'screenshots');
export const MODES = ['chaos', 'browser', 'full'];

// Fail fast with a clear message if the store or its PayQA adapter isn't reachable
export async function checkStore(storeUrl, storeToken) {
  let res;
  try {
    res = await createStoreClient(storeUrl, { token: storeToken }).health();
  } catch (err) {
    return { ok: false, error: `Can't reach the store at ${storeUrl}. Check it's running (${err.cause?.code || err.message}).` };
  }
  if (res.ok) return { ok: true, capabilities: res.body?.capabilities || {} };
  if (res.status === 401) return { ok: false, error: 'The store rejected PayQA. Check the store token.' };
  return {
    ok: false,
    error: `The store at ${storeUrl} is running, but its PayQA adapter isn't available at /payqa (HTTP ${res.status}). Mount and enable the adapter.`,
  };
}

export async function runMode({ mode, storeUrl, storeToken, runId, headless = true, onUpdate = () => {} }) {
  const reach = await checkStore(storeUrl, storeToken);
  if (!reach.ok) throw new Error(reach.error);

  if (mode === 'chaos') return runChaos({ storeUrl, storeToken, onUpdate });

  if (mode === 'browser') {
    return runBrowser({ storeUrl, storeToken, runId, headless, screenshotDir: SCREENSHOT_DIR, onUpdate });
  }

  if (mode === 'full') {
    let chaosResults = [];
    const chaos = await runChaos({
      storeUrl,
      storeToken,
      onUpdate: (r) => {
        chaosResults = r.map((x) => ({ ...x, mode: 'chaos' }));
        onUpdate(chaosResults);
      },
    });
    chaosResults = chaos.results.map((x) => ({ ...x, mode: 'chaos' }));

    const browser = await runBrowser({
      storeUrl,
      storeToken,
      runId,
      headless,
      screenshotDir: SCREENSHOT_DIR,
      onUpdate: (r) => onUpdate([...chaosResults, ...r.map((x) => ({ ...x, mode: 'browser' }))]),
    });

    const results = [...chaosResults, ...browser.results.map((x) => ({ ...x, mode: 'browser' }))];
    return { results, summary: summarize(results) };
  }

  throw new Error(`Unknown mode "${mode}". Use one of: ${MODES.join(', ')}`);
}

// PayQA engine: serves the dashboard, starts test runs and reports live results

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { runMode, checkStore, MODES, SCREENSHOT_DIR } from './modes.mjs';
import { createRun, updateRun, getRun, listRuns } from './runs.mjs';
import { analyzeRun } from './ai/analyze.mjs';
import { claudeConfigured } from './ai/claude.mjs';
import { createStoreClient } from './lib/storeClient.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.env.PAYQA_PORT || 5000;
const DEFAULT_STORE_TOKEN = process.env.PAYQA_STORE_TOKEN || undefined;
// Browser runs are headless by default; set PAYQA_HEADLESS=false to watch them (great for demos)
const HEADLESS = process.env.PAYQA_HEADLESS !== 'false';

// ---------- hosted-demo settings (all optional; defaults suit running locally) ----------
// PAYQA_BROWSER_MODE=off      Browser Mode needs a full Chrome, too heavy for small free servers
// PAYQA_LOCK_STORES=true      only the configured demo stores can be tested (public demo)
// PAYQA_MAX_RUNS_PER_HOUR=30  protects the Claude API budget on a public demo
const BROWSER_MODE = process.env.PAYQA_BROWSER_MODE !== 'off';
const LOCK_STORES = process.env.PAYQA_LOCK_STORES === 'true';
const MAX_RUNS_PER_HOUR = Number(process.env.PAYQA_MAX_RUNS_PER_HOUR) || 0;

// Stores offered as one-click choices in the dashboard
const STORES = (() => {
  if (process.env.PAYQA_BUGGY_STORE_URL || process.env.PAYQA_FIXED_STORE_URL) {
    return [
      process.env.PAYQA_BUGGY_STORE_URL && { label: 'Demo store (buggy)', url: process.env.PAYQA_BUGGY_STORE_URL },
      process.env.PAYQA_FIXED_STORE_URL && { label: 'Demo store (fixed)', url: process.env.PAYQA_FIXED_STORE_URL },
    ].filter(Boolean);
  }
  try {
    if (process.env.PAYQA_STORES) return JSON.parse(process.env.PAYQA_STORES);
  } catch {
    console.warn('⚠️  PAYQA_STORES is not valid JSON, using the local demo stores');
  }
  return [
    { label: 'Demo store (buggy)', url: 'http://localhost:4000' },
    { label: 'Demo store (fixed)', url: 'http://localhost:4001' },
    { label: 'Minimal store', url: 'http://localhost:4100', token: 'minimal-store-token' },
  ];
})().map((s) => ({ ...s, url: s.url.replace(/\/$/, '') }));

const DEFAULT_STORE_URL = process.env.STORE_URL || STORES[0]?.url || 'http://localhost:4000';

const allowedStore = (url) => !LOCK_STORES || STORES.some((s) => s.url === url.replace(/\/$/, ''));
const LOCKED_MESSAGE =
  'This hosted demo only tests its own demo stores. To test your own store, run PayQA locally (see the README).';

const runStarts = [];
function rateLimited() {
  if (!MAX_RUNS_PER_HOUR) return false;
  const hourAgo = Date.now() - 3_600_000;
  while (runStarts.length && runStarts[0] < hourAgo) runStarts.shift();
  return runStarts.length >= MAX_RUNS_PER_HOUR;
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) =>
  res.json({
    defaultStoreUrl: DEFAULT_STORE_URL,
    modes: MODES,
    stores: STORES,
    browserMode: BROWSER_MODE,
    lockedStores: LOCK_STORES,
    ai: claudeConfigured() ? 'claude' : 'built-in',
  })
);

// Free hosting puts idle stores to sleep; the dashboard calls this on load to start waking them
app.post('/api/warmup', (req, res) => {
  for (const s of STORES) {
    createStoreClient(s.url, { token: s.token, timeoutMs: 90_000 }).health().catch(() => {});
  }
  res.json({ ok: true });
});

// POST so a store token never ends up in a URL or log
app.post('/api/store-check', async (req, res) => {
  const storeUrl = (req.body?.storeUrl || DEFAULT_STORE_URL).trim();
  if (!allowedStore(storeUrl)) return res.json({ ok: false, error: LOCKED_MESSAGE });
  res.json(await checkStore(storeUrl, req.body?.storeToken || DEFAULT_STORE_TOKEN));
});

// Start a run: { mode: "chaos" | "browser" | "full", storeUrl?: "http://localhost:4000" }
app.post('/api/runs', (req, res) => {
  const mode = req.body?.mode || 'chaos';
  const storeUrl = (req.body?.storeUrl || DEFAULT_STORE_URL).trim();
  const storeToken = req.body?.storeToken || DEFAULT_STORE_TOKEN; // used for this run only, never saved
  if (!MODES.includes(mode)) return res.status(400).json({ error: `Unknown mode "${mode}"` });
  if (!BROWSER_MODE && mode !== 'chaos') {
    return res.status(400).json({ error: 'Browser Mode needs a full Chrome and runs locally only. Use Chaos here.' });
  }
  if (!allowedStore(storeUrl)) return res.status(403).json({ error: LOCKED_MESSAGE });
  if (listRuns().some((r) => r.status === 'running' || r.status === 'analyzing')) {
    return res.status(409).json({ error: 'A test run is already in progress. Wait for it to finish.' });
  }
  if (rateLimited()) {
    return res.status(429).json({ error: 'This demo has reached its hourly limit of test runs. Please try again later.' });
  }
  runStarts.push(Date.now());

  const run = createRun({ mode, storeUrl });
  res.status(202).json({ id: run.id });

  runMode({ mode, storeUrl, storeToken, runId: run.id, headless: HEADLESS, onUpdate: (results) => updateRun(run.id, { results }) })
    .then(async ({ results, summary }) => {
      updateRun(run.id, { status: 'analyzing', results, summary });
      const analysis = await analyzeRun({ mode, results, summary }).catch((err) => ({ error: err.message }));
      updateRun(run.id, { status: 'completed', analysis, finishedAt: new Date().toISOString() });
    })
    .catch((err) => updateRun(run.id, { status: 'error', error: err.message, finishedAt: new Date().toISOString() }));
});

app.get('/api/runs', (req, res) => res.json(listRuns()));

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

app.listen(PORT, () => {
  console.log(`🛡️  PayQA dashboard on http://localhost:${PORT}`);
  console.log(`   Stores: ${STORES.map((s) => s.url).join(', ')}`);
  console.log(`   AI analysis: ${claudeConfigured() ? 'Claude' : 'built-in explanations (no ANTHROPIC_API_KEY)'}`);
  if (!BROWSER_MODE || LOCK_STORES || MAX_RUNS_PER_HOUR) {
    console.log(`   Hosted demo: browser mode ${BROWSER_MODE ? 'on' : 'off'}, stores ${LOCK_STORES ? 'locked' : 'open'}, ${MAX_RUNS_PER_HOUR || 'unlimited'} runs/hour`);
  }
});

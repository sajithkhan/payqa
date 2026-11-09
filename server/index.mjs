// PayQA engine: serves the dashboard, starts test runs and reports live results

import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { runMode, checkStore, MODES, SCREENSHOT_DIR } from './modes.mjs';
import { createRun, updateRun, getRun, listRuns } from './runs.mjs';
import { analyzeRun } from './ai/analyze.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.env.PAYQA_PORT || 5000;
const DEFAULT_STORE_URL = process.env.STORE_URL || 'http://localhost:4000';
// Browser runs are headless by default; set PAYQA_HEADLESS=false to watch them (great for demos)
const HEADLESS = process.env.PAYQA_HEADLESS !== 'false';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => res.json({ defaultStoreUrl: DEFAULT_STORE_URL, modes: MODES }));

app.get('/api/store-check', async (req, res) => {
  res.json(await checkStore(req.query.url || DEFAULT_STORE_URL));
});

// Start a run: { mode: "chaos" | "browser" | "full", storeUrl?: "http://localhost:4000" }
app.post('/api/runs', (req, res) => {
  const mode = req.body?.mode || 'chaos';
  const storeUrl = (req.body?.storeUrl || DEFAULT_STORE_URL).trim();
  if (!MODES.includes(mode)) return res.status(400).json({ error: `Unknown mode "${mode}"` });
  if (listRuns().some((r) => r.status === 'running' || r.status === 'analyzing')) {
    return res.status(409).json({ error: 'A test run is already in progress. Wait for it to finish.' });
  }

  const run = createRun({ mode, storeUrl });
  res.status(202).json({ id: run.id });

  runMode({ mode, storeUrl, runId: run.id, headless: HEADLESS, onUpdate: (results) => updateRun(run.id, { results }) })
    .then(async ({ results, summary }) => {
      updateRun(run.id, { status: 'analyzing', results, summary });
      const analysis = await analyzeRun({ results, summary }).catch((err) => ({ error: err.message }));
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
  console.log(`   Default store under test: ${DEFAULT_STORE_URL}`);
});

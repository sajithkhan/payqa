// PayQA engine API: the dashboard starts runs here and polls for live results

import 'dotenv/config';
import express from 'express';
import { runChaos } from './chaos/runner.mjs';
import { createRun, updateRun, getRun, listRuns } from './runs.mjs';

const PORT = process.env.PAYQA_PORT || 5000;
const DEFAULT_STORE_URL = process.env.STORE_URL || 'http://localhost:4000';

const app = express();
app.use(express.json());

// Allow the dashboard (another port) to call this API
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Start a run: { mode: "chaos", storeUrl?: "http://localhost:4000" }
app.post('/api/runs', (req, res) => {
  const mode = req.body?.mode || 'chaos';
  const storeUrl = req.body?.storeUrl || DEFAULT_STORE_URL;
  if (mode !== 'chaos') return res.status(400).json({ error: `Mode "${mode}" not supported yet` });

  const run = createRun({ mode, storeUrl });
  res.status(202).json({ id: run.id });

  runChaos({ storeUrl, onUpdate: (results) => updateRun(run.id, { results }) })
    .then(({ results, summary }) => updateRun(run.id, { status: 'completed', results, summary, finishedAt: new Date().toISOString() }))
    .catch((err) => updateRun(run.id, { status: 'error', error: err.message }));
});

app.get('/api/runs', (req, res) => res.json(listRuns()));

app.get('/api/runs/:id', (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

app.listen(PORT, () => {
  console.log(`🛡️  PayQA engine on http://localhost:${PORT}`);
  console.log(`   Default store under test: ${DEFAULT_STORE_URL}`);
});

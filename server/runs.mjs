// Stores test runs in memory and saves finished runs to server/data/runs/*.json
// (saved runs survive restarts, so the dashboard can always show the last report)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'data', 'runs');
fs.mkdirSync(DIR, { recursive: true });

const runs = new Map();

for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  try {
    const run = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    if (run.status === 'running' || run.status === 'analyzing') {
      Object.assign(run, { status: 'error', error: 'The engine restarted during this run' });
    }
    runs.set(run.id, run);
  } catch {
    // ignore broken files
  }
}

export function createRun(fields) {
  const id = `run_${Date.now().toString(36)}`;
  const run = { id, status: 'running', createdAt: new Date().toISOString(), results: [], summary: null, ...fields };
  runs.set(id, run);
  return run;
}

export function updateRun(id, patch) {
  const run = runs.get(id);
  Object.assign(run, patch);
  if (run.status === 'completed' || run.status === 'error') {
    fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(run, null, 2));
  }
  return run;
}

export const getRun = (id) => runs.get(id);

export const listRuns = () =>
  [...runs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, mode, status, createdAt, storeUrl, summary, error }) => ({ id, mode, status, createdAt, storeUrl, summary, error }));

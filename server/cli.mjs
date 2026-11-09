// Run PayQA from the terminal:
//   node server/cli.mjs                         chaos mode against http://localhost:4000
//   node server/cli.mjs browser                 browser mode (opens a visible Chrome window)
//   node server/cli.mjs full                    chaos + browser
//   node server/cli.mjs browser --headless      browser mode without a visible window
//   node server/cli.mjs chaos http://my-store   test another store

import 'dotenv/config';
import { runMode, MODES } from './modes.mjs';

const args = process.argv.slice(2);
const mode = args.find((a) => MODES.includes(a)) || 'chaos';
const storeUrl = args.find((a) => a.startsWith('http')) || process.env.STORE_URL || 'http://localhost:4000';
const headless = args.includes('--headless');

console.log(`\n🛡️  PayQA ${mode} mode → ${storeUrl}\n`);

const ICON = { passed: '✅', failed: '❌', error: '⚠️ ' };

let outcome;
try {
  outcome = await runMode({ mode, storeUrl, headless, runId: `cli-${Date.now().toString(36)}` });
} catch (err) {
  console.log(`⚠️  ${err.message}\n`);
  process.exit(1);
}
const { results, summary } = outcome;

for (const r of results) {
  const tag = r.mode ? `[${r.mode}] ` : '';
  console.log(`${ICON[r.status]} ${tag}${r.title}  (${r.durationMs} ms)`);
  if (r.error) console.log(`     error: ${r.error}`);
  for (const c of r.checks) {
    if (!c.passed) {
      console.log(`     ✗ [${c.severity}] ${c.title}`);
      console.log(`         expected: ${c.expected}`);
      console.log(`         actual:   ${c.actual}`);
    }
  }
}

console.log('\n──────────────────────────────');
console.log(`Scenarios: ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} errors`);
console.log(`Checks:    ${summary.checksPassed}/${summary.checksTotal} passed`);
console.log(`Bugs:      ${summary.bugsFound.join(', ') || 'none'}`);
console.log(`Payment Readiness Score: ${summary.score}/100\n`);

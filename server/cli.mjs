// Quick way to run Chaos Mode from the terminal:
//   node server/cli.mjs                       (tests http://localhost:4000)
//   node server/cli.mjs http://other-store    (tests another store)

import 'dotenv/config';
import { runChaos } from './chaos/runner.mjs';

const storeUrl = process.argv[2] || process.env.STORE_URL || 'http://localhost:4000';
console.log(`\n🛡️  PayQA Chaos Mode → ${storeUrl}\n`);

const ICON = { passed: '✅', failed: '❌', error: '⚠️ ' };

const { results, summary } = await runChaos({ storeUrl });

for (const r of results) {
  console.log(`${ICON[r.status]} ${r.title}  (${r.durationMs} ms)`);
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

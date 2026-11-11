// Analysis of a finished run.
// builtInAnalysis() groups failed checks into issues and explains them with built-in text.
// analyzeRun() then asks Claude (if ANTHROPIC_API_KEY is set) to explain this specific run,
// and falls back to the built-in text if Claude isn't available.

import { explainWithClaude, claudeConfigured } from './claude.mjs';

const ISSUES = {
  'amount-mismatch': {
    title: 'PayPal charges a different amount than the cart shows',
    explanation:
      'The cart applies the coupon, but the order sent to PayPal uses the subtotal. The customer sees one price and pays another.',
    impact: 'Customers are overcharged, which leads to chargebacks, refunds and lost trust.',
    fix: `// Send PayPal the same total the customer saw
const chargeAmount = cart.total; // not cart.subtotal`,
  },
  'false-success': {
    title: 'Failed payments are shown as successful',
    explanation:
      'When PayPal declines or errors on capture, the store still returns "Payment successful!" to the customer.',
    impact: 'Customers think they paid and wait for goods. You ship products you were never paid for.',
    fix: `if (!captureSucceeded) {
  return res.status(402).json({ ok: false, message: 'Payment failed. Please try another method.' });
}`,
  },
  'paid-before-capture': {
    title: 'Orders are marked paid before PayPal confirms',
    explanation:
      'The order status, payment record and stock are updated before the capture call returns, and are never rolled back when it fails.',
    impact: 'Your books say you were paid when you were not, and stock disappears for orders that never completed.',
    fix: `const r = await capture(order.id);
if (r.status === 'COMPLETED') {
  order.status = 'PAID';
  recordPayment(order);
  reduceStock(order.lines);
}`,
  },
  'no-idempotency': {
    title: 'Retries record the payment twice',
    explanation:
      'Each capture request records a payment and reduces stock, with no check for a capture already in progress or done.',
    impact: 'A double-click or network retry creates duplicate payments and wrong stock counts.',
    fix: `if (order.status === 'PAID') return res.json({ ok: true, status: 'PAID' });
// and send PayPal-Request-Id: order.id on the capture call`,
  },
  'input-validation': {
    title: 'Invalid carts are accepted',
    explanation: 'The store creates PayPal orders for carts with zero quantities or unknown products.',
    impact: 'Broken orders reach PayPal and your order history.',
    fix: `if (!product || !Number.isInteger(qty) || qty < 1) {
  return res.status(400).json({ error: 'Invalid cart item' });
}`,
  },
  'checkout-broken': {
    title: 'Checkout does not complete',
    explanation: 'A real customer journey through PayPal did not end with a confirmed, paid order.',
    impact: 'Customers cannot pay you.',
    fix: `// Check the onApprove handler calls your capture endpoint
// and that the capture result is COMPLETED before showing success.`,
  },
  inventory: {
    title: 'Stock counts go wrong',
    explanation: 'Stock shown to customers does not match the orders that were actually paid.',
    impact: 'You oversell or hide products that are still available.',
    fix: `// Reduce stock only after a COMPLETED capture, exactly once per order.`,
  },
};

const RANK = { critical: 3, high: 2, medium: 1, low: 0 };

function builtInAnalysis(run) {
  const failed = (run.results || []).flatMap((r) =>
    r.checks.filter((c) => !c.passed).map((c) => ({ ...c, scenarioId: r.id, scenarioTitle: r.title }))
  );

  const byBug = new Map();
  for (const c of failed) {
    const entry = byBug.get(c.bug) || { bug: c.bug, severity: c.severity, scenarios: new Set() };
    if (RANK[c.severity] > RANK[entry.severity]) entry.severity = c.severity;
    entry.scenarios.add(c.scenarioTitle);
    byBug.set(c.bug, entry);
  }

  const issues = [...byBug.values()]
    .sort((a, b) => RANK[b.severity] - RANK[a.severity])
    .map((e) => ({
      bug: e.bug,
      severity: e.severity,
      scenarios: [...e.scenarios],
      ...(ISSUES[e.bug] || {
        title: e.bug,
        explanation: 'This check failed.',
        impact: 'Review the failed checks.',
        fix: '',
      }),
    }));

  const score = run.summary?.score ?? 0;
  const tested = (run.summary?.checksTotal ?? 0) > 0;
  const ready = tested && issues.length === 0 && (run.summary?.errors ?? 0) === 0;
  const critical = issues.filter((i) => i.severity === 'critical').length;

  const errors = (run.results || []).filter((r) => r.status === 'error');
  const errorNote = errors.length
    ? ` ${errors.length} scenario${errors.length === 1 ? '' : 's'} couldn't finish (${errors.map((r) => r.title).join(', ')}), so run again to get a complete result.`
    : '';

  let summary;
  if (!tested && !errors.length) {
    const reason = (run.results || []).find((r) => r.skipReason)?.skipReason;
    summary = `Nothing could be tested in this run.${reason ? ` ${reason}` : ''}`;
  } else if (ready) {
    const skipped = run.summary?.skipped || 0;
    summary =
      `All ${run.summary?.passed ?? ''} scenarios that ran passed. The store handled every failure PayQA threw at it without marking unpaid orders as paid or charging the wrong amount.` +
      (skipped ? ` ${skipped} scenario${skipped === 1 ? ' was' : 's were'} skipped because the store doesn't support ${skipped === 1 ? 'it' : 'them'}.` : '');
  } else if (issues.length) {
    summary =
      `Found ${issues.length} problem${issues.length === 1 ? '' : 's'}${critical ? `, ${critical} critical` : ''}. ` +
      `Most serious: “${issues[0].title}”. Fix these before taking real payments.` +
      errorNote;
  } else {
    summary = `No problems found in the scenarios that finished.${errorNote}`;
  }

  return { source: issues.length ? 'preview' : 'none', ready, score, summary, issues, failed };
}

export async function analyzeRun(run) {
  const base = builtInAnalysis(run);
  const { failed, ...analysis } = base;

  // Nothing to explain, or no key: use the built-in analysis
  if (!analysis.issues.length || !claudeConfigured()) return analysis;

  try {
    const ai = await explainWithClaude({ run, issues: analysis.issues, failedChecks: failed, builtInSummary: analysis.summary });
    const byBug = new Map(ai.issues.map((i) => [i.bug, i]));
    return {
      ...analysis,
      source: 'claude',
      model: ai.model,
      summary: ai.summary || analysis.summary,
      issues: analysis.issues.map((issue) => {
        const x = byBug.get(issue.bug);
        if (!x) return issue;
        return {
          ...issue, // severity and scenarios always come from PayQA, not the AI
          title: x.title || issue.title,
          explanation: x.explanation || issue.explanation,
          impact: x.impact || issue.impact,
          fix: x.fix || issue.fix,
        };
      }),
    };
  } catch (err) {
    console.warn(`⚠️  Claude analysis failed, using built-in explanations: ${err.message}`);
    return { ...analysis, aiError: err.message };
  }
}

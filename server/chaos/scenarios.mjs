// Chaos Mode scenarios.
// Each scenario drives the store, then checks what the store did against what PayPal says really happened.
// PayPal is the source of truth: the engine reads orders straight from the PayPal API.

import { paypalFetch } from '../lib/paypal.mjs';

const DEFAULT_CART = { items: [{ productId: 'p1', qty: 1 }], coupon: '' };

// ---------- helpers ----------

const looksLikeSuccess = (res) =>
  res.body?.ok === true || /success/i.test(res.body?.message || '');

function check(id, title, passed, { severity, bug, expected, actual }) {
  return { id, title, passed: Boolean(passed), severity, bug, expected, actual };
}

async function paypalOrder(orderId) {
  const r = await paypalFetch(`/v2/checkout/orders/${orderId}`);
  return r.ok ? r.data : null;
}

// Create an order, then fail the capture `times` times with a PayPal mock error
async function failedCaptureFlow(store, mockCode, times = 1, cart = DEFAULT_CART) {
  await store.reset();
  const stockBefore = await store.inventory();

  const created = await store.createOrder(cart);
  if (!created.ok) throw new Error(`Store could not create order: ${JSON.stringify(created.body)}`);
  const orderId = created.body.id;

  const captures = [];
  for (let i = 0; i < times; i++) captures.push(await store.capture(orderId, mockCode));

  const storeOrder = await store.getOrder(orderId);
  const stockAfter = await store.inventory();
  const pp = await paypalOrder(orderId);

  return { orderId, captures, storeOrder, stockBefore, stockAfter, paypalStatus: pp?.status || 'UNKNOWN' };
}

// Standard checks for "PayPal said no"
function paymentFailureChecks(flow, code) {
  const cap = flow.captures[0];
  const p1Before = flow.stockBefore.p1;
  const p1After = flow.stockAfter.p1;

  return [
    check('no-false-success', 'Customer is not told the payment succeeded', !looksLikeSuccess(cap), {
      severity: 'critical',
      bug: 'false-success',
      expected: 'An error message shown to the customer',
      actual: `HTTP ${cap.status}: "${cap.body?.message ?? JSON.stringify(cap.body)}"`,
    }),
    check(
      'status-matches-paypal',
      'Order is not marked PAID unless PayPal completed it',
      !(flow.storeOrder.status === 'PAID' && flow.paypalStatus !== 'COMPLETED'),
      {
        severity: 'critical',
        bug: 'paid-before-capture',
        expected: `Store status not PAID (PayPal status: ${flow.paypalStatus})`,
        actual: `Store status: ${flow.storeOrder.status}, PayPal status: ${flow.paypalStatus}`,
      }
    ),
    check('no-stock-for-unpaid', 'No stock deducted for an unpaid order', p1After === p1Before, {
      severity: 'high',
      bug: 'paid-before-capture',
      expected: `Stock stays at ${p1Before}`,
      actual: `Stock went ${p1Before} → ${p1After}`,
    }),
    check('no-payment-recorded', 'No payment recorded when PayPal declined', (flow.storeOrder.paymentsRecorded ?? 0) === 0, {
      severity: 'high',
      bug: 'paid-before-capture',
      expected: '0 payments recorded',
      actual: `${flow.storeOrder.paymentsRecorded} payment(s) recorded after ${code}`,
    }),
  ];
}

// ---------- scenarios ----------

export const SCENARIOS = [
  {
    id: 'card-declined',
    title: 'Card declined at capture',
    category: 'Payment failure',
    description: 'PayPal declines the buyer\'s card when the store captures the payment.',
    mockCode: 'INSTRUMENT_DECLINED',
    async run(store) {
      const flow = await failedCaptureFlow(store, this.mockCode);
      return { checks: paymentFailureChecks(flow, this.mockCode), evidence: flow };
    },
  },
  {
    id: 'transaction-refused',
    title: 'Transaction refused by PayPal',
    category: 'Payment failure',
    description: 'PayPal refuses the transaction (e.g. risk or compliance reasons).',
    mockCode: 'TRANSACTION_REFUSED',
    async run(store) {
      const flow = await failedCaptureFlow(store, this.mockCode);
      return { checks: paymentFailureChecks(flow, this.mockCode), evidence: flow };
    },
  },
  {
    id: 'paypal-outage',
    title: 'PayPal server error during capture',
    category: 'Resilience',
    description: 'PayPal returns a 500 error while the store is capturing the payment.',
    mockCode: 'INTERNAL_SERVER_ERROR',
    async run(store) {
      const flow = await failedCaptureFlow(store, this.mockCode);
      const checks = paymentFailureChecks(flow, this.mockCode).filter((c) =>
        ['no-false-success', 'status-matches-paypal'].includes(c.id)
      );
      return { checks, evidence: flow };
    },
  },
  {
    id: 'retry-capture',
    title: 'Customer retries after a failed payment',
    category: 'Idempotency',
    description: 'The capture call is sent twice (double-click, network retry). It must not double-record.',
    mockCode: 'INSTRUMENT_DECLINED',
    async run(store) {
      const flow = await failedCaptureFlow(store, this.mockCode, 2);
      const recorded = flow.storeOrder.paymentsRecorded ?? 0;
      const deducted = flow.stockBefore.p1 - flow.stockAfter.p1;
      const checks = [
        check('payment-recorded-once', 'Payment recorded at most once across retries', recorded <= 1, {
          severity: 'critical',
          bug: 'no-idempotency',
          expected: 'At most 1 payment record',
          actual: `${recorded} payment records after 2 capture attempts`,
        }),
        check('stock-deducted-once', 'Stock deducted at most once across retries', deducted <= 1, {
          severity: 'high',
          bug: 'no-idempotency',
          expected: 'Stock reduced by at most 1',
          actual: `Stock reduced by ${deducted}`,
        }),
      ];
      return { checks, evidence: flow };
    },
  },
  {
    id: 'coupon-amount',
    title: 'Coupon discount reaches PayPal',
    category: 'Amount integrity',
    description: 'Cart with coupon SAVE10: the amount PayPal charges must match the total the customer saw.',
    async run(store) {
      await store.reset();
      const cart = { items: [{ productId: 'p1', qty: 2 }, { productId: 'p3', qty: 1 }], coupon: 'SAVE10' };
      const shown = (await store.priceCart(cart)).body;
      const created = await store.createOrder(cart);
      if (!created.ok) throw new Error(`Store could not create order: ${JSON.stringify(created.body)}`);
      const pp = await paypalOrder(created.body.id);
      const charged = Number(pp?.purchase_units?.[0]?.amount?.value);
      const diff = Math.round((charged - shown.total) * 100) / 100;

      const checks = [
        check('amount-matches', 'PayPal charges the total shown at checkout', Math.abs(diff) < 0.01, {
          severity: 'critical',
          bug: 'amount-mismatch',
          expected: `$${shown.total.toFixed(2)} (after ${shown.coupon} discount of $${shown.discount.toFixed(2)})`,
          actual: `PayPal order amount: $${charged.toFixed(2)} (customer overcharged by $${diff.toFixed(2)})`,
        }),
      ];
      return { checks, evidence: { shown, orderId: created.body.id, paypalAmount: charged } };
    },
  },
  {
    id: 'plain-amount',
    title: 'Amount matches without a coupon',
    category: 'Amount integrity',
    description: 'Control test: a normal cart should send the exact total to PayPal.',
    async run(store) {
      await store.reset();
      const cart = { items: [{ productId: 'p2', qty: 1 }, { productId: 'p3', qty: 2 }], coupon: '' };
      const shown = (await store.priceCart(cart)).body;
      const created = await store.createOrder(cart);
      if (!created.ok) throw new Error(`Store could not create order: ${JSON.stringify(created.body)}`);
      const pp = await paypalOrder(created.body.id);
      const charged = Number(pp?.purchase_units?.[0]?.amount?.value);

      const checks = [
        check('amount-matches', 'PayPal charges the total shown at checkout', Math.abs(charged - shown.total) < 0.01, {
          severity: 'critical',
          bug: 'amount-mismatch',
          expected: `$${shown.total.toFixed(2)}`,
          actual: `PayPal order amount: $${charged.toFixed(2)}`,
        }),
      ];
      return { checks, evidence: { shown, orderId: created.body.id, paypalAmount: charged } };
    },
  },
  {
    id: 'invalid-cart',
    title: 'Invalid cart is rejected',
    category: 'Input validation',
    description: 'Zero quantity and unknown products must be rejected before a PayPal order is created.',
    async run(store) {
      await store.reset();
      const zeroQty = await store.createOrder({ items: [{ productId: 'p1', qty: 0 }] });
      const unknown = await store.createOrder({ items: [{ productId: 'nope', qty: 1 }] });
      const checks = [
        check('rejects-zero-qty', 'Rejects a cart with quantity 0', zeroQty.status >= 400 && zeroQty.status < 500, {
          severity: 'medium',
          bug: 'input-validation',
          expected: 'HTTP 4xx',
          actual: `HTTP ${zeroQty.status}`,
        }),
        check('rejects-unknown-product', 'Rejects an unknown product', unknown.status >= 400 && unknown.status < 500, {
          severity: 'medium',
          bug: 'input-validation',
          expected: 'HTTP 4xx',
          actual: `HTTP ${unknown.status}`,
        }),
      ];
      return { checks, evidence: { zeroQty, unknown } };
    },
  },
];

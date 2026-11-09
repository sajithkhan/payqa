// Chaos Mode scenarios.
// Each scenario drives the store through the PayQA Adapter, then checks what the store did
// against what PayPal says really happened. PayPal is the source of truth: the engine reads
// orders straight from the PayPal API.
//
// Scenarios adapt to the store: they use the store's own products, only check stock if the
// store reports inventory, and only test coupons if the store declares a test coupon.

import { paypalFetch } from '../lib/paypal.mjs';

// ---------- helpers ----------

const looksLikeSuccess = (res) => res.body?.ok === true || /success/i.test(res.body?.message || '');

function check(id, title, passed, { severity, bug, expected, actual }) {
  return { id, title, passed: Boolean(passed), severity, bug, expected, actual };
}

async function paypalOrder(orderId) {
  const r = await paypalFetch(`/v2/checkout/orders/${orderId}`);
  return r.ok ? r.data : null;
}

const money = (n) => `$${Number(n).toFixed(2)}`;

// Create an order for one unit of the first product, then fail the capture `times` times
async function failedCaptureFlow(ctx, mockCode, times = 1) {
  const { store, products } = ctx;
  const product = products[0];
  await store.reset();
  const stockBefore = await store.inventory();

  const created = await store.createOrder({ items: [{ productId: product.id, qty: 1 }], coupon: '' });
  if (!created.ok || !created.body?.id) {
    throw new Error(`Store could not create an order (HTTP ${created.status}): ${JSON.stringify(created.body)}`);
  }
  const orderId = created.body.id;

  const captures = [];
  for (let i = 0; i < times; i++) captures.push(await store.capture(orderId, mockCode));

  const storeOrder = (await store.getOrder(orderId)) || {};
  const stockAfter = await store.inventory();
  const pp = await paypalOrder(orderId);

  return {
    orderId,
    product,
    captures,
    storeOrder,
    stockBefore: stockBefore?.[product.id],
    stockAfter: stockAfter?.[product.id],
    paypalStatus: pp?.status || 'UNKNOWN',
  };
}

// Standard checks for "PayPal said no"
function paymentFailureChecks(flow, code, { withStock = true, withPayments = true } = {}) {
  const cap = flow.captures[0];
  const checks = [
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
        actual: `Store status: ${flow.storeOrder.status ?? 'unknown'}, PayPal status: ${flow.paypalStatus}`,
      }
    ),
  ];

  if (withStock && flow.stockBefore !== undefined) {
    checks.push(
      check('no-stock-for-unpaid', 'No stock deducted for an unpaid order', flow.stockAfter === flow.stockBefore, {
        severity: 'high',
        bug: 'paid-before-capture',
        expected: `${flow.product.name} stock stays at ${flow.stockBefore}`,
        actual: `Stock went ${flow.stockBefore} → ${flow.stockAfter}`,
      })
    );
  }
  if (withPayments && flow.storeOrder.paymentsRecorded !== undefined) {
    checks.push(
      check('no-payment-recorded', 'No payment recorded when PayPal declined', flow.storeOrder.paymentsRecorded === 0, {
        severity: 'high',
        bug: 'paid-before-capture',
        expected: '0 payments recorded',
        actual: `${flow.storeOrder.paymentsRecorded} payment(s) recorded after ${code}`,
      })
    );
  }
  return checks;
}

async function amountCheck(ctx, cart, label) {
  const { store } = ctx;
  await store.reset();
  const priced = await store.priceCart(cart);
  if (!priced.ok) throw new Error(`Store could not price the cart (HTTP ${priced.status})`);
  const shown = priced.body;

  const created = await store.createOrder(cart);
  if (!created.ok || !created.body?.id) throw new Error(`Store could not create an order (HTTP ${created.status})`);
  const pp = await paypalOrder(created.body.id);
  const charged = Number(pp?.purchase_units?.[0]?.amount?.value);
  const diff = Math.round((charged - shown.total) * 100) / 100;

  const check1 = check('amount-matches', 'PayPal charges the total shown at checkout', Math.abs(diff) < 0.01, {
    severity: 'critical',
    bug: 'amount-mismatch',
    expected: `${money(shown.total)}${label ? ` (${label})` : ''}`,
    actual:
      Math.abs(diff) < 0.01
        ? `PayPal order amount: ${money(charged)}`
        : `PayPal order amount: ${money(charged)} (customer ${diff > 0 ? 'overcharged' : 'undercharged'} by ${money(Math.abs(diff))})`,
  });
  return { checks: [check1], evidence: { shown, orderId: created.body.id, paypalAmount: charged } };
}

// ---------- scenarios ----------

export const SCENARIOS = [
  {
    id: 'card-declined',
    title: 'Card declined at capture',
    category: 'Payment failure',
    description: "PayPal declines the buyer's card when the store captures the payment.",
    mockCode: 'INSTRUMENT_DECLINED',
    async run(ctx) {
      const flow = await failedCaptureFlow(ctx, this.mockCode);
      return { checks: paymentFailureChecks(flow, this.mockCode), evidence: flow };
    },
  },
  {
    id: 'transaction-refused',
    title: 'Transaction refused by PayPal',
    category: 'Payment failure',
    description: 'PayPal refuses the transaction (e.g. risk or compliance reasons).',
    mockCode: 'TRANSACTION_REFUSED',
    async run(ctx) {
      const flow = await failedCaptureFlow(ctx, this.mockCode);
      return { checks: paymentFailureChecks(flow, this.mockCode), evidence: flow };
    },
  },
  {
    id: 'paypal-outage',
    title: 'PayPal server error during capture',
    category: 'Resilience',
    description: 'PayPal returns a 500 error while the store is capturing the payment.',
    mockCode: 'INTERNAL_SERVER_ERROR',
    async run(ctx) {
      const flow = await failedCaptureFlow(ctx, this.mockCode);
      return { checks: paymentFailureChecks(flow, this.mockCode, { withStock: false, withPayments: false }), evidence: flow };
    },
  },
  {
    id: 'retry-capture',
    title: 'Customer retries after a failed payment',
    category: 'Idempotency',
    description: 'The capture call is sent twice (double-click, network retry). It must not double-record.',
    mockCode: 'INSTRUMENT_DECLINED',
    async run(ctx) {
      const flow = await failedCaptureFlow(ctx, this.mockCode, 2);
      const checks = [];
      if (flow.storeOrder.paymentsRecorded !== undefined) {
        checks.push(
          check('payment-recorded-once', 'Payment recorded at most once across retries', flow.storeOrder.paymentsRecorded <= 1, {
            severity: 'critical',
            bug: 'no-idempotency',
            expected: 'At most 1 payment record',
            actual: `${flow.storeOrder.paymentsRecorded} payment records after 2 capture attempts`,
          })
        );
      }
      if (flow.stockBefore !== undefined) {
        const deducted = flow.stockBefore - flow.stockAfter;
        checks.push(
          check('stock-deducted-once', 'Stock deducted at most once across retries', deducted <= 1, {
            severity: 'high',
            bug: 'no-idempotency',
            expected: 'Stock reduced by at most 1',
            actual: `Stock reduced by ${deducted}`,
          })
        );
      }
      if (!checks.length) return { skipped: 'The store does not report payments or inventory, so retries cannot be checked.' };
      return { checks, evidence: flow };
    },
  },
  {
    id: 'coupon-amount',
    title: 'Coupon discount reaches PayPal',
    category: 'Amount integrity',
    description: 'A cart with the store\'s test coupon: the amount PayPal charges must match the total the customer saw.',
    async run(ctx) {
      const coupon = ctx.capabilities.testCoupon;
      if (!coupon) return { skipped: 'The store did not declare a test coupon.' };
      const [a, , c] = ctx.products;
      const cart = {
        items: [{ productId: a.id, qty: 2 }, ...(c ? [{ productId: c.id, qty: 1 }] : [])],
        coupon,
      };
      const result = await amountCheck(ctx, cart, `after ${coupon}`);
      const s = result.evidence.shown;
      if (s.discount) result.checks[0].expected = `${money(s.total)} (after ${coupon} discount of ${money(s.discount)})`;
      return result;
    },
  },
  {
    id: 'plain-amount',
    title: 'Amount matches without a coupon',
    category: 'Amount integrity',
    description: 'Control test: a normal cart should send the exact total to PayPal.',
    async run(ctx) {
      const [a, b = a, c = a] = ctx.products;
      const items = b.id === c.id ? [{ productId: b.id, qty: 3 }] : [{ productId: b.id, qty: 1 }, { productId: c.id, qty: 2 }];
      return amountCheck(ctx, { items, coupon: '' });
    },
  },
  {
    id: 'invalid-cart',
    title: 'Invalid cart is rejected',
    category: 'Input validation',
    description: 'Zero quantity and unknown products must be rejected before a PayPal order is created.',
    async run(ctx) {
      const { store, products } = ctx;
      await store.reset();
      const zeroQty = await store.createOrder({ items: [{ productId: products[0].id, qty: 0 }] });
      const unknown = await store.createOrder({ items: [{ productId: 'payqa-does-not-exist', qty: 1 }] });
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

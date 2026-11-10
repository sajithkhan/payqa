// Minimal Store: a second, independent example of a store connected to PayQA.
//
// It's deliberately different from the demo store, to show the adapter isn't tied to it:
//   - different products and cart format (SKUs, prices in cents)
//   - no coupons and no stock tracking (PayQA skips those checks)
//   - the PayQA endpoints are protected with a token
//   - its checkout logic is correct, so PayQA should clear it for go-live
//
// Run from the repo root (uses the same PayPal sandbox keys in .env):
//   node examples/minimal-store/server.mjs
// Then in PayQA: store URL http://localhost:4100, token: minimal-store-token

import 'dotenv/config';
import express from 'express';
import { payqaAdapter, payqaPayPalHeaders } from '../../adapter/payqa-adapter.mjs';

const PORT = process.env.MINIMAL_STORE_PORT || 4100;
const PAYPAL = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com';
const PAYQA_TOKEN = process.env.MINIMAL_STORE_TOKEN || 'minimal-store-token';

// ---------- catalog and orders (in memory) ----------
const CATALOG = {
  'MUG-01': { name: 'Enamel camping mug', cents: 1250 },
  'TEE-02': { name: 'Organic cotton tee', cents: 2900 },
};
const orders = new Map(); // paypalOrderId -> { state, cents, captures }

// ---------- PayPal client ----------
let token = null;
let tokenExpires = 0;

async function paypal(path, { method = 'GET', body, requestId } = {}) {
  if (!token || Date.now() > tokenExpires) {
    const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${PAYPAL}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const d = await r.json();
    if (!r.ok) throw new Error('PayPal auth failed');
    token = d.access_token;
    tokenExpires = Date.now() + (d.expires_in - 60) * 1000;
  }

  const res = await fetch(`${PAYPAL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {}), // PayPal-side idempotency
      ...payqaPayPalHeaders(), // the one line added for PayQA
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
}

// ---------- checkout logic ----------
function cartCents(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Cart is empty');
  return items.reduce((sum, { productId, qty }) => {
    const p = CATALOG[productId];
    if (!p || !Number.isInteger(qty) || qty < 1) throw new Error(`Invalid item: ${productId}`);
    return sum + p.cents * qty;
  }, 0);
}

async function startCheckout({ items }) {
  let cents;
  try {
    cents = cartCents(items);
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }
  const r = await paypal('/v2/checkout/orders', {
    method: 'POST',
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: (cents / 100).toFixed(2) } }],
    },
  });
  if (!r.ok) return { status: 502, body: { error: 'Payment provider unavailable' } };
  orders.set(r.data.id, { state: 'AWAITING_PAYMENT', cents, captures: 0 });
  return { status: 201, body: { id: r.data.id } };
}

async function confirmPayment(orderId) {
  const order = orders.get(orderId);
  if (!order) return { status: 404, body: { ok: false, message: 'Unknown order' } };

  // Idempotent: a repeat request after success changes nothing
  if (order.state === 'PAID') return { status: 200, body: { ok: true, message: 'Already paid. Thank you!' } };

  const r = await paypal(`/v2/checkout/orders/${orderId}/capture`, { method: 'POST', requestId: `capture-${orderId}` });
  const capture = r.data?.purchase_units?.[0]?.payments?.captures?.[0];

  // Only a COMPLETED capture counts as paid
  if (!r.ok || capture?.status !== 'COMPLETED') {
    order.state = 'PAYMENT_FAILED';
    return { status: 402, body: { ok: false, message: 'Your payment did not go through. You have not been charged.' } };
  }

  order.state = 'PAID';
  order.captures += 1;
  return { status: 200, body: { ok: true, message: 'Payment received. Thank you!' } };
}

// ---------- app ----------
const app = express();
app.use(express.json());

// The store's own customer API (what its front end would call)
app.post('/checkout', async (req, res) => {
  const r = await startCheckout(req.body);
  res.status(r.status).json(r.body);
});
app.post('/checkout/:id/confirm', async (req, res) => {
  const r = await confirmPayment(req.params.id);
  res.status(r.status).json(r.body);
});

// PayQA Adapter: maps PayQA's calls onto the functions above
app.use(
  '/payqa',
  payqaAdapter({
    enabled: process.env.PAYQA_ENABLED !== 'false',
    token: PAYQA_TOKEN,
    paypalBaseUrl: PAYPAL,
    products: () => Object.entries(CATALOG).map(([id, p]) => ({ id, name: p.name, price: p.cents / 100 })),
    priceCart: ({ items }) => {
      const total = cartCents(items) / 100;
      return { subtotal: total, discount: 0, total };
    },
    createOrder: startCheckout,
    captureOrder: confirmPayment,
    getOrder: (id) => {
      const o = orders.get(id);
      return o && { status: o.state === 'PAID' ? 'PAID' : o.state, paymentsRecorded: o.captures };
    },
    reset: () => orders.clear(),
    // no inventory and no testCoupon: PayQA skips those checks
  })
);

app.get('/', (req, res) => {
  res.type('text').send('Minimal Store (API only). Test it from the PayQA dashboard: store URL http://localhost:4100, token: minimal-store-token.');
});

app.listen(PORT, () => {
  console.log(`🧺 Minimal Store on http://localhost:${PORT}`);
  console.log(`   PayQA adapter: /payqa (token: ${PAYQA_TOKEN})`);
});

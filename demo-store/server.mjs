// PayQA Demo Store: a small shop with a PayPal checkout and 4 deliberate bugs.
// BUGGY_MODE=true (default) turns the bugs on; BUGGY_MODE=false is the "fixed" store.
//
// The planted bugs PayQA should catch:
//   BUG 1: Order is marked PAID before PayPal confirms the capture
//   BUG 2: Coupon discount is shown in the cart but PayPal is charged the full price
//   BUG 3: A declined/failed capture still shows "Payment successful!" to the customer
//   BUG 4: No idempotency, so retrying capture records the payment twice and reduces stock twice

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paypalFetch } from './paypal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.STORE_PORT || 4000;
const BUGGY = process.env.BUGGY_MODE !== 'false';
const TEST_MODE = process.env.STORE_TEST_MODE !== 'false'; // lets PayQA inject PayPal mock errors

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- In-memory "database" ----------
const PRODUCTS = [
  { id: 'p1', name: 'Ceylon Tea Gift Box', price: 24.0, emoji: '🍵' },
  { id: 'p2', name: 'Handmade Batik Scarf', price: 39.5, emoji: '🧣' },
  { id: 'p3', name: 'Wooden Elephant Figurine', price: 18.75, emoji: '🐘' },
];
const COUPONS = { SAVE10: 0.1 };

let stock = {};
let orders = new Map(); // key: PayPal order id
let payments = [];

function resetDb() {
  stock = { p1: 20, p2: 15, p3: 30 };
  orders = new Map();
  payments = [];
}
resetDb();

const money = (n) => Math.round(n * 100) / 100;

function priceCart(items = [], coupon) {
  let subtotal = 0;
  const lines = [];
  for (const { productId, qty } of items) {
    const product = PRODUCTS.find((p) => p.id === productId);
    const quantity = Number(qty);
    if (!product || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Invalid cart item: ${productId}`);
    }
    subtotal += product.price * quantity;
    lines.push({ productId, name: product.name, qty: quantity, price: product.price });
  }
  if (lines.length === 0) throw new Error('Cart is empty');

  const code = (coupon || '').trim().toUpperCase();
  const rate = COUPONS[code] || 0;
  const discount = money(subtotal * rate);
  return {
    lines,
    subtotal: money(subtotal),
    coupon: rate ? code : null,
    discount,
    total: money(subtotal - discount),
  };
}

function reduceStock(lines) {
  for (const l of lines) stock[l.productId] -= l.qty;
}

// PayQA can force PayPal failures by sending this header (sandbox negative testing)
const mockFrom = (req) => (TEST_MODE ? req.get('x-payqa-mock') || null : null);

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID, buggyMode: BUGGY, testMode: TEST_MODE });
});

app.get('/api/products', (req, res) => {
  res.json(PRODUCTS.map((p) => ({ ...p, stock: stock[p.id] })));
});

// Preview totals for the cart UI
app.post('/api/cart/price', (req, res) => {
  try {
    res.json(priceCart(req.body.items, req.body.coupon));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Create a PayPal order
app.post('/api/orders', async (req, res) => {
  let cart;
  try {
    cart = priceCart(req.body.items, req.body.coupon);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // BUG 2: the customer sees the discounted total, but PayPal is charged the subtotal
  const chargeAmount = BUGGY ? cart.subtotal : cart.total;

  const r = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
    mockCode: mockFrom(req),
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          description: 'PayQA Demo Store order',
          amount: { currency_code: 'USD', value: chargeAmount.toFixed(2) },
        },
      ],
    },
  });

  if (!r.ok) {
    return res.status(502).json({ error: 'Could not create PayPal order', paypal: r.data });
  }

  orders.set(r.data.id, {
    id: r.data.id,
    status: 'CREATED',
    lines: cart.lines,
    coupon: cart.coupon,
    expectedTotal: cart.total,
    chargedAmount: chargeAmount,
    captureAttempts: 0,
    paypalStatus: r.data.status,
    failureReason: null,
    createdAt: new Date().toISOString(),
  });

  res.json({ id: r.data.id, expectedTotal: cart.total });
});

// Capture a PayPal order (called after the buyer approves)
app.post('/api/orders/:id/capture', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.captureAttempts += 1;

  if (BUGGY) {
    // BUG 1: mark as paid before PayPal has confirmed anything
    order.status = 'PAID';
    // BUG 4: no idempotency check, so every call records a payment and reduces stock
    payments.push({ orderId: order.id, amount: order.chargedAmount, at: new Date().toISOString() });
    reduceStock(order.lines);
  } else if (order.status === 'PAID') {
    // Fixed: idempotent, a retry doesn't double-record
    return res.json({ ok: true, status: 'PAID', message: 'Payment already completed.' });
  }

  const r = await paypalFetch(`/v2/checkout/orders/${order.id}/capture`, {
    method: 'POST',
    mockCode: mockFrom(req),
  });

  const capture = r.data?.purchase_units?.[0]?.payments?.captures?.[0];
  const succeeded = r.ok && r.data?.status === 'COMPLETED' && capture?.status === 'COMPLETED';

  if (!succeeded) {
    const reason =
      r.data?.details?.[0]?.issue || capture?.status || r.data?.name || `HTTP ${r.status}`;

    if (BUGGY) {
      // BUG 3: swallow the failure and tell the customer it worked
      order.paypalStatus = `FAILED: ${reason}`;
      return res.json({ ok: true, status: order.status, message: 'Payment successful!' });
    }

    order.status = 'PAYMENT_FAILED';
    order.paypalStatus = `FAILED: ${reason}`;
    order.failureReason = reason;
    return res
      .status(402)
      .json({ ok: false, status: order.status, message: 'Payment failed. Please try another method.', reason });
  }

  if (!BUGGY) {
    order.status = 'PAID';
    payments.push({ orderId: order.id, amount: Number(capture.amount.value), at: new Date().toISOString() });
    reduceStock(order.lines);
  }
  order.paypalStatus = 'COMPLETED';
  order.paypalCaptureId = capture.id;
  order.paypalCapturedAmount = Number(capture.amount.value);

  res.json({ ok: true, status: 'PAID', message: 'Payment successful!' });
});

// ---------- Inspection endpoints used by PayQA ----------
app.get('/api/orders', (req, res) => res.json([...orders.values()]));

app.get('/api/orders/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ ...order, paymentsRecorded: payments.filter((p) => p.orderId === order.id).length });
});

app.get('/api/inventory', (req, res) => res.json(stock));

app.post('/api/test/reset', (req, res) => {
  if (!TEST_MODE) return res.status(403).json({ error: 'Test mode is off' });
  resetDb();
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🛒 PayQA Demo Store on http://localhost:${PORT}`);
  console.log(`   Buggy mode: ${BUGGY ? 'ON (4 planted bugs)' : 'OFF (fixed store)'}`);
});

// PayQA Demo Store: a small shop with a PayPal checkout and 4 deliberate bugs.
// BUGGY_MODE=true (default) turns the bugs on; BUGGY_MODE=false is the "fixed" store.
//
// The planted bugs PayQA should catch:
//   BUG 1: Order is marked PAID before PayPal confirms the capture
//   BUG 2: Coupon discount is shown in the cart but PayPal is charged the full price
//   BUG 3: A declined/failed capture still shows "Payment successful!" to the customer
//   BUG 4: No idempotency, so retrying capture records the payment twice and reduces stock twice
//
// The store connects to PayQA through the PayQA Adapter (see ../adapter), mounted at /payqa.

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paypalFetch } from './paypal.mjs';
import { payqaAdapter } from '../adapter/payqa-adapter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || process.env.STORE_PORT || 4000;
// `node demo-store/server.mjs --fixed` (or BUGGY_MODE=false) runs the store without the bugs
const BUGGY = process.env.BUGGY_MODE !== 'false' && !process.argv.includes('--fixed');

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

// ---------- Checkout logic (used by the customer API and by the PayQA adapter) ----------
// Each returns { status, body }: exactly what the customer-facing endpoint sends.

async function createOrder({ items, coupon } = {}) {
  let cart;
  try {
    cart = priceCart(items, coupon);
  } catch (e) {
    return { status: 400, body: { error: e.message } };
  }

  // BUG 2: the customer sees the discounted total, but PayPal is charged the subtotal
  const chargeAmount = BUGGY ? cart.subtotal : cart.total;

  const r = await paypalFetch('/v2/checkout/orders', {
    method: 'POST',
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

  if (!r.ok) return { status: 502, body: { error: 'Could not create PayPal order', paypal: r.data } };

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

  return { status: 200, body: { id: r.data.id, expectedTotal: cart.total } };
}

async function captureOrder(orderId) {
  const order = orders.get(orderId);
  if (!order) return { status: 404, body: { error: 'Order not found' } };

  order.captureAttempts += 1;

  if (BUGGY) {
    // BUG 1: mark as paid before PayPal has confirmed anything
    order.status = 'PAID';
    // BUG 4: no idempotency check, so every call records a payment and reduces stock
    payments.push({ orderId: order.id, amount: order.chargedAmount, at: new Date().toISOString() });
    reduceStock(order.lines);
  } else if (order.status === 'PAID') {
    // Fixed: idempotent, a retry doesn't double-record
    return { status: 200, body: { ok: true, status: 'PAID', message: 'Payment already completed.' } };
  }

  const r = await paypalFetch(`/v2/checkout/orders/${order.id}/capture`, { method: 'POST' });

  const capture = r.data?.purchase_units?.[0]?.payments?.captures?.[0];
  const succeeded = r.ok && r.data?.status === 'COMPLETED' && capture?.status === 'COMPLETED';

  if (!succeeded) {
    const reason = r.data?.details?.[0]?.issue || capture?.status || r.data?.name || `HTTP ${r.status}`;

    if (BUGGY) {
      // BUG 3: swallow the failure and tell the customer it worked
      order.paypalStatus = `FAILED: ${reason}`;
      return { status: 200, body: { ok: true, status: order.status, message: 'Payment successful!' } };
    }

    order.status = 'PAYMENT_FAILED';
    order.paypalStatus = `FAILED: ${reason}`;
    order.failureReason = reason;
    return {
      status: 402,
      body: { ok: false, status: order.status, message: 'Payment failed. Please try another method.', reason },
    };
  }

  if (!BUGGY) {
    order.status = 'PAID';
    payments.push({ orderId: order.id, amount: Number(capture.amount.value), at: new Date().toISOString() });
    reduceStock(order.lines);
  }
  order.paypalStatus = 'COMPLETED';
  order.paypalCaptureId = capture.id;
  order.paypalCapturedAmount = Number(capture.amount.value);

  return { status: 200, body: { ok: true, status: 'PAID', message: 'Payment successful!' } };
}

function getOrder(orderId) {
  const order = orders.get(orderId);
  if (!order) return null;
  return { ...order, paymentsRecorded: payments.filter((p) => p.orderId === order.id).length };
}

// ---------- Customer API (used by the shop's own front end) ----------
app.get('/api/config', (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID, buggyMode: BUGGY });
});

app.get('/api/products', (req, res) => {
  res.json(PRODUCTS.map((p) => ({ ...p, stock: stock[p.id] })));
});

app.post('/api/cart/price', (req, res) => {
  try {
    res.json(priceCart(req.body.items, req.body.coupon));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/orders', async (req, res) => {
  const r = await createOrder(req.body);
  res.status(r.status).json(r.body);
});

app.post('/api/orders/:id/capture', async (req, res) => {
  const r = await captureOrder(req.params.id);
  res.status(r.status).json(r.body);
});

// ---------- PayQA Adapter ----------
app.use(
  '/payqa',
  payqaAdapter({
    enabled: process.env.PAYQA_ENABLED !== 'false', // on by default for the demo store
    token: process.env.PAYQA_TOKEN,
    paypalBaseUrl: process.env.PAYPAL_BASE_URL,
    testCoupon: 'SAVE10',
    browserMode: true, // the shop page uses PayQA's data-testid conventions
    products: () => PRODUCTS.map((p) => ({ id: p.id, name: p.name, price: p.price })),
    priceCart: (cart) => priceCart(cart.items, cart.coupon),
    createOrder,
    captureOrder,
    getOrder,
    inventory: () => ({ ...stock }),
    reset: resetDb,
  })
);

app.listen(PORT, () => {
  console.log(`🛒 PayQA Demo Store on http://localhost:${PORT}`);
  console.log(`   Buggy mode: ${BUGGY ? 'ON (4 planted bugs)' : 'OFF (fixed store)'}`);
  console.log(`   PayQA adapter: /payqa`);
});

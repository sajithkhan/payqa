// PayQA Adapter: lets PayQA test your PayPal checkout on a staging/sandbox store.
//
// Drop this file into your Express app, mount it, and wire it to your own checkout functions:
//
//   import { payqaAdapter, payqaPayPalHeaders } from './payqa-adapter.mjs';
//
//   app.use('/payqa', payqaAdapter({
//     enabled: process.env.PAYQA_ENABLED === 'true',
//     token: process.env.PAYQA_TOKEN,                 // optional shared secret
//     paypalBaseUrl: process.env.PAYPAL_BASE_URL,     // must be the sandbox
//     testCoupon: 'SAVE10',                           // optional: a coupon PayQA can use
//     products:     async () => [{ id, name, price }],
//     priceCart:    async (cart) => ({ subtotal, discount, total }),
//     createOrder:  async (cart) => ({ status, body: { id } }),        // your create-order logic
//     captureOrder: async (orderId) => ({ status, body }),            // your capture logic, as the customer sees it
//     getOrder:     async (orderId) => ({ status: 'PAID' | ..., paymentsRecorded }),
//     inventory:    async () => ({ [productId]: quantity }),           // optional
//     reset:        async () => {},                                    // optional: restore test data
//   }));
//
// Then add ONE line to wherever your code calls PayPal's REST API:
//
//   headers: { Authorization: ..., 'Content-Type': 'application/json', ...payqaPayPalHeaders() }
//
// During a PayQA test, that adds PayPal's sandbox negative-testing header, so PayPal itself
// declines or fails the call and your real error handling gets exercised.
// Outside PayQA tests it adds nothing.
//
// Requires: Node 18+, Express 4/5.

import express from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';

export const PAYQA_ADAPTER_VERSION = '1.0';

const testContext = new AsyncLocalStorage();

/** Headers to add to your PayPal REST calls. Empty unless PayQA is running a failure test. */
export function payqaPayPalHeaders() {
  const mockCode = testContext.getStore()?.mockCode;
  return mockCode ? { 'PayPal-Mock-Response': JSON.stringify({ mock_application_codes: mockCode }) } : {};
}

const REQUIRED = ['products', 'priceCart', 'createOrder', 'captureOrder', 'getOrder'];
const SAFE_MOCK = /^[A-Z_]{3,60}$/;

export function payqaAdapter(options = {}) {
  const router = express.Router();
  router.use(express.json());

  const missing = REQUIRED.filter((k) => typeof options[k] !== 'function');
  if (missing.length) throw new Error(`PayQA adapter: missing functions: ${missing.join(', ')}`);

  // sandbox, or a local fake PayPal used in automated tests
  const isSandbox =
    !options.paypalBaseUrl || /sandbox\.paypal\.com|^https?:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(options.paypalBaseUrl);
  const active = Boolean(options.enabled) && isSandbox;

  if (options.enabled && !isSandbox) {
    console.warn('⚠️  PayQA adapter disabled: PAYPAL_BASE_URL is not the PayPal sandbox. Never test against live payments.');
  }

  // Gate: off unless enabled, sandbox only, optional token
  router.use((req, res, next) => {
    if (!active) return res.status(404).json({ error: 'PayQA adapter is not enabled on this store' });
    if (options.token && req.get('x-payqa-token') !== options.token) {
      return res.status(401).json({ error: 'Invalid or missing PayQA token' });
    }
    next();
  });

  // Run a store function inside the PayQA test context (so payqaPayPalHeaders() can see the mock code)
  const handle = (fn) => async (req, res) => {
    const raw = req.get('x-payqa-mock');
    const mockCode = raw && SAFE_MOCK.test(raw) ? raw : null;
    try {
      const out = await testContext.run({ mockCode }, () => fn(req));
      res.status(out?.httpStatus || 200).json(out?.json ?? out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };

  router.get('/health', handle(async () => ({
    ok: true,
    adapter: PAYQA_ADAPTER_VERSION,
    capabilities: {
      inventory: typeof options.inventory === 'function',
      reset: typeof options.reset === 'function',
      testCoupon: options.testCoupon || null,
    },
  })));

  router.get('/products', handle(() => options.products()));

  router.post('/cart/price', handle(async (req) => {
    try {
      return await options.priceCart(req.body);
    } catch (err) {
      return { httpStatus: 400, json: { error: err.message } };
    }
  }));

  // createOrder / captureOrder return { status, body }: the HTTP status and body your
  // customer-facing endpoint would send. PayQA judges what the customer would see.
  router.post('/orders', handle(async (req) => {
    const r = await options.createOrder(req.body);
    return { httpStatus: r.status || 200, json: r.body };
  }));

  router.post('/orders/:id/capture', handle(async (req) => {
    const r = await options.captureOrder(req.params.id);
    return { httpStatus: r.status || 200, json: r.body };
  }));

  router.get('/orders/:id', handle(async (req) => {
    const order = await options.getOrder(req.params.id);
    return order ? order : { httpStatus: 404, json: { error: 'Order not found' } };
  }));

  router.get('/inventory', handle(async () =>
    options.inventory ? options.inventory() : { httpStatus: 404, json: { error: 'Inventory not provided' } }
  ));

  router.post('/reset', handle(async () => {
    if (options.reset) await options.reset();
    return { ok: true, reset: Boolean(options.reset) };
  }));

  return router;
}

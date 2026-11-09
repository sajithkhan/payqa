# PayQA Adapter

Connect your store to PayQA in about 15 minutes, so PayQA can test your PayPal checkout before you go live.

The adapter is one file, `payqa-adapter.mjs`, for **Node.js + Express** stores that call PayPal's Orders API from their own backend.

> Use it on **staging or local** only, with the **PayPal sandbox**. The adapter refuses to start if your PayPal URL is the live API.

## How it works

1. You mount the adapter at `/payqa` and point it at your own checkout functions.
2. PayQA calls `/payqa/...` to create orders, capture payments and read the result.
3. For failure tests, PayQA asks the adapter to make PayPal fail (for example "card declined"). Your PayPal calls pick this up through one helper, `payqaPayPalHeaders()`, and PayPal's sandbox returns the error.
4. PayQA checks what **your real code** did: what the customer was told, whether the order was marked paid, whether stock changed. It compares that with what PayPal says actually happened.

Your checkout code isn't mocked or replaced. PayQA tests the code you'll ship.

## Setup

### 1. Copy the file

Copy `payqa-adapter.mjs` into your project.

### 2. Add one line to your PayPal calls

Wherever your backend calls the PayPal REST API, add the PayQA headers:

```js
import { payqaPayPalHeaders } from './payqa-adapter.mjs';

const res = await fetch(`${PAYPAL_BASE_URL}/v2/checkout/orders/${id}/capture`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...payqaPayPalHeaders(), // ← add this
  },
});
```

Outside a PayQA test this adds nothing, so it's safe to leave in.

### 3. Mount the adapter

```js
import { payqaAdapter } from './payqa-adapter.mjs';

app.use('/payqa', payqaAdapter({
  enabled: process.env.PAYQA_ENABLED === 'true',
  token: process.env.PAYQA_TOKEN,            // recommended on shared staging servers
  paypalBaseUrl: process.env.PAYPAL_BASE_URL, // must be https://api-m.sandbox.paypal.com
  testCoupon: 'SAVE10',                       // optional

  products:     async () => [{ id: 'sku-1', name: 'Mug', price: 12.5 }],
  priceCart:    async ({ items, coupon }) => ({ subtotal, discount, total }),
  createOrder:  async ({ items, coupon }) => ({ status: 201, body: { id: paypalOrderId } }),
  captureOrder: async (orderId) => ({ status: 200, body: { ok: true, message: 'Payment successful!' } }),
  getOrder:     async (orderId) => ({ status: 'PAID', paymentsRecorded: 1 }),
  inventory:    async () => ({ 'sku-1': 20 }),  // optional
  reset:        async () => {},                 // optional
}));
```

### 4. Run PayQA

Open the PayQA dashboard, enter your store's URL (for example `https://staging.mystore.com`), add the token if you set one, and press **Run tests**.

## What each function should do

| Function | Required | Should return |
|---|---|---|
| `products()` | Yes | The products PayQA can put in a cart: `[{ id, name, price }]`. Use cheap test items. |
| `priceCart({ items, coupon })` | Yes | What the customer sees: `{ subtotal, discount, total }`. Throw for an invalid cart. |
| `createOrder({ items, coupon })` | Yes | `{ status, body }` from your create-order logic. `body.id` must be the PayPal order id. |
| `captureOrder(orderId)` | Yes | `{ status, body }`: exactly what your capture endpoint sends the customer. PayQA reads `body.ok` and `body.message`. |
| `getOrder(orderId)` | Yes | Your record of the order: `{ status, paymentsRecorded }`. Use `status: 'PAID'` for paid orders. |
| `inventory()` | No | Stock per product id: `{ [id]: quantity }`. Enables the stock checks. |
| `reset()` | No | Restore test data between scenarios (clear test orders, refill stock). |

`items` is always `[{ productId, qty }]`. Map it to your own cart format inside these functions.

If you skip an optional function, PayQA skips the checks that need it and says so in the report.

## Safety

- **Off by default.** Nothing is exposed unless `enabled` is true.
- **Sandbox only.** If `paypalBaseUrl` isn't the PayPal sandbox, the adapter stays off and logs a warning.
- **Token.** Set `token` and PayQA must send the same value. Without it, every `/payqa` request is rejected.
- **Separate from your customer API.** Test endpoints like `reset` and `inventory` live only under `/payqa`.

## Current limits

- **Node.js + Express only.** Adapters for other stacks (PHP, Python, Java) and for platforms like WooCommerce are planned.
- **Browser Mode** drives the shop's web pages, so for now it only knows the demo store's page layout. Chaos Mode works with any store that has the adapter.

# Minimal Store (example)

A second store connected to PayQA through the [PayQA Adapter](../../adapter/README.md). It exists to show that PayQA isn't tied to the demo store.

It differs from the demo store on purpose:

| | Demo store | Minimal store |
|---|---|---|
| Products | `p1`, `p2`, `p3` in dollars | `MUG-01`, `TEE-02` in cents |
| Coupons | `SAVE10` | none |
| Stock tracking | yes | none |
| PayQA token | not required | required |
| Checkout logic | 4 planted bugs | correct |
| Web page | yes | API only |

Because it has no coupons or stock, PayQA **skips** the coupon test and the stock checks and says why in the report. Because its checkout logic is correct, PayQA clears it for go-live.

## Run it

From the repo root (it uses the same PayPal sandbox keys in `.env`):

```bash
node examples/minimal-store/server.mjs
```

Then test it from the PayQA dashboard:

- **Store to test:** `http://localhost:4100`
- **Store needs an access token?** → `minimal-store-token`
- **What to run:** Chaos

Or from the terminal:

```powershell
$env:PAYQA_STORE_TOKEN="minimal-store-token"; node server/cli.mjs chaos http://localhost:4100
```

Browser Mode isn't available for this store, because it has no web page.

## What to look at in the code

`server.mjs` is about 150 lines. The parts that matter for PayQA:

- `payqaPayPalHeaders()` added to the PayPal client's headers: the one line that lets PayQA make PayPal decline or fail calls.
- `app.use('/payqa', payqaAdapter({...}))`: maps PayQA's calls onto the store's own `startCheckout` and `confirmPayment` functions. PayQA tests the store's real checkout code.
- `confirmPayment()` shows the correct pattern: idempotent, only a `COMPLETED` capture counts as paid, and a clear failure message for the customer.

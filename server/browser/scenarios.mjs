// Browser Mode scenarios: drive the store like a real customer, through the real PayPal popup,
// then verify the result against the store's data and PayPal's API (source of truth).

import { paypalFetch } from '../lib/paypal.mjs';
import { openPayPalPopup, loginToPayPal, completePurchase, readPopupAmount } from './paypalPopup.mjs';

const money = (text) => Number(String(text).replace(/[^0-9.]/g, ''));

function check(id, title, passed, { severity, bug, expected, actual }) {
  return { id, title, passed: Boolean(passed), severity, bug, expected, actual };
}

async function paypalOrder(orderId) {
  if (!orderId) return null;
  const r = await paypalFetch(`/v2/checkout/orders/${orderId}`);
  return r.ok ? r.data : null;
}

async function stockShown(page, productId) {
  const text = await page.getByTestId(`stock-${productId}`).textContent();
  return parseInt(text, 10);
}

async function addToCart(page, productId, times = 1) {
  for (let i = 0; i < times; i++) await page.getByTestId(`add-${productId}`).click();
  await page.getByTestId('total').waitFor({ state: 'visible' });
}

async function shot(page, ctx, name) {
  if (!ctx.screenshotDir) return null;
  const file = `${ctx.runId || 'cli'}-${name}.png`;
  await page.screenshot({ path: `${ctx.screenshotDir}/${file}`, fullPage: true }).catch(() => {});
  return file;
}

export const SCENARIOS = [
  {
    id: 'browser-checkout',
    title: 'Customer completes a PayPal checkout',
    category: 'Customer journey',
    description: 'Add an item, pay through the real PayPal popup with the sandbox buyer, and confirm the order end to end.',
    async run(ctx) {
      const { page, store, buyer } = ctx;
      await store.reset();
      await page.goto(store.baseUrl);
      await page.getByTestId('products').waitFor();

      const stockBefore = await stockShown(page, 'p3');
      await addToCart(page, 'p3');
      const cartTotal = money(await page.getByTestId('total').textContent());

      const { popup, orderId } = await openPayPalPopup(page);
      ctx.popup = popup; // lets the runner screenshot PayPal's page if a step fails
      await loginToPayPal(popup, buyer.email, buyer.password);
      const popupAmount = await readPopupAmount(popup);
      // start listening before clicking, so a fast close isn't missed
      const closed = popup.waitForEvent('close', { timeout: 90_000 }).catch(() => {});
      await completePurchase(popup);
      if (!popup.isClosed()) await closed;

      const result = page.getByTestId('checkout-result');
      await result.waitFor({ state: 'visible', timeout: 60_000 });
      const message = (await result.textContent()).trim();
      await page.waitForTimeout(1_000); // let the product list refresh
      const stockAfter = await stockShown(page, 'p3');
      const screenshot = await shot(page, ctx, 'checkout');

      const pp = await paypalOrder(orderId);
      const storeOrder = orderId ? await store.getOrder(orderId) : null;

      const checks = [
        check('success-shown', 'Customer sees a success message', /success/i.test(message), {
          severity: 'critical',
          bug: 'checkout-broken',
          expected: 'A success message after paying',
          actual: `"${message}"`,
        }),
        check('paypal-completed', 'PayPal confirms the payment was captured', pp?.status === 'COMPLETED', {
          severity: 'critical',
          bug: 'checkout-broken',
          expected: 'PayPal order status COMPLETED',
          actual: `PayPal order status ${pp?.status || 'unknown'}`,
        }),
        check('store-paid', 'Store records the order as PAID', storeOrder?.status === 'PAID', {
          severity: 'high',
          bug: 'checkout-broken',
          expected: 'Store order status PAID',
          actual: `Store order status ${storeOrder?.status || 'unknown'}`,
        }),
        check('stock-updated', 'Stock shown to customers drops by 1', stockBefore - stockAfter === 1, {
          severity: 'medium',
          bug: 'inventory',
          expected: `Stock ${stockBefore} → ${stockBefore - 1}`,
          actual: `Stock ${stockBefore} → ${stockAfter}`,
        }),
      ];
      return { checks, evidence: { orderId, cartTotal, popupAmount, message, screenshot } };
    },
  },
  {
    id: 'browser-coupon-amount',
    title: 'PayPal shows the same total the customer saw',
    category: 'Amount integrity',
    description: 'Apply coupon SAVE10 in the cart, open PayPal, and compare the on-screen total with the amount PayPal will charge.',
    async run(ctx) {
      const { page, store } = ctx;
      await store.reset();
      await page.goto(store.baseUrl);
      await page.getByTestId('products').waitFor();

      await addToCart(page, 'p1', 2);
      await addToCart(page, 'p3');
      await page.getByTestId('coupon-input').fill('SAVE10');
      await page.getByTestId('apply-coupon').click();
      await page.getByTestId('discount').waitFor({ state: 'visible' });
      const cartTotal = money(await page.getByTestId('total').textContent());
      const screenshot = await shot(page, ctx, 'coupon-cart');

      const { popup, orderId } = await openPayPalPopup(page);
      ctx.popup = popup; // lets the runner screenshot PayPal's page if a step fails
      const pp = await paypalOrder(orderId);
      const charged = Number(pp?.purchase_units?.[0]?.amount?.value);
      await popup.close().catch(() => {});

      const diff = Math.round((charged - cartTotal) * 100) / 100;
      const checks = [
        check('amount-matches-screen', 'PayPal amount matches the total on screen', Math.abs(diff) < 0.01, {
          severity: 'critical',
          bug: 'amount-mismatch',
          expected: `$${cartTotal.toFixed(2)} (total shown in the cart after SAVE10)`,
          actual: `PayPal will charge $${charged.toFixed(2)} (${diff > 0 ? 'overcharged' : 'off'} by $${Math.abs(diff).toFixed(2)})`,
        }),
      ];
      return { checks, evidence: { orderId, cartTotal, paypalAmount: charged, screenshot } };
    },
  },
  {
    id: 'browser-cancel',
    title: 'Customer cancels in the PayPal popup',
    category: 'Customer journey',
    description: 'The customer closes the PayPal window. The store must not show success, take stock, or mark the order paid.',
    async run(ctx) {
      const { page, store } = ctx;
      await store.reset();
      await page.goto(store.baseUrl);
      await page.getByTestId('products').waitFor();

      const stockBefore = await stockShown(page, 'p2');
      await addToCart(page, 'p2');

      const { popup, orderId } = await openPayPalPopup(page);
      ctx.popup = popup; // lets the runner screenshot PayPal's page if a step fails
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await popup.close();

      const result = page.getByTestId('checkout-result');
      await result.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
      const message = ((await result.textContent().catch(() => '')) || '').trim();
      const stockAfter = await stockShown(page, 'p2');
      const storeOrder = orderId ? await store.getOrder(orderId) : null;
      const screenshot = await shot(page, ctx, 'cancel');

      const checks = [
        check('no-success-on-cancel', 'No success message after cancelling', !/success/i.test(message), {
          severity: 'critical',
          bug: 'false-success',
          expected: 'A cancelled message (or no message)',
          actual: message ? `"${message}"` : 'No message shown',
        }),
        check('cancel-not-paid', 'Cancelled order is not marked PAID', storeOrder?.status !== 'PAID', {
          severity: 'critical',
          bug: 'paid-before-capture',
          expected: 'Store order not PAID',
          actual: `Store order status ${storeOrder?.status || 'none'}`,
        }),
        check('cancel-stock', 'Stock unchanged after cancelling', stockAfter === stockBefore, {
          severity: 'high',
          bug: 'inventory',
          expected: `Stock stays at ${stockBefore}`,
          actual: `Stock ${stockBefore} → ${stockAfter}`,
        }),
      ];
      return { checks, evidence: { orderId, message, screenshot } };
    },
  },
];

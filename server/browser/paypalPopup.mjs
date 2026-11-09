// Helpers for driving the PayPal button and sandbox popup with Playwright.
// PayPal changes its sandbox UI from time to time, so each step tries a few selectors.

const LONG = 60_000;

// Click the yellow PayPal button (it lives inside an iframe) and catch the popup.
// Also captures the PayPal order id from the store's POST /api/orders response.
export async function openPayPalPopup(page) {
  const orderResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/orders') && r.request().method() === 'POST',
    { timeout: LONG }
  );

  const button = page
    .frameLocator('#paypal-button-container iframe')
    .first()
    .locator('[data-funding-source="paypal"]')
    .first();
  await button.waitFor({ state: 'visible', timeout: LONG });

  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: LONG }), button.click()]);

  const res = await orderResponse;
  const body = await res.json().catch(() => ({}));
  return { popup, orderId: body.id || null, createOrderStatus: res.status() };
}

async function visible(locator, timeout = 3_000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

// Log in with the sandbox buyer account
export async function loginToPayPal(popup, email, password) {
  await popup.waitForLoadState('domcontentloaded');

  // Optional cookie banner
  const accept = popup.locator('#acceptAllButton, button:has-text("Accept")');
  if (await visible(accept, 4_000)) await accept.first().click().catch(() => {});

  const emailInput = popup.locator('#email, input[name="login_email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: LONG });
  await emailInput.fill(email);

  const next = popup.locator('#btnNext, button:has-text("Next")');
  if (await visible(next)) await next.first().click();

  const passwordInput = popup.locator('#password, input[name="login_password"]').first();
  await passwordInput.waitFor({ state: 'visible', timeout: LONG });
  await passwordInput.fill(password);

  await popup.locator('#btnLogin, button:has-text("Log In")').first().click();
}

// Read the amount PayPal shows on the review page (best effort, for evidence only)
export async function readPopupAmount(popup) {
  const text = await popup.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  const m = text.match(/\$\s?(\d+(?:\.\d{2}))/);
  return m ? Number(m[1]) : null;
}

// Click "Complete Purchase" (or whatever PayPal calls it today)
export async function completePurchase(popup) {
  const button = popup
    .locator('#payment-submit-btn, [data-testid="submit-button-initial"]')
    .or(popup.getByRole('button', { name: /complete purchase|pay now|continue to review|agree.*pay/i }))
    .first();
  await button.waitFor({ state: 'visible', timeout: LONG });
  await button.click();
}

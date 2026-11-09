// Helpers for driving the PayPal button and sandbox popup with Playwright.
// PayPal's sandbox serves slightly different page layouts and keeps hidden copies of some
// buttons, so every step only targets VISIBLE elements and prefers keyboard actions
// (pressing Enter) the way a real customer would.

const LONG = 60_000;

// Run a step and, if it fails, say which step it was
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    throw new Error(`${name}: ${err.message.split('\n')[0]}`);
  }
}

async function isVisible(locator, timeout = 3_000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

// Click the yellow PayPal button (it lives inside an iframe) and catch the popup.
// Also captures the PayPal order id from the store's POST /api/orders response.
export async function openPayPalPopup(page) {
  return step('Opening the PayPal popup', async () => {
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
  });
}

// Log in with the sandbox buyer account
export async function loginToPayPal(popup, email, password) {
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  // Optional cookie banner
  const accept = popup.locator('#acceptAllButton:visible, button:has-text("Accept"):visible');
  if (await isVisible(accept, 4_000)) await accept.first().click().catch(() => {});

  const emailInput = popup.locator('#email:visible, input[name="login_email"]:visible').first();
  const passwordInput = popup.locator('#password:visible, input[name="login_password"]:visible').first();

  const nextButton = popup.locator('#btnNext:visible, button:has-text("Next"):visible').first();
  const loginButton = popup
    .locator('#btnLogin:visible, button:has-text("Log In"):visible, button[type="submit"]:visible')
    .first();

  await step('PayPal login: email step', async () => {
    await emailInput.waitFor({ state: 'visible', timeout: LONG });
    await emailInput.fill(email);
    // Some layouts show email and password together; others ask for email first
    if (await isVisible(passwordInput, 1_500)) return;
    await emailInput.press('Enter');
    // If Enter didn't move the page on, click the visible Next button
    if (!(await isVisible(passwordInput, 5_000)) && (await isVisible(nextButton, 1_000))) {
      await nextButton.click();
    }
  });

  await step('PayPal login: password step', async () => {
    await passwordInput.waitFor({ state: 'visible', timeout: LONG });
    await passwordInput.fill(password);
    await passwordInput.press('Enter');
    // If Enter didn't submit (some layouts have no submit button), click Log In
    const stillOnLogin = await passwordInput
      .waitFor({ state: 'hidden', timeout: 5_000 })
      .then(() => false)
      .catch(() => true);
    if (stillOnLogin && (await isVisible(loginButton, 1_000))) await loginButton.click();
  });
}

// Read the amount PayPal shows on the review page (best effort, for evidence only)
export async function readPopupAmount(popup) {
  const text = await popup.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
  const m = text.match(/\$\s?(\d+(?:\.\d{2}))/);
  return m ? Number(m[1]) : null;
}

// Click "Complete Purchase" (or whatever PayPal calls it today)
export async function completePurchase(popup) {
  await step('PayPal review page: Complete Purchase', async () => {
    const button = popup
      .locator('#payment-submit-btn:visible, [data-testid="submit-button-initial"]:visible')
      .or(popup.getByRole('button', { name: /complete purchase|pay now|continue to review|agree.*pay/i }).filter({ visible: true }))
      .first();
    await button.waitFor({ state: 'visible', timeout: LONG });
    await button.click();
  });
}

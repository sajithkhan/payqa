// Talks to the store under test through the PayQA store adapter API.
// Never throws on HTTP errors: returns { status, ok, body } so checks can inspect them.

export function createStoreClient(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, ok: res.ok, body: data };
  }

  return {
    baseUrl: base,
    reset: () => call('/api/test/reset', { method: 'POST' }),
    inventory: async () => (await call('/api/inventory')).body,
    priceCart: (cart) => call('/api/cart/price', { method: 'POST', body: cart }),
    createOrder: (cart) => call('/api/orders', { method: 'POST', body: cart }),
    capture: (orderId, mockCode) =>
      call(`/api/orders/${orderId}/capture`, {
        method: 'POST',
        headers: mockCode ? { 'x-payqa-mock': mockCode } : {},
      }),
    getOrder: async (orderId) => (await call(`/api/orders/${orderId}`)).body,
  };
}

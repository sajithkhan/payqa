// Talks to the store under test through the PayQA Adapter (mounted at <store>/payqa).
// Never throws on HTTP errors: returns { status, ok, body } so checks can inspect them.

export function createStoreClient(baseUrl, { token, timeoutMs = 45_000 } = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const api = `${base}/payqa`;

  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'x-payqa-token': token } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
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
    health: () => call('/health'),
    products: async () => (await call('/products')).body,
    reset: () => call('/reset', { method: 'POST' }),
    inventory: async () => {
      const r = await call('/inventory');
      return r.ok ? r.body : null;
    },
    priceCart: (cart) => call('/cart/price', { method: 'POST', body: cart }),
    createOrder: (cart) => call('/orders', { method: 'POST', body: cart }),
    capture: (orderId, mockCode) =>
      call(`/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: mockCode ? { 'x-payqa-mock': mockCode } : {},
      }),
    getOrder: async (orderId) => {
      const r = await call(`/orders/${encodeURIComponent(orderId)}`);
      return r.ok ? r.body : null;
    },
  };
}

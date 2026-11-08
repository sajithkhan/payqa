// Front end for the PayQA Demo Store
const cart = {}; // productId -> qty
let couponCode = '';
let products = [];

const $ = (id) => document.getElementById(id);
const usd = (n) => `$${Number(n).toFixed(2)}`;

function cartItems() {
  return Object.entries(cart).map(([productId, qty]) => ({ productId, qty }));
}

async function loadProducts() {
  products = await fetch('/api/products').then((r) => r.json());
  $('products').innerHTML = products
    .map(
      (p) => `
      <div class="card" data-testid="product-${p.id}">
        <div class="emoji">${p.emoji}</div>
        <h3>${p.name}</h3>
        <div class="price">${usd(p.price)}</div>
        <div class="stock" data-testid="stock-${p.id}">${p.stock} in stock</div>
        <button class="add" data-testid="add-${p.id}" onclick="addToCart('${p.id}')">Add to cart</button>
      </div>`
    )
    .join('');
}

window.addToCart = (id) => {
  cart[id] = (cart[id] || 0) + 1;
  renderCart();
};

async function renderCart() {
  const items = cartItems();
  if (items.length === 0) {
    $('cart-lines').innerHTML = '<p class="empty">Cart is empty</p>';
    $('totals').innerHTML = '';
    return;
  }

  const priced = await fetch('/api/cart/price', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, coupon: couponCode }),
  }).then((r) => r.json());

  $('cart-lines').innerHTML = priced.lines
    .map((l) => `<div class="line"><span>${l.name} × ${l.qty}</span><span>${usd(l.price * l.qty)}</span></div>`)
    .join('');

  $('totals').innerHTML = `
    <div class="line"><span>Subtotal</span><span data-testid="subtotal">${usd(priced.subtotal)}</span></div>
    ${priced.discount ? `<div class="line"><span>Discount (${priced.coupon})</span><span data-testid="discount">-${usd(priced.discount)}</span></div>` : ''}
    <div class="line total"><span>Total</span><span data-testid="total">${usd(priced.total)}</span></div>`;
}

$('apply-coupon').addEventListener('click', () => {
  couponCode = $('coupon').value.trim();
  renderCart();
});

function showResult(ok, message) {
  const el = $('result');
  el.className = ok ? 'success' : 'error';
  el.textContent = message;
}

function loadPayPalSdk(clientId) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD`;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function init() {
  const config = await fetch('/api/config').then((r) => r.json());
  const badge = $('mode-badge');
  badge.textContent = config.buggyMode ? 'Buggy mode' : 'Fixed mode';
  if (!config.buggyMode) badge.classList.add('fixed');

  await loadProducts();

  try {
    await loadPayPalSdk(config.clientId);
  } catch {
    showResult(false, 'Could not load PayPal. Check your internet connection.');
    return;
  }

  paypal
    .Buttons({
      createOrder: async () => {
        const res = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: cartItems(), coupon: couponCode }),
        });
        const data = await res.json();
        if (!res.ok) {
          showResult(false, data.error || 'Could not start checkout');
          throw new Error(data.error);
        }
        return data.id;
      },
      onApprove: async ({ orderID }) => {
        const res = await fetch(`/api/orders/${orderID}/capture`, { method: 'POST' });
        const data = await res.json();
        showResult(data.ok, data.message);
        if (data.ok) {
          Object.keys(cart).forEach((k) => delete cart[k]);
          renderCart();
          loadProducts();
        }
      },
      onCancel: () => showResult(false, 'Payment cancelled.'),
      onError: () => showResult(false, 'Something went wrong with PayPal.'),
    })
    .render('#paypal-button-container');
}

init();

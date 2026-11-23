// Fixture behaviour: cart in localStorage, client-side search/sort, contact-form validation. No network calls.
(function () {
  const CART = 'fixture-cart';
  const read = () => { try { return JSON.parse(localStorage.getItem(CART) || '[]'); } catch { return []; } };
  const write = (items) => localStorage.setItem(CART, JSON.stringify(items));
  const money = (n) => '$' + n.toFixed(2);

  document.querySelectorAll('.add-to-cart').forEach((btn) => btn.addEventListener('click', () => {
    const qty = Number(document.getElementById('qty').value);
    const msg = document.querySelector('.cart-message');
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) { msg.textContent = 'Quantity must be between 1 and 10.'; msg.className = 'cart-message error'; return; }
    const items = read();
    const found = items.find((i) => i.sku === btn.dataset.sku);
    if (found) found.qty = Math.min(10, found.qty + qty); else items.push({ sku: btn.dataset.sku, name: btn.dataset.name, price: Number(btn.dataset.price), qty });
    write(items); msg.className = 'cart-message'; msg.textContent = 'Added ' + qty + ' x ' + btn.dataset.name + ' to your cart.';
  }));

  const table = document.querySelector('#cart-table tbody');
  let discount = 0;
  function renderCart() {
    if (!table) return;
    const items = read(); table.innerHTML = '';
    let total = 0;
    items.forEach((i) => {
      total += i.price * i.qty;
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td><td><button type="button">Remove</button></td>';
      tr.children[0].textContent = i.name; tr.children[1].textContent = i.qty; tr.children[2].textContent = money(i.price * i.qty);
      tr.querySelector('button').addEventListener('click', () => { write(read().filter((x) => x.sku !== i.sku)); renderCart(); });
      table.appendChild(tr);
    });
    document.getElementById('cart-empty').hidden = items.length > 0;
    document.getElementById('cart-total').textContent = money(total * (1 - discount));
  }
  const apply = document.getElementById('apply-promo');
  if (apply) apply.addEventListener('click', () => {
    const code = document.getElementById('promo').value.trim().toUpperCase();
    const out = document.getElementById('promo-message');
    if (code === 'TEA10') { discount = 0.1; out.textContent = '10% discount applied.'; } else { discount = 0; out.textContent = 'That promo code is not valid.'; }
    renderCart();
  });
  renderCart();

  const list = document.getElementById('product-list');
  if (list) {
    const q = (new URLSearchParams(location.search).get('q') || '').trim().toLowerCase();
    const rows = Array.from(list.children);
    let shown = 0;
    rows.forEach((li) => { const hit = !q || li.dataset.name.toLowerCase().includes(q) || li.dataset.kind.includes(q); li.hidden = !hit; if (hit) shown++; });
    document.getElementById('no-results').hidden = shown > 0;
    if (q) document.getElementById('filter-status').textContent = 'Showing ' + shown + ' result(s) for "' + q + '".';
    document.getElementById('sort').addEventListener('change', (e) => {
      const v = e.target.value;
      rows.sort((a, b) => v === 'name' ? a.dataset.name.localeCompare(b.dataset.name) : (v === 'price-asc' ? 1 : -1) * (a.dataset.price - b.dataset.price));
      rows.forEach((r) => list.appendChild(r));
    });
  }

  const form = document.getElementById('contact-form');
  if (form) form.addEventListener('submit', (e) => {
    e.preventDefault();
    const errs = [];
    if (!form.name.value.trim()) errs.push('Name is required.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.value)) errs.push('Enter a valid email address.');
    if (!form.topic.value) errs.push('Choose a topic.');
    if (form.message.value.trim().length < 10) errs.push('Message must be at least 10 characters.');
    const ul = document.getElementById('form-errors'); ul.innerHTML = '';
    errs.forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
    document.getElementById('form-success').hidden = errs.length > 0;
    if (!errs.length) form.reset();
  });
})();

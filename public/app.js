const DEFAULT_WHATSAPP_NUMBER = '917888329606';
const readList = (key) => {
  try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; }
  catch { return []; }
};
const variantKey = (item) => `${item.id}|${item.size || ''}|${item.color || ''}`;
const state = {
  products: [], filter: 'All', query: '', sort: 'featured', savedOnly: false,
  favorites: new Set(readList('apria-favorites')),
  quote: readList('apria-quote').map((item) => ({ ...item, key: item.key || variantKey(item) })),
  cart: readList('apria-cart').filter((item) => item && typeof item === 'object').map((item) => ({ ...item, key: item.key || variantKey(item) })),
  payment: { enabled: false, keyId: '', currency: 'INR', deliveryPaise: 0 }, checkoutBusy: false
};
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function toast(message) {
  const el = $('#toast'); el.textContent = message; el.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}
function saveQuote() {
  localStorage.setItem('apria-quote', JSON.stringify(state.quote));
  $('#quote-count').textContent = state.quote.reduce((total, item) => total + item.quantity, 0);
  renderQuote();
}
const money = (rupees) => `₹${Number(rupees || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
function saveCart() {
  state.cart = state.cart.filter((item) => {
    const product = state.products.find((entry) => entry.id === item.id);
    return product && getSizes(product.sizes).includes(item.size) && getColors(product.color).includes(item.color);
  }).slice(0, 20).map((item) => ({ ...item, quantity: Math.max(1, Math.min(100, Number.parseInt(item.quantity, 10) || 1)), key: variantKey(item) }));
  localStorage.setItem('apria-cart', JSON.stringify(state.cart)); renderCart();
}
function addToCart(id, variant = {}) {
  const product = state.products.find((item) => item.id === id); if (!product) return;
  const available = variantAvailability(product, variant.size, variant.color);
  if (available < 1) { toast('This size and colour is currently out of stock.'); return; }
  const quantity = Math.max(1, Math.min(available, 100, Number.parseInt(variant.quantity, 10) || 1));
  const entry = { id, size: variant.size || '', color: variant.color || '', quantity };
  entry.key = variantKey(entry);
  const existing = state.cart.find((item) => item.key === entry.key);
  if (!existing && state.cart.length >= 20) { toast('Your bag can hold up to 20 garment options.'); return; }
  if (existing && existing.quantity + quantity > available) { toast(`Only ${available} are available in this option.`); return; }
  if (existing) existing.quantity = Math.min(100, existing.quantity + quantity); else state.cart.push(entry);
  saveCart(); toast(`${product.name} added to your shopping bag.`);
}
function renderCart() {
  const host = $('#cart-items'); if (!host) return;
  const count = state.cart.reduce((total, item) => total + item.quantity, 0);
  $('#cart-count').textContent = count;
  const subtotal = state.cart.reduce((sum, item) => {
    const product = state.products.find((entry) => entry.id === item.id);
    return sum + (product ? Number(product.price) * item.quantity : 0);
  }, 0);
  const delivery = Number(state.payment.deliveryPaise || 0) / 100;
  $('#cart-subtotal').textContent = money(subtotal); $('#cart-delivery').textContent = delivery ? money(delivery) : 'Free';
  $('#cart-total').textContent = money(subtotal + delivery);
  $('#cart-delivery-total').textContent = money(subtotal + delivery);
  host.innerHTML = state.cart.length ? state.cart.map((item) => {
    const product = state.products.find((entry) => entry.id === item.id); if (!product) return '';
    const available = variantAvailability(product, item.size, item.color);
    return `<article class="cart-item"><img src="${esc(product.image)}" alt=""><div><div class="cart-item-title">${esc(product.name)}</div><div class="cart-item-meta">${esc(item.color)} · Size ${esc(item.size)}${available < item.quantity ? ' · stock changed, please edit' : ''}</div><div class="cart-item-controls"><input type="number" min="1" max="100" value="${item.quantity}" aria-label="Quantity for ${esc(product.name)}" data-cart-quantity="${esc(item.key)}"><button type="button" data-cart-remove="${esc(item.key)}">Remove</button></div></div><div class="cart-item-price">${money(Number(product.price) * item.quantity)}</div></article>`;
  }).join('') : '<div class="cart-empty"><b>Your bag is empty for now.</b><span>Take a look around and add something when you find the right fit.</span><button type="button" data-cart-close>Explore the collection ↗</button></div>';
  const button = $('#checkout-form [type="submit"]');
  if (button) {
    button.disabled = !state.cart.length || state.checkoutBusy;
    button.innerHTML = state.payment.enabled ? 'Continue to UPI payment <span aria-hidden="true">↗</span>' : 'Send order request <span aria-hidden="true">↗</span>';
  }
  const paymentNote = $('#checkout-payment-note');
  if (paymentNote) paymentNote.textContent = state.payment.enabled
    ? 'UPI payments are processed securely by Razorpay. APRIA never sees your UPI PIN.'
    : 'Online UPI is not enabled yet. Send an order request and APRIA can confirm availability and arrange payment. No payment is taken now.';
  const next = $('#checkout-next'); if (next) next.disabled = !state.cart.length;
}
function setCheckoutStep(step) {
  const delivery = step === 'delivery';
  $('#cart-step-bag').hidden = delivery; $('#cart-step-delivery').hidden = !delivery;
  document.querySelectorAll('[data-checkout-step]').forEach((item) => {
    const active = item.dataset.checkoutStep === step;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('#cart-dialog').scrollTop = 0;
  if ($('#cart-dialog').open) (delivery ? $('#checkout-title') : $('#checkout-next')).focus();
}
function getSizes(spec) {
  if (spec.includes('–')) {
    const [from, to] = spec.split('–').map((part) => part.trim());
    const alpha = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
    if (alpha.includes(from) && alpha.includes(to)) return alpha.slice(alpha.indexOf(from), alpha.indexOf(to) + 1);
    const first = Number(from), last = Number(to);
    if (Number.isFinite(first) && Number.isFinite(last) && last >= first && (last - first) / 2 < 30) {
      return Array.from({ length: Math.floor((last - first) / 2) + 1 }, (_, index) => String(first + index * 2));
    }
  }
  return spec.split('/').map((part) => part.trim()).filter(Boolean);
}
function getColors(spec) { return spec.split('/').map((part) => part.trim()).filter(Boolean); }
function variantAvailability(product, size, color) {
  const variant = product?.variants?.find((entry) => entry.size === size && entry.color === color);
  return Math.max(0, Number(variant?.available ?? 0));
}
function filteredProducts() {
  let result = state.products.filter((product) => {
    const categoryMatches = state.filter === 'All' || product.category === state.filter;
    const savedMatches = !state.savedOnly || state.favorites.has(product.id);
    const haystack = [product.name, product.category, product.color, product.fabric, product.gsm, product.description].join(' ').toLowerCase();
    return categoryMatches && savedMatches && haystack.includes(state.query.toLowerCase());
  });
  if (state.sort === 'price-low') result = result.sort((a, b) => a.price - b.price);
  if (state.sort === 'price-high') result = result.sort((a, b) => b.price - a.price);
  if (state.sort === 'name') result = result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}
function renderProducts() {
  const products = filteredProducts();
  $('#product-count').textContent = products.length;
  $('#favorites-count').textContent = state.favorites.size;
  $('#favorites-toggle').setAttribute('aria-pressed', String(state.savedOnly));
  $('#favorites-toggle').classList.toggle('active', state.savedOnly);
  $('#product-grid').innerHTML = products.map((product) => `
    <article class="product-card">
      <div class="product-image-wrap" data-product="${esc(product.id)}">
        <img class="product-image" src="${esc(product.image)}" alt="${esc(product.name)}" loading="lazy">
        <span class="product-tag">${esc(product.tag)}</span>
        <button class="favorite-button ${state.favorites.has(product.id) ? 'is-favorite' : ''}" data-favorite="${esc(product.id)}" aria-label="${state.favorites.has(product.id) ? 'Remove from' : 'Save to'} favourites" aria-pressed="${state.favorites.has(product.id)}">${state.favorites.has(product.id) ? '♥' : '♡'}</button>
        <button class="quick-add" data-options="${esc(product.id)}">Choose size <span>＋</span></button>
      </div>
      <div class="product-meta"><div><button type="button" class="product-name" data-product="${esc(product.id)}">${esc(product.name)}</button><div class="product-category">${esc(product.category)} · ${esc(product.color)}</div></div><div class="product-price">₹${Number(product.price).toLocaleString('en-IN')}</div></div>
      <div class="product-spec"><span>${esc(product.gsm)}</span><span>${esc(product.fabric)}</span></div>
    </article>`).join('') || `<div class="empty-results"><span>${state.savedOnly ? '♡' : '⌕'}</span><b>${state.savedOnly ? 'No saved garments yet' : 'No garments found'}</b><p>${state.savedOnly ? 'Tap the heart on a garment to keep it here.' : 'Try another search or clear a filter.'}</p><button class="text-button" data-clear-filters>Clear filters</button></div>`;
  renderPersonalEdit();
}
const weightEdits = {
  everyday: { min: 180, max: 240, label: 'THE EASY-LAYER EDIT', description: 'Lighter jerseys for warm days. A comfortable starting point for tees, polos, and easy everyday layers.' },
  structured: { min: 260, max: 300, label: 'THE MORE-SHAPE EDIT', description: 'A little more substance for a defined drape. Explore heavier tees, terry, and sturdy cotton bottoms.' },
  warm: { min: 320, max: 380, label: 'THE EXTRA-WARMTH EDIT', description: 'Brushed fleece for cooler days, with the comfort and weight of a proper layer.' }
};
function renderWeightProducts(kind = 'everyday') {
  const edit = weightEdits[kind] || weightEdits.everyday;
  $('#weight-description').textContent = edit.description;
  $('#weight-result-label').textContent = edit.label;
  const matches = state.products.filter((product) => {
    const gsm = Number.parseInt(String(product.gsm).match(/\d+/)?.[0] || '', 10);
    return Number.isFinite(gsm) && gsm >= edit.min && gsm <= edit.max;
  }).slice(0, 3);
  $('#weight-products').innerHTML = matches.length ? matches.map((product) => `
    <button type="button" class="weight-pick" data-product="${esc(product.id)}">
      <img src="${esc(product.image)}" alt="" loading="lazy">
      <span><b>${esc(product.name)}</b><small>${esc(product.gsm)} · ${esc(product.fabric)}</small></span>
      <span aria-hidden="true">↗</span>
    </button>`).join('') : '<p class="weight-empty">This weight is not in the current collection. Send us a note about what you have in mind.</p>';
}
function renderPersonalEdit() {
  const count = state.favorites.size, progress = Math.min(count, 3);
  const progressEl = $('#edit-progress'); progressEl.setAttribute('aria-label', `${progress} of 3 styles saved`); progressEl.setAttribute('aria-valuenow', String(progress));
  [...progressEl.querySelectorAll('span')].forEach((dot, index) => dot.classList.toggle('complete', index < progress));
  $('#edit-progress-label').textContent = `${progress} / 3 saved`;
  $('#edit-message').textContent = count === 0 ? 'Save the styles you like. We’ll suggest a few more, and keep your picks on this device.'
    : count === 1 ? 'One lovely pick. Save a couple more if you like—your edit will be here when you come back.'
      : count === 2 ? 'Your edit is taking shape. One more saved style makes it easy to compare your favourites.'
        : 'Your little edit is ready. We’ve picked a few more pieces that might feel like you.';
  const saved = state.products.filter((product) => state.favorites.has(product.id));
  const categories = new Set(saved.map((product) => product.category));
  let picks = count ? state.products.filter((product) => categories.has(product.category) && !state.favorites.has(product.id)) : state.products.filter((product) => ['BESTSELLER', 'CORE', 'NEW SEASON'].includes(product.tag));
  if (picks.length < 3) picks = [...picks, ...state.products.filter((product) => !state.favorites.has(product.id) && !picks.some((pick) => pick.id === product.id))];
  picks = picks.slice(0, 3);
  $('#recommendation-title').textContent = count ? 'A few picks in your style' : 'Easy places to start';
  $('#recommendation-note').textContent = count ? 'Based on your saved styles' : 'A few APRIA favourites';
  $('#recommendation-list').innerHTML = picks.map((product) => `<button type="button" class="recommendation-card" data-product="${esc(product.id)}"><img src="${esc(product.image)}" alt=""><span><b>${esc(product.name)}</b><small>${esc(product.category)} · ${money(product.price)}</small></span><i aria-hidden="true">↗</i></button>`).join('');
}
function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  localStorage.setItem('apria-favorites', JSON.stringify([...state.favorites])); renderProducts();
}
function addProduct(id, variant = {}) {
  const product = state.products.find((item) => item.id === id); if (!product) return;
  const entry = { id, size: variant.size || '', color: variant.color || '', quantity: Math.max(1, Math.min(10000, Number(variant.quantity) || 1)) };
  entry.key = variantKey(entry);
  const existing = state.quote.find((item) => item.key === entry.key);
  if (existing) existing.quantity = Math.min(10000, existing.quantity + entry.quantity); else state.quote.push(entry);
  saveQuote(); toast(`${product.name} added to your quote list.`);
}
function renderQuote() {
  const host = $('#quote-items'); if (!host) return;
  host.innerHTML = state.quote.length ? state.quote.map((item) => {
    const product = state.products.find((entry) => entry.id === item.id); if (!product) return '';
    const details = [item.size && `Size ${item.size}`, item.color].filter(Boolean).join(' · ') || 'Choose size and colour in product details';
    return `<div class="quote-item"><img src="${esc(product.image)}" alt=""><div><b>${esc(product.name)}</b><small>${esc(details)} · ${esc(product.gsm)}</small></div><div><input aria-label="Quantity for ${esc(product.name)}" type="number" min="1" max="10000" value="${item.quantity}" data-quantity="${esc(item.key)}"><button aria-label="Remove ${esc(product.name)}" data-remove="${esc(item.key)}">×</button></div></div>`;
  }).join('') : '<div class="quote-empty">Your list is empty. Add a garment from the collection to get started.</div>';
}
function openProduct(id) {
  const product = state.products.find((item) => item.id === id); if (!product) return;
  const sizes = getSizes(product.sizes), colors = getColors(product.color);
  $('#product-detail').innerHTML = `<div class="product-detail">
    <img src="${esc(product.image)}" alt="${esc(product.name)}">
    <div class="product-detail-copy"><div class="eyebrow">${esc(product.tag)} / ${esc(product.category.toUpperCase())}</div>
      <h2 id="product-detail-title">${esc(product.name)}</h2><div class="detail-price">₹${Number(product.price).toLocaleString('en-IN')} <small>indicative retail price · bulk pricing on request</small></div>
      <p>${esc(product.description)}</p><div class="detail-specs"><div><span>Fabric</span><b>${esc(product.fabric)}</b></div><div><span>Weight</span><b>${esc(product.gsm)}</b></div></div>
      <div class="variant-fields"><label>Colour<select id="detail-color">${colors.map((color) => `<option value="${esc(color)}">${esc(color)}</option>`).join('')}</select></label><label>Size<select id="detail-size" required><option value="" disabled selected>Select size</option></select></label><label>Quantity<input id="detail-quantity" type="number" min="1" max="100" value="1"></label></div>
      <p class="variant-availability" id="detail-availability" aria-live="polite">Choose a colour and size to check availability.</p>
      <button class="button button-dark" data-cart-add="${esc(product.id)}" disabled>Add to shopping bag <span>＋</span></button><button class="detail-quote-button" data-add="${esc(product.id)}">Add to quote list ↗</button>
    </div></div>`;
  const colorInput = $('#detail-color'), sizeInput = $('#detail-size');
  function updateOptions() {
    const prior = sizeInput.value, color = colorInput.value;
    sizeInput.innerHTML = `<option value="" disabled selected>Select size</option>${sizes.map((size) => {
      const available = variantAvailability(product, size, color);
      return `<option value="${esc(size)}" ${available ? '' : 'disabled'}>${esc(size)}${available ? ` · ${available} available` : ' · sold out'}</option>`;
    }).join('')}`;
    if (sizes.includes(prior) && variantAvailability(product, prior, color) > 0) sizeInput.value = prior;
    const available = variantAvailability(product, sizeInput.value, color);
    const quantity = $('#detail-quantity'); quantity.max = String(Math.max(1, Math.min(100, available)));
    quantity.value = String(Math.min(Math.max(1, Number(quantity.value) || 1), Math.max(1, Math.min(100, available))));
    $('#detail-availability').textContent = sizeInput.value ? (available ? `${available} available in this size and colour.` : 'This option is currently unavailable.') : 'Choose an available size to continue.';
    $('[data-cart-add]').disabled = !sizeInput.value || available < 1;
  }
  colorInput.addEventListener('change', updateOptions); sizeInput.addEventListener('change', updateOptions); updateOptions();
  $('#product-dialog').showModal();
}
async function loadRazorpay() {
  if (window.Razorpay) return window.Razorpay;
  if (!loadRazorpay.promise) loadRazorpay.promise = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'https://checkout.razorpay.com/v1/checkout.js'; script.async = true;
    script.onload = () => window.Razorpay ? resolve(window.Razorpay) : reject(new Error('Secure checkout did not load. Please try again.'));
    script.onerror = () => reject(new Error('Secure checkout did not load. Check your connection and try again.'));
    document.head.appendChild(script);
  });
  return loadRazorpay.promise;
}
function checkoutStatus(message, error = false) {
  const status = $('#checkout-status'); status.textContent = message; status.classList.toggle('error', error);
}
async function verifyPayment(order, payment) {
  checkoutStatus('Verifying your payment securely…');
  const response = await fetch('/api/checkout/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: order.orderId, ...payment }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Payment received, but confirmation is delayed. Keep your receipt and contact APRIA.');
  if (result.status !== 'paid') {
    checkoutStatus(result.message || 'Payment is being confirmed. Keep your receipt and contact APRIA before retrying.', true);
    state.checkoutBusy = false; renderCart(); return;
  }
  state.cart = []; saveCart(); $('#cart-dialog').close();
  $('#receipt-code').textContent = result.receipt; $('#order-success').showModal();
  state.checkoutBusy = false; renderCart();
}
async function submitCheckout(form) {
  if (!state.cart.length || state.checkoutBusy) return;
  if (!form.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(form));
  const payload = {
    customer: { name: fields.name, email: fields.email, phone: fields.phone, address1: fields.address1, address2: fields.address2, city: fields.city, state: fields.state, pincode: fields.pincode },
    items: state.cart.map(({ id, size, color, quantity }) => ({ id, size, color, quantity }))
  };
  if (!state.payment.enabled) {
    const orderRequest = {
      name: fields.name, email: fields.email, phone: fields.phone,
      address: { address1: fields.address1, address2: fields.address2, city: fields.city, state: fields.state, pincode: fields.pincode },
      items: state.cart.map(({ id, size, color, quantity }) => ({ id, size, color, quantity }))
    };
    state.checkoutBusy = true; renderCart(); checkoutStatus('Saving your order request…');
    try {
      const response = await fetch('/api/order-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderRequest) });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to save your order request. Please try again.');
      checkoutStatus('Order request saved. No payment was taken. APRIA must confirm availability and arrange payment with you.');
    } catch (error) {
      checkoutStatus(error.message.includes('Failed to fetch') ? 'Could not reach APRIA. Your bag is still saved; please contact us to arrange your order.' : error.message, true);
    } finally {
      state.checkoutBusy = false; renderCart();
    }
    return;
  }
  const button = form.querySelector('[type="submit"]');
  state.checkoutBusy = true; renderCart(); button.disabled = true; checkoutStatus('Preparing your secure checkout…');
  try {
    const orderResponse = await fetch('/api/checkout/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const order = await orderResponse.json().catch(() => ({}));
    if (!orderResponse.ok) throw new Error(order.error || 'Unable to start checkout. Please try again.');
    const expectedPaise = Math.round((state.cart.reduce((sum, item) => {
      const product = state.products.find((entry) => entry.id === item.id);
      return sum + (product ? Number(product.price) * item.quantity : 0);
    }, 0) * 100) + Number(state.payment.deliveryPaise || 0));
    if (!Number.isSafeInteger(order.amount) || order.amount !== expectedPaise || order.currency !== 'INR') throw new Error('The catalogue total changed. Refresh the page and review your bag before paying.');
    const Razorpay = await loadRazorpay();
    state.checkoutBusy = false; renderCart();
    const gateway = new Razorpay({
      key: order.keyId || state.payment.keyId, amount: order.amount, currency: order.currency, name: 'APRIA',
      description: 'APRIA apparel order', order_id: order.razorpayOrderId,
      prefill: { name: fields.name, email: fields.email, contact: fields.phone },
      notes: { receipt: order.receipt }, theme: { color: '#283328' },
      config: { display: {
        blocks: { apria_upi: { name: 'Pay via UPI', instruments: [{ method: 'upi' }] } },
        sequence: ['block.apria_upi'],
        preferences: { show_default_blocks: false }
      } },
      handler: (payment) => verifyPayment(order, payment).catch((error) => { state.checkoutBusy = false; renderCart(); checkoutStatus(error.message, true); }),
      modal: { ondismiss: () => { state.checkoutBusy = false; renderCart(); checkoutStatus('Payment window closed. Your bag is still here; you can try again whenever you’re ready.'); } }
    });
    gateway.on('payment.failed', (event) => {
      state.checkoutBusy = false; renderCart();
      checkoutStatus(event.error?.description || 'Payment did not complete. Your bag is still here; please try again.', true);
    });
    gateway.open();
  } catch (error) {
    state.checkoutBusy = false; renderCart(); checkoutStatus(error.message, true);
  }
}
async function submitForm(form) {
  const status = form.querySelector('.form-status'), button = form.querySelector('[type=submit]');
  const data = Object.fromEntries(new FormData(form));
  if (form.id === 'quote-form') data.items = state.quote.map((item) => ({ ...item, name: state.products.find((product) => product.id === item.id)?.name || item.id }));
  button.disabled = true; button.style.opacity = '.6'; status.classList.remove('error'); status.textContent = 'Sending your enquiry…';
  try {
    const response = await fetch('/api/enquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Please try again.');
    form.reset(); status.textContent = 'Thanks! Your enquiry is with our team. We’ll be in touch.';
    if (form.id === 'quote-form') { state.quote = []; saveQuote(); }
    else setTimeout(() => { status.textContent = ''; }, 7000);
  } catch (error) {
    status.textContent = error.message.includes('Failed to fetch') ? 'Couldn’t connect right now. Please try again or WhatsApp us.' : error.message;
    status.classList.add('error');
  } finally { button.disabled = false; button.style.opacity = '1'; }
}

document.addEventListener('click', (event) => {
  const favorite = event.target.closest('[data-favorite]');
  if (favorite) { event.stopPropagation(); toggleFavorite(favorite.dataset.favorite); return; }
  const options = event.target.closest('[data-options]');
  if (options) { event.stopPropagation(); openProduct(options.dataset.options); return; }
  const cartAdd = event.target.closest('[data-cart-add]');
  if (cartAdd) {
    event.stopPropagation();
    const size = $('#detail-size')?.value || '', color = $('#detail-color')?.value || '';
    if (!size) { $('#detail-size')?.focus(); toast('Choose a size to add this garment.'); return; }
    addToCart(cartAdd.dataset.cartAdd, { size, color, quantity: $('#detail-quantity')?.value || 1 });
    $('#product-dialog').close(); return;
  }
  const add = event.target.closest('[data-add]');
  if (add) {
    event.stopPropagation();
    const size = $('#detail-size')?.value || '', color = $('#detail-color')?.value || '';
    if (!size) { $('#detail-size')?.focus(); toast('Choose a size to add this garment.'); return; }
    addProduct(add.dataset.add, { size, color, quantity: $('#detail-quantity')?.value || 1 });
    if (add.closest('.product-dialog')) $('#product-dialog').close(); return;
  }
  const product = event.target.closest('[data-product]');
  if (product) { openProduct(product.dataset.product); return; }
  const remove = event.target.closest('[data-remove]');
  if (remove) { state.quote = state.quote.filter((item) => item.key !== remove.dataset.remove); saveQuote(); return; }
  const cartRemove = event.target.closest('[data-cart-remove]');
  if (cartRemove) { state.cart = state.cart.filter((item) => item.key !== cartRemove.dataset.cartRemove); saveCart(); return; }
  if (event.target.closest('#cart-trigger')) { renderCart(); setCheckoutStep('bag'); $('#cart-dialog').showModal(); return; }
  if (event.target.closest('#checkout-help-link')) $('#cart-dialog').close();
  if (event.target.closest('#checkout-next')) { if (state.cart.length) setCheckoutStep('delivery'); return; }
  if (event.target.closest('#checkout-back')) { setCheckoutStep('bag'); return; }
  if (event.target.closest('[data-cart-close]')) { $('#cart-dialog').close(); $('#shop').scrollIntoView({ behavior: 'smooth' }); return; }
  if (event.target.closest('#success-close')) { $('#order-success').close(); return; }
  if (event.target.closest('[data-clear-filters]')) {
    state.filter = 'All'; state.query = ''; state.savedOnly = false; $('#product-search').value = ''; $('#product-sort').value = 'featured';
    document.querySelectorAll('.filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'All')); renderProducts();
  }
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-quantity]')) {
    const item = state.quote.find((entry) => entry.key === event.target.dataset.quantity);
    if (item) { item.quantity = Math.max(1, Math.min(10000, Number(event.target.value) || 1)); saveQuote(); }
  }
  if (event.target.matches('[data-cart-quantity]')) {
    const item = state.cart.find((entry) => entry.key === event.target.dataset.cartQuantity);
    if (item) { item.quantity = Math.max(1, Math.min(100, Number(event.target.value) || 1)); saveCart(); }
  }
});
$('#filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  state.filter = button.dataset.filter;
  document.querySelectorAll('.filter').forEach((entry) => entry.classList.toggle('active', entry === button)); renderProducts();
});
$('#product-search').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderProducts(); });
$('#product-sort').addEventListener('change', (event) => { state.sort = event.target.value; renderProducts(); });
$('#favorites-toggle').addEventListener('click', () => { state.savedOnly = !state.savedOnly; renderProducts(); });
$('#weight-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-weight]'); if (!button) return;
  document.querySelectorAll('#weight-tabs [data-weight]').forEach((tab) => {
    const active = tab === button;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-pressed', String(active));
  });
  renderWeightProducts(button.dataset.weight);
});
$('#quote-trigger').addEventListener('click', () => $('#quote-dialog').showModal());
$('#checkout-form').addEventListener('submit', (event) => { event.preventDefault(); submitCheckout(event.currentTarget); });
document.querySelectorAll('dialog .dialog-close').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
document.querySelectorAll('.inquiry-form:not(#checkout-form)').forEach((form) => form.addEventListener('submit', (event) => { event.preventDefault(); submitForm(form); }));
const menu = $('.menu-toggle');
menu.addEventListener('click', () => { const open = $('#main-nav').classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu'); });
document.querySelectorAll('.main-nav a').forEach((link) => link.addEventListener('click', () => { $('#main-nav').classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); }));
$('#year').textContent = new Date().getFullYear(); saveQuote();
renderCart();
fetch('/api/products').then((response) => { if (!response.ok) throw new Error(); return response.json(); })
  .then((data) => { state.products = Array.isArray(data) ? data : data.products; renderProducts(); renderWeightProducts(); saveQuote(); saveCart(); })
  .catch(() => { $('#product-grid').innerHTML = '<div class="loading">The collection is taking a moment. Refresh the page to try again.</div>'; });
fetch('/api/config').then((response) => response.json()).then(({ whatsappNumber }) => {
  const number = /^\d{8,15}$/.test(whatsappNumber || '') ? whatsappNumber : DEFAULT_WHATSAPP_NUMBER;
  const formatted = `+${number.slice(0, 2)} ${number.slice(2, 7)} ${number.slice(7)}`;
  const message = (text) => `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  $('#whatsapp-link').href = message("Hi APRIA, I'd like to discuss an apparel enquiry.");
  $('#whatsapp-link small').textContent = `Message APRIA about your idea · ${formatted}`;
  const checkoutHelp = $('#checkout-help-link');
  checkoutHelp.href = message('Hi APRIA, I need help with my order or payment.');
  checkoutHelp.target = '_blank';
  checkoutHelp.rel = 'noopener';
}).catch(() => {
  const number = DEFAULT_WHATSAPP_NUMBER;
  $('#whatsapp-link').href = `https://wa.me/${number}?text=${encodeURIComponent("Hi APRIA, I'd like to discuss an apparel enquiry.")}`;
  $('#whatsapp-link small').textContent = 'Message APRIA about your idea · +91 78883 29606';
  const checkoutHelp = $('#checkout-help-link');
  checkoutHelp.href = `https://wa.me/${number}?text=${encodeURIComponent('Hi APRIA, I need help with my order or payment.')}`;
  checkoutHelp.target = '_blank';
  checkoutHelp.rel = 'noopener';
});
fetch('/api/payment/config').then((response) => response.json()).then((config) => {
  state.payment = { ...state.payment, ...config };
  checkoutStatus(config.enabled ? 'Secure UPI checkout is ready. Delivery is calculated at checkout.' : 'Online UPI is not enabled. You can still send an order request; APRIA will confirm payment options.');
  renderCart();
}).catch(() => {
  checkoutStatus('Payment setup could not be reached. You can still send an order request; no payment will be taken.', true);
  renderCart();
});

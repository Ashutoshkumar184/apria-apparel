const state = { user: null, csrfToken: '', view: 'overview', products: [], enquiries: [], requests: [], orders: [], users: [], audit: [], settings: null, search: '', requestKind: 'all' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const money = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const label = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
const statuses = {
  enquiry: ['new', 'in_progress', 'quoted', 'won', 'closed'],
  request: ['new', 'contacted', 'converted', 'closed'],
  fulfillment: ['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled']
};
function showMessage(message, error = false) {
  const element = $('#portal-message'); element.textContent = message; element.hidden = !message; element.classList.toggle('error', error);
  if (message && !error) setTimeout(() => { if (element.textContent === message) element.hidden = true; }, 6000);
}
async function api(path, options = {}) {
  const method = options.method || 'GET', headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (!['GET', 'HEAD'].includes(method) && state.csrfToken && !['/api/admin/login', '/api/admin/setup'].includes(path)) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(path, { ...options, method, headers, credentials: 'same-origin', body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body });
  const result = await response.json().catch(() => ({}));
  if (response.status === 401 && !['/api/admin/login', '/api/admin/setup'].includes(path)) { state.user = null; state.csrfToken = ''; showAuth(); }
  if (!response.ok) throw new Error(result.error || 'Could not complete that action. Please try again.');
  return result;
}
function formData(form) { return Object.fromEntries(new FormData(form)); }
function statusMarkup(value, kind = '') { const status = String(value || 'new'); const alert = ['failed', 'closed', 'cancelled'].includes(status); const good = ['paid', 'delivered', 'converted', 'won'].includes(status); return `<span class="pill ${good ? 'paid' : alert ? 'alert' : ''} ${esc(kind)}">${esc(label(status))}</span>`; }
function formStatus(form, message, error = false) { const target = $('.admin-status', form); if (target) { target.textContent = message; target.classList.toggle('error', error); } }
function showAuth(setupRequired = false, setupEnabled = true) {
  state.user = null;
  $('#portal').hidden = true; $('#password-panel').hidden = true; $('#auth-panel').hidden = false; $('#admin-user-chip').hidden = true; $('#admin-logout').hidden = true;
  $('#login-form').hidden = setupRequired; $('#setup-form').hidden = !setupRequired || !setupEnabled;
  $('#auth-title').innerHTML = setupRequired ? 'Set up your<br>studio desk<span>.</span>' : 'Your studio,<br>in good order<span>.</span>';
  $('#auth-description').textContent = setupRequired
    ? setupEnabled ? 'Create the owner account using the one-time setup code from your server environment.' : 'Admin setup is not configured. Add ADMIN_SETUP_TOKEN and ADMIN_SESSION_SECRET to .env, then restart the local server.'
    : 'Sign in to review customer requests, orders, stock, and the APRIA catalogue.';
  if (setupRequired && !setupEnabled) $('#setup-form').hidden = true;
  $('#admin-nav').querySelectorAll('[data-view]').forEach((button) => button.classList.remove('active'));
}
function showPasswordChange() {
  $('#auth-panel').hidden = true; $('#portal').hidden = true; $('#password-panel').hidden = false; $('#admin-user-chip').hidden = false; $('#admin-logout').hidden = false;
  $('#admin-user-chip').textContent = `${state.user.name} · change password`;
}
async function openPortal(user, csrfToken) {
  state.user = user; state.csrfToken = csrfToken || state.csrfToken;
  $('#auth-panel').hidden = true; $('#password-panel').hidden = true; $('#portal').hidden = false; $('#admin-user-chip').hidden = false; $('#admin-logout').hidden = false;
  $('#admin-user-chip').textContent = `${user.name} · ${label(user.role)}`;
  $$('[data-owner-only]').forEach((element) => { element.hidden = user.role !== 'owner'; });
  if (user.mustChangePassword) { showPasswordChange(); return; }
  await loadView(state.view);
}
async function boot() {
  try {
    const session = await api('/api/admin/session');
    state.csrfToken = session.csrfToken || '';
    await openPortal(session, session.csrfToken);
  } catch {
    try { const status = await api('/api/admin/status'); showAuth(status.setupRequired, status.setupEnabled); }
    catch { showAuth(false, false); $('#auth-description').textContent = 'The portal service could not be reached. Check that APRIA is running, then refresh this page.'; }
  }
}
function pageHeading(kicker, title, description, action = '') {
  return `<header class="page-heading"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</header>`;
}
function setView(view) {
  if (state.user?.role !== 'owner' && ['catalog', 'team', 'settings'].includes(view)) view = 'overview';
  state.view = view;
  $$('#admin-nav [data-view]').forEach((button) => { const active = button.dataset.view === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $$('.admin-view').forEach((panel) => { panel.hidden = panel.dataset.panel !== view; });
  loadView(view).catch((error) => showMessage(error.message, true));
}
async function loadView(view) {
  if (!state.user || state.user.mustChangePassword) return;
  state.view = view;
  if (view === 'overview') await renderOverview();
  else if (view === 'requests') await renderRequests();
  else if (view === 'orders') await renderOrders();
  else if (view === 'catalog') await renderCatalog();
  else if (view === 'team') await renderTeam();
  else if (view === 'settings') await renderSettings();
  else if (view === 'activity') await renderAudit();
}
async function renderOverview() {
  const data = await api('/api/admin/overview');
  const panel = $('[data-panel="overview"]');
  panel.innerHTML = `${pageHeading('STUDIO DESK / 01', 'Good to see you, ' + state.user.name.split(' ')[0] + '.', 'A clear view of the work waiting for APRIA today.')}
    <div class="metrics-grid"><article class="metric"><span>New enquiries</span><strong>${Number(data.newEnquiries || 0)}</strong><small>Waiting for a reply</small></article><article class="metric"><span>Order requests</span><strong>${Number(data.openRequests || 0)}</strong><small>Payment not collected</small></article><article class="metric"><span>Paid orders to fulfil</span><strong>${Number(data.ordersToFulfill || 0)}</strong><small>Verified captured payments</small></article><article class="metric"><span>Captured sales</span><strong>${money(data.salesPaise)}</strong><small>Verified payments only</small></article></div>
    <div class="dashboard-grid"><article class="admin-card"><h2>Needs a look</h2><p class="card-subtitle">Items that may need action before the next order moves.</p><div class="action-list"><div class="action-row"><b>Payments to review</b><span>${Number(data.pendingPayments || 0)}</span></div><div class="action-row"><b>Low-stock variants</b><span>${Number(data.lowStock || 0)}</span></div><div class="action-row"><b>Orders awaiting delivery</b><span>${Number(data.ordersToFulfill || 0)}</span></div></div></article><article class="admin-card"><h2>Quick route</h2><p class="card-subtitle">Go straight to the customer work queue.</p><div class="action-list"><div class="action-row"><b>Customer requests</b><button type="button" class="admin-small-button" data-go="requests">Open inbox ↗</button></div><div class="action-row"><b>Paid orders</b><button type="button" class="admin-small-button" data-go="orders">View orders ↗</button></div>${state.user.role === 'owner' ? '<div class="action-row"><b>Stock & catalogue</b><button type="button" class="admin-small-button" data-go="catalog">Manage ↗</button></div>' : ''}</div></article></div>`;
  $('#nav-request-count').textContent = Number(data.newEnquiries || 0) + Number(data.openRequests || 0);
}
function contactLinks(item) {
  const email = item.email ? `<a href="mailto:${esc(item.email)}">${esc(item.email)}</a>` : '';
  const phoneDigits = String(item.phone || '').replace(/\D/g, '');
  const phone = phoneDigits ? `<a href="tel:${esc(item.phone)}">${esc(item.phone)}</a>` : '';
  const whatsapp = phoneDigits.length >= 8 ? `<a href="https://wa.me/${esc(phoneDigits)}" target="_blank" rel="noopener">WhatsApp ↗</a>` : '';
  return [email, phone, whatsapp].filter(Boolean).join(' · ');
}
function itemLines(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return `<ul>${items.map((item) => `<li>${esc(item.name || item.id)} · ${esc(item.size)} / ${esc(item.color)} × ${Number(item.quantity || 1)}${item.lineTotalPaise ? ` — ${money(item.lineTotalPaise)}` : ''}</li>`).join('')}</ul>`;
}
function statusOptions(options, current) { return options.map((option) => `<option value="${option}" ${option === current ? 'selected' : ''}>${esc(label(option))}</option>`).join(''); }
function enquiryCard(item) {
  const id = String(item.id || ''), created = item.createdAt || item.created_at || '', type = item.type === 'general' && item.company === 'Retail order request' ? 'Retail order request' : label(item.type || 'enquiry');
  return `<article class="record-card" data-record-card data-search="${esc([item.name, item.email, item.phone, item.company, item.type, item.message].join(' ').toLowerCase())}"><div class="record-top"><div><h2>${esc(item.name || 'Customer request')}</h2><p>${esc(type)}${item.company && item.company !== 'Retail order request' ? ` · ${esc(item.company)}` : ''}</p></div>${statusMarkup(item.status)}</div><div class="record-meta"><time datetime="${esc(created)}">${esc(new Date(created).toLocaleString())}</time><span>${contactLinks(item)}</span></div>${item.message ? `<p>${esc(item.message)}</p>` : ''}${itemLines(item.items)}<div class="record-actions"><label>Status<select data-status>${statusOptions(statuses.enquiry, item.status || 'new')}</select></label><label class="note-field">Private APRIA note<textarea data-note maxlength="3000" placeholder="Only visible to the team…">${esc(item.adminNote || item.admin_note || '')}</textarea></label><button class="admin-small-button" type="button" data-save-enquiry="${esc(id)}">Save update</button></div></article>`;
}
function requestCard(item) {
  const id = String(item.id || ''), created = item.createdAt || item.created_at || '', address = item.address || {};
  return `<article class="record-card" data-record-card data-search="${esc([item.name, item.email, item.phone, item.id].join(' ').toLowerCase())}"><div class="record-top"><div><h2>${esc(item.name || 'Retail order request')}</h2><p>Retail order request · ${money(item.amountEstimatePaise || 0)} estimated · no payment collected</p></div>${statusMarkup(item.status)}</div><div class="record-meta"><time datetime="${esc(created)}">${esc(new Date(created).toLocaleString())}</time><span>${contactLinks(item)}</span></div><p class="record-address">Ship to: ${esc([address.address1, address.address2, address.city, address.state, address.pincode].filter(Boolean).join(', '))}</p><div class="record-items">${itemLines(item.items)}</div><div class="record-actions"><label>Status<select data-status>${statusOptions(statuses.request, item.status || 'new')}</select></label><label class="note-field">Private APRIA note<textarea data-note maxlength="3000" placeholder="Only visible to the team…">${esc(item.adminNote || '')}</textarea></label><button class="admin-small-button" type="button" data-save-request="${esc(id)}">Save update</button></div></article>`;
}
async function renderRequests() {
  const [enquiryData, requestData] = await Promise.all([api('/api/admin/enquiries'), api('/api/admin/order-requests')]);
  state.enquiries = enquiryData.enquiries || []; state.requests = requestData.orderRequests || [];
  const panel = $('[data-panel="requests"]'), action = '<div class="toolbar"><input type="search" data-search-input placeholder="Search customer, email, phone…" aria-label="Search requests"><select data-request-kind aria-label="Request type"><option value="all">All requests</option><option value="enquiries">Enquiries</option><option value="order-requests">Retail order requests</option></select><select data-request-status aria-label="Filter by status"><option value="all">All statuses</option><option value="new">New</option><option value="in_progress">In progress</option><option value="quoted">Quoted</option><option value="contacted">Contacted</option><option value="converted">Converted</option><option value="won">Won</option><option value="closed">Closed</option></select></div>';
  panel.innerHTML = `${pageHeading('CUSTOMER DESK / 02', 'Requests', 'Enquiries and unpaid retail order requests arrive here. Email and WhatsApp actions open your own app.', action)}<div class="record-list" id="request-list"></div>`;
  $('[data-request-kind]', panel).value = state.requestKind;
  paintRequests();
}
function paintRequests() {
  const host = $('#request-list'); if (!host) return;
  const records = [];
  if (state.requestKind !== 'order-requests') records.push(...state.enquiries.map((item) => ({ ...item, requestKind: 'enquiry' })));
  if (state.requestKind !== 'enquiries') records.push(...state.requests.map((item) => ({ ...item, requestKind: 'order-request' })));
  const search = state.search.toLowerCase(), status = $('[data-request-status]')?.value || 'all';
  const filtered = records.filter((item) => (!search || [item.name, item.email, item.phone, item.company, item.type, item.message, item.id].join(' ').toLowerCase().includes(search)) && (status === 'all' || item.status === status));
  host.innerHTML = filtered.length ? filtered.map((item) => item.requestKind === 'enquiry' ? enquiryCard(item) : requestCard(item)).join('') : '<div class="empty-state">No requests match this view yet.</div>';
}
function orderCard(item) {
  const customer = item.customer || {}, created = item.createdAt || item.created_at || '', paid = item.status === 'paid';
  const actions = paid
    ? `<div class="record-actions"><label>Fulfilment<select data-fulfillment>${statusOptions(statuses.fulfillment, item.fulfillmentStatus || 'unfulfilled')}</select></label><label class="note-field">Private APRIA note<textarea data-note maxlength="3000" placeholder="Only visible to the team…">${esc(item.adminNote || '')}</textarea></label><button class="admin-small-button" type="button" data-save-order="${esc(item.id)}">Save update</button></div>`
    : '<p class="record-address">Fulfilment controls unlock after Razorpay confirms a captured payment.</p>';
  return `<article class="record-card" data-record-card data-search="${esc([item.id, customer.name, customer.email, customer.phone, item.status].join(' ').toLowerCase())}"><div class="record-top"><div><h2>Order ${esc(String(item.id).slice(0, 8).toUpperCase())}</h2><p>${esc(customer.name || '')} · ${esc(customer.email || '')}</p></div><div>${statusMarkup(item.status, item.status)} ${statusMarkup(item.fulfillmentStatus || 'unfulfilled')}</div></div><div class="record-meta"><time datetime="${esc(created)}">${esc(new Date(created).toLocaleString())}</time><span>${money(item.amountPaise || 0)} ${esc(item.currency || 'INR')}</span><span>Payment ${esc(item.paymentId || 'pending')}</span></div><p class="record-address">${esc([customer.address1, customer.address2, customer.city, customer.state, customer.pincode].filter(Boolean).join(', '))}</p><div class="record-items">${itemLines(item.items)}</div>${actions}</article>`;
}
async function renderOrders() {
  const data = await api('/api/admin/orders'); state.orders = data.orders || [];
  const panel = $('[data-panel="orders"]'), action = '<div class="toolbar"><input type="search" data-list-search placeholder="Search order or customer…" aria-label="Search paid orders"><select data-order-status aria-label="Filter payment status"><option value="all">All payment states</option><option value="paid">Paid</option><option value="authorized">Authorized</option><option value="created">Pending</option><option value="failed">Failed</option></select></div>';
  panel.innerHTML = `${pageHeading('FULFILMENT / 03', 'Orders & payments', 'Payment state comes from Razorpay. Fulfilment unlocks after capture; refunds remain in Razorpay.', action)}<div class="record-list" id="paid-order-list"></div>`;
  paintOrders();
}
function paintOrders() {
  const host = $('#paid-order-list'); if (!host) return;
  const search = state.search.toLowerCase(), status = $('[data-order-status]')?.value || 'all';
  const filtered = state.orders.filter((item) => (!search || [item.id, item.customer?.name, item.customer?.email].join(' ').toLowerCase().includes(search)) && (status === 'all' || item.status === status));
  host.innerHTML = filtered.length ? filtered.map(orderCard).join('') : '<div class="empty-state">No paid orders match this view. Unpaid customer requests are in Requests.</div>';
}
function field(name, value, labelText, type = 'text', wide = false) {
  return `<label class="admin-field ${wide ? 'wide' : ''}">${esc(labelText)}<input name="${esc(name)}" type="${type}" value="${esc(value ?? '')}" ${type === 'number' ? 'min="0" step="0.01"' : ''} required></label>`;
}
function productForm(product, prefix = 'product') {
  return `<form class="product-edit-form" data-product-form data-product-id="${esc(product.id)}">
    ${field('name', product.name, 'Product name')}${field('category', product.category, 'Category')}${field('price', product.price, 'Retail price (₹)', 'number')}
    ${field('from', product.from, 'Bulk price from (₹)', 'number')}${field('image', product.image, 'Image URL')}${field('tag', product.tag, 'Product tag')}
    ${field('color', product.color, 'Colours (separate with /)')}${field('sizes', product.sizes, 'Sizes (for example XS–XXL)')}${field('gsm', product.gsm, 'GSM / weight')}
    ${field('fabric', product.fabric, 'Fabric')}
    <label class="admin-field wide">Description<textarea name="description" maxlength="1200">${esc(product.description)}</textarea></label>
    <label class="admin-field">Store visibility<select name="active"><option value="true" ${product.active ? 'selected' : ''}>Active</option><option value="false" ${!product.active ? 'selected' : ''}>Archived</option></select></label>
    <div class="wide"><button class="admin-primary" type="submit">Save product</button> <span class="admin-status" role="status"></span></div>
  </form>`;
}
function stockRows(product) {
  return `<div class="variant-stock-grid">${(product.variants || []).map((variant) => `<div class="stock-control"><span>${esc(variant.size)} / ${esc(variant.color)}<small> · ${Number(variant.available ?? (Number(variant.stockOnHand) - Number(variant.reserved || 0)))} available</small></span><input type="number" min="${Number(variant.reserved || 0)}" max="1000000" step="1" value="${Number(variant.stockOnHand || 0)}" aria-label="Stock for ${esc(product.name)} ${esc(variant.size)} ${esc(variant.color)}" data-stock-input><button type="button" data-stock-save="${esc(product.id)}" data-size="${esc(variant.size)}" data-color="${esc(variant.color)}">Save</button></div>`).join('')}</div>`;
}
function productCard(product) {
  return `<article class="product-admin-card"><div class="product-admin-head"><img src="${esc(product.image)}" alt=""><div><h2>${esc(product.name)}</h2><p>${esc(product.category)} · ${money(Math.round(Number(product.price) * 100))} · ${esc(product.gsm || '')}</p></div>${statusMarkup(product.active ? 'active' : 'closed')}</div>${productForm(product)}<div class="inventory-section"><h3>Stock by size and colour</h3>${stockRows(product)}</div></article>`;
}
function newProductForm() {
  return `<form class="product-create-form" id="product-create-form">
    ${field('name', '', 'Product name')}${field('category', '', 'Category')}${field('price', '0', 'Retail price (₹)', 'number')}
    ${field('from', '0', 'Bulk price from (₹)', 'number')}${field('image', '', 'Image URL')}${field('tag', '', 'Product tag')}
    ${field('color', '', 'Colours (separate with /)')}${field('sizes', '', 'Sizes (for example XS–XXL)')}${field('gsm', '', 'GSM / weight')}${field('fabric', '', 'Fabric')}
    <label class="admin-field wide">Description<textarea name="description" maxlength="1200"></textarea></label>
    <div class="wide"><button class="admin-primary" type="submit">Create product</button> <span class="admin-status" role="status"></span></div>
  </form>`;
}
async function renderCatalog() {
  const data = await api('/api/admin/products'); state.products = data.products || data || [];
  const panel = $('[data-panel="catalog"]'), action = `<button type="button" class="admin-primary" data-toggle-create>Add a product +</button>`;
  panel.innerHTML = `${pageHeading('COLLECTION / 04', 'Catalogue & stock', 'Update product details and track inventory for each size and colour.', action)}<div class="toolbar"><input type="search" data-list-search placeholder="Find a garment…" aria-label="Search catalogue"><select data-product-status aria-label="Filter products"><option value="active">Active products</option><option value="all">All products</option><option value="archived">Archived</option></select></div><div id="product-create-wrap" class="admin-card" hidden><h2 class="section-title">New garment</h2><p class="card-subtitle">New variants start with zero stock. Enter counts below after creating the product.</p>${newProductForm()}</div><div class="product-list" id="admin-product-list"></div>`;
  paintProducts();
}
function paintProducts() {
  const host = $('#admin-product-list'); if (!host) return;
  const filter = $('[data-product-status]')?.value || 'active', search = state.search.toLowerCase();
  const products = state.products.filter((item) => (filter === 'all' || (filter === 'active' ? item.active : !item.active)) && (!search || [item.name, item.category, item.fabric, item.gsm].join(' ').toLowerCase().includes(search)));
  host.innerHTML = products.length ? products.map(productCard).join('') : '<div class="empty-state">No garments match this view.</div>';
}
async function renderTeam() {
  const data = await api('/api/admin/users'); state.users = data.users || [];
  const panel = $('[data-panel="team"]');
  panel.innerHTML = `${pageHeading('PEOPLE / 05', 'Team access', 'Staff can manage customer conversations and fulfilment. Only the owner can edit the shop.')}
    <article class="admin-card"><h2>Add a staff member</h2><p class="card-subtitle">A temporary password is shown once. Share it privately; the team member must change it at first sign-in.</p><form id="staff-create-form" class="toolbar staff-create-form"><input name="name" placeholder="Full name" aria-label="Staff member name" required maxlength="100"><input name="email" type="email" placeholder="Email address" aria-label="Staff email" required maxlength="200"><button class="admin-primary" type="submit">Create account</button><p class="admin-status" role="status" aria-live="polite"></p></form></article><div class="user-list" id="staff-list"></div>`;
  $('#staff-list').innerHTML = state.users.map((user) => `<article class="user-card"><div><h3>${esc(user.name)} ${user.role === 'owner' ? '<span class="pill">Owner</span>' : ''}</h3><p>${esc(user.email)} · ${user.active ? 'Active' : 'Deactivated'}${user.mustChangePassword ? ' · Must change password' : ''}</p></div>${user.role === 'staff' ? `<div class="user-actions"><button class="admin-small-button" type="button" data-user-action="reset-password" data-user-id="${esc(user.id)}">Reset password</button><button class="${user.active ? 'admin-danger' : 'admin-small-button'}" type="button" data-user-action="${user.active ? 'deactivate' : 'activate'}" data-user-id="${esc(user.id)}">${user.active ? 'Deactivate' : 'Reactivate'}</button></div>` : ''}</article>`).join('') || '<div class="empty-state">No accounts found.</div>';
}
async function renderSettings() {
  state.settings = await api('/api/admin/settings'); const panel = $('[data-panel="settings"]');
  panel.innerHTML = `${pageHeading('SHOP / 06', 'Shop settings', 'These values update the customer storefront. Payment credentials remain in server secrets.')}
    <form id="settings-form" class="setting-card"><h2>Public contact & delivery</h2><p>Use international digits, including the country code, for WhatsApp. The delivery amount appears at checkout.</p><label class="admin-field">WhatsApp number<input name="whatsappNumber" inputmode="numeric" placeholder="919876543210" value="${esc(state.settings.whatsappNumber || '')}" maxlength="15"></label><label class="admin-field">Flat delivery charge (₹)<input name="shippingFeeRupees" type="number" min="0" max="50000" step="0.01" value="${(Number(state.settings.shippingFeePaise || 0) / 100).toFixed(2)}" required></label><button class="admin-primary" type="submit">Save shop settings</button><p class="admin-status" role="status"></p></form>`;
}
async function renderAudit() {
  const data = await api('/api/admin/audit'); state.audit = data.audit || []; const panel = $('[data-panel="activity"]');
  panel.innerHTML = `${pageHeading('STUDIO LOG / 07', 'Activity', 'A record of account, catalogue, stock, and fulfilment changes.')}
    <div class="audit-list">${state.audit.length ? state.audit.map((row) => `<article class="audit-row"><time datetime="${esc(row.createdAt || row.created_at)}">${esc(new Date(row.createdAt || row.created_at).toLocaleString())}</time><span><b>${esc(row.userEmail || row.user_email || '')}</b> · ${esc(row.summary || row.action || '')}</span><small>${esc(row.targetType || row.target_type || '')}</small></article>`).join('') : '<div class="empty-state">No admin activity recorded yet.</div>'}</div>`;
}
function syncStatusFilter() { if (state.view === 'requests') paintRequests(); else if (state.view === 'orders') paintOrders(); }
function showTempPassword(password) {
  $('#temporary-secret').textContent = password; $('#secret-status').textContent = ''; $('#secret-dialog').showModal();
}
async function submitForm(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const values = formData(form);
  try {
    if (form.id === 'login-form') {
      const response = await api('/api/admin/login', { method: 'POST', body: values }); state.csrfToken = response.csrfToken || ''; await openPortal(response, response.csrfToken); return;
    }
    if (form.id === 'setup-form') {
      const response = await api('/api/admin/setup', { method: 'POST', body: values }); state.csrfToken = response.csrfToken || ''; await openPortal(response, response.csrfToken); showMessage('Owner account created. Keep your setup code private; it cannot create another owner.'); return;
    }
    if (form.id === 'password-form') {
      await api('/api/admin/password', { method: 'PUT', body: values }); state.user.mustChangePassword = false; $('#password-panel').hidden = true; $('#portal').hidden = false; showMessage('Password updated. You can use the portal now.'); await loadView('overview'); return;
    }
    if (form.dataset.productForm !== undefined) {
      const data = { ...values, price: Number(values.price), from: Number(values.from), active: values.active === 'true' };
      const response = await api(`/api/admin/products/${encodeURIComponent(form.dataset.productId)}`, { method: 'PUT', body: data });
      const product = response.product || response; state.products = state.products.map((item) => item.id === product.id ? product : item); showMessage(`${product.name} saved.`); paintProducts(); return;
    }
    if (form.id === 'product-create-form') {
      const response = await api('/api/admin/products', { method: 'POST', body: { ...values, price: Number(values.price), from: Number(values.from), active: true } });
      const product = response.product || response; state.products.push(product); paintProducts(); $('#product-create-wrap').hidden = true; showMessage(`${product.name} added. Enter stock for its variants before enabling purchases.`); return;
    }
    if (form.id === 'staff-create-form') {
      const response = await api('/api/admin/users', { method: 'POST', body: values }); showTempPassword(response.temporaryPassword); await renderTeam(); return;
    }
    if (form.id === 'settings-form') {
      state.settings = await api('/api/admin/settings', { method: 'PUT', body: { whatsappNumber: values.whatsappNumber, shippingFeePaise: Math.round(Number(values.shippingFeeRupees) * 100) } });
      showMessage('Shop settings saved and applied to the storefront.'); return;
    }
  } catch (error) { formStatus(form, error.message, true); }
}
async function saveStock(button) {
  const control = button.closest('.stock-control'), input = $('[data-stock-input]', control), quantity = Number(input.value);
  button.disabled = true;
  try { await api(`/api/admin/products/${encodeURIComponent(button.dataset.stockSave)}/stock`, { method: 'PATCH', body: { size: button.dataset.size, color: button.dataset.color, stockOnHand: quantity } }); showMessage('Variant stock updated.'); await renderCatalog(); }
  catch (error) { showMessage(error.message, true); button.disabled = false; }
}
async function saveRecord(button, kind) {
  const card = button.closest('[data-record-card]'), id = button.dataset[kind === 'enquiry' ? 'saveEnquiry' : kind === 'request' ? 'saveRequest' : 'saveOrder'];
  const select = $('[data-status]', card), note = $('[data-note]', card), payload = kind === 'order' ? { fulfillmentStatus: $('[data-fulfillment]', card).value, adminNote: note.value } : { status: select.value, adminNote: note.value };
  button.disabled = true;
  try {
    const endpoint = kind === 'enquiry' ? 'enquiries' : kind === 'request' ? 'order-requests' : 'orders';
    await api(`/api/admin/${endpoint}/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }); showMessage('Customer record updated.'); await loadView(state.view);
  } catch (error) { showMessage(error.message, true); button.disabled = false; }
}

document.addEventListener('submit', (event) => { event.preventDefault(); submitForm(event); });
document.addEventListener('input', (event) => {
  if (event.target.matches('[data-search-input],[data-list-search]')) { state.search = event.target.value; syncStatusFilter(); if (state.view === 'catalog') paintProducts(); }
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-request-kind]')) { state.requestKind = event.target.value; paintRequests(); }
  if (event.target.matches('[data-request-status]')) paintRequests();
  if (event.target.matches('[data-order-status]')) paintOrders();
  if (event.target.matches('[data-product-status]')) paintProducts();
});
document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]'); if (nav) { setView(nav.dataset.view); return; }
  const go = event.target.closest('[data-go]'); if (go) { setView(go.dataset.go); return; }
  const stock = event.target.closest('[data-stock-save]'); if (stock) { await saveStock(stock); return; }
  const enquiry = event.target.closest('[data-save-enquiry]'); if (enquiry) { await saveRecord(enquiry, 'enquiry'); return; }
  const request = event.target.closest('[data-save-request]'); if (request) { await saveRecord(request, 'request'); return; }
  const order = event.target.closest('[data-save-order]'); if (order) { await saveRecord(order, 'order'); return; }
  const toggle = event.target.closest('[data-toggle-create]'); if (toggle) { $('#product-create-wrap').hidden = !$('#product-create-wrap').hidden; $('#product-create-form')?.querySelector('input')?.focus(); return; }
  const userAction = event.target.closest('[data-user-action]');
  if (userAction) {
    userAction.disabled = true;
    try { const result = await api(`/api/admin/users/${encodeURIComponent(userAction.dataset.userId)}`, { method: 'PATCH', body: { action: userAction.dataset.userAction } }); if (result.temporaryPassword) showTempPassword(result.temporaryPassword); showMessage('Team account updated.'); await renderTeam(); }
    catch (error) { showMessage(error.message, true); userAction.disabled = false; } return;
  }
  if (event.target.closest('#admin-logout')) {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {}
    state.csrfToken = ''; showAuth(false, true); $('#login-form').reset(); return;
  }
  if (event.target.closest('[data-close-secret]')) { $('#secret-dialog').close(); return; }
  if (event.target.closest('[data-copy-secret]')) {
    try { await navigator.clipboard.writeText($('#temporary-secret').textContent); $('#secret-status').textContent = 'Copied. Share it privately.'; }
    catch { $('#secret-status').textContent = 'Copy is unavailable. Select the password and copy it manually.'; }
  }
});
$('#secret-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
boot();

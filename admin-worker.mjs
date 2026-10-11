const SESSION_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const ENQUIRY_STATES = ['new', 'in_progress', 'quoted', 'won', 'closed'];
const REQUEST_STATES = ['new', 'contacted', 'converted', 'closed'];
const FULFILLMENT_STATES = ['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled'];
const DEFAULT_WHATSAPP_NUMBER = '917888329606';
const PASSWORD_HASH_ITERATIONS = 100000;

function clean(value, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function json(status, data, headers = {}) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers } }); }
function b64url(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function randomToken(length = 32) { const bytes = new Uint8Array(length); crypto.getRandomValues(bytes); return b64url(bytes); }
async function sha256(value) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
async function passwordHash(password) {
  const salt = randomToken(16), key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: PASSWORD_HASH_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${PASSWORD_HASH_ITERATIONS}$${salt}$${b64url(bits)}`;
}
async function passwordMatches(password, encoded) {
  const [kind, rounds, salt, expected] = String(encoded || '').split('$');
  if (kind !== 'pbkdf2' || Number(rounds) !== PASSWORD_HASH_ITERATIONS || !salt || !expected) return false;
  const actual = await passwordHashFromSalt(password, salt, PASSWORD_HASH_ITERATIONS);
  return timingSafeEqual(actual, expected);
}
async function passwordHashFromSalt(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' }, key, 256);
  return b64url(bits);
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function emailValue(value) { return clean(value, 200).toLowerCase(); }
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128; }
function sizesOf(spec) {
  const parts = String(spec || '').split('–').map((part) => part.trim()), alpha = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  if (parts.length === 2 && alpha.includes(parts[0]) && alpha.includes(parts[1])) return alpha.slice(alpha.indexOf(parts[0]), alpha.indexOf(parts[1]) + 1);
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const first = Number(parts[0]), last = Number(parts[1]);
    if (last >= first && (last - first) % 2 === 0 && (last - first) / 2 < 30) return Array.from({ length: (last - first) / 2 + 1 }, (_, i) => String(first + i * 2));
  }
  return String(spec || '').split('/').map((part) => part.trim()).filter(Boolean);
}
function colorsOf(spec) { return String(spec || '').split('/').map((part) => part.trim()).filter(Boolean); }
function productPayload(product, variants = []) {
  return { ...product, price: Number(product.price_paise) / 100, from: Number(product.from_price_paise || 0) / 100, active: Boolean(product.active), sortOrder: Number(product.sort_order || 0), variants: variants.map((item) => ({ size: item.size, color: item.color, stockOnHand: Number(item.stock_on_hand), reserved: Number(item.reserved), available: Math.max(0, Number(item.stock_on_hand) - Number(item.reserved)) })) };
}
function sizesColors(product) { return sizesOf(product.sizes).flatMap((size) => colorsOf(product.color).map((color) => ({ size, color }))); }
async function ensureCatalog(env) {
  const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM products').first();
  if (Number(count?.count || 0)) return;
  const response = await env.ASSETS.fetch(new Request('https://assets.local/products.json'));
  if (!response.ok) throw new Error('Catalogue seed unavailable.');
  const products = await response.json(), now = new Date().toISOString(), statements = [];
  for (const [index, product] of products.entries()) {
    statements.push(env.DB.prepare('INSERT OR IGNORE INTO products (id, name, category, price_paise, from_price_paise, image, color, gsm, fabric, sizes, tag, description, active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
      .bind(clean(product.id, 80), clean(product.name, 120), clean(product.category, 60), Math.round(Number(product.price) * 100), Math.round(Number(product.from || 0) * 100), clean(product.image, 500), clean(product.color, 180), clean(product.gsm, 60), clean(product.fabric, 100), clean(product.sizes, 100), clean(product.tag, 60), clean(product.description, 1200), index, now, now));
    for (const variant of sizesColors(product)) statements.push(env.DB.prepare('INSERT OR IGNORE INTO product_variants (product_id, size, color, stock_on_hand, reserved) VALUES (?, ?, ?, 0, 0)').bind(product.id, variant.size, variant.color));
  }
  if (statements.length) await env.DB.batch(statements);
}
async function getProducts(env, includeInactive = false) {
  await ensureCatalog(env);
  const results = await env.DB.prepare(`SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`).all();
  const products = [];
  for (const product of results.results || []) {
    const stock = await env.DB.prepare('SELECT size, color, stock_on_hand, reserved FROM product_variants WHERE product_id = ? ORDER BY size, color').bind(product.id).all();
    products.push(productPayload(product, stock.results || []));
  }
  return products;
}
async function getSettings(env) {
  const rows = await env.DB.prepare('SELECT setting_key, setting_value FROM admin_settings').all();
  const values = Object.fromEntries((rows.results || []).map((row) => [row.setting_key, row.setting_value]));
  const shippingFeePaise = Number(values.shippingFeePaise ?? env.SHIPPING_FEE_PAISE ?? 0);
  const whatsappNumber = String(values.whatsappNumber || env.WHATSAPP_NUMBER || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, '');
  const updatedAt = new Date().toISOString();
  if (values.shippingFeePaise === undefined) await env.DB.prepare('INSERT OR IGNORE INTO admin_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)').bind('shippingFeePaise', String(shippingFeePaise), updatedAt).run();
  if (values.whatsappNumber === undefined) await env.DB.prepare('INSERT OR IGNORE INTO admin_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?)').bind('whatsappNumber', whatsappNumber, updatedAt).run();
  return { shippingFeePaise, whatsappNumber };
}
async function audit(env, auth, action, targetType, targetId, summary) {
  await env.DB.prepare('INSERT INTO admin_audit_log (id, created_at, user_id, user_email, action, target_type, target_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), new Date().toISOString(), auth.user.id, auth.user.email, clean(action, 80), clean(targetType, 80), clean(targetId, 100), clean(summary, 300)).run();
}
function safeUser(user) { return { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: Boolean(user.must_change_password), active: Boolean(user.active) }; }
function cookieToken(request) {
  const value = request.headers.get('Cookie') || '';
  const entry = value.split(';').map((item) => item.trim()).find((item) => item.startsWith('apria_admin='));
  try { return entry ? decodeURIComponent(entry.slice('apria_admin='.length)) : ''; } catch { return ''; }
}
function setCookie(token, maxAge) { return `apria_admin=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`; }
async function sessionFor(request, env) {
  const raw = cookieToken(request); if (!raw) return null;
  if (String(env.ADMIN_SESSION_SECRET || '').length < 32) return null;
  const session = await env.DB.prepare('SELECT * FROM admin_sessions WHERE token_hash = ? AND expires_at > ?').bind(await sha256(`${env.ADMIN_SESSION_SECRET}|${raw}`), new Date().toISOString()).first();
  if (!session) return null;
  const user = await env.DB.prepare('SELECT * FROM admin_users WHERE id = ? AND active = 1').bind(session.user_id).first();
  return user ? { user, session } : null;
}
function originMatches(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
async function jsonBody(request) {
  const raw = await request.text(); if (raw.length > 60000) throw new Error('Request is too large.');
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('Please submit valid JSON.'); }
}
function decodeId(value) { try { return decodeURIComponent(value); } catch { return ''; } }
function slug(value) { return clean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'garment'; }
function adminProductInput(input, id, existing = {}) {
  const name = clean(input.name, 120), category = clean(input.category, 60), color = clean(input.color, 180), sizes = clean(input.sizes, 100);
  const image = clean(input.image, 500), imagePath = image.startsWith('/') && !image.startsWith('//') && !image.split('/').includes('..') && /^\/[A-Za-z0-9_./-]+$/.test(image), imageOk = /^https:\/\//i.test(image) || imagePath;
  const price = Number(input.price), from = Number(input.from || 0);
  if (!name || !category || !color || !sizes || !imageOk || !Number.isFinite(price) || price <= 0 || price > 500000 || !Number.isFinite(from) || from < 0 || from > 500000 || !sizesOf(sizes).length || !colorsOf(color).length) throw new Error('Enter a name, category, valid image URL, sizes, colours and a retail price above ₹0.');
  return { id, name, category, pricePaise: Math.round(price * 100), fromPricePaise: Math.round(from * 100), image, color, sizes, gsm: clean(input.gsm, 60), fabric: clean(input.fabric, 100), tag: clean(input.tag, 60), description: clean(input.description, 1200), active: input.active === false ? 0 : 1, sortOrder: Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : Number(existing.sort_order || 0) };
}
async function auditMaybe(env, auth, action, targetType, targetId, summary) { if (auth) await audit(env, auth, action, targetType, targetId, summary); }
async function reserveStock(env, orderId, items, expiresAt) {
  const unique = new Map();
  for (const item of items) { const key = `${item.id}|${item.size}|${item.color}`; unique.set(key, { ...item, quantity: (unique.get(key)?.quantity || 0) + item.quantity }); }
  const rows = [...unique.values()];
  const writes = rows.map((item) => env.DB.prepare('UPDATE product_variants SET reserved = reserved + ? WHERE product_id = ? AND size = ? AND color = ? AND stock_on_hand - reserved >= ?')
    .bind(item.quantity, item.id, item.size, item.color, item.quantity));
  const results = await env.DB.batch(writes);
  const changed = rows.filter((_, index) => Number(results[index]?.meta?.changes || 0) === 1);
  if (changed.length !== rows.length) {
    if (changed.length) await env.DB.batch(changed.map((item) => env.DB.prepare('UPDATE product_variants SET reserved = MAX(0, reserved - ?) WHERE product_id = ? AND size = ? AND color = ?').bind(item.quantity, item.id, item.size, item.color)));
    return false;
  }
  const createdAt = new Date().toISOString();
  try {
    await env.DB.batch(rows.map((item) => env.DB.prepare('INSERT INTO stock_reservations (id, order_id, product_id, size, color, quantity, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), orderId, item.id, item.size, item.color, item.quantity, expiresAt, 'reserved', createdAt)));
  } catch (error) {
    await env.DB.batch(rows.map((item) => env.DB.prepare('UPDATE product_variants SET reserved = MAX(0, reserved - ?) WHERE product_id = ? AND size = ? AND color = ?').bind(item.quantity, item.id, item.size, item.color)));
    throw error;
  }
  return true;
}
async function resolveReservation(env, orderId, resultStatus) {
  const rows = await env.DB.prepare("SELECT * FROM stock_reservations WHERE order_id = ? AND status = 'reserved'").bind(orderId).all();
  if (!rows.results?.length) return;
  const statements = [];
  for (const item of rows.results) {
    statements.push(resultStatus === 'committed'
      ? env.DB.prepare("UPDATE product_variants SET reserved = MAX(0, reserved - ?), stock_on_hand = MAX(0, stock_on_hand - ?) WHERE product_id = ? AND size = ? AND color = ? AND EXISTS (SELECT 1 FROM stock_reservations WHERE id = ? AND status = 'reserved')").bind(item.quantity, item.quantity, item.product_id, item.size, item.color, item.id)
      : env.DB.prepare("UPDATE product_variants SET reserved = MAX(0, reserved - ?) WHERE product_id = ? AND size = ? AND color = ? AND EXISTS (SELECT 1 FROM stock_reservations WHERE id = ? AND status = 'reserved')").bind(item.quantity, item.product_id, item.size, item.color, item.id));
    statements.push(env.DB.prepare('UPDATE stock_reservations SET status = ? WHERE id = ? AND status = ?').bind(resultStatus, item.id, 'reserved'));
  }
  await env.DB.batch(statements);
}
async function logIn(env, request, email, password) {
  if (String(env.ADMIN_SESSION_SECRET || '').length < 32) return json(503, { error: 'Set a random ADMIN_SESSION_SECRET of at least 32 characters in Worker secrets.' });
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown', key = await sha256(`${email}|${ip}`), now = new Date();
  const row = await env.DB.prepare('SELECT * FROM admin_login_attempts WHERE attempt_key = ?').bind(key).first();
  const fresh = !row || now.getTime() - Date.parse(row.window_started_at) >= ATTEMPT_WINDOW_MS;
  if (!fresh && Number(row.failures) >= MAX_LOGIN_FAILURES) return json(429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
  const user = await env.DB.prepare('SELECT * FROM admin_users WHERE email = ? COLLATE NOCASE AND active = 1').bind(email).first();
  if (!user || !(await passwordMatches(String(password || ''), user.password_hash))) {
    const failures = fresh ? 1 : Number(row.failures) + 1, started = fresh ? now.toISOString() : row.window_started_at;
    await env.DB.prepare('INSERT INTO admin_login_attempts (attempt_key, failures, window_started_at) VALUES (?, ?, ?) ON CONFLICT(attempt_key) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at').bind(key, failures, started).run();
    return json(401, { error: 'Email or password is incorrect.' });
  }
  await env.DB.prepare('DELETE FROM admin_login_attempts WHERE attempt_key = ?').bind(key).run();
  const raw = randomToken(), csrf = randomToken(24), createdAt = now.toISOString(), expiresAt = new Date(now.getTime() + SESSION_MS).toISOString();
  await env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?').bind(createdAt).run();
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await sha256(`${env.ADMIN_SESSION_SECRET}|${raw}`), user.id, csrf, createdAt, expiresAt).run();
  return json(200, { ...safeUser(user), csrfToken: csrf, expiresAt }, { 'Set-Cookie': setCookie(raw, SESSION_MS / 1000) });
}
async function handleOrderRequest(request, env) {
  const input = await jsonBody(request), products = await getProducts(env), name = clean(input.name, 100), email = emailValue(input.email), phone = clean(input.phone, 40);
  const address = { address1: clean(input.address?.address1, 200), address2: clean(input.address?.address2, 200), city: clean(input.address?.city, 80), state: clean(input.address?.state, 80), pincode: clean(input.address?.pincode, 6) };
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.replace(/\D/g, '').length < 10 || !address.address1 || !address.city || !address.state || !/^\d{6}$/.test(address.pincode)) throw new Error('Enter your name, valid email and phone, and a complete Indian delivery address.');
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 20) throw new Error('Your order must contain 1 to 20 garment options.');
  const items = [];
  for (const row of input.items) {
    const product = products.find((item) => item.id === clean(row?.id, 80)), size = clean(row?.size, 20), color = clean(row?.color, 80), quantity = Number(row?.quantity);
    if (!product || !sizesOf(product.sizes).includes(size) || !colorsOf(product.color).includes(color) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('A garment option is no longer available. Refresh and try again.');
    items.push({ id: product.id, name: product.name, size, color, quantity, unitPricePaise: Math.round(product.price * 100), lineTotalPaise: Math.round(product.price * 100) * quantity });
  }
  const settings = await getSettings(env), amount = items.reduce((sum, item) => sum + item.lineTotalPaise, 0) + settings.shippingFeePaise, id = crypto.randomUUID(), now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO order_requests (id, created_at, name, email, phone, address_json, items_json, amount_estimate_paise, status, admin_note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, now, name, email, phone, JSON.stringify(address), JSON.stringify(items), amount, 'new', '', now).run();
  return json(201, { ok: true, id });
}

export async function handleAdminRequest(request, env, url) {
  if (url.pathname === '/api/order-requests' && request.method === 'POST') {
    try { return await handleOrderRequest(request, env); } catch (error) { return json(400, { error: error.message || 'Unable to save your order request.' }); }
  }
  if (!url.pathname.startsWith('/api/admin/')) return null;
  try {
    if (url.pathname === '/api/admin/status' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_users').first();
      return json(200, { setupRequired: Number(row?.count || 0) === 0, setupEnabled: String(env.ADMIN_SETUP_TOKEN || '').length >= 32 && String(env.ADMIN_SESSION_SECRET || '').length >= 32 });
    }
    if (url.pathname === '/api/admin/setup' && request.method === 'POST') {
      const input = await jsonBody(request);
      if (String(env.ADMIN_SETUP_TOKEN || '').length < 32 || String(env.ADMIN_SESSION_SECRET || '').length < 32) return json(503, { error: 'Set independent random ADMIN_SETUP_TOKEN and ADMIN_SESSION_SECRET values of at least 32 characters.' });
      if (!timingSafeEqual(String(input.setupToken || ''), String(env.ADMIN_SETUP_TOKEN))) return json(403, { error: 'Setup code is not valid.' });
      const email = emailValue(input.email), name = clean(input.name, 100), password = input.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || !validPassword(password)) return json(400, { error: 'Enter your name, a valid email, and a password with at least 12 characters.' });
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM admin_users').first();
      if (Number(count?.count || 0)) return json(409, { error: 'Owner setup has already been completed.' });
      const now = new Date().toISOString(), user = { id: crypto.randomUUID(), email, name, password_hash: await passwordHash(password), role: 'owner', must_change_password: 0, active: 1 };
      const inserted = await env.DB.prepare('INSERT OR IGNORE INTO admin_users (id, email, name, password_hash, role, must_change_password, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)')
        .bind(user.id, user.email, user.name, user.password_hash, user.role, now, now).run();
      if (!Number(inserted.meta?.changes || 0)) return json(409, { error: 'Owner setup has already been completed.' });
      const auth = { user };
      await audit(env, auth, 'owner_setup', 'user', user.id, 'Created the initial owner account.');
      const raw = randomToken(), csrf = randomToken(24), expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
      await env.DB.prepare('INSERT INTO admin_sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await sha256(`${env.ADMIN_SESSION_SECRET}|${raw}`), user.id, csrf, now, expiresAt).run();
      return json(201, { ...safeUser(user), csrfToken: csrf, expiresAt }, { 'Set-Cookie': setCookie(raw, SESSION_MS / 1000) });
    }
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
      const input = await jsonBody(request); return logIn(env, request, emailValue(input.email), input.password);
    }
    const auth = await sessionFor(request, env);
    if (url.pathname === '/api/admin/session' && request.method === 'GET') return auth ? json(200, { ...safeUser(auth.user), csrfToken: auth.session.csrf_token, expiresAt: auth.session.expires_at }) : json(401, { error: 'Sign in to continue.' });
    if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
      if (!auth) return json(200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
      if (!originMatches(request) || request.headers.get('X-CSRF-Token') !== auth.session.csrf_token) return json(403, { error: 'Security check failed. Refresh and try again.' });
      await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(auth.session.token_hash).run();
      return json(200, { ok: true }, { 'Set-Cookie': setCookie('', 0) });
    }
    if (!auth) return json(401, { error: 'Sign in to continue.' });
    const route = url.pathname.slice('/api/admin'.length).replace(/\/$/, '') || '/', method = request.method, owner = auth.user.role === 'owner';
    if (auth.user.must_change_password && route !== '/password') return json(403, { error: 'Change your temporary password before continuing.' });
    if (!['GET', 'HEAD'].includes(method) && (!originMatches(request) || request.headers.get('X-CSRF-Token') !== auth.session.csrf_token)) return json(403, { error: 'Security check failed. Refresh and try again.' });
    const staffAllowed = route === '/overview' || route === '/enquiries' || route.startsWith('/enquiries/') || route === '/order-requests' || route.startsWith('/order-requests/') || route === '/orders' || route.startsWith('/orders/') || route === '/audit' || route === '/password';
    if (!owner && !staffAllowed) return json(403, { error: 'This action is available to the owner only.' });
    if (route === '/password' && method === 'PUT') {
      const input = await jsonBody(request);
      if (!validPassword(input.newPassword)) return json(400, { error: 'Choose a password with at least 12 characters.' });
      const user = await env.DB.prepare('SELECT * FROM admin_users WHERE id = ?').bind(auth.user.id).first();
      if (!user || !(await passwordMatches(String(input.currentPassword || ''), user.password_hash))) return json(401, { error: 'Current password is incorrect.' });
      await env.DB.prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').bind(await passwordHash(input.newPassword), new Date().toISOString(), user.id).run();
      await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, auth.session.token_hash).run();
      await audit(env, auth, 'password_changed', 'user', user.id, 'Changed account password.');
      return json(200, { ok: true });
    }
    if (route === '/overview' && method === 'GET') {
      const [enquiries, requests, orders, pending, sales, variants] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS count FROM enquiries WHERE status = 'new'").first(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM order_requests WHERE status NOT IN ('converted', 'closed')").first(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE status = 'paid' AND fulfillment_status != 'delivered'").first(),
        env.DB.prepare("SELECT COUNT(*) AS count FROM payment_orders WHERE status IN ('created', 'authorized')").first(),
        env.DB.prepare("SELECT COALESCE(SUM(amount_paise), 0) AS total FROM payment_orders WHERE status = 'paid'").first(),
        env.DB.prepare('SELECT COUNT(*) AS count FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active = 1 AND v.stock_on_hand - v.reserved <= 3').first()
      ]);
      return json(200, { newEnquiries: enquiries.count, openRequests: requests.count, ordersToFulfill: orders.count, pendingPayments: pending.count, salesPaise: sales.total, lowStock: variants.count });
    }
    if (route === '/products' && method === 'GET') return json(200, { products: await getProducts(env, owner) });
    const productMatch = route.match(/^\/products\/([^/]+)(?:\/(stock))?$/);
    if (route === '/products' && method === 'POST' && owner) {
      const input = await jsonBody(request), products = await getProducts(env, true), id = `${slug(input.name)}-${randomToken(4).slice(0, 6)}`;
      const item = adminProductInput(input, id, { sort_order: products.length }), now = new Date().toISOString();
      await env.DB.prepare('INSERT INTO products (id, name, category, price_paise, from_price_paise, image, color, gsm, fabric, sizes, tag, description, active, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(item.id, item.name, item.category, item.pricePaise, item.fromPricePaise, item.image, item.color, item.gsm, item.fabric, item.sizes, item.tag, item.description, item.active, item.sortOrder, now, now).run();
      const variants = sizesColors(item);
      if (variants.length) await env.DB.batch(variants.map((variant) => env.DB.prepare('INSERT INTO product_variants (product_id, size, color, stock_on_hand, reserved) VALUES (?, ?, ?, 0, 0)').bind(id, variant.size, variant.color)));
      await audit(env, auth, 'product_created', 'product', id, `Created ${item.name}.`);
      return json(201, { product: (await getProducts(env, true)).find((entry) => entry.id === id) });
    }
    if (productMatch && method === 'PUT' && !productMatch[2] && owner) {
      const id = decodeId(productMatch[1]), input = await jsonBody(request), existing = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
      if (!existing) return json(404, { error: 'Product not found.' });
      const item = adminProductInput(input, id, existing), now = new Date().toISOString();
      await env.DB.prepare('UPDATE products SET name = ?, category = ?, price_paise = ?, from_price_paise = ?, image = ?, color = ?, gsm = ?, fabric = ?, sizes = ?, tag = ?, description = ?, active = ?, sort_order = ?, updated_at = ? WHERE id = ?')
        .bind(item.name, item.category, item.pricePaise, item.fromPricePaise, item.image, item.color, item.gsm, item.fabric, item.sizes, item.tag, item.description, item.active, item.sortOrder, now, id).run();
      const variants = sizesColors(item), current = await env.DB.prepare('SELECT * FROM product_variants WHERE product_id = ?').bind(id).all(), currentMap = new Map((current.results || []).map((row) => [`${row.size}|${row.color}`, row]));
      const statements = variants.map((variant) => {
        const old = currentMap.get(`${variant.size}|${variant.color}`);
        return old ? env.DB.prepare('UPDATE product_variants SET stock_on_hand = ? WHERE product_id = ? AND size = ? AND color = ? AND stock_on_hand >= reserved').bind(old.stock_on_hand, id, variant.size, variant.color)
          : env.DB.prepare('INSERT OR IGNORE INTO product_variants (product_id, size, color, stock_on_hand, reserved) VALUES (?, ?, ?, 0, 0)').bind(id, variant.size, variant.color);
      });
      if (statements.length) await env.DB.batch(statements);
      const kept = new Set(variants.map((item) => `${item.size}|${item.color}`));
      for (const old of current.results || []) if (!kept.has(`${old.size}|${old.color}`) && Number(old.reserved) === 0) await env.DB.prepare('DELETE FROM product_variants WHERE product_id = ? AND size = ? AND color = ?').bind(id, old.size, old.color).run();
      await audit(env, auth, 'product_updated', 'product', id, `Updated ${item.name}.`);
      return json(200, { product: (await getProducts(env, true)).find((entry) => entry.id === id) });
    }
    if (productMatch && method === 'PATCH' && productMatch[2] && owner) {
      const id = decodeId(productMatch[1]), input = await jsonBody(request), quantity = Number(input.stockOnHand);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) return json(400, { error: 'Stock must be a whole number from 0 to 1,000,000.' });
      const result = await env.DB.prepare('UPDATE product_variants SET stock_on_hand = ? WHERE product_id = ? AND size = ? AND color = ? AND ? >= reserved').bind(quantity, id, clean(input.size, 20), clean(input.color, 80), quantity).run();
      if (!Number(result.meta?.changes || 0)) return json(409, { error: 'Variant not found, or stock cannot be reduced below quantities reserved for checkout.' });
      await audit(env, auth, 'stock_updated', 'product_variant', `${id}|${input.size}|${input.color}`, `Set variant stock to ${quantity}.`);
      return json(200, { ok: true, stockOnHand: quantity });
    }
    if (route === '/enquiries' && method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM enquiries ORDER BY created_at DESC LIMIT 500').all();
      return json(200, { enquiries: (rows.results || []).map((item) => ({ ...item, items: parseArray(item.items_json), createdAt: item.created_at, updatedAt: item.updated_at, adminNote: item.admin_note, status: item.status })) });
    }
    const enquiryMatch = route.match(/^\/enquiries\/([^/]+)$/);
    if (enquiryMatch && method === 'PATCH') {
      const id = decodeId(enquiryMatch[1]), input = await jsonBody(request);
      if (!ENQUIRY_STATES.includes(input.status)) return json(400, { error: 'Choose a valid enquiry status.' });
      const result = await env.DB.prepare('UPDATE enquiries SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?').bind(input.status, clean(input.adminNote, 3000), new Date().toISOString(), id).run();
      if (!Number(result.meta?.changes || 0)) return json(404, { error: 'Enquiry not found.' });
      await audit(env, auth, 'enquiry_updated', 'enquiry', id, `Changed enquiry status to ${input.status}.`);
      return json(200, { ok: true });
    }
    if (route === '/order-requests' && method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM order_requests ORDER BY created_at DESC LIMIT 500').all();
      return json(200, { orderRequests: (rows.results || []).map((item) => ({ id: item.id, createdAt: item.created_at, updatedAt: item.updated_at, name: item.name, email: item.email, phone: item.phone, address: parseObject(item.address_json), items: parseArray(item.items_json), amountEstimatePaise: item.amount_estimate_paise, status: item.status, adminNote: item.admin_note })) });
    }
    const requestMatch = route.match(/^\/order-requests\/([^/]+)$/);
    if (requestMatch && method === 'PATCH') {
      const id = decodeId(requestMatch[1]), input = await jsonBody(request);
      if (!REQUEST_STATES.includes(input.status)) return json(400, { error: 'Choose a valid order request status.' });
      const result = await env.DB.prepare('UPDATE order_requests SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?').bind(input.status, clean(input.adminNote, 3000), new Date().toISOString(), id).run();
      if (!Number(result.meta?.changes || 0)) return json(404, { error: 'Order request not found.' });
      await audit(env, auth, 'request_updated', 'order_request', id, `Changed request status to ${input.status}.`);
      return json(200, { ok: true });
    }
    if (route === '/orders' && method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM payment_orders ORDER BY created_at DESC LIMIT 500').all();
      return json(200, { orders: (rows.results || []).map((item) => ({ id: item.id, razorpayOrderId: item.razorpay_order_id, amountPaise: item.amount_paise, currency: item.currency, status: item.status, paymentId: item.payment_id, customer: parseObject(item.customer_json), items: parseArray(item.items_json), createdAt: item.created_at, updatedAt: item.updated_at, fulfillmentStatus: item.fulfillment_status, adminNote: item.admin_note, reservationExpiresAt: item.reservation_expires_at })) });
    }
    const orderMatch = route.match(/^\/orders\/([^/]+)$/);
    if (orderMatch && method === 'PATCH') {
      const id = decodeId(orderMatch[1]), input = await jsonBody(request);
      if (!FULFILLMENT_STATES.includes(input.fulfillmentStatus)) return json(400, { error: 'Choose a valid fulfilment status.' });
      const result = await env.DB.prepare("UPDATE payment_orders SET fulfillment_status = ?, admin_note = ?, updated_at = ? WHERE id = ? AND status = 'paid'").bind(input.fulfillmentStatus, clean(input.adminNote, 3000), new Date().toISOString(), id).run();
      if (!Number(result.meta?.changes || 0)) {
        const existing = await env.DB.prepare('SELECT status FROM payment_orders WHERE id = ?').bind(id).first();
        return existing ? json(409, { error: 'Fulfilment can only be updated after Razorpay confirms a captured payment.' }) : json(404, { error: 'Order not found.' });
      }
      await audit(env, auth, 'fulfillment_updated', 'order', id, `Changed fulfilment to ${input.fulfillmentStatus}.`);
      return json(200, { ok: true });
    }
    if (route === '/settings' && method === 'GET' && owner) return json(200, await getSettings(env));
    if (route === '/settings' && method === 'PUT' && owner) {
      const input = await jsonBody(request), fee = Number(input.shippingFeePaise), phone = clean(input.whatsappNumber, 24).replace(/\D/g, '');
      if (!Number.isSafeInteger(fee) || fee < 0 || fee > 5000000 || (phone && (phone.length < 8 || phone.length > 15))) return json(400, { error: 'Enter a valid delivery fee and international WhatsApp number.' });
      const now = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare('INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at').bind('shippingFeePaise', String(fee), now),
        env.DB.prepare('INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at').bind('whatsappNumber', phone, now)
      ]);
      await audit(env, auth, 'settings_updated', 'settings', 'shop', 'Updated shop contact or delivery settings.');
      return json(200, { shippingFeePaise: fee, whatsappNumber: phone });
    }
    if (route === '/users' && method === 'GET' && owner) {
      const rows = await env.DB.prepare('SELECT * FROM admin_users ORDER BY created_at').all(); return json(200, { users: (rows.results || []).map(safeUser) });
    }
    if (route === '/users' && method === 'POST' && owner) {
      const input = await jsonBody(request), email = emailValue(input.email), name = clean(input.name, 100);
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'Enter a name and valid email address.' });
      const temp = randomToken(15), now = new Date().toISOString(), id = crypto.randomUUID();
      try { await env.DB.prepare('INSERT INTO admin_users (id, email, name, password_hash, role, must_change_password, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)').bind(id, email, name, await passwordHash(temp), 'staff', now, now).run(); }
      catch { return json(409, { error: 'An account already uses this email.' }); }
      await audit(env, auth, 'staff_created', 'user', id, `Created staff access for ${email}.`);
      return json(201, { user: { id, email, name, role: 'staff', mustChangePassword: true, active: true }, temporaryPassword: temp });
    }
    const userMatch = route.match(/^\/users\/([^/]+)$/);
    if (userMatch && method === 'PATCH' && owner) {
      const id = decodeId(userMatch[1]), input = await jsonBody(request), temp = input.action === 'reset-password' ? randomToken(15) : '';
      const user = await env.DB.prepare("SELECT * FROM admin_users WHERE id = ? AND role = 'staff'").bind(id).first();
      if (!user) return json(404, { error: 'Staff account not found.' });
      if (!['activate', 'deactivate', 'reset-password'].includes(input.action)) return json(400, { error: 'Unknown staff account action.' });
      const now = new Date().toISOString();
      if (input.action === 'reset-password') {
        await env.DB.prepare('UPDATE admin_users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').bind(await passwordHash(temp), now, id).run();
        await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(id).run();
      } else {
        await env.DB.prepare('UPDATE admin_users SET active = ?, updated_at = ? WHERE id = ?').bind(input.action === 'activate' ? 1 : 0, now, id).run();
        if (input.action === 'deactivate') await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(id).run();
      }
      await audit(env, auth, `staff_${input.action}`, 'user', id, `Updated staff account ${user.email}.`);
      return json(200, { ok: true, ...(temp ? { temporaryPassword: temp } : {}) });
    }
    if (route === '/audit' && method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT 250').all(); return json(200, { audit: rows.results || [] });
    }
    return json(404, { error: 'Admin endpoint not found.' });
  } catch (error) { return json(400, { error: error.message || 'Unable to complete the admin request.' }); }
}

function parseArray(value) { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function parseObject(value) { try { const parsed = JSON.parse(value || '{}'); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }

export async function publicProducts(env) { return getProducts(env, false); }
export async function publicSettings(env) { return getSettings(env); }
export async function createStockReservation(env, orderId, items, expiresAt) { return reserveStock(env, orderId, items, expiresAt); }
export async function resolveStockReservation(env, orderId, resultStatus) { return resolveReservation(env, orderId, resultStatus); }
export async function reconcileExpiredReservations(env) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return;
  const expired = await env.DB.prepare("SELECT DISTINCT p.* FROM payment_orders p JOIN stock_reservations r ON r.order_id = p.id WHERE r.status = 'reserved' AND r.expires_at <= ? AND p.status IN ('created', 'authorized') LIMIT 25").bind(new Date().toISOString()).all();
  for (const order of expired.results || []) {
    try {
      const auth = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
      const result = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(order.razorpay_order_id)}/payments`, { headers: { Authorization: `Basic ${auth}` } });
      if (!result.ok) continue;
      const payments = await result.json(), rows = payments.items || [];
      const captured = rows.find((payment) => payment.status === 'captured' && payment.captured === true && payment.order_id === order.razorpay_order_id);
      const authorized = rows.find((payment) => payment.status === 'authorized' && payment.order_id === order.razorpay_order_id);
      if (captured) {
        const status = await env.DB.prepare("UPDATE payment_orders SET status = 'paid', payment_id = ?, updated_at = ? WHERE id = ? AND status != 'paid'").bind(captured.id, new Date().toISOString(), order.id).run();
        if (Number(status.meta?.changes || 0)) await resolveReservation(env, order.id, 'committed');
      } else if (authorized) {
        await env.DB.prepare("UPDATE payment_orders SET status = 'authorized', payment_id = ?, reservation_expires_at = ? WHERE id = ?").bind(authorized.id, new Date(Date.now() + 15 * 60 * 1000).toISOString(), order.id).run();
        await env.DB.prepare("UPDATE stock_reservations SET expires_at = ? WHERE order_id = ? AND status = 'reserved'").bind(new Date(Date.now() + 15 * 60 * 1000).toISOString(), order.id).run();
      } else {
        await env.DB.prepare("UPDATE payment_orders SET status = 'failed', updated_at = ? WHERE id = ? AND status != 'paid'").bind(new Date().toISOString(), order.id).run();
        await resolveReservation(env, order.id, 'released');
      }
    } catch { /* Retry unresolved reservations on the next scheduled reconciliation. */ }
  }
}

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, createHash, pbkdf2Sync, timingSafeEqual } = require('node:crypto');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA, 'admin-data.json');
const DEFAULT_WHATSAPP_NUMBER = '917888329606';
const SESSION_MS = 8 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const ENQUIRY_STATES = ['new', 'in_progress', 'quoted', 'won', 'closed'];
const REQUEST_STATES = ['new', 'contacted', 'converted', 'closed'];
const FULFILLMENT_STATES = ['unfulfilled', 'processing', 'shipped', 'delivered', 'cancelled'];
let storeQueue = Promise.resolve();
let initPromise;

function clean(value, max = 500) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
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
function productVariants(product, existing = []) {
  const current = new Map(existing.map((row) => [`${row.size}|${row.color}`, row]));
  return sizesOf(product.sizes).flatMap((size) => colorsOf(product.color).map((color) => {
    const prior = current.get(`${size}|${color}`);
    return { size, color, stockOnHand: Math.max(0, Number.parseInt(prior?.stockOnHand, 10) || 0), reserved: Math.max(0, Number.parseInt(prior?.reserved, 10) || 0) };
  }));
}
function normalizeProduct(input, id, existing = {}) {
  const name = clean(input.name, 120), category = clean(input.category, 60), color = clean(input.color, 180), sizes = clean(input.sizes, 100);
  const image = clean(input.image, 500), imagePath = image.startsWith('/') && !image.startsWith('//') && !image.split('/').includes('..') && /^\/[A-Za-z0-9_./-]+$/.test(image), imageOk = /^https:\/\//i.test(image) || imagePath;
  const price = Number(input.price), from = Number(input.from || 0);
  if (!name || !category || !color || !sizes || !imageOk || !Number.isFinite(price) || price <= 0 || price > 500000 || !Number.isFinite(from) || from < 0 || from > 500000) throw new Error('Enter a name, category, valid image URL, sizes, colours and a retail price above ₹0.');
  if (!sizesOf(sizes).length || !colorsOf(color).length) throw new Error('Add at least one size and colour.');
  const product = { ...existing, id, name, category, price, from, image, color, sizes, gsm: clean(input.gsm, 60), fabric: clean(input.fabric, 100), tag: clean(input.tag, 60), description: clean(input.description, 1200), active: input.active !== false, sortOrder: Number.isInteger(Number(input.sortOrder)) ? Number(input.sortOrder) : (existing.sortOrder || 0), updatedAt: new Date().toISOString() };
  product.variants = productVariants(product, existing.variants || []);
  return product;
}
function blankStore() { return { version: 1, users: [], sessions: [], attempts: {}, products: [], enquiries: [], orderRequests: [], orders: [], settings: null, audit: [] }; }
async function makeInitialStore() {
  const store = blankStore(), sourceProducts = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'public', 'products.json'), 'utf8'));
  store.products = sourceProducts.map((product, index) => normalizeProduct({ ...product, active: true, sortOrder: index }, product.id));
  store.settings = { whatsappNumber: (process.env.WHATSAPP_NUMBER || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, ''), shippingFeePaise: Math.max(0, Number.parseInt(process.env.SHIPPING_FEE_PAISE || '0', 10) || 0) };
  try {
    const lines = (await fs.promises.readFile(path.join(DATA, 'enquiries.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean);
    store.enquiries = lines.map((line) => { try { const item = JSON.parse(line), createdAt = item.createdAt || new Date().toISOString(); return { ...item, status: 'new', adminNote: '', updatedAt: createdAt }; } catch { return null; } }).filter(Boolean);
  } catch {}
  try {
    const oldOrders = JSON.parse(await fs.promises.readFile(path.join(DATA, 'orders.json'), 'utf8'));
    store.orders = Array.isArray(oldOrders) ? oldOrders.map((order) => ({ fulfillmentStatus: 'unfulfilled', adminNote: '', reservationStatus: 'none', reservationExpiresAt: '', ...order })) : [];
  } catch {}
  return store;
}
async function atomicSave(store) {
  await fs.promises.mkdir(DATA, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.rename(temporary, STORE_FILE);
}
async function ensureStore() {
  if (!initPromise) initPromise = (async () => {
    await fs.promises.mkdir(DATA, { recursive: true });
    try {
      const store = JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf8'));
      Object.assign(store, { ...blankStore(), ...store });
      if (!store.settings) store.settings = { whatsappNumber: (process.env.WHATSAPP_NUMBER || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, ''), shippingFeePaise: 0 };
      else if (!store.settings.whatsappNumber) store.settings.whatsappNumber = (process.env.WHATSAPP_NUMBER || DEFAULT_WHATSAPP_NUMBER).replace(/\D/g, '');
      if (!Array.isArray(store.products) || !store.products.length) store.products = (await makeInitialStore()).products;
      await atomicSave(store);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error instanceof SyntaxError) throw new Error('Local admin data is unreadable. Restore data/admin-data.json from backup before continuing.', { cause: error });
        throw error;
      }
      await atomicSave(await makeInitialStore());
    }
  })();
  return initPromise;
}
async function readStore() { await ensureStore(); await storeQueue; return JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf8')); }
async function updateStore(callback) {
  await ensureStore(); let result;
  const operation = storeQueue.then(async () => { const store = JSON.parse(await fs.promises.readFile(STORE_FILE, 'utf8')); result = await callback(store); await atomicSave(store); });
  storeQueue = operation.catch(() => {}); await operation; return result;
}
function pbkdf2(password, salt) { return pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('base64url'); }
function passwordHash(password) { const salt = randomBytes(16).toString('base64url'); return `pbkdf2$210000$${salt}$${pbkdf2(password, salt)}`; }
function passwordMatches(password, encoded) {
  const [kind, rounds, salt, expected] = String(encoded || '').split('$'); if (kind !== 'pbkdf2' || Number(rounds) !== 210000 || !salt || !expected) return false;
  const actual = Buffer.from(pbkdf2(password, salt)), wanted = Buffer.from(expected); return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function sessionHash(value) { return hash(`${process.env.ADMIN_SESSION_SECRET || ''}|${value}`); }
function token(bytes = 32) { return randomBytes(bytes).toString('base64url'); }
function validPassword(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 128; }
function emailValue(value) { return clean(value, 200).toLowerCase(); }
function json(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...headers }); res.end(JSON.stringify(value)); }
function parseBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', (chunk) => { body += chunk; if (body.length > 60000) { reject(new Error('Request is too large.')); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Please submit valid JSON.')); } }); req.on('error', reject); }); }
function cookieToken(req) { const entry = String(req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('apria_admin=')); try { return entry ? decodeURIComponent(entry.slice('apria_admin='.length)) : ''; } catch { return ''; } }
function cookieHeader(req, value, age) { const secure = Boolean(req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'); return `apria_admin=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`; }
async function sessionFor(req, store) {
  const raw = cookieToken(req); if (!raw) return null;
  const session = store.sessions.find((entry) => entry.tokenHash === sessionHash(raw) && Date.parse(entry.expiresAt) > Date.now());
  if (!session) return null;
  const user = store.users.find((entry) => entry.id === session.userId && entry.active); return user ? { user, session } : null;
}
function safeUser(user) { return { id: user.id, email: user.email, name: user.name, role: user.role, mustChangePassword: Boolean(user.mustChangePassword), active: Boolean(user.active) }; }
function audit(store, auth, action, targetType, targetId, summary) { store.audit.unshift({ id: randomUUID(), createdAt: new Date().toISOString(), userId: auth.user.id, userEmail: auth.user.email, action, targetType, targetId: clean(targetId, 100), summary: clean(summary, 300) }); store.audit.length = Math.min(store.audit.length, 1000); }
function productView(product) { return { ...product, variants: product.variants.map((row) => ({ ...row, available: Math.max(0, row.stockOnHand - row.reserved) })) }; }
function setSession(req, res, store, user) {
  const raw = token(), csrfToken = token(24), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + SESSION_MS).toISOString();
  store.sessions = store.sessions.filter((entry) => Date.parse(entry.expiresAt) > Date.now());
  store.sessions.push({ tokenHash: sessionHash(raw), userId: user.id, csrfToken, createdAt, expiresAt });
  res.setHeader('Set-Cookie', cookieHeader(req, raw, SESSION_MS / 1000)); return { ...safeUser(user), csrfToken, expiresAt };
}
function originMatches(req) { if (!req.headers.origin) return true; try { return new URL(req.headers.origin).host === String(req.headers.host || ''); } catch { return false; } }
function slug(value) { return clean(value, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 56) || 'garment'; }
function sortCreated(a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); }
function cartVariants(store, items, requireStock = false) {
  if (!Array.isArray(items) || !items.length || items.length > 20) throw new Error('Your order must contain 1 to 20 garment options.');
  const merged = new Map();
  for (const raw of items) {
    const product = store.products.find((entry) => entry.id === clean(raw?.id, 80) && entry.active), size = clean(raw?.size, 20), color = clean(raw?.color, 80), quantity = Number(raw?.quantity);
    const variant = product?.variants.find((row) => row.size === size && row.color === color);
    if (!product || !variant || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('A garment option is no longer available. Refresh and try again.');
    const key = `${product.id}|${size}|${color}`, previous = merged.get(key);
    merged.set(key, { product, variant, size, color, quantity: (previous?.quantity || 0) + quantity });
  }
  return [...merged.values()].map((row) => {
    if (row.quantity > 100) throw new Error('A garment quantity exceeds the allowed limit.');
    if (requireStock && row.variant.stockOnHand - row.variant.reserved < row.quantity) throw new Error(`${row.product.name} (${row.size}, ${row.color}) is out of stock or has insufficient quantity.`);
    const unitPricePaise = Math.round(row.product.price * 100);
    return { id: row.product.id, name: row.product.name, size: row.size, color: row.color, quantity: row.quantity, unitPricePaise, lineTotalPaise: unitPricePaise * row.quantity };
  });
}
async function createOrderRequest(req, res) {
  try {
    const input = await parseBody(req), store = await readStore(), name = clean(input.name, 100), email = emailValue(input.email), phone = clean(input.phone, 40);
    const address = { address1: clean(input.address?.address1, 200), address2: clean(input.address?.address2, 200), city: clean(input.address?.city, 80), state: clean(input.address?.state, 80), pincode: clean(input.address?.pincode, 6) };
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phone.replace(/\D/g, '').length < 10 || !address.address1 || !address.city || !address.state || !/^\d{6}$/.test(address.pincode)) throw new Error('Enter your name, valid email and phone, and a complete Indian delivery address.');
    const items = cartVariants(store, input.items, false), amountEstimatePaise = items.reduce((sum, item) => sum + item.lineTotalPaise, 0) + Number(store.settings.shippingFeePaise || 0), now = new Date().toISOString();
    const request = { id: randomUUID(), createdAt: now, updatedAt: now, name, email, phone, address, items, amountEstimatePaise, status: 'new', adminNote: '' };
    await updateStore((current) => { current.orderRequests.unshift(request); }); return json(res, 201, { ok: true, id: request.id });
  } catch (error) { return json(res, 400, { error: error.message || 'Unable to save your order request.' }); }
}
function validStatus(value, statuses) { return statuses.includes(value); }

async function handleAdminRequest(req, res, url) {
  if (url.pathname === '/api/order-requests' && req.method === 'POST') { await createOrderRequest(req, res); return true; }
  if (!url.pathname.startsWith('/api/admin/')) return false;
  await ensureStore();
  const route = url.pathname.slice('/api/admin'.length).replace(/\/$/, '') || '/', method = req.method;
  try {
    if (route === '/status' && method === 'GET') {
      const store = await readStore(); return json(res, 200, { setupRequired: store.users.length === 0, setupEnabled: String(process.env.ADMIN_SETUP_TOKEN || '').length >= 32 && String(process.env.ADMIN_SESSION_SECRET || '').length >= 32 });
    }
    if (route === '/setup' && method === 'POST') {
      const input = await parseBody(req);
      if (String(process.env.ADMIN_SETUP_TOKEN || '').length < 32 || String(process.env.ADMIN_SESSION_SECRET || '').length < 32) return json(res, 503, { error: 'Set independent random ADMIN_SETUP_TOKEN and ADMIN_SESSION_SECRET values of at least 32 characters in .env.' });
      const provided = Buffer.from(String(input.setupToken || '')), expected = Buffer.from(process.env.ADMIN_SETUP_TOKEN);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return json(res, 403, { error: 'Setup code is not valid.' });
      const email = emailValue(input.email), name = clean(input.name, 100), password = input.password;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || !validPassword(password)) return json(res, 400, { error: 'Enter your name, a valid email, and a password with at least 12 characters.' });
      const result = await updateStore((store) => {
        if (store.users.length) return { error: 'Owner setup has already been completed.' };
        const now = new Date().toISOString(), user = { id: randomUUID(), email, name, passwordHash: passwordHash(password), role: 'owner', mustChangePassword: false, active: true, createdAt: now, updatedAt: now };
        store.users.push(user); audit(store, { user }, 'owner_setup', 'user', user.id, 'Created the initial owner account.'); return { user };
      });
      if (result.error) return json(res, 409, { error: result.error });
      const session = await updateStore((store) => setSession(req, res, store, store.users.find((user) => user.id === result.user.id)));
      return json(res, 201, session);
    }
    if (route === '/login' && method === 'POST') {
      if (String(process.env.ADMIN_SESSION_SECRET || '').length < 32) return json(res, 503, { error: 'Set a random ADMIN_SESSION_SECRET of at least 32 characters in .env.' });
      const input = await parseBody(req), email = emailValue(input.email), ip = clean(req.socket.remoteAddress || '', 80), attemptKey = hash(`${email}|${ip}`), now = Date.now();
      const store = await readStore(), attempt = store.attempts[attemptKey];
      if (attempt && now - attempt.startedAt < ATTEMPT_WINDOW_MS && attempt.failures >= MAX_LOGIN_FAILURES) return json(res, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
      const user = store.users.find((entry) => entry.email === email && entry.active);
      if (!user || !passwordMatches(String(input.password || ''), user.passwordHash)) {
        await updateStore((current) => { let row = current.attempts[attemptKey]; if (!row || now - row.startedAt >= ATTEMPT_WINDOW_MS) row = current.attempts[attemptKey] = { failures: 0, startedAt: now }; row.failures += 1; });
        return json(res, 401, { error: 'Email or password is incorrect.' });
      }
      return json(res, 200, await updateStore((current) => { delete current.attempts[attemptKey]; return setSession(req, res, current, user); }));
    }
    const store = await readStore(), auth = await sessionFor(req, store);
    if (route === '/session' && method === 'GET') return auth ? json(res, 200, { ...safeUser(auth.user), csrfToken: auth.session.csrfToken, expiresAt: auth.session.expiresAt }) : json(res, 401, { error: 'Sign in to continue.' });
    if (route === '/logout' && method === 'POST') {
      if (!auth) { res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); return json(res, 200, { ok: true }); }
      if (!originMatches(req) || req.headers['x-csrf-token'] !== auth.session.csrfToken) return json(res, 403, { error: 'Security check failed. Refresh and try again.' });
      await updateStore((current) => { current.sessions = current.sessions.filter((entry) => entry.tokenHash !== auth.session.tokenHash); });
      res.setHeader('Set-Cookie', cookieHeader(req, '', 0)); return json(res, 200, { ok: true });
    }
    if (!auth) return json(res, 401, { error: 'Sign in to continue.' });
    if (auth.user.mustChangePassword && route !== '/password') return json(res, 403, { error: 'Change your temporary password before continuing.' });
    if (!['GET', 'HEAD'].includes(method) && (!originMatches(req) || req.headers['x-csrf-token'] !== auth.session.csrfToken)) return json(res, 403, { error: 'Security check failed. Refresh and try again.' });
    const owner = auth.user.role === 'owner';
    if (route === '/password' && method === 'PUT') {
      const input = await parseBody(req); if (!validPassword(input.newPassword)) return json(res, 400, { error: 'Choose a password with at least 12 characters.' });
      const changed = await updateStore((current) => {
        const user = current.users.find((entry) => entry.id === auth.user.id);
        if (!user || !passwordMatches(String(input.currentPassword || ''), user.passwordHash)) return false;
        user.passwordHash = passwordHash(input.newPassword); user.mustChangePassword = false; user.updatedAt = new Date().toISOString();
        current.sessions = current.sessions.filter((entry) => entry.userId !== user.id || entry.tokenHash === auth.session.tokenHash);
        audit(current, auth, 'password_changed', 'user', user.id, 'Changed account password.'); return true;
      });
      return changed ? json(res, 200, { ok: true }) : json(res, 401, { error: 'Current password is incorrect.' });
    }
    const staffAllowed = route === '/overview' || route === '/enquiries' || route.startsWith('/enquiries/') || route === '/order-requests' || route.startsWith('/order-requests/') || route === '/orders' || route.startsWith('/orders/') || route === '/audit';
    if (!owner && !staffAllowed) return json(res, 403, { error: 'This action is available to the owner only.' });
    if (route === '/overview' && method === 'GET') {
      const pendingPayments = store.orders.filter((item) => ['created', 'authorized'].includes(item.status)).length;
      const lowStock = store.products.flatMap((product) => product.active ? product.variants.map((variant) => ({ product, variant })) : []).filter(({ variant }) => variant.stockOnHand - variant.reserved <= 3).length;
      const salesPaise = store.orders.filter((item) => item.status === 'paid').reduce((sum, item) => sum + Number(item.amountPaise || 0), 0);
      return json(res, 200, { newEnquiries: store.enquiries.filter((item) => item.status === 'new').length, openRequests: store.orderRequests.filter((item) => !['converted', 'closed'].includes(item.status)).length, ordersToFulfill: store.orders.filter((item) => item.status === 'paid' && item.fulfillmentStatus !== 'delivered').length, pendingPayments, lowStock, salesPaise });
    }
    if (route === '/products' && method === 'GET') return json(res, 200, { products: store.products.slice().sort((a, b) => a.sortOrder - b.sortOrder).map(productView) });
    if (route === '/products' && method === 'POST' && owner) {
      const input = await parseBody(req), id = `${slug(input.name)}-${randomBytes(3).toString('hex')}`, product = normalizeProduct(input, id, { sortOrder: store.products.length });
      await updateStore((current) => { current.products.push(product); audit(current, auth, 'product_created', 'product', id, `Created ${product.name}.`); }); return json(res, 201, productView(product));
    }
    const productMatch = route.match(/^\/products\/([^/]+)(?:\/(stock))?$/);
    if (productMatch && method === 'PUT' && !productMatch[2] && owner) {
      const id = decodeURIComponent(productMatch[1]), input = await parseBody(req); let updated;
      const found = await updateStore((current) => {
        const index = current.products.findIndex((item) => item.id === id); if (index < 0) return false;
        const nextVariants = new Set(sizesOf(input.sizes).flatMap((size) => colorsOf(input.color).map((color) => `${size}|${color}`)));
        const reservedVariantRemoved = current.products[index].variants.some((variant) => variant.reserved > 0 && !nextVariants.has(`${variant.size}|${variant.color}`));
        if (reservedVariantRemoved) { updated = null; return false; }
        updated = normalizeProduct(input, id, current.products[index]); current.products[index] = updated; audit(current, auth, 'product_updated', 'product', id, `Updated ${updated.name}.`); return true;
      });
      if (!found && updated === null) return json(res, 409, { error: 'This product has variants reserved during checkout. Keep those sizes and colours until the reservation is resolved.' });
      return found ? json(res, 200, productView(updated)) : json(res, 404, { error: 'Product not found.' });
    }
    if (productMatch && method === 'PATCH' && productMatch[2] && owner) {
      const id = decodeURIComponent(productMatch[1]), input = await parseBody(req), quantity = Number(input.stockOnHand); let outcome;
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) return json(res, 400, { error: 'Stock must be a whole number from 0 to 1,000,000.' });
      await updateStore((current) => {
        const product = current.products.find((item) => item.id === id), variant = product?.variants.find((item) => item.size === clean(input.size, 20) && item.color === clean(input.color, 80));
        if (!variant) { outcome = 'missing'; return; } if (quantity < variant.reserved) { outcome = 'reserved'; return; }
        variant.stockOnHand = quantity; audit(current, auth, 'stock_updated', 'product_variant', `${id}|${variant.size}|${variant.color}`, `Set ${product.name} ${variant.size}/${variant.color} stock to ${quantity}.`); outcome = 'ok';
      });
      if (outcome === 'reserved') return json(res, 409, { error: 'Stock cannot be reduced below quantities reserved for checkout.' });
      return outcome === 'ok' ? json(res, 200, { ok: true, stockOnHand: quantity }) : json(res, 404, { error: 'Product variant not found.' });
    }
    if (route === '/enquiries' && method === 'GET') return json(res, 200, { enquiries: store.enquiries.slice().sort(sortCreated) });
    const enquiryMatch = route.match(/^\/enquiries\/([^/]+)$/);
    if (enquiryMatch && method === 'PATCH') {
      const id = decodeURIComponent(enquiryMatch[1]), input = await parseBody(req); if (!validStatus(input.status, ENQUIRY_STATES)) return json(res, 400, { error: 'Choose a valid enquiry status.' });
      const found = await updateStore((current) => { const item = current.enquiries.find((entry) => entry.id === id); if (!item) return false; item.status = input.status; item.adminNote = clean(input.adminNote, 3000); item.updatedAt = new Date().toISOString(); audit(current, auth, 'enquiry_updated', 'enquiry', id, `Changed enquiry status to ${input.status}.`); return true; });
      return found ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Enquiry not found.' });
    }
    if (route === '/order-requests' && method === 'GET') return json(res, 200, { orderRequests: store.orderRequests.slice().sort(sortCreated) });
    const requestMatch = route.match(/^\/order-requests\/([^/]+)$/);
    if (requestMatch && method === 'PATCH') {
      const id = decodeURIComponent(requestMatch[1]), input = await parseBody(req); if (!validStatus(input.status, REQUEST_STATES)) return json(res, 400, { error: 'Choose a valid order request status.' });
      const found = await updateStore((current) => { const item = current.orderRequests.find((entry) => entry.id === id); if (!item) return false; item.status = input.status; item.adminNote = clean(input.adminNote, 3000); item.updatedAt = new Date().toISOString(); audit(current, auth, 'request_updated', 'order_request', id, `Changed request status to ${input.status}.`); return true; });
      return found ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Order request not found.' });
    }
    if (route === '/orders' && method === 'GET') return json(res, 200, { orders: store.orders.slice().sort(sortCreated).map((item) => ({ ...item, fulfillmentStatus: item.fulfillmentStatus || 'unfulfilled', adminNote: item.adminNote || '' })) });
    const orderMatch = route.match(/^\/orders\/([^/]+)$/);
    if (orderMatch && method === 'PATCH') {
      const id = decodeURIComponent(orderMatch[1]), input = await parseBody(req); if (!validStatus(input.fulfillmentStatus, FULFILLMENT_STATES)) return json(res, 400, { error: 'Choose a valid fulfilment status.' });
      let unpaid = false;
      const found = await updateStore((current) => { const item = current.orders.find((entry) => entry.id === id); if (!item) return false; if (item.status !== 'paid') { unpaid = true; return false; } item.fulfillmentStatus = input.fulfillmentStatus; item.adminNote = clean(input.adminNote, 3000); item.updatedAt = new Date().toISOString(); audit(current, auth, 'fulfillment_updated', 'order', id, `Changed fulfilment to ${input.fulfillmentStatus}.`); return true; });
      if (unpaid) return json(res, 409, { error: 'Fulfilment can only be updated after Razorpay confirms a captured payment.' });
      return found ? json(res, 200, { ok: true }) : json(res, 404, { error: 'Order not found.' });
    }
    if (route === '/settings' && method === 'GET' && owner) return json(res, 200, store.settings);
    if (route === '/settings' && method === 'PUT' && owner) {
      const input = await parseBody(req), fee = Number(input.shippingFeePaise), phone = clean(input.whatsappNumber, 24).replace(/\D/g, '');
      if (!Number.isSafeInteger(fee) || fee < 0 || fee > 5000000 || (phone && (phone.length < 8 || phone.length > 15))) return json(res, 400, { error: 'Enter a valid delivery fee and international WhatsApp number.' });
      await updateStore((current) => { current.settings = { shippingFeePaise: fee, whatsappNumber: phone }; audit(current, auth, 'settings_updated', 'settings', 'shop', 'Updated shop contact or delivery settings.'); }); return json(res, 200, { shippingFeePaise: fee, whatsappNumber: phone });
    }
    if (route === '/users' && method === 'GET' && owner) return json(res, 200, { users: store.users.map(safeUser) });
    if (route === '/users' && method === 'POST' && owner) {
      const input = await parseBody(req), email = emailValue(input.email), name = clean(input.name, 100);
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a name and valid email address.' });
      if (store.users.some((item) => item.email === email)) return json(res, 409, { error: 'An account already uses this email.' });
      const temp = token(15), now = new Date().toISOString(), user = { id: randomUUID(), email, name, passwordHash: passwordHash(temp), role: 'staff', mustChangePassword: true, active: true, createdAt: now, updatedAt: now };
      await updateStore((current) => { current.users.push(user); audit(current, auth, 'staff_created', 'user', user.id, `Created staff access for ${email}.`); }); return json(res, 201, { user: safeUser(user), temporaryPassword: temp });
    }
    const userMatch = route.match(/^\/users\/([^/]+)$/);
    if (userMatch && method === 'PATCH' && owner) {
      const id = decodeURIComponent(userMatch[1]), input = await parseBody(req), temp = input.action === 'reset-password' ? token(15) : '';
      const found = await updateStore((current) => {
        const user = current.users.find((entry) => entry.id === id && entry.role === 'staff'); if (!user) return false;
        if (input.action === 'deactivate') { user.active = false; current.sessions = current.sessions.filter((entry) => entry.userId !== id); }
        else if (input.action === 'activate') user.active = true;
        else if (input.action === 'reset-password') { user.passwordHash = passwordHash(temp); user.mustChangePassword = true; current.sessions = current.sessions.filter((entry) => entry.userId !== id); }
        else return false;
        user.updatedAt = new Date().toISOString(); audit(current, auth, `staff_${input.action}`, 'user', id, `Updated staff account ${user.email}.`); return true;
      });
      return found ? json(res, 200, { ok: true, ...(temp ? { temporaryPassword: temp } : {}) }) : json(res, 404, { error: 'Staff account not found.' });
    }
    if (route === '/audit' && method === 'GET') return json(res, 200, { audit: store.audit.slice(0, 250) });
    return json(res, 404, { error: 'Admin endpoint not found.' });
  } catch (error) { return json(res, 400, { error: error.message || 'Unable to complete the admin request.' }); }
}

async function listProducts() { const store = await readStore(); return store.products.filter((item) => item.active).sort((a, b) => a.sortOrder - b.sortOrder).map(productView); }
async function getOrder(id) { const store = await readStore(); return store.orders.find((item) => item.id === id) || null; }
async function saveOrder(order) { return updateStore((store) => { const index = store.orders.findIndex((item) => item.id === order.id); if (index < 0) store.orders.push(order); else store.orders[index] = { ...store.orders[index], ...order }; return store.orders.find((item) => item.id === order.id); }); }
async function reserveStock(order, expiresAt) {
  return updateStore((store) => {
    const items = cartVariants(store, order.items, true);
    for (const item of items) { const variant = store.products.find((product) => product.id === item.id).variants.find((row) => row.size === item.size && row.color === item.color); variant.reserved += item.quantity; }
    const saved = { ...order, reservationStatus: 'reserved', reservationExpiresAt: expiresAt }; store.orders.push(saved); return saved;
  });
}
async function resolveReservation(order, resultStatus) {
  return updateStore((store) => {
    const current = store.orders.find((item) => item.id === order.id); if (!current || current.reservationStatus !== 'reserved') return;
    for (const item of current.items || []) { const variant = store.products.find((product) => product.id === item.id)?.variants.find((row) => row.size === item.size && row.color === item.color); if (!variant) continue; variant.reserved = Math.max(0, variant.reserved - item.quantity); if (resultStatus === 'committed') variant.stockOnHand = Math.max(0, variant.stockOnHand - item.quantity); }
    current.reservationStatus = resultStatus; current.updatedAt = new Date().toISOString();
  });
}
async function reconciliationCandidates() { const store = await readStore(); return store.orders.filter((order) => order.reservationStatus === 'reserved' && Date.parse(order.reservationExpiresAt || '') <= Date.now()); }

module.exports = { handleAdminRequest, listProducts, getOrder, saveOrder, reserveStock, resolveReservation, reconciliationCandidates, sizesOf, colorsOf, cartVariants, readStore, updateStore, hashPassword: passwordHash, verifyPassword: passwordMatches };

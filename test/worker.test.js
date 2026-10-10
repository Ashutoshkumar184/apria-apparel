const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const worker = require('../worker.js').default;

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {}

class D1StatementMock {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...params) { this.params = params; return this; }
  first() { return this.db.prepare(this.sql).get(...this.params) ?? null; }
  all() { return { results: this.db.prepare(this.sql).all(...this.params) }; }
  run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid || 0) } };
  }
}
class D1Mock {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1StatementMock(this.db, sql); }
  batch(statements) {
    this.db.exec('BEGIN');
    try {
      const results = statements.map((item) => item.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

test('Cloudflare Worker admin flows run against migrated D1 and preserve existing rows', { skip: !DatabaseSync && 'node:sqlite is available starting in newer Node releases' }, async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const migrationDir = path.resolve(__dirname, '..', 'migrations');
  raw.exec(fs.readFileSync(path.join(migrationDir, '0001_create_enquiries.sql'), 'utf8'));
  raw.exec(fs.readFileSync(path.join(migrationDir, '0002_create_payment_orders.sql'), 'utf8'));
  raw.prepare('INSERT INTO enquiries (id, created_at, name, email, type, message, items_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('existing-enquiry', '2026-01-01T00:00:00.000Z', 'Legacy customer', 'legacy@example.test', 'bulk', 'Existing enquiry.', '[]');
  raw.prepare('INSERT INTO payment_orders (id, razorpay_order_id, amount_paise, currency, status, customer_json, items_json, payment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('existing-paid', 'order_existing', 25000, 'INR', 'paid', '{"name":"Legacy buyer"}', '[]', 'pay_existing', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  raw.prepare('INSERT INTO payment_orders (id, razorpay_order_id, amount_paise, currency, status, customer_json, items_json, payment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('existing-unpaid', 'order_unpaid', 25000, 'INR', 'created', '{"name":"Pending buyer"}', '[]', '', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  raw.exec(fs.readFileSync(path.join(migrationDir, '0003_admin_portal.sql'), 'utf8'));
  const env = {
    DB: new D1Mock(raw),
    ASSETS: { fetch: async (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/products.json') return Response.json(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'products.json'), 'utf8')));
      if (pathname === '/admin.html') return new Response(fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      return new Response('Not found', { status: 404 });
    } },
    ADMIN_SETUP_TOKEN: 'worker-test-one-time-token-123456789012',
    ADMIN_SESSION_SECRET: 'worker-test-session-secret-123456789012345',
    SHIPPING_FEE_PAISE: '0',
    WHATSAPP_NUMBER: '919900000000'
  };
  const base = 'https://apria.example';
  const call = async (url, { method = 'GET', body, cookie = '', csrf = '', expect = 200 } = {}) => {
    const headers = new Headers();
    if (body !== undefined) { headers.set('Content-Type', 'application/json'); headers.set('Origin', base); }
    if (cookie) headers.set('Cookie', cookie);
    if (csrf) headers.set('X-CSRF-Token', csrf);
    const request = new Request(`${base}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const response = await worker.fetch(request, env);
    const data = await response.json().catch(() => ({}));
    assert.equal(response.status, expect, `${method} ${url}: ${JSON.stringify(data)}`);
    return { response, data, cookie: response.headers.get('Set-Cookie')?.split(';', 1)[0] || cookie };
  };

  const oldEnquiry = raw.prepare('SELECT * FROM enquiries WHERE id = ?').get('existing-enquiry');
  const oldOrder = raw.prepare('SELECT * FROM payment_orders WHERE id = ?').get('existing-paid');
  assert.equal(oldEnquiry.status, 'new');
  assert.equal(oldOrder.status, 'paid');
  assert.equal(oldOrder.fulfillment_status, 'unfulfilled');

  assert.deepEqual((await call('/api/admin/status')).data, { setupRequired: true, setupEnabled: true });
  const portalPage = await worker.fetch(new Request(`${base}/admin`), env);
  assert.equal(portalPage.status, 200);
  assert.match(await portalPage.text(), /APRIA Studio — Admin/);
  const wranglerConfig = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'wrangler.jsonc'), 'utf8'));
  assert.ok(wranglerConfig.assets.run_worker_first.includes('/admin'));
  assert.ok(wranglerConfig.assets.run_worker_first.includes('/admin/*'));
  const setup = await call('/api/admin/setup', { method: 'POST', body: { setupToken: env.ADMIN_SETUP_TOKEN, name: 'Worker Owner', email: 'owner@example.test', password: 'worker-owner-password' }, expect: 201 });
  const ownerCookie = setup.cookie, ownerCsrf = setup.data.csrfToken;
  await call('/api/admin/orders/existing-unpaid', { method: 'PATCH', cookie: ownerCookie, csrf: ownerCsrf, body: { fulfillmentStatus: 'processing' }, expect: 409 });
  const catalogue = await call('/api/products');
  const product = catalogue.data[0], variant = product.variants[0];
  assert.equal(variant.available, 0);
  await call(`/api/admin/products/${encodeURIComponent(product.id)}/stock`, { method: 'PATCH', cookie: ownerCookie, csrf: ownerCsrf, body: { size: variant.size, color: variant.color, stockOnHand: 3 } });

  const enquiry = await call('/api/enquiries', { method: 'POST', body: { name: 'New Buyer', email: 'buyer@example.test', type: 'bulk', message: 'Please send a quote.' }, expect: 201 });
  const request = await call('/api/order-requests', { method: 'POST', body: { name: 'Retail Buyer', email: 'retail@example.test', phone: '+919999999999', address: { address1: '1 Sample Street', city: 'Pune', state: 'Maharashtra', pincode: '411001' }, items: [{ id: product.id, size: variant.size, color: variant.color, quantity: 1 }] }, expect: 201 });
  assert.equal((await call('/api/admin/enquiries', { cookie: ownerCookie })).data.enquiries.some((item) => item.id === enquiry.data.id), true);
  assert.equal((await call('/api/admin/order-requests', { cookie: ownerCookie })).data.orderRequests.some((item) => item.id === request.data.id), true);

  const adminWorker = await import('../admin-worker.mjs');
  const stockOrder = { id: 'worker-stock-reservation', items: [{ id: product.id, size: variant.size, color: variant.color, quantity: 2 }] };
  assert.equal(await adminWorker.createStockReservation(env, stockOrder.id, stockOrder.items, new Date(Date.now() + 60_000).toISOString()), true);
  assert.equal((await call('/api/products')).data[0].variants[0].available, 1);
  await Promise.all([adminWorker.resolveStockReservation(env, stockOrder.id, 'committed'), adminWorker.resolveStockReservation(env, stockOrder.id, 'committed')]);
  assert.equal((await call('/api/products')).data[0].variants[0].available, 1);

  const now = new Date().toISOString();
  const createPendingPayment = (id, providerId) => raw.prepare('INSERT INTO payment_orders (id, razorpay_order_id, amount_paise, currency, status, customer_json, items_json, payment_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, providerId, 100, 'INR', 'created', '{}', '[]', '', now, now);
  createPendingPayment('captured-expiry', 'order_captured_expiry');
  const expiryItem = [{ id: product.id, size: variant.size, color: variant.color, quantity: 1 }];
  assert.equal(await adminWorker.createStockReservation(env, 'captured-expiry', expiryItem, new Date(Date.now() - 1000).toISOString()), true);
  createPendingPayment('failed-expiry', 'order_failed_expiry');
  await call(`/api/admin/products/${encodeURIComponent(product.id)}/stock`, { method: 'PATCH', cookie: ownerCookie, csrf: ownerCsrf, body: { size: variant.size, color: variant.color, stockOnHand: 2 } });
  assert.equal(await adminWorker.createStockReservation(env, 'failed-expiry', expiryItem, new Date(Date.now() - 1000).toISOString()), true);
  env.RAZORPAY_KEY_ID = 'rzp_test_mock'; env.RAZORPAY_KEY_SECRET = 'test-secret';
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => Response.json({ items: String(url).includes('order_captured_expiry') ? [{ id: 'pay_captured', status: 'captured', captured: true, order_id: 'order_captured_expiry' }] : [] });
    await adminWorker.reconcileExpiredReservations(env);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(raw.prepare('SELECT status FROM payment_orders WHERE id = ?').get('captured-expiry').status, 'paid');
  assert.equal(raw.prepare('SELECT status FROM payment_orders WHERE id = ?').get('failed-expiry').status, 'failed');
  assert.equal(raw.prepare("SELECT status FROM stock_reservations WHERE order_id = 'captured-expiry'").get().status, 'committed');
  assert.equal(raw.prepare("SELECT status FROM stock_reservations WHERE order_id = 'failed-expiry'").get().status, 'released');
  assert.equal((await call('/api/products')).data[0].variants[0].available, 1);

  const staff = await call('/api/admin/users', { method: 'POST', cookie: ownerCookie, csrf: ownerCsrf, body: { name: 'Worker Staff', email: 'staff@example.test' }, expect: 201 });
  const login = await call('/api/admin/login', { method: 'POST', body: { email: 'staff@example.test', password: staff.data.temporaryPassword } });
  await call('/api/admin/overview', { cookie: login.cookie, expect: 403 });
  await call('/api/admin/password', { method: 'PUT', cookie: login.cookie, csrf: login.data.csrfToken, body: { currentPassword: staff.data.temporaryPassword, newPassword: 'worker-staff-password' } });
  assert.equal((await call('/api/admin/overview', { cookie: login.cookie })).data.newEnquiries, 2);
  await call('/api/admin/products', { cookie: login.cookie, expect: 403 });
  await call('/api/admin/logout', { method: 'POST', cookie: login.cookie, csrf: login.data.csrfToken, body: {} });
  await call('/api/admin/session', { cookie: login.cookie, expect: 401 });
  raw.close();
});

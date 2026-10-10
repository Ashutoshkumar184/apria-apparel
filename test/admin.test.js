const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', (error) => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('local owner, staff, request inbox and inventory flows work in isolated data', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apria-admin-test-'));
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  for (const file of ['server.js', 'admin-local.cjs']) fs.copyFileSync(path.resolve(__dirname, '..', file), path.join(root, file));
  fs.cpSync(path.resolve(__dirname, '..', 'public'), path.join(root, 'public'), { recursive: true });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const setupToken = 'local-test-one-time-setup-token-1234567890';
  const sessionSecret = 'local-test-session-pepper-12345678901234567890';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_SETUP_TOKEN: setupToken, ADMIN_SESSION_SECRET: sessionSecret },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(2000)]); }
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/admin/status`)).ok) break; }
    catch { await delay(50); }
  }
  assert.equal(child.exitCode, null, `local server exited early: ${stderr}`);
  const call = async (url, { method = 'GET', body, cookie = '', csrf = '', expect = 200 } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers.Origin = base; }
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`${base}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    assert.equal(response.status, expect, `${method} ${url}: ${JSON.stringify(data)}`);
    return { response, data, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || cookie };
  };
  const status = await call('/api/admin/status');
  assert.deepEqual([status.data.setupRequired, status.data.setupEnabled], [true, true]);
  await call('/api/admin/setup', { method: 'POST', body: { setupToken: 'wrong-code', name: 'Owner', email: 'owner@example.test', password: 'owner-password-123' }, expect: 403 });
  const setup = await call('/api/admin/setup', { method: 'POST', body: { setupToken, name: 'Owner', email: 'owner@example.test', password: 'owner-password-123' }, expect: 201 });
  const ownerCookie = setup.cookie, ownerCsrf = setup.data.csrfToken;
  assert.equal(setup.data.role, 'owner');
  await call('/api/admin/setup', { method: 'POST', body: { setupToken, name: 'Other', email: 'other@example.test', password: 'other-password-123' }, expect: 409 });

  const storeHtml = await fetch(`${base}/admin`);
  assert.match(await storeHtml.text(), /APRIA Studio — Admin/);
  const catalog = await call('/api/products');
  assert.ok(catalog.data.length > 0);
  const product = catalog.data[0], variant = product.variants[0];
  assert.equal(variant.available, 0, 'seed inventory must start unavailable');
  const ownerProducts = await call('/api/admin/products', { cookie: ownerCookie });
  assert.ok(ownerProducts.data.products.length > 0);

  const enquiry = await call('/api/enquiries', { method: 'POST', body: { name: 'Test Buyer', email: 'buyer@example.test', phone: '+919999999999', type: 'bulk', company: 'Sample Studio', message: 'Please quote a short production run.' }, expect: 201 });
  const orderRequest = await call('/api/order-requests', { method: 'POST', body: { name: 'Test Retail Buyer', email: 'retail@example.test', phone: '+918888888888', address: { address1: '1 Test Road', city: 'Mumbai', state: 'Maharashtra', pincode: '400001' }, items: [{ id: product.id, size: variant.size, color: variant.color, quantity: 1 }] }, expect: 201 });
  const stock = await call(`/api/admin/products/${encodeURIComponent(product.id)}/stock`, { method: 'PATCH', cookie: ownerCookie, csrf: ownerCsrf, body: { size: variant.size, color: variant.color, stockOnHand: 2 } });
  assert.equal(stock.data.stockOnHand, 2);

  const adminLocal = require(path.join(root, 'admin-local.cjs'));
  const firstOrder = { id: 'test-failed-order', status: 'created', items: [{ id: product.id, size: variant.size, color: variant.color, quantity: 1 }] };
  await adminLocal.reserveStock(firstOrder, new Date(Date.now() + 60_000).toISOString());
  await call('/api/admin/orders/test-failed-order', { method: 'PATCH', cookie: ownerCookie, csrf: ownerCsrf, body: { fulfillmentStatus: 'processing' }, expect: 409 });
  await assert.rejects(() => adminLocal.reserveStock({ ...firstOrder, id: 'test-overstock-order', items: [{ ...firstOrder.items[0], quantity: 2 }] }, new Date(Date.now() + 60_000).toISOString()), /insufficient quantity/i);
  await call(`/api/admin/products/${encodeURIComponent(product.id)}/stock`, { method: 'PATCH', cookie: ownerCookie, csrf: ownerCsrf, body: { size: variant.size, color: variant.color, stockOnHand: 0 }, expect: 409 });
  await adminLocal.resolveReservation(firstOrder, 'released');
  const capturedOrder = { ...firstOrder, id: 'test-captured-order' };
  await adminLocal.reserveStock(capturedOrder, new Date(Date.now() - 1000).toISOString());
  assert.equal((await adminLocal.reconciliationCandidates()).some((item) => item.id === capturedOrder.id), true);
  await adminLocal.resolveReservation(capturedOrder, 'committed');
  const freshCatalog = await call('/api/products');
  assert.equal(freshCatalog.data.find((item) => item.id === product.id).variants.find((item) => item.size === variant.size && item.color === variant.color).available, 1);

  await call('/api/admin/settings', { method: 'PUT', cookie: ownerCookie, csrf: ownerCsrf, body: { whatsappNumber: '919876543210', shippingFeePaise: 5000 } });
  const staff = await call('/api/admin/users', { method: 'POST', cookie: ownerCookie, csrf: ownerCsrf, body: { name: 'Staff Member', email: 'staff@example.test' }, expect: 201 });
  assert.equal(staff.data.user.mustChangePassword, true);
  await call('/api/admin/users', { method: 'POST', cookie: ownerCookie, csrf: ownerCsrf, body: { name: 'Duplicate', email: 'staff@example.test' }, expect: 409 });
  const staffLogin = await call('/api/admin/login', { method: 'POST', body: { email: 'staff@example.test', password: staff.data.temporaryPassword } });
  const staffCookie = staffLogin.cookie, staffCsrf = staffLogin.data.csrfToken;
  assert.equal(staffLogin.data.mustChangePassword, true);
  await call('/api/admin/overview', { cookie: staffCookie, expect: 403 });
  await call('/api/admin/password', { method: 'PUT', cookie: staffCookie, csrf: staffCsrf, body: { currentPassword: staff.data.temporaryPassword, newPassword: 'staff-new-password-123' } });
  const overview = await call('/api/admin/overview', { cookie: staffCookie });
  assert.equal(overview.data.newEnquiries, 1);
  await call('/api/admin/products', { cookie: staffCookie, expect: 403 });
  const enquiries = await call('/api/admin/enquiries', { cookie: staffCookie });
  assert.equal(enquiries.data.enquiries[0].id, enquiry.data.id);
  await call(`/api/admin/enquiries/${encodeURIComponent(enquiry.data.id)}`, { method: 'PATCH', cookie: staffCookie, csrf: staffCsrf, body: { status: 'quoted', adminNote: 'Quote sent for review.' } });
  const requests = await call('/api/admin/order-requests', { cookie: staffCookie });
  assert.equal(requests.data.orderRequests[0].id, orderRequest.data.id);
  await call(`/api/admin/order-requests/${encodeURIComponent(orderRequest.data.id)}`, { method: 'PATCH', cookie: staffCookie, csrf: staffCsrf, body: { status: 'contacted', adminNote: 'Availability being checked.' } });
  const audit = await call('/api/admin/audit', { cookie: staffCookie });
  assert.ok(audit.data.audit.some((row) => row.targetId === enquiry.data.id));

  await call('/api/admin/logout', { method: 'POST', cookie: staffCookie, csrf: staffCsrf, body: {} });
  await call('/api/admin/session', { cookie: staffCookie, expect: 401 });
  const diskPath = path.join(root, 'data', 'admin-data.json');
  const localStore = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  for (const session of localStore.sessions) session.expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(diskPath, JSON.stringify(localStore));
  await call('/api/admin/session', { cookie: ownerCookie, expect: 401 });
  assert.equal((await call('/api/config')).data.whatsappNumber, '919876543210');
  assert.match(stderr, /^$/);
});

const MAX_BODY = 20_000;
import { handleAdminRequest, publicProducts, publicSettings, createStockReservation, resolveStockReservation, reconcileExpiredReservations } from './admin-worker.mjs';
import { handleCustomerRequest } from './customer-worker.mjs';
// build-dashboard-worker.js replaces this empty object with the public files
// for a dashboard-only deploy. Wrangler deployments instead use env.ASSETS.
const EMBEDDED_ASSETS = {};
const corsHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store'
};
function response(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { ...corsHeaders, ...headers } });
}
function clean(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function shippingFeePaise(env) {
  const value = Number(env.SHIPPING_FEE_PAISE || 0);
  return Number.isSafeInteger(value) && value >= 0 && value <= 5_000_000 ? value : 0;
}
function getSizes(spec) {
  const parts = String(spec || '').split('–').map((part) => part.trim());
  const alpha = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  if (parts.length === 2 && alpha.includes(parts[0]) && alpha.includes(parts[1])) return alpha.slice(alpha.indexOf(parts[0]), alpha.indexOf(parts[1]) + 1);
  if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const first = Number(parts[0]), last = Number(parts[1]);
    if (last >= first && (last - first) % 2 === 0 && (last - first) / 2 < 30) return Array.from({ length: (last - first) / 2 + 1 }, (_, index) => String(first + index * 2));
  }
  return String(spec || '').split('/').map((part) => part.trim()).filter(Boolean);
}
function prepareCheckout(input, products, env) {
  const name = clean(input.customer?.name, 100);
  const email = clean(input.customer?.email, 200);
  const phone = clean(input.customer?.phone, 40);
  const phoneDigits = phone.replace(/\D/g, '');
  const address1 = clean(input.customer?.address1, 200);
  const address2 = clean(input.customer?.address2, 200);
  const city = clean(input.customer?.city, 80);
  const state = clean(input.customer?.state, 80);
  const pincode = clean(input.customer?.pincode, 12);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || phoneDigits.length < 10 || phoneDigits.length > 15 || !address1 || !city || !state || !/^\d{6}$/.test(pincode)) {
    return { error: 'Enter your name, valid email and phone, and a complete Indian delivery address.', status: 400 };
  }
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > 20) return { error: 'Your cart must contain 1 to 20 garment options.', status: 400 };
  const byId = new Map(products.map((product) => [product.id, product]));
  const items = [];
  let subtotalPaise = 0;
  for (const raw of input.items) {
    const product = raw && byId.get(clean(raw.id, 80));
    const size = clean(raw?.size, 20), color = clean(raw?.color, 80), quantity = Number(raw?.quantity);
    const colors = String(product?.color || '').split('/').map((part) => part.trim());
    const variant = product?.variants?.find((entry) => entry.size === size && entry.color === color);
    if (!product || !product.active || !variant || variant.available < quantity || !getSizes(product.sizes).includes(size) || !colors.includes(color) || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      return { error: 'One or more cart options are no longer available. Refresh the page and try again.', status: 400 };
    }
    const unitPricePaise = Math.round(Number(product.price) * 100);
    if (!Number.isSafeInteger(unitPricePaise) || unitPricePaise < 1) return { error: 'A garment price is unavailable. Please contact APRIA.', status: 400 };
    const lineTotalPaise = unitPricePaise * quantity;
    subtotalPaise += lineTotalPaise;
    items.push({ id: product.id, name: clean(product.name, 120), size, color, quantity, unitPricePaise, lineTotalPaise });
  }
  const deliveryPaise = Number(env.__shippingFeePaise ?? shippingFeePaise(env));
  const amountPaise = subtotalPaise + deliveryPaise;
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 100 || amountPaise > 50_000_000) return { error: 'The order total must be between ₹1 and ₹5,00,000.', status: 400 };
  return { customer: { name, email, phone, address1, address2, city, state, pincode }, items, subtotalPaise, deliveryPaise, amountPaise };
}
function paymentsEnabled(env) { return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET); }
async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return { error: response('Request is too large', 413) };
  try { return { value: JSON.parse(raw || '{}') }; }
  catch { return { error: response('Please submit valid JSON.', 400) }; }
}
async function razorpayRequest(env, method, endpoint, body) {
  const credentials = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
  const response = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${credentials}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Razorpay returned ${response.status}`);
  return result;
}
async function razorpaySignature(orderId, paymentId, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${orderId}|${paymentId}`));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function timingSafeTextEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
async function serveAsset(request, env, pathname) {
  if (env.ASSETS) return env.ASSETS.fetch(new Request(new URL(pathname, request.url)));
  const asset = EMBEDDED_ASSETS[pathname] || (pathname === '/' ? EMBEDDED_ASSETS['/index.html'] : null);
  if (!asset) return new Response('Not found', { status: 404, headers: corsHeaders });
  const bytes = Uint8Array.from(atob(asset.body), (character) => character.charCodeAt(0));
  const body = asset.encoding === 'gzip'
    ? new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    : bytes;
  return response(body, 200, { 'Content-Type': asset.type, 'Cache-Control': 'public, max-age=3600' });
}
async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/account' || url.pathname === '/account/') return serveAsset(request, env, '/account.html');
  if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin/setup') return serveAsset(request, env, '/admin.html');
  const adminResponse = await handleAdminRequest(request, env, url);
  if (adminResponse) return adminResponse;
  const customerResponse = await handleCustomerRequest(request, env, url);
  if (customerResponse) return customerResponse;
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return Response.json({ ok: true, service: 'APRIA', time: new Date().toISOString() }, { headers: corsHeaders });
  }
  if (url.pathname === '/api/config' && request.method === 'GET') {
    const settings = await publicSettings(env);
    return Response.json({ whatsappNumber: settings.whatsappNumber }, { headers: corsHeaders });
  }
  if (url.pathname === '/api/products' && request.method === 'GET') {
    try { return Response.json(await publicProducts(env), { headers: corsHeaders }); }
    catch { return Response.json({ error: 'Catalogue unavailable. Please try again.' }, { status: 503, headers: corsHeaders }); }
  }
  if (url.pathname === '/api/payment/config' && request.method === 'GET') {
    const settings = await publicSettings(env);
    return Response.json({ enabled: paymentsEnabled(env), keyId: env.RAZORPAY_KEY_ID || '', currency: 'INR', deliveryPaise: settings.shippingFeePaise }, { headers: corsHeaders });
  }
  if (url.pathname === '/api/checkout/orders' && request.method === 'POST') {
    if (!paymentsEnabled(env)) return Response.json({ error: 'Online payment is not configured yet. Please contact APRIA.' }, { status: 503, headers: corsHeaders });
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return Response.json({ error: 'Please submit a valid checkout.' }, { status: 400, headers: corsHeaders });
    let products, settings;
    try { [products, settings] = await Promise.all([publicProducts(env), publicSettings(env)]); }
    catch { return Response.json({ error: 'Catalogue unavailable. Please try again.' }, { status: 503, headers: corsHeaders }); }
    const checkout = prepareCheckout(parsed.value, products, { ...env, __shippingFeePaise: settings.shippingFeePaise });
    if (checkout.error) return Response.json({ error: checkout.error }, { status: checkout.status, headers: corsHeaders });
    const id = crypto.randomUUID(), createdAt = new Date().toISOString();
    const receipt = `apria-${id.replace(/-/g, '').slice(0, 28)}`;
    let razorpayOrder;
    try {
      razorpayOrder = await razorpayRequest(env, 'POST', 'orders', {
        amount: checkout.amountPaise, currency: 'INR', receipt, notes: { apria_order_id: id }
      });
    } catch {
      return Response.json({ error: 'Unable to start payment right now. Please try again.' }, { status: 502, headers: corsHeaders });
    }
    if (!razorpayOrder.id || razorpayOrder.amount !== checkout.amountPaise || razorpayOrder.currency !== 'INR') {
      return Response.json({ error: 'Payment provider returned an invalid order. Please try again.' }, { status: 502, headers: corsHeaders });
    }
    const reservationExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const reserved = await createStockReservation(env, id, checkout.items, reservationExpiresAt);
    if (!reserved) return Response.json({ error: 'Stock changed while checkout was starting. Refresh your bag and try again.' }, { status: 409, headers: corsHeaders });
    try {
      await env.DB.prepare('INSERT INTO payment_orders (id, razorpay_order_id, amount_paise, currency, status, customer_json, items_json, payment_id, created_at, updated_at, fulfillment_status, admin_note, reservation_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, razorpayOrder.id, checkout.amountPaise, 'INR', 'created', JSON.stringify(checkout.customer), JSON.stringify(checkout.items), '', createdAt, createdAt, 'unfulfilled', '', reservationExpiresAt).run();
    } catch {
      await resolveStockReservation(env, id, 'released');
      return Response.json({ error: 'Unable to save your order right now. Please try again.' }, { status: 500, headers: corsHeaders });
    }
    return Response.json({ ok: true, orderId: id, receipt: id.slice(0, 8).toUpperCase(), razorpayOrderId: razorpayOrder.id, amount: checkout.amountPaise, currency: 'INR', keyId: env.RAZORPAY_KEY_ID }, { status: 201, headers: corsHeaders });
  }
  if (url.pathname === '/api/checkout/verify' && request.method === 'POST') {
    if (!paymentsEnabled(env)) return Response.json({ error: 'Online payment is not configured yet. Please contact APRIA.' }, { status: 503, headers: corsHeaders });
    const parsed = await readJson(request);
    if (parsed.error) return parsed.error;
    const input = parsed.value;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return Response.json({ error: 'Please submit valid payment details.' }, { status: 400, headers: corsHeaders });
    const orderId = clean(input.orderId, 80), providerOrderId = clean(input.razorpay_order_id, 80);
    const paymentId = clean(input.razorpay_payment_id, 80), signature = clean(input.razorpay_signature, 128);
    const order = await env.DB.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(orderId).first();
    if (!order || order.razorpay_order_id !== providerOrderId) return Response.json({ error: 'Checkout order not found. Please contact APRIA before retrying.' }, { status: 404, headers: corsHeaders });
    const receipt = order.id.slice(0, 8).toUpperCase();
    if (order.status === 'paid') return Response.json({ ok: true, status: 'paid', receipt }, { headers: corsHeaders });
    if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) return Response.json({ error: 'Payment verification failed. Please contact APRIA with your payment details.' }, { status: 400, headers: corsHeaders });
    const expected = await razorpaySignature(order.razorpay_order_id, paymentId, env.RAZORPAY_KEY_SECRET);
    if (!timingSafeTextEqual(expected, signature.toLowerCase())) return Response.json({ error: 'Payment verification failed. Please contact APRIA with your payment details.' }, { status: 400, headers: corsHeaders });
    let payment;
    try { payment = await razorpayRequest(env, 'GET', `payments/${encodeURIComponent(paymentId)}`); }
    catch { return Response.json({ error: 'Unable to confirm payment right now. Keep your payment receipt and contact APRIA.' }, { status: 502, headers: corsHeaders }); }
    if (payment.order_id !== order.razorpay_order_id || payment.amount !== order.amount_paise || payment.currency !== order.currency || payment.method !== 'upi') {
      return Response.json({ error: 'Payment details do not match this UPI order. Please contact APRIA.' }, { status: 400, headers: corsHeaders });
    }
    const status = payment.status === 'captured' && payment.captured === true ? 'paid' : payment.status === 'authorized' ? 'authorized' : 'failed';
    const updatedAt = new Date().toISOString();
    await env.DB.prepare('UPDATE payment_orders SET status = ?, payment_id = ?, updated_at = ?, reservation_expires_at = ? WHERE id = ?')
      .bind(status, paymentId, updatedAt, status === 'authorized' ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : order.reservation_expires_at, order.id).run();
    if (status === 'paid') await resolveStockReservation(env, order.id, 'committed');
    else if (status === 'failed') await resolveStockReservation(env, order.id, 'released');
    else if (status === 'authorized') await env.DB.prepare("UPDATE stock_reservations SET expires_at = ? WHERE order_id = ? AND status = 'reserved'")
      .bind(new Date(Date.now() + 15 * 60 * 1000).toISOString(), order.id).run();
    if (status !== 'paid') return Response.json({ ok: true, status, receipt, message: status === 'authorized' ? 'Payment is authorised and awaiting capture. APRIA will confirm the order shortly.' : 'Payment has not been captured. Please contact APRIA before retrying.' }, { status: 202, headers: corsHeaders });
    return Response.json({ ok: true, status: 'paid', receipt }, { headers: corsHeaders });
  }
  if (url.pathname !== '/api/enquiries') return serveAsset(request, env, url.pathname);
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: 'Enquiry is too large' }, { status: 413, headers: corsHeaders });
  let input;
  try { input = JSON.parse(raw || '{}'); }
  catch { return Response.json({ error: 'Please submit a valid form.' }, { status: 400, headers: corsHeaders }); }
  const name = clean(input.name, 100);
  const email = clean(input.email, 200);
  const phone = clean(input.phone, 40);
  const type = clean(input.type, 40);
  const company = clean(input.company, 160);
  const message = clean(input.message, 3000);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message || !['product', 'bulk', 'private-label', 'general'].includes(type)) {
    return Response.json({ error: 'Please provide your name, a valid email, enquiry type and message.' }, { status: 400, headers: corsHeaders });
  }
  if (input.website) return Response.json({ ok: true, id: 'received' }, { headers: corsHeaders });
  const items = Array.isArray(input.items) ? input.items.slice(0, 20).filter(item => item && typeof item === 'object').map(item => ({
    id: clean(item.id, 80), name: clean(item.name, 120), size: clean(item.size, 20), color: clean(item.color, 80), quantity: Math.max(1, Math.min(10000, Number.parseInt(item.quantity, 10) || 1))
  })) : [];
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    await env.DB.prepare('INSERT INTO enquiries (id, created_at, name, email, phone, type, company, message, items_json, status, admin_note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, createdAt, name, email, phone, type, company, message, JSON.stringify(items), 'new', '', createdAt).run();
  } catch {
    return Response.json({ error: 'Unable to save your enquiry right now.' }, { status: 500, headers: corsHeaders });
  }
  return Response.json({ ok: true, id, message: 'Thanks—your enquiry is with our team.' }, { status: 201, headers: corsHeaders });
}
export default {
  async fetch(request, env) {
    try { return await route(request, env); }
    catch { return Response.json({ error: 'Service temporarily unavailable.' }, { status: 500, headers: corsHeaders }); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(reconcileExpiredReservations(env)); }
};

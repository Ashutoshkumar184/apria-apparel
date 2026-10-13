const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');

const ROOT = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const ENV_FILE = path.join(__dirname, '.env');
try {
  const envText = fs.readFileSync(ENV_FILE, 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith('#') || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    process.env[match[1]] = value;
  }
} catch {}
const adminLocal = require('./admin-local.cjs');
const customerAuth = require('./customer-local.cjs');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4' };
function send(res, status, data, type='application/json; charset=utf-8') { res.writeHead(status, { 'Content-Type':type, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin', 'Cache-Control':'no-store' }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', c => { body += c; if (body.length > 20_000) { reject(new Error('Request too large')); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } }); req.on('error', reject); }); }
function clean(value, max=500) { return typeof value === 'string' ? value.trim().slice(0,max) : ''; }
function getIp(req) { return clean(req.socket.remoteAddress || '',80); }
function shippingFeePaise(env=process.env) {
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
function prepareCheckout(input, products, env=process.env) {
  input = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
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
const saveLocalOrder = adminLocal.saveOrder;
const getLocalOrder = adminLocal.getOrder;
async function razorpayRequest(method, endpoint, body, env=process.env) {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`https://api.razorpay.com/v1/${endpoint}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Razorpay returned ${response.status}`);
  return result;
}
function verifyRazorpaySignature(orderId, paymentId, signature, secret) {
  if (!/^[a-f0-9]{64}$/i.test(signature || '')) return false;
  const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin/setup') url.pathname = '/admin.html';
  if (url.pathname === '/account' || url.pathname === '/account/') url.pathname = '/account.html';
  if (url.pathname.startsWith('/api/customer/')) {
    if (await customerAuth.handleCustomerRequest(req, res, url)) return;
  }
  if (url.pathname.startsWith('/api/admin/') || (url.pathname === '/api/order-requests' && req.method === 'POST')) {
    await adminLocal.handleAdminRequest(req, res, url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res,200,{ ok:true, service:'APRIA', time:new Date().toISOString() });
  if (req.method === 'GET' && url.pathname === '/api/config') return send(res,200,{ whatsappNumber:(await adminLocal.readStore()).settings.whatsappNumber || process.env.WHATSAPP_NUMBER || '917888329606' });
  if (req.method === 'GET' && url.pathname === '/api/products') {
    try { return send(res,200,await adminLocal.listProducts()); }
    catch { return send(res,500,{ error:'Product catalogue unavailable' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/payment/config') {
    return send(res,200,{ enabled:!!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET), keyId:process.env.RAZORPAY_KEY_ID || '', currency:'INR', deliveryPaise:(await adminLocal.readStore()).settings.shippingFeePaise });
  }
  if (req.method === 'POST' && url.pathname === '/api/checkout/orders') {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return send(res,503,{ error:'Online payment is not configured yet. Please contact APRIA.' });
    try {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res,400,{ error:'Please submit a valid checkout.' });
      const [products, settings] = await Promise.all([adminLocal.listProducts(), adminLocal.readStore()]);
      const checkout = prepareCheckout(input,products,{ ...process.env, __shippingFeePaise:settings.settings.shippingFeePaise });
      if (checkout.error) return send(res,checkout.status,{ error:checkout.error });
      const id = randomUUID(), createdAt = new Date().toISOString();
      const razorpayOrder = await razorpayRequest('POST','orders',{
        amount:checkout.amountPaise,
        currency:'INR',
        receipt:`apria-${id.replace(/-/g,'').slice(0,28)}`,
        notes:{ apria_order_id:id }
      });
      if (!razorpayOrder.id || razorpayOrder.amount !== checkout.amountPaise || razorpayOrder.currency !== 'INR') return send(res,502,{ error:'Payment provider returned an invalid order. Please try again.' });
      const order = {
        id, razorpayOrderId:razorpayOrder.id, amountPaise:checkout.amountPaise, currency:'INR', status:'created',
        customer:checkout.customer, items:checkout.items, createdAt, updatedAt:createdAt, paymentId:'', fulfillmentStatus:'unfulfilled'
      };
      const reservationExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      try { await adminLocal.reserveStock(order, reservationExpiresAt); }
      catch (error) { return send(res,409,{ error:error.message || 'Stock changed while checkout was starting. Refresh your bag and try again.' }); }
      return send(res,201,{ ok:true, orderId:id, receipt:order.id.slice(0,8).toUpperCase(), razorpayOrderId:razorpayOrder.id, amount:checkout.amountPaise, currency:'INR', keyId:process.env.RAZORPAY_KEY_ID });
    } catch (error) {
      console.error('Checkout order creation failed:',error.message);
      return send(res,502,{ error:'Unable to start payment right now. Please try again.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/checkout/verify') {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return send(res,503,{ error:'Online payment is not configured yet. Please contact APRIA.' });
    try {
      const input = await readBody(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res,400,{ error:'Please submit valid payment details.' });
      const orderId = clean(input.orderId,80), providerOrderId = clean(input.razorpay_order_id,80), paymentId = clean(input.razorpay_payment_id,80), signature = clean(input.razorpay_signature,128);
      const order = await getLocalOrder(orderId);
      if (!order || order.razorpayOrderId !== providerOrderId) return send(res,404,{ error:'Checkout order not found. Please contact APRIA before retrying.' });
      if (order.status === 'paid') { await adminLocal.resolveReservation(order,'committed'); return send(res,200,{ ok:true,status:'paid',receipt:order.id.slice(0,8).toUpperCase() }); }
      if (!/^pay_[A-Za-z0-9]+$/.test(paymentId) || !verifyRazorpaySignature(order.razorpayOrderId,paymentId,signature,process.env.RAZORPAY_KEY_SECRET)) return send(res,400,{ error:'Payment verification failed. Do not retry yet; contact APRIA with your payment details.' });
      const payment = await razorpayRequest('GET',`payments/${encodeURIComponent(paymentId)}`);
      if (payment.order_id !== order.razorpayOrderId || payment.amount !== order.amountPaise || payment.currency !== order.currency || payment.method !== 'upi') return send(res,400,{ error:'Payment details do not match this UPI order. Please contact APRIA.' });
      order.paymentId = paymentId;
      order.status = payment.status === 'captured' && payment.captured === true ? 'paid' : payment.status === 'authorized' ? 'authorized' : 'failed';
      order.updatedAt = new Date().toISOString();
      if (order.status === 'authorized') order.reservationExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await saveLocalOrder(order);
      if (order.status === 'paid') await adminLocal.resolveReservation(order,'committed');
      else if (order.status === 'failed') await adminLocal.resolveReservation(order,'released');
      else if (order.status === 'authorized') {
        order.reservationStatus = 'reserved';
        await saveLocalOrder(order);
      }
      if (order.status !== 'paid') return send(res,202,{ ok:true,status:order.status,receipt:order.id.slice(0,8).toUpperCase(),message:order.status === 'authorized' ? 'Payment is authorised and awaiting capture. APRIA will confirm the order shortly.' : 'Payment has not been captured. Please contact APRIA before retrying.' });
      return send(res,200,{ ok:true,status:'paid',receipt:order.id.slice(0,8).toUpperCase() });
    } catch (error) {
      console.error('Checkout verification failed:',error.message);
      return send(res,502,{ error:'Unable to confirm payment right now. Keep your payment receipt and contact APRIA.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/enquiries') {
    try {
      const input = await readBody(req);
      const name=clean(input.name,100), email=clean(input.email,200), phone=clean(input.phone,40), type=clean(input.type,40), message=clean(input.message,3000);
      if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message || !['product','bulk','private-label','general'].includes(type)) return send(res,400,{ error:'Please provide your name, a valid email, enquiry type and message.' });
      if (input.website) return send(res,200,{ ok:true, id:'received' });
      const items = Array.isArray(input.items) ? input.items.slice(0,20).filter(x => x && typeof x === 'object').map(x => ({ id:clean(x.id,80), name:clean(x.name,120), size:clean(x.size,20), color:clean(x.color,80), quantity:Math.max(1,Math.min(10000,Number.parseInt(x.quantity,10)||1)) })) : [];
      const createdAt = new Date().toISOString();
      const enquiry={ id:randomUUID(), createdAt, updatedAt:createdAt, status:'new', adminNote:'', name,email,phone,type,company:clean(input.company,160), message, items, ip:getIp(req) };
      await adminLocal.updateStore((store) => { store.enquiries.unshift(enquiry); });
      await fs.promises.mkdir(DATA,{ recursive:true });
      await fs.promises.appendFile(path.join(DATA,'enquiries.jsonl'),JSON.stringify(enquiry)+'\n',{ encoding:'utf8', mode:0o600 });
      console.log(`Enquiry received ${enquiry.id} (${type})`);
      return send(res,201,{ ok:true, id:enquiry.id, message:'Thanks—your enquiry is with our team.' });
    } catch (e) { return send(res,e.message==='Invalid JSON'?400:500,{ error:e.message==='Invalid JSON'?'Please submit a valid form.':'Unable to save your enquiry right now.' }); }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res,405,{ error:'Method not allowed' });
  const requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  let file;
  try { file = path.resolve(ROOT, '.'+requested); } catch { return send(res,404,'Not found','text/plain; charset=utf-8'); }
  if (!file.startsWith(ROOT + path.sep) || file === __filename) return send(res,404,'Not found','text/plain; charset=utf-8');
  fs.stat(file,(err,stats)=>{
    if (err || !stats.isFile()) return send(res,404,'Not found','text/plain; charset=utf-8');
    const type = mime[path.extname(file)]||'application/octet-stream';
    const headers = { 'Content-Type':type,'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':'no-cache' };
    const range = path.extname(file) === '.mp4' ? req.headers.range : null;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416,{ ...headers,'Accept-Ranges':'bytes','Content-Range':`bytes */${stats.size}` });
        return res.end();
      }
      const suffix = !match[1];
      const start = suffix ? Math.max(0,stats.size-Number(match[2])) : Number(match[1]);
      const end = suffix ? stats.size-1 : Math.min(stats.size-1,match[2] ? Number(match[2]) : stats.size-1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stats.size) {
        res.writeHead(416,{ ...headers,'Accept-Ranges':'bytes','Content-Range':`bytes */${stats.size}` });
        return res.end();
      }
      res.writeHead(206,{ ...headers,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${stats.size}`,'Content-Length':end-start+1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file,{ start,end }).pipe(res);
    }
    res.writeHead(200,{ ...headers,'Content-Length':stats.size,...(path.extname(file) === '.mp4' ? { 'Accept-Ranges':'bytes' } : {}) });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT,HOST,()=>console.log(`APRIA running at http://localhost:${PORT}`));
async function reconcileLocalReservations() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return;
  for (const order of await adminLocal.reconciliationCandidates()) {
    try {
      const result = await razorpayRequest('GET',`orders/${encodeURIComponent(order.razorpayOrderId)}/payments`), items = result.items || [];
      const captured = items.find((payment) => payment.status === 'captured' && payment.captured === true && payment.order_id === order.razorpayOrderId);
      const authorized = items.find((payment) => payment.status === 'authorized' && payment.order_id === order.razorpayOrderId);
      if (captured) { order.status='paid'; order.paymentId=captured.id; order.updatedAt=new Date().toISOString(); await saveLocalOrder(order); await adminLocal.resolveReservation(order,'committed'); }
      else if (authorized) { order.status='authorized'; order.paymentId=authorized.id; order.reservationExpiresAt=new Date(Date.now()+15*60*1000).toISOString(); await saveLocalOrder(order); }
      else { order.status='failed'; order.updatedAt=new Date().toISOString(); await saveLocalOrder(order); await adminLocal.resolveReservation(order,'released'); }
    } catch (error) { console.error('Stock reservation reconciliation deferred:',error.message); }
  }
}
const reservationTimer = setInterval(() => reconcileLocalReservations().catch((error) => console.error('Stock reservation reconciliation failed:',error.message)), 5 * 60 * 1000);
reservationTimer.unref?.();
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)));

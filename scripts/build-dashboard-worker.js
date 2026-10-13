const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const outputDir = path.join(root, 'work');
const workerPath = path.join(root, 'worker.js');
const adminModulePath = path.join(root, 'admin-worker.mjs');
const customerModulePath = path.join(root, 'customer-worker.mjs');
const outputPath = path.join(outputDir, 'apria-cloudflare-worker.js');
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const assets = {};
for (const entry of fs.readdirSync(publicDir, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const absolutePath = path.join(publicDir, entry.name);
  const extension = path.extname(entry.name).toLowerCase();
  assets[`/${entry.name}`] = {
    body: zlib.gzipSync(fs.readFileSync(absolutePath), { level: 9 }).toString('base64'),
    encoding: 'gzip',
    type: mimeTypes[extension] || 'application/octet-stream',
  };
}

let source = fs.readFileSync(workerPath, 'utf8');
const adminImport = "import { handleAdminRequest, publicProducts, publicSettings, createStockReservation, resolveStockReservation, reconcileExpiredReservations } from './admin-worker.mjs';";
if (!source.includes(adminImport)) throw new Error(`Could not find the admin module import in ${workerPath}`);
const adminModule = fs.readFileSync(adminModulePath, 'utf8').replace(/^export /gm, '');
source = source.replace(adminImport, '').replace('const MAX_BODY = 20_000;', () => `const { handleAdminRequest, publicProducts, publicSettings, createStockReservation, resolveStockReservation, reconcileExpiredReservations } = (() => {\n${adminModule}\nreturn { handleAdminRequest, publicProducts, publicSettings, createStockReservation, resolveStockReservation, reconcileExpiredReservations };\n})();\n\nconst MAX_BODY = 20_000;`);
const customerImport = "import { handleCustomerRequest } from './customer-worker.mjs';";
if (!source.includes(customerImport)) throw new Error(`Could not find the customer module import in ${workerPath}`);
const customerModule = fs.readFileSync(customerModulePath, 'utf8').replace(/^export /gm, '');
source = source.replace(customerImport, '').replace('const MAX_BODY = 20_000;', () => `const { handleCustomerRequest } = (() => {\n${customerModule}\nreturn { handleCustomerRequest };\n})();\n\nconst MAX_BODY = 20_000;`);
const placeholder = 'const EMBEDDED_ASSETS = {};';
if (!source.includes(placeholder)) {
  throw new Error(`Could not find asset placeholder in ${workerPath}`);
}
source = source.replace(placeholder, `const EMBEDDED_ASSETS = ${JSON.stringify(assets)};`);
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, source);
console.log(`Built dashboard Worker at ${outputPath} with ${Object.keys(assets).length} embedded assets (${Buffer.byteLength(source)} bytes).`);

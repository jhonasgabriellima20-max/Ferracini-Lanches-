const fs = require('fs');

function stop(message){
  console.error('CHECK FALHOU:', message);
  process.exit(1);
}

const required = [
  'package.json',
  'vercel.json',
  'api/catalogo.json',
  'api/pedidos.js',
  'api/disponibilidade.js',
  'api/painel-pedidos.js',
  'api/comanda.js',
  'lib/postgres-storage.js',
  'scripts/test-neon-storage.js'
];

for (const file of required) {
  if (!fs.existsSync(file)) stop('arquivo ausente: ' + file);
}

let pkg;
let config;
let catalog;
try { pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); }
catch (err) { stop('package.json inválido: ' + err.message); }
try { config = JSON.parse(fs.readFileSync('vercel.json', 'utf8')); }
catch (err) { stop('vercel.json inválido: ' + err.message); }
try { catalog = JSON.parse(fs.readFileSync('api/catalogo.json', 'utf8')); }
catch (err) { stop('catalogo inválido: ' + err.message); }

if (!pkg.dependencies || !pkg.dependencies['@vercel/oidc']) {
  stop('@vercel/oidc ausente');
}
if (pkg.dependencies['@vercel/blob']) stop('@vercel/blob ainda presente');
if (pkg.dependencies['@neondatabase/serverless']) stop('driver direto do banco ainda presente');

if (fs.existsSync('lib/blob-storage.js')) stop('blob-storage legado ainda existe');
if (fs.existsSync('lib/blob-auth.js')) stop('blob-auth legado ainda existe');

const storage = fs.readFileSync('lib/postgres-storage.js', 'utf8');
for (const needle of [
  '@vercel/oidc',
  'getVercelOidcToken',
  'STORAGE_FUNCTION_URL',
  'ferracinistore.compute',
  'callStorage',
  "mode:'postgres'",
  'STORAGE_UNAVAILABLE'
]) {
  if (!storage.includes(needle)) stop('storage incompleto: ' + needle);
}
if (storage.includes('.apirest.')) stop('referência antiga à Data API');

for (const file of [
  'lib/postgres-storage.js',
  'api/pedidos.js',
  'api/disponibilidade.js',
  'api/painel-pedidos.js',
  'api/comanda.js',
  'scripts/test-neon-storage.js'
]) {
  const src = fs.readFileSync(file, 'utf8');
  try { new Function(src); }
  catch (err) { stop('JavaScript inválido em ' + file + ': ' + err.message); }
}

for (const file of [
  'api/pedidos.js',
  'api/disponibilidade.js',
  'api/painel-pedidos.js',
  'api/comanda.js'
]) {
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes("require('../lib/postgres-storage')")) {
    stop(file + ' não usa postgres-storage');
  }
  if (src.includes("require('../lib/blob-storage')")) {
    stop(file + ' ainda usa blob-storage');
  }
}

if (!String(config.buildCommand || '').includes('scripts/test-neon-storage.js')) {
  stop('teste Neon não é obrigatório no build');
}

if (Object.keys(catalog.produtos || {}).length !== 27) stop('quantidade de produtos divergente');
if (Object.keys(catalog.adicionais || {}).length !== 17) stop('quantidade de adicionais divergente');

console.log('Migração Neon passou nos checks críticos.');

const fs = require('fs');

let failed = false;
function fail(message){
  console.error('CHECK FALHOU:', message);
  failed = true;
}

const required = [
  'index.html','admin.html','mesa.html','pedidos.html','vercel.json','package.json',
  'api/catalogo.json','api/comanda.js','api/distancia.js','api/disponibilidade.js',
  'api/painel-pedidos.js','api/pedidos.js','lib/delivery-distance.js',
  'lib/postgres-storage.js','scripts/test-neon-storage.js'
];
for(const file of required){
  if(!fs.existsSync(file)) fail('arquivo ausente: '+file);
}

for(const file of [
  'api/comanda.js','api/distancia.js','api/disponibilidade.js',
  'api/painel-pedidos.js','api/pedidos.js','lib/delivery-distance.js',
  'lib/postgres-storage.js','scripts/test-neon-storage.js'
]){
  if(!fs.existsSync(file)) continue;
  try{ new Function(fs.readFileSync(file,'utf8')); }
  catch(err){ fail(file+': JavaScript inválido — '+err.message); }
}

try{
  const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
  if(!pkg.dependencies?.['@vercel/oidc']) fail('package.json: @vercel/oidc ausente');
  if(pkg.dependencies?.['@vercel/blob']) fail('package.json: @vercel/blob ainda presente');
  if(pkg.dependencies?.['@neondatabase/serverless']) fail('package.json: driver direto do banco ainda presente');
}catch(err){ fail('package.json inválido — '+err.message); }

if(fs.existsSync('lib/blob-storage.js')) fail('lib/blob-storage.js ainda existe');
if(fs.existsSync('lib/blob-auth.js')) fail('lib/blob-auth.js ainda existe');

if(fs.existsSync('lib/postgres-storage.js')){
  const storage=fs.readFileSync('lib/postgres-storage.js','utf8');
  for(const [needle,label] of [
    ['@vercel/oidc','OIDC da Vercel'],
    ['getVercelOidcToken','obtenção do token OIDC'],
    ['STORAGE_FUNCTION_URL','Neon Function de armazenamento'],
    ['callStorage','chamada à Neon Function'],
    ["mode:'postgres'",'modo PostgreSQL'],
    ['STORAGE_UNAVAILABLE','fallback de indisponibilidade'],
  ]){
    if(!storage.includes(needle)) fail('lib/postgres-storage.js: '+label);
  }
  if(storage.includes('apirest.sa-east-1')) fail('lib/postgres-storage.js: Data API antiga ainda referenciada');
}

for(const file of ['api/pedidos.js','api/disponibilidade.js','api/painel-pedidos.js','api/comanda.js']){
  if(!fs.existsSync(file)) continue;
  const src=fs.readFileSync(file,'utf8');
  if(!src.includes("require('../lib/postgres-storage')")){
    fail(file+': não usa postgres-storage');
  }
  if(src.includes("require('../lib/blob-storage')")){
    fail(file+': ainda usa blob-storage');
  }
}

if(fs.existsSync('api/pedidos.js')){
  const api=fs.readFileSync('api/pedidos.js','utf8');
  for(const needle of [
    "require('./catalogo.json')",'PRINT_AGENT_TOKEN','timingSafeEqual',
    'origemPermitida','rateLimit','clientRequestId','validarEntregaNoServidor',
    'Math.ceil((distanciaKm * 2.30) - 1e-9) * 100'
  ]){
    if(!api.includes(needle)) fail('api/pedidos.js: proteção ausente '+needle);
  }
}

for(const file of ['index.html','mesa.html']){
  if(!fs.existsSync(file)) continue;
  const html=fs.readFileSync(file,'utf8');
  if(!html.includes('/api/pedidos')) fail(file+': /api/pedidos ausente');
  if(!html.includes('5543998075190')) fail(file+': WhatsApp da loja ausente');
  if(!html.includes('registroFallbackWhatsapp')) fail(file+': fallback WhatsApp ausente');
  if(!html.includes('controller.abort(), 4000')) fail(file+': timeout seguro de 4s ausente');
  const scripts=[...html.matchAll(/<script\\b([^>]*)>([\\s\\S]*?)<\\/script>/gi)];
  for(const [,attrs,source] of scripts){
    if(/\\bsrc\\s*=/.test(attrs)||/application\\/ld\\+json/i.test(attrs)) continue;
    try{ new Function(source); }
    catch(err){ fail(file+': JavaScript inline inválido — '+err.message); }
  }
}

if(fs.existsSync('index.html')){
  const html=fs.readFileSync('index.html','utf8');
  if(!/valorPorKm\s*:\s*2\.30\b/.test(html)) fail('index.html: R$ 2,30/km ausente');
  if(!html.includes('endCep')) fail('index.html: CEP ausente');
  if(!/cartao\s*:\s*['"]Cartão['"]/.test(html)) fail('index.html: cartão na retirada ausente');
}

try{
  const c=JSON.parse(fs.readFileSync('api/catalogo.json','utf8'));
  if(Object.keys(c.produtos||{}).length!==27) fail('catálogo: produtos divergentes');
  if(Object.keys(c.adicionais||{}).length!==17) fail('catálogo: adicionais divergentes');
}catch(err){ fail('api/catalogo.json inválido — '+err.message); }

try{
  const config=JSON.parse(fs.readFileSync('vercel.json','utf8'));
  if(!String(config.buildCommand||'').includes('test-neon-storage.js')){
    fail('vercel.json: teste Neon não é obrigatório');
  }
  const headers=(config.headers||[]).flatMap(x=>x.headers||[]).map(x=>x.key);
  for(const h of ['Content-Security-Policy','X-Content-Type-Options','X-Frame-Options','Strict-Transport-Security']){
    if(!headers.includes(h)) fail('vercel.json: header ausente '+h);
  }
}catch(err){ fail('vercel.json inválido — '+err.message); }

if(failed) process.exit(1);
console.log('Snapshot passou nas verificações críticas e de segurança.');

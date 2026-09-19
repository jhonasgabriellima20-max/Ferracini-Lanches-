const fs = require('fs');
const path = require('path');

const required = [
  'index.html', 'admin.html', 'mesa.html', 'vercel.json', 'package.json',
  'api/catalogo.json', 'api/comanda.js', 'api/distancia.js', 'api/disponibilidade.js',
  'api/painel-pedidos.js', 'api/pedidos.js', 'lib/delivery-distance.js', 'lib/blob-storage.js'
];

let failed = false;
function fail(message){
  console.error(`CHECK FALHOU: ${message}`);
  failed = true;
}

for(const file of required){
  if(!fs.existsSync(path.join(process.cwd(), file))) fail(`arquivo ausente: ${file}`);
}

function checkHtml(file, isMesa){
  if(!fs.existsSync(file)) return;
  const html = fs.readFileSync(file, 'utf8');
  const checks = [
    ['/api/distancia', 'endpoint de frete'],
    ['/api/pedidos', 'registro seguro de pedidos'],
    [/valorPorKm\s*:\s*2\.30\b/, 'valor de R$ 2,30/km'],
    [/Math\.ceil\(\(data\.distanciaKm\s*\*\s*CONFIG\.entrega\.valorPorKm\)\s*-\s*1e-9\)/, 'arredondamento inteiro do frete'],
    ['endCep', 'campo CEP'],
    ['carregarDisponibilidade', 'disponibilidade'],
    ['montarPayloadPedido', 'payload da fila de impressão'],
    ['clientRequestIdAtual', 'idempotência do envio'],
    ['registrarPedidoNoSistema', 'registro direto no sistema'],
  ];

  for(const [check, label] of checks){
    const ok = check instanceof RegExp ? check.test(html) : html.includes(check);
    if(!ok) fail(`${file}: ${label}`);
  }

  if(!html.includes('https://wa.me/') || !html.includes('5543998075190')) fail(`${file}: WhatsApp da loja ausente`);

  if(/fetch\(['"]\/api\/comanda/.test(html)) fail(`${file}: ainda usa endpoint legado de comanda`);
  if(html.includes('\\`') || html.includes('\\${')) fail(`${file}: template literal escapado incorretamente`);

  if(isMesa){
    if(!/tipo\s*:\s*['"]mesa['"]/.test(html)) fail(`${file}: identificação da mesa`);
  }else{
    if(!/data-method\s*=\s*['"]retirada['"]/i.test(html) || !/Retirar no local/i.test(html)){
      fail(`${file}: opção de retirada ausente no site principal`);
    }
    if(!/data-method\s*=\s*['"]entrega['"]/i.test(html)){
      fail(`${file}: opção de entrega ausente no site principal`);
    }
    if(!/tipo\s*:\s*deliveryMethod/.test(html)){
      fail(`${file}: tipo de atendimento não acompanha a escolha retirada/entrega`);
    }
  }

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for(const [, attrs, source] of scripts){
    if(/\bsrc\s*=/.test(attrs) || /application\/ld\+json/i.test(attrs)) continue;
    try{ new Function(source); }
    catch(err){ fail(`${file}: JavaScript inválido — ${err.message}`); }
  }
}

checkHtml('index.html', false);
checkHtml('mesa.html', true);

if(fs.existsSync('api/pedidos.js')){
  const api = fs.readFileSync('api/pedidos.js', 'utf8');
  const securityChecks = [
    ["require('./catalogo.json')", 'catálogo canônico no servidor'],
    ["require('../lib/delivery-distance')", 'cálculo compartilhado de distância no servidor'],
    ['CATALOGO.produtos', 'validação de preços no servidor'],
    ['PRINT_AGENT_TOKEN', 'token privado do agente de impressão'],
    ['timingSafeEqual', 'comparação segura de token'],
    ['origemPermitida', 'validação de origem'],
    ['rateLimit', 'limite de requisições'],
    ['MAX_BODY_BYTES', 'limite do corpo'],
    ['clientRequestId', 'idempotência'],
    ["require('../lib/blob-storage')", 'camada segura de armazenamento'],
    ['Math.ceil((distanciaKm * 2.30) - 1e-9) * 100', 'validação do frete no servidor'],
    ['validarEntregaNoServidor', 'revalidação da distância antes de registrar pedido'],
    ['MAX_DISTANCE_DELTA_KM', 'tolerância controlada para divergência de distância'],
    ["content-type", 'validação de Content-Type'],
  ];
  for(const [needle, label] of securityChecks){
    if(!api.includes(needle)) fail(`api/pedidos.js: ${label}`);
  }
}

if(fs.existsSync('api/disponibilidade.js')){
  const api = fs.readFileSync('api/disponibilidade.js', 'utf8');
  for(const [needle, label] of [
    ['AUTH_MAX_FAILURES', 'limite de tentativas administrativas'],
    ['recordAuthFailure', 'registro de falhas de autenticação'],
    ['timingSafeEqual', 'comparação segura de senha'],
    ['Retry-After', 'resposta de bloqueio temporário'],
  ]){
    if(!api.includes(needle)) fail(`api/disponibilidade.js: ${label}`);
  }
}

if(fs.existsSync('api/painel-pedidos.js')){
  const api = fs.readFileSync('api/painel-pedidos.js', 'utf8');
  for(const [needle, label] of [
    ['AUTH_MAX_FAILURES', 'limite de tentativas no painel de pedidos'],
    ['timingSafeEqual', 'comparação segura de senha'],
    ['Retry-After', 'bloqueio temporário'],
  ]){
    if(!api.includes(needle)) fail(`api/painel-pedidos.js: ${label}`);
  }
}

if(fs.existsSync('api/comanda.js')){
  const api = fs.readFileSync('api/comanda.js', 'utf8');
  for(const [needle, label] of [
    ['credencialValida', 'proteção do endpoint legado'],
    ['PRINT_AGENT_TOKEN', 'token do agente'],
    ['ADMIN_PASSWORD', 'senha administrativa como credencial alternativa'],
    ['Endpoint interno protegido', 'negação pública do endpoint legado'],
  ]){
    if(!api.includes(needle)) fail(`api/comanda.js: ${label}`);
  }
}

if(fs.existsSync('api/catalogo.json')){
  try{
    const catalogo = JSON.parse(fs.readFileSync('api/catalogo.json', 'utf8'));
    const nomesProdutos = Object.keys(catalogo.produtos || {});
    const nomesAdicionais = Object.keys(catalogo.adicionais || {});
    if(nomesProdutos.length !== 23) fail('api/catalogo.json: quantidade de produtos inesperada');
    if(nomesAdicionais.length !== 17) fail('api/catalogo.json: quantidade de adicionais inesperada');

    for(const file of ['index.html', 'mesa.html']){
      if(!fs.existsSync(file)) continue;
      const html = fs.readFileSync(file, 'utf8');

      for(const nome of nomesProdutos){
        const escaped = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const preco = catalogo.produtos[nome].precoCentavos / 100;
        const pattern = new RegExp(`nome:\\s*["']${escaped}["']\\s*,\\s*preco:\\s*${preco.toFixed(2)}\\b`);
        if(!pattern.test(html)) fail(`${file}: catálogo divergente para ${nome}`);
      }

      for(const nome of nomesAdicionais){
        const escaped = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const preco = catalogo.adicionais[nome] / 100;
        const pattern = new RegExp(`nome:\\s*["']${escaped}["'][^}]+preco:\\s*${preco.toFixed(2)}\\b`);
        if(!pattern.test(html)) fail(`${file}: adicional divergente para ${nome}`);
      }
    }
  }catch(err){ fail(`api/catalogo.json inválido — ${err.message}`); }
}

if(fs.existsSync('vercel.json')){
  try{
    const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
    const allHeaders = (config.headers || []).flatMap(item => item.headers || []).map(item => item.key);
    for(const name of ['Content-Security-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']){
      if(!allHeaders.includes(name)) fail(`vercel.json: cabeçalho ${name}`);
    }
  }catch(err){ fail(`vercel.json inválido — ${err.message}`); }
}

if(fs.existsSync('package.json')){
  try{
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const blobVersion = String(pkg.dependencies?.['@vercel/blob'] || '');
    if(!/^\^?2\.(?:8|9|[1-9]\d)\./.test(blobVersion)) fail('package.json: @vercel/blob precisa estar em 2.8.0 ou superior');
  }catch(err){ fail(`package.json inválido — ${err.message}`); }
}

if(fs.existsSync('lib/blob-storage.js')){
  const storage = fs.readFileSync('lib/blob-storage.js', 'utf8');
  for(const [needle, label] of [
    ["aes-256-gcm", 'criptografia AES-256-GCM'],
    ["access, useCache: false", 'leitura compatível por modo de acesso'],
    ["'private'", 'preferência por armazenamento privado'],
    ["'public'", 'fallback público criptografado'],
    ['STORAGE_ENCRYPTION_KEY', 'chave de criptografia dedicada opcional'],
  ]){
    if(!storage.includes(needle)) fail(`lib/blob-storage.js: ${label}`);
  }
}

for(const file of ['api/comanda.js', 'api/distancia.js', 'api/disponibilidade.js', 'api/painel-pedidos.js', 'api/pedidos.js', 'lib/delivery-distance.js', 'lib/blob-storage.js']){
  if(!fs.existsSync(file)) continue;
  try{ new Function(fs.readFileSync(file, 'utf8')); }
  catch(err){ fail(`${file}: JavaScript inválido — ${err.message}`); }
}

if(failed) process.exit(1);
console.log('Snapshot passou nas verificações estáticas e de segurança.');

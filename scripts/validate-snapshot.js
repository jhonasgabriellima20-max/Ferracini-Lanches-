const fs = require('fs');
const path = require('path');

const required = [
  'index.html', 'admin.html', 'mesa.html', 'vercel.json', 'package.json',
  'api/catalogo.json', 'api/comanda.js', 'api/distancia.js', 'api/disponibilidade.js', 'api/pedidos.js'
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
    ['valorPorKm: 2.30', 'valor de R$ 2,30/km'],
    ['Math.ceil((data.distanciaKm * CONFIG.entrega.valorPorKm) - 1e-9)', 'arredondamento inteiro do frete'],
    ['endCep', 'campo CEP'],
    ['carregarDisponibilidade', 'disponibilidade'],
    ['montarPayloadPedido', 'payload da fila de impressão'],
    ['clientRequestIdAtual', 'idempotência do envio'],
    ['5543998075190', 'WhatsApp da loja'],
  ];
  for(const [needle, label] of checks){
    if(!html.includes(needle)) fail(`${file}: ${label}`);
  }
  if(/fetch\(['"]\/api\/comanda/.test(html)) fail(`${file}: ainda usa endpoint legado de comanda`);
  if(html.includes('\\`') || html.includes('\\${')) fail(`${file}: template literal escapado incorretamente`);
  if(isMesa && !html.includes("tipo: 'mesa'")) fail(`${file}: identificação da mesa`);

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
    ['CATALOGO.produtos', 'validação de preços no servidor'],
    ['PRINT_AGENT_TOKEN', 'token privado do agente de impressão'],
    ['timingSafeEqual', 'comparação segura de token'],
    ['origemPermitida', 'validação de origem'],
    ['rateLimit', 'limite de requisições'],
    ['MAX_BODY_BYTES', 'limite do corpo'],
    ['clientRequestId', 'idempotência'],
    ["access: 'private'", 'armazenamento privado'],
    ['Math.ceil((distanciaKm * 2.30) - 1e-9) * 100', 'validação do frete no servidor'],
  ];
  for(const [needle, label] of securityChecks){
    if(!api.includes(needle)) fail(`api/pedidos.js: ${label}`);
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
        const preco = catalogo.produtos[nome].precoCentavos / 100;
        const trecho = `nome:"${nome}", preco:${preco.toFixed(2)}`;
        if(!html.includes(trecho)) fail(`${file}: catálogo divergente para ${nome}`);
      }
      for(const nome of nomesAdicionais){
        const escaped = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\if(fs.existsSync('vercel.json')){');
        const preco = catalogo.adicionais[nome] / 100;
        const pattern = new RegExp(`nome: ["']${escaped}["'][^}]+preco: ${preco.toFixed(2)}`);
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

for(const file of ['api/comanda.js', 'api/distancia.js', 'api/disponibilidade.js', 'api/pedidos.js']){
  if(!fs.existsSync(file)) continue;
  try{ new Function(fs.readFileSync(file, 'utf8')); }
  catch(err){ fail(`${file}: JavaScript inválido — ${err.message}`); }
}

if(failed) process.exit(1);
console.log('Snapshot passou nas verificações estáticas e de segurança.');

const fs = require('fs');
const path = require('path');

const required = [
  'index.html', 'admin.html', 'mesa.html', 'vercel.json', 'package.json',
  'api/distancia.js', 'api/disponibilidade.js'
];

let failed = false;
for (const file of required) {
  if (!fs.existsSync(path.join(process.cwd(), file))) {
    console.error(`FALTANDO: ${file}`);
    failed = true;
  }
}

if (fs.existsSync('index.html')) {
  const html = fs.readFileSync('index.html', 'utf8');
  const checks = [
    ['/api/distancia', 'endpoint de frete'],
    ['valorPorKm: 2.30', 'valor de R$ 2,30/km'],
    ['endCep', 'campo CEP'],
    ['carregarDisponibilidade', 'disponibilidade'],
    ['5543998075190', 'WhatsApp da loja']
  ];
  for (const [needle, label] of checks) {
    if (!html.includes(needle)) {
      console.error(`CHECK FALHOU: ${label}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log('Snapshot passou nas verificações estáticas básicas.');

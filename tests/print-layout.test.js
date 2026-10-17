const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname,'..','printer-agent','FerraciniPrintAgent.ps1'),'utf8');

assert.match(script, /function Send-ToPrinter/);
assert.match(script, /FerraciniReceiptPrinter/);
assert.match(script, /System\.Drawing\.Printing/);
assert.match(script, /new PaperSize\("Ferracini 80 mm", 315, approxHeight\)/);
assert.match(script, /doc\.PrintController = new StandardPrintController\(\)/);
assert.match(script, /g\.DrawString\(line/);
assert.match(script, /StringFormatFlags\.NoWrap/);
assert.match(script, /float availableWidth = limitX - x/);
assert.match(script, /e\.HasMorePages = nextLine < lines\.Length/);
assert.doesNotMatch(script, /\|\s*Out-Printer/);
assert.match(script, /Send-ToPrinter \$text \(\[string\]\$cfg\.printerName\)/);
assert.match(script, /Send-ToPrinter \$receipt \$printerName/);

assert.match(script, /function Receipt-Label/);
assert.match(script, /useEmojis = \$true/);
assert.match(script, /Format-Receipt \$pedido \$width \$useEmojis/);
assert.match(script, /FontStyle\.Bold/);
assert.match(script, /PAGO PELO SITE - MERCADO PAGO/);
assert.match(script, /pagamento\.mpOrderId/);
assert.match(script, /Defesa adicional: nunca enviar comanda sem pagamento aprovado/);
assert.match(script, /FontStyle\.Bold, GraphicsUnit\.Point/);

assert.match(script, /private static bool IsTotal/);
assert.match(script, /private static bool IsImportant/);
assert.match(script, /Taxa de servico:/);
assert.match(script, /if \(\$tipo -ne 'mesa'\)/);
assert.match(script, /NAO E PEDIDO REAL/);
assert.match(script, /numero = 'TESTE'/);
assert.match(script, /taxaServicoCentavos = 300/);
assert.match(script, /'🧾'/);
assert.match(script, /'💰'/);
assert.match(script, /'🍔'/);
assert.match(script, /'👤'/);
assert.match(script, /'➕'/);
assert.match(script, /\$null -eq \$cfg\.useEmojis/);

console.log('OK: bobina 80 mm, negrito, icones, taxa de servico, sem pagamento na mesa e teste ficticio.');

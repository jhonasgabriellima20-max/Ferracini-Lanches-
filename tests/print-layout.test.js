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
console.log('OK: impressão a 80 mm, sem formatacao A4, com paginacao e reuso no teste e pedidos.');

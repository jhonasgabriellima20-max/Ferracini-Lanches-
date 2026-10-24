// O expediente atravessa a meia-noite; o próximo dia começa às 06h de São Paulo.
(function(root){
  function dataOperacao(agora = new Date()){
    const partes = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(agora).map(p => [p.type, p.value]));
    const dia = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, Number(partes.day)));
    if(Number(partes.hour) < 6) dia.setUTCDate(dia.getUTCDate() - 1);
    return dia.toISOString().slice(0, 10);
  }
  if(typeof module === 'object' && module.exports) module.exports = { dataOperacao };
  else root.FerraciniExpediente = { dataOperacao };
})(globalThis);

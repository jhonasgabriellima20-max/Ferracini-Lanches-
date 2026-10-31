// Inspects presence and optionally performs a read-only account request.
// Never prints credential values or provider response bodies.
const args = new Set(process.argv.slice(2));
const required = ['MP_PUBLIC_KEY', 'MP_ACCESS_TOKEN'];
const enabled = process.env.MP_CARD_CHECKOUT_ENABLED === 'true';
if(process.env.VERCEL_ENV !== 'preview') required.push('MP_WEBHOOK_SECRET');
const missing = required.filter(name => !process.env[name]?.trim());
async function main(){
  if(!enabled && !args.has('--require-enabled')){
    console.log('Mercado Pago desativado. Instalar este código não ativa cobranças.');
    return;
  }
  if(!enabled){
    console.error('Falta habilitar MP_CARD_CHECKOUT_ENABLED após autorização e configuração.');
    process.exitCode = 1;
  }
  if(missing.length){
    console.error('Variáveis ausentes: ' + missing.join(', ') + '. Configure-as no painel seguro da Vercel.');
    process.exitCode = 1;
    return;
  }
  console.log('Variáveis de pagamento presentes. Isso não valida credenciais, banco ou cobrança.');
  if(args.has('--check-provider')){
    try{
      const response = await fetch('https://api.mercadopago.com/users/me', {
        headers:{Authorization:'Bearer ' + process.env.MP_ACCESS_TOKEN, Accept:'application/json'},
        redirect:'error', signal:AbortSignal.timeout(15000),
      });
      if(!response.ok){
        console.error('Consulta de conta Mercado Pago recusada: HTTP ' + response.status + '. Nenhuma cobrança foi criada.');
        process.exitCode = 1;
        return;
      }
      console.log('Acesso de leitura à conta Mercado Pago confirmado; cobrança e aplicação ainda exigem teste no Preview.');
    }catch{
      console.error('Consulta Mercado Pago indisponível. Verifique rede e credenciais; nenhuma cobrança foi criada.');
      process.exitCode = 1;
    }
  }
}
main().catch(() => { console.error('Pré-validação indisponível.'); process.exitCode = 1; });

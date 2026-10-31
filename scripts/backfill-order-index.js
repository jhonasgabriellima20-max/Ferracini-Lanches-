// Run with the old application's new orders paused/drained and a backup made.
// Dry-run is the default. --apply is the only flag that permits index inserts.
// Perform this migration before installing/activating the new order flow.
const {backfillOrderIndex}=require('../lib/order-index-backfill');

async function main(){
  const args=process.argv.slice(2);
  if(args.includes('--help')){
    console.log('Uso: node scripts/backfill-order-index.js [--apply]');
    console.log('Sem --apply: somente leitura. Antes de aplicar, pause e drene novos pedidos do aplicativo antigo e preserve backup do banco. Execute antes de instalar/ativar o fluxo novo.');
    console.log('Usa PRINT_QUEUE_DATABASE_URL existente; VERCEL_ENV=preview restringe a mp-preview/. Não altere bindings nem envie valores em chat.');
    return;
  }
  if(args.some(arg=>arg !== '--apply') || args.filter(arg=>arg==='--apply').length > 1){
    console.error('Argumentos inválidos. Use --help.');process.exitCode=1;return;
  }
  if(!process.env.PRINT_QUEUE_DATABASE_URL?.trim()){
    console.error('PRINT_QUEUE_DATABASE_URL ausente. Configure o binding existente no ambiente seguro; nenhuma migração foi executada.');
    process.exitCode=1;return;
  }
  try{
    const {neon}=require('@neondatabase/serverless');
    const report=await backfillOrderIndex(neon(process.env.PRINT_QUEUE_DATABASE_URL),{
      namespace:process.env.VERCEL_ENV==='preview'?'mp-preview/':'',apply:args.includes('--apply'),
    });
    // Counts only: never print paths, customer records or connection/error data.
    console.log(JSON.stringify(report));
    if(report.blocked) process.exitCode=2;
  }catch{
    console.error('Migração não concluída. Verifique acesso e integridade do banco; nenhuma alteração parcial desta operação é mantida.');
    process.exitCode=1;
  }
}
main().catch(()=>{console.error('Migração indisponível.');process.exitCode=1;});

const assert=require('node:assert/strict');
const fs=require('node:fs');
process.env.VERCEL_ENV='production';
const handler=require('../api/pedidos');
const request=()=>({method:'POST',headers:{origin:'https://ferracinilanches.com.br','content-type':'application/json'},body:{clientRequestId:'test'},query:{}});
async function call(){
 const res={statusCode:200,setHeader(){return this;},status(code){this.statusCode=code;return this;},json(payload){this.body=payload;return this;}};
 await handler(request(),res);
 return res;
}
(async()=>{
 for(const env of ['production','preview']){
  process.env.VERCEL_ENV=env;
  const resp=await call();
  assert.equal(resp.statusCode,503,'Pedido nao pago deve ser bloqueado em '+env);
  assert.equal(resp.body.pedidoConfirmado,false);
  assert.equal(resp.body.pagamentoVerificado,false);
  assert.equal(resp.body.checkoutSuspenso,true);
 }
 for(const name of ['index.html','mesa.html']){
  const page=fs.readFileSync(require('node:path').join(__dirname,'..',name),'utf8');
  assert.match(page,/function paymentOptionsForMethod/);
  assert.doesNotMatch(page,/return \['pix'/);
  assert.match(page,/temporariamente/);
 }
 console.log('OK: checkout suspenso, sem Pix e sem criacao de comanda nao paga em Production/Preview');
})().catch(err=>{console.error(err);process.exitCode=1;});

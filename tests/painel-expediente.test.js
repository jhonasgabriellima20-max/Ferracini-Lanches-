const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let now = '2026-10-25T02:59:00Z';
const RealDate = Date;
class Clock extends RealDate {
  constructor(...args){ super(...(args.length ? args : [now])); }
  static now(){ return new RealDate(now).getTime(); }
}
const elements = new Map();
const el = id => {
  if(!elements.has(id)) elements.set(id, {value:'', textContent:'', innerHTML:'', addEventListener(){}, classList:{add(){},remove(){}}});
  return elements.get(id);
};
const queries = [];
const context = vm.createContext({Date:Clock, Intl, console, Set, Map,
  sessionStorage:{getItem(){return '';}},
  document:{getElementById:el, querySelectorAll:()=>[]},
  fetch:async url=>{
    queries.push(url);
    return {ok:true, status:200, json:async()=>({pedidos:[],total:0,dias:[]})};
  }
});
vm.runInContext(fs.readFileSync('assets/dia-operacao.js','utf8'), context);
const html = fs.readFileSync('pedidos.html','utf8');
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
(async()=>{
  assert.equal(vm.runInContext('diaSelecionado',context),'2026-10-24');
  now='2026-10-25T03:01:00Z';
  await vm.runInContext('carregar()',context);
  assert.equal(vm.runInContext('diaSelecionado',context),'2026-10-24');
  now='2026-10-25T09:00:00Z';
  await vm.runInContext('carregar()',context);
  assert.equal(vm.runInContext('diaSelecionado',context),'2026-10-25');
  assert.equal(el('count').textContent,'0 pedidos');
  assert.ok(queries.some(q=>q.includes('data=2026-10-25')));
  vm.runInContext("diaSelecionado='2026-10-20'; acompanhandoHoje=false",context);
  now='2026-10-26T09:00:00Z';
  await vm.runInContext('carregar()',context);
  assert.equal(vm.runInContext('diaSelecionado',context),'2026-10-20');
  console.log('OK - painel aberto acompanha expediente, preserva meia-noite e consulta ao histórico');
})().catch(e=>{console.error(e);process.exitCode=1;});

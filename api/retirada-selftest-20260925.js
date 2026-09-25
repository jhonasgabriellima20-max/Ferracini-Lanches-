const { estimarPrazo } = require('../lib/prep-estimator');

module.exports = async function handler(req, res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  if(req.method !== 'GET') return res.status(405).json({error:'method'});
  try{
    const config = await require('./disponibilidade').readPrepConfig();
    const itens = [
      {nome:'X-Salada', quantidade:11},
      {nome:'X-Frango', quantidade:1},
      {nome:'Dog Simples', quantidade:1},
      {nome:'X-Bacon (1 Kilo)', quantidade:1},
    ];
    const pequeno = [{nome:'X-Salada', quantidade:1}];
    const agora = new Date();
    const prior = (items, minutesAgo) => ({
      criadoEm: new Date(agora.getTime() - minutesAgo * 60000).toISOString(),
      itens: items,
    });
    const filaLeve = Array.from({length:15}, (_,i) => prior([{nome:'X-Salada',quantidade:1}], 30 - i*2));
    const filaMedia = Array.from({length:15}, (_,i) => prior([{nome:'X-Salada',quantidade:1},{nome:'X-Bacon (1 Kilo)',quantidade:1}], 30 - i*2));

    const [retiradaAtual, retiradaPequena, retirada15Leves, retirada15Medias] = await Promise.all([
      estimarPrazo({itens, tipo:'retirada', distanciaKm:0, config, agora}),
      estimarPrazo({itens:pequeno, tipo:'retirada', distanciaKm:0, config, agora, pedidos:[]}),
      estimarPrazo({itens, tipo:'retirada', distanciaKm:0, config, agora, pedidos:filaLeve}),
      estimarPrazo({itens, tipo:'retirada', distanciaKm:0, config, agora, pedidos:filaMedia}),
    ]);

    return res.status(200).json({
      ok:true,
      checkedAt: agora.toISOString(),
      demanda: config.demanda,
      atrasoExtraMinutos: config.atrasoExtraMinutos,
      retiradaAtual,
      retiradaPequena,
      retirada15Leves,
      retirada15Medias,
    });
  }catch(err){
    console.error('[retirada-selftest]', String(err));
    return res.status(500).json({ok:false,error:String(err?.message || err)});
  }
};
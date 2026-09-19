module.exports = async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if(req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido.' });

  const oidc = String(process.env.VERCEL_OIDC_TOKEN || '').trim();
  if(!oidc) return res.status(503).json({ ok:false, step:'oidc', error:'OIDC indisponível' });

  try{
    const response = await fetch(
      'https://api.vercel.com/storage/stores/blob?teamId=team_GObmx1bMb8GYVLduQk8qb93g',
      {
        method:'POST',
        headers:{
          'Authorization': 'Bearer ' + oidc,
          'Content-Type':'application/json'
        },
        body: JSON.stringify({
          name:'ferracini-pedidos',
          region:'iad1',
          access:'private',
          projectId:'prj_KzbF8mN8dUsf6bZV3a8a8wxBTRAg'
        })
      }
    );
    const text = await response.text();
    let data;
    try{ data = JSON.parse(text); }catch{ data = { message:text.slice(0,300) }; }
    const store = data?.store || data;
    return res.status(response.ok ? 200 : response.status).json({
      ok: response.ok,
      status: response.status,
      id: response.ok ? (store?.id || store?.storeId || null) : null,
      access: response.ok ? (store?.access || null) : null,
      region: response.ok ? (store?.region || null) : null,
      error: response.ok ? null : (data?.error?.message || data?.message || data?.error || 'Falha na criação')
    });
  }catch(err){
    return res.status(503).json({ ok:false, step:'request', error:String(err) });
  }
};
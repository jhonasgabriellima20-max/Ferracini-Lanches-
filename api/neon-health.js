module.exports = async function handler(req, res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  try{
    const { getVercelOidcToken } = await import('@vercel/oidc');
    const token = await getVercelOidcToken();
    if(!token) return res.status(503).json({ ok:false, stage:'oidc' });

    const response = await fetch('https://br-shiny-snow-awm66ato-ferracinistore.compute.c-12.us-east-1.aws.neon.tech/',{
      method:'POST',
      headers:{
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      body:JSON.stringify({ op:'read', pathname:'config/disponibilidade.json' })
    });

    const text=await response.text();
    if(!response.ok){
      return res.status(503).json({ ok:false, stage:'neon-function', status:response.status, detail:text.slice(0,120) });
    }
    let data=null;
    try{ data=text?JSON.parse(text):null; }catch{}
    return res.status(200).json({
      ok:true,
      storage:'neon-function',
      auth:'vercel-oidc',
      stateLoaded:Boolean(data && Object.hasOwn(data,'value'))
    });
  }catch(err){
    return res.status(503).json({ ok:false, stage:'exception', error:String(err?.message||err).slice(0,120) });
  }
};
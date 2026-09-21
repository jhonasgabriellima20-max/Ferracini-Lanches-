module.exports = async function handler(req, res){
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
  try{
    const { getVercelOidcToken } = await import('@vercel/oidc');
    const token = await getVercelOidcToken();
    if(!token) return res.status(503).json({ ok:false, stage:'oidc' });

    const url = new URL('https://ep-soft-mud-aczjydzb.apirest.sa-east-1.aws.neon.tech/ferracini/rest/v1/ferracini_store');
    url.searchParams.set('select','pathname');
    url.searchParams.set('limit','1');

    const response = await fetch(url,{
      headers:{ Authorization:`Bearer ${token}`, Accept:'application/json' }
    });
    if(!response.ok){
      const body = await response.text().catch(()=> '');
      return res.status(503).json({ ok:false, stage:'neon', status:response.status, detail:body.slice(0,120) });
    }
    return res.status(200).json({ ok:true, storage:'neon-postgres', auth:'vercel-oidc' });
  }catch(err){
    return res.status(503).json({ ok:false, stage:'exception', error:String(err?.message||err).slice(0,120) });
  }
};
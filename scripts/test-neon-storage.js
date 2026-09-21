(async () => {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if(!token) process.exit(110);
  let payload;
  try{
    payload=JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  }catch{
    process.exit(111);
  }
  const iss=String(payload.iss||'');
  const aud=Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud||'')];

  if(iss==='https://oidc.vercel.com/jho-n' && aud.includes('https://vercel.com/jho-n')) process.exit(112);
  if(iss==='https://oidc.vercel.com' && aud.includes('https://vercel.com/jho-n')) process.exit(113);
  if(iss==='https://oidc.vercel.com/jho-n') process.exit(114);
  if(iss==='https://oidc.vercel.com') process.exit(115);
  if(aud.includes('https://vercel.com/jho-n')) process.exit(116);
  process.exit(117);
})().catch(()=>process.exit(118));

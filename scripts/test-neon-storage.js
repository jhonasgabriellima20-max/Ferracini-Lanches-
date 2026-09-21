(async () => {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if(!token) process.exit(120);

  let header;
  try{
    header=JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  }catch{
    process.exit(121);
  }

  const res=await fetch('https://oidc.vercel.com/jho-n/.well-known/jwks');
  if(!res.ok) process.exit(122);
  const jwks=await res.json();
  const keys=Array.isArray(jwks?.keys)?jwks.keys:[];
  const match=keys.find(k=>String(k.kid||'')===String(header.kid||''));
  if(!match) process.exit(123);

  const alg=String(header.alg||'');
  const kty=String(match.kty||'');
  const crv=String(match.crv||'');

  if(alg==='ES256' && kty==='EC' && crv==='P-256') process.exit(124);
  if(alg==='RS256' && kty==='RSA') process.exit(125);
  if(alg==='EdDSA') process.exit(126);
  process.exit(127);
})().catch(()=>process.exit(128));

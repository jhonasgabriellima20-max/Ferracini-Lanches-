(async () => {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if(!token) process.exit(60);

  let payload;
  try{
    payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  }catch{
    process.exit(61);
  }

  const sub = String(payload.sub || '');
  const aud = String(payload.aud || '');
  const iss = String(payload.iss || '');

  const expected = 'owner:jho-n:project:ferracini-lanches:environment:preview';
  if(sub === expected) process.exit(62);
  if(sub.startsWith('owner:jho-n:project:ferracini-lanches:')) process.exit(63);
  if(sub.includes('project:ferracini-lanches')) process.exit(64);
  if(sub.includes('environment:preview')) process.exit(65);
  if(aud === 'https://vercel.com/jho-n') process.exit(66);
  if(iss === 'https://oidc.vercel.com/jho-n') process.exit(67);
  if(iss === 'https://oidc.vercel.com') process.exit(68);
  process.exit(69);
})().catch(() => process.exit(70));

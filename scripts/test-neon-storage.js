(async () => {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if(!token) throw new Error('OIDC da Vercel indisponível');

  const url = new URL('https://ep-soft-mud-aczjydzb.apirest.sa-east-1.aws.neon.tech/ferracini/rest/v1/ferracini_store');
  url.searchParams.set('select', 'pathname');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  });

  if(!response.ok){
    const body = await response.text();
    throw new Error(`Neon Data API respondeu ${response.status}: ${body.slice(0,180)}`);
  }

  console.log('Neon Data API + Vercel OIDC: OK');
})().catch(err => {
  console.error(err.message || String(err));
  process.exit(1);
});
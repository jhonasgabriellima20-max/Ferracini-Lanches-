(async () => {
  const { getVercelOidcToken } = await import('@vercel/oidc');
  const token = await getVercelOidcToken();
  if(!token) process.exit(93);

  const response = await fetch(
    'https://ep-icy-butterfly-ac1crq9a.apirest.sa-east-1.aws.neon.tech/ferracini/rest/v1/rpc/ferracini_debug_role',
    {
      method:'POST',
      headers:{
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json',
        Accept:'application/json'
      },
      body:'{}'
    }
  );

  if(response.status===401) process.exit(94);
  if(response.status===403) process.exit(95);
  if(!response.ok) process.exit(96);

  const data=await response.json();
  const role=String(data?.current_user || data?.[0]?.current_user || '');
  if(role==='owner:jho-n:project:ferracini-lanches:environment:preview') process.exit(97);
  if(role==='authenticated') process.exit(98);
  if(role==='anonymous') process.exit(99);
  if(role==='authenticator') process.exit(100);
  process.exit(101);
})().catch(()=>process.exit(102));

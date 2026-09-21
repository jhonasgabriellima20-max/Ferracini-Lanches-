const status={environment:process.env.VERCEL_ENV,DATABASE_URL:Boolean(process.env.DATABASE_URL),POSTGRES_URL:Boolean(process.env.POSTGRES_URL),POSTGRES_URL_NON_POOLING:Boolean(process.env.POSTGRES_URL_NON_POOLING)};
console.log('FERRACINI_DATABASE_CONFIG',JSON.stringify(status));
if(process.env.VERCEL_ENV==='preview')require('fs').writeFileSync('database-readiness.json',JSON.stringify(status));

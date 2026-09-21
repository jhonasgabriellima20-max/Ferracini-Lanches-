const crypto = require('crypto');

module.exports = function handler(req, res){
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if(process.env.VERCEL_ENV === 'production'){
    return res.status(404).json({ error: 'Not found' });
  }

  const token = String(process.env.PRINT_AGENT_TOKEN || '');
  const admin = String(process.env.ADMIN_PASSWORD || '');
  const maps = String(process.env.GOOGLE_MAPS_API_KEY || '');

  return res.status(200).json({
    environment: process.env.VERCEL_ENV || 'unknown',
    printAgentTokenConfigured: Boolean(token),
    printAgentTokenFingerprint: token
      ? crypto.createHash('sha256').update(token).digest('hex')
      : null,
    adminConfigured: Boolean(admin),
    mapsConfigured: Boolean(maps),
  });
};
// Shared boundary checks for same-origin browser payment requests.
const buckets = new Map();
function headers(res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Robots-Tag','noindex, nofollow');
}
function sameOrigin(req) {
  if(String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  const origin = String(req.headers.origin || '');
  if(!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host || '');
    const local = ['localhost','127.0.0.1'].includes(parsed.hostname);
    return parsed.host === host && (parsed.protocol === 'https:' || (local && parsed.protocol === 'http:'));
  } catch { return false; }
}
function rateLimit(req, res, scope, limit = 30) {
  const now = Date.now();
  const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0,100);
  const key = scope + ':' + ip;
  if(buckets.size > 2000) for(const [key,value] of buckets) if(value.until <= now) buckets.delete(key);
  if(buckets.size > 3000 && !buckets.has(key)) { res.setHeader('Retry-After','60'); return false; }
  let bucket = buckets.get(key);
  if(!bucket || bucket.until <= now) { bucket = {count:0, until:now + 60000}; buckets.set(key,bucket); }
  bucket.count++;
  if(bucket.count <= limit) return true;
  res.setHeader('Retry-After',String(Math.max(1,Math.ceil((bucket.until-now)/1000))));
  return false;
}
function jsonBody(req, maximum = 12000) {
  if(!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('json_required'),{status:415});
  if(Number(req.headers['content-length'] || 0) > maximum || Buffer.byteLength(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})) > maximum)
    throw Object.assign(new Error('body_too_large'),{status:413});
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch { throw Object.assign(new Error('invalid_json'),{status:400}); }
  if(!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('invalid_json'),{status:400});
  return body;
}
module.exports = {headers, sameOrigin, rateLimit, jsonBody};

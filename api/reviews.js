// Reviews API for the BryanSCL dashboard (Vercel serverless function).
//
//   GET    /api/reviews                    → published reviews (public)
//   POST   /api/reviews                    → submit a review (public)
//   GET    /api/reviews?admin=1            → every review          (needs x-admin-key)
//   PATCH  /api/reviews?id=…  {status}     → publish / hide        (needs x-admin-key)
//   DELETE /api/reviews?id=…               → delete                (needs x-admin-key)
//
// Storage: Upstash Redis over its REST API (no npm packages needed).
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   KV_REST_API_URL + KV_REST_API_TOKEN      (added automatically by the Upstash integration)
//     or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   ADMIN_KEY                                (your admin password — choose a long one)
//   REVIEWS_REQUIRE_APPROVAL=true            (optional: new reviews stay hidden until you publish them)

const crypto = require('crypto');

const KEY = 'dashboard:reviews';
const LIMITS = { name: 60, relation: 40, app: 60, comment: 1000 };
const RATE = { max: 5, windowSec: 3600 };

const RELATIONS = ['Girlfriend', 'Friend', 'Family', 'Others'];

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redis(cmd) {
  const cfg = redisConfig();
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error('Storage error: ' + (data.error || r.status));
  return data.result;
}

function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, max);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  const given = req.headers['x-admin-key'];
  return !!(key && given && safeEqual(given, key));
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

async function allReviews() {
  const flat = (await redis(['HGETALL', KEY])) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { out.push(JSON.parse(flat[i + 1])); } catch (e) { /* skip bad rows */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function publicView(r) {
  return { id: r.id, name: r.name, relation: r.relation, app: r.app, comment: r.comment, createdAt: r.createdAt };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  try {
    if (!redisConfig()) {
      return send(res, 503, { error: 'Reviews are not set up yet. Connect an Upstash Redis store to this Vercel project.' });
    }
    const url = new URL(req.url, 'http://localhost');
    const method = req.method;

    /* ── public: list published ── */
    if (method === 'GET' && !url.searchParams.get('admin')) {
      const list = (await allReviews()).filter((r) => r.status === 'published').slice(0, 100).map(publicView);
      return send(res, 200, { reviews: list });
    }

    /* ── public: submit ── */
    if (method === 'POST') {
      const body = await readBody(req);
      if (body.website) return send(res, 200, { ok: true, status: 'published' }); // honeypot: pretend success
      const review = {
        name: clean(body.name, LIMITS.name),
        relation: clean(body.relation, LIMITS.relation),
        app: clean(body.app, LIMITS.app),
        comment: clean(body.comment, LIMITS.comment)
      };
      const missing = Object.keys(review).filter((k) => !review[k]);
      if (missing.length) return send(res, 400, { error: 'Please fill in: ' + missing.join(', ') + '.' });
      if (review.comment.length < 5) return send(res, 400, { error: 'Your comment is a little short. Add a few more words.' });
      if (RELATIONS.indexOf(review.relation) < 0) review.relation = 'Others';

      const ipHash = crypto.createHash('sha256').update(clientIp(req) + (process.env.ADMIN_KEY || '')).digest('hex').slice(0, 16);
      const rlKey = 'dashboard:rl:' + ipHash;
      const count = await redis(['INCR', rlKey]);
      if (count === 1) await redis(['EXPIRE', rlKey, RATE.windowSec]);
      if (count > RATE.max) return send(res, 429, { error: 'Too many reviews from this connection. Try again in an hour.' });

      const needsApproval = String(process.env.REVIEWS_REQUIRE_APPROVAL || '').toLowerCase() === 'true';
      const record = Object.assign(review, {
        id: crypto.randomBytes(8).toString('hex'),
        status: needsApproval ? 'hidden' : 'published',
        createdAt: Date.now()
      });
      await redis(['HSET', KEY, record.id, JSON.stringify(record)]);
      return send(res, 201, { ok: true, status: record.status, review: publicView(record) });
    }

    /* ── admin ── */
    if (!process.env.ADMIN_KEY) return send(res, 503, { error: 'Admin is not set up. Add an ADMIN_KEY environment variable in Vercel.' });
    if (!isAdmin(req)) return send(res, 401, { error: 'Wrong admin password.' });

    if (method === 'GET') return send(res, 200, { reviews: await allReviews() });

    const id = clean(url.searchParams.get('id'), 32);
    if (!id) return send(res, 400, { error: 'Missing review id.' });
    const raw = await redis(['HGET', KEY, id]);
    if (!raw) return send(res, 404, { error: 'Review not found. It may already be deleted.' });

    if (method === 'PATCH') {
      const body = await readBody(req);
      const status = body.status === 'published' ? 'published' : 'hidden';
      const rec = JSON.parse(raw);
      rec.status = status;
      await redis(['HSET', KEY, id, JSON.stringify(rec)]);
      return send(res, 200, { ok: true, review: rec });
    }
    if (method === 'DELETE') {
      await redis(['HDEL', KEY, id]);
      return send(res, 200, { ok: true });
    }
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return send(res, 405, { error: 'Method not allowed.' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'Something went wrong saving reviews. Try again shortly.' });
  }
};

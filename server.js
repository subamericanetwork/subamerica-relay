/**
 * Relay 2.1 for Subamerica
 * Adds: POST /resolve/stream  -> { m3u8 } => { appId, streamKey, streamId?, raw? }
 *
 * Existing endpoints:
 *  - POST /nowplaying { artist_id, artist_name }
 *  - GET  /offer/active
 *  - GET  /b/:token   (shortlink -> add-to-cart -> /checkout)
 *  - GET  /qr/:token.png
 *  - GET  /health
 *
 * Integrations:
 *  - WooCommerce REST (read-only): fetch product by SKU from wc/v3/products
 *  - SKU map: artist_id -> sku
 *  - Livepush: optional; /resolve/stream looks up stream by streamKey if LIVEPUSH_API_TOKEN provided
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: '*' }));

// Memory stores
let nowPlaying = { artist_id: null, artist_name: null, ts: 0 };
let tokenStore = new Map(); // token -> { product_id, artist_id, createdAt }

// Config (env)
const PORT = parseInt(process.env.PORT || '8080', 10);
const SHOP_BASE = process.env.SHOP_BASE || 'https://subamerica.net/shop';
const WC_API_URL = process.env.WC_API_URL || 'https://subamerica.net/wp-json/wc/v3';
const WC_KEY = process.env.WC_KEY || '';
const WC_SECRET = process.env.WC_SECRET || '';
const LIVEPUSH_API_TOKEN = process.env.LIVEPUSH_API_TOKEN || '';
const LIVEPUSH_API_BASE = process.env.LIVEPUSH_API_BASE || 'https://dev.livepush.io/api/v1';

const SHORT_TTL_MS = (parseInt(process.env.SHORT_TOKEN_TTL_SEC || '1800', 10) || 1800) * 1000;
const OFFER_TTL_SEC = parseInt(process.env.OFFER_TTL_SEC || '25', 10) || 25;
const CURRENCY = process.env.CURRENCY || 'USD';

// SKU map (load from file)
let skuMap = {};
try { skuMap = require('./sku_map.json'); } catch(e) { skuMap = {}; }

function fmtUSD(amount) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: CURRENCY }).format(amount);
  } catch(e) {
    const n = parseFloat(amount) || 0;
    return `$${n.toFixed(2)}`;
  }
}

function pruneTokens() {
  const now = Date.now();
  for (const [tok, obj] of tokenStore.entries()) {
    if (now - obj.createdAt > SHORT_TTL_MS) tokenStore.delete(tok);
  }
}
setInterval(pruneTokens, 60 * 1000);

// --------------- One-shot Stream Resolver ---------------
/**
 * Body: { m3u8: "https://.../live_cdn/<appId>/<streamKey[-?]>/index.m3u8" }
 * Returns: { appId, streamKey, streamId?, raw? }
 * - If LIVEPUSH_API_TOKEN is provided, we call GET {LIVEPUSH_API_BASE}/streams and match by streamKey
 * - Some HLS paths include a trailing '-' on the stream key; we strip dashed suffixes when matching.
 */
app.post('/resolve/stream', async (req, res) => {
  const m3u8 = (req.body && req.body.m3u8) ? String(req.body.m3u8) : '';
  if (!m3u8) return res.status(400).json({ error: 'm3u8 required' });

  const out = { appId: null, streamKey: null, streamId: null, raw: {} };

  try {
    const u = new URL(m3u8);
    // Expect path like: /live_cdn/<appId>/<streamKey>/index.m3u8
    const parts = u.pathname.split('/').filter(Boolean);
    // find the segment 'live_cdn' and take next two parts
    const idx = parts.indexOf('live_cdn');
    if (idx >= 0 && parts.length >= idx + 3) {
      out.appId = parts[idx + 1];
      let key = parts[idx + 2];
      // strip trailing dash(es) some CDNs append
      key = key.replace(/-+$/,'');
      out.streamKey = key;
    }
  } catch(e) {
    return res.status(400).json({ error: 'invalid m3u8 url' });
  }

  if (!out.appId || !out.streamKey) {
    return res.status(422).json({ error: 'could not parse appId/streamKey from m3u8', parsed: out });
  }

  // Optionally resolve streamId from Livepush
  if (LIVEPUSH_API_TOKEN) {
    try {
      const r = await fetch(`${LIVEPUSH_API_BASE}/streams`, {
        headers: { 'Authorization': `Bearer ${LIVEPUSH_API_TOKEN}` }
      });
      const arr = await r.json();
      out.raw.streamsCount = Array.isArray(arr) ? arr.length : 0;
      if (Array.isArray(arr)) {
        const found = arr.find(s => {
          const k = (s.streamKey || '').replace(/-+$/,'');
          return k === out.streamKey;
        });
        if (found) {
          out.streamId = found.id || null;
          out.raw.match = found;
        }
      }
    } catch(e) {
      out.raw.error = 'livepush_lookup_failed';
    }
  }

  return res.json(out);
});

// ---------------- Existing API ----------------

app.post('/nowplaying', (req, res) => {
  const body = req.body || {};
  if (!body.artist_id) return res.status(400).json({ error: 'artist_id required' });
  nowPlaying = { artist_id: body.artist_id, artist_name: body.artist_name || body.artist_id, ts: Date.now() };
  return res.json({ ok: true, nowPlaying });
});

app.get('/offer/active', async (req, res) => {
  const artistId = nowPlaying.artist_id;
  if (!artistId) {
    return res.json({ overlay: { visible: false, ttlSec: OFFER_TTL_SEC } });
  }

  const sku = skuMap[artistId];
  if (!sku) {
    return res.json({ overlay: { visible: false, ttlSec: OFFER_TTL_SEC } });
  }

  // WooCommerce: fetch by SKU
  const url = new URL(WC_API_URL + '/products');
  url.searchParams.set('sku', sku);
  url.searchParams.set('status', 'publish');
  const auth = Buffer.from(WC_KEY + ':' + WC_SECRET).toString('base64');
  let prod;
  try {
    const r = await fetch(url.toString(), { headers: { 'Authorization': 'Basic ' + auth } });
    const arr = await r.json();
    if (Array.isArray(arr) && arr.length > 0) {
      prod = arr[0];
    }
  } catch (e) {
    return res.json({ overlay: { visible: false, ttlSec: OFFER_TTL_SEC } });
  }
  if (!prod || !prod.id || prod.type === 'variable' || prod.stock_status !== 'instock') {
    return res.json({ overlay: { visible: false, ttlSec: OFFER_TTL_SEC } });
  }

  // Short token
  const token = crypto.randomBytes(5).toString('hex');
  tokenStore.set(token, { product_id: prod.id, artist_id: artistId, createdAt: Date.now() });

  // Build response
  const image = (prod.images && prod.images[0] && prod.images[0].src) ? prod.images[0].src : null;
  const amount = parseFloat(prod.price || prod.regular_price || '0') || 0;
  const formatted = fmtUSD(amount);
  const buyUrl = `${SHOP_BASE}/?add-to-cart=${prod.id}&quantity=1`;

  return res.json({
    overlay: { visible: true, ttlSec: OFFER_TTL_SEC },
    artist: { id: artistId, name: nowPlaying.artist_name || artistId },
    product: {
      id: prod.id,
      sku: prod.sku,
      name: prod.name,
      description: (prod.short_description || '').replace(/<[^>]*>/g, '').slice(0, 160),
      price: { amount, currency: CURRENCY, formatted },
      image,
      buyUrl,
      shortUrl: `${req.protocol}://${req.get('host')}/b/${token}`,
      qrPng:    `${req.protocol}://${req.get('host')}/qr/${token}.png`
    }
  });
});

app.get('/b/:token', (req, res) => {
  const rec = tokenStore.get(req.params.token);
  if (!rec) return res.status(404).send('Expired');
  const final = `${SHOP_BASE}/?add-to-cart=${rec.product_id}&quantity=1`;
  const checkout = `${SHOP_BASE}/checkout`;
  res.set('Content-Type', 'text/html');
  return res.send(`<!doctype html><meta http-equiv="refresh" content="0;url=${final}"><script>setTimeout(function(){location.replace('${checkout}')},500)</script>`);
});

app.get('/qr/:token.png', async (req, res) => {
  const rec = tokenStore.get(req.params.token);
  if (!rec) return res.status(404).send('Expired');
  const shortUrl = `${req.protocol}://${req.get('host')}/b/${req.params.token}`;
  try {
    const png = await QRCode.toBuffer(shortUrl, { type: 'png', margin: 1, width: 300 });
    res.set('Content-Type', 'image/png');
    return res.send(png);
  } catch (e) {
    return res.status(500).send('QR error');
  }
});

app.get('/health', (req,res)=> res.json({ ok:true, ts: new Date().toISOString() }));

app.listen(PORT, ()=> console.log('Relay 2.1 listening on :' + PORT));

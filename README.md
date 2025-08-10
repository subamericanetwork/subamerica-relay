# Subamerica Relay 2.1

Adds **POST /resolve/stream** to extract `appId` and `streamKey` from an HLS URL and (optionally) resolve the Livepush `streamId`.

## New Endpoint
```
POST /resolve/stream
{ "m3u8": "https://hls-.../live_cdn/<appId>/<streamKey>/index.m3u8" }

Response:
{
  "appId": "...",
  "streamKey": "...",
  "streamId": "..." | null,
  "raw": { "streamsCount": 12, "match": { ... } }   // present if LIVEPUSH_API_TOKEN set
}
```
Set env to enable Livepush lookup:
```
LIVEPUSH_API_TOKEN=your_token
LIVEPUSH_API_BASE=https://dev.livepush.io/api/v1
```

## Existing Endpoints
- POST /nowplaying  { artist_id, artist_name }
- GET  /offer/active
- GET  /b/:token     (shortlink -> add-to-cart -> /checkout)
- GET  /qr/:token.png
- GET  /health

## Config (.env or environment)
```
PORT=8080
SHOP_BASE=https://subamerica.net/shop
WC_API_URL=https://subamerica.net/wp-json/wc/v3
WC_KEY=your_consumer_key
WC_SECRET=your_consumer_secret
SHORT_TOKEN_TTL_SEC=1800
OFFER_TTL_SEC=25
CURRENCY=USD
LIVEPUSH_API_TOKEN=
LIVEPUSH_API_BASE=https://dev.livepush.io/api/v1
```

## SKU map
Edit `sku_map.json`:
```
{ "colleenanthony": "0002" }
```

// Porkbun API Proxy Server
// Cloudflare Workers の IP は Porkbun WAF にブロックされるため、
// このサーバーを経由して Porkbun API を呼び出す。
import { createServer } from 'http';

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PROXY_SECRET || '';

const PORKBUN_BASE = 'https://api.porkbun.com/api/json/v3';

const server = createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Secret',
    });
    res.end();
    return;
  }

  // POST のみ許可
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  // シークレット認証
  if (SECRET && req.headers['x-proxy-secret'] !== SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  // URL: /porkbun/domain/create → https://api.porkbun.com/api/json/v3/domain/create
  const path = req.url.replace(/^\/porkbun/, '') || '/ping';
  const targetUrl = `${PORKBUN_BASE}${path}`;

  // リクエストボディを読み込む
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    const porkbunRes = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body || '{}',
    });
    const text = await porkbunRes.text();
    res.writeHead(porkbunRes.status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy fetch error: ${e.message}` }));
  }
});

server.listen(PORT, () => {
  console.log(`Porkbun proxy listening on port ${PORT}`);
});

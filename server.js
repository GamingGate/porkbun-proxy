// Domain Registrar API Proxy Server
// Cloudflare Workers の IP はレジストラ WAF にブロックされるため、
// このサーバーを経由して各レジストラ API を呼び出す。
import { createServer } from 'http';

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PROXY_SECRET || '';

const PORKBUN_BASE   = 'https://api.porkbun.com/api/json/v3';
const NAMECHEAP_BASE = 'https://api.namecheap.com/xml.response';
const NAMESILO_BASE  = 'https://www.namesilo.com/api';
const DNA_BASE       = 'https://rest-api.domainnameapi.com';

const server = createServer(async (req, res) => {
  // GET /myip → このサーバーの外部IPを返す（Namecheapホワイトリスト登録用 + ウォームアップ確認用）
  if (req.method === 'GET' && req.url === '/myip') {
    try {
      const ipRes = await fetch('https://checkip.amazonaws.com/');
      const ip = (await ipRes.text()).trim();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',  // ブラウザからの直接アクセス（ウォームアップ）を許可
      });
      res.end(JSON.stringify({ ip }));
    } catch (e) {
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Secret',
    });
    res.end();
    return;
  }

  // POST のみ許可（/myip 以外）
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

  // リクエストボディを読み込む
  let body = '';
  for await (const chunk of req) body += chunk;

  try {
    let targetUrl, fetchOptions;

    if (req.url.startsWith('/porkbun')) {
      // Porkbun: /porkbun/domain/create → https://api.porkbun.com/api/json/v3/domain/create
      const path = req.url.replace(/^\/porkbun/, '') || '/ping';
      targetUrl = `${PORKBUN_BASE}${path}`;
      fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body || '{}',
      };
    } else if (req.url.startsWith('/namecheap')) {
      // Namecheap: /namecheap → https://api.namecheap.com/xml.response
      // body はクエリ文字列形式で渡す（application/x-www-form-urlencoded）
      targetUrl = NAMECHEAP_BASE;
      fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body || '',
      };
    } else if (req.url.startsWith('/namesilo')) {
      // NameSilo: GET ベース API
      // /namesilo/getPrices → https://www.namesilo.com/api/getPrices
      // body はクエリ文字列（key=xxx&version=1&type=json&...）
      const path = req.url.replace(/^\/namesilo/, '') || '/getPrices';
      const qs = body ? `?${body}` : '';
      targetUrl = `${NAMESILO_BASE}${path}${qs}`;
      fetchOptions = {
        method: 'GET',
        headers: { 'Accept': 'application/json', 'User-Agent': 'MassSite/1.0' },
      };
    } else if (req.url.startsWith('/dna')) {
      // Domain Name API (DNA): REST API
      // GET エンドポイント: /tld/list（認証はクエリパラメータ）
      // POST エンドポイント: /domain/register, /domain/modifynameserver（認証はJSONボディ）
      const GET_ENDPOINTS = ['/tld/list'];
      const path = req.url.replace(/^\/dna/, '') || '/tld/list';
      const isGetEndpoint = GET_ENDPOINTS.some(ep => path === ep || path.startsWith(ep + '?'));

      if (isGetEndpoint) {
        // BodyのJSONをクエリパラメータ＋Basic Authヘッダーに変換してGETで転送
        let params = {};
        try { params = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const qs = new URLSearchParams(params).toString();
        targetUrl = `${DNA_BASE}${path}${qs ? '?' + qs : ''}`;
        // Basic Auth ヘッダーも付与（UserName:Password を base64 エンコード）
        const dnaUser = params['UserName'] || params['username'] || '';
        const dnaPass = params['Password'] || params['password'] || '';
        const basicAuth = dnaUser ? 'Basic ' + Buffer.from(`${dnaUser}:${dnaPass}`).toString('base64') : '';
        fetchOptions = {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            ...(basicAuth ? { 'Authorization': basicAuth } : {}),
          },
        };
      } else {
        // POST エンドポイント: JSONボディをそのまま転送（Basic Authも付与）
        let params = {};
        try { params = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const dnaUser = params['UserName'] || params['username'] || '';
        const dnaPass = params['Password'] || params['password'] || '';
        const basicAuth = dnaUser ? 'Basic ' + Buffer.from(`${dnaUser}:${dnaPass}`).toString('base64') : '';
        targetUrl = `${DNA_BASE}${path}`;
        fetchOptions = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...(basicAuth ? { 'Authorization': basicAuth } : {}),
          },
          body: body || '{}',
        };
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unknown proxy route' }));
      return;
    }

    const upstreamRes = await fetch(targetUrl, fetchOptions);
    const text = await upstreamRes.text();
    const contentType = upstreamRes.headers.get('content-type') || 'application/json';
    res.writeHead(upstreamRes.status, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(text);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Proxy fetch error: ${e.message}` }));
  }
});

server.listen(PORT, () => {
  console.log(`Registrar proxy listening on port ${PORT}`);
});

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function ddgImageSearch(query) {
  const pageUrl = 'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iar=images&iax=images&ia=images';
  const pageResp = await fetch(pageUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8' },
    redirect: 'follow'
  });
  const pageHtml = await pageResp.text();
  const vqdMatch = pageHtml.match(/vqd[=:]["']?([0-9a-zA-Z_-]+)/i);
  if (!vqdMatch) throw new Error('No VQD token');
  const vqd = vqdMatch[1];

  const apiUrl = 'https://duckduckgo.com/i.js?l=us-en&o=json&q=' + encodeURIComponent(query) + '&vqd=' + vqd;
  const apiResp = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': pageUrl }
  });
  if (!apiResp.ok) throw new Error('DDG i.js ' + apiResp.status);
  const apiData = await apiResp.json();
  if (!apiData.results || apiData.results.length === 0) return null;
  for (const r of apiData.results) {
    if ((r.width || 0) >= 100 && (r.height || 0) >= 100) return r.image;
  }
  return apiData.results[0].image;
}

async function wikiImageSearch(query) {
  const results = [];
  const searchUrl = 'https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=' +
    encodeURIComponent(query) + '&srnamespace=6&format=json&srlimit=3';
  const resp = await fetch(searchUrl, {
    headers: { 'User-Agent': 'StockFerre/1.0 (app de inventario; contacto@email.com)', 'Api-User-Agent': 'StockFerre/1.0' }
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('Wiki parse error'); }
  if (!data.query || !data.query.search) return results;

  for (const item of data.query.search) {
    const title = item.title;
    if (!title.match(/\.(jpg|jpeg|png|webp|gif)/i)) continue;
    try {
      const imgUrl = 'https://commons.wikimedia.org/w/api.php?action=query&titles=' +
        encodeURIComponent(title) + '&prop=imageinfo&iiprop=url&iiurlwidth=400&format=json';
      const imgResp = await fetch(imgUrl, {
        headers: { 'User-Agent': 'StockFerre/1.0 (app de inventario; contacto@email.com)', 'Api-User-Agent': 'StockFerre/1.0' }
      });
      const imgText = await imgResp.text();
      let imgData;
      try { imgData = JSON.parse(imgText); } catch(e) { continue; }
      const pages = imgData.query && imgData.query.pages;
      if (pages) {
        const pageId = Object.keys(pages)[0];
        if (pages[pageId] && pages[pageId].imageinfo && pages[pageId].imageinfo[0]) {
          results.push(pages[pageId].imageinfo[0].url);
        }
      }
    } catch(e) { continue; }
    if (results.length >= 2) break;
  }
  return results;
}

async function searchImages(query) {
  const results = [];

  // 1. DuckDuckGo image search
  try {
    const img = await ddgImageSearch(query);
    if (img) results.push({ image: img, source: 'duckduckgo' });
  } catch (e) {
    console.log('DDG error:', e.message);
  }

  // 2. DuckDuckGo Instant Answer
  try {
    const resp = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json',
      { headers: { 'User-Agent': UA } });
    const data = await resp.json();
    if (data.Image && /^https?:\/\//i.test(data.Image) && !results.some(r => r.image === data.Image)) {
      results.push({ image: data.Image, source: 'ddg-instant' });
    }
  } catch (e) {
    console.log('DDG instant error:', e.message);
  }

  // 3. Wikipedia (solo si no hay resultados todavu00eda)
  if (results.length === 0) {
    try {
      const wikiResults = await wikiImageSearch(query);
      for (const img of wikiResults) {
        if (!results.some(r => r.image === img)) results.push({ image: img, source: 'wikipedia' });
      }
    } catch (e) {
      console.log('Wiki error:', e.message);
    }
  }

  return results;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost:' + PORT);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (reqUrl.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (reqUrl.pathname === '/api/search-images') {
    const q = reqUrl.searchParams.get('q') || '';
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing q parameter' }));
      return;
    }
    try {
      const results = await searchImages(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, results: [] }));
    }
    return;
  }

  if (reqUrl.pathname === '/api/proxy') {
    const target = reqUrl.searchParams.get('url') || '';
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    try {
      const proxyResp = await fetch(target, { headers: { 'User-Agent': UA }, redirect: 'follow' });
      const contentType = proxyResp.headers.get('content-type') || 'text/plain';
      const body = await proxyResp.arrayBuffer();
      res.writeHead(proxyResp.status, { 'Content-Type': contentType });
      res.end(Buffer.from(body));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Archivos estaticos
  let filePath = path.join(ROOT, reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname);
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('===========================================');
  console.log('  StockFerre servidor local activo');
  console.log('  http://localhost:' + PORT);
  console.log('  Presiona Ctrl+C para cerrar');
  console.log('===========================================');
});

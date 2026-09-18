const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function decodeEntities(s) {
  const el = String(s || '').replace(/[\r\n\t]+/g, ' ').trim();
  return el
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, ' ').trim();
}

// Descarga una página (viaja con el User-Agent de navegador, sigue redirecciones)
// y extrae los metadatos del producto: <title>, og:title, og:image (+dimensiones)
// y las imágenes declaradas en los datos estructurados JSON-LD.
async function fetchPageInfo(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  if (resp.status !== 200 && resp.status !== 404) throw new Error('Page HTTP ' + resp.status);
  const html = await resp.text();
  const finalUrl = resp.url;

  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  let ogTitle = '';
  let ogImage = '';
  let ogWidth = 0;
  let ogHeight = 0;
  const metaProps = {};
  const metaRe = /<meta[^>]+(?:property|name|itemprop)=["']([^"']+)["'][^>]*>/gi;
  let mm;
  while ((mm = metaRe.exec(html)) !== null) {
    const k = (mm[1] || '').toLowerCase();
    const contentMatch = mm[0].match(/content=["']([^"']*)["']/i);
    if (contentMatch) metaProps[k] = contentMatch[1];
  }
  ogTitle = decodeEntities(metaProps['og:title']);
  ogImage = decodeEntities(metaProps['og:image']);
  ogWidth = parseInt(metaProps['og:image:width'], 10) || 0;
  ogHeight = parseInt(metaProps['og:image:height'], 10) || 0;
  if (!ogImage) ogImage = decodeEntities(metaProps['image']);

  const images = [];
  if (ogImage) images.push(ogImage);

  let jldSku = '', jldMpn = '', jldModel = '', jldBrand = '', jldName = '';

  // 2. JSON-LD Product: nombre + imagen del producto (respaldo de og:*).
  function collectJld(node, arr) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
    const isProduct = types.some(t => String(t) === 'Product');
    const add = v => { if (typeof v === 'string' && /^https?:\/\//i.test(v) && arr.indexOf(v) === -1) arr.push(v); };
    if (isProduct) {
      if (node.name && !ogTitle) ogTitle = String(node.name);
      if (node.name) jldName = String(node.name);
      if (node.sku) jldSku = String(node.sku);
      if (node.mpn) jldMpn = String(node.mpn);
      if (node.model) jldModel = typeof node.model === 'string' ? node.model : (node.model && node.model.name || '');
      if (node.brand) jldBrand = typeof node.brand === 'string' ? node.brand : (node.brand && node.brand.name || '');
      add(node.image);
      if (Array.isArray(node.image)) node.image.forEach(add);
      if (node.offers) {
        const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
        offers.forEach(o => { if (o && o.sku && !jldSku) jldSku = String(o.sku); });
      }
    }
    if (node.image && node.image.url) add(node.image.url);
    add(node.thumbnailUrl);
    add(node.contentUrl);
    if (isProduct) add(node.url);
  }
  const jldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jm;
  while ((jm = jldRe.exec(html)) !== null) {
    try {
      const raw = jm[1];
      const data = JSON.parse(raw);
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        if (item['@graph'] && Array.isArray(item['@graph'])) {
          item['@graph'].forEach(g => collectJld(g, images));
        } else {
          collectJld(item, images);
        }
      }
    } catch (e) { /* JSON-LD inválido: ignorar */ }
  }

  const seen = {};
  const finalImages = images.filter(i => {
    if (seen[i]) return false;
    seen[i] = 1;
    return true;
  }).map(i => new URL(i, finalUrl).toString());

  // NOTA: NO se usa "código en el <head>" como evidencia (ver app.js): en
  // sitios como Truper el <head> incluye listas de varios productos con todos
  // sus códigos, lo que confirmaba páginas de productos DISTINTOS al buscado.

  const sku = jldSku || jldMpn || jldModel;

  return {
    url: finalUrl,
    status: resp.status,
    title,
    ogTitle,
    ogImage: finalImages.length ? finalImages[0] : '',
    images: finalImages,
    ogWidth,
    ogHeight,
    sku,
    mpn: jldMpn,
    modelo: jldModel,
    marcaJld: jldBrand,
    nombreJld: jldName,
    descripcion: decodeEntities(metaProps['description'] || metaProps['og:description'])
  };
}

async function ddgImageSearch(query) {
  const pageUrl = 'https://duckduckgo.com/?q=' + encodeURIComponent(query) + '&iar=images&iax=images&ia=images';
  const pageResp = await fetch(pageUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000)
  });
  const pageHtml = await pageResp.text();
  const vqdMatch = pageHtml.match(/vqd[=:]["']?([0-9a-zA-Z_-]+)/i);
  if (!vqdMatch) throw new Error('No VQD token');
  const vqd = vqdMatch[1];

  const apiUrl = 'https://duckduckgo.com/i.js?l=us-en&o=json&q=' + encodeURIComponent(query) + '&vqd=' + vqd;
  const apiResp = await fetch(apiUrl, {
    headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': pageUrl },
    signal: AbortSignal.timeout(8000)
  });
  if (!apiResp.ok) throw new Error('DDG i.js ' + apiResp.status);
  const apiData = await apiResp.json();
  if (!apiData.results || apiData.results.length === 0) return null;
  for (const r of apiData.results) {
    if ((r.width || 0) >= 100 && (r.height || 0) >= 100) return r.image;
  }
  return apiData.results[0].image;
}

// Búsqueda de imágenes en Bing. Basta leer el HTML de la página de imágenes:
// cada resultado trae un bloque JSON m= con la URL de la foto (murl) y la
// URL de la página del producto (purl), que nos sirve para validar que la
// imagen corresponde de verdad al producto buscado.
async function bingImageSearch(query) {
  const searchUrl = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) +
    '&qft=%2Bfilterui%3aphoto-photo&form=HDRSC2';
  const resp = await fetch(searchUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) throw new Error('Bing ' + resp.status);
  const html = await resp.text();
  const items = [];
  const vistos = new Set();
  const re = /m\s*=\s*"((?:[^"]|&quot;)*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const blob = m[1];
    const imageMatch = blob.match(/murl&quot;:&quot;(https?:\/\/[^"&]+)/i);
    if (!imageMatch) continue;
    const image = imageMatch[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    if (!/\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(image)) continue;
    if (vistos.has(image)) continue;
    vistos.add(image);
    const pageMatch = blob.match(/purl&quot;:&quot;(https?:\/\/[^"&]+)/i);
    items.push({
      image: image,
      page: (pageMatch ? pageMatch[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&') : ''),
      title: ''
    });
    if (items.length >= 8) break;
  }
  return items;
}

// Búsqueda de imágenes en Yandex Images: indexa fotos de tiendas y
// marketplaces. Acepta el título que acompaña a cada imagen para validar si
// corresponde al producto buscado.
async function yandexImageSearch(query) {
  const url = 'https://yandex.com/images/search?text=' + encodeURIComponent(query) + '&isize=medium';
  const resp = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000)
  });
  if (!resp.ok) throw new Error('Yandex ' + resp.status);
  const html = await resp.text();
  const items = [];
  const vistos = new Set();
  const re = /&quot;url&quot;:&quot;(https?:\/\/[^&]+)&quot;.{0,600}?&quot;title&quot;:&quot;([^&]{0,140})/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const image = m[1].replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(image)) continue;
    if (vistos.has(image)) continue;
    vistos.add(image);
    items.push({
      image: image,
      page: '',
      title: m[2].replace(/\\u0026/g, '&')
    });
    if (items.length >= 8) break;
  }
  return items;
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
  const sources = { bing: 'ok', yandex: 'ok', duckduckgo: 'skip', wikipedia: 'skip' };

  const push = (image, source, page, title) => {
    if (!image) return;
    if (results.some(r => r.image === image)) return;
    results.push({ image, source, page: page || '', title: title || '' });
  };

  // 0. Bing y Yandex EN PARALELO (ninguno debe esperar al otro). Bing trae la
  //     página del producto (muy útil para validar); Yandex aporta marketplaces.
  const [bingRes, yandexRes] = await Promise.allSettled([
    bingImageSearch(query),
    yandexImageSearch(query)
  ]);
  if (bingRes.status === 'fulfilled') {
    for (const it of bingRes.value) push(it.image, 'bing', it.page, it.title);
    sources.bing = 'ok (' + bingRes.value.length + ')';
  } else {
    const msg = (bingRes.reason && bingRes.reason.message) || 'error';
    console.log('Bing error:', msg);
    sources.bing = 'error: ' + msg;
  }
  if (yandexRes.status === 'fulfilled') {
    for (const it of yandexRes.value) push(it.image, 'yandex', it.page, it.title);
    sources.yandex = 'ok (' + yandexRes.value.length + ')';
  } else {
    const msg = (yandexRes.reason && yandexRes.reason.message) || 'error';
    console.log('Yandex error:', msg);
    sources.yandex = 'error: ' + msg;
  }

  // 1. DuckDuckGo image search (solo útil como último recurso).
  try {
    const img = await ddgImageSearch(query);
    push(img, 'duckduckgo', '', '');
    sources.duckduckgo = img ? 'ok (1)' : 'sin resultado';
  } catch (e) {
    console.log('DDG error:', e.message);
    sources.duckduckgo = 'error: ' + e.message;
  }

  // 2. DuckDuckGo Instant Answer
  try {
    const resp = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json',
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
    const data = await resp.json();
    if (data.Image && /^https?:\/\//i.test(data.Image)) {
      push(data.Image, 'ddg-instant', '', '');
    }
  } catch (e) {
    console.log('DDG instant error:', e.message);
  }

  // 3. Wikipedia (solo si no hay resultados todav\u00eda)
  if (results.length === 0) {
    try {
      const wikiResults = await wikiImageSearch(query);
      for (const img of wikiResults) push(img, 'wikipedia', '', '');
    } catch (e) {
      console.log('Wiki error:', e.message);
    }
  }

  return { results, sources };
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://localhost:' + PORT);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (reqUrl.pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: 2 }));
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
      const out = await searchImages(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: out.results || [], sources: out.sources || {} }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, results: [], sources: {} }));
    }
    return;
  }

  if (reqUrl.pathname === '/api/product-page') {
    const target = reqUrl.searchParams.get('url') || '';
    if (!target || !/^https?:\/\//i.test(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid url' }));
      return;
    }
    try {
      const info = await fetchPageInfo(target);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(info));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache' });
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

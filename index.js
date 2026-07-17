'use strict';
/**
 * Presenton white-label gateway.
 * Reverse-proxies the self-hosted Presenton app and makes it:
 *   1. AUTH-FREE — injects HTTP Basic auth on every upstream request, so the
 *      "SECURE INSTANCE / create admin login" gate never shows.
 *   2. BRAND-FREE — injects CSS + a MutationObserver that hides the Presenton
 *      logo/wordmark and rewrites the "Presenton" name to a neutral label.
 *   3. EMBEDDABLE — strips CSP / X-Frame-Options so it iframes cleanly.
 * Zero dependencies (Node built-ins only). Serves Presenton at the gateway root
 * so the app's absolute /_next/... asset paths resolve correctly.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const UPSTREAM = process.env.UPSTREAM_HOST || 'presenton-production.up.railway.app';
const USER = process.env.PRESENTON_USER || 'fr';
const PASS = process.env.PRESENTON_PASS || 'FrPresenton2026Aa';
const AUTH = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const BRAND = process.env.BRAND_NAME || 'Slides';
const PORT = process.env.PORT || 3000;

const INJECT = `
<style id="fr-debrand">
  a[href*="presenton.ai"], a[href*="github.com/presenton"],
  img[src*="logo" i], img[alt*="presenton" i], [aria-label*="presenton" i]{display:none !important;}
</style>
<script id="fr-debrand-js">
(function(){
  var RE=/presenton/ig;
  function scrub(){
    try{
      if(document.title && /presenton/i.test(document.title)) document.title=${JSON.stringify(BRAND)};
      document.querySelectorAll('img,svg').forEach(function(el){
        var s=(el.getAttribute('alt')||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('src')||'');
        if(/presenton/i.test(s)) el.style.display='none';
      });
      var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false),n;
      while((n=w.nextNode())){ if(RE.test(n.nodeValue)){ n.nodeValue=n.nodeValue.replace(RE,${JSON.stringify(BRAND)}); } }
    }catch(e){}
  }
  var mo=new MutationObserver(function(){scrub();});
  function boot(){ scrub(); if(document.body) mo.observe(document.body,{subtree:true,childList:true,characterData:true}); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot); else boot();
})();
</script>`;

function proxyHeaders(src) {
  const h = Object.assign({}, src);
  h.host = UPSTREAM;
  h.authorization = AUTH;
  h['accept-encoding'] = 'identity'; // so we can read/patch HTML
  return h;
}

const server = http.createServer((req, res) => {
  const opts = { hostname: UPSTREAM, port: 443, path: req.url, method: req.method, headers: proxyHeaders(req.headers) };
  const up = https.request(opts, (ur) => {
    const ct = String(ur.headers['content-type'] || '');
    const isHtml = ct.includes('text/html');
    const headers = Object.assign({}, ur.headers);
    delete headers['content-security-policy'];
    delete headers['content-security-policy-report-only'];
    delete headers['x-frame-options'];
    // rewrite any absolute redirects back onto the gateway host
    if (headers.location) headers.location = String(headers.location).split('https://' + UPSTREAM).join('');
    if (isHtml) {
      delete headers['content-length'];
      let chunks = [];
      ur.on('data', (c) => chunks.push(c));
      ur.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        if (body.includes('</head>')) body = body.replace('</head>', INJECT + '</head>');
        else if (body.includes('</body>')) body = body.replace('</body>', INJECT + '</body>');
        else body += INJECT;
        res.writeHead(ur.statusCode, headers);
        res.end(body);
      });
    } else {
      res.writeHead(ur.statusCode, headers);
      ur.pipe(res);
    }
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('gateway upstream error'); });
  req.pipe(up);
});

// WebSocket / upgrade passthrough (auth injected) over TLS to upstream.
server.on('upgrade', (req, socket) => {
  const headers = proxyHeaders(req.headers);
  delete headers['accept-encoding'];
  const upstream = tls.connect(443, UPSTREAM, { servername: UPSTREAM }, () => {
    let head = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
    for (const k of Object.keys(headers)) head += k + ': ' + headers[k] + '\r\n';
    head += '\r\n';
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => console.log('presenton gateway listening on ' + PORT + ' -> ' + UPSTREAM));

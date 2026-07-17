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

// Ycode look-and-feel injected RESILIENTLY: Next.js App Router wipes inline
// <head> tags on hydration, so instead of a static <style> we inject a script
// that (re)creates a <style> + Inter <link> via a MutationObserver — surviving
// hydration. Presenton uses the same shadcn tokens as Ycode (hsl(var(--token)))
// so overriding the tokens with Ycode's DARK values (HSL) + Inter = coherence.
const CSS_TEXT = [
  ":root,.dark,html{",
  "--background:0 0% 10.5%;--foreground:0 0% 98%;",
  "--card:0 0% 12.5%;--card-foreground:0 0% 98%;",
  "--popover:0 0% 15%;--popover-foreground:0 0% 96%;",
  "--primary:217 91% 60%;--primary-foreground:0 0% 100%;",
  "--secondary:0 0% 17%;--secondary-foreground:0 0% 98%;",
  "--muted:0 0% 17%;--muted-foreground:0 0% 63%;",
  "--accent:0 0% 19%;--accent-foreground:0 0% 98%;",
  "--destructive:0 72% 51%;--destructive-foreground:0 0% 98%;",
  "--border:0 0% 20%;--input:0 0% 20%;--ring:217 91% 60%;--radius:0.625rem;",
  "--font-syne:'Inter';--font-unbounded:'Inter';--font-inter:'Inter';color-scheme:dark;}",
  "html{background:hsl(0 0% 10.5%) !important;}",
  "body,button,input,textarea,select,h1,h2,h3,h4,h5,h6,p,span,div,a,label{",
  "font-family:'Inter',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif !important;}",
  // --- dark-theme fixes for Presenton's hardcoded light-theme elements ---
  // kill the white scroll-fade sticky headers (they render as an ugly white bar on dark)
  ".sticky.top-0{background-image:none !important;background-color:transparent !important;}",
  // hardcoded dark arbitrary-hex text (text-[#191919], text-[#101323], …) -> light, but ONLY on app pages
  // (the editor keeps dark text on white slides). Covers all dark hexes #00..#3f.
  "[data-fr-app='app'] [class*='text-[#0'],[data-fr-app='app'] [class*='text-[#1'],[data-fr-app='app'] [class*='text-[#2'],[data-fr-app='app'] [class*='text-[#3']{color:#f2f2f5 !important;-webkit-text-fill-color:#f2f2f5 !important;}",
  // white chip/pill backgrounds (rounded-full) -> dark card so they match Ycode (slides aren't rounded-full, so untouched)
  ".bg-white.rounded-full{background-color:hsl(0 0% 16%) !important;}",
  // primary CTAs (Presenton overrides bg-primary with an inline peach gradient) -> Ycode blue (CSS !important beats inline)
  ".bg-primary{background-image:none !important;background-color:hsl(217 91% 60%) !important;color:#fff !important;}",
  ".bg-primary:hover{background-color:hsl(217 91% 55%) !important;}",
  ".bg-primary [class*='text-[#10'],.bg-primary [class*='text-[#11']{color:#fff !important;-webkit-text-fill-color:#fff !important;}",
  // ===== APP-PAGE reskin (dashboard/templates/upload/settings — data-fr-app='app'); the editor (data-fr-app='editor') is left alone so slides stay white =====
  // hardcoded white/light page + card backgrounds -> Ycode dark surfaces (incl. semi-transparent bg-white/40..90)
  "[data-fr-app='app'] .bg-white,[data-fr-app='app'] [class*='bg-white/40'],[data-fr-app='app'] [class*='bg-white/50'],[data-fr-app='app'] [class*='bg-white/60'],[data-fr-app='app'] [class*='bg-white/70'],[data-fr-app='app'] [class*='bg-white/80'],[data-fr-app='app'] [class*='bg-white/90']{background-color:hsl(0 0% 13%) !important;}",
  "[data-fr-app='app'] .bg-gray-50,[data-fr-app='app'] .bg-gray-100,[data-fr-app='app'] .bg-slate-50,[data-fr-app='app'] .bg-slate-100,[data-fr-app='app'] .bg-neutral-50,[data-fr-app='app'] .bg-neutral-100,[data-fr-app='app'] .bg-zinc-50,[data-fr-app='app'] .bg-zinc-100,[data-fr-app='app'] .bg-gray-200{background-color:hsl(0 0% 16%) !important;}",
  // dark hardcoded text -> light (Tailwind grays)
  "[data-fr-app='app'] .text-black,[data-fr-app='app'] .text-gray-900,[data-fr-app='app'] .text-gray-800,[data-fr-app='app'] .text-gray-700,[data-fr-app='app'] .text-slate-900,[data-fr-app='app'] .text-slate-800,[data-fr-app='app'] .text-slate-700,[data-fr-app='app'] .text-neutral-900,[data-fr-app='app'] .text-neutral-800,[data-fr-app='app'] .text-zinc-900{color:#f2f2f5 !important;-webkit-text-fill-color:#f2f2f5 !important;}",
  "[data-fr-app='app'] .text-gray-600,[data-fr-app='app'] .text-gray-500,[data-fr-app='app'] .text-gray-400,[data-fr-app='app'] .text-slate-600,[data-fr-app='app'] .text-slate-500,[data-fr-app='app'] .text-neutral-600,[data-fr-app='app'] .text-neutral-500{color:hsl(0 0% 64%) !important;-webkit-text-fill-color:hsl(0 0% 64%) !important;}",
  // light borders -> subtle dark
  "[data-fr-app='app'] .border-gray-200,[data-fr-app='app'] .border-gray-100,[data-fr-app='app'] .border-gray-300,[data-fr-app='app'] .border-slate-200,[data-fr-app='app'] .border-slate-100,[data-fr-app='app'] .border-neutral-200{border-color:hsl(0 0% 20%) !important;}",
  // selected/active list item (light lavender bg-[#F4F3FF]) -> dark surface with a blue accent border (Ycode 'selected' look)
  "[data-fr-app='app'] [class*='bg-[#F4F3FF'],[data-fr-app='app'] [class*='bg-[#EEF'],[data-fr-app='app'] [class*='bg-[#EFF']{background-color:hsl(217 30% 18%) !important;}",
  "[data-fr-app='app'] [class*='border-[#D9D6FE'],[data-fr-app='app'] [class*='border-[#C7D']{border-color:hsl(217 60% 48%) !important;}",
  // hover states designed for light bg -> dark
  "[data-fr-app='app'] .hover\\:bg-gray-50:hover,[data-fr-app='app'] .hover\\:bg-gray-100:hover,[data-fr-app='app'] .hover\\:bg-slate-100:hover,[data-fr-app='app'] .hover\\:bg-neutral-100:hover{background-color:hsl(0 0% 18%) !important;}",
  // Ycode buttons: not pill-shaped; secondary/outline buttons use the input surface
  "[data-fr-app='app'] button{font-family:'Inter' !important;font-weight:500 !important;}",
  "a[href*='presenton.ai'],a[href*='github.com/presenton'],img[src*='logo' i],img[alt*='presenton' i],[aria-label*='presenton' i]{display:none !important;}",
].join('');

const INJECT = `<script id="fr-ycode-js">
(function(){
  var BRAND=${JSON.stringify(BRAND)};
  var CSS=${JSON.stringify(CSS_TEXT)};
  var FONT='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap';
  var RE=/presenton/ig;
  function ensure(){
    var head=document.head||document.documentElement;
    if(!document.getElementById('fr-ycode-font')){var l=document.createElement('link');l.id='fr-ycode-font';l.rel='stylesheet';l.href=FONT;head.appendChild(l);}
    var s=document.getElementById('fr-ycode-style');
    if(!s||!s.isConnected){ if(!s){s=document.createElement('style');s.id='fr-ycode-style';s.textContent=CSS;} head.appendChild(s); }
    try{
      document.documentElement.classList.add('dark');
      // Route flag: the slide editor keeps white slides; every other page gets the full app reskin.
      var p=location.pathname;
      var isEditor=(p.indexOf('/presentation')===0)||(p.indexOf('/pdf-maker')===0);
      document.documentElement.setAttribute('data-fr-app', isEditor?'editor':'app');
    }catch(e){}
  }
  function scrub(){
    try{
      if(document.title && RE.test(document.title)) document.title=BRAND;
      document.querySelectorAll('img,svg').forEach(function(el){var t=(el.getAttribute('alt')||'')+' '+(el.getAttribute('aria-label')||'')+' '+(el.getAttribute('src')||'');if(RE.test(t))el.style.display='none';});
      if(document.body){var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false),n;while((n=w.nextNode())){if(RE.test(n.nodeValue))n.nodeValue=n.nodeValue.replace(RE,BRAND);}}
    }catch(e){}
  }
  // Presenton's primary CTAs use an INLINE peach gradient (Get Started / New Template / …).
  // CSS can't target inline-style values, so restyle them to Ycode's blue squircle button in JS.
  function fixCTAs(){
    try{
      document.querySelectorAll('[style*="linear-gradient(270deg"]').forEach(function(el){
        el.style.setProperty('background','hsl(217 91% 60%)','important');
        el.style.setProperty('background-image','none','important');
        el.style.setProperty('color','#ffffff','important');
        el.style.setProperty('-webkit-text-fill-color','#ffffff','important');
        el.style.setProperty('border-radius','12px','important');
        el.style.setProperty('box-shadow','none','important');
      });
    }catch(e){}
  }
  function tick(){ ensure(); scrub(); fixCTAs(); }
  var mo=new MutationObserver(tick);
  function boot(){ tick(); mo.observe(document.documentElement,{subtree:true,childList:true,characterData:true}); setInterval(tick,1500); }
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
        // Inject at end of <body> — a sibling of the Next.js root, so the script
        // runs after the body exists and survives head reconciliation.
        if (body.includes('</body>')) body = body.replace('</body>', INJECT + '</body>');
        else if (body.includes('</head>')) body = body.replace('</head>', INJECT + '</head>');
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

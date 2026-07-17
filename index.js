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
  "--primary:221 83% 53%;--primary-foreground:0 0% 100%;",
  "--secondary:0 0% 17%;--secondary-foreground:0 0% 98%;",
  "--muted:0 0% 17%;--muted-foreground:0 0% 63%;",
  "--accent:0 0% 19%;--accent-foreground:0 0% 98%;",
  "--destructive:0 72% 51%;--destructive-foreground:0 0% 98%;",
  "--border:0 0% 20%;--input:0 0% 20%;--ring:221 83% 53%;--radius:0.625rem;",
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
  ".bg-primary{background-image:none !important;background-color:hsl(221 83% 53%) !important;color:#fff !important;}",
  ".bg-primary:hover{background-color:hsl(221 74% 46%) !important;}",
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
  // Advanced-Settings modal + panels: specific hardcoded light-hex surfaces -> Ycode dark (kept specific so template slide previews stay white)
  "[data-fr-app='app'] [class*='bg-[#F3F3F6'],[data-fr-app='app'] [class*='bg-[#F8F8FA'],[data-fr-app='app'] [class*='bg-[#FAFAFA'],[data-fr-app='app'] [class*='bg-[#F5F5F5'],[data-fr-app='app'] [class*='bg-[#FBFBFD'],[data-fr-app='app'] [class*='bg-[#F7F7']{background-color:hsl(0 0% 13%) !important;}",
  "[data-fr-app='app'] [class*='bg-[#ECE8F6'],[data-fr-app='app'] [class*='bg-[#EDE8'],[data-fr-app='app'] [class*='bg-[#F0F0F4'],[data-fr-app='app'] [class*='bg-[#EAE']{background-color:hsl(0 0% 16.5%) !important;}",
  "[data-fr-app='app'] [class*='border-[#E7E9F2'],[data-fr-app='app'] [class*='border-[#EDEEEF'],[data-fr-app='app'] [class*='border-[#E7E'],[data-fr-app='app'] [class*='border-[#EDE'],[data-fr-app='app'] [class*='border-[#EAE']{border-color:hsl(0 0% 22%) !important;}",
  // decorative sparkle SVGs live INSIDE the hero <h1> (svg.absolute) — hide them
  "[data-fr-app='app'] h1 svg,[data-fr-app='app'] h1 img{display:none !important;}",
  // prompt box: kill the ugly whitish border, make it a FILLED dark input (Ycode bg-input, rounded)
  "[data-fr-app='app'] [class*='border-[#DBDBDB']{border:0 !important;background-color:hsl(0 0% 100% / 0.05) !important;border-radius:14px !important;box-shadow:none !important;}",
  "[data-fr-app='app'] textarea{background-color:transparent !important;border:0 !important;box-shadow:none !important;}",
  // remove white separator lines (hr + the light divider borders like border-[#E1E1E5])
  "[data-fr-app='app'] hr{display:none !important;}",
  "[data-fr-app='app'] [class*='border-[#E1'],[data-fr-app='app'] [class*='border-[#E5'],[data-fr-app='app'] [class*='border-[#E8'],[data-fr-app='app'] [class*='border-[#EEE'],[data-fr-app='app'] [class*='border-[#F0'],[data-fr-app='app'] [class*='border-[#DDD'],[data-fr-app='app'] [class*='border-white']{border-color:transparent !important;}",
  // sidebar light bg -> dark
  "[data-fr-app='app'] [class*='bg-[#F6'],[data-fr-app='app'] [class*='bg-[#F9'],[data-fr-app='app'] [class*='bg-[#FCF']{background-color:hsl(0 0% 11%) !important;}",
  // ===== Dropdowns / menus (slides count, language, settings) -> Ycode popover style =====
  "[data-fr-app='app'] [role='menu'],[data-fr-app='app'] [role='listbox'],[data-fr-app='app'] [class*='DropdownMenuContent'],[data-fr-app='app'] [data-radix-menu-content],[data-fr-app='app'] [data-radix-popper-content-wrapper] > div{background-color:hsl(0 0% 13%) !important;border:1px solid hsl(0 0% 100% / 0.08) !important;border-radius:12px !important;box-shadow:0 12px 40px rgba(0,0,0,.55) !important;padding:4px !important;}",
  "[data-fr-app='app'] [role='menuitem'],[data-fr-app='app'] [role='option']{border-radius:8px !important;color:#e6e6e9 !important;-webkit-text-fill-color:#e6e6e9 !important;font-family:'Inter' !important;}",
  "[data-fr-app='app'] [role='menuitem']:hover,[data-fr-app='app'] [role='option']:hover,[data-fr-app='app'] [role='menuitem'][data-highlighted],[data-fr-app='app'] [role='option'][data-highlighted]{background-color:hsl(0 0% 100% / 0.08) !important;}",
  // number/search inputs inside dropdowns -> filled dark, rounded, no white border
  "[data-fr-app='app'] [role='menu'] input,[data-fr-app='app'] [role='listbox'] input{background-color:hsl(0 0% 100% / 0.06) !important;border:1px solid hsl(0 0% 100% / 0.1) !important;border-radius:8px !important;color:#e6e6e9 !important;}",
  // hover states designed for light bg -> dark
  "[data-fr-app='app'] .hover\\:bg-gray-50:hover,[data-fr-app='app'] .hover\\:bg-gray-100:hover,[data-fr-app='app'] .hover\\:bg-slate-100:hover,[data-fr-app='app'] .hover\\:bg-neutral-100:hover{background-color:hsl(0 0% 18%) !important;}",
  // ===== Ycode BUTTON style =====
  // Ycode buttons are squircles (rounded-xl), NOT Presenton's rounded-full pills.
  "[data-fr-app='app'] button{font-family:'Inter' !important;font-weight:500 !important;}",
  // pill buttons + pill-triggers (Auto slides / Auto (English) / icon buttons) -> Ycode squircle w/ subtle bg-input fill, no ring, no shadow
  "[data-fr-app='app'] button[class*='rounded-full'],[data-fr-app='app'] a[class*='rounded-full']{border-radius:10px !important;box-shadow:none !important;--tw-ring-shadow:0 0 #0000 !important;--tw-ring-offset-shadow:0 0 #0000 !important;--tw-ring-color:transparent !important;background-color:hsl(0 0% 100% / 0.1) !important;border:0 !important;color:#e6e6e9 !important;}",
  "[data-fr-app='app'] button[class*='rounded-full']:hover,[data-fr-app='app'] a[class*='rounded-full']:hover{background-color:hsl(0 0% 100% / 0.16) !important;}",
  "[data-fr-app='app'] button[class*='rounded-full'] span,[data-fr-app='app'] button[class*='rounded-full'] p{color:#e6e6e9 !important;-webkit-text-fill-color:#e6e6e9 !important;}",
  // primary CTA -> Ycode blue squircle (h-9-ish, rounded-xl, white, medium)
  ".bg-primary,[data-fr-app='app'] [class*='rounded-[28px]'],[data-fr-app='app'] [class*='rounded-[48px]']{border-radius:12px !important;}",
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
        el.style.setProperty('background','hsl(221 83% 53%)','important');
        el.style.setProperty('background-image','none','important');
        el.style.setProperty('color','#ffffff','important');
        el.style.setProperty('-webkit-text-fill-color','#ffffff','important');
        el.style.setProperty('border-radius','12px','important');
        el.style.setProperty('box-shadow','none','important');
      });
    }catch(e){}
  }
  // Interface cleanup ("refais l'interface façon Ycode"): remove clutter Presenton ships.
  function hide(el){ if(el){ el.style.setProperty('display','none','important'); } }
  function has(el,s){ return ((el.textContent||'').indexOf(s)>=0); }
  function redesign(){
    try{
      // 1) model-status chip: "OpenAI (gpt-4o) · Image generation disabled · Web: …"
      document.querySelectorAll("[class*='rounded-[50px]']").forEach(function(el){
        if(has(el,'Image generation disabled')||has(el,'OpenAI (gpt')) hide(el);
      });
      // 2) decorative sparkle SVGs around the "Generate" hero title (svg siblings of the h1)
      var h1=null; document.querySelectorAll('h1').forEach(function(e){ if(has(e,'Generate')) h1=e; });
      // remove the hero title "Generate" + the subtitle — user wants just the prompt space
      if(h1) hide(h1);
      document.querySelectorAll('p,h2,span,div').forEach(function(el){ if((el.textContent||'').trim()==='Turn prompts or documents into presentations with AI') hide(el); });
      // 3) ugly attachments uploader (label + dashed drop box) — user wants a clean prompt only
      document.querySelectorAll('*').forEach(function(el){ if((el.textContent||'').trim()==='Attachments (optional)') hide(el.parentElement||el); });
      document.querySelectorAll("[class*='border-dashed']").forEach(function(el){
        if(el.querySelector && (el.querySelector('input[type=file]') || has(el,'Office docs') || has(el,'Attachments'))) hide(el);
      });
      // 4) remove Settings + Community + Templates + Help from the sidebar (keep Dashboard + prompt only)
      document.querySelectorAll('a,button').forEach(function(el){
        var t=(el.textContent||'').trim(); var w=el.getBoundingClientRect().width;
        if((t==='Settings'||t==='Community'||t==='Help'||t==='Templates')&&w>0&&w<190) hide(el);
      });
      // 5) generation controls -> ONE Ycode segmented bar (light-gray track) with mini-bubble items inside
      var autoBtn=null; document.querySelectorAll('button').forEach(function(b){ if(has(b,'Auto slides')) autoBtn=b; });
      if(autoBtn && autoBtn.parentElement){
        var c=autoBtn.parentElement;
        c.style.setProperty('display','inline-flex','important');
        c.style.setProperty('gap','4px','important');
        c.style.setProperty('background-color','hsl(0 0% 100% / 0.07)','important'); // lighter gray track
        c.style.setProperty('border-radius','12px','important');
        c.style.setProperty('padding','4px','important');
        c.style.setProperty('width','fit-content','important');
        c.style.setProperty('flex-wrap','nowrap','important');
        Array.prototype.forEach.call(c.children,function(ch){
          var bt = ch.tagName==='BUTTON' ? ch : (ch.querySelector && ch.querySelector('button'));
          if(bt){ bt.style.setProperty('background-color','hsl(0 0% 100% / 0.1)','important'); bt.style.setProperty('border','0','important'); bt.style.setProperty('box-shadow','none','important'); bt.style.setProperty('border-radius','8px','important'); } // mini bubble
        });
      }
      // 6) DELETE the left sidebar entirely (narrow sticky/fixed full-height left column)
      document.querySelectorAll("[class*='h-screen'],aside,nav").forEach(function(el){
        var cs=getComputedStyle(el); var r=el.getBoundingClientRect();
        if((cs.position==='sticky'||cs.position==='fixed') && r.width>0 && r.width<230 && r.left<70 && r.height>400) hide(el);
      });
      // 7) center the prompt column
      var ta=document.querySelector('textarea');
      if(ta){ var node=ta;
        for(var i=0;i<9&&node;i++){
          if(node.parentElement && node.querySelector && node.querySelector('textarea') && has(node,'Get Started')){
            node.style.setProperty('max-width','900px','important');
            node.style.setProperty('margin-left','auto','important');
            node.style.setProperty('margin-right','auto','important');
            break;
          }
          node=node.parentElement;
        }
      }
    }catch(e){}
  }
  function tick(){ ensure(); scrub(); fixCTAs(); redesign(); }
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

// Tiny realtime log dashboard for the Craft World bot.
// Serves an HTML page that streams factory_loop.log via Server-Sent Events.
// Access is gated by a secret token in the query string (?key=...).
//
// Env:
//   LOG_PORT   port to listen on (default 8080)
//   LOG_TOKEN  required secret; requests without ?key=<token> get 401
//   LOG_FILE   path to the log file (default ./factory_loop.log)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.LOG_PORT || '8080', 10);
const TOKEN = process.env.LOG_TOKEN || '';
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'factory_loop.log');

// Strip ANSI color codes so the browser shows clean text.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function authed(reqUrl) {
  if (!TOKEN) return true; // no token configured = open (not recommended)
  const u = new URL(reqUrl, 'http://x');
  return u.searchParams.get('key') === TOKEN;
}

const PAGE = `<!doctype html>
<html lang="vi"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Craft Bot — Log</title>
<style>
  body{margin:0;background:#0d1117;color:#c9d1d9;font:13px/1.5 ui-monospace,Consolas,monospace}
  header{position:sticky;top:0;background:#161b22;padding:10px 14px;border-bottom:1px solid #30363d;display:flex;gap:12px;align-items:center}
  h1{font-size:14px;margin:0;font-weight:600}
  .dot{width:9px;height:9px;border-radius:50%;background:#3fb950;box-shadow:0 0 6px #3fb950}
  .dot.off{background:#f85149;box-shadow:0 0 6px #f85149}
  #log{padding:10px 14px;white-space:pre-wrap;word-break:break-word}
  .ok{color:#3fb950}.warn{color:#d29922}.err{color:#f85149}.step{color:#58a6ff}.dim{color:#6e7681}
  label{margin-left:auto;font-size:12px;color:#8b949e}
</style></head><body>
<header>
  <span class="dot" id="dot"></span>
  <h1>Craft World Bot — factory_loop.log</h1>
  <label><input type="checkbox" id="follow" checked> auto-scroll</label>
</header>
<div id="log"></div>
<script>
  const logEl = document.getElementById('log');
  const dot = document.getElementById('dot');
  const follow = document.getElementById('follow');
  function color(line){
    if(/\\[✓\\]/.test(line)) return 'ok';
    if(/\\[⚠\\]/.test(line)) return 'warn';
    if(/\\[✗\\]/.test(line)) return 'err';
    if(/\\[➤\\]/.test(line)) return 'step';
    return 'dim';
  }
  function add(line){
    const div=document.createElement('div');
    div.className=color(line);
    div.textContent=line;
    logEl.appendChild(div);
    while(logEl.childNodes.length>2000) logEl.removeChild(logEl.firstChild);
    if(follow.checked) window.scrollTo(0,document.body.scrollHeight);
  }
  const key = new URLSearchParams(location.search).get('key')||'';
  const es = new EventSource('/stream?key='+encodeURIComponent(key));
  es.onmessage = e => add(e.data);
  es.onopen = ()=>dot.classList.remove('off');
  es.onerror = ()=>dot.classList.add('off');
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (!authed(req.url)) {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Unauthorized — add ?key=<token>');
    return;
  }

  const urlPath = req.url.split('?')[0];

  if (urlPath === '/' || urlPath === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (urlPath === '/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');

    // Send the last ~650 lines first, then follow new ones via `tail -F`.
    try {
      const existing = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-650);
      for (const l of existing) if (l) res.write(`data: ${stripAnsi(l)}\n\n`);
    } catch { /* file may not exist yet */ }

    const tail = spawn('tail', ['-n', '0', '-F', LOG_FILE]);
    const onData = (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (line) res.write(`data: ${stripAnsi(line)}\n\n`);
      }
    };
    tail.stdout.on('data', onData);

    // Heartbeat keeps proxies from closing the idle connection.
    const hb = setInterval(() => res.write(': ping\n\n'), 15000);

    req.on('close', () => { clearInterval(hb); tail.kill(); });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[log-server] listening on :${PORT}  token=${TOKEN ? 'set' : 'NONE'}  file=${LOG_FILE}`);
});

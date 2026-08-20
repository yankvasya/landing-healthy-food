// Capture screenshots of each section using Chrome DevTools Protocol
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const URL = 'https://yankvasya.github.io/landing-healthy-food/';
const PORT = 9224;
const OUT_DIR = __dirname;

// Sections to capture: [name, scrollY] based on measured section offsets
const SECTIONS = [
  ['hero', 0],
  ['advantages', 822],
  ['menu', 1495],
  ['how', 2898],
  ['testimonials', 3484],
  ['cta', 4144],
  ['footer', 4481],
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 200)}`);
  }
}

async function main() {
  // Launch Brave headless with remote debugging, redirect output to file
  const logFile = fs.openSync(path.join(OUT_DIR, 'brave.log'), 'w');
  const brave = spawn(BRAVE, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1440,900', 'about:blank'
  ], { stdio: ['ignore', logFile, logFile] });

  // Wait for debugging endpoint
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await getJson(`http://127.0.0.1:${PORT}/json`);
      if (targets.length) break;
    } catch (e) {}
    await sleep(500);
  }
  if (!targets || !targets.length) {
    console.error('Failed to connect to Brave');
    brave.kill();
    process.exit(1);
  }

  // Use the existing page tab
  const tab = targets.find(t => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  function send(method, params = {}) {
    return new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await send('Page.enable');
  await send('Runtime.enable');

  // Navigate to the site
  await send('Page.navigate', { url: URL });
  await sleep(6000);

  // Set device metrics for consistent viewport (2x for crisp images)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
  });
  await sleep(1000);

  // Capture each section
  for (const [name, y] of SECTIONS) {
    await send('Runtime.evaluate', { expression: `window.scrollTo(0, ${y});` });
    await sleep(1500); // wait for reveal animations

    const result = await send('Page.captureScreenshot', { format: 'png' });
    const buf = Buffer.from(result.result.data, 'base64');
    const file = path.join(OUT_DIR, `section-${name}.png`);
    fs.writeFileSync(file, buf);
    console.log(`Saved ${file} (${buf.length} bytes)`);
  }

  ws.close();
  brave.kill();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });

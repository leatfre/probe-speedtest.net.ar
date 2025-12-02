const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const CENTRAL_URL = (process.env.CENTRAL_URL || '').replace(/\/$/, '');
const DOMAIN = process.env.DOMAIN || '';
const SELF_HOST_RAW = (process.env.SELF_HOST || DOMAIN || '').trim();
const SELF_HOST_HAS_SCHEME = /^https?:\/\//i.test(SELF_HOST_RAW);
const SELF_HOST = SELF_HOST_HAS_SCHEME ? SELF_HOST_RAW.replace(/\/$/, '') : SELF_HOST_RAW;
const INTERVAL = parseInt(process.env.AUTO_UPDATE_INTERVAL_MS || '60000'); // 1 minuto default
const PROBE_CONTAINER = process.env.PROBE_CONTAINER || 'speedtest-probe';

// Helper simple para templates (si faltaba)
function renderTemplate(buf) {
  // Por ahora solo devolvemos el buffer tal cual, 
  // ya que no tenemos logica de template definida.
  return buf;
}

// Robust fetch wrapper with timeout
async function fetchJson(url, opts) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 15000); // 15s timeout
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    clearTimeout(id);
    throw e;
  }


}

async function logToCentral(message, level = 'info') {
  try {
    const origin = CENTRAL_URL;
    // We need a token. We can't easily get it here without refactoring.
    // But we can try to reuse the token if we are inside the cycle.
    // For now, let's just console.log and hope the existing log scraper picks it up?
    // No, the existing log scraper picks up docker logs.
    // So console.log IS sending to central!
    console.log(`[Update] ${message}`);
  } catch (e) { }
}

function writeIfChanged(rel, buf) {
  try {
    const abs = path.join(__dirname, rel);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let current = Buffer.alloc(0);
    if (fs.existsSync(abs)) current = fs.readFileSync(abs);

    if (Buffer.compare(current, buf) !== 0) {
      fs.writeFileSync(abs, buf);
      console.log(`[Update] Updated ${rel}`);
      return true;
    }
  } catch (e) {
    console.error(`[Update] Error writing ${rel}:`, e);
  }
  return false;
}

function dockerRequest(pathname, method = 'POST') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: pathname, method }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function restartContainer(name) {
  try {
    console.log(`[Update] Restarting container: ${name}`);
    await dockerRequest(`/containers/${encodeURIComponent(name)}/restart`, 'POST');
  } catch (e) {
    console.error(`[Update] Failed to restart ${name}:`, e);
  }
}

async function restartProbe() {
  await restartContainer(PROBE_CONTAINER);
  // Evitamos reiniciar Nginx/ACME automáticamente para no causar inestabilidad
  // await new Promise(r => setTimeout(r, 2000));
  // await restartContainer('speedtest-acme');
  // await new Promise(r => setTimeout(r, 2000));
  // await restartContainer('nginx-proxy');
}

const CONTAINERS = [
  process.env.PROBE_CONTAINER || 'speedtest-probe',
  'speedtest-autoupdate',
  'nginx-proxy',
  'speedtest-acme'
];

async function getContainerLogs(container) {
  try {
    const res = await dockerRequest(`/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&tail=100&timestamps=1`, 'GET');
    if (res.statusCode !== 200) return '';
    const buf = res.body;
    let out = '';
    let i = 0;
    while (i < buf.length) {
      if (i + 8 > buf.length) break;
      const size = buf.readUInt32BE(i + 4);
      i += 8;
      if (i + size > buf.length) break;
      out += buf.subarray(i, i + size).toString('utf8');
      i += size;
    }
    return out;
  } catch { return ''; }
}

function hostCandidates() {
  const c = [];
  if (SELF_HOST) c.push(SELF_HOST);
  if (DOMAIN) c.push(`https://${DOMAIN}`);
  // if (DOMAIN) c.push(`http://${DOMAIN}`); // Evitamos HTTP simple para evitar errores de Mixed Content si el central fuerza HTTPS
  return [...new Set(c)];
}

async function cycle() {
  if (!CENTRAL_URL || !SELF_HOST) return;
  try {
    const origin = CENTRAL_URL;
    let token = '';
    for (const h of hostCandidates()) {
      try {
        // Added timeout protection implicitly via updated fetchJson if used here, 
        // but for safety let's wrap this fetch specifically or rely on fetchJson update?
        // The code below uses fetchJson, so it inherits the timeout.
        const tokenData = await fetchJson(`${CENTRAL_URL}/probe/token`, {
          method: 'POST',
          headers: { 'Origin': origin, 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: h })
        });
        token = tokenData && tokenData.token;
        if (token) break;
      } catch (e) { console.warn(`[Update] Token fetch failed for ${h}:`, e.message); }
    }
    if (!token) return;
    const data = await fetchJson(`${CENTRAL_URL}/probe/update/files`, {
      headers: { 'Origin': origin, 'X-Probe-Auth': token }
    });
    const files = Array.isArray(data?.files) ? data.files : [];
    let changed = false;
    let selfChanged = false;
    for (const f of files) {
      let rel = String(f.path || '').replace(/\\/g, '/');
      let buf = Buffer.from(String(f.content_b64 || ''), 'base64');
      if (rel.startsWith('vhost.d/')) {
        const domain = process.env.DOMAIN || SELF_HOST.replace(/^https?:\/\//, '');
        // Use _location file to force proxy_pass inside location /
        const oldFile = require('path').join(APPLY_DIR, 'vhost.d', domain);
        try { if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile); } catch { }

        rel = `vhost.d/${domain}_location`;
        buf = renderTemplate(buf);
        // The original instruction had `continue;` outside the block but indented.
        // Assuming it was meant to be inside to skip further processing for this file.
        const wasChanged = writeIfChanged(rel, buf); // Apply the change for the _location file
        if (wasChanged) changed = true; // Mark as changed if the _location file was updated
        continue; // Skip the rest of the loop for this file
      }
      if (rel.endsWith('.env')) continue;
      if (rel === 'package-lock.json') continue;
      const wasChanged = writeIfChanged(rel, buf);
      if (wasChanged) {
        changed = true;
        if (rel === 'autoupdate.js') selfChanged = true;
      }
    }
    if (changed) {
      try {
        // Debounce restart slightly
        console.log('[Update] Changes detected, restarting probe in 2s...');
        await new Promise(r => setTimeout(r, 2000));
        await restartProbe();
      } catch { }
    }

    try {
      for (const container of CONTAINERS) {
        const logs = await getContainerLogs(container);
        if (logs) {
          await fetchJson(`${CENTRAL_URL}/probe/log`, {
            method: 'POST',
            headers: { 'Origin': origin, 'X-Probe-Auth': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ level: 'info', code: `docker_logs:${container}`, message: logs })
          });
        }
      }
    } catch { }

    if (selfChanged) {
      console.log('Self-update detected. Exiting to restart...');
      process.exit(0);
    }
  } catch { }
}

setInterval(cycle, INTERVAL);
cycle();
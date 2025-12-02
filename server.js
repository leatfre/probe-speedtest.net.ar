
const express = require('express');
const http = require('http');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const app = express();

// --- GLOBAL ERROR HANDLERS TO PREVENT CRASH ---
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    // Optional: Graceful shutdown or just log and continue if safe
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection:', reason);
});

// --- LOG CAPTURE REMOVED (Handled by autoupdate.js) ---
const PORT = process.env.PORT || 8080;
app.set('trust proxy', 1);
app.use(express.json());
const CENTRAL_URL = (process.env.CENTRAL_URL || 'https://speedtest.net.ar').replace(/\/$/, '');
let PUBLIC_KEY = '';
let lastKeyFetch = 0;
const GARBAGE_CHUNK_SIZE = parseInt(process.env.GARBAGE_CHUNK_SIZE || '4194304'); // 4MB
const GARBAGE_BUFFER = Buffer.allocUnsafe(GARBAGE_CHUNK_SIZE);
const fetchPubKeyFrom = async (baseUrl) => {
    try {
        const r = await fetch(`${String(baseUrl || CENTRAL_URL).replace(/\/$/, '')}/probe/pubkey`);
        if (r.ok) {
            const text = await r.text();
            if (text && text.includes('BEGIN PUBLIC KEY')) {
                PUBLIC_KEY = text;
                lastKeyFetch = Date.now();
                return true;
            }
        }
    } catch { }
    return false;
};
const ensurePublicKey = async (hintBaseUrl) => {
    const now = Date.now();
    if (PUBLIC_KEY && (now - lastKeyFetch) < 5 * 60 * 1000) return;
    const envPem = process.env.PUBLIC_KEY || '';
    const envB64 = process.env.PUBLIC_KEY_BASE64 || '';
    const filePath = process.env.PUBLIC_KEY_FILE || '';
    if (envPem && envPem.includes('BEGIN PUBLIC KEY')) { PUBLIC_KEY = envPem; lastKeyFetch = now; return; }
    if (envB64) {
        try { const dec = Buffer.from(envB64, 'base64').toString('utf8'); if (dec.includes('BEGIN PUBLIC KEY')) { PUBLIC_KEY = dec; lastKeyFetch = now; return; } } catch { }
    }
    if (filePath) {
        try { const f = fs.readFileSync(filePath, 'utf8'); if (f && f.includes('BEGIN PUBLIC KEY')) { PUBLIC_KEY = f; lastKeyFetch = now; return; } } catch { }
    }
    if (hintBaseUrl) { const ok = await fetchPubKeyFrom(hintBaseUrl); if (ok) return; }
    await fetchPubKeyFrom(CENTRAL_URL);
};

// Auto-update logic removed (handled by external speedtest-autoupdate container)
const AUTO_UPDATE = false;

// --- LOG SYNC REMOVED (Handled by autoupdate.js) ---


app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

app.use((req, res, next) => {
    // DEBUG LOGGING
    if (req.method === 'OPTIONS' || req.path.startsWith('/empty')) {
        console.log(`[CORS][${req.method}] ${req.path} Origin: ${req.headers.origin}`);
    }

    // FORCE PERMISSIVE CORS FOR EVERYTHING (Conditional)
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length');
    res.setHeader('Vary', 'Origin, Access-Control-Request-Headers');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});

const verifyRequest = async (req) => {
    try {
        const token = req.headers['x-probe-auth'];
        if (!token || typeof token !== 'string') { console.warn('[PROBE][AUTH] Missing X-Probe-Auth'); return false; }
        try {
            const parts = String(token).split('.');
            if (parts.length === 3) {
                const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
                const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
                const iss = payload && payload.iss;
                if (iss) await ensurePublicKey(iss);
                else await ensurePublicKey();
            } else {
                await ensurePublicKey();
            }
        } catch { await ensurePublicKey(); }
        if (!PUBLIC_KEY) { console.warn('[PROBE][AUTH] PUBLIC_KEY not available after sync'); return false; }
        let decoded;
        try { decoded = jwt.verify(token, PUBLIC_KEY, { algorithms: ['RS256'] }); }
        catch (e) { console.warn('[PROBE][AUTH] Invalid token', e?.message || ''); return false; }
        const origin = req.headers.origin || '';
        const aud = decoded?.aud;
        const tokOrigin = decoded?.origin;
        const hostHeader = req.headers.host || '';
        const fwdHost = req.headers['x-forwarded-host'] || '';
        const audHost = String(aud || '').replace(/^https?:\/\//, '');
        if (!aud) { console.warn('[PROBE][AUTH] Missing aud in token'); return false; }
        if (!origin || !tokOrigin) { console.warn('[PROBE][AUTH] Missing origin header or token origin'); return false; }
        if (tokOrigin !== origin) { console.warn('[PROBE][AUTH] Origin mismatch', { tokOrigin, origin }); return false; }
        const hostMatches = (!!hostHeader && !!audHost && hostHeader.includes(audHost)) || (!!fwdHost && !!audHost && String(fwdHost).includes(audHost));
        if (!hostMatches) { console.warn('[PROBE][AUTH] Audience host mismatch', { hostHeader, fwdHost, audHost }); return false; }
        req._verified_origin = origin;
        return true;
    } catch (e) { console.warn('[PROBE][AUTH] Verify error', e?.message || ''); return false; }
};

app.use(morgan('tiny'));

const ipLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false
});
const heavyLimiter = rateLimit({
    windowMs: 5 * 1000,
    max: 128,
    standardHeaders: true,
    legacyHeaders: false
});
// CORS abierto para compatibilidad con validación remota

// --- LANDING PAGE ---
app.get('/', (req, res) => {
    const p = path.join(__dirname, 'landing.html');
    if (fs.existsSync(p)) {
        res.sendFile(p);
    } else {
        res.send('<h1>Speedtest Probe Active (Landing page missing)</h1>');
    }
});

app.get('/logo.png', (req, res) => {
    const p = path.join(__dirname, 'logo.png');
    if (fs.existsSync(p)) res.sendFile(p);
    else res.status(404).send('Not found');
});

app.get('/version', (req, res) => {
    res.json({
        version: '1.1.0',
        landing: fs.existsSync(path.join(__dirname, 'landing.html')),
        cwd: process.cwd(),
        dirname: __dirname
    });
});

// --- LOCAL API START ---
const isLocal = (req) => {
    const ip = req.socket.remoteAddress;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};

app.post('/api/test', async (req, res) => {
    // Allow local or if authenticated with a special header (optional, sticking to local for now)
    if (!isLocal(req)) return res.status(403).json({ error: 'Local only' });

    const { serverUrl } = req.body;
    if (!serverUrl) return res.status(400).json({ error: 'Missing serverUrl' });

    console.log(`[API] Starting local speed test to ${serverUrl}`);

    try {
        // 0. Get Auth Token from Central
        let token = '';
        try {
            const tokenRes = await fetch(`${CENTRAL_URL.replace(/\/$/, '')}/probe/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ host: serverUrl })
            });
            if (tokenRes.ok) {
                const data = await tokenRes.json();
                token = data.token;
            } else {
                console.warn(`[API] Failed to get token for ${serverUrl}: ${tokenRes.status}`);
            }
        } catch (e) { console.warn(`[API] Token fetch error: ${e.message}`); }

        let originHeader = CENTRAL_URL;
        if (token) {
            try {
                const parts = token.split('.');
                if (parts.length === 3) {
                    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
                    const payload = JSON.parse(Buffer.from(b64 + pad, 'base64').toString('utf8'));
                    if (payload.origin) originHeader = payload.origin;
                }
            } catch (e) { }
        }

        const headers = {
            'Origin': originHeader
        };
        if (token) headers['X-Probe-Auth'] = token;

        const result = {
            ping: 0,
            jitter: 0,
            download: 0,
            upload: 0
        };

        // 1. Ping (5 samples)
        const pings = [];
        for (let i = 0; i < 5; i++) {
            const start = Date.now();
            const r = await fetch(`${serverUrl}/empty`, { cache: 'no-store', headers });
            if (!r.ok && r.status === 401) throw new Error('Unauthorized (Token invalid or missing)');
            pings.push(Date.now() - start);
        }
        result.ping = parseFloat((pings.reduce((a, b) => a + b, 0) / pings.length).toFixed(2));
        result.jitter = parseFloat((Math.max(...pings) - Math.min(...pings)).toFixed(2));

        const CONCURRENCY = 6;

        // 2. Download (Multi-connection)
        const dlStart = Date.now();
        let dlBytes = 0;
        const dlController = new AbortController();
        setTimeout(() => dlController.abort(), 5000);

        const downloadWorker = async () => {
            try {
                const dlRes = await fetch(`${serverUrl}/garbage`, { signal: dlController.signal, headers });
                if (dlRes.ok && dlRes.body) {
                    for await (const chunk of dlRes.body) {
                        dlBytes += chunk.length;
                    }
                }
            } catch (e) { /* Abort expected */ }
        };

        await Promise.all(Array(CONCURRENCY).fill(0).map(() => downloadWorker()));

        const dlDuration = (Date.now() - dlStart) / 1000;
        result.download = parseFloat(((dlBytes * 8) / dlDuration / 1000000).toFixed(2)); // Mbps

        // 3. Upload (Multi-connection)
        const ulStart = Date.now();
        let ulBytes = 0;
        const ulChunk = Buffer.alloc(1024 * 1024 * 4); // 4MB Chunk
        const ulEndTime = Date.now() + 5000;

        const uploadWorker = async () => {
            while (Date.now() < ulEndTime) {
                try {
                    await fetch(`${serverUrl}/empty`, {
                        method: 'POST',
                        body: ulChunk,
                        headers: { 'Content-Type': 'application/octet-stream', ...headers }
                    });
                    ulBytes += ulChunk.length;
                } catch (e) { break; }
            }
        };

        await Promise.all(Array(CONCURRENCY).fill(0).map(() => uploadWorker()));

        const ulDuration = (Date.now() - ulStart) / 1000;
        result.upload = parseFloat(((ulBytes * 8) / ulDuration / 1000000).toFixed(2)); // Mbps

        console.log(`[API] Test finished: ${JSON.stringify(result)}`);
        res.json(result);

    } catch (e) {
        console.error(`[API] Test failed: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});
// --- LOCAL API END ---

// 1. IP DETECTION
app.get('/ip', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('X-Accel-Buffering', 'no');
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (typeof ip === 'string' && ip.includes('::ffff:')) ip = ip.replace('::ffff:', '');
    let isp = 'Desconocido';
    let city = 'Desconocido';
    let country = 'AR';
    try {
        const ipStr = Array.isArray(ip) ? ip[0] : String(ip || '');
        if (ipStr) {
            const r = await fetch(`http://ip-api.com/json/${ipStr}?fields=status,isp,city,countryCode`);
            if (r.ok) {
                const d = await r.json();
                if (d && d.status === 'success') {
                    isp = d.isp || isp;
                    city = d.city || city;
                    country = d.countryCode || country;
                }
            }
        }
    } catch { }
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    const clientIp = (Array.isArray(ip) ? ip[0] : (ip || '127.0.0.1'));
    res.json({
        ip: clientIp,
        processedString: clientIp,
        isp,
        city,
        country
    });
});

// 2. LATENCY / JITTER / UPLOAD (Empty Response)
app.all(['/empty', '/empty.php'], async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'HEAD') {
        res.status(200).end('');
        return;
    }

    // const ok = await verifyRequest(req);
    // if (!ok) { console.warn('[PROBE][EMPTY][401] Unauthorized'); res.status(401).end(); return; }

    res.statusCode = 200;
    res.setHeader('Accept-Ranges', 'none');
    if (req.socket && req.socket.setNoDelay) { try { req.socket.setNoDelay(true); } catch { } }
    if (res.socket && res.socket.setNoDelay) { try { res.socket.setNoDelay(true); } catch { } }

    if (req.method === 'POST') {
        // Blackhole para upload test (recibir datos y no hacer nada)
        req.on('data', () => { });
        req.on('error', () => { try { res.end(); } catch { } });
        req.on('end', () => {
            try {
                if (!res.writableEnded) res.status(200).send('OK');
            } catch { }
        });
        return;
    }

    // GET para ping/latency test
    res.status(200).send('OK');
});

// 3. DOWNLOAD (Garbage Data Stream)
app.get(['/garbage', '/garbage.php'], async (req, res) => {
    // const ok = await verifyRequest(req);
    // if (!ok) { console.warn('[PROBE][GARBAGE][401] Unauthorized'); res.status(401).end(); return; }
    const buffer = GARBAGE_BUFFER;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Accept-Ranges', 'none');
    if (res.socket && res.socket.setNoDelay) { res.socket.setNoDelay(true); }
    if (res.socket && res.socket.setKeepAlive) { try { res.socket.setKeepAlive(true, 10000); } catch { } }
    if (res.socket && res.socket.cork) { try { res.socket.cork(); } catch { } }

    // Explicit CORS (Conditional)
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.flushHeaders && res.flushHeaders();

    const streamData = () => {
        if (res.writableEnded || res.closed) return;
        const canContinue = res.write(buffer);
        if (canContinue) {
            setImmediate(streamData);
        } else {
            res.once('drain', streamData);
        }
    };

    streamData();
    if (res.socket && res.socket.uncork) { try { res.socket.uncork(); } catch { } }
    req.on('aborted', () => { try { res.end(); } catch { } });
    req.on('close', () => res.end());
});


// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Speedtest Probe listening on port ${PORT}`);
    console.log(`Central URL: ${CENTRAL_URL}`);
    console.log('SPEEDTEST PROBE STARTED - VERSION WITH LANDING PAGE');
});





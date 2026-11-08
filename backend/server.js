const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');
const config = require('./lib/config');
const sessionManager = require('./lib/sessionManager');
const moneroRpc = require('./lib/moneroRpc');
const moneroKeys = require('./lib/moneroKeys');
const swapClient = require('./lib/swapClient');
const { rateLimit } = require('./lib/rateLimit');
const pow = require('./lib/pow');

const MAX_BODY_BYTES = 8 * 1024 * 1024; // signed tx sets include every wallet output; allow generous room
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{95}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.mp3': 'audio/mpeg',
    '.wasm': 'application/wasm'
};

function parseBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let aborted = false;
        // A body that trickles in forever would hold the socket open: 30 s is plenty for 8 MB.
        const deadline = setTimeout(() => {
            if (aborted) return;
            aborted = true;
            req.destroy();
            resolve({});
        }, 30000);
        req.on('data', (c) => {
            if (aborted) return;
            total += c.length;
            if (total > MAX_BODY_BYTES) {
                aborted = true;
                req.destroy();
                resolve({});
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            clearTimeout(deadline);
            if (aborted) return;
            const str = Buffer.concat(chunks).toString('utf8');
            const ctype = req.headers['content-type'] || '';
            if (ctype.includes('application/json')) {
                try { resolve(JSON.parse(str)); } catch (e) { resolve({}); }
            } else if (ctype.includes('application/x-www-form-urlencoded')) {
                const params = new URLSearchParams(str);
                const obj = {};
                for (const [k, v] of params.entries()) obj[k] = v;
                resolve(obj);
            } else {
                resolve({ raw: str });
            }
        });
        req.on('error', () => { clearTimeout(deadline); resolve({}); });
    });
}

function setSecurityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/**
 * Content Security Policy for the app page. Everything is same-origin: the only inline script
 * (the storage purge at the top of app.html) gets a per-request nonce; the WebAssembly signer
 * needs 'wasm-unsafe-eval'; the QR renderer emits data: images.
 */
function cspFor(nonce) {
    return [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self'",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'self'"
    ].join('; ');
}

function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}

const gzipCache = new Map(); // filePath -> { mtimeMs, gzippedBuffer }

async function serveStatic(req, res, pathname) {
    const publicRoot = path.resolve(config.publicDir);
    let filePath = path.join(publicRoot, (pathname === '/' || pathname === '/index.html') ? 'app.html' : pathname);
    filePath = path.normalize(filePath);

    // Security check to avoid path traversal
    if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
    }
    // Dotfiles (.DS_Store, .well-known we do not use, editor backups) are never public.
    if (path.relative(publicRoot, filePath).split(path.sep).some(seg => seg.startsWith('.'))) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
    }

    try {
        let stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
            filePath = path.join(filePath, 'app.html');
            stat = await fs.promises.stat(filePath);
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

        // Unchanged asset: 304 with no body (browser revalidates via ETag every load,
        // so files stay fresh but the 5.7MB of JS is only transferred once).
        if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache, must-revalidate' });
            return res.end();
        }

        const headers = {
            'Content-Type': contentType,
            'ETag': etag,
            'Cache-Control': 'no-cache, must-revalidate',
            'Vary': 'Accept-Encoding'
        };

        // gzip text assets; compress once per file version, serve from memory.
        const COMPRESSIBLE = new Set(['.js', '.css', '.html', '.json', '.svg', '.txt', '.map']);
        const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
        if (acceptsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024) {
            let entry = gzipCache.get(filePath);
            if (!entry || entry.mtimeMs !== stat.mtimeMs) {
                entry = { mtimeMs: stat.mtimeMs, buf: zlib.gzipSync(await fs.promises.readFile(filePath), { level: 6 }) };
                if (gzipCache.size >= 40) gzipCache.clear();
                gzipCache.set(filePath, entry);
            }
            headers['Content-Encoding'] = 'gzip';
            headers['Content-Length'] = entry.buf.length;
            res.writeHead(200, headers);
            return res.end(entry.buf);
        }

        headers['Content-Length'] = stat.size;
        // Headers are sent only once the file is actually open; a read error (e.g. a file the
        // unprivileged runtime user cannot read) must never bubble up and kill the process.
        const stream = fs.createReadStream(filePath);
        stream.on('open', () => { res.writeHead(200, headers); stream.pipe(res); });
        stream.on('error', (err) => {
            console.error('[static] read error', filePath, err.code || err.message);
            if (res.headersSent) return res.destroy();
            res.writeHead(err.code === 'EACCES' ? 403 : 404, { 'Content-Type': 'text/plain' });
            res.end(err.code === 'EACCES' ? 'Forbidden' : 'Not Found');
        });
    } catch (e) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
}

async function resolveSession(body, query, headers = {}) {
    // Session ids travel in the POST body or an explicit header only: never in the query string
    // (logs, referrers) and never in cookies (would make every urlencoded POST a CSRF target).
    const authHeader = headers['authorization'];
    const bearer = authHeader ? authHeader.replace(/^Bearer\s+/i, '').trim() : null;

    const sessionId = (body && (body.session_id || body.token)) ||
                      headers['x-session-id'] ||
                      bearer;

    if (!sessionId) return null;
    return await sessionManager.getSession(String(sessionId));
}

/**
 * Only keep the fields the UI needs from the client-supplied pending tx description, and
 * only in the formats we expect. The record is shown back to the same user, but it still
 * must not be able to carry arbitrary payloads.
 */
function sanitizeTxInfo(raw, fallbackAmount) {
    let info = null;
    try {
        info = typeof raw === 'string' && raw ? JSON.parse(raw) : raw;
    } catch (e) {
        info = null;
    }
    if (!info || typeof info !== 'object') info = {};
    const digits = (v) => (typeof v === 'string' || typeof v === 'number') && /^[0-9]{1,20}$/.test(String(v)) ? String(v) : null;
    return {
        amount: digits(info.amount) || digits(fallbackAmount) || '0',
        fee: digits(info.fee) || '0',
        address: (typeof info.address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(info.address)) ? info.address : '',
        payment_id: '0000000000000000'
    };
}

function pendingRecord(txInfo, txid) {
    return Object.assign({}, txInfo, {
        time: Math.floor(Date.now() / 1000),
        type: 'pendingtx',
        direction: 'out',
        confirmations: '0/10',
        txid,
        height: 0
    });
}

/**
 * Combined wallet state for a session (used by /api/state and pushed over /api/events).
 */
async function buildState(session) {
    const isNew = session.isNew === '1' || session.isNew === true;
    const info = await moneroRpc.getAddressInfo(session.address, session.viewkey, session.restoreHeight, isNew);
    const out = { status: 'OK', busy: Boolean(info.busy), restore_height: session.restoreHeight || 0 };
    if (info.busy) {
        // The instance is refreshing (or serving another wallet). Report syncing honestly and,
        // when we have one, the last snapshot marked stale; never a confident zero balance.
        const rec = await sessionManager.getWalletRecord(session.address);
        const tip = parseInt(info.blockchain_height, 10) || (rec ? rec.blockchainHeight : 0) || 0;
        out.syncing = true;
        out.wallet_ready = false;
        out.scan_start = (rec && Number.isInteger(rec.generatedHeight)) ? rec.generatedHeight
            : (Number.isInteger(info.scan_start) ? info.scan_start
                : (session.restoreHeight > 0 ? session.restoreHeight : null));
        // No wallet file yet: the instance is scanning another wallet, so this one is waiting
        // for its turn (deep restores share a few scan lanes). Say so instead of "preparing".
        out.queued = !(rec && rec.walletFile);
        if (rec && rec.stateAt > 0 && typeof rec.balance === 'string') {
            out.stale = true;
            out.as_of = Math.floor(rec.stateAt / 1000);
            out.balance = rec.balance;
            out.unlocked = rec.unlocked || '0';
            out.height = tip > 0 ? { current: Math.max(parseInt(rec.scannedHeight, 10) || 0, parseInt(info.scanned_height, 10) || 0), target: tip } : null;
            out.live = Boolean(info.live);
            out.transactions = Array.isArray(rec.txs) ? rec.txs : [];
            out.transactions_total = out.transactions.length;
        } else {
            // No snapshot yet, but the scan start is known: report it rather than 0, so the
            // page does not flash "0 / 3,794,000" between two polls of the same wallet.
            const known = Math.max(parseInt((rec && rec.scannedHeight) || '0', 10) || 0, out.scan_start || 0, parseInt(info.scanned_height, 10) || 0);
            out.height = tip > 0 ? { current: known, target: tip } : null;
            out.live = Boolean(info.live);
        }
        return out;
    }
    const blockchainHeight = parseInt(info.blockchain_height, 10) || 0;
    out.syncing = Boolean(info.syncing);
    out.scan_start = Number.isInteger(info.scan_start) ? info.scan_start : null;
    out.balance = info.balance || '0';
    out.unlocked = info.unlocked_balance || '0';
    out.wallet_ready = Boolean(info.wallet_ready) && !out.syncing;
    out.height = blockchainHeight > 0 ? {
        current: Math.min(parseInt(info.scanned_height, 10) || 0, blockchainHeight),
        target: blockchainHeight
    } : null;

    const data = await moneroRpc.getAddressTransactions(session.address, session.viewkey, session.restoreHeight, isNew);
    if (data && !data.busy) {
        let txsList = Array.isArray(data.transactions) ? data.transactions : [];
        const pending = await sessionManager.getPendingTxs(session.sessionId);
        if (pending.length > 0) {
            const now = Math.floor(Date.now() / 1000);
            const known = new Set(txsList.map(t => t.txid));
            for (const p of pending) {
                if (known.has(p.txid) || (now - (p.time || 0)) > 1800) {
                    await sessionManager.removePendingTx(session.sessionId, p.txid);
                }
            }
            const still = (await sessionManager.getPendingTxs(session.sessionId)).filter(p => !known.has(p.txid));
            if (still.length) txsList = [...still, ...txsList];
        }
        out.transactions = txsList.slice(0, 10);
        out.transactions_total = txsList.length;
    }
    return out;
}

function stateFingerprint(state) {
    if (!state || state.busy) return null;
    const txs = (state.transactions || []).map(t => `${t.txid}:${t.type}:${t.confirmations}`).join('|');
    return `${state.balance}/${state.unlocked}/${state.height ? state.height.current : 0}/${txs}`;
}

/**
 * Server-sent events. One connection per tab; a short-lived token (not the session id) goes
 * in the URL because EventSource cannot set headers.
 */
const eventTokens = new Map();       // token -> { sessionId, expires }
const subscribers = new Map();       // address -> Set<{ res, session, lastFingerprint }>

function issueEventToken(sessionId) {
    const token = require('crypto').randomBytes(16).toString('hex');
    eventTokens.set(token, { sessionId, expires: Date.now() + 60000 });
    for (const [t, v] of eventTokens) if (v.expires < Date.now()) eventTokens.delete(t);
    return token;
}

function sseSend(res, event, data) {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
}

const pushStats = new Map(); // address -> { pushes, last_push, last_reason, subscribers }

async function pushStateTo(address, reason) {
    const subs = subscribers.get(address);
    if (!subs || subs.size === 0) return;
    const first = subs.values().next().value;
    let state;
    try { state = await buildState(first.session); } catch (e) { return; }
    const fp = stateFingerprint(state);
    if (fp === null) return;
    let sent = 0;
    for (const sub of subs) {
        if (sub.lastFingerprint === fp) continue;
        sub.lastFingerprint = fp;
        sseSend(sub.res, 'state', Object.assign({ reason }, state));
        sent++;
    }
    if (sent > 0) {
        const st = pushStats.get(address) || { pushes: 0 };
        st.pushes += sent;
        st.last_push = Date.now();
        st.last_reason = reason;
        pushStats.set(address, st);
    }
}

moneroRpc.hasSubscribers = (address) => {
    const set = subscribers.get(address);
    return Boolean(set && set.size > 0);
};

moneroRpc.onChainEvent = async (event, touched) => {
    const touchedSet = new Set(Array.isArray(touched) ? touched : []);
    // Wallets whose refresh just reported new money/blocks go first, then the rest.
    const addresses = Array.from(subscribers.keys()).sort((a, b) => (touchedSet.has(b) ? 1 : 0) - (touchedSet.has(a) ? 1 : 0));
    for (const address of addresses) {
        // Only wallets that are open somewhere get rebuilt (subscribers are active users, so
        // theirs normally are). Others wait for their own poll.
        const inst = moneroRpc.instanceFor(address);
        if (inst.openAddress !== address) continue;
        await pushStateTo(address, touchedSet.has(address) ? 'wallet' : (event ? event.type : 'chain'));
    }
};

setInterval(() => {
    for (const subs of subscribers.values()) {
        for (const sub of subs) {
            try { sub.res.write(': keep-alive\n\n'); } catch (e) {}
        }
    }
}, 25000).unref();

/**
 * Per-page URLs with their own SEO tags. The app is a single HTML file; for these paths the
 * server injects the page's title, description, canonical and Open Graph tags so crawlers and
 * link previews see distinct pages, while the client router shows the matching view.
 */
const SITE_URL = (process.env.SITE_URL || 'https://xmrnest.org').replace(/\/+$/, '');
const SEO_PAGES = {
    '/': {
        page: 'welcome',
        title: 'Monero Web Wallet: Private XMR Wallet Online | XmrNest',
        description: 'XmrNest is a Monero web wallet that runs in your browser. Create or restore an XMR wallet in minutes. Your keys never leave your device.'
    },
    '/create': {
        page: 'create',
        title: 'Create a Monero Wallet: Free 25-Word Seed | XmrNest',
        description: 'Create a new Monero wallet in your browser. Get your 25-word XMR seed in seconds. No sign-up, no email. Your seed is never sent to our servers.'
    },
    '/restore': {
        page: 'import',
        title: 'Restore Monero Wallet from Seed or Keys | XmrNest',
        description: 'Restore your Monero wallet with your 25-word seed or private keys. Works with seeds from Monero GUI, Cake Wallet and Feather. Keys stay in your browser.'
    },
    '/how-to-use': {
        page: 'how',
        title: 'How to Use a Monero Wallet: Send & Receive XMR | XmrNest',
        description: 'Learn how to create a Monero wallet, receive XMR and send it safely in 3 simple steps. Plus easy tips to keep your seed and funds safe.'
    },
    '/swap': {
        page: 'swap',
        title: 'Swap BTC, ETH & USDT to Monero (XMR) | XmrNest',
        description: 'Swap BTC, ETH, USDT, USDC, DAI, BNB, SOL, ZEC or TRX to Monero (XMR) and back. No sign-up, no account. Your XMR goes straight to your own wallet.'
    },
    // Signed-in views: same app, not meant to be indexed.
    '/send': { page: 'send', title: 'Send XMR | XmrNest', description: 'Send Monero from your XmrNest wallet.', noindex: true },
    '/receive': { page: 'receive', title: 'Receive XMR | XmrNest', description: 'Receive Monero in your XmrNest wallet.', noindex: true }
};
const SEO_ALIASES = { '/import': '/restore', '/how': '/how-to-use', '/welcome': '/', '/home': '/' }; // 301 to the canonical path
const SEO_SILENT = { '/index.html': '/', '/app.html': '/' };                                      // same page, no redirect

function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let appHtmlCache = { mtimeMs: 0, html: '' };
async function loadAppHtml() {
    const file = path.join(path.resolve(config.publicDir), 'app.html');
    const stat = await fs.promises.stat(file);
    if (stat.mtimeMs !== appHtmlCache.mtimeMs) {
        appHtmlCache = { mtimeMs: stat.mtimeMs, html: await fs.promises.readFile(file, 'utf8') };
    }
    return appHtmlCache.html;
}

async function serveAppPage(req, res, routePath) {
    const meta = SEO_PAGES[routePath];
    let html = await loadAppHtml();
    const canonical = SITE_URL + (routePath === '/' ? '/' : routePath);
    const tags = [
        `<title>${escapeAttr(meta.title)}</title>`,
        `<meta name="description" content="${escapeAttr(meta.description)}">`,
        meta.noindex ? '<meta name="robots" content="noindex, nofollow">' : '<meta name="robots" content="index, follow">',
        `<link rel="canonical" href="${escapeAttr(canonical)}">`,
        `<meta property="og:type" content="website">`,
        `<meta property="og:site_name" content="XmrNest">`,
        `<meta property="og:title" content="${escapeAttr(meta.title)}">`,
        `<meta property="og:description" content="${escapeAttr(meta.description)}">`,
        `<meta property="og:url" content="${escapeAttr(canonical)}">`,
        `<meta property="og:image" content="${escapeAttr(SITE_URL + '/img/xmrnest-monero-wallet.png')}">`,
        `<meta name="twitter:card" content="summary">`,
        `<meta name="twitter:title" content="${escapeAttr(meta.title)}">`,
        `<meta name="twitter:description" content="${escapeAttr(meta.description)}">`
    ].join('\n');
    html = html.replace(/<title>[^<]*<\/title>/, tags);
    // Tell the client router which view this URL is for (used before any hash logic).
    html = html.replace('<body', `<body data-route="${escapeAttr(meta.page)}"`);
    // The single inline script (storage purge) is allowed through a per-request nonce.
    const nonce = require('crypto').randomBytes(16).toString('base64');
    html = html.replace('<script>', `<script nonce="${nonce}">`);

    const headers = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, must-revalidate',
        'Content-Security-Policy': cspFor(nonce),
        'Vary': 'Accept-Encoding'
    };
    const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
    const body = Buffer.from(html, 'utf8');
    if (acceptsGzip) {
        const gz = zlib.gzipSync(body, { level: 6 });
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = gz.length;
        res.writeHead(200, headers);
        return res.end(gz);
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
}

function robotsTxt() {
    return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /send\nDisallow: /receive\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

function sitemapXml() {
    const urls = Object.keys(SEO_PAGES).filter(p => !SEO_PAGES[p].noindex)
        .map(p => `  <url><loc>${escapeAttr(SITE_URL + (p === '/' ? '/' : p))}</loc><changefreq>weekly</changefreq></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const server = http.createServer(async (req, res) => {
    setSecurityHeaders(res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;
    const body = (req.method === 'POST') ? await parseBody(req) : {};

    // Abuse limits WITHOUT touching IP addresses (policy: this server never reads, stores or
    // logs a visitor's IP). Budgets are site-wide for anonymous routes; a burst of abuse can
    // exhaust them for a while, but logged-in wallets keep working and no instance can be
    // pinned for hours by a flood of fresh key pairs.
    const tooMany = (name, limit, windowMs, scope) => {
        const wait = rateLimit(scope || 'global', name, limit, windowMs);
        if (!wait) return false;
        res.setHeader('Retry-After', String(wait));
        sendJson(res, 429, { status: 'Failed', code: 'rate_limited', reason: `The service is busy. Please wait ${wait}s and try again.`, retry_after: wait });
        return true;
    };
    if (pathname.startsWith('/api/') && pathname !== '/api/events' && tooMany('api_all', 6000, 60000)) return;

    try {
        // 0. HEALTH / SYNC STATUS (no session needed). Operational detail (which wallets are
        // open / registered) only with the operator token, if one is configured.
        if (pathname === '/api/health') {
            const [daemonInfo, pool] = await Promise.all([
                moneroRpc.callDaemonJsonRpc('get_info'),
                moneroRpc.getPoolStatus()
            ]);
            const walletVersion = pool[0] || {};
            const daemonOk = Boolean(daemonInfo && daemonInfo.status === 'OK');
            const detailed = Boolean(config.healthToken) && String(query.token || '') === config.healthToken;
            if (!detailed) {
                return sendJson(res, 200, {
                    status: daemonOk ? 'OK' : 'DEGRADED',
                    daemon: daemonOk ? { height: daemonInfo.height, synchronized: Boolean(daemonInfo.synchronized) } : { error: 'unreachable' },
                    wallet_rpc: (walletVersion && walletVersion.version) ? { version: walletVersion.version } : { error: 'unreachable' },
                    pool_size: pool.length,
                    redis: sessionManager.isRedisReady
                });
            }
            return sendJson(res, 200, {
                status: daemonOk ? 'OK' : 'DEGRADED',
                daemon: daemonOk ? {
                    height: daemonInfo.height,
                    target_height: daemonInfo.target_height,
                    synchronized: Boolean(daemonInfo.synchronized),
                    tx_pool_size: daemonInfo.tx_pool_size,
                    version: daemonInfo.version
                } : { error: (daemonInfo && daemonInfo.error && daemonInfo.error.message) || 'unreachable' },
                wallet_rpc: (walletVersion && walletVersion.version) ? { version: walletVersion.version } : { error: 'unreachable' },
                wallet_rpc_pool: pool,
                chain_watcher: moneroRpc.watcher.lastEvent,
                event_streams: Array.from(subscribers.entries()).map(([a, set]) => {
                    const st = pushStats.get(a) || {};
                    return { wallet: a.slice(0, 8) + '...', tabs: set.size, pushes: st.pushes || 0,
                             last_push_s: st.last_push ? Math.floor((Date.now() - st.last_push) / 1000) : null, last_reason: st.last_reason || null };
                }),
                registered_wallets: (await sessionManager.listWallets()).length,
                redis: sessionManager.isRedisReady
            });
        }

        // 0b. RESTORE HEIGHT FOR A DATE (YYYY-MM-DD) -> block height two days earlier
        if (pathname === '/api/height-for-date') {
            if (tooMany('height_lookup', 120, 60000)) return;
            const date = String(body.date || query.date || '').trim();
            const height = await moneroRpc.getHeightForDate(date);
            if (height === null) {
                return sendJson(res, 400, { status: 'Failed', reason: 'Invalid date (use YYYY-MM-DD) or daemon unreachable' });
            }
            return sendJson(res, 200, { status: 'OK', date, height });
        }

        // 0b2. RESTORE HEIGHT FROM A KNOWN TRANSACTION ID
        if (pathname === '/api/height-for-txid') {
            if (tooMany('height_lookup', 120, 60000)) return;
            const txid = String(body.txid || query.txid || '').trim();
            if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
                return sendJson(res, 400, { status: 'Failed', reason: 'Transaction ID must be 64 hex characters' });
            }
            const info = await moneroRpc.getHeightForTxid(txid);
            if (!info) {
                return sendJson(res, 404, { status: 'Failed', reason: 'Transaction not found on chain (unknown, or still unconfirmed)' });
            }
            return sendJson(res, 200, { status: 'OK', txid, height: info.height, tx_height: info.tx_height });
        }

        // 0c. COMBINED STATE: one poll instead of balance + height + transactions
        if (pathname === '/api/state') {
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }
            return sendJson(res, 200, await buildState(session));
        }

        // 0d. EVENT TOKEN (short-lived, single purpose) for the SSE stream
        if (pathname === '/api/events/token') {
            if (tooMany('event_token', 300, 60000)) return;
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }
            return sendJson(res, 200, { status: 'OK', token: issueEventToken(session.sessionId), expires_in: 60 });
        }

        // 0e. SERVER-SENT EVENTS: pushes a `state` event whenever the wallet's state changes
        if (pathname === '/api/events') {
            const t = String(query.t || '');
            const entry = eventTokens.get(t);
            eventTokens.delete(t);
            if (!entry || entry.expires < Date.now()) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired event token' });
            }
            const session = await sessionManager.getSession(entry.sessionId);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.write(': connected\n\n');
            const sub = { res, session, lastFingerprint: null };
            if (!subscribers.has(session.address)) subscribers.set(session.address, new Set());
            const set0 = subscribers.get(session.address);
            // At most 5 open streams per wallet: the oldest one is closed when a sixth arrives.
            while (set0.size >= 5) {
                const oldest = set0.values().next().value;
                set0.delete(oldest);
                try { oldest.res.end(); } catch (e) {}
            }
            set0.add(sub);
            req.on('close', () => {
                const set = subscribers.get(session.address);
                if (set) { set.delete(sub); if (set.size === 0) subscribers.delete(session.address); }
            });
            sseSend(res, 'hello', { address: session.address.slice(0, 8) + '...', poll_fallback_seconds: 60 });
            // Initial snapshot so the tab is current without waiting for the next chain event.
            pushStateTo(session.address, 'connect').catch(() => {});
            return;
        }

        // 1. AUTH
        if (pathname === '/api/auth') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            if (rateLimit('global', 'auth', 120, 60000)) {
                return res.end('0:The service is busy. Please wait a minute and try again.');
            }
            const address = String(body.address || '').trim();
            const viewkey = String(body.viewkey || '').trim().toLowerCase();
            const isNew = String(body.isnew || '0').trim() === '1';

            if (!address || !viewkey) {
                return res.end('0:Address and view key are required');
            }
            if (!ADDRESS_RE.test(address)) {
                return res.end('0:Invalid Monero address format');
            }
            if (!HEX64_RE.test(viewkey)) {
                return res.end('0:Invalid private view key format');
            }
            const decoded = moneroKeys.decodeAddress(address);
            if (!decoded || decoded.type !== 'standard') {
                return res.end('0:Address must be a valid primary (standard) Monero address');
            }
            // Prove ownership: the view key must derive the address's public view key.
            // Without this anyone knowing a public address could read that wallet.
            if (!moneroKeys.verifyViewKey(address, viewkey)) {
                return res.end('0:Private view key does not match this address');
            }

            let restoreHeight = parseInt(body.restore_height || body.restoreHeight || query.restore_height || '0', 10);
            if (!Number.isFinite(restoreHeight) || restoreHeight < 0) restoreHeight = 0;
            let heightSource = String(body.restore_source || 'manual').replace(/[^a-z_]/g, '').slice(0, 16) || 'manual';

            // Remember the restore height per wallet. A later re-import without a height reuses it,
            // so a wallet never silently falls back to a full scan from genesis.
            const record = await sessionManager.getWalletRecord(address);
            // A wallet this server has never seen means a new wallet file and a scan. Key pairs
            // are free to mint and we do not look at IPs, so the browser pays a small proof of
            // work per NEW wallet instead (harder while many are being created). Existing
            // wallets never see this.
            const isNewHere = !record;
            if (isNewHere) {
                const nonce = String(body.pow_nonce || '').trim().toLowerCase();
                const chal = String(body.pow_challenge || '').trim().toLowerCase();
                if (!nonce || !chal) {
                    const c = pow.issueChallenge(address);
                    return res.end(`0:POW_REQUIRED:${c.challenge}:${c.bits}`);
                }
                const bad = pow.verify(chal, address, nonce);
                if (bad) {
                    const c = pow.issueChallenge(address);
                    return res.end(`0:POW_REQUIRED:${c.challenge}:${c.bits}`);
                }
                // Daily safety bound (should never be reached with the puzzle in place).
                if (rateLimit('global', 'wallet_new_day', config.newWalletsPerDay, 86400000)) {
                    return res.end('0:Too many new wallets are being created right now. Please try again later.');
                }
            }
            const hasStoredHeight = Boolean(record && record.source && record.source !== 'unknown');
            if (restoreHeight > 0) {
                // A LOWER height is always safe (just slower). Never let a date/txid-derived height
                // raise a stored one (including a stored 0 from a confirmed full scan): a later
                // txid than the wallet's first receive would hide funds on the next regeneration.
                // Only an explicit manual height may raise it.
                if (hasStoredHeight && restoreHeight > record.restoreHeight && heightSource !== 'manual') {
                    restoreHeight = record.restoreHeight;
                    heightSource = 'stored';
                } else if (!record || record.restoreHeight !== restoreHeight) {
                    await sessionManager.saveWalletRecord(address, { restoreHeight, source: heightSource });
                }
                // The wallet FILE may have been generated at another height. wallet-rpc cannot move
                // a file's start height, so ask the instance to re-anchor: upward only if the file
                // has found nothing yet (checked live), downward always (lower is just slower).
                if (record && Number.isInteger(record.generatedHeight) && record.regenerateDeclined !== restoreHeight
                    && (record.generatedHeight < restoreHeight - 100 || (record.generatedHeight > 0 && restoreHeight < record.generatedHeight - 100))) {
                    await sessionManager.setPendingRegenerate(address, restoreHeight);
                }
            } else if (hasStoredHeight && record.restoreHeight > 0) {
                restoreHeight = record.restoreHeight;
                heightSource = 'stored';
            } else if (isNew) {
                // Brand-new wallet: start just below the tip and remember it, so the client can
                // show the real start height and a later re-import never scans from genesis.
                const tip = await moneroRpc.getDaemonHeight();
                if (tip > 0) {
                    restoreHeight = Math.max(0, tip - 1000);
                    await sessionManager.saveWalletRecord(address, { restoreHeight, source: 'new' });
                }
                heightSource = 'new';
            } else {
                heightSource = 'genesis';
                // No height given and none stored: a scan from block 0 would start. Make the
                // client confirm that explicitly (after the view key has been verified above).
                if (String(body.confirm_full_scan || '0') !== '1') {
                    return res.end('0:FULL_SCAN_CONFIRM');
                }
                // Remember the confirmed genesis start so a later date/txid login cannot raise it.
                if (!hasStoredHeight) await sessionManager.saveWalletRecord(address, { restoreHeight: 0, source: 'genesis' });
            }

            const sessionId = await sessionManager.createSession(address, viewkey, isNew, restoreHeight);
            if (isNewHere) pow.recordNewWallet();
            // Pin to an instance once. A restore far below the tip goes to a scan lane so its
            // hours of scanning never block the instances that serve synced wallets.
            let deepScan = false;
            if (isNewHere && !isNew) {
                const tipNow = moneroRpc.lastKnownDaemonHeight || await moneroRpc.getDaemonHeight();
                deepScan = !(restoreHeight > 0) || (tipNow > 0 && restoreHeight < tipNow - config.deepScanBlocks);
            }
            await moneroRpc.placeWallet(address, { deepScan });
            await sessionManager.registerWallet(address); // keep-warm registry (address only)
            return res.end(`1:${sessionId}:${restoreHeight}:${heightSource}`);
        }

        // 4. PRICE FEED
        if (pathname === '/api/price') {
            const prices = await moneroRpc.getPrice();
            return sendJson(res, 200, prices);
        }

        // 5. FEES ESTIMATE (per byte, 4 priority levels from the daemon)
        if (pathname === '/api/fees') {
            const levels = await moneroRpc.getFeeLevels();
            return sendJson(res, 200, {
                status: 'OK',
                fee: levels.fee,
                fees: levels.fees,
                quantization_mask: levels.quantization_mask,
                unit: 'atomic_per_byte'
            });
        }

        // 6. UNSPENT OUTPUTS (legacy/light-client view; never used for the signing flow)
        if (pathname === '/api/unspent-outputs') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return res.end('0');
            }

            const isNew = session.isNew === '1' || session.isNew === true;
            const fee = await moneroRpc.getFeeEstimate();
            const data = await moneroRpc.getWalletUnspentOutputs(session.address, session.viewkey, session.restoreHeight, isNew);
            const spentImages = await sessionManager.getSpentKeyImages(session.sessionId);
            const spentSet = new Set(spentImages.map(k => (k || '').toLowerCase()));

            const result = [fee.toString()];
            if (data && Array.isArray(data.outputs)) {
                for (const out of data.outputs) {
                    if (out.key_image && spentSet.has(out.key_image.toLowerCase())) continue;
                    result.push(out);
                }
            }

            return res.end(JSON.stringify(result));
        }

        // 8a. CREATE UNSIGNED TRANSACTION (watch-only wallet, zero spend key exposure)
        if (pathname === '/api/create-unsigned-tx') {
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }

            const toAddress = String(body.to_address || body.destination || '').trim();
            const sweepAll = String(body.sweep_all || '0') === '1';
            let priority = parseInt(body.priority || '1', 10);
            if (!Number.isFinite(priority) || priority < 1 || priority > 4) priority = 1;

            const dest = moneroKeys.decodeAddress(toAddress);
            if (!dest) {
                return sendJson(res, 400, { status: 'Failed', reason: 'Invalid destination address (bad prefix or checksum)' });
            }
            // Standalone payment IDs are rejected by monero-wallet-rpc >= 0.15. An integrated
            // destination address already carries its payment id, so a payment_id field is
            // never forwarded.

            let amountAtomic = body.amount_atomic || body.amountAtomic;
            if (!sweepAll && !amountAtomic && body.amount) {
                const amt = String(body.amount).trim();
                if (!/^[0-9]*\.?[0-9]*$/.test(amt) || amt === '' || amt === '.') {
                    return sendJson(res, 400, { status: 'Failed', reason: 'Invalid amount format' });
                }
                const parts = amt.split('.');
                const whole = BigInt(parts[0] || '0') * 1000000000000n;
                const fracStr = (parts[1] || '').padEnd(12, '0').slice(0, 12);
                amountAtomic = (whole + BigInt(fracStr || '0')).toString();
            }

            if (!sweepAll) {
                if (!amountAtomic || !/^[0-9]+$/.test(String(amountAtomic))) {
                    return sendJson(res, 400, { status: 'Failed', reason: 'Missing or invalid amount' });
                }
                if (BigInt(amountAtomic) === 0n) {
                    return sendJson(res, 400, { status: 'Failed', reason: 'Amount must be greater than zero' });
                }
            }

            const isNew = session.isNew === '1' || session.isNew === true;
            const result = await moneroRpc.createUnsignedTransfer({
                address: session.address,
                viewkey: session.viewkey,
                toAddress,
                amountAtomic,
                priority,
                restoreHeight: session.restoreHeight,
                isNew,
                sweepAll
            });

            if (result.status === 'OK') {
                return sendJson(res, 200, {
                    status: 'OK',
                    unsigned_txset: result.unsigned_txset,
                    outputs_hex: result.outputs_hex,
                    fee: result.fee,
                    amount: result.amount,
                    tx_hash: result.tx_hash,
                    tx_hash_list: result.tx_hash_list,
                    tx_count: result.tx_count,
                    sweep: sweepAll
                });
            }

            return sendJson(res, 500, {
                status: 'Failed',
                reason: result.reason || 'Failed to create unsigned transaction'
            });
        }

        // 8a2. EXPORT OUTPUTS (for key image computation in the browser)
        if (pathname === '/api/export-outputs') {
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }
            const isNew = session.isNew === '1' || session.isNew === true;
            const result = await moneroRpc.exportOutputs({ address: session.address, viewkey: session.viewkey, restoreHeight: session.restoreHeight, isNew });
            return sendJson(res, result.status === 'OK' ? 200 : (result.busy ? 503 : 500), result);
        }

        // 8a3. IMPORT KEY IMAGES (signed in the browser) so the watch-only wallet learns its spends
        if (pathname === '/api/import-key-images') {
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }
            let list = null;
            try { list = typeof body.key_images === 'string' ? JSON.parse(body.key_images) : body.key_images; } catch (e) { list = null; }
            if (!Array.isArray(list) || list.length > 20000) {
                return sendJson(res, 400, { status: 'Failed', reason: 'key_images must be a JSON array (max 20000)' });
            }
            const clean = [];
            for (const k of list) {
                if (!k || typeof k.key_image !== 'string' || typeof k.signature !== 'string') {
                    return sendJson(res, 400, { status: 'Failed', reason: 'Each item needs key_image and signature' });
                }
                if (!/^[0-9a-fA-F]{64}$/.test(k.key_image) || !/^[0-9a-fA-F]{128}$/.test(k.signature)) {
                    return sendJson(res, 400, { status: 'Failed', reason: 'key_image must be 64 hex chars and signature 128 hex chars' });
                }
                clean.push({ key_image: k.key_image.toLowerCase(), signature: k.signature.toLowerCase() });
            }
            let offset = parseInt(body.offset || '0', 10);
            if (!Number.isFinite(offset) || offset < 0) offset = 0;
            const isNew = session.isNew === '1' || session.isNew === true;
            const result = await moneroRpc.importKeyImages({
                address: session.address, viewkey: session.viewkey, restoreHeight: session.restoreHeight, isNew,
                signedKeyImages: clean, offset
            });
            if (result.status === 'OK') {
                setTimeout(() => pushStateTo(session.address, 'key-images').catch(() => {}), 300);
            }
            return sendJson(res, result.status === 'OK' ? 200 : (result.busy ? 503 : 500), result);
        }

        // 8b. SUBMIT SIGNED TRANSACTION (broadcasts a browser-signed tx set)
        if (pathname === '/api/submit-signed-tx') {
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }

            const signedTxset = String(body.signed_txset || body.tx_data_hex || body.tx || '').trim();
            if (!signedTxset) {
                return sendJson(res, 400, { status: 'Failed', reason: 'Missing signed transaction data (signed_txset)' });
            }
            if (!/^[0-9a-fA-F]+$/.test(signedTxset) || signedTxset.length % 2 !== 0) {
                return sendJson(res, 400, { status: 'Failed', reason: 'Signed transaction data must be a valid hex string' });
            }

            const txInfo = sanitizeTxInfo(body.tx_info, body.amount);
            const isNew = session.isNew === '1' || session.isNew === true;
            const result = await moneroRpc.submitSignedTransfer(signedTxset, {
                address: session.address,
                viewkey: session.viewkey,
                restoreHeight: session.restoreHeight,
                isNew
            });

            if (result.status === 'OK') {
                if (result.txid) {
                    await sessionManager.addPendingTx(session.sessionId, pendingRecord(txInfo, result.txid));
                }
                setTimeout(() => pushStateTo(session.address, 'broadcast').catch(() => {}), 500);
                return sendJson(res, 200, {
                    status: 'OK',
                    txid: result.txid,
                    tx_hash_list: result.tx_hash_list
                });
            }

            return sendJson(res, 500, {
                status: 'Failed',
                reason: result.reason || 'Failed to broadcast signed transaction'
            });
        }

        // 10c. SWAP: any supported coin <-> XMR, open to everyone. Forwarded to the swap gateway
        // configured with SWAP_GATEWAY_URL / SWAP_GATEWAY_KEY (docs/swap-gateway-api.md). Orders are
        // tracked with the order token the browser keeps; when a wallet is open the token is also
        // stored under the wallet address so the order shows up again from another browser.
        if (pathname.startsWith('/api/swap/')) {
            // Everything here is forwarded to the configured swap gateway (docs/swap-gateway-api.md).
            // Only documented fields leave this server; the browser stays same-origin.
            const limited = tooMany;
            const reply = (out) => {
                if (out.body && out.body.retry_after) res.setHeader('Retry-After', String(out.body.retry_after));
                return sendJson(res, out.http, out.body);
            };

            if (pathname.startsWith('/api/swap/logo/')) {
                const logo = await swapClient.getLogo(pathname.slice('/api/swap/logo/'.length));
                if (!logo) { res.writeHead(404); return res.end(); }
                // Third-party images re-served from our origin: sandboxed in case one is ever opened directly.
                res.writeHead(200, { 'Content-Type': logo.type, 'Content-Length': logo.body.length, 'Cache-Control': 'public, max-age=86400', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
                return res.end(logo.body);
            }
            if (pathname === '/api/swap/config') {
                if (limited('swap_config', 600, 60000)) return;
                return sendJson(res, 200, await swapClient.publicConfig());
            }
            if (!swapClient.enabled()) {
                return sendJson(res, 503, { status: 'Failed', code: 'unavailable', reason: 'Swaps are not available on this server.' });
            }

            if (pathname === '/api/swap/quote') {
                if (limited('swap_quote', 120, 60000)) return;
                return reply(await swapClient.quote({ from: String(body.from || '').slice(0, 32), to: String(body.to || '').slice(0, 32), amount: String(body.amount || '').slice(0, 40), toAddress: String(body.to_address || '').trim().slice(0, 256) || null }));
            }

            // Optional wallet session: lets the order be found again from any browser.
            const session = body.session_id ? await resolveSession(body, query, req.headers) : null;

            if (pathname === '/api/swap/create') {
                if (limited('swap_create', 10, 60000)) return;
                const out = await swapClient.createOrder({
                    from: String(body.from || '').slice(0, 32), to: String(body.to || '').slice(0, 32), amount: String(body.amount || '').slice(0, 40),
                    toAddress: String(body.to_address || '').trim().slice(0, 256),
                    refundAddress: String(body.refund_address || '').trim().slice(0, 256)
                });
                if (out.http !== 200 || !out.body.order || !swapClient.TOKEN_RE.test(String(out.body.order_token || ''))) return reply(out.http === 200 ? { http: 503, body: { status: 'Failed', code: 'unavailable', reason: 'The swap service answered unexpectedly. Please try again.' } } : out);
                const stored = swapClient.storedRecordFrom(out.body);
                if (session && stored.orderId) {
                    try { await sessionManager.addSwapOrder(session.address, stored); } catch (e) { console.error('[swap] could not store order', stored.orderId, e.message); }
                }
                console.log(`[swap] order ${stored.orderId}: ${stored.depositAmountHuman} ${stored.fromSymbol} -> ${stored.toSymbol}${session ? ' for ' + session.address.slice(0, 8) + '…' : ' (guest)'}`);
                const view = out.body.order;
                view.swap_session = out.body.order_token; // the browser keeps this to track its order
                view.history = swapClient.historyRow(stored);
                return sendJson(res, 200, view);
            }

            if (pathname === '/api/swap/orders') {
                if (limited('swap_read', 600, 60000)) return;
                if (!session) return sendJson(res, 200, { status: 'OK', orders: [] });
                const list = await sessionManager.listSwapOrders(session.address);
                return sendJson(res, 200, { status: 'OK', orders: list.map(swapClient.historyRow) });
            }

            const orderId = String(body.order_id || '').trim();
            if (!swapClient.ORDER_ID_RE.test(orderId)) {
                return sendJson(res, 400, { status: 'Failed', code: 'invalid_request', reason: 'Invalid order id' });
            }
            // Credential precedence for READS: the order token the browser holds, then the
            // wallet's stored token, then the destination-address proof. ACTIONS (refund /
            // payout address, close wait) need the browser-held token: a wallet session is
            // proven by the view key alone, and a view key must not be enough to redirect a payout.
            let ownerToken = String(body.swap_session || '').trim();
            if (ownerToken && !swapClient.TOKEN_RE.test(ownerToken)) ownerToken = '';
            const stored = session ? await sessionManager.getSwapOrder(session.address, orderId) : null;
            const token = ownerToken || (stored && stored.orderToken) || '';

            if (pathname === '/api/swap/order') {
                if (limited('swap_read', 600, 60000)) return;
                const verify = String(body.verify_address || '').trim();
                if (!token && !/^[A-Za-z0-9:_-]{10,256}$/.test(verify)) {
                    return sendJson(res, 404, { status: 'Failed', code: 'not_found', reason: 'This swap could not be found. Enter its order id and the receiving address.' });
                }
                const out = await swapClient.readOrder(orderId, token ? { token } : { verify });
                if (out.http !== 200) return reply(out);
                const view = out.body;
                if (stored) {
                    const kind = (view.customer_state && view.customer_state.kind) || view.order_status;
                    if (kind !== stored.kind || view.order_status !== stored.status) {
                        sessionManager.updateSwapOrder(session.address, orderId, { kind, status: view.order_status }).catch(() => {});
                    }
                }
                view.read_only = !ownerToken;
                return sendJson(res, 200, view);
            }

            const actions = { '/api/swap/order/close-wait': 'close-wait', '/api/swap/order/refund-address': 'refund-address', '/api/swap/order/payout-address': 'payout-address' };
            if (actions[pathname]) {
                if (limited('swap_action', 60, 60000)) return;
                if (!ownerToken) return sendJson(res, 403, { status: 'Failed', code: 'forbidden', reason: 'Only the browser that created this swap can change it.' });
                const address = String(body.address || '').trim();
                if (actions[pathname] !== 'close-wait' && !/^[A-Za-z0-9:_-]{10,256}$/.test(address)) {
                    return sendJson(res, 400, { status: 'Failed', code: 'invalid_request', reason: 'Enter a valid address.' });
                }
                return reply(await swapClient.orderAction(actions[pathname], orderId, ownerToken, address));
            }

            return sendJson(res, 404, { status: 'Failed', reason: 'Unknown swap route' });
        }

        // 10b. RESERVE NEXT SUBADDRESS INDEX (derivation itself happens in the browser)
        if (pathname === '/api/subaddress-next') {
            const session = await resolveSession(body, query, req.headers);
            if (!session) {
                return sendJson(res, 401, { status: 'Failed', reason: 'Invalid or expired session' });
            }
            const index = await sessionManager.nextSubaddressIndex(session.address);
            if (!index || index > 199) {
                // wallet-rpc's default lookahead is 200 minor indices; beyond that payments would
                // not be detected without reconfiguring the instances.
                return sendJson(res, 409, { status: 'Failed', reason: 'Subaddress limit reached (199 per wallet)' });
            }
            return sendJson(res, 200, { status: 'OK', index });
        }

        // 12. LOGOUT
        if (pathname === '/api/logout') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            const sessionId = body && body.session_id;
            if (sessionId) {
                await sessionManager.destroySession(String(sessionId));
                // A stream opened with this session must not keep receiving balances after logout.
                for (const [addr, set] of subscribers) {
                    for (const sub of set) {
                        if (sub.session && sub.session.sessionId === String(sessionId)) {
                            set.delete(sub);
                            try { sub.res.end(); } catch (e) {}
                        }
                    }
                    if (set.size === 0) subscribers.delete(addr);
                }
            }
            return res.end('1:Logged out');
        }

        // Page routes (SEO): the app shell with per-page title/description/canonical.
        if (req.method === 'GET' || req.method === 'HEAD') {
            const routePath = SEO_ALIASES[pathname] || SEO_SILENT[pathname] || pathname;
            if (SEO_ALIASES[pathname]) {
                res.writeHead(301, { 'Location': routePath + (parsedUrl.search || '') });
                return res.end();
            }
            if (SEO_PAGES[routePath]) {
                return serveAppPage(req, res, routePath);
            }
            if (pathname === '/robots.txt') {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
                return res.end(robotsTxt());
            }
            if (pathname === '/sitemap.xml') {
                res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
                return res.end(sitemapXml());
            }
        }

        // Default: Serve static files from public/
        await serveStatic(req, res, pathname);
    } catch (err) {
        console.error(`[server] Unhandled error on ${req.method} ${pathname}:`, err);
        if (!res.headersSent) {
            sendJson(res, 500, { status: 'Failed', reason: 'Internal server error' });
        } else {
            res.end();
        }
    }
});

// Graceful shutdown: flush open wallets to disk before the process exits.
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received: storing open wallets before exit`);
    const guard = setTimeout(() => process.exit(0), 25000);
    try { await moneroRpc.storeAllOpenWallets(20000); } catch (e) {}
    clearTimeout(guard);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Long-lived event streams: Node would otherwise close every request after 300 s.
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 61000;

if (swapClient.enabled()) {
    swapClient.publicConfig().then(c => console.log(`[swap] gateway ${c.enabled ? 'ok' : 'disabled'}${c.name ? ' (' + c.name + ')' : ''}, ${c.assets.length} assets, key ${config.swapGatewayKey ? 'configured' : 'not configured'}`)).catch(() => {});
}

// Wallet placements must be known before the first request, or a wallet could be opened on its
// hash instance while another process still holds the same file.
moneroRpc.ready.then(() => server.listen(config.port, '0.0.0.0', () => {
    console.log(`[XmrNest] Monero Web Wallet API running on port ${config.port}`);
    console.log(`[XmrNest] Serving static UI from: ${config.publicDir}`);
    console.log(`[XmrNest] Daemon URL: ${config.daemonUrl}`);
    console.log(`[XmrNest] Wallet RPC URL: ${config.walletRpcUrl}`);
}));

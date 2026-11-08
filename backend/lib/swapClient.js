/**
 * Thin client for a swap gateway (docs/swap-gateway-api.md). The wallet never talks to a
 * liquidity provider itself: the swap page's requests are forwarded to the gateway named by
 * SWAP_GATEWAY_URL, authenticated with the instance key SWAP_GATEWAY_KEY.
 *
 * Rules (section 9 of the contract):
 *   - only documented fields leave this server: no client headers, no wallet address, no
 *     session id, nothing that could identify a user;
 *   - the instance key is read once and never appears in responses, logs or errors;
 *   - logos are re-served from this origin so the browser stays same-origin;
 *   - an unreachable or slow gateway is reported as 503 "unavailable".
 */
const config = require('./config');

const TIMEOUT_MS = 20000;
const CREATE_TIMEOUT_MS = 30000;
const CONFIG_CACHE_MS = 60000;
const LOGO_MAX_BYTES = 400 * 1024;
const LOGO_RE = /^(coin|chain)-[A-Za-z0-9]{1,16}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const ORDER_ID_RE = /^[A-Za-z0-9:_-]{1,128}$/;

const UNAVAILABLE = { status: 'Failed', code: 'unavailable', reason: 'The swap service is temporarily unavailable. Please try again in a minute.' };
const DISABLED_CONFIG = { status: 'OK', enabled: false, name: null, terms_url: null, fee_percent: 0, coins: [], chains: [], assets: [] };

let configCache = { at: 0, body: null };
const logos = new Map(); // name -> { at, logo: {type, body} | null }

function enabled() {
    return Boolean(config.swapGatewayUrl);
}

async function gatewayFetch(method, path, { body = null, headers = null, timeoutMs = TIMEOUT_MS, raw = false } = {}) {
    if (!enabled()) return { http: 503, body: UNAVAILABLE };
    const h = { 'Accept': raw ? 'image/*' : 'application/json', ...(headers || {}) };
    if (config.swapGatewayKey) h['Authorization'] = `Bearer ${config.swapGatewayKey}`;
    if (body) h['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(`${config.swapGatewayUrl}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, redirect: 'manual' });
        if (raw) {
            if (!r.ok) return { http: r.status, body: null };
            const type = (r.headers.get('content-type') || '').split(';')[0].trim();
            const buf = Buffer.from(await r.arrayBuffer());
            return { http: 200, body: (buf.length && buf.length <= LOGO_MAX_BYTES && /^image\/(png|jpeg|svg\+xml|webp|gif)$/.test(type)) ? { type, body: buf } : null };
        }
        let data = null;
        try { data = await r.json(); } catch (e) { data = null; }
        if (!data || typeof data !== 'object') return { http: 503, body: UNAVAILABLE };
        if (r.status >= 400 && data.status !== 'Failed') return { http: 503, body: UNAVAILABLE };
        const retryAfter = parseInt(r.headers.get('retry-after') || '0', 10) || 0;
        if (retryAfter && data.status === 'Failed' && !data.retry_after) data.retry_after = retryAfter;
        return { http: r.ok ? 200 : r.status, body: data };
    } catch (err) {
        // never echo the URL or key; the reason is a fixed sentence
        console.error(`[swap] gateway ${method} ${path.split('?')[0]} failed: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        return { http: 503, body: UNAVAILABLE };
    } finally {
        clearTimeout(timer);
    }
}

/** GET /v1/config, cached 60 s, logo names rewritten to this origin. */
async function publicConfig() {
    if (!enabled()) return DISABLED_CONFIG;
    if (configCache.body && Date.now() - configCache.at < CONFIG_CACHE_MS) return configCache.body;
    const out = await gatewayFetch('GET', '/v1/config', { timeoutMs: 10000 });
    if (out.http !== 200 || out.body.status !== 'OK') return configCache.body || { ...DISABLED_CONFIG, enabled: false };
    const c = out.body;
    const logoUrl = (name) => (typeof name === 'string' && LOGO_RE.test(name)) ? `/api/swap/logo/${name}` : null;
    const view = {
        status: 'OK',
        enabled: c.enabled !== false,
        name: typeof c.name === 'string' ? c.name.slice(0, 40) : null,
        fee_percent: typeof c.fee_percent === 'number' ? c.fee_percent : 0,
        terms_url: (typeof c.terms_url === 'string' && /^https:\/\/[^\s"'<>]{1,200}$/.test(c.terms_url)) ? c.terms_url : null,
        coins: (Array.isArray(c.coins) ? c.coins : []).slice(0, 100).map(x => ({ symbol: String(x.symbol || '').slice(0, 16), name: String(x.name || '').slice(0, 40), logo: logoUrl(x.logo) })),
        chains: (Array.isArray(c.chains) ? c.chains : []).slice(0, 100).map(x => ({ key: String(x.key || '').slice(0, 16), name: String(x.name || '').slice(0, 40), family: String(x.family || '').slice(0, 8), logo: logoUrl(x.logo) })),
        assets: (Array.isArray(c.assets) ? c.assets : []).slice(0, 200).map(a => ({
            key: String(a.key || '').slice(0, 32), coin: String(a.coin || '').slice(0, 16), chain: String(a.chain || '').slice(0, 16),
            decimals: Number.isInteger(a.decimals) ? a.decimals : 0, note: typeof a.note === 'string' ? a.note.slice(0, 40) : null,
            can_send: Boolean(a.can_send), can_receive: Boolean(a.can_receive),
            price_usd: (typeof a.price_usd === 'number' && Number.isFinite(a.price_usd)) ? a.price_usd : null
        }))
    };
    configCache = { at: Date.now(), body: view };
    return view;
}

/** Logo bytes for /api/swap/logo/<name>, fetched once from the gateway; null when unknown. */
async function getLogo(name) {
    if (!enabled() || !LOGO_RE.test(String(name))) return null;
    const hit = logos.get(name);
    if (hit && (hit.logo || Date.now() - hit.at < 300000)) return hit.logo;
    const out = await gatewayFetch('GET', `/v1/logos/${name}`, { raw: true, timeoutMs: 10000 });
    const logo = out.http === 200 ? out.body : null;
    logos.set(name, { at: Date.now(), logo });
    if (logos.size > 500) logos.delete(logos.keys().next().value);
    return logo;
}

function quote({ from, to, amount, toAddress }) {
    return gatewayFetch('POST', '/v1/quote', { body: { from, to, amount, to_address: toAddress || '' } });
}

/** Returns { http, body: { order_token, order, history } } on success. */
function createOrder({ from, to, amount, toAddress, refundAddress }) {
    return gatewayFetch('POST', '/v1/orders', { body: { from, to, amount, to_address: toAddress, refund_address: refundAddress || '' }, timeoutMs: CREATE_TIMEOUT_MS });
}

function readOrder(orderId, { token, verify }) {
    if (!ORDER_ID_RE.test(String(orderId || ''))) return Promise.resolve({ http: 400, body: { status: 'Failed', code: 'invalid_request', reason: 'Invalid order id' } });
    const headers = {};
    if (token && TOKEN_RE.test(token)) headers['X-Order-Token'] = token;
    else if (verify) headers['X-Verify-Address'] = verify;
    return gatewayFetch('GET', `/v1/orders/${encodeURIComponent(orderId)}`, { headers });
}

function orderAction(action, orderId, token, address) {
    if (!ORDER_ID_RE.test(String(orderId || '')) || !TOKEN_RE.test(String(token || ''))) return Promise.resolve({ http: 400, body: { status: 'Failed', code: 'invalid_request', reason: 'Invalid order' } });
    return gatewayFetch('POST', `/v1/orders/${encodeURIComponent(orderId)}/actions/${action}`, { headers: { 'X-Order-Token': token }, body: address ? { address } : {} });
}

/** What the wallet stores per signed-in order: the gateway's history row plus the token. */
function storedRecordFrom(created) {
    const h = (created && created.history && typeof created.history === 'object') ? created.history : {};
    const o = (created && created.order && typeof created.order === 'object') ? created.order : {};
    const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);
    return {
        orderId: s(o.order_id || h.order_id, 128),
        orderToken: s(created.order_token, 128),
        createdAt: Date.now(),
        fromSymbol: s(h.from_symbol, 16), toSymbol: s(h.to_symbol, 16),
        fromChain: s(h.from_chain, 16), toChain: s(h.to_chain, 16),
        depositAmountHuman: s(h.deposit_amount_human, 64), expectedOutputHuman: s(h.expected_output_human, 64),
        status: s(h.order_status || o.order_status, 32),
        kind: s(h.kind || (o.customer_state && o.customer_state.kind), 32),
        expiresAt: s(h.expires_at || o.expires_at, 64)
    };
}

/** History row shown in the wallet's swap list (never includes the token). */
function historyRow(rec) {
    return {
        order_id: rec.orderId, created_at: rec.createdAt,
        from_symbol: rec.fromSymbol, to_symbol: rec.toSymbol || 'XMR',
        from_chain: rec.fromChain || null, to_chain: rec.toChain || null,
        deposit_amount_human: rec.depositAmountHuman || null, expected_output_human: rec.expectedOutputHuman || null,
        order_status: rec.status, kind: rec.kind, expires_at: rec.expiresAt || null
    };
}

module.exports = { enabled, publicConfig, getLogo, quote, createOrder, readOrder, orderAction, storedRecordFrom, historyRow, ORDER_ID_RE, TOKEN_RE };

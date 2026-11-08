/**
 * Sliding-window limiter. By policy this server never looks at client IP addresses, so the
 * `scope` is either 'global' (one budget for the whole site) or an opaque token the client
 * already holds (a session id). Nothing here is persisted or logged.
 */
const buckets = new Map();

function rateLimit(scope, name, limit, windowMs) {
    const key = `${scope || 'global'}|${name}`;
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= limit) {
        buckets.set(key, arr);
        return Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
    }
    arr.push(now);
    buckets.set(key, arr);
    if (buckets.size > 5000) {
        for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
    }
    return 0;
}

module.exports = { rateLimit };

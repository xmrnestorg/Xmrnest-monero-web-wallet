/**
 * Proof-of-work gate for NEW wallets (addresses this server has never seen).
 *
 * Policy: the server never looks at IP addresses, so it cannot tell one visitor from a flood.
 * Instead, creating a new wallet file costs the browser a small keccak puzzle: a fraction of a
 * second for one user, but a flood of thousands of fake wallets has to pay that price for each
 * one, and the puzzle gets harder automatically while many new wallets are being created.
 * Real users are never refused; at worst they wait a little longer during an attack.
 *
 * Puzzle: find `nonce` (8 hex chars) such that keccak256(challenge || address || nonce) starts
 * with `bits` zero bits. Challenges are random, single-use and expire after 10 minutes.
 */
const crypto = require('crypto');
const { keccak256 } = require('./moneroKeys');
const config = require('./config');

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_OPEN_CHALLENGES = 20000;
const challenges = new Map(); // challengeHex -> { address, bits, expires }
const recentNewWallets = [];  // timestamps of new wallet creations (last hour)

function pruneRecent() {
    const cutoff = Date.now() - 3600000;
    while (recentNewWallets.length && recentNewWallets[0] < cutoff) recentNewWallets.shift();
}

/** New wallets created in the last hour (drives the adaptive difficulty). */
function newWalletsLastHour() {
    pruneRecent();
    return recentNewWallets.length;
}

/**
 * Difficulty in leading zero bits. Base (~65k hashes, well under a second on a laptop, a couple
 * of seconds on a phone) plus one bit for every `powStepWallets` new wallets in the last hour,
 * capped so a legitimate user still gets through during a flood.
 */
function currentBits() {
    const extra = Math.floor(newWalletsLastHour() / Math.max(1, config.powStepWallets));
    return Math.min(config.powBaseBits + config.powMaxExtraBits, config.powBaseBits + extra);
}

function issueChallenge(address) {
    if (challenges.size >= MAX_OPEN_CHALLENGES) {
        const now = Date.now();
        for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
        while (challenges.size >= MAX_OPEN_CHALLENGES) challenges.delete(challenges.keys().next().value);
    }
    const challenge = crypto.randomBytes(16).toString('hex');
    const bits = currentBits();
    challenges.set(challenge, { address, bits, expires: Date.now() + CHALLENGE_TTL_MS });
    return { challenge, bits };
}

function leadingZeroBits(buf) {
    let n = 0;
    for (const b of buf) {
        if (b === 0) { n += 8; continue; }
        n += Math.clz32(b) - 24;
        break;
    }
    return n;
}

/** Hash exactly as the browser does: keccak256 over the raw bytes of challenge+address+nonce hex. */
function hashFor(challenge, address, nonceHex) {
    const addrHex = Buffer.from(address, 'utf8').toString('hex');
    return keccak256(Buffer.from(challenge + addrHex + nonceHex, 'hex'));
}

/** Validates and consumes a solution. Returns null on success, or a reason string. */
function verify(challenge, address, nonceHex) {
    if (!/^[0-9a-f]{32}$/.test(String(challenge || ''))) return 'bad challenge';
    if (!/^[0-9a-f]{8}$/.test(String(nonceHex || ''))) return 'bad nonce';
    const entry = challenges.get(challenge);
    if (!entry) return 'unknown or already used challenge';
    challenges.delete(challenge); // single use, success or not
    if (entry.expires < Date.now()) return 'challenge expired';
    if (entry.address !== address) return 'challenge was issued for another address';
    if (leadingZeroBits(hashFor(challenge, address, nonceHex)) < entry.bits) return 'solution does not meet the difficulty';
    return null;
}

function recordNewWallet() {
    pruneRecent();
    recentNewWallets.push(Date.now());
}

/** Reference solver (used by tests; the browser has its own). */
function solve(challenge, address, bits) {
    for (let n = 0; n < 0xffffffff; n++) {
        const nonce = n.toString(16).padStart(8, '0');
        if (leadingZeroBits(hashFor(challenge, address, nonce)) >= bits) return nonce;
    }
    return null;
}

module.exports = { issueChallenge, verify, recordNewWallet, newWalletsLastHour, currentBits, solve, hashFor, leadingZeroBits };

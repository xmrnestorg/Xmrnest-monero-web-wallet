/**
 * Monero key / address helpers (pure Node.js, zero dependencies).
 *
 * Used by the API to prove that a caller who presents an address + private view key
 * actually owns that view key: the public view key embedded in the address must equal
 * viewkey * G on Ed25519. Without this check anyone who knows a public address could
 * open the existing watch-only wallet on the server and read its balance/history.
 */

// ---------------------------------------------------------------------------
// Keccak-256 (original Keccak padding, as used by CryptoNote cn_fast_hash)
// ---------------------------------------------------------------------------
const KECCAK_RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const KECCAK_ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14]
];
const MASK64 = (1n << 64n) - 1n;

function rotl64(x, n) {
    n = n % 64;
    if (n === 0) return x;
    return ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK64;
}

function keccakF(state) {
    for (let round = 0; round < 24; round++) {
        // theta
        const c = new Array(5);
        for (let x = 0; x < 5; x++) {
            c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        }
        for (let x = 0; x < 5; x++) {
            const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
            for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
        }
        // rho + pi
        const b = new Array(25);
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], KECCAK_ROT[x][y]);
            }
        }
        // chi
        for (let x = 0; x < 5; x++) {
            for (let y = 0; y < 5; y++) {
                state[x + 5 * y] = b[x + 5 * y] ^ ((~b[(x + 1) % 5 + 5 * y] & MASK64) & b[(x + 2) % 5 + 5 * y]);
            }
        }
        // iota
        state[0] ^= KECCAK_RC[round];
    }
}

function keccak256(bytes) {
    const rate = 136;
    const state = new Array(25).fill(0n);
    const padded = Buffer.alloc(Math.floor(bytes.length / rate) * rate + rate);
    padded.set(bytes, 0);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;

    for (let off = 0; off < padded.length; off += rate) {
        for (let i = 0; i < rate / 8; i++) {
            state[i] ^= padded.readBigUInt64LE(off + i * 8);
        }
        keccakF(state);
    }

    const out = Buffer.alloc(32);
    for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
    return out;
}

// ---------------------------------------------------------------------------
// Monero base58 (8-byte blocks -> 11 chars, last partial block shorter)
// ---------------------------------------------------------------------------
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_FULL_BLOCK = 8;
const B58_FULL_ENC = 11;
const B58_ENC_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];

function decodeBlock(str) {
    let num = 0n;
    for (const ch of str) {
        const idx = B58_ALPHABET.indexOf(ch);
        if (idx < 0) throw new Error('invalid base58 character');
        num = num * 58n + BigInt(idx);
    }
    const size = B58_ENC_SIZES.indexOf(str.length);
    if (size < 0) throw new Error('invalid base58 block size');
    if (num >= (1n << BigInt(8 * size))) throw new Error('base58 block overflow');
    const out = Buffer.alloc(size);
    for (let i = size - 1; i >= 0; i--) {
        out[i] = Number(num & 0xffn);
        num >>= 8n;
    }
    return out;
}

function base58Decode(str) {
    const fullBlocks = Math.floor(str.length / B58_FULL_ENC);
    const lastLen = str.length % B58_FULL_ENC;
    const parts = [];
    for (let i = 0; i < fullBlocks; i++) {
        parts.push(decodeBlock(str.slice(i * B58_FULL_ENC, (i + 1) * B58_FULL_ENC)));
    }
    if (lastLen > 0) parts.push(decodeBlock(str.slice(fullBlocks * B58_FULL_ENC)));
    return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------
const MAINNET_PREFIXES = {
    18: 'standard',
    19: 'integrated',
    42: 'subaddress'
};

function readVarint(buf) {
    let value = 0n;
    let shift = 0n;
    let i = 0;
    while (i < buf.length) {
        const b = buf[i++];
        value |= BigInt(b & 0x7f) << shift;
        if ((b & 0x80) === 0) return { value: Number(value), length: i };
        shift += 7n;
    }
    throw new Error('truncated varint');
}

/**
 * Decode a mainnet Monero address. Returns null when invalid (bad base58, prefix, length or checksum).
 * @returns {{type: string, spendPub: Buffer, viewPub: Buffer, paymentId: Buffer|null}|null}
 */
function decodeAddress(address) {
    try {
        if (typeof address !== 'string') return null;
        const raw = base58Decode(address);
        const { value: prefix, length: plen } = readVarint(raw);
        const type = MAINNET_PREFIXES[prefix];
        if (!type) return null;

        const expectedLen = plen + 64 + (type === 'integrated' ? 8 : 0) + 4;
        if (raw.length !== expectedLen) return null;

        const body = raw.subarray(0, raw.length - 4);
        const checksum = raw.subarray(raw.length - 4);
        if (!keccak256(body).subarray(0, 4).equals(checksum)) return null;

        return {
            type,
            spendPub: raw.subarray(plen, plen + 32),
            viewPub: raw.subarray(plen + 32, plen + 64),
            paymentId: type === 'integrated' ? raw.subarray(plen + 64, plen + 72) : null
        };
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Ed25519 (BigInt) - only what is needed: scalar * basepoint and point encoding
// ---------------------------------------------------------------------------
const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(a, m = P) {
    const r = a % m;
    return r >= 0n ? r : r + m;
}

function modPow(base, exp, m = P) {
    let result = 1n;
    base = mod(base, m);
    while (exp > 0n) {
        if (exp & 1n) result = (result * base) % m;
        base = (base * base) % m;
        exp >>= 1n;
    }
    return result;
}

function modInv(a) {
    return modPow(a, P - 2n);
}

const D = mod(-121665n * modInv(121666n));
const BASE = {
    x: 15112221349535400772501151409588531511454012693041857206046113283949847762202n,
    y: 46316835694926478169428394003475163141307993866256225615783033603165251855960n
};

// Extended coordinates (X, Y, Z, T) with x = X/Z, y = Y/Z, xy = T/Z
function pointAdd(p1, p2) {
    const A = mod((p1.y - p1.x) * (p2.y - p2.x));
    const B = mod((p1.y + p1.x) * (p2.y + p2.x));
    const C = mod(2n * p1.t * p2.t * D);
    const Dd = mod(2n * p1.z * p2.z);
    const E = B - A;
    const F = Dd - C;
    const G = Dd + C;
    const H = B + A;
    return { x: mod(E * F), y: mod(G * H), z: mod(F * G), t: mod(E * H) };
}

function scalarMultBase(scalar) {
    let result = { x: 0n, y: 1n, z: 1n, t: 0n };
    let addend = { x: BASE.x, y: BASE.y, z: 1n, t: mod(BASE.x * BASE.y) };
    while (scalar > 0n) {
        if (scalar & 1n) result = pointAdd(result, addend);
        addend = pointAdd(addend, addend);
        scalar >>= 1n;
    }
    return result;
}

function encodePoint(pt) {
    const zinv = modInv(pt.z);
    const x = mod(pt.x * zinv);
    const y = mod(pt.y * zinv);
    const out = Buffer.alloc(32);
    let yy = y;
    for (let i = 0; i < 32; i++) {
        out[i] = Number(yy & 0xffn);
        yy >>= 8n;
    }
    if (x & 1n) out[31] |= 0x80;
    return out;
}

function scalarFromHexLE(hex) {
    const buf = Buffer.from(hex, 'hex');
    let s = 0n;
    for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(buf[i]);
    return s;
}

/**
 * Compute the Ed25519 public key (hex) for a 32-byte little-endian secret scalar (hex).
 * Returns null if the scalar is not a valid reduced non-zero scalar.
 */
function secretToPublic(secretHex) {
    if (typeof secretHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(secretHex)) return null;
    const s = scalarFromHexLE(secretHex);
    if (s === 0n || s >= L) return null;
    return encodePoint(scalarMultBase(s)).toString('hex');
}

/**
 * True iff `viewkeyHex` is the private view key of `address` (standard mainnet address).
 */
function verifyViewKey(address, viewkeyHex) {
    const decoded = decodeAddress(address);
    if (!decoded || decoded.type !== 'standard') return false;
    const pub = secretToPublic(viewkeyHex);
    if (!pub) return false;
    return pub === decoded.viewPub.toString('hex');
}

module.exports = {
    keccak256,
    base58Decode,
    decodeAddress,
    secretToPublic,
    verifyViewKey
};

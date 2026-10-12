// Obsidia client-side crypto.
// Everything zero-knowledge happens here, in the browser, before anything
// touches the server. The server only ever sees ciphertext.
//
// Scheme:
//   - PBKDF2-SHA256, 100 000 iterations, 16-byte salt per user
//   - 64 bytes derived; split into (auth_key[0:32], enc_key[32:64])
//   - auth_key is sent to the server (which bcrypts it) as proof-of-passphrase
//   - enc_key never leaves the browser; held in sessionStorage while the tab
//     is open, dropped when the tab closes
//   - AES-256-GCM with 12-byte random IV; IV prepended to every ciphertext

(function () {
'use strict';

const PBKDF2_ITERS = 100000;

const b64 = {
    enc(bytes) {
        let s = '';
        const view = new Uint8Array(bytes);
        for (let i = 0; i < view.length; i++) s += String.fromCharCode(view[i]);
        return btoa(s);
    },
    dec(str) {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
};

async function deriveKeys(passphrase, saltB64) {
    const salt = b64.dec(saltB64);
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(passphrase),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
        baseKey,
        512
    );
    const buf = new Uint8Array(bits);
    const authBytes = buf.slice(0, 32);
    const encBytes = buf.slice(32, 64);

    const encKey = await crypto.subtle.importKey(
        'raw', encBytes, 'AES-GCM', true, ['encrypt', 'decrypt']
    );
    return { authKeyB64: b64.enc(authBytes), encKey, encKeyRawB64: b64.enc(encBytes) };
}

async function importEncKey(encKeyRawB64) {
    return await crypto.subtle.importKey(
        'raw', b64.dec(encKeyRawB64), 'AES-GCM', true, ['encrypt', 'decrypt']
    );
}

async function encryptBytes(encKey, plainBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        encKey,
        plainBytes
    );
    // Output = iv (12) || ciphertext
    const ctView = new Uint8Array(ct);
    const out = new Uint8Array(iv.length + ctView.length);
    out.set(iv, 0);
    out.set(ctView, iv.length);
    return out;
}

async function decryptBytes(encKey, ivAndCt) {
    const data = ivAndCt instanceof Uint8Array ? ivAndCt : new Uint8Array(ivAndCt);
    if (data.length < 13) throw new Error('Ciphertext too short');
    const iv = data.slice(0, 12);
    const ct = data.slice(12);
    const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        encKey,
        ct
    );
    return new Uint8Array(pt);
}

async function encryptString(encKey, str) {
    const bytes = new TextEncoder().encode(str);
    const ct = await encryptBytes(encKey, bytes);
    return b64.enc(ct);
}

async function decryptString(encKey, ctB64) {
    const bytes = await decryptBytes(encKey, b64.dec(ctB64));
    return new TextDecoder().decode(bytes);
}

// Session key management: stash the derived enc_key in sessionStorage so
// a page refresh doesn't log the user out, but closing the tab locks
// the vault again.

const SESSION_KEY_FIELD = 'obsidia_enc_key';

function stashEncKey(encKeyRawB64) {
    sessionStorage.setItem(SESSION_KEY_FIELD, encKeyRawB64);
}

async function loadEncKey() {
    const raw = sessionStorage.getItem(SESSION_KEY_FIELD);
    if (!raw) return null;
    return await importEncKey(raw);
}

function dropEncKey() {
    sessionStorage.removeItem(SESSION_KEY_FIELD);
}

window.ObsidiaCrypto = {
    deriveKeys,
    importEncKey,
    encryptBytes,
    decryptBytes,
    encryptString,
    decryptString,
    stashEncKey,
    loadEncKey,
    dropEncKey,
    b64
};

})();

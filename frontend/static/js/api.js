// Thin fetch wrapper for the Obsidia API.
// Token + email + salt kept in localStorage; the derived encryption key
// is NEVER stored here (it lives in sessionStorage via crypto.js).

(function () {
'use strict';

const TOKEN_FIELD = 'obsidia_token';
const EMAIL_FIELD = 'obsidia_email';
const SALT_FIELD = 'obsidia_salt';
const PLAN_FIELD = 'obsidia_plan';

const Session = {
    get token() { return localStorage.getItem(TOKEN_FIELD); },
    get email() { return localStorage.getItem(EMAIL_FIELD); },
    get salt()  { return localStorage.getItem(SALT_FIELD); },
    get plan()  { return localStorage.getItem(PLAN_FIELD) || 'free'; },

    save({ token, email, salt, plan }) {
        if (token) localStorage.setItem(TOKEN_FIELD, token);
        if (email) localStorage.setItem(EMAIL_FIELD, email);
        if (salt)  localStorage.setItem(SALT_FIELD, salt);
        if (plan)  localStorage.setItem(PLAN_FIELD, plan);
    },
    setPlan(plan) { localStorage.setItem(PLAN_FIELD, plan); },
    clear() {
        localStorage.removeItem(TOKEN_FIELD);
        localStorage.removeItem(EMAIL_FIELD);
        localStorage.removeItem(SALT_FIELD);
        localStorage.removeItem(PLAN_FIELD);
        if (window.ObsidiaCrypto) window.ObsidiaCrypto.dropEncKey();
    },
    isAuthed() { return !!this.token; }
};

async function apiFetch(path, { method = 'GET', body, isForm = false, raw = false } = {}) {
    const headers = {};
    if (Session.token) headers['Authorization'] = `Bearer ${Session.token}`;
    if (body && !isForm) headers['Content-Type'] = 'application/json';

    const resp = await fetch(path, {
        method,
        headers,
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });

    if (resp.status === 401) {
        Session.clear();
        if (!path.startsWith('/api/auth/')) {
            window.location.href = '/login?expired=1';
            return;
        }
    }

    if (raw) return resp;

    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) {
        const msg = (data && data.detail) ? data.detail : `Request failed (${resp.status})`;
        throw new Error(msg);
    }
    return data;
}

const Api = {
    // auth
    async getSalt(email) {
        return apiFetch('/api/auth/salt', { method: 'POST', body: { email } });
    },
    async signup(email, saltB64, authKeyB64) {
        return apiFetch('/api/auth/signup',
            { method: 'POST', body: { email, salt: saltB64, auth_key: authKeyB64 } });
    },
    async login(email, authKeyB64) {
        return apiFetch('/api/auth/login',
            { method: 'POST', body: { email, auth_key: authKeyB64 } });
    },

    // user
    async me() { return apiFetch('/api/user/me'); },
    async upgrade() { return apiFetch('/api/user/upgrade', { method: 'POST' }); },
    async cancel()  { return apiFetch('/api/user/cancel',  { method: 'POST' }); },
    async deleteAccount() { return apiFetch('/api/user', { method: 'DELETE' }); },

    // folders
    async createFolder(encryptedName, parentId) {
        return apiFetch('/api/folders',
            { method: 'POST', body: { encrypted_name: encryptedName, parent_id: parentId } });
    },
    async deleteFolder(id) {
        return apiFetch(`/api/folders/${id}`, { method: 'DELETE' });
    },

    // files
    async listItems(folderId = null) {
        const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : '';
        return apiFetch(`/api/files${q}`);
    },
    async uploadFile(encryptedName, folderId, blob) {
        const fd = new FormData();
        fd.append('encrypted_name', encryptedName);
        if (folderId) fd.append('folder_id', folderId);
        fd.append('blob', blob);
        return apiFetch('/api/files', { method: 'POST', body: fd, isForm: true });
    },
    async downloadFile(id) {
        const resp = await apiFetch(`/api/files/${id}/download`, { raw: true });
        if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
        return new Uint8Array(await resp.arrayBuffer());
    },
    async deleteFile(id) {
        return apiFetch(`/api/files/${id}`, { method: 'DELETE' });
    },
    async restoreFile(id) {
        return apiFetch(`/api/files/${id}/restore`, { method: 'POST' });
    },
    async permanentDeleteFile(id) {
        return apiFetch(`/api/files/${id}/permanent`, { method: 'DELETE' });
    },
    async starFile(id, starred) {
        const q = `?starred=${starred ? 'true' : 'false'}`;
        return apiFetch(`/api/files/${id}/star${q}`, { method: 'POST' });
    },
    async listStarred() { return apiFetch('/api/starred'); },
    async listTrash()   { return apiFetch('/api/trash'); },
};

window.ObsidiaApi = Api;
window.ObsidiaSession = Session;

})();

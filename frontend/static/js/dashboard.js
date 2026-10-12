// Dashboard logic.
//
// Flow on load:
//   1. If no session token, bounce to /login.
//   2. If session exists but no derived enc_key (new tab, refresh after
//      sessionStorage cleared), show the unlock modal.
//   3. Otherwise, load the vault.

const { deriveKeys, loadEncKey, stashEncKey, dropEncKey,
        encryptBytes, decryptBytes, encryptString, decryptString, b64 }
      = window.ObsidiaCrypto;
const Api = window.ObsidiaApi;
const Session = window.ObsidiaSession;

// --- Custom modal (replaces window.confirm / window.prompt) ------

function uiConfirm({ title, body = '', okText = 'OK', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise(resolve => openUiModal({
        title, body, okText, cancelText, danger,
        showInput: false,
        onResolve: resolve,
    }));
}

function uiPrompt({ title, body = '', placeholder = '', defaultValue = '',
                     okText = 'OK', cancelText = 'Cancel' } = {}) {
    return new Promise(resolve => openUiModal({
        title, body, okText, cancelText, danger: false,
        showInput: true, placeholder, defaultValue,
        onResolve: resolve,
    }));
}

function openUiModal(opts) {
    const modal = document.getElementById('ui-modal');
    document.getElementById('ui-modal-title').textContent = opts.title || '';
    document.getElementById('ui-modal-body').textContent  = opts.body || '';

    const field = document.getElementById('ui-modal-field');
    const input = document.getElementById('ui-modal-input');
    // Use style.display explicitly: HTML's `hidden` attribute loses to
    // `.field { display: flex }` in the stylesheet.
    field.style.display = opts.showInput ? '' : 'none';
    if (opts.showInput) {
        input.placeholder = opts.placeholder || '';
        input.value = opts.defaultValue || '';
    }

    // Replace buttons with fresh clones to drop previous listeners.
    let okBtn = document.getElementById('ui-modal-ok');
    let cancelBtn = document.getElementById('ui-modal-cancel');
    const freshOk = okBtn.cloneNode(false);
    freshOk.textContent = opts.okText;
    freshOk.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    freshOk.id = 'ui-modal-ok';
    freshOk.type = 'button';
    okBtn.replaceWith(freshOk);
    okBtn = freshOk;

    const freshCancel = cancelBtn.cloneNode(false);
    freshCancel.textContent = opts.cancelText;
    freshCancel.className = 'btn btn-outline';
    freshCancel.id = 'ui-modal-cancel';
    freshCancel.type = 'button';
    cancelBtn.replaceWith(freshCancel);
    cancelBtn = freshCancel;

    let settled = false;
    const close = (result) => {
        if (settled) return;
        settled = true;
        modal.hidden = true;
        document.removeEventListener('keydown', keyHandler);
        opts.onResolve(result);
    };

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close(opts.showInput ? null : false);
        } else if (e.key === 'Enter' && opts.showInput) {
            // handled below on the input itself to grab the current value
        }
    };
    document.addEventListener('keydown', keyHandler);

    okBtn.addEventListener('click', () => {
        if (opts.showInput) {
            const v = (input.value || '').trim();
            close(v || null);
        } else {
            close(true);
        }
    });
    cancelBtn.addEventListener('click', () => {
        close(opts.showInput ? null : false);
    });

    if (opts.showInput) {
        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                okBtn.click();
            }
        };
    }

    modal.hidden = false;
    setTimeout(() => {
        if (opts.showInput) input.focus();
        else okBtn.focus();
    }, 50);
}


let ENC_KEY = null;
let CURRENT_FOLDER_ID = null;     // null = root
let BREADCRUMB = [{ id: null, name: 'All files' }];
let LAST_LISTING = { folders: [], files: [] };   // after decryption
let FILTER = '';
let VIEW = 'files';               // 'files' | 'starred' | 'trash' | 'security' | 'settings'
let LOCK_TIMER = null;


// --- Settings (persisted to localStorage per browser) --------------

const SETTINGS_KEY = 'obsidia_settings';
const DEFAULT_SETTINGS = {
    theme: 'dark',
    compact: false,
    dateStyle: 'relative',
    defaultView: 'files',
    lockTimer: '30',             // minutes, or 'never'
    encMode: 'zero',             // 'zero' | 'recoverable'
    notifSignin: false,
    notifBilling: true,
    notifTransparency: false,
};

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS,
                 ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}
function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}
function updateSetting(key, value) {
    const s = loadSettings();
    s[key] = value;
    saveSettings(s);
    applySetting(key, value);
}
function applySetting(key, value) {
    if (key === 'compact') {
        document.body.classList.toggle('compact', !!value);
    } else if (key === 'dateStyle') {
        if (VIEW === 'files' || VIEW === 'starred' || VIEW === 'trash') renderListing();
    } else if (key === 'lockTimer') {
        resetLockTimer();
    }
}
function applyAllSettings() {
    const s = loadSettings();
    document.body.classList.toggle('compact', !!s.compact);
}

// Vault auto-lock on inactivity.
function resetLockTimer() {
    if (LOCK_TIMER) { clearTimeout(LOCK_TIMER); LOCK_TIMER = null; }
    const s = loadSettings();
    if (s.lockTimer === 'never') return;
    const minutes = parseInt(s.lockTimer, 10);
    if (!minutes) return;
    LOCK_TIMER = setTimeout(() => {
        dropEncKey();
        ENC_KEY = null;
        toast('Vault locked for inactivity', 'ok');
        openUnlockModal();
    }, minutes * 60 * 1000);
}
function wireActivityForLockTimer() {
    ['click', 'keydown', 'scroll'].forEach(ev =>
        document.addEventListener(ev, resetLockTimer, { passive: true })
    );
}


// --- Boot ----------------------------------------------------------

window.addEventListener('DOMContentLoaded', async () => {
    if (!Session.isAuthed()) {
        window.location.href = '/login';
        return;
    }

    wireUI();

    ENC_KEY = await loadEncKey();
    if (!ENC_KEY) {
        openUnlockModal();
    } else {
        await bootDashboard();
    }
});


// --- Unlock modal --------------------------------------------------

function openUnlockModal() {
    document.getElementById('unlock-modal').hidden = false;
    document.getElementById('unlock-pass').focus();
    setEncIndicator(false);
}
function closeUnlockModal() {
    document.getElementById('unlock-modal').hidden = true;
}

function wireUnlockForm() {
    const form = document.getElementById('unlock-form');
    const err = document.getElementById('unlock-err');
    const btn = document.getElementById('unlock-submit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        const pass = document.getElementById('unlock-pass').value;
        if (!pass) return;
        btn.classList.add('loading');
        btn.disabled = true;
        try {
            const salt = Session.salt;
            if (!salt) throw new Error('No salt in session; please sign in again.');
            const { authKeyB64, encKeyRawB64, encKey } = await deriveKeys(pass, salt);
            // Verify the derived key by trying to log in with it.
            await Api.login(Session.email, authKeyB64);
            stashEncKey(encKeyRawB64);
            ENC_KEY = encKey;
            closeUnlockModal();
            setEncIndicator(true);
            await bootDashboard();
        } catch (ex) {
            err.textContent = ex.message || 'Could not unlock vault.';
            btn.classList.remove('loading');
            btn.disabled = false;
        }
    });
}


// --- Main boot sequence --------------------------------------------

async function bootDashboard() {
    try {
        applyAllSettings();   // compact mode class, etc.

        // Honor the "Default view" setting on first boot.
        const s = loadSettings();
        if (s.defaultView && s.defaultView !== 'files' && VIEW === 'files') {
            VIEW = s.defaultView;
            document.querySelectorAll('.sidebar .nav-list button')
                .forEach(b => b.classList.remove('active'));
            const navBtn = document.getElementById('nav-' + VIEW);
            if (navBtn) navBtn.classList.add('active');
        }

        resetLockTimer();
        await loadUser();
        await loadItems(CURRENT_FOLDER_ID);
    } catch (ex) {
        toast(ex.message || 'Failed to load vault', 'err');
    }
}

async function loadUser() {
    const me = await Api.me();
    const email = me.email;
    const initials = email.slice(0, 2).toUpperCase();
    document.getElementById('avatar').textContent = initials;
    document.getElementById('user-name').textContent = email.split('@')[0];
    document.getElementById('user-email').textContent = email;

    renderQuota(me);

    document.getElementById('file-count').textContent = me.file_count;
    document.getElementById('starred-count').textContent = me.starred_count || '';
    document.getElementById('trash-count').textContent = me.trashed_count || '';
    document.getElementById('stat-files').textContent = me.file_count;
    document.getElementById('stat-folders').textContent = me.folder_count;
    document.getElementById('stat-plan').textContent =
        me.plan === 'plus' ? 'Plus' : 'Free';

    // Keep the local plan in sync with the server, then flip the
    // billing button between "Upgrade" (Free), "Cancel" (Plus) or
    // disabled "Coming soon" (Plus not yet available).
    Session.setPlan(me.plan);
    const billBtn = document.getElementById('upgrade-btn');
    billBtn.disabled = false;
    billBtn.style.opacity = '';
    billBtn.style.cursor = '';
    if (me.plan === 'plus') {
        billBtn.innerHTML = 'Cancel Plus '
          + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">'
          + '<line x1="18" y1="6" x2="6" y2="18"></line>'
          + '<line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    } else if (me.plus_available) {
        billBtn.innerHTML = 'Upgrade to Plus '
          + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">'
          + '<path d="M5 12h14M13 5l7 7-7 7"></path></svg>';
    } else {
        // Plus is not accepting signups yet. Disable the button.
        billBtn.innerHTML = 'Plus · Coming soon '
          + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'
          + '<circle cx="12" cy="12" r="10"></circle>'
          + '<polyline points="12 6 12 12 16 14"></polyline></svg>';
        billBtn.disabled = true;
        billBtn.style.opacity = '0.55';
        billBtn.style.cursor = 'not-allowed';
    }
}

function renderQuota(me) {
    const used = me.storage_used, quota = me.storage_quota;
    const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;
    document.getElementById('storage-used').textContent = formatBytes(used);
    document.getElementById('storage-of').textContent  = 'of ' + formatBytes(quota);
    document.getElementById('storage-fill').style.width = pct + '%';
    document.getElementById('stat-storage').innerHTML =
        `${formatBytes(used).replace(/ .*/, '')}<span class="unit"> ${formatBytes(used).split(' ')[1]} / ${formatBytes(quota)}</span>`;
    const remaining = Math.max(0, quota - used);
    document.getElementById('stat-storage-sub').textContent =
        formatBytes(remaining) + ' available';
}


// --- Listing + rendering -------------------------------------------

async function loadItems(folderId) {
    CURRENT_FOLDER_ID = folderId;

    // Security + Settings aren't file listings — render the panel instead.
    if (VIEW === 'security') {
        renderViewSpecific();
        renderBreadcrumb();
        await loadSecurityView();
        return;
    }
    if (VIEW === 'settings') {
        renderViewSpecific();
        renderBreadcrumb();
        loadSettingsView();
        return;
    }

    let data;
    if (VIEW === 'starred')      data = await Api.listStarred();
    else if (VIEW === 'trash')   data = await Api.listTrash();
    else                         data = await Api.listItems(folderId);

    // Decrypt all names in parallel.
    const folders = await Promise.all(data.folders.map(async f => ({
        ...f, name: await safeDecryptName(f.encrypted_name, '(folder)'),
    })));
    const files = await Promise.all(data.files.map(async f => {
        const meta = await safeDecryptMeta(f.encrypted_name);
        return { ...f, name: meta.name, type: meta.type || '' };
    }));
    LAST_LISTING = { folders, files };
    renderListing();
    renderBreadcrumb();
    renderViewSpecific();
}

async function switchView(view) {
    if (view === VIEW) return;
    VIEW = view;
    FILTER = '';
    document.getElementById('search-input').value = '';
    document.querySelectorAll('.sidebar .nav-list button').forEach(b => b.classList.remove('active'));
    const navBtn = document.getElementById('nav-' + view);
    if (navBtn) navBtn.classList.add('active');
    if (view === 'files') {
        BREADCRUMB = [{ id: null, name: 'All files' }];
        CURRENT_FOLDER_ID = null;
    } else {
        BREADCRUMB = [];
        CURRENT_FOLDER_ID = null;
    }
    await loadItems(CURRENT_FOLDER_ID);
}

function renderViewSpecific() {
    const inFiles    = VIEW === 'files';
    const inSecurity = VIEW === 'security';
    const inSettings = VIEW === 'settings';
    const inPanel    = inSecurity || inSettings;

    // Files area vs panel (security or settings). Use .hidden (the
    // attribute) so we don't fight the HTML `hidden` the panels start with.
    const filesArea = document.getElementById('files-area');
    const secArea   = document.getElementById('security-area');
    const setArea   = document.getElementById('settings-area');
    if (filesArea) filesArea.hidden = inPanel;
    if (secArea)   secArea.hidden   = !inSecurity;
    if (setArea)   setArea.hidden   = !inSettings;

    // Upload / New folder live in the file views only.
    document.getElementById('upload-btn').style.display    = inFiles ? '' : 'none';
    document.getElementById('new-folder-btn').style.display = inFiles ? '' : 'none';
    // Search makes no sense in Security/Settings.
    const searchEl = document.querySelector('.search');
    if (searchEl) searchEl.style.display = inPanel ? 'none' : '';

    // Folder grid and its header belong to the Files view only.
    const folderHeader = document.getElementById('folders-head');
    const folderGrid   = document.getElementById('folder-grid');
    if (folderHeader) folderHeader.style.display = inFiles ? '' : 'none';
    if (folderGrid)   folderGrid.style.display   = inFiles ? '' : 'none';

    // Section header for the file list adapts.
    const filesHeadLabel = document.getElementById('files-head-label');
    if (filesHeadLabel) {
        if (VIEW === 'starred') filesHeadLabel.textContent = 'Starred files';
        else if (VIEW === 'trash') filesHeadLabel.textContent = 'In trash';
        else filesHeadLabel.textContent = 'Files';
    }

    // Empty-state copy adapts too.
    const title = document.getElementById('empty-title');
    const body = document.getElementById('empty-body');
    if (title && body) {
        if (VIEW === 'starred') {
            title.textContent = 'Nothing starred yet.';
            body.textContent = 'Star files from All files to pin them here.';
        } else if (VIEW === 'trash') {
            title.textContent = 'Trash is empty.';
            body.textContent = 'Deleted files land here. They stay until you permanently delete them.';
        } else {
            title.textContent = 'Your vault is empty.';
            body.textContent = 'Drop files here, or click Upload to add your first encrypted file.';
        }
    }
}

function renderBreadcrumb() {
    const bc = document.getElementById('breadcrumb');
    bc.innerHTML = '';

    if (VIEW === 'starred') {
        bc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg><span class="here">Starred</span>';
        return;
    }
    if (VIEW === 'trash') {
        bc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg><span class="here">Trash</span>';
        return;
    }
    if (VIEW === 'security') {
        bc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 1 1 8 0v4"></path></svg><span class="here">Security</span>';
        return;
    }
    if (VIEW === 'settings') {
        bc.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg><span class="here">Settings</span>';
        return;
    }

    const homeSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;
    bc.insertAdjacentHTML('beforeend', homeSvg);
    BREADCRUMB.forEach((c, i) => {
        const last = i === BREADCRUMB.length - 1;
        if (i > 0) {
            bc.insertAdjacentHTML('beforeend',
                `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>`);
        }
        const el = document.createElement('span');
        el.className = last ? 'here' : 'crumb';
        el.textContent = c.name;
        if (!last) {
            el.addEventListener('click', () => {
                BREADCRUMB = BREADCRUMB.slice(0, i + 1);
                loadItems(c.id);
            });
        }
        bc.appendChild(el);
    });
}

function renderListing() {
    const { folders, files } = LAST_LISTING;
    const q = FILTER.toLowerCase();
    const folderGrid = document.getElementById('folder-grid');
    const tbody = document.getElementById('files-tbody');
    folderGrid.innerHTML = '';
    tbody.innerHTML = '';

    const filterFn = x => !q || x.name.toLowerCase().includes(q);
    const shownFolders = folders.filter(filterFn);
    const shownFiles = files.filter(filterFn);

    shownFolders.forEach(f => folderGrid.appendChild(folderCard(f)));
    shownFiles.forEach(f => tbody.appendChild(fileRow(f)));

    const noItems = shownFolders.length === 0 && shownFiles.length === 0;
    document.getElementById('empty-state').hidden = !noItems;
    document.getElementById('files-wrap').style.display = shownFiles.length ? '' : 'none';
    folderGrid.style.display = shownFolders.length ? '' : 'none';
}

function folderCard(folder) {
    const el = document.createElement('div');
    el.className = 'folder';
    el.innerHTML = `
      <div class="folder-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
      </div>
      <div class="folder-name"></div>
      <div class="folder-meta">Folder</div>
      <button type="button" class="folder-del" title="Delete folder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>
      </button>
    `;
    el.querySelector('.folder-name').textContent = folder.name;
    el.addEventListener('click', (e) => {
        if (e.target.closest('.folder-del')) return;
        BREADCRUMB = [...BREADCRUMB, { id: folder.id, name: folder.name }];
        loadItems(folder.id);
    });
    el.querySelector('.folder-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await uiConfirm({
            title: 'Delete folder',
            body: `Delete "${folder.name}"? The folder must be empty.`,
            okText: 'Delete folder',
            danger: true,
        });
        if (!ok) return;
        try {
            await Api.deleteFolder(folder.id);
            toast(`Folder "${folder.name}" deleted`, 'ok');
            await loadItems(CURRENT_FOLDER_ID);
            await loadUser();
        } catch (ex) {
            toast(ex.message, 'err');
        }
    });
    return el;
}

function fileRow(file) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <div class="file-name">
          <div class="file-icon">${iconFor(file.name)}</div>
          <div><span class="n"></span></div>
        </div>
      </td>
      <td class="col-sub"></td>
      <td class="col-right"></td>
      <td>${statusCellFor(file)}</td>
      <td>
        <div class="row-actions">${actionsFor(file)}</div>
      </td>
    `;
    tr.querySelector('.n').textContent = file.name;
    tr.querySelector('.col-sub').textContent = VIEW === 'trash'
        ? ('trashed ' + formatDate(file.trashed_at))
        : formatDate(file.modified_at);
    tr.querySelector('.col-right').textContent = formatBytes(file.size);

    // Wire actions based on view.
    const starBtn = tr.querySelector('.star');
    if (starBtn) starBtn.addEventListener('click', () => toggleStar(file));
    const dlBtn = tr.querySelector('.dl');
    if (dlBtn) dlBtn.addEventListener('click', () => downloadFile(file));
    const rmBtn = tr.querySelector('.rm');
    if (rmBtn) rmBtn.addEventListener('click', () => deleteFile(file));
    const resBtn = tr.querySelector('.restore');
    if (resBtn) resBtn.addEventListener('click', () => restoreFile(file));
    const purgeBtn = tr.querySelector('.purge');
    if (purgeBtn) purgeBtn.addEventListener('click', () => permanentDeleteFile(file));

    return tr;
}

function statusCellFor(file) {
    if (VIEW === 'trash') {
        return `<span class="enc-pill" style="background: rgba(255,100,120,0.08); color: var(--err);">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>
          Trashed</span>`;
    }
    return `<span class="enc-pill">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 1 1 8 0v4"></path></svg>
      Encrypted</span>`;
}

function actionsFor(file) {
    if (VIEW === 'trash') {
        return `
          <button type="button" class="restore" title="Restore">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"></path><polyline points="3 4 3 10 9 10"></polyline></svg>
          </button>
          <button type="button" class="purge danger" title="Delete forever">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          </button>`;
    }
    const starClass = file.starred ? 'star on' : 'star';
    const starSvg = file.starred
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
    return `
      <button type="button" class="${starClass}" title="${file.starred ? 'Unstar' : 'Star'}">${starSvg}</button>
      <button type="button" class="dl" title="Download">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
      </button>
      <button type="button" class="rm danger" title="Move to trash">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path></svg>
      </button>`;
}


// --- Upload --------------------------------------------------------

async function uploadFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    const progress = document.getElementById('upload-progress');
    const label = document.getElementById('upload-label');
    const pct = document.getElementById('upload-pct');
    const fill = document.getElementById('upload-fill');

    progress.hidden = false;
    try {
        for (let i = 0; i < files.length; i++) {
            const f = files[i];
            label.textContent = `Encrypting ${f.name} (${i+1}/${files.length})…`;
            pct.textContent = '0%';
            fill.style.width = '0%';

            // Encrypt the filename + type metadata.
            const metaJson = JSON.stringify({ name: f.name, type: f.type || '' });
            const encName = await encryptString(ENC_KEY, metaJson);

            // Read full file into memory. Fine for the prototype;
            // streaming encryption is a later enhancement.
            fill.style.width = '20%'; pct.textContent = '20%';
            const bytes = new Uint8Array(await f.arrayBuffer());
            fill.style.width = '50%'; pct.textContent = '50%';

            const cipher = await encryptBytes(ENC_KEY, bytes);
            fill.style.width = '80%'; pct.textContent = '80%';

            label.textContent = `Uploading ${f.name}…`;
            await Api.uploadFile(encName, CURRENT_FOLDER_ID,
                                 new Blob([cipher], { type: 'application/octet-stream' }));
            fill.style.width = '100%'; pct.textContent = '100%';
            toast(`Uploaded "${f.name}"`, 'ok');
        }
        await loadItems(CURRENT_FOLDER_ID);
        await loadUser();
    } catch (ex) {
        toast(ex.message || 'Upload failed', 'err');
    } finally {
        setTimeout(() => { progress.hidden = true; }, 400);
    }
}


// --- Download ------------------------------------------------------

async function downloadFile(file) {
    try {
        toast(`Decrypting "${file.name}"…`);
        const cipher = await Api.downloadFile(file.id);
        const plain = await decryptBytes(ENC_KEY, cipher);
        const blob = new Blob([plain], { type: file.type || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (ex) {
        toast(ex.message || 'Download failed', 'err');
    }
}

async function deleteFile(file) {
    // Soft delete: moves to Trash. Not immediately destructive.
    try {
        await Api.deleteFile(file.id);
        toast(`"${file.name}" moved to trash`, 'ok');
        await loadItems(CURRENT_FOLDER_ID);
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}

async function toggleStar(file) {
    const next = !file.starred;
    try {
        await Api.starFile(file.id, next);
        toast(next ? `Starred "${file.name}"` : `Unstarred "${file.name}"`, 'ok');
        await loadItems(CURRENT_FOLDER_ID);
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}

async function restoreFile(file) {
    try {
        await Api.restoreFile(file.id);
        toast(`"${file.name}" restored`, 'ok');
        await loadItems(CURRENT_FOLDER_ID);
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}

async function permanentDeleteFile(file) {
    const ok = await uiConfirm({
        title: 'Delete forever?',
        body: `"${file.name}" will be removed from disk and your quota freed. This cannot be undone.`,
        okText: 'Delete forever',
        danger: true,
    });
    if (!ok) return;
    try {
        await Api.permanentDeleteFile(file.id);
        toast(`"${file.name}" deleted forever`, 'ok');
        await loadItems(CURRENT_FOLDER_ID);
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}


// --- New folder ----------------------------------------------------

async function createFolder() {
    const name = await uiPrompt({
        title: 'New folder',
        body: "Choose a name. It's encrypted on your device before anything is saved.",
        placeholder: 'Folder name',
        okText: 'Create folder',
    });
    if (!name) return;
    try {
        const encName = await encryptString(ENC_KEY, JSON.stringify({ name }));
        await Api.createFolder(encName, CURRENT_FOLDER_ID);
        toast(`Folder "${name}" created`, 'ok');
        await loadItems(CURRENT_FOLDER_ID);
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}


// --- Upgrade (mock) -----------------------------------------------

async function doUpgrade() {
    const ok = await uiConfirm({
        title: 'Upgrade to Obsidia Plus',
        body: 'This flips your plan to Plus (1 TB quota). In production it would open PayPal to start the subscription — right now it just updates the flag.',
        okText: 'Upgrade',
    });
    if (!ok) return;
    try {
        const resp = await Api.upgrade();
        Session.setPlan('plus');
        toast('Welcome to Obsidia Plus · 1 TB', 'ok');
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}

async function doCancel() {
    const ok = await uiConfirm({
        title: 'Cancel Obsidia Plus?',
        body: "You'll drop back to the Free plan (20 GB). Your files stay put — you just can't upload more until you're under 20 GB. In production this would cancel the recurring PayPal subscription.",
        okText: 'Cancel Plus',
        cancelText: 'Keep Plus',
        danger: true,
    });
    if (!ok) return;
    try {
        await Api.cancel();
        Session.setPlan('free');
        toast('Subscription cancelled · back to Free', 'ok');
        await loadUser();
    } catch (ex) {
        toast(ex.message, 'err');
    }
}


// --- Security view -------------------------------------------------

async function loadSecurityView() {
    try {
        const me = await Api.me();
        document.getElementById('sec-email').textContent = me.email;
        document.getElementById('sec-plan').textContent =
            me.plan === 'plus' ? 'Obsidia Plus' : 'Free';
        document.getElementById('sec-file-count').textContent =
            `${me.file_count} file${me.file_count === 1 ? '' : 's'}`;
        document.getElementById('sec-bytes').textContent =
            `${formatBytes(me.storage_used)} ciphertext`;
        document.getElementById('sec-salt').textContent = Session.salt || '—';
    } catch (ex) {
        toast(ex.message, 'err');
    }
}


// --- Settings view -------------------------------------------------

function loadSettingsView() {
    const s = loadSettings();

    // Toggle switches.
    const safeChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    safeChecked('set-compact', s.compact);
    safeChecked('set-notif-signin', s.notifSignin);
    safeChecked('set-notif-billing', s.notifBilling);
    safeChecked('set-notif-transparency', s.notifTransparency);

    // Button groups.
    document.querySelectorAll('.btn-group[data-setting]').forEach(group => {
        const key = group.dataset.setting;
        const val = String(s[key]);
        group.querySelectorAll('button').forEach(b => {
            b.classList.toggle('on', b.dataset.value === val);
        });
    });
}

function wireSettingsControls() {
    // Button-group one-of-N selectors.
    document.querySelectorAll('.btn-group[data-setting]').forEach(group => {
        const key = group.dataset.setting;
        group.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-value]');
            if (!btn || btn.disabled) return;
            const value = btn.dataset.value;

            // Recoverable mode isn't implemented; explain and bail.
            if (key === 'encMode' && value === 'recoverable') {
                uiConfirm({
                    title: 'Recoverable mode isn’t available yet',
                    body: 'This would escrow a wrapped copy of your vault key with Obsidia so a lost passphrase could be reset. It’s on the roadmap. Your account stays in zero-knowledge for now.',
                    okText: 'Got it',
                    cancelText: 'Close',
                });
                return;
            }

            group.querySelectorAll('button').forEach(b => b.classList.remove('on'));
            btn.classList.add('on');
            updateSetting(key, value);
            toast('Preference saved', 'ok');
        });
    });

    // Toggle switches.
    const setToggle = (id, key) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', (e) => {
            updateSetting(key, e.target.checked);
            toast('Preference saved', 'ok');
        });
    };
    setToggle('set-compact', 'compact');
    setToggle('set-notif-signin', 'notifSignin');
    setToggle('set-notif-billing', 'notifBilling');
    setToggle('set-notif-transparency', 'notifTransparency');
}

async function doChangePass() {
    await uiConfirm({
        title: 'Change passphrase',
        body: "Changing your passphrase re-wraps your vault key in your browser (your files don't need to re-upload). Not wired up in this prototype yet — happy to add it next if you want.",
        okText: 'Got it',
        cancelText: 'Close',
    });
}

async function doDeleteAccount() {
    const ok = await uiConfirm({
        title: 'Delete your Obsidia account?',
        body: "Every encrypted file, folder, and account record will be permanently removed. This cannot be undone and we can't help you get your files back — we never had the keys.",
        okText: 'Delete everything',
        cancelText: 'Keep account',
        danger: true,
    });
    if (!ok) return;

    const confirm2 = await uiPrompt({
        title: 'Last check',
        body: 'Type DELETE to confirm you want to wipe your account.',
        placeholder: 'DELETE',
        okText: 'Delete account',
    });
    if (!confirm2 || confirm2.trim().toUpperCase() !== 'DELETE') {
        toast('Account kept', 'ok');
        return;
    }

    try {
        await Api.deleteAccount();
        toast('Account deleted. Signing out…', 'ok');
        setTimeout(() => {
            Session.clear();
            dropEncKey();
            window.location.href = '/';
        }, 800);
    } catch (ex) {
        toast(ex.message || 'Could not delete account', 'err');
    }
}


// --- Sign out ------------------------------------------------------

function signOut() {
    Session.clear();
    dropEncKey();
    window.location.href = '/';
}


// --- UI wiring -----------------------------------------------------

function wireUI() {
    document.getElementById('upload-btn').addEventListener('click', () =>
        document.getElementById('file-input').click());
    document.getElementById('file-input').addEventListener('change', (e) =>
        uploadFiles(e.target.files));
    document.getElementById('new-folder-btn').addEventListener('click', createFolder);
    document.getElementById('upgrade-btn').addEventListener('click', () => {
        if (Session.plan === 'plus') doCancel(); else doUpgrade();
    });
    document.getElementById('signout-btn').addEventListener('click', signOut);
    document.getElementById('search-input').addEventListener('input', (e) => {
        FILTER = e.target.value;
        renderListing();
    });

    // Sidebar view switching.
    document.getElementById('nav-files').addEventListener('click',    () => switchView('files'));
    document.getElementById('nav-starred').addEventListener('click',  () => switchView('starred'));
    document.getElementById('nav-trash').addEventListener('click',    () => switchView('trash'));
    const navSec = document.getElementById('nav-security');
    if (navSec) navSec.addEventListener('click', () => switchView('security'));
    const navSet = document.getElementById('nav-settings');
    if (navSet) navSet.addEventListener('click', () => switchView('settings'));

    // Settings controls (wire once; panel populates on each visit).
    wireSettingsControls();
    // Activity listeners that keep the auto-lock timer alive.
    wireActivityForLockTimer();

    // Security view actions.
    const changePass = document.getElementById('change-pass-btn');
    if (changePass) changePass.addEventListener('click', doChangePass);
    const secSignout = document.getElementById('sec-signout-btn');
    if (secSignout) secSignout.addEventListener('click', signOut);
    const delAcct = document.getElementById('delete-account-btn');
    if (delAcct) delAcct.addEventListener('click', doDeleteAccount);

    // Drag-and-drop onto the whole workspace (Files view only).
    const dropZone = document.querySelector('.workspace');
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        if (VIEW !== 'files') {
            toast('Switch to All files to upload', 'err');
            return;
        }
        if (e.dataTransfer.files && e.dataTransfer.files.length) {
            uploadFiles(e.dataTransfer.files);
        }
    });

    wireUnlockForm();
}


// --- Helpers -------------------------------------------------------

function setEncIndicator(unlocked) {
    const el = document.getElementById('enc-indicator');
    const txt = el.querySelector('span');
    if (unlocked) {
        el.classList.remove('locked');
        txt.textContent = 'End-to-end encrypted · Vault unlocked';
    } else {
        el.classList.add('locked');
        txt.textContent = 'Vault locked';
    }
}

async function safeDecryptName(ciphertextB64, fallback) {
    try {
        const json = await decryptString(ENC_KEY, ciphertextB64);
        return JSON.parse(json).name || fallback;
    } catch {
        return fallback;
    }
}

async function safeDecryptMeta(ciphertextB64) {
    try {
        const json = await decryptString(ENC_KEY, ciphertextB64);
        return JSON.parse(json);
    } catch {
        return { name: '(encrypted)', type: '' };
    }
}

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    const s = v >= 10 ? v.toFixed(0) : v.toFixed(1);
    return `${s} ${units[i]}`;
}

function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    const style = (loadSettings().dateStyle) || 'relative';
    if (style === 'absolute') {
        return d.toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH} hour${diffH===1?'':'s'} ago`;
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return `${diffD} day${diffD===1?'':'s'} ago`;
    return d.toLocaleDateString();
}

function iconFor(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const img = ['png','jpg','jpeg','gif','webp','svg','bmp','heic'];
    const vid = ['mp4','mov','mkv','avi','webm','m4v'];
    const aud = ['mp3','wav','flac','m4a','ogg','opus'];
    const pdf = ['pdf'];
    const zip = ['zip','rar','7z','tar','gz'];
    const doc = ['md','txt','docx','rtf','odt','html'];
    let shape = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
    if (img.includes(ext)) shape = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
    else if (vid.includes(ext)) shape = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2"></rect></svg>`;
    else if (aud.includes(ext)) shape = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`;
    else if (zip.includes(ext)) shape = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg>`;
    return shape;
}

function toast(msg, kind) {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
        el.style.transition = 'opacity .3s, transform .3s';
        el.style.opacity = '0';
        el.style.transform = 'translateX(20px)';
        setTimeout(() => el.remove(), 320);
    }, 2800);
}

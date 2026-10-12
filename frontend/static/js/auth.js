// Signup + login logic. Attached to signup.html and login.html.

const { deriveKeys, stashEncKey, b64 } = window.ObsidiaCrypto;
const Api = window.ObsidiaApi;
const Session = window.ObsidiaSession;

function showErr(el, msg) {
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
}

function setLoading(btn, on) {
    if (on) btn.classList.add('loading'); else btn.classList.remove('loading');
    btn.disabled = on;
}

function wireSignup() {
    const form = document.getElementById('signup-form');
    if (!form) return;
    const err = document.getElementById('auth-err');
    const btn = document.getElementById('submit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showErr(err, '');

        const email = form.email.value.trim().toLowerCase();
        const pass = form.passphrase.value;
        const confirm = form.confirm.value;
        const ack = form.ack.checked;

        if (!email) return showErr(err, 'Email required.');
        if (pass.length < 10)
            return showErr(err, 'Passphrase must be at least 10 characters. Longer is better.');
        if (pass !== confirm)
            return showErr(err, "Those passphrases don't match.");
        if (!ack)
            return showErr(err, 'Please confirm you understand that lost passphrases are unrecoverable.');

        setLoading(btn, true);
        try {
            // Client-generated salt. 16 random bytes.
            const saltBytes = crypto.getRandomValues(new Uint8Array(16));
            const saltB64 = b64.enc(saltBytes);

            const { authKeyB64, encKeyRawB64 } = await deriveKeys(pass, saltB64);
            const resp = await Api.signup(email, saltB64, authKeyB64);

            Session.save({
                token: resp.token,
                email: resp.email,
                salt: resp.salt,
                plan: resp.plan,
            });
            stashEncKey(encKeyRawB64);

            window.location.href = '/dashboard';
        } catch (ex) {
            showErr(err, ex.message || 'Signup failed.');
            setLoading(btn, false);
        }
    });
}

function wireLogin() {
    const form = document.getElementById('login-form');
    if (!form) return;
    const err = document.getElementById('auth-err');
    const info = document.getElementById('auth-info');
    const btn = document.getElementById('submit');

    const params = new URLSearchParams(window.location.search);
    if (params.get('expired')) info.textContent = 'Your session expired. Please sign in again.';
    if (params.get('locked'))  info.textContent = 'Vault locked. Re-enter your passphrase to unlock.';

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showErr(err, '');

        const email = form.email.value.trim().toLowerCase();
        const pass = form.passphrase.value;

        if (!email || !pass) return showErr(err, 'Email and passphrase required.');

        setLoading(btn, true);
        try {
            const { salt } = await Api.getSalt(email);
            const { authKeyB64, encKeyRawB64 } = await deriveKeys(pass, salt);
            const resp = await Api.login(email, authKeyB64);

            Session.save({
                token: resp.token,
                email: resp.email,
                salt: resp.salt,
                plan: resp.plan,
            });
            stashEncKey(encKeyRawB64);

            window.location.href = '/dashboard';
        } catch (ex) {
            showErr(err, ex.message || 'Sign-in failed.');
            setLoading(btn, false);
        }
    });
}

// Wire whichever form is on the current page.
window.addEventListener('DOMContentLoaded', () => {
    wireSignup();
    wireLogin();
});

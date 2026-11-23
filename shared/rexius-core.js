/* =====================================================================
   Rexius core — the one file every app shares.
   ---------------------------------------------------------------------
   Load order on a page:
     <script src="…/shared/config.js"></script>
     <script src="…/retail-yard/vendor/supabase.js"></script>
     <script src="…/shared/rexius-core.js"></script>

   Gives a page:
     RexiusCore.client          the Supabase client (default sign-in storage,
                                so one sign-in is shared with Retail Yard and
                                Mix Board, which use the same project + site)
     RexiusCore.session()       the current session, or null
     RexiusCore.signIn(e, p)    email + password
     RexiusCore.signOut()
     RexiusCore.myHub()         { me, apps } from core.my_hub()
     RexiusCore.mountBar(opts)  slim "All apps" bar for the top of an app
     RexiusCore.friendly(err)   plain-language error text
   ===================================================================== */
(function () {
  'use strict';
  var cfg = window.REXIUS_CONFIG || {};
  var lib = window.supabase;
  var problem = !cfg.supabaseUrl || !cfg.supabaseKey ? 'The shared settings file did not load.'
              : !lib || !lib.createClient ? 'The sign-in library did not load.' : '';

  var client = problem ? null : lib.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Only ever link to an address on this same site. */
  function safePath(p) {
    return typeof p === 'string' && /^\/[A-Za-z0-9._\/-]*$/.test(p) && p.indexOf('//') === -1 ? p : null;
  }

  function friendly(err) {
    var m = String((err && (err.message || err.msg)) || err || '');
    var code = err && err.code, st = err && err.status;
    if (st === 429 || /rate limit|too many/i.test(m)) return 'Too many sign-in attempts. Wait a few minutes and try again.';
    if (/invalid login|invalid credentials|invalid grant/i.test(m)) return 'Email or password is incorrect.';
    if (/email not confirmed/i.test(m)) return 'That account still has to confirm its email address.';
    if (code === 'PGRST106' || /schema must be one of|invalid schema/i.test(m)) return 'SETUP: the core schema is not exposed yet.';
    if (code === 'PGRST202' || code === '42883' || /could not find the function/i.test(m)) return 'SETUP: the hub database script has not been run yet.';
    if (code === 'PGRST301' || /jwt expired/i.test(m)) return 'Your sign-in expired. Reload the page and sign in again.';
    if (/failed to fetch|networkerror|load failed/i.test(m)) return 'Can\'t reach the server. Check your connection and try again.';
    return m || 'Something went wrong.';
  }

  async function session() {
    if (!client) return null;
    var r = await client.auth.getSession();
    return r.data ? r.data.session : null;
  }
  async function signIn(email, password) {
    var r = await client.auth.signInWithPassword({ email: email, password: password });
    if (r.error) throw r.error;
  }
  async function signOut() { if (client) await client.auth.signOut(); }

  async function myHub() {
    var r = await client.schema('core').rpc('my_hub');
    if (r.error) throw r.error;
    return r.data || { me: {}, apps: [] };
  }

  /* A slim bar for the top of an app: link back to the hub + who is signed in.
     Usage inside an app:  RexiusCore.mountBar({ app: 'Retail Yard' })            */
  function mountBar(opts) {
    opts = opts || {};
    var hub = safePath(cfg.hubPath) || '/';
    var bar = document.createElement('div');
    bar.setAttribute('data-rexius-bar', '');
    bar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:6px 14px;background:#0A0E0B;color:#E5EBE6;' +
      'font:600 12px/1.2 "IBM Plex Sans",system-ui,sans-serif;letter-spacing:.04em';
    bar.innerHTML = '<a href="' + esc(hub) + '" style="color:inherit;text-decoration:none;opacity:.85">&#8249; ALL APPS</a>' +
      '<span style="opacity:.45">/</span><span>' + esc(opts.app || '') + '</span>' +
      '<span data-who style="margin-left:auto;opacity:.7;font-weight:400;letter-spacing:0"></span>';
    document.body.insertBefore(bar, document.body.firstChild);
    session().then(function (s) {
      if (s && s.user) bar.querySelector('[data-who]').textContent = s.user.email || '';
    });
    return bar;
  }

  window.RexiusCore = Object.freeze({
    client: client, problem: problem, esc: esc, safePath: safePath, friendly: friendly,
    session: session, signIn: signIn, signOut: signOut, myHub: myHub, mountBar: mountBar
  });
})();

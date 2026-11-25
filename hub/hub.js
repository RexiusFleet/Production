/* Rexius hub — sign in once, see the apps you can open. */
(function () {
  'use strict';
  var R = window.RexiusCore, $ = function (s) { return document.querySelector(s); };
  var app = $('#app'), who = $('#who');
  var esc = R ? R.esc : function (s) { return String(s); };

  if (!R || R.problem) {
    app.innerHTML = '<div class="panel notice"><h2>Site configuration problem</h2><p>' +
      esc(R ? R.problem : 'The shared Rexius file did not load.') + '</p></div>';
    return;
  }

  /* ---------- sign-in ---------- */
  function signInScreen() {
    who.hidden = true;
    app.innerHTML =
      '<div class="panel signin"><h1>Rexius Apps</h1>' +
      '<p class="muted" style="margin:0">Sign in with your Rexius email and password.</p>' +
      '<form id="si" novalidate style="display:grid;gap:12px">' +
      '<label class="field"><span>Email</span><input id="si-email" type="email" required autocomplete="username" maxlength="254"></label>' +
      '<label class="field"><span>Password</span><input id="si-pass" type="password" required autocomplete="current-password" maxlength="128"></label>' +
      '<div><button class="btn primary" id="si-btn">Sign in</button></div>' +
      '<div class="hint" id="si-hint" role="alert"></div></form>' +
      '<p class="muted" style="margin:0;font-size:.85rem">Forgot your password or don\'t have one? Ask an admin to set one for you.</p></div>';
    $('#si').addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = $('#si-email').value.trim(), pass = $('#si-pass').value, btn = $('#si-btn'), hint = $('#si-hint');
      if (!email || !pass) { hint.textContent = 'Enter your email and password.'; return; }
      btn.disabled = true; hint.textContent = '';
      try { await R.signIn(email, pass); await home(); }
      catch (err) { hint.textContent = R.friendly(err); btn.disabled = false; }
    });
    $('#si-email').focus();
  }

  /* ---------- setup not finished ---------- */
  function setupScreen(msg) {
    app.innerHTML =
      '<div class="panel notice"><h2>One-time setup needed</h2>' +
      '<p class="muted" style="margin:0">' + esc(msg.replace(/^SETUP:\s*/, '')) + '</p><ol>' +
      '<li>In the Production Supabase project, open the SQL editor and run <code>sql/core_001_hub.sql</code>.</li>' +
      '<li>Project Settings → Data API → Exposed schemas → add <code>core</code>.</li>' +
      '<li>Reload this page.</li></ol>' +
      '<div><button class="btn" id="out">Sign out</button></div></div>';
    $('#out').addEventListener('click', leave);
  }

  async function leave() { await R.signOut(); signInScreen(); }

  /* ---------- tiles ---------- */
  async function home() {
    var s = await R.session();
    if (!s) return signInScreen();
    app.innerHTML = '<p class="muted">Loading your apps…</p>';
    var hub;
    try { hub = await R.myHub(); }
    catch (err) {
      var m = R.friendly(err);
      if (/^SETUP:/.test(m)) return setupScreen(m);
      app.innerHTML = '<div class="panel notice"><h2>Couldn\'t load your apps</h2><p>' + esc(m) +
        '</p><div><button class="btn primary" id="again">Try again</button> <button class="btn" id="out">Sign out</button></div></div>';
      $('#again').addEventListener('click', home); $('#out').addEventListener('click', leave);
      return;
    }
    var me = hub.me || {}, apps = (hub.apps || []).filter(function (a) { return R.safePath(a.path); });

    who.hidden = false;
    who.innerHTML = '<span>' + esc(me.full_name || me.email || '') + (me.is_admin ? ' · Admin' : '') +
      '</span><button class="btn ghost" id="out">Sign out</button>';
    $('#out').addEventListener('click', leave);

    app.innerHTML = '<p class="eyebrow">Your apps</p>' + (apps.length
      ? '<ul class="tiles">' + apps.map(function (a) {
          return '<li><a class="tile" href="' + esc(R.safePath(a.path)) + '">' +
            '<span class="dept">' + esc(a.department) + '</span><h2>' + esc(a.name) + '</h2>' +
            '<p>' + esc(a.description) + '</p><span class="go">Open →</span></a></li>';
        }).join('') + '</ul>'
      : '<div class="panel"><p style="margin:0">You don\'t have any apps yet. Ask an admin to give you access.</p></div>') +
      (me.is_admin ? '<section class="admin" id="admin"></section>' : '');
    if (me.is_admin) adminPanel();
  }

  /* ---------- admin: who can open what ---------- */
  async function adminPanel() {
    var box = $('#admin'), core = R.client.schema('core');
    box.innerHTML = '<p class="muted">Loading access…</p>';
    var res = await Promise.all([
      core.from('apps').select('slug,name,open_to_all,active').order('sort'),
      core.from('people').select('user_id,email,full_name,is_admin').order('email'),
      core.from('app_access').select('user_id,app_slug')
    ]);
    var bad = res.find(function (r) { return r.error; });
    if (bad) { box.innerHTML = '<p class="hint">' + esc(R.friendly(bad.error)) + '</p>'; return; }
    var apps = res[0].data.filter(function (a) { return a.active; }), people = res[1].data, has = {};
    res[2].data.forEach(function (x) { has[x.user_id + '|' + x.app_slug] = true; });

    box.innerHTML =
      '<div class="admin-head"><h2>Who can open what</h2>' +
      '<span class="muted">Everyone with an account is listed, whether or not they have signed in yet. Each app still applies its own permissions inside.</span></div>' +
      '<div class="scroll"><table><thead><tr><th>Person</th>' +
      apps.map(function (a) { return '<th>' + esc(a.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      '<tr class="all-row"><td>Everyone signed in</td>' + apps.map(function (a) {
        return '<td><input type="checkbox" data-all="' + esc(a.slug) + '"' + (a.open_to_all ? ' checked' : '') +
          ' aria-label="' + esc(a.name) + ' open to everyone"></td>';
      }).join('') + '</tr>' +
      people.map(function (p) {
        return '<tr><td>' + esc(p.full_name || p.email) + (p.is_admin ? '<span class="tag">Admin</span>' : '') + '</td>' +
          apps.map(function (a) {
            var open = a.open_to_all || p.is_admin;
            return '<td><input type="checkbox" data-u="' + esc(p.user_id) + '" data-app="' + esc(a.slug) + '"' +
              (open || has[p.user_id + '|' + a.slug] ? ' checked' : '') + (open ? ' disabled' : '') +
              ' aria-label="' + esc(p.email + ' can open ' + a.name) + '"></td>';
          }).join('') + '</tr>';
      }).join('') + '</tbody></table></div><div class="hint" id="adm-hint" role="alert"></div>';

    if (box.dataset.bound) return;
    box.dataset.bound = '1';
    box.addEventListener('change', async function (e) {
      var t = e.target, hint = $('#adm-hint'), r;
      if (!t.matches('input[type=checkbox]')) return;
      t.disabled = true; hint.textContent = '';
      if (t.dataset.all) {
        r = await core.from('apps').update({ open_to_all: t.checked }).eq('slug', t.dataset.all);
      } else if (t.checked) {
        r = await core.from('app_access').upsert({ user_id: t.dataset.u, app_slug: t.dataset.app });
      } else {
        r = await core.from('app_access').delete().eq('user_id', t.dataset.u).eq('app_slug', t.dataset.app);
      }
      if (r.error) { t.checked = !t.checked; t.disabled = false; hint.textContent = R.friendly(r.error); return; }
      if (t.dataset.all) adminPanel(); else t.disabled = false;
    });
  }

  home().catch(function (err) {
    app.innerHTML = '<div class="panel notice"><h2>Something went wrong</h2><p>' + esc(R.friendly(err)) + '</p></div>';
  });
})();

/* Rexius Products — the shared catalog: every product, its current weight
   (lbs per cubic yard), and which apps it is available in. */
(function () {
  'use strict';
  var R = window.RexiusCore, $ = function (s, el) { return (el || document).querySelector(s); };
  var app = $('#app'), modalRoot = $('#modalRoot');
  var esc = R ? R.esc : String;

  if (!R || R.problem) {
    app.innerHTML = '<div class="panel notice"><h2>Site configuration problem</h2><p>' +
      esc(R ? R.problem : 'The shared Rexius file did not load.') + '</p></div>';
    return;
  }
  var core = R.client.schema('core');
  var S = { me: {}, apps: [], products: [], pa: new Set(), q: '', app: '', showOff: false };
  var MAX_LBS = 10000;

  /* Same rule as core.norm_name() in the database. */
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function num(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    var t = String(v == null ? '' : v).replace(/[,\s]/g, '').replace(/(lbs?|pounds?|#)(\/?(cu)?yd)?\.?$/i, '');
    return t === '' || !/^-?\d*\.?\d+$/.test(t) ? NaN : parseFloat(t);
  }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''; }
  function toast(msg) {
    var t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200);
  }
  function must(r) { if (r.error) throw r.error; return r.data; }

  /* ================= load ================= */
  async function boot() {
    var s = await R.session();
    if (!s) { location.replace(R.safePath((window.REXIUS_CONFIG || {}).hubPath) || '../hub/'); return; }
    R.mountBar({ app: 'Products' });
    try {
      var hub = await R.myHub(); S.me = hub.me || {};
      await load(); shell(); rows();
    } catch (err) { failScreen(err); }
  }
  async function load() {
    var res = await Promise.all([
      core.from('apps').select('*').order('sort'),
      core.from('products').select('*').order('name'),
      core.from('product_apps').select('product_id,app_slug')
    ]);
    /* uses_catalog is added by sql/core_003_catalog_apps.sql; until then every app shows. */
    S.apps = must(res[0]).filter(function (a) { return a.active && a.slug !== 'products' && a.uses_catalog !== false; });
    S.products = must(res[1]);
    S.pa = new Set(must(res[2]).map(function (x) { return x.product_id + '|' + x.app_slug; }));
  }
  function failScreen(err) {
    var m = R.friendly(err), setup = /^SETUP:/.test(m) || (err && (err.code === '42P01' || err.code === 'PGRST205'));
    app.innerHTML = '<div class="panel notice"><h2>' + (setup ? 'One-time setup needed' : 'Couldn\'t load products') + '</h2>' +
      (setup ? '<p class="muted" style="margin:0">Run <code>sql/core_002_products.sql</code> in the Production Supabase SQL editor, then reload this page.</p>'
             : '<p>' + esc(m) + '</p>') + '</div>';
  }

  /* ================= main screen ================= */
  function shell() {
    var admin = !!S.me.is_admin;
    app.innerHTML =
      '<div class="head"><h1>Products</h1><span class="count" id="count"></span>' +
      (admin ? '' : '<span class="tag">View only</span>') + '</div>' +
      '<div class="tools">' +
      '<input type="search" id="q" placeholder="Search name, code or category" aria-label="Search products">' +
      '<select id="fapp" aria-label="Filter by app"><option value="">All apps</option>' +
      S.apps.map(function (a) { return '<option value="' + esc(a.slug) + '">In ' + esc(a.name) + '</option>'; }).join('') +
      '<option value="-none">Not in any app</option><option value="-noweight">No weight yet</option><option value="-est">Estimated weight</option></select>' +
      '<label class="chk"><input type="checkbox" id="off"> Show inactive</label><span class="sp"></span>' +
      (admin ? '<button class="btn" id="upload">Upload weights</button><button class="btn primary" id="add">Add product</button>' : '') +
      '</div>' +
      '<div class="scroll"><table><thead><tr><th>Product</th><th>Category</th><th class="n">Lbs / yd</th><th>Updated</th>' +
      S.apps.map(function (a) { return '<th class="c">' + esc(a.name) + '</th>'; }).join('') +
      (admin ? '<th></th>' : '') + '</tr></thead><tbody id="rows"></tbody></table></div>';

    $('#q').addEventListener('input', function (e) { S.q = e.target.value; rows(); });
    $('#fapp').addEventListener('change', function (e) { S.app = e.target.value; rows(); });
    $('#off').addEventListener('change', function (e) { S.showOff = e.target.checked; rows(); });
    if (admin) {
      $('#add').addEventListener('click', function () { editDialog(null); });
      $('#upload').addEventListener('click', uploadDialog);
      $('#rows').addEventListener('change', onRowChange);
      $('#rows').addEventListener('click', function (e) {
        var b = e.target.closest('[data-edit]'); if (b) editDialog(byId(b.dataset.edit));
      });
    }
  }
  function byId(id) { return S.products.find(function (p) { return p.id === id; }); }
  function inApps(p) { return S.apps.filter(function (a) { return S.pa.has(p.id + '|' + a.slug); }); }

  function visible() {
    var q = norm(S.q);
    return S.products.filter(function (p) {
      if (!S.showOff && !p.active) return false;
      if (S.app === '-none') { if (inApps(p).length) return false; }
      else if (S.app === '-noweight') { if (p.lbs_per_yard != null) return false; }
      else if (S.app === '-est') { if (p.weight_source !== 'estimate') return false; }
      else if (S.app && !S.pa.has(p.id + '|' + S.app)) return false;
      if (!q) return true;
      return norm([p.name, p.erp_code, p.category].concat(p.aliases || []).join(' ')).indexOf(q) !== -1;
    });
  }
  function rows() {
    var admin = !!S.me.is_admin, list = visible(), cols = 4 + S.apps.length + (admin ? 1 : 0);
    $('#count').textContent = list.length + ' of ' + S.products.length;
    $('#rows').innerHTML = list.length ? list.map(function (p) {
      var w = p.lbs_per_yard == null ? '' : Number(p.lbs_per_yard);
      return '<tr class="' + (p.active ? '' : 'off') + '"><td class="name"><b>' + esc(p.name) + '</b>' +
        (p.active ? '' : ' <span class="tag">Inactive</span>') +
        ((p.erp_code || (p.aliases || []).length) ? '<span class="sub">' +
          (p.erp_code ? 'ERP ' + esc(p.erp_code) : '') + (p.erp_code && p.aliases.length ? ' · ' : '') +
          (p.aliases.length ? 'also: ' + esc(p.aliases.join(', ')) : '') + '</span>' : '') + '</td>' +
        '<td>' + esc(p.category) + '</td>' +
        '<td class="n">' + (admin
          ? '<input class="wt" inputmode="decimal" data-wt="' + esc(p.id) + '" value="' + esc(w) + '" aria-label="Pounds per yard for ' + esc(p.name) + '">'
          : '<span class="mono">' + esc(w === '' ? '—' : w) + '</span>') + '</td>' +
        '<td>' + (p.weight_source === 'estimate' ? '<span class="tag warn">Estimate</span>'
                 : p.weight_updated_at ? '<span class="muted">' + esc(fmtDate(p.weight_updated_at)) + '</span>' : '') + '</td>' +
        S.apps.map(function (a) {
          return '<td class="c"><input type="checkbox" data-pid="' + esc(p.id) + '" data-app="' + esc(a.slug) + '"' +
            (S.pa.has(p.id + '|' + a.slug) ? ' checked' : '') + (admin ? '' : ' disabled') +
            ' aria-label="' + esc(p.name + ' available in ' + a.name) + '"></td>';
        }).join('') +
        (admin ? '<td class="n"><button class="btn sm" data-edit="' + esc(p.id) + '">Edit</button></td>' : '') + '</tr>';
    }).join('') : '<tr><td class="empty" colspan="' + cols + '">' +
      (S.products.length ? 'No products match.' : 'No products yet.') + '</td></tr>';
  }

  async function onRowChange(e) {
    var t = e.target, r;
    if (t.dataset.wt) {
      var p = byId(t.dataset.wt), raw = t.value.trim(), v = raw === '' ? null : num(raw);
      t.classList.remove('saved', 'err');
      if (v !== null && (isNaN(v) || v <= 0 || v >= MAX_LBS)) { t.classList.add('err'); toast('Enter pounds per yard between 1 and 9,999.'); return; }
      if (v === (p.lbs_per_yard == null ? null : Number(p.lbs_per_yard))) return;
      r = await core.from('products').update({ lbs_per_yard: v, weight_source: v === null ? '' : 'manual' }).eq('id', p.id).select().single();
      if (r.error) { t.classList.add('err'); toast(R.friendly(r.error)); return; }
      Object.assign(p, r.data); t.classList.add('saved');
      t.closest('tr').children[3].innerHTML = p.weight_updated_at ? '<span class="muted">' + esc(fmtDate(p.weight_updated_at)) + '</span>' : '';
      return;
    }
    if (t.dataset.pid) {
      var key = t.dataset.pid + '|' + t.dataset.app; t.disabled = true;
      r = t.checked
        ? await core.from('product_apps').upsert({ product_id: t.dataset.pid, app_slug: t.dataset.app })
        : await core.from('product_apps').delete().eq('product_id', t.dataset.pid).eq('app_slug', t.dataset.app);
      t.disabled = false;
      if (r.error) { t.checked = !t.checked; toast(R.friendly(r.error)); return; }
      if (t.checked) S.pa.add(key); else S.pa.delete(key);
    }
  }

  /* ================= dialogs ================= */
  function openModal(html, wide) {
    modalRoot.innerHTML = '<div class="scrim"><div class="modal' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true">' + html + '</div></div>';
    var scrim = $('.scrim', modalRoot);
    scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) closeModal(); });
    document.addEventListener('keydown', escClose);
    return $('.modal', modalRoot);
  }
  function escClose(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() { modalRoot.innerHTML = ''; document.removeEventListener('keydown', escClose); }

  function editDialog(p) {
    var isNew = !p; p = p || { name: '', erp_code: '', category: '', aliases: [], notes: '', active: true, lbs_per_yard: null };
    var cats = Array.from(new Set(S.products.map(function (x) { return x.category; }).filter(Boolean))).sort();
    var m = openModal(
      '<h2>' + (isNew ? 'Add product' : 'Edit product') + '</h2><form id="pf" class="form" novalidate>' +
      '<label class="field full"><span>Name</span><input id="f-name" maxlength="160" required value="' + esc(p.name) + '"></label>' +
      '<label class="field"><span>ERP code</span><input id="f-erp" maxlength="40" value="' + esc(p.erp_code || '') + '"></label>' +
      '<label class="field"><span>Category</span><input id="f-cat" maxlength="60" list="cats" value="' + esc(p.category || '') + '">' +
      '<datalist id="cats">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist></label>' +
      (isNew ? '<label class="field"><span>Lbs per yard <small>(optional)</small></span><input id="f-wt" inputmode="decimal"></label>' : '') +
      '<label class="field full"><span>Other names <small>— separate with commas; used to match uploads and other apps</small></span>' +
      '<input id="f-alias" value="' + esc((p.aliases || []).join(', ')) + '"></label>' +
      '<label class="field full"><span>Notes</span><textarea id="f-notes" rows="2" maxlength="500">' + esc(p.notes || '') + '</textarea></label>' +
      '<label class="chk full" style="grid-column:1/-1"><input type="checkbox" id="f-active"' + (p.active ? ' checked' : '') + '> Active</label>' +
      '</form>' +
      (isNew ? '' :
        '<div class="field"><span>Duplicate? Merge this product into another <small>— its name becomes an alias there and its apps carry over</small></span>' +
        '<div class="actions"><select id="f-merge" style="flex:1;min-width:0;padding:8px 10px;background:var(--bg);border:1px solid var(--line);border-radius:var(--r)"><option value="">Choose the product to keep…</option>' +
        S.products.filter(function (x) { return x.id !== p.id; }).map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('') +
        '</select><button class="btn" id="merge" type="button">Merge</button></div></div>') +
      '<div class="hint" id="f-hint" role="alert"></div>' +
      '<div class="actions">' + (isNew ? '' : '<button class="btn danger" id="del" type="button">Delete</button>') +
      '<span class="sp"></span><button class="btn" id="cancel" type="button">Cancel</button><button class="btn primary" id="save" type="button">Save</button></div>');
    var hint = $('#f-hint', m);
    $('#cancel', m).addEventListener('click', closeModal);
    $('#f-name', m).focus();

    $('#save', m).addEventListener('click', async function () {
      var name = $('#f-name', m).value.trim();
      if (!name) { hint.textContent = 'Give the product a name.'; return; }
      var row = {
        name: name, erp_code: $('#f-erp', m).value.trim() || null, category: $('#f-cat', m).value.trim(),
        notes: $('#f-notes', m).value.trim(), active: $('#f-active', m).checked,
        aliases: Array.from(new Set($('#f-alias', m).value.split(',').map(function (a) { return a.trim(); })
          .filter(function (a) { return a && norm(a) !== norm(name); })))
      };
      if (isNew) {
        var raw = $('#f-wt', m).value.trim();
        if (raw) { var v = num(raw); if (isNaN(v) || v <= 0 || v >= MAX_LBS) { hint.textContent = 'Lbs per yard must be between 1 and 9,999.'; return; } row.lbs_per_yard = v; row.weight_source = 'manual'; }
      }
      this.disabled = true;
      var r = isNew ? await core.from('products').insert(row) : await core.from('products').update(row).eq('id', p.id);
      if (r.error) { this.disabled = false; hint.textContent = r.error.code === '23505' ? 'A product with that name already exists.' : R.friendly(r.error); return; }
      closeModal(); await refresh(isNew ? 'Product added.' : 'Saved.');
    });

    if (isNew) return;
    $('#merge', m).addEventListener('click', async function () {
      var dst = $('#f-merge', m).value; if (!dst) { hint.textContent = 'Choose the product to keep first.'; return; }
      if (this.dataset.armed !== dst) { this.dataset.armed = dst; this.textContent = 'Confirm merge'; hint.textContent = '"' + p.name + '" will be removed and folded into "' + byId(dst).name + '". This can\'t be undone.'; return; }
      this.disabled = true;
      var r = await core.rpc('merge_products', { src: p.id, dst: dst });
      if (r.error) { this.disabled = false; hint.textContent = R.friendly(r.error); return; }
      closeModal(); await refresh('Merged.');
    });
    $('#del', m).addEventListener('click', async function () {
      if (!this.dataset.armed) { this.dataset.armed = '1'; this.textContent = 'Confirm delete'; hint.textContent = 'This removes the product and its weight history for good. Untick "Active" instead to just hide it.'; return; }
      this.disabled = true;
      var r = await core.from('products').delete().eq('id', p.id);
      if (r.error) { this.disabled = false; hint.textContent = R.friendly(r.error); return; }
      closeModal(); await refresh('Deleted.');
    });
  }
  async function refresh(msg) {
    try { await load(); rows(); if (msg) toast(msg); } catch (err) { toast(R.friendly(err)); }
  }

  /* ================= weight upload ================= */
  function parseDelimited(text) {
    text = text.replace(/^﻿/, '');
    var first = text.split(/\r?\n/, 1)[0], d = first.indexOf('\t') !== -1 ? '\t'
      : (first.split(';').length > first.split(',').length ? ';' : ',');
    var out = [], row = [], cell = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === '') q = true;
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out;
  }

  /* Minimal .xlsx reader (first sheet): unzip with the browser's own inflate, read the XML. */
  async function readXlsx(buf) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\'t read Excel files. Save the sheet as CSV, or copy and paste the cells instead.');
    var u8 = new Uint8Array(buf), dv = new DataView(buf), td = new TextDecoder(), i = u8.length - 22, files = {}, k;
    while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
    if (i < 0) throw new Error('That doesn\'t look like an Excel (.xlsx) file.');
    var n = dv.getUint16(i + 10, true), off = dv.getUint32(i + 16, true);
    for (k = 0; k < n && dv.getUint32(off, true) === 0x02014b50; k++) {
      var nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true);
      files[td.decode(u8.subarray(off + 46, off + 46 + nl))] = { method: dv.getUint16(off + 10, true), size: dv.getUint32(off + 20, true), at: dv.getUint32(off + 42, true) };
      off += 46 + nl + el + cl;
    }
    async function get(name) {
      var f = files[name]; if (!f) return '';
      var start = f.at + 30 + dv.getUint16(f.at + 26, true) + dv.getUint16(f.at + 28, true), data = u8.subarray(start, start + f.size);
      if (f.method === 0) return td.decode(data);
      return await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    function xml(t) { return new DOMParser().parseFromString(t, 'application/xml'); }
    var sheet = Object.keys(files).filter(function (f) { return /^xl\/worksheets\/sheet\d+\.xml$/.test(f); })
      .sort(function (a, b) { return parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10); })[0];
    if (!sheet) throw new Error('No worksheet found in that file.');
    var ss = Array.from(xml(await get('xl/sharedStrings.xml') || '<x/>').getElementsByTagName('si')).map(function (si) {
      return Array.from(si.getElementsByTagName('t')).filter(function (t) { return t.parentNode.nodeName !== 'rPh'; })
        .map(function (t) { return t.textContent; }).join('');
    });
    return Array.from(xml(await get(sheet)).getElementsByTagName('row')).map(function (r) {
      var out = [];
      Array.from(r.getElementsByTagName('c')).forEach(function (c, idx) {
        var ref = (c.getAttribute('r') || '').replace(/\d+/g, ''), col = idx, t = c.getAttribute('t'), j;
        if (ref) { col = 0; for (j = 0; j < ref.length; j++) col = col * 26 + (ref.charCodeAt(j) - 64); col--; }
        var v = c.getElementsByTagName('v')[0], is = c.getElementsByTagName('is')[0];
        out[col] = t === 's' ? (ss[+(v ? v.textContent : -1)] || '') : t === 'inlineStr' ? (is ? is.textContent : '') : (v ? v.textContent : '');
      });
      for (var x = 0; x < out.length; x++) if (out[x] == null) out[x] = '';
      return out;
    });
  }

  /* Work out which column is the product name and which is the weight. */
  function analyze(grid) {
    grid = grid.map(function (r) { return r.map(function (c) { return String(c == null ? '' : c).trim(); }); })
      .filter(function (r) { return r.some(Boolean); });
    if (!grid.length) throw new Error('No rows found.');
    var NAME = /product|name|item|material|description/i, WT = /lb|weight|density|\bwt\b|pounds/i, CODE = /erp|code|sku|item\s*(#|no|num)/i;
    var hi = -1, nameCol = -1, wtCol = -1, codeCol = -1, r, c;
    for (r = 0; r < Math.min(grid.length, 6) && hi < 0; r++) {
      var nI = grid[r].findIndex(function (x) { return NAME.test(x) && !CODE.test(x) && isNaN(num(x)); });
      var wI = grid[r].findIndex(function (x) { return WT.test(x) && isNaN(num(x)); });
      if (wI >= 0 && (nI >= 0 || grid[r].length >= 2)) {
        hi = r; wtCol = wI; nameCol = nI;
        codeCol = grid[r].findIndex(function (x) { return CODE.test(x); });
      }
    }
    var data = grid.slice(hi + 1), width = Math.max.apply(null, grid.map(function (x) { return x.length; }));
    function score(col, fn) { return data.reduce(function (s, x) { return s + (fn(x[col] || '') ? 1 : 0); }, 0); }
    if (wtCol < 0) { var best = 0; for (c = 0; c < width; c++) { var sN = score(c, function (v) { var n = num(v); return !isNaN(n) && n >= 50; }); if (sN > best) { best = sN; wtCol = c; } } }
    if (nameCol < 0) { var bestT = 0; for (c = 0; c < width; c++) { if (c === wtCol || c === codeCol) continue; var sT = score(c, function (v) { return v && isNaN(num(v)); }); if (sT > bestT) { bestT = sT; nameCol = c; } } }
    if (wtCol < 0 || nameCol < 0) throw new Error('Couldn\'t find a product-name column and a weight column. Use two columns: product name, then pounds per yard.');
    return data.map(function (x) { return { name: x[nameCol] || '', code: codeCol >= 0 ? (x[codeCol] || '') : '', raw: x[wtCol] || '' }; })
      .filter(function (x) { return x.name || x.raw; });
  }

  function matcher() {
    var byName = {}, byCode = {}, dupCode = {};
    S.products.forEach(function (p) {
      [p.name].concat(p.aliases || []).forEach(function (n) { var k = norm(n); if (k && !byName[k]) byName[k] = p; });
      var c = norm(p.erp_code); if (c) { if (byCode[c]) dupCode[c] = 1; byCode[c] = p; }
    });
    return function (row) {
      var c = norm(row.code);
      return byName[norm(row.name)] || (c && !dupCode[c] ? byCode[c] : null) || null;
    };
  }

  function uploadDialog() {
    var m = openModal(
      '<h2>Upload weights</h2>' +
      '<p class="muted" style="margin:0">Two columns are enough: <b>product name</b> and <b>pounds per cubic yard</b>. An ERP code column helps matching. You\'ll see a preview before anything is saved.</p>' +
      '<div class="drop" id="drop"><p style="margin:0 0 10px">Drop a <b>.xlsx</b> or <b>.csv</b> file here</p>' +
      '<input type="file" id="file" accept=".xlsx,.csv,.tsv,.txt" aria-label="Choose a spreadsheet file"></div>' +
      '<div class="or">OR PASTE CELLS COPIED FROM EXCEL</div>' +
      '<textarea class="paste" id="paste" placeholder="Hemlock&#9;640&#10;Garden Sand&#9;2450" aria-label="Paste cells"></textarea>' +
      '<div class="hint" id="u-hint" role="alert"></div>' +
      '<div class="actions"><span class="sp"></span><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="preview">Preview</button></div>', true);
    var hint = $('#u-hint', m), drop = $('#drop', m);
    $('#cancel', m).addEventListener('click', closeModal);

    async function fromFile(f) {
      hint.textContent = '';
      try {
        if (f.size > 5 * 1024 * 1024) throw new Error('That file is over 5 MB. Upload just the sheet with names and weights.');
        var grid = /\.xlsx$/i.test(f.name) ? await readXlsx(await f.arrayBuffer())
          : /\.xls$/i.test(f.name) ? (function () { throw new Error('Old .xls files aren\'t supported. Save as .xlsx or .csv, or paste the cells.'); })()
          : parseDelimited(await f.text());
        previewStep(analyze(grid), f.name);
      } catch (err) { hint.textContent = err.message || String(err); }
    }
    $('#file', m).addEventListener('change', function (e) { if (e.target.files[0]) fromFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) fromFile(f); });
    $('#preview', m).addEventListener('click', function () {
      var t = $('#paste', m).value; hint.textContent = '';
      if (!t.trim()) { hint.textContent = 'Choose a file or paste some cells first.'; return; }
      try { previewStep(analyze(parseDelimited(t)), 'pasted cells'); } catch (err) { hint.textContent = err.message || String(err); }
    });
  }

  function previewStep(list, label) {
    var match = matcher(), seen = {};
    var items = list.map(function (x) {
      var v = num(x.raw), p = match(x), it = { name: x.name, code: x.code, raw: x.raw, lbs: v, auto: p ? p.id : '', pick: p ? p.id : '' };
      it.bad = isNaN(v) ? 'Not a number' : (v <= 0 || v >= MAX_LBS) ? 'Out of range' : !x.name ? 'No name' : '';
      if (!it.bad && p) { if (seen[p.id]) it.bad = 'Listed twice'; seen[p.id] = 1; }
      return it;
    });
    var opts = '<option value="">Skip</option><option value="+new">Add as a new product</option>' +
      S.products.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('');

    var m = openModal(
      '<h2>Check before saving</h2><p class="muted" style="margin:0">From ' + esc(label) + '. Fix any row marked "No match" by choosing its product, or leave it on Skip.</p>' +
      '<div class="sum" id="sum"></div>' +
      '<div class="scroll" style="max-height:48vh;overflow:auto"><table><thead><tr><th>In your file</th><th class="n">New lbs/yd</th><th>Product</th><th class="n">Current</th><th></th></tr></thead><tbody id="prev"></tbody></table></div>' +
      '<label class="chk"><input type="checkbox" id="remember" checked> Remember names I match by hand, so the next upload matches them automatically</label>' +
      '<div class="hint" id="p-hint" role="alert"></div>' +
      '<div class="actions"><button class="btn" id="back">Back</button><span class="sp"></span><button class="btn" id="cancel">Cancel</button><button class="btn primary" id="apply">Save</button></div>', true);

    function status(it) {
      if (it.bad) return ['bad', it.bad];
      if (!it.pick) return ['warn', it.auto ? 'Skipped' : 'No match'];
      if (it.pick === '+new') return ['ok', 'New product'];
      var p = byId(it.pick), cur = p.lbs_per_yard == null ? null : Number(p.lbs_per_yard);
      if (cur === it.lbs) return ['', 'Unchanged'];
      if (cur && Math.abs(it.lbs - cur) / cur > 0.4) return ['warn', 'Big change'];
      return ['ok', cur == null ? 'First weight' : 'Will update'];
    }
    function draw() {
      var n = { change: 0, same: 0, add: 0, skip: 0, bad: 0 };
      $('#prev', m).innerHTML = items.map(function (it, i) {
        var st = status(it), p = it.pick && it.pick !== '+new' ? byId(it.pick) : null;
        if (it.bad) n.bad++; else if (!it.pick) n.skip++; else if (it.pick === '+new') n.add++; else if (st[1] === 'Unchanged') n.same++; else n.change++;
        return '<tr><td class="name"><b>' + esc(it.name || '—') + '</b>' + (it.code ? '<span class="sub">' + esc(it.code) + '</span>' : '') + '</td>' +
          '<td class="n mono">' + esc(isNaN(it.lbs) ? it.raw : it.lbs) + '</td>' +
          '<td>' + (it.bad ? '' : '<select data-i="' + i + '" style="max-width:260px;padding:5px 6px;background:var(--bg);border:1px solid var(--line);border-radius:4px">' +
            opts.replace('value="' + esc(it.pick) + '"', 'value="' + esc(it.pick) + '" selected') + '</select>') + '</td>' +
          '<td class="n mono">' + (p && p.lbs_per_yard != null ? esc(Number(p.lbs_per_yard)) : '—') + '</td>' +
          '<td><span class="tag ' + st[0] + '">' + esc(st[1]) + '</span></td></tr>';
      }).join('');
      $('#sum', m).innerHTML =
        '<span class="tag ok">' + n.change + ' to update</span>' + (n.add ? '<span class="tag ok">' + n.add + ' new</span>' : '') +
        '<span class="tag">' + n.same + ' unchanged</span>' + (n.skip ? '<span class="tag warn">' + n.skip + ' skipped</span>' : '') +
        (n.bad ? '<span class="tag bad">' + n.bad + ' can\'t be read</span>' : '');
      $('#apply', m).disabled = !(n.change + n.add);
      $('#apply', m).textContent = n.change + n.add ? 'Save ' + (n.change + n.add) + ' weight' + (n.change + n.add === 1 ? '' : 's') : 'Nothing to save';
    }
    draw();
    $('#prev', m).addEventListener('change', function (e) {
      var i = e.target.dataset.i; if (i == null) return;
      var it = items[+i], v = e.target.value, hint = $('#p-hint', m); hint.textContent = '';
      if (v && v !== '+new' && items.some(function (o, j) { return j !== +i && !o.bad && o.pick === v; })) {
        hint.textContent = 'Another row already goes to that product.'; e.target.value = it.pick; return;
      }
      it.pick = v; draw();
    });
    $('#cancel', m).addEventListener('click', closeModal);
    $('#back', m).addEventListener('click', uploadDialog);
    $('#apply', m).addEventListener('click', async function () {
      var hint = $('#p-hint', m), btn = this; btn.disabled = true; hint.textContent = '';
      try {
        var ok = items.filter(function (it) { return !it.bad && it.pick; });
        var adds = ok.filter(function (it) { return it.pick === '+new'; })
          .map(function (it) { return { name: it.name, erp_code: it.code || null, lbs_per_yard: it.lbs, weight_source: 'upload' }; });
        if (adds.length) must(await core.from('products').insert(adds));
        if ($('#remember', m).checked) {
          var hand = ok.filter(function (it) { return it.pick !== '+new' && it.pick !== it.auto && norm(it.name) !== norm(byId(it.pick).name); });
          for (var h = 0; h < hand.length; h++) {
            var p = byId(hand[h].pick), al = (p.aliases || []).concat(hand[h].name);
            must(await core.from('products').update({ aliases: Array.from(new Set(al)) }).eq('id', p.id));
            p.aliases = al;
          }
        }
        var sets = ok.filter(function (it) { return it.pick !== '+new'; }).map(function (it) { return { id: it.pick, lbs: it.lbs }; });
        var changed = sets.length ? must(await core.rpc('apply_weights', { rows: sets, src: 'upload' })) : 0;
        closeModal(); await refresh((changed + adds.length) + ' weight' + (changed + adds.length === 1 ? '' : 's') + ' saved.');
      } catch (err) {
        btn.disabled = false;
        hint.textContent = err && err.code === '23505' ? 'One of the new products has the same name as an existing one. Match it to that product instead.' : R.friendly(err);
      }
    });
  }

  boot().catch(failScreen);
})();

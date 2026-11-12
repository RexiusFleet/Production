/* =============================================================
   Retail Yard Tracker
   - Demo mode (no config.js values): sample data in this browser only.
   - Live mode: config.js is generated at deploy time from environment
     variables by scripts/build.mjs. No keys live in this source file.
   ============================================================= */
'use strict';

/* ---------- Runtime configuration (OWASP A05 / A02) ----------
   config.js sets window.RYT_CONFIG = { supabaseUrl, supabaseKey }.
   The only key that may ever reach a browser is Supabase's PUBLIC key
   (legacy "anon" JWT or new "sb_publishable_…"). It grants nothing on its
   own: every read/write is still checked by Row Level Security and
   column grants in supabase/schema.sql.
   Server-side secrets (service_role / sb_secret_… / Shopify webhook secret)
   live only in Supabase Edge Function secrets. readConfig() refuses to start
   if one is ever pasted into config.js by mistake, so it cannot be used
   from the page. */
function readConfig(){
  const raw=(typeof window!=='undefined'&&window.RYT_CONFIG)||{};
  const url=String(raw.supabaseUrl||'').trim();
  const key=String(raw.supabaseKey||'').trim();
  if(!url&&!key) return {url:'',key:'',problem:null};
  // Only accept an https Supabase project URL (blocks javascript:, http:, look-alike hosts).
  if(!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)) return {url:'',key:'',problem:'The Supabase URL in config.js is not a valid https://<project>.supabase.co address.'};
  if(/^sb_secret_/.test(key)) return {url:'',key:'',problem:'config.js contains a SECRET key. Remove it, rotate that key in Supabase, and use the publishable key instead.'};
  if(/^eyJ/.test(key)){
    try{
      const payload=JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      if(payload.role!=='anon') return {url:'',key:'',problem:'config.js contains a service_role key. Remove it, rotate it in Supabase, and use the anon/publishable key instead.'};
    }catch{ return {url:'',key:'',problem:'The Supabase key in config.js could not be read.'}; }
  } else if(!/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(key)){
    return {url:'',key:'',problem:'The Supabase key in config.js is not a public (anon or publishable) key.'};
  }
  return {url,key,problem:null};
}
const CONFIG=readConfig();
const DB_SCHEMA='yard';   // must match the schema in supabase/schema.sql and Data API → Exposed schemas

/* =============================================================
   INPUT VALIDATION (OWASP A03 Injection / A04 Insecure Design)
   -------------------------------------------------------------
   Every write the app makes goes through validateWrite() — one choke point
   in front of both the live and demo adapters, so no form can skip it.
   - Schema per table + operation: types, ranges, lengths, enums, patterns.
   - Unknown fields are REJECTED (not silently dropped).
   - Strings are normalised (NFC), control characters replaced, trimmed.
   This is for fast, friendly feedback. The database enforces the same rules
   independently (CHECK constraints, column grants, RLS in schema.sql), so a
   request that bypasses this page is still validated.
   ============================================================= */
class ValidationError extends Error { constructor(msg){ super(msg); this.name='ValidationError'; } }

const V={
  id:      (o={})=>({type:'id',...o}),
  str:     (max,o={})=>({type:'str',max,...o}),
  num:     (min,max,o={})=>({type:'num',min,max,...o}),
  int:     (min,max,o={})=>({type:'int',min,max,...o}),
  bool:    (o={})=>({type:'bool',...o}),
  oneOf:   (vals,o={})=>({type:'enum',vals,...o}),
  date:    (back,ahead,o={})=>({type:'date',back,ahead,...o}),
  strList: (maxItems,maxLen,o={})=>({type:'strList',maxItems,maxLen,...o}),
};
const HAUL_GROUP_KEYS=['bark','sawdust','primary','fng','turf','compost'];
const TRUCK_NO_RE=/^[A-Za-z0-9][A-Za-z0-9 #/-]{0,19}$/;
const BIN_CODE_RE=/^[A-Za-z0-9][A-Za-z0-9 _-]{0,11}$/;

// req: required on insert. null: may be null. Updates are partial (only listed fields allowed).
const WRITE_SCHEMAS={
  'internal_orders.insert':{
    customer:V.str(120,{req:true,label:'Customer'}), reference:V.str(120,{null:true,label:'Reference'}),
    product_id:V.id({req:true}), bin_id:V.id({req:true}),
    qty_yd:V.num(0.01,1000,{req:true,label:'Volume'}),
    tote_count:V.int(1,1000,{null:true,label:'Number of totes'}), tote_size_yd:V.num(0.01,20,{null:true,label:'Tote size'}),
    pull_on:V.date(366,31,{null:true,label:'Date'}), status:V.oneOf(['pulled'],{req:true}), notes:V.str(500,{null:true,label:'Notes'}) },
  'internal_orders.update':{ status:V.oneOf(['cancelled']) },
  'shopify_order_lines.update':{
    product_id:V.id(), yd_each:V.num(0.01,1000,{label:'Yards per item'}), qty_yd:V.num(0.01,100000,{label:'Volume'}),
    status:V.oneOf(['pulled','ignored']) },
  'products.insert':{
    name:V.str(80,{req:true,label:'Product name'}), sku:V.str(40,{null:true,label:'SKU'}),
    shopify_product_id:V.int(1,Number.MAX_SAFE_INTEGER,{null:true,label:'Shopify product ID'}),
    shopify_titles:V.strList(10,200,{label:'Shopify titles'}), shopify_variant_match:V.str(40,{null:true,label:'Variant text'}),
    haul_group:V.oneOf(HAUL_GROUP_KEYS,{null:true,label:'Haul group'}), active:V.bool() },
  'products.update':null,   // same fields as insert, all optional (set below)
  'bins.insert':{
    code:V.str(12,{req:true,pattern:BIN_CODE_RE,label:'Bin code'}), product_id:V.id({null:true}),
    capacity_yd:V.num(0,2000,{req:true,label:'Capacity'}), reorder_yd:V.num(0,2000,{req:true,label:'Reorder point'}),
    sort:V.int(-10000,10000,{label:'Sort order'}), active:V.bool(), notes:V.str(500,{null:true,label:'Notes'}),
    map_x:V.int(1,30,{null:true,label:'Map column'}), map_y:V.int(1,500,{null:true,label:'Map row'}),
    map_w:V.int(1,10,{label:'Map width'}), map_h:V.int(1,50,{label:'Map height'}) },
  'bins.update':null,
  'backfill_requests.insert':{
    product_id:V.id({req:true}), bin_id:V.id({req:true}), qty_yd:V.num(0.01,2000,{req:true,label:'Volume'}),
    needed_by:V.date(31,366,{null:true,label:'Needed by'}), method:V.oneOf(['bulk','slinger'],{req:true}),
    status:V.oneOf(['requested'],{req:true}), notes:V.str(500,{null:true,label:'Notes'}) },
  'backfill_requests.update':{ status:V.oneOf(['cancelled']) },
  'hauls.insert':{
    request_id:V.id({null:true}), method:V.oneOf(['bulk','slinger'],{req:true}),
    truck_no:V.str(20,{req:true,pattern:TRUCK_NO_RE,label:'Truck number'}), loads:V.int(1,50,{label:'Loads'}),
    conditions:V.oneOf(['dry','wet'],{null:true}), product_id:V.id({req:true}), bin_id:V.id({req:true}),
    volume_yd:V.num(0.01,2000,{req:true,label:'Volume'}), haul_on:V.date(366,366,{req:true,label:'Date'}),
    status:V.oneOf(['scheduled','delivered'],{req:true}) },
  'hauls.update':{ status:V.oneOf(['scheduled','en_route','delivered','cancelled']) },
  'debris_events.insert':{
    kind:V.oneOf(['intake','grind','removal'],{req:true}), bin_id:V.id({req:true,label:'Pile'}),
    qty_yd:V.num(0.01,2000,{req:true,label:'Volume'}), to_bin_id:V.id({null:true,label:'Ground pile'}),
    to_qty_yd:V.num(0.01,2000,{null:true,label:'Ground material made'}), source:V.str(120,{null:true,label:'From'}),
    hauler:V.str(40,{null:true,label:'Hauler'}), loads:V.int(1,50,{null:true,label:'Loads'}),
    happened_on:V.date(366,366,{req:true,label:'Date'}), status:V.oneOf(['done','scheduled'],{req:true}),
    notes:V.str(500,{null:true,label:'Notes'}) },
  'debris_events.update':{ status:V.oneOf(['done','cancelled']) },
  'movements.insert':{
    bin_id:V.id({req:true}), product_id:V.id({null:true}), qty_yd:V.num(-5000,5000,{req:true,nonZero:true,label:'Volume'}),
    kind:V.oneOf(['count','adjustment'],{req:true}), occurred_on:V.date(366,1,{req:true,label:'Date'}), note:V.str(300,{null:true,label:'Reason'}) },
};
// Updates of catalog rows: same fields as insert, nothing required.
for(const t of ['products','bins']){
  const s={}; for(const [k,f] of Object.entries(WRITE_SCHEMAS[t+'.insert'])) s[k]={...f,req:false}; WRITE_SCHEMAS[t+'.update']=s;
}

// Strip every Unicode control char (\p{Cc}, incl. U+0085) and line/paragraph separators — matches the DB's [[:cntrl:]] check.
const cleanStr=v=>String(v).normalize('NFC').replace(/[\p{Cc}\u2028\u2029]/gu,' ').replace(/\s{2,}/g,' ').trim();
const isId=v=>typeof v==='string'&&/^[A-Za-z0-9-]{1,64}$/.test(v);   // uuid in live mode; demo ids are similar
function checkField(name,f,v){
  const label=f.label||name;
  if(v===undefined){ if(f.req) throw new ValidationError(`${label} is required.`); return undefined; }
  if(v===null||(typeof v==='string'&&v.trim()==='')){
    if(f.req) throw new ValidationError(`${label} is required.`);
    if(f.null) return null;
    throw new ValidationError(`${label} can't be empty.`);
  }
  switch(f.type){
    case 'id': if(!isId(v)) throw new ValidationError(`${label} is not valid.`); return v;
    case 'str': {
      const s=cleanStr(v);
      if(!s){ if(f.req) throw new ValidationError(`${label} is required.`); return null; }
      if(s.length>f.max) throw new ValidationError(`${label} is too long (max ${f.max} characters).`);
      if(f.pattern&&!f.pattern.test(s)) throw new ValidationError(`${label} has characters that aren't allowed.`);
      return s;
    }
    case 'num': case 'int': {
      const n=typeof v==='number'?v:Number(String(v).trim());
      if(!Number.isFinite(n)) throw new ValidationError(`${label} must be a number.`);
      if(f.type==='int'&&!Number.isInteger(n)) throw new ValidationError(`${label} must be a whole number.`);
      if(n<f.min||n>f.max) throw new ValidationError(`${label} must be between ${f.min} and ${f.max}.`);
      if(f.nonZero&&n===0) throw new ValidationError(`${label} can't be zero.`);
      return f.type==='int'?n:Math.round(n*100)/100;
    }
    case 'bool': if(typeof v!=='boolean') throw new ValidationError(`${label} must be yes or no.`); return v;
    case 'enum': if(!f.vals.includes(v)) throw new ValidationError(`${label} has an unexpected value.`); return v;
    case 'date': {
      if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||isNaN(Date.parse(v+'T12:00:00'))) throw new ValidationError(`${label} must be a valid date.`);
      const diff=dayDiff(v);
      if(diff< -f.back||diff>f.ahead) throw new ValidationError(`${label} is too far ${diff<0?'in the past':'in the future'}.`);
      return v;
    }
    case 'strList': {
      if(!Array.isArray(v)) throw new ValidationError(`${label} must be a list.`);
      const out=[...new Set(v.map(cleanStr).filter(Boolean))];
      if(out.length>f.maxItems) throw new ValidationError(`${label}: at most ${f.maxItems} entries.`);
      if(out.some(s=>s.length>f.maxLen)) throw new ValidationError(`${label}: each entry must be ${f.maxLen} characters or fewer.`);
      return out;
    }
  }
  throw new ValidationError(`${label} is not valid.`);
}
function validateWrite(table,op,row){
  const schema=WRITE_SCHEMAS[table+'.'+op];
  if(!schema) throw new ValidationError('That change is not allowed from this page.');
  if(!row||typeof row!=='object'||Array.isArray(row)) throw new ValidationError('Invalid data.');
  const extra=Object.keys(row).filter(k=>!(k in schema));
  if(extra.length) throw new ValidationError('Unexpected field: '+extra.slice(0,3).join(', '));   // reject, don't strip
  const out={};
  for(const [k,f] of Object.entries(schema)){
    if(op==='update'&&!(k in row)) continue;
    const v=checkField(k,f,row[k]);
    if(v!==undefined) out[k]=v;
  }
  if(op==='update'&&!Object.keys(out).length) throw new ValidationError('Nothing to save.');
  return out;
}
// Settings are JSON: validate shape per key (mirrors validate_setting() in schema.sql).
function validateSetting(key,value){
  const num=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
  switch(key){
    case 'yd_per_unit': if(!num(value,0.5,50)) throw new ValidationError('Cubic yards per unit must be between 0.5 and 50.'); return value;
    case 'tote_sizes':
      if(!Array.isArray(value)||value.length<1||value.length>20||!value.every(x=>num(x,0.01,20))) throw new ValidationError('Tote sizes must be 1–20 numbers above 0 and up to 20 yd³.');
      return value;
    case 'trucks':
      if(!Array.isArray(value)||value.length>30) throw new ValidationError('Up to 30 trucks.');
      return value.map(t=>{
        if(!t||typeof t!=='object'||Object.keys(t).some(k=>!['no','cap'].includes(k))) throw new ValidationError('Invalid truck entry.');
        const no=cleanStr(t.no??''); if(!TRUCK_NO_RE.test(no)) throw new ValidationError('Truck numbers may use letters, digits, spaces, # / - (max 20).');
        const cap={};
        for(const [g,c] of Object.entries(t.cap||{})){
          if(!HAUL_GROUP_KEYS.includes(g)||!c||typeof c!=='object'||Object.keys(c).some(k=>!['dry','wet'].includes(k))) throw new ValidationError('Invalid truck capacity.');
          for(const k of ['dry','wet']) if(c[k]!=null&&!num(c[k],0,500)) throw new ValidationError('Truck capacity must be between 0 and 500 yd³.');
          cap[g]={dry:c.dry??null,wet:c.wet??null};
        }
        return {no,cap};
      });
    case 'shopify_ignore_titles':
      if(!Array.isArray(value)||value.length>500) throw new ValidationError('Up to 500 skipped titles.');
      return [...new Set(value.map(v=>cleanStr(v)).filter(Boolean))].map(s=>{ if(s.length>300) throw new ValidationError('Skipped titles must be 300 characters or fewer.'); return s; });
    default: throw new ValidationError('Unknown setting.');
  }
}
// Wrap an adapter so every write is validated first.
function withValidation(adapter){
  return Object.assign(Object.create(adapter),{
    async insert(t,row){
      // Demo-only: simulated Shopify orders are inserted directly in demo mode.
      if(adapter.mode==='demo'&&t==='shopify_order_lines') return adapter.insert(t,row);
      return adapter.insert(t,validateWrite(t,'insert',row));
    },
    async update(t,id,patch){
      if(!isId(id)) throw new ValidationError('Invalid record.');
      return adapter.update(t,id,validateWrite(t,'update',patch));
    },
    async setSetting(k,v){ return adapter.setSetting(k,validateSetting(k,v)); },
    async updateMany(t,ids,patch){
      if(!Array.isArray(ids)||!ids.length||ids.length>500||!ids.every(isId)) throw new ValidationError('Invalid records.');
      return adapter.updateMany(t,ids,validateWrite(t,'update',patch));
    },
    async linkTitle(pid,title){
      const t=cleanStr(title);
      if(!isId(pid)||!t||t.length>300) throw new ValidationError('Invalid link.');
      return adapter.linkTitle(pid,t);
    },
  });
}

/* Turn API / database errors into plain messages. Raw database errors are
   logged to the console only, never shown (OWASP A09: no internals in the UI). */
function friendlyError(e){
  if(e instanceof ValidationError) return e.message;
  const code=String(e?.code||''), msg=String(e?.message||''), status=Number(e?.status||0);
  if(code==='RL429'||status===429||/rate limit|too many/i.test(msg)) return 'You’re making changes too quickly. Wait about a minute and try again.';
  if(code==='42501'||/permission denied|row-level security/i.test(msg)) return 'Your account doesn’t have permission to do that.';
  if(code==='23514') return 'One of the values is outside the allowed range.';
  if(code==='22023'&&msg.length<160) return msg;     // our own guard messages are written for people
  if(code==='P0001'&&msg.length<160) return msg;     // RAISE EXCEPTION from our triggers
  if(code==='PGRST301'||/jwt expired/i.test(msg)) return 'Your sign-in expired. Reload the page and sign in again.';
  if(/failed to fetch|network/i.test(msg)) return 'Couldn’t reach the server. Check the connection and try again.';
  return 'Something went wrong. Try again.';
}

const ROLES = {
  // Ordering, scheduled deliveries and confirming deliveries all live on the Order Product tab.
  inventory:{label:'Inventory', tabs:['debris','yard','pulls','backfill','ledger','setup']},
  hauling:{label:'Bulk hauling', tabs:['debris','yard','backfill']},
  debris:{label:'Yard debris', tabs:['debris','yard','backfill']},   // Mike: debris side; retail read-only
  admin:{label:'Admin', tabs:['debris','yard','pulls','backfill','ledger','setup']},
  viewer:{label:'View only', tabs:['debris','yard','backfill']},
};
const TAB_LABELS = {yard:'Retail Bins', debris:'Yard Debris', pulls:'Draw', backfill:'Order Product', hauls:'Hauls', ledger:'Ledger', setup:'Setup'};
const DEMO_USERS = [
  {id:'u-jeff', name:'Jeff Davis', role:'inventory'},
  {id:'u-kevin', name:'Kevin Roemer', email:'kevinr@rexius.com', role:'hauling'},
  {id:'u-mike', name:'Mike', email:'mikeg@rexius.com', role:'debris'},
  {id:'u-admin', name:'Admin', role:'admin'},
];
const METHOD = {bulk:{label:'Bulk truck', who:'Kevin Roemer'}, slinger:{label:'Slinger', who:'Jeff Davis'}};

/* ---------- helpers ---------- */
const $ = (s,r=document)=>r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = ()=> (crypto.randomUUID ? crypto.randomUUID() : 'id-'+Math.random().toString(36).slice(2)+Date.now().toString(36));
const isoDay = (off=0)=>{const d=new Date(); d.setDate(d.getDate()+off); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
const nowISO = ()=> new Date().toISOString();
const r1 = n => Math.round((Number(n)||0)*10)/10;
const fmtN = n => r1(n).toLocaleString(undefined,{maximumFractionDigits:1});
const ydu = ()=> Number(S?.settings?.yd_per_unit) || 7.5;
const fmtYd = n => fmtN(n)+' yd³';
const fmtUnits = n => fmtN((Number(n)||0)/ydu())+' units';
const signed = n => (n>0?'+':n<0?'−':'')+fmtN(Math.abs(n));
function dayDiff(iso){ if(!iso) return null; const [y,m,d]=iso.slice(0,10).split('-').map(Number); const t=new Date(); return Math.round((new Date(y,m-1,d) - new Date(t.getFullYear(),t.getMonth(),t.getDate()))/864e5); }
function fmtDate(iso){
  if(!iso) return '—'; const diff=dayDiff(iso);
  if(diff===0) return 'Today'; if(diff===1) return 'Tomorrow'; if(diff===-1) return 'Yesterday';
  const [y,m,d]=iso.slice(0,10).split('-').map(Number);
  return new Date(y,m-1,d).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}
const whenDate = iso => { const t=fmtDate(iso); return /^(Today|Tomorrow|Yesterday)$/.test(t)?t.toLowerCase():t; };
const store = {
  get(k,f){ try{ const v=localStorage.getItem(k); return v==null?f:JSON.parse(v);}catch{ return f; } },
  set(k,v){ try{ localStorage.setItem(k,JSON.stringify(v)); }catch{} },
  del(k){ try{ localStorage.removeItem(k);}catch{} }
};
let toastT;
function toast(msg, err){ const t=$('#toast'); t.textContent=msg; t.className='toast'+(err?' err':''); t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>t.hidden=true, err?5000:2600); }

/* =============================================================
   Demo adapter — mirrors the database triggers in schema.sql
   ============================================================= */
/* HWY 99 bins from HWY_99_Bins.xlsx ("Current" sheet): [code, product, capacity yd³, map col, map row, width, height] */
const YARD_BINS=[["T1", "Econobark", 150, 2, 2, 1, 5],["T2", "Beautibark", 150, 3, 2, 1, 5],["T3", "Hemlock", 150, 4, 2, 1, 5],["T4", "Primary", 150, 5, 2, 1, 5],["T5", "Flower-n-Garden", 150, 6, 2, 1, 5],["T6", "Turf Start", 150, 7, 2, 1, 5],["T7", "Promix", 150, 8, 2, 1, 5],["L1", "1/4 Minus", 60, 1, 11, 1, 3],["L2", "3/4 Minus", 60, 1, 14, 1, 3],["L3", "3/4 Open", 60, 1, 17, 1, 3],["L4", "3/8 Round", 60, 1, 20, 1, 3],["L5", "3/4 Round", 60, 1, 23, 1, 3],["L6", "1.5 Round", 60, 1, 26, 1, 3],["L7", "Decomposed Granite", 60, 1, 29, 1, 3],["L8", "Beach Sand", 60, 1, 32, 1, 3],["L9", "Pumice", 60, 1, 35, 1, 3],["M1", "LFNW", 90, 6, 8, 1, 3],["M2", "GVO Compost", 90, 6, 11, 1, 3],["M3", "GVO Compost", 90, 6, 14, 1, 4],["M4", "Opus 3", 60, 6, 18, 1, 2],["M5", "Opus Biotope", 60, 6, 20, 1, 2],["M6", "Opus 1", 90, 6, 22, 1, 4],["M7", "GVO NO Potting", 90, 6, 26, 1, 4],["M8", "Loam", 90, 6, 30, 1, 4],["M9", "Garden Sand", 90, 6, 34, 1, 4],["R1", "Alder Sawdust", 60, 7, 9, 1, 2],["R2", "Sawdust", 90, 7, 11, 1, 3],["R3", "Red Ultrakote", 90, 7, 14, 1, 4],["R4", "Black Ultrakote", 90, 7, 18, 1, 4],["R5", "Patio Potting Soil", 90, 7, 22, 1, 4],["R6", "Steer Plus", 90, 7, 26, 1, 4],["R7", "Decobark Nuggets", 90, 7, 30, 1, 4],["R8", "Fiberex", 90, 7, 34, 1, 4],["R9", "GVO With Worm Castings", 90, 7, 38, 1, 4],["E1", null, 60, 8, 40, 1, 2]];
/* Yard product → Shopify product title (from products_export.csv) */
const SHOPIFY_TITLES={"Econobark": "Econo-Bark", "Beautibark": "BeautiBark", "Hemlock": "Premium Hemlock", "Primary": "Primary Planting Soil", "Flower-n-Garden": "Flower-n-Garden", "Turf Start": "Premium Turf Start", "Promix": "Pro Mix", "1/4 Minus": "1/4\" Minus", "3/4 Minus": "3/4\" Minus", "3/4 Open": "3/4 Open", "3/8 Round": "3/8\" Round Pea Gravel", "Decomposed Granite": "Decomposed Granite", "Beach Sand": "Beach Sand", "Pumice": "Pumice", "LFNW": "Love Food Not Waste Compost", "GVO Compost": "G.V.O. Organic Compost", "Opus 3": "Opus Grows Mix #3", "Opus Biotope": "Opus Grows Bio-Tope", "Opus 1": "Opus Grows Mix #1", "GVO NO Potting": "G.V All Natural & Organic Potting Soil", "Loam": "Loam", "Garden Sand": "Garden Sand", "Sawdust": "Fresh Sawdust", "Patio Potting Soil": "Patio Potting Soil", "Steer Plus": "Steer Plus", "Decobark Nuggets": "DecoBark Nuggets", "Fiberex": "Fiberex", "GVO With Worm Castings": "G.V.O. Potting Soil w/Worm Castings", "1.5 Round": "1.5 Round", "Red Ultrakote": "UltraKote", "Black Ultrakote": "UltraKote", "3/4 Round": "3/4\" Round", "Alder Sawdust": "Alder Sawdust"};
const SHOPIFY_VARIANT={"Red Ultrakote":"Red","Black Ultrakote":"Black"};
/* Bulk trucks Kevin dispatches (Trucks_and_Hauling.xlsx). Capacity per load in yd³, by product haul group. */
const DEFAULT_TRUCKS=[{"no": "85", "cap": {"bark": {"dry": 37.5, "wet": 37.5}, "sawdust": {"dry": 37.5, "wet": 37.5}, "primary": {"dry": 22.5, "wet": 18.75}, "fng": {"dry": 18.75, "wet": 15.0}, "turf": {"dry": 18.75, "wet": 15.0}, "compost": {"dry": 30, "wet": 25}}}, {"no": "98", "cap": {"bark": {"dry": 60.0, "wet": 48.75}, "primary": {"dry": 45.0, "wet": 37.5}, "fng": {"dry": 37.5, "wet": 30.0}, "turf": {"dry": 37.5, "wet": 30.0}, "compost": {"dry": 52.5, "wet": 45.0}}}];
const HAUL_GROUPS={"bark": "Barks / Fiberex", "sawdust": "Sawdust", "primary": "Primary", "fng": "Flower-n-Garden", "turf": "Turf Start", "compost": "Compost"};
const PRODUCT_HAUL_GROUP={"Econobark": "bark", "Beautibark": "bark", "Hemlock": "bark", "Decobark Nuggets": "bark", "Red Ultrakote": "bark", "Black Ultrakote": "bark", "Fiberex": "bark", "Sawdust": "sawdust", "Alder Sawdust": "sawdust", "Primary": "primary", "Flower-n-Garden": "fng", "Turf Start": "turf", "GVO Compost": "compost", "LFNW": "compost", "Steer Plus": "compost"};
const SHOPIFY_IGNORE=["Grass Seed", "Coir Fibre", "Chicken Compost", "Perlite", "3.8Ft Peat Moss", "Christmas Tree Fees", "Dump Card", "Bio-Bags", "Sand Bags", "Tip Fees-Curbside NEW", "Tip Fees-Food Waste NEW", "Bags", "Sanipac", "Chip Truck", "Opus Grows Mix #2", "Opus Grows Mix Zero", "Worm Castings", "Filled Tote"];
const YARD_LANDMARKS=[{"label": "Scale booth", "x": 3, "y": 29, "w": 1, "h": 3, "kind": "booth"}, {"label": "Bagged goods", "x": 6, "y": 43, "w": 1, "h": 4, "kind": "bags"}];
/* Yard Debris piles: [code, product, role, map column, Shopify "Tip Fees" variant] */
/* Layout (10-column grid): Wood Debris over Ground Debris at the top; Green Waste and Excavation side by side below. */
const DEBRIS_BINS=[["WOOD","Wood Debris","grind",[3,1,4,5],"Wood Waste"],["GROUND","Ground Debris","ground",[3,7,4,5],null],["GREEN","Green Waste","grind",[2,15,4,5],"Yard Debris"],["EXC","Excavation","dump",[7,15,4,5],"Dirt and Rock"]];
function seedDemo(){
  const names=[...new Set(YARD_BINS.map(b=>b[1]).filter(Boolean))];
  const prods=names.map(n=>({id:uid(),name:n,sku:null,shopify_product_id:null,shopify_titles:SHOPIFY_TITLES[n]?[SHOPIFY_TITLES[n]]:[],shopify_variant_match:SHOPIFY_VARIANT[n]||null,haul_group:PRODUCT_HAUL_GROUP[n]||null,active:true,created_at:nowISO()}));
  const pid=n=>prods.find(p=>p.name===n)?.id||null;
  const bins=YARD_BINS.map(([code,name,cap,x,y,w,h],i)=>({id:uid(),code,product_id:pid(name),capacity_yd:cap,reorder_yd:r1(cap*.25),sort:i,active:true,notes:'',map_x:x,map_y:y,map_w:w,map_h:h,site:'retail',debris_role:null,created_at:nowISO()}));
  DEBRIS_BINS.forEach(([code,name,role,[x,y,w,h],variant],i)=>{
    const p={id:uid(),name,sku:null,shopify_product_id:null,shopify_titles:variant?['Tip Fees']:[],shopify_variant_match:variant,haul_group:null,active:true,created_at:nowISO()};
    prods.push(p);
    bins.push({id:uid(),code,product_id:p.id,capacity_yd:100,reorder_yd:0,sort:101+i,active:true,notes:'',map_x:x,map_y:y,map_w:w,map_h:h,site:'debris',debris_role:role,created_at:nowISO()});
  });
  const B=c=>bins.find(b=>b.code===c);
  const mv=[]; const M=(bin,qty,kind,note,day,by='Jeff Davis')=>mv.push({id:uid(),created_at:new Date(Date.now()+day*864e5).toISOString(),occurred_on:isoDay(day),bin_id:bin.id,product_id:bin.product_id,qty_yd:qty,kind,note,created_by_name:by});
  // Example opening levels (share of capacity) — demo only
  const frac=[.42,.48,.31,.55,.7,.33,.8, .4,.24,.66,.5,.72,.3,.58,.85,.44, .5,.36,.6,.75,.18,.52,.47,.63,.29, .55,.69,.41,.37,.8,.5,.22,.6,.45];
  bins.forEach((b,i)=>{ if(b.product_id&&b.site!=='debris') M(b,r1(b.capacity_yd*(frac[i]??.5)),'count','Opening count (example)',-6); });
  M(B('T2'),-5,'shopify','Shopify #R4790',-3,'Shopify'); M(B('R6'),-4,'shopify','Shopify #R4801',-1,'Shopify');
  M(B('T3'),-15,'internal','Internal order — Eugene Blowers · Santa Clara',-1);
  M(B('T1'),60,'backfill','Truck 98',-1,'Kevin Roemer'); M(B('T1'),15,'backfill','Truck 85',-1,'Kevin Roemer');
  M(B('M2'),-7.5,'internal','Internal order — CAS · WO-2287',0);
  // Yard Debris: opening counts, then example intake / grind / removal / tip fee
  [['EXC',42],['GREEN',63],['WOOD',28],['GROUND',55]].forEach(([c,q])=>M(B(c),q,'count','Opening count (example)',-6));
  const DE=(kind,code,qty,day,status,x={})=>({id:uid(),created_at:new Date(Date.now()+Math.min(day,0)*864e5).toISOString(),kind,bin_id:B(code).id,qty_yd:qty,to_bin_id:null,to_qty_yd:null,source:null,hauler:null,loads:null,happened_on:isoDay(day),status,done_at:status==='done'?nowISO():null,notes:null,created_by_name:'Mike',...x});
  const debris=[
    DE('removal','GROUND',30,1,'scheduled',{hauler:'98',loads:1,created_by_name:'Kevin Roemer'}),
    DE('intake','GREEN',6,-1,'done',{source:'Eugene Blowers crew',created_by_name:'Jeff Davis'}),
    DE('grind','GREEN',20,-1,'done',{to_bin_id:B('GROUND').id,to_qty_yd:9}),
    DE('removal','EXC',12,-2,'done',{hauler:'85',loads:1,created_by_name:'Kevin Roemer'}),
  ];
  const sm=(e,bin,qty,kind,note)=>{ M(bin,qty,kind,note,Math.min(0,dayDiff(e.happened_on)),e.created_by_name); mv[mv.length-1].source_table='debris_events'; mv[mv.length-1].source_id=e.id; };
  sm(debris[1],B('GREEN'),6,'intake','Debris in — Eugene Blowers crew');
  sm(debris[2],B('GREEN'),-20,'grind','Ground into GROUND'); sm(debris[2],B('GROUND'),9,'grind','Ground from GREEN');
  sm(debris[3],B('EXC'),-12,'removal','Hauled away — Truck 85');
  M(B('GREEN'),2,'shopify','Shopify #R4826',0,'Shopify');
  M(B('T3'),-3,'shopify','Shopify #R4823',0,'Shopify'); M(B('T2'),-5,'shopify','Shopify #R4824',0,'Shopify'); M(B('M2'),-4,'shopify','Shopify #R4825',0,'Shopify');
  mv.sort((a,b)=>b.created_at.localeCompare(a.created_at));

  const io=[
    {customer:'Eugene Blowers',reference:'Santa Clara',bin:'T3',qty:15,pull_on:isoDay(-1),status:'pulled',notes:''},
    {customer:'CAS',reference:'WO-2287',bin:'M2',qty:7.5,pull_on:isoDay(0),status:'pulled',notes:''},
  ].map(o=>({id:uid(),created_at:nowISO(),customer:o.customer,reference:o.reference,bin_id:B(o.bin).id,product_id:B(o.bin).product_id,qty_yd:o.qty,pull_on:o.pull_on,status:o.status,pulled_at:o.status==='pulled'?nowISO():null,notes:o.notes,created_by_name:'Jeff Davis'}));

  const L=(order,cust,bin,variant,qty,day,status='pulled',shopId)=>{
    const b=bin?B(bin):null; const p=b?prods.find(x=>x.id===b.product_id):null; const yd=parseFloat(variant)||null;
    const at=new Date(Date.now()+day*864e5).toISOString();
    return {id:uid(),created_at:at,order_name:order,customer_name:cust,ordered_at:at,shopify_product_id:shopId??p?.shopify_product_id??null,product_id:p?.id??null,
      title:p?(p.shopify_titles[0]||p.name):'3/4" Round',variant_title:p?.shopify_variant_match?p.shopify_variant_match+' / '+variant:variant,quantity:qty,yd_each:yd,qty_yd:yd?yd*qty:null,bin_id:b?b.id:null,status,pulled_at:status==='pulled'?at:null};
  };
  const lines=[
    L('#R4823','M. Alvarez','T3','3',1,0),
    L('#R4824','D. Okafor','T2','1',5,0),
    L('#R4825','S. Lindqvist','M2','1',4,0),
    L('#R4801','J. Moreno','R6','1',4,-1,'pulled'),
    L('#R4826','K. Patel','GREEN','1',2,0),
  ];

  const req=(bin,qty,needed,method,status,notes)=>({id:uid(),created_at:nowISO(),bin_id:B(bin).id,product_id:B(bin).product_id,qty_yd:qty,needed_by:isoDay(needed),method,status,notes,created_by_name:'Jeff Davis'});
  const rq=[req('M2',60,1,'bulk','scheduled','Two loads if possible'),req('L2',30,3,'slinger','requested',''),req('T1',75,-1,'bulk','delivered','')];
  const H=(r,truck,vol,day,status)=>({id:uid(),created_at:nowISO(),request_id:r.id,method:r.method,truck_no:truck,loads:1,conditions:'dry',bin_id:r.bin_id,product_id:r.product_id,volume_yd:vol,haul_on:isoDay(day),status,delivered_at:status==='delivered'?nowISO():null,created_by_name:'Kevin Roemer'});
  const hauls=[H(rq[2],'98',60,-1,'delivered'),H(rq[2],'85',15,-1,'delivered'),H(rq[0],'85',30,1,'scheduled')];

  return {v:16,debris_events:debris,userId:'u-jeff',settings:{yd_per_unit:7.5,tote_sizes:[1,1.5],trucks:DEFAULT_TRUCKS,yard_landmarks:YARD_LANDMARKS,shopify_ignore_titles:SHOPIFY_IGNORE},products:prods,bins,movements:mv,internal_orders:io,shopify_order_lines:lines,backfill_requests:rq,hauls};
}

function DemoAdapter(){
  const KEY='ryt-demo-v16';
  let db=store.get(KEY,null); if(!db||db.v!==16){ db=seedDemo(); }
  const save=()=>store.set(KEY,db);
  const me=()=>DEMO_USERS.find(u=>u.id===db.userId)||DEMO_USERS[0];
  const defaultBin=pid=>db.bins.filter(b=>b.active!==false&&b.product_id===pid).sort((a,b)=>(a.sort-b.sort)||a.code.localeCompare(b.code))[0]?.id||null;
  const move=m=>db.movements.unshift({id:uid(),created_at:nowISO(),occurred_on:isoDay(),created_by_name:me().name,...m});
  function syncReq(rid){
    const r=db.backfill_requests.find(x=>x.id===rid); if(!r||r.status==='cancelled') return;
    const hs=db.hauls.filter(h=>h.request_id===rid);
    const del=hs.filter(h=>h.status==='delivered').reduce((s,h)=>s+Number(h.volume_yd),0);
    r.status = del>=r.qty_yd ? 'delivered' : hs.some(h=>['en_route','delivered'].includes(h.status)) ? 'in_progress' : hs.some(h=>h.status==='scheduled') ? 'scheduled' : 'requested';
  }
  function pullTrigger(t,row,old){
    if(t==='internal_orders'||t==='shopify_order_lines'){
      const isShop=t==='shopify_order_lines';
      const label=isShop?'Shopify '+row.order_name:'Internal order — '+row.customer+(row.reference?' · '+row.reference:'');
      const sign=id=>isShop&&db.bins.find(b=>b.id===id)?.site==='debris'?1:-1;   // tip fees add to debris piles
      if(row.status==='pulled'&&old.status!=='pulled'){
        if(!row.product_id||row.qty_yd==null) throw new Error('Link this Shopify product before it can draw from inventory');
        row.bin_id=row.bin_id||defaultBin(row.product_id);
        if(!row.bin_id) throw new Error('No bin is set up for this product');
        row.pulled_at=nowISO();
        move({bin_id:row.bin_id,product_id:row.product_id,qty_yd:sign(row.bin_id)*row.qty_yd,kind:isShop?'shopify':'internal',note:label,...(isShop&&!old.status?{created_by_name:'Shopify'}:{})});
      } else if(old.status==='pulled'&&row.status!=='pulled'){
        move({bin_id:old.bin_id,product_id:old.product_id,qty_yd:-sign(old.bin_id)*Number(old.qty_yd),kind:'adjustment',note:(row.status==='cancelled'&&isShop?'Order cancelled — ':isShop?'Reversed draw — ':'Order undone — ')+label});
        row.pulled_at=null;
      }
    }
    if(t==='debris_events'){
      // Mirrors trg_debris_event() in schema.sql
      const b=db.bins.find(x=>x.id===row.bin_id), tb=db.bins.find(x=>x.id===row.to_bin_id);
      if(!b||b.site!=='debris') throw new Error('Choose a Yard Debris bin');
      if(row.kind==='intake'&&b.debris_role==='ground') throw new Error('Ground debris is only added to by grinding');
      if(row.kind==='grind'&&(b.debris_role!=='grind'||!tb||tb.debris_role!=='ground')) throw new Error('Only green waste and wood debris are ground, onto the ground debris pile');
      if(row.status==='scheduled'&&row.kind!=='removal') throw new Error('Only removals can be scheduled');
      if(old.status&&!((old.status==='scheduled'&&['done','cancelled'].includes(row.status))||(old.status==='done'&&row.status==='cancelled'))) throw new Error('That change is not allowed');
      const who=/^\d+$/.test(row.hauler||'')?'Truck '+row.hauler:row.hauler;
      const M=(bin,q,kind,note,extra={})=>move({bin_id:bin.id,product_id:bin.product_id,qty_yd:q,kind,note,source_table:'debris_events',source_id:row.id,...extra});
      if(row.status==='done'&&old.status!=='done'){
        row.done_at=nowISO(); const on={occurred_on:row.happened_on};
        if(row.kind==='intake') M(b,Number(row.qty_yd),'intake','Debris in'+(row.source?' — '+row.source:''),on);
        else if(row.kind==='grind'){ M(b,-Number(row.qty_yd),'grind','Ground into '+tb.code,on); M(tb,Number(row.to_qty_yd),'grind','Ground from '+b.code,on); }
        else M(b,-Number(row.qty_yd),'removal','Hauled away'+(who?' — '+who:''),on);
      } else if(old.status==='done'&&row.status!=='done'){
        row.done_at=null;
        if(row.kind==='grind'){ M(b,Number(old.qty_yd),'adjustment','Grind undone'); M(tb,-Number(old.to_qty_yd),'adjustment','Grind undone'); }
        else M(b,(row.kind==='intake'?-1:1)*Number(old.qty_yd),'adjustment',row.kind==='intake'?'Debris in undone':'Removal undone');
      }
    }
    if(t==='hauls'){
      if(row.status==='delivered'&&old.status!=='delivered'){
        row.delivered_at=nowISO();
        move({bin_id:row.bin_id,product_id:row.product_id,qty_yd:Number(row.volume_yd),kind:'backfill',note:'Truck '+row.truck_no+(row.method==='slinger'?' (slinger)':''),occurred_on:row.haul_on});
      } else if(old.status==='delivered'&&row.status!=='delivered'){
        row.delivered_at=null;
        move({bin_id:old.bin_id,product_id:old.product_id,qty_yd:-Number(old.volume_yd),kind:'adjustment',note:'Reversed delivery — Truck '+old.truck_no});
      }
      if(row.request_id) syncReq(row.request_id);
      if(old.request_id&&old.request_id!==row.request_id) syncReq(old.request_id);
    }
  }
  return {
    mode:'demo',
    async load(){
      const onHand={}; db.movements.forEach(m=>{onHand[m.bin_id]=(onHand[m.bin_id]||0)+Number(m.qty_yd);});
      return {products:db.products,bins:db.bins,onHand,movements:db.movements.slice(0,400),internalOrders:db.internal_orders,
        shopifyLines:db.shopify_order_lines,backfills:db.backfill_requests,hauls:db.hauls,debris:db.debris_events,settings:db.settings,me:me()};
    },
    async insert(t,row){
      if(['internal_orders','backfill_requests','hauls'].includes(t)&&db.bins.find(b=>b.id===row.bin_id)?.site==='debris') throw new Error('Yard Debris bins are managed on the Yard Debris tab');
      const tmpl={id:uid(),created_at:nowISO(),created_by_name:me().name};
      const r={...tmpl,...row};
      if(t==='hauls'||t==='shopify_order_lines'||t==='internal_orders'||t==='debris_events'){ pullTrigger(t,r,{status:''}); db[t].unshift(r); }
      else db[t].unshift(r);
      save(); return r;
    },
    async update(t,id,patch){
      const r=db[t].find(x=>x.id===id); if(!r) throw new Error('Record not found');
      const old={...r}; const next={...r,...patch};
      pullTrigger(t,next,old); Object.assign(r,next); save();
    },
    async setSetting(k,v){ db.settings[k]=v; save(); },
    async updateMany(t,ids,patch){ for(const id of ids) await this.update(t,id,patch); },
    async linkTitle(pid,title){
      for(const l of db.shopify_order_lines.filter(x=>x.status==='unmapped'&&x.yd_each&&String(x.title).toLowerCase()===title.toLowerCase()))
        await this.update('shopify_order_lines',l.id,{product_id:pid,qty_yd:r1(l.yd_each*l.quantity),status:'pulled'});
    },
    setUser(id){ db.userId=id; save(); },
    reset(){ db=seedDemo(); save(); },
  };
}

/* =============================================================
   Live adapter — Supabase
   ============================================================= */
function LiveAdapter(cfg){
  // persistSession keeps people signed in on yard devices; tokens are short-lived JWTs that
  // auto-refresh. The CSP in index.html limits where scripts can come from, which is what
  // protects these stored tokens from injected script (OWASP A03/A07).
  // All Retail Yard data lives in its own `yard` schema inside the shared production project,
  // so it never collides with another app's tables in `public`.
  const sb=window.supabase.createClient(cfg.url,cfg.key,{db:{schema:DB_SCHEMA},auth:{persistSession:true,autoRefreshToken:true}});
  const q=p=>p.then(({data,error})=>{ if(error) throw error; return data; });
  return {
    mode:'live', sb,
    async session(){ const {data}=await sb.auth.getSession(); return data.session; },
    // Email + password sign-in. No emails are sent. Accounts are created by an admin in
    // Supabase (the sign-in pool is shared with other production apps); access to the yard
    // additionally requires a row in yard.user_invites.
    async signInPassword(email,password){ const {error}=await sb.auth.signInWithPassword({email,password}); if(error) throw error; },
    async changePassword(password){ const {error}=await sb.auth.updateUser({password}); if(error) throw error; },
    async ensureProfile(){ const {data,error}=await sb.rpc('ensure_profile'); if(error) throw error; return data; },
    async signOut(){ await sb.auth.signOut(); },
    async load(){
      const {data:{user}}=await sb.auth.getUser();
      const [products,bins,levels,movements,internalOrders,lines,backfills,hauls,debris,settings,profile]=await Promise.all([
        q(sb.from('products').select('*').order('name')),
        q(sb.from('bins').select('*').order('sort').order('code')),
        q(sb.from('bin_on_hand').select('*')),
        q(sb.from('movements').select('*').order('created_at',{ascending:false}).limit(400)),
        q(sb.from('internal_orders').select('*').order('created_at',{ascending:false}).limit(500)),
        q(sb.from('shopify_order_lines').select('*, shopify_orders(order_name,customer_name,created_at_shopify)').order('created_at',{ascending:false}).limit(500)),
        q(sb.from('backfill_requests').select('*').order('created_at',{ascending:false}).limit(300)),
        q(sb.from('hauls').select('*').order('haul_on',{ascending:false}).limit(500)),
        q(sb.from('debris_events').select('*').order('created_at',{ascending:false}).limit(500)),
        q(sb.from('settings').select('*')),
        q(sb.from('profiles').select('*').eq('id',user.id).maybeSingle()),
      ]);
      const onHand={}; levels.forEach(l=>onHand[l.bin_id]=Number(l.on_hand_yd));
      const shopifyLines=lines.map(l=>({...l,order_name:l.shopify_orders?.order_name,customer_name:l.shopify_orders?.customer_name,ordered_at:l.shopify_orders?.created_at_shopify||l.created_at}));
      const st={}; settings.forEach(s=>st[s.key]=s.value);
      return {products,bins,onHand,movements,internalOrders,shopifyLines,backfills,hauls,debris,settings:st,
        me:{id:user.id,name:profile?.full_name||user.email,role:profile?.role||null}};
    },
    async insert(t,row){ const clean={...row}; delete clean.created_by_name; return q(sb.from(t).insert(clean).select().single()); },
    async update(t,id,patch){ return q(sb.from(t).update(patch).eq('id',id)); },
    async setSetting(k,v){ return q(sb.from('settings').upsert({key:k,value:v})); },
    async updateMany(t,ids,patch){ return q(sb.from(t).update(patch).in('id',ids)); },
    async linkTitle(pid,title){ return q(sb.rpc('link_shopify_title',{p_product_id:pid,p_title:title})); },
    // Live updates. onStatus is told when the channel connects or drops, so the app can reconnect.
    subscribe(cb,onStatus){
      const ch=sb.channel('yard-'+Date.now()).on('postgres_changes',{event:'*',schema:DB_SCHEMA},cb)
        .subscribe(st=>onStatus&&onStatus(st));
      return ()=>{ try{ sb.removeChannel(ch); }catch{} };
    },
  };
}

/* =============================================================
   State + derived figures
   ============================================================= */
let A=null, S=null, D=null;
const UI=Object.assign({yardView:'map',selBin:null,binMode:'view',tab:'debris',pullFilter:'all',bfFilter:'all',haulFilter:'upcoming',ledgerBin:'',openHaulFor:null,editBin:null,editProduct:null,mapLine:null},
  {tab:store.get('ryt-tab','yard'),yardView:store.get('ryt-yardview','map')});

const role=()=>S.me.role;
const has=(...r)=>r.includes(role());
const can={
  pull:()=>has('inventory','admin'),
  order:()=>has('inventory','admin'),
  request:()=>has('inventory','admin'),
  dispatch:m=> m==='bulk' ? has('hauling','admin') : has('inventory','admin'),
  haul:()=>has('hauling','inventory','admin'),
  confirmDelivery:()=>has('inventory','admin'),   // Jeff (and admins) confirm deliveries; that's what adds product to the bin
  adjust:()=>has('inventory','admin'),
  setup:()=>has('inventory','admin'),
  binCapacity:()=>has('hauling','inventory','admin'),
  debris:()=>has('admin','inventory','hauling','debris'),   // Yard Debris: Jeff, Kevin, Mike, admins
};
const tabsFor=()=> (ROLES[role()]||ROLES.viewer).tabs;

function derive(){
  const d={};
  d.product=Object.fromEntries(S.products.map(p=>[p.id,p]));
  d.bin=Object.fromEntries(S.bins.map(b=>[b.id,b]));
  const liveBins=S.bins.filter(b=>b.active!==false).sort((a,b)=>(a.sort-b.sort)||a.code.localeCompare(b.code));
  // activeBins = the retail side (everything the Retail Bins / Draw / Order Product tabs use).
  const activeBins=liveBins.filter(b=>b.site!=='debris');
  d.activeBins=activeBins;
  d.debrisBins=liveBins.filter(b=>b.site==='debris');
  d.allBins=liveBins;
  S.debris=S.debris||[];
  d.defaultBin=pid=>activeBins.find(b=>b.product_id===pid)?.id||null;
  d.lineBin=l=>l.bin_id||d.defaultBin(l.product_id);
  const out={}, inc={};
  // "Out" = drawn today (Shopify + internal, net of same-day reversals)
  const todayMv=S.movements.filter(m=>(m.occurred_on||m.created_at.slice(0,10))===isoDay()&&d.bin[m.bin_id]?.site!=='debris');
  todayMv.forEach(m=>{ if(['shopify','internal'].includes(m.kind)||(m.kind==='adjustment'&&/^(Order undone|Order cancelled|Reversed draw|Reversed pull)/.test(m.note||''))) out[m.bin_id]=(out[m.bin_id]||0)-Number(m.qty_yd); });
  const openHauls=S.hauls.filter(h=>['scheduled','en_route'].includes(h.status));
  openHauls.forEach(h=>{ inc[h.bin_id]=(inc[h.bin_id]||0)+Number(h.volume_yd); });
  const openReqBins=new Set(S.backfills.filter(r=>!['delivered','cancelled'].includes(r.status)).map(r=>r.bin_id));
  d.stats={};
  liveBins.forEach(b=>{
    const onHand=r1(S.onHand[b.id]||0), o=Math.max(0,r1(out[b.id]||0)), i=r1(inc[b.id]||0), proj=r1(onHand+i);
    const re=Number(b.reorder_yd)||0, cap=Number(b.capacity_yd)||0;
    let st='ok';
    if(!b.product_id) st='empty';
    else if(b.site==='debris') st='debris';   // no low / full warnings on the debris piles (for now)
    else if(onHand<=0) st='out';
    else if(onHand<=re) st='low';
    else if(cap&&onHand>cap) st='over';
    d.stats[b.id]={onHand,out:o,inc:i,proj,st,hasReq:openReqBins.has(b.id),avail:onHand};
  });
  d.openHauls=openHauls;
  d.unmapped=S.shopifyLines.filter(l=>l.status==='unmapped');
  d.drawnToday=r1(Object.values(out).reduce((a,v)=>a+Math.max(0,v),0));
  const isRev=m=>m.kind==='adjustment'&&/^(Order undone|Order cancelled|Reversed draw|Reversed pull)/.test(m.note||'');
  d.ordersToday=Math.max(0,todayMv.filter(m=>['shopify','internal'].includes(m.kind)).length-todayMv.filter(isRev).length);
  d.shopToday=r1(todayMv.filter(m=>m.kind==='shopify'&&(m.occurred_on||m.created_at.slice(0,10))===isoDay()).reduce((s,m)=>s-Number(m.qty_yd),0));
  D=d;
}
const ST_CHIP={debris:['Yard debris','c-mute'],ok:['OK','c-ok'],low:['Low','c-warn'],watch:['Watch','c-warn'],out:['Out','c-bad'],over:['Over cap','c-info'],empty:['No product','c-mute']};
const prodName=id=>D.product[id]?.name||'Unassigned';
const binLabel=id=>{ const b=D.bin[id]; return b?b.code:'—'; };

/* ---------- shared fragments ---------- */
function productOptions(sel){
  return `<option value="">Choose a product</option>`+S.products.filter(p=>p.active!==false&&D.defaultBin(p.id)).sort((x,y)=>x.name.localeCompare(y.name))
    .map(p=>`<option value="${p.id}" ${p.id===sel?'selected':''}>${esc(p.name)}</option>`).join('');
}
function binOptions(sel, {blank='Choose a bin', withLevel=true, bins=D.activeBins}={}){
  return `<option value="">${esc(blank)}</option>`+bins.filter(b=>b.product_id).map(b=>{
    const s=D.stats[b.id];
    return `<option value="${b.id}" ${b.id===sel?'selected':''}>${esc(prodName(b.product_id))} — ${esc(b.code)}${withLevel?` (${fmtN(s.onHand)} yd³)`:''}</option>`;
  }).join('');
}
function qtyField(name='qty', label='Volume', val=''){
  return `<label class="field wide"><span>${label}</span><div class="qty">
    <input id="${name}-${UI.tab}" name="${name}" type="number" step="0.5" min="0.5" required value="${esc(val)}" inputmode="decimal">
    <select name="${name}_unit" aria-label="Unit"><option value="yd">yd³</option><option value="unit">units (${fmtN(ydu())} yd³)</option></select>
  </div></label>`;
}
const toYd=(fd,name='qty')=> r1(Number(fd.get(name))*(fd.get(name+'_unit')==='unit'?ydu():1));
function gauge(b,s){
  const cap=Math.max(Number(b.capacity_yd)||1,1), pct=Math.max(0,Math.min(1,s.onHand/cap));
  const base=56, H=44, y=base-pct*H, ry=base-Math.min(1,(Number(b.reorder_yd)||0)/cap)*H;
  const id='g'+String(b.id).replace(/[^a-z0-9]/gi,'');
  return `<svg class="gauge" viewBox="0 0 140 62" role="img" aria-label="${esc(b.code)} is ${Math.round(pct*100)}% full">
    <defs><clipPath id="${id}"><polygon points="16,56 52,12 88,12 124,56"/></clipPath></defs>
    <rect class="g-wall" x="2" y="12" width="9" height="44" rx="1"/><rect class="g-wall" x="129" y="12" width="9" height="44" rx="1"/>
    <polygon class="g-empty" points="16,56 52,12 88,12 124,56"/>
    <rect class="g-fill" clip-path="url(#${id})" x="0" y="${y.toFixed(1)}" width="140" height="${(base-y).toFixed(1)}"/>
    <line class="g-re" x1="12" x2="128" y1="${ry.toFixed(1)}" y2="${ry.toFixed(1)}"/>
    <line class="g-ground" x1="0" x2="140" y1="56.75" y2="56.75"/>
  </svg>`;
}
function statusChip(s){
  const map={open:['Open','c-acc'],pulled:['Pulled','c-ok'],cancelled:['Cancelled','c-mute'],pending:['To pull','c-acc'],unmapped:['Needs mapping','c-warn'],ignored:['Ignored','c-mute'],
    requested:['Requested','c-warn'],scheduled:['Scheduled','c-info'],in_progress:['In progress','c-info'],delivered:['Delivered','c-ok'],en_route:['En route','c-info'],confirmed:['Delivered ✓','c-ok']};
  const [t,c]=map[s]||[s,'c-mute']; return `<span class="chip ${c}">${esc(t)}</span>`;
}
const confirmBtn=(act,label,attrs,cls='')=>`<button class="btn sm ${cls}" data-act="${act}" data-confirm="${esc(label)}" ${attrs}>${esc(label)}</button>`;

/* =============================================================
   Views
   ============================================================= */
const VIEWS={};

/* ---------- Yard ---------- */
VIEWS.yard={
  shell:()=>`<section class="view">
    <div class="summary" data-dyn="ySummary"></div>
    <div class="split">
      <div class="sec">
        <div class="sec-head"><h2>Product Yard</h2>
          ${can.order()?'<button class="btn sm take" data-act="drawFor">Take out product</button>':''}
          ${can.request()?'<button class="btn sm order" data-act="orderFor">Order product</button>':''}
          <div class="filters" data-dyn="yToggle"></div></div>
        <div class="map-legend"><span><i class="lg-ok"></i>OK</span><span><i class="lg-warn"></i>Low</span><span><i class="lg-bad"></i>Out</span><span>Shading = fill level · ▼ drawn today · ▲ hauls coming</span></div>
        <div data-dyn="yBins"></div>
      </div>
      <aside class="sec">
        <div data-dyn="yDetail" id="bin-detail"></div>
        <h2>Needs attention</h2><div class="alerts" data-dyn="yAlerts"></div>
        <h2>Next 7 days</h2><div data-dyn="yUpcoming"></div>
      </aside>
    </div></section>`,
  dyn:{
    ySummary(){
      const st=D.activeBins.map(b=>D.stats[b.id]);
      const total=st.reduce((s,x)=>s+x.onHand,0), out=st.reduce((s,x)=>s+x.out,0), inc=st.reduce((s,x)=>s+x.inc,0);
      const cap=D.activeBins.reduce((s,b)=>s+(Number(b.capacity_yd)||0),0);
      const low=st.filter(x=>['low','out','watch'].includes(x.st)).length;
      return `<div><span class="k">On hand</span><span class="v num">${fmtN(total)}<small>yd³</small></span><span class="s">${cap?Math.round(total/cap*100):0}% of ${fmtN(cap)} yd³ capacity · ${D.activeBins.length} bins</span></div>
        <div><span class="k">Drawn today</span><span class="v num">${fmtN(D.drawnToday)}<small>yd³</small></span><span class="s">${D.ordersToday} orders · ${fmtN(D.shopToday)} yd³ from Shopify</span></div>
        <div><span class="k">Incoming</span><span class="v num">${fmtN(inc)}<small>yd³</small></span><span class="s">${D.openHauls.length} hauls scheduled or en route</span></div>
        <div><span class="k">Bins to watch</span><span class="v num">${low}</span><span class="s">At or below reorder point</span></div>`;
    },
    yToggle(){ return [['map','Map'],['list','List']].map(([k,l])=>`<button data-act="yardView" data-v="${k}" aria-pressed="${UI.yardView===k}">${l}</button>`).join(''); },
    yBins(){
      if(!D.activeBins.length) return `<div class="empty panel">No bins yet. Add your bins in Setup.</div>`;
      if(UI.yardView==='list') return `<div class="bins">${D.activeBins.map(binCard).join('')}</div>`;
      return yardMap();
    },
    yDetail(){
      return `<div class="empty panel" style="padding:14px">Tap a bin on the map to take out or order product.</div>`;
    },
    yAlerts(){
      const items=[];
      if(has('inventory','admin')){
        D.activeBins.forEach(b=>{ const s=D.stats[b.id];
          if(['low','out','watch'].includes(s.st)&&!s.hasReq&&b.product_id){
            const why = `is at ${fmtN(s.onHand)} yd³ (reorder at ${fmtN(b.reorder_yd)})`;
            items.push(`<div class="alert" style="--c:var(--${s.st==='out'?'bad':'warn'})"><p><b>${esc(b.code)} ${esc(prodName(b.product_id))}</b> ${why}.</p>
              <div class="btns"><button class="btn sm primary" data-act="quickReq" data-bin="${b.id}">Order product</button></div></div>`);
          }});
        if(D.unmapped.length) items.push(`<div class="alert" style="--c:var(--warn)"><p><b>${D.unmapped.length} Shopify line${D.unmapped.length>1?'s':''}</b> are on hold. They draw from inventory once their product is linked.</p><div class="btns"><button class="btn sm" data-act="tab" data-tab="pulls">Link products</button></div></div>`);
        const toConfirm=S.hauls.filter(h=>['scheduled','en_route'].includes(h.status)&&(h.status==='en_route'||dayDiff(h.haul_on)<=0)).length;
        if(toConfirm) items.push(`<div class="alert" style="--c:var(--ok)"><p><b>${toConfirm} deliver${toConfirm>1?'ies':'y'}</b> due today or en route. Confirm ${toConfirm>1?'them':'it'} when the product arrives.</p><div class="btns"><button class="btn sm" data-act="tab" data-tab="backfill">Confirm deliveries</button></div></div>`);
        const slingers=S.backfills.filter(r=>r.method==='slinger'&&r.status==='requested');
        if(slingers.length) items.push(`<div class="alert" style="--c:var(--info)"><p><b>${slingers.length} slinger request${slingers.length>1?'s':''}</b> waiting for you to schedule.</p><div class="btns"><button class="btn sm" data-act="tab" data-tab="backfill">Schedule</button></div></div>`);
      }
      if(has('hauling','admin')){
        S.backfills.filter(r=>r.method==='bulk'&&r.status==='requested').forEach(r=>{
          items.push(`<div class="alert" style="--c:var(--info)"><p><b>${esc(r.created_by_name||'Jeff')}</b> requests <b class="num">${fmtYd(r.qty_yd)}</b> ${esc(prodName(r.product_id))}, needed ${whenDate(r.needed_by)}.</p>
            <div class="btns"><button class="btn sm primary" data-act="scheduleReq" data-id="${r.id}">Schedule a truck</button></div></div>`);
        });
      }
      return items.join('')||`<div class="empty panel">Nothing needs attention right now.</div>`;
    },
    yUpcoming(){
      const ev=[];
      D.openHauls.forEach(h=>ev.push({d:h.haul_on,q:+h.volume_yd,t:`${prodName(h.product_id)} · Truck ${h.truck_no}`}));
      const list=ev.filter(e=>dayDiff(e.d)<=7).sort((a,b)=>a.d.localeCompare(b.d));
      if(!list.length) return `<div class="empty panel">No pulls or hauls in the next week.</div>`;
      return `<div class="timeline">${list.map(e=>`<div class="tl"><span class="d">${esc(fmtDate(e.d))}</span><span>${esc(e.t)}</span><span class="q num ${e.q<0?'neg':'pos'}">${signed(e.q)}</span></div>`).join('')}</div>`;
    },
  },
};
function binCard(b){
  const s=D.stats[b.id]; const [lbl,cls]=ST_CHIP[s.st];
  const reqBtn = can.request()&&b.product_id&&['low','out','watch'].includes(s.st)
    ? (s.hasReq?`<span class="chip c-info">Product ordered</span>`:`<button class="btn sm" data-act="quickReq" data-bin="${b.id}">Order product</button>`) : '';
  return `<article class="bin st-${s.st}">
    <div class="bin-h"><span class="prod">${esc(prodName(b.product_id))}</span><span class="chip ${cls}">${lbl}</span></div>
    <div class="code">Bin ${esc(b.code)}</div>
    ${gauge(b,s)}
    <div class="level"><b class="num">${fmtN(s.onHand)}</b><span class="of">of ${fmtN(b.capacity_yd)} yd³</span><span class="u">${fmtUnits(s.onHand)}</span></div>
    <dl class="flows"><div><dt>Today</dt><dd class="${s.out?'neg':''}">${s.out?'−'+fmtN(s.out):'0'}</dd></div>
      <div><dt>In</dt><dd class="${s.inc?'pos':''}">${s.inc?'+'+fmtN(s.inc):'0'}</dd></div>
      <div><dt>Projected</dt><dd>${fmtN(s.proj)}</dd></div></dl>
    ${reqBtn}
  </article>`;
}
const isPhone=()=>{ try{ return window.matchMedia('(max-width: 720px)').matches; }catch{ return false; } };
const ZONES={T:'Top row · 150 yd bins',L:'Left side · aggregates',M:'Center row',R:'Right center row',E:'Other'};
function mapTilePhone(b){
  const s=D.stats[b.id]; const pct=Math.max(0,Math.min(100,s.onHand/Math.max(1,Number(b.capacity_yd)||1)*100));
  return `<button class="ptile st-${s.st} ${UI.selBin===b.id?'sel':''}" data-act="selBin" data-id="${b.id}" aria-label="${esc(prodName(b.product_id))}, bin ${esc(b.code)}: ${fmtN(s.onHand)} of ${fmtN(b.capacity_yd)} cubic yards, ${ST_CHIP[s.st][0]}">
      <span class="pt-top"><span class="pt-name">${esc(b.product_id?prodName(b.product_id):'Empty')}</span><span class="tcode">${esc(b.code)}</span></span>
      <span class="pt-bar"><i style="width:${pct.toFixed(0)}%"></i></span>
      <span class="pt-num num"><b>${fmtN(s.onHand)}</b> / ${fmtN(b.capacity_yd)} yd³${s.out?` <span class="f out">▼${fmtN(s.out)}</span>`:''}${s.inc?` <span class="f in">▲${fmtN(s.inc)}</span>`:''}</span>
    </button>`;
}
function yardMapPhone(){
  const groups={};
  D.activeBins.forEach(b=>{ const z=(b.code||'?')[0].toUpperCase(); (groups[z]=groups[z]||[]).push(b); });
  const order=[...Object.keys(ZONES).filter(z=>groups[z]),...Object.keys(groups).filter(z=>!ZONES[z])];
  return order.map(z=>`<section class="zone"><h3>${esc(ZONES[z]||z)}</h3><div class="ptiles">${groups[z].map(mapTilePhone).join('')}</div></section>`).join('');
}
// Retail Bins by default; the Yard Debris tab passes its own piles, no landmarks and 4 columns.
function yardMap(bins=D.activeBins,{landmarks=S.settings.yard_landmarks||[],minCols=8,colMin='96px',phone=yardMapPhone}={}){
  if(isPhone()) return phone();
  const placed=bins.filter(b=>b.map_x&&b.map_y);
  const lms=(landmarks||[]).filter(l=>l&&l.x&&l.y);
  const all=[...placed.map(b=>[b.map_y,b.map_y+(b.map_h||1)-1]),...lms.map(l=>[l.y,l.y+(l.h||1)-1])];
  if(!all.length) return `<div class="empty panel">No bins have a map position yet. Add one in Setup.</div><div class="bins">${bins.map(binCard).join('')}</div>`;
  const minY=Math.min(...all.map(a=>a[0])), maxY=Math.max(...all.map(a=>a[1]));
  const maxX=Math.max(minCols,...placed.map(b=>b.map_x+(b.map_w||1)-1),...lms.map(l=>l.x+(l.w||1)-1));
  // Numbers only: positions come from stored settings and go into a style attribute.
  const n=v=>Math.max(1,Math.min(500,Math.trunc(Number(v))||1));
  const pos=(x,y,w,h)=>`grid-column:${n(x)} / span ${n(w)};grid-row:${n(y-minY+1)} / span ${n(h)}`;
  const tiles=placed.map(b=>{
    const s=D.stats[b.id]; const pct=Math.max(0,Math.min(100,s.onHand/Math.max(1,Number(b.capacity_yd)||1)*100));
    const flags=(s.out?`<span class="f out">▼${fmtN(s.out)}</span>`:'')+(s.inc?`<span class="f in">▲${fmtN(s.inc)}</span>`:'');
    return `<button class="tile st-${s.st} ${UI.selBin===b.id?'sel':''}" style="${pos(b.map_x,b.map_y,b.map_w,b.map_h)}" data-act="selBin" data-id="${b.id}"
        aria-label="${esc(b.code)} ${esc(prodName(b.product_id))}: ${fmtN(s.onHand)} of ${fmtN(b.capacity_yd)} cubic yards, ${ST_CHIP[s.st][0]}">
      <i class="lvl" style="height:${pct.toFixed(0)}%"></i>
      <span class="tcode">${esc(b.code)}</span>
      <span class="tt">${esc(b.product_id?prodName(b.product_id):'Empty')}</span>
      <span class="tv num">${fmtN(s.onHand)}<small>/${fmtN(b.capacity_yd)}</small>${flags}</span>
    </button>`;
  }).join('');
  const marks=lms.map(l=>`<div class="mark mk-${esc(l.kind||'x')}" style="${pos(l.x,l.y,l.w,l.h)}">${esc(l.label)}</div>`).join('');
  const off=bins.filter(b=>!(b.map_x&&b.map_y));
  return `<div class="map-wrap"><div class="map" style="grid-template-columns:repeat(${maxX},minmax(${colMin},1fr));grid-template-rows:repeat(${maxY-minY+1},var(--rowh))">${tiles}${marks}</div></div>
    ${off.length?`<div class="muted" style="font-size:.82rem">Not on the map: ${off.map(b=>esc(b.code)).join(', ')}</div>`:''}`;
}

/* ---------- Yard Debris ----------
   The opposite of the retail side: tip fees (Shopify) and intake ADD to the piles,
   grinding moves green waste / wood debris onto Ground Debris, and removals
   (scheduled or logged) take debris away. Mirrors trg_debris_event() in schema.sql. */
const DEBRIS_HINT={dump:'Tip fees and intake add · hauled away',grind:'Tip fees and intake add · ground into Ground Debris · hauled away',ground:'Only grinding adds · hauled away'};
const DEBRIS_KIND={intake:['Debris in','c-ok'],grind:['Grind','c-acc'],removal:['Removal','c-warn'],shopify:['Tip fee','c-info']};
const debrisKindFilter={intake:b=>b.debris_role!=='ground',grind:b=>b.debris_role==='grind',removal:()=>true};
// Shopify timestamps → the local calendar day (a UTC slice would show evening orders as "tomorrow").
const tsDay=t=>{ const d=new Date(t); return isNaN(d)?String(t||'').slice(0,10):d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const haulerName=h=>/^\d+$/.test(h||'')?'Truck '+h:(h||'');
function debrisBinOpts(filter,sel){
  return D.debrisBins.filter(filter).map(b=>`<option value="${b.id}" ${b.id===sel?'selected':''}>${esc(prodName(b.product_id))} (${fmtN(D.stats[b.id].onHand)} yd³)</option>`).join('');
}
function debrisFields(kind,bin){
  // bin given → the pop-up for that pile: the pile is fixed.
  const pick=(label)=>{ const opts=D.debrisBins.filter(debrisKindFilter[kind]);
    return bin ? `<input type="hidden" name="bin_id" value="${esc(bin.id)}">`
      : `<label class="field"><span>${label}</span><select name="bin_id" required>${opts.length>1?'<option value="">Choose…</option>':''}${debrisBinOpts(debrisKindFilter[kind])}</select></label>`; };
  const num=(name,label)=>`<label class="field"><span>${label}</span><input name="${name}" type="number" step="0.25" min="0.25" required inputmode="decimal"></label>`;
  const date=`<label class="field"><span>Date</span><input name="happened_on" type="date" value="${isoDay()}"></label>`;
  const notes=`<label class="field full"><span>Notes</span><input name="notes" maxlength="500"></label>`;
  if(kind==='intake') return pick('Pile')+num('qty','Volume yd³')+
    `<label class="field"><span>From</span><input name="source" maxlength="120" placeholder="Customer, crew or job"></label>`+date+notes;
  if(kind==='grind'){
    const grounds=D.debrisBins.filter(b=>b.debris_role==='ground');
    const to=grounds.length===1?`<input type="hidden" name="to_bin_id" value="${esc(grounds[0].id)}">`
      :`<label class="field"><span>Ground onto</span><select name="to_bin_id" required>${debrisBinOpts(b=>b.debris_role==='ground')}</select></label>`;
    return pick('Ground from')+to+num('qty','Amount ground (yd³)')+num('to_qty','Ground made (yd³)')+date+notes;
  }
  return pick('Pile')+
    `<label class="field"><span>Truck</span><select name="truck_sel" data-act-change="debrisTruck">${trucks().map(t=>`<option value="${esc(t.no)}">Truck ${esc(t.no)}</option>`).join('')}<option value="other">Outside hauler</option></select></label>
    <label class="field" data-other-truck hidden><span>Hauler name</span><input name="truck_other" maxlength="40"></label>
    <label class="field"><span>Loads</span><input name="loads" type="number" min="1" max="50" step="1" value="1"></label>`+num('qty','Volume yd³')+date+
    `<label class="field"><span>Status</span><select name="status"><option value="done">Hauled already (take out now)</option><option value="scheduled">Schedule (confirm when hauled)</option></select></label>`+notes;
}
const DEBRIS_FORMS={intake:['Add debris','order','Add to pile'],grind:['Record grind','primary','Save grind'],removal:['Haul away','take','Save removal']};
function debrisCard(b){
  const s=D.stats[b.id];
  return `<article class="bin st-${s.st}">
    <div class="bin-h"><span class="prod">${esc(prodName(b.product_id))}</span></div>
    <div class="code">Pile ${esc(b.code)}</div>
    ${gauge(b,s)}
    <div class="level"><b class="num">${fmtN(s.onHand)}</b><span class="of">of ${fmtN(b.capacity_yd)} yd³</span></div>
    <div class="muted" style="font-size:.8rem">${esc(DEBRIS_HINT[b.debris_role]||'')}</div>
  </article>`;
}
const debrisDue=()=>S.debris.filter(e=>e.kind==='removal'&&e.status==='scheduled'&&dayDiff(e.happened_on)<=0).length;
function debrisRemovalRow(e){
  const late=dayDiff(e.happened_on)<0;
  return `<div class="row">
    <span class="chip c-warn">Removal</span>
    <div class="main"><span class="t">${esc(prodName(D.bin[e.bin_id]?.product_id))}</span><span class="m">${esc(haulerName(e.hauler))}${e.loads>1?' × '+e.loads+' loads':''}${e.notes?' · '+esc(e.notes):''} · Scheduled by ${esc(e.created_by_name||'—')}</span></div>
    <span class="vol">${fmtN(e.qty_yd)} yd³</span>
    <span class="date">${esc(fmtDate(e.happened_on))}${late?' <span class="chip c-bad">Late</span>':''}</span>
    <span class="act">${can.debris()?`<button class="btn sm order" data-act="debrisDone" data-id="${e.id}">Confirm removed</button>${confirmBtn('debrisCancel','Cancel',`data-id="${e.id}"`,'cancel')}`:''}</span></div>`;
}
VIEWS.debris={
  shell:()=>{
    const f=UI.debrisForm&&can.debris()?UI.debrisForm:null; const [title,cls,btn]=f?DEBRIS_FORMS[f]:[];
    return `<section class="view">
    <div class="summary" data-dyn="dSummary"></div>
    <div class="split">
      <div class="sec">
        <div class="sec-head"><h2>Yard Debris</h2>
          ${can.debris()?`<button class="btn sm order" data-act="debrisForm" data-v="intake">Add debris</button>
          <button class="btn sm" data-act="debrisForm" data-v="grind">Record grind</button>
          <button class="btn sm take" data-act="debrisForm" data-v="removal">Haul away</button>`:''}</div>
        ${f?`<div class="panel panel-pad"><div class="sec-head"><h3 style="margin:0">${esc(title)}</h3><button class="btn sm ghost" data-act="debrisForm" data-v="">Close</button></div>
          <form class="form" data-form="debris" data-kind="${f}" autocomplete="off">${debrisFields(f,null)}
          <div class="form-actions full"><button class="btn ${cls}">${esc(btn)}</button></div></form></div>`:''}
        <p class="muted" style="margin:0;font-size:.85rem">Tip fees and intake add to the piles. Grinding moves green waste and wood debris onto Ground Debris. Removals take debris away. Tap a pile for its details.</p>
        <div data-dyn="dMap"></div>
      </div>
      <aside class="sec">
        <h2>Scheduled removals</h2><div class="rows" data-dyn="dSched"></div>
        <h2>Recent activity</h2><div class="rows" data-dyn="dRecent"></div>
      </aside>
    </div></section>`;
  },
  dyn:{
    dSummary(){
      const bins=D.debrisBins, total=bins.reduce((s,b)=>s+D.stats[b.id].onHand,0);
      const wk=e=>e.status==='done'&&dayDiff(e.happened_on)>=-6&&dayDiff(e.happened_on)<=0;
      const tips=S.shopifyLines.filter(l=>l.status==='pulled'&&D.bin[D.lineBin(l)]?.site==='debris'&&dayDiff(tsDay(l.ordered_at||l.created_at))>=-6);
      const inn=S.debris.filter(e=>e.kind==='intake'&&wk(e)).reduce((s,e)=>s+Number(e.qty_yd),0)+tips.reduce((s,l)=>s+Number(l.qty_yd||0),0);
      const ground=S.debris.filter(e=>e.kind==='grind'&&wk(e)).reduce((s,e)=>s+Number(e.to_qty_yd),0);
      const out=S.debris.filter(e=>e.kind==='removal'&&wk(e)).reduce((s,e)=>s+Number(e.qty_yd),0);
      const sched=S.debris.filter(e=>e.kind==='removal'&&e.status==='scheduled');
      return `<div><span class="k">On the piles</span><span class="v num">${fmtN(total)}<small>yd³</small></span><span class="s">${bins.length} piles</span></div>
        <div><span class="k">Came in · 7 days</span><span class="v num">${fmtN(inn)}<small>yd³</small></span><span class="s">${tips.length} tip fee${tips.length===1?'':'s'} plus intake</span></div>
        <div><span class="k">Ground · 7 days</span><span class="v num">${fmtN(ground)}<small>yd³</small></span><span class="s">Ground material made</span></div>
        <div><span class="k">Hauled away · 7 days</span><span class="v num">${fmtN(out)}<small>yd³</small></span><span class="s">${sched.length} removal${sched.length===1?'':'s'} scheduled</span></div>`;
    },
    dMap(){
      if(!D.debrisBins.length) return `<div class="empty panel">No Yard Debris piles yet. Run schema.sql to add them.</div>`;
      return yardMap(D.debrisBins,{landmarks:[],minCols:10,colMin:'0',phone:()=>`<div class="ptiles">${D.debrisBins.map(mapTilePhone).join('')}</div>`});
    },
    dSched(){
      const list=S.debris.filter(e=>e.kind==='removal'&&e.status==='scheduled').sort((a,b)=>a.happened_on.localeCompare(b.happened_on));
      return list.map(debrisRemovalRow).join('')||`<div class="empty">No removals scheduled.</div>`;
    },
    dRecent(){
      const ev=S.debris.filter(e=>e.status!=='scheduled'&&dayDiff(e.happened_on)>=-14).map(e=>{
        const b=D.bin[e.bin_id], tb=D.bin[e.to_bin_id];
        const title=e.kind==='grind'?`${prodName(b?.product_id)} → ${prodName(tb?.product_id)}`:prodName(b?.product_id);
        const meta=[e.kind==='grind'?`${fmtN(e.qty_yd)} yd³ used, ${fmtN(e.to_qty_yd)} yd³ made`:'',e.source,e.hauler&&haulerName(e.hauler)+(e.loads>1?' × '+e.loads:''),e.notes,e.created_by_name&&'by '+e.created_by_name].filter(Boolean).join(' · ');
        const sign=e.kind==='intake'?1:e.kind==='removal'?-1:0;
        return {kind:e.kind,id:e.id,date:e.happened_on,at:e.created_at,title,meta,qty:e.kind==='grind'?e.to_qty_yd:e.qty_yd,sign,cancelled:e.status==='cancelled',undo:e.status==='done'&&can.debris()?confirmBtn('debrisUndo','Undo',`data-id="${e.id}"`,'ghost'):''};
      });
      const tips=S.shopifyLines.filter(l=>['pulled','ignored','cancelled'].includes(l.status)&&l.product_id&&D.bin[D.lineBin(l)]?.site==='debris'&&dayDiff(tsDay(l.ordered_at||l.created_at))>=-14).map(l=>({
        kind:'shopify',id:l.id,date:tsDay(l.ordered_at||l.created_at),at:l.ordered_at||l.created_at,title:prodName(l.product_id),
        meta:`${l.order_name||'Shopify'} · ${l.customer_name||''} · ${l.variant_title||''}${l.quantity>1?' × '+l.quantity:''}`,qty:l.qty_yd,sign:1,cancelled:l.status!=='pulled',
        undo:l.status==='pulled'&&can.pull()?confirmBtn('reverseShop','Reverse',`data-id="${l.id}"`,'ghost'):''}));
      const rows=[...ev,...tips].sort((a,b)=>b.date.localeCompare(a.date)||String(b.at).localeCompare(String(a.at))).slice(0,60);
      if(!rows.length) return `<div class="empty">Nothing in the last 14 days.</div>`;
      return rows.map(r=>{ const [l,c]=DEBRIS_KIND[r.kind];
        return `<div class="row ${r.cancelled?'dim':''}"><span class="chip ${r.cancelled?'c-mute':c}">${r.cancelled?'Undone':l}</span>
          <div class="main"><span class="t">${esc(r.title)}</span><span class="m">${esc(r.meta)}</span></div>
          <span class="vol" style="color:var(--${r.sign<0?'bad':r.sign>0?'ok':'ink'})">${r.sign<0?'−':r.sign>0?'+':''}${fmtN(r.qty)} yd³</span>
          <span class="date">${esc(fmtDate(r.date))}</span><span class="act">${r.undo}</span></div>`; }).join('');
    },
  },
};

/* ---------- Orders ---------- */
function drawFormFields(bin){
  // bin given → the pop-up for that bin: product is fixed and the draw comes from THAT bin.
  const product = bin
    ? `<input type="hidden" id="io-prod" name="product_id" value="${esc(bin.product_id)}" data-hint="io-hint" data-hint-bin="${esc(bin.id)}"><input type="hidden" name="bin_id" value="${esc(bin.id)}">`
    : `<label class="field"><span>Product</span><select id="io-prod" name="product_id" required data-hint="io-hint" data-hint-product="1">
          <option value="">Choose a product</option>${S.products.filter(p=>p.active!==false&&D.defaultBin(p.id)).sort((x,y)=>x.name.localeCompare(y.name)).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>`;
  return `        <label class="field"><span>Customer or department</span><select id="io-cust" name="customer" required data-act-change="custSel">
          <option value="">Choose…</option>${CUSTOMERS.map(c=>`<option>${c}</option>`).join('')}</select></label>
        <label class="field" id="io-other-wrap" hidden><span>Other — who is it for?</span><input id="io-other" name="other" maxlength="100"></label>
        <label class="field"><span>Draw by</span><select id="io-mode" name="mode" data-act-change="drawMode"><option value="volume">Volume</option><option value="totes">Totes</option></select></label>
        <label class="field" data-tote hidden><span>How many totes</span><input id="io-totes" name="totes" type="number" min="1" step="1" inputmode="numeric" data-act-input="toteCalc"></label>
        <label class="field" data-tote hidden><span>Tote size</span><select id="io-tsize" name="tote_size" data-act-change="toteCalc">${toteSizes().map(n=>`<option value="${n}">${fmtN(n)} yd³ tote</option>`).join('')}</select></label>
        ${product}
        <div data-vol style="display:contents">${qtyField('qty','Volume')}</div>
        <div class="field full" data-tote hidden><span>Draw</span><div class="tote-calc num" id="io-calc">Enter how many totes</div></div>
        <label class="field"><span>Date</span><input id="io-date" name="pull_on" type="date" value="${isoDay()}"></label>
        <label class="field full"><span>Notes</span><input id="io-notes" name="notes" maxlength="500"></label>
`;
}
function orderFormFields(bin,qty=''){
  const product = bin
    ? `<input type="hidden" id="rq-bin" name="product_id" value="${esc(bin.product_id)}" data-hint="rq-hint" data-hint-bin="${esc(bin.id)}"><input type="hidden" name="bin_id" value="${esc(bin.id)}">`
    : `<label class="field"><span>Product</span><select id="rq-bin" name="product_id" required data-hint="rq-hint" data-hint-product="1">${productOptions(UI.prefillBin&&D.bin[UI.prefillBin]?.product_id)}</select></label>`;
  return `        ${product}
        ${qtyField('qty','Volume needed', qty)}
        <label class="field"><span>Needed by</span><input id="rq-date" name="needed_by" type="date" value="${isoDay(1)}"></label>
        <div class="field full"><span>Haul with</span><div class="seg">
          <label><input type="radio" name="method" value="bulk" checked> Bulk truck <span class="muted">· Kevin Roemer dispatches</span></label>
          <label><input type="radio" name="method" value="slinger"> Slinger <span class="muted">· you dispatch</span></label></div></div>
        <label class="field full"><span>Notes for dispatch</span><input id="rq-notes" name="notes" maxlength="500"></label>
`;
}

const CUSTOMERS=['Eugene Blowers','CAS','Bagger','Other'];
const trucks=()=>{ const v=S.settings.trucks; return Array.isArray(v)?v:DEFAULT_TRUCKS; };
const truckCap=(no,pid,cond)=>{ const t=trucks().find(t=>String(t.no)===String(no)); const g=D.product[pid]?.haul_group; const c=t&&g&&t.cap?.[g]; return c?Number(c[cond==='wet'?'wet':'dry'])||null:null; };
function truckFields(pid,{remaining=0,method='bulk'}={}){
  const opts=trucks().map(t=>`<option value="${esc(t.no)}">Truck ${esc(t.no)}</option>`).join('');
  return `<label class="field"><span>Truck</span><select name="truck_sel" data-act-change="haulCalc">${opts}<option value="other">${method==='slinger'?'Slinger / other':'Other truck'}</option></select></label>
    <label class="field" data-other-truck hidden><span>Truck #</span><input name="truck_other" inputmode="numeric" maxlength="20"></label>
    <label class="field"><span>Conditions</span><select name="conditions" data-act-change="haulCalc"><option value="dry">Dry</option><option value="wet">Wet</option></select></label>
    <label class="field"><span>Loads</span><input name="loads" type="number" min="1" step="1" value="1" data-act-input="haulCalc"></label>
    <label class="field"><span>Volume yd³</span><input name="volume" type="number" step="0.25" min="0.25" required value="${remaining||''}" data-act-input="haulTouch"></label>
    <div class="hint full" data-truck-hint></div>`;
}
const toteSizes=()=>{ const v=S.settings.tote_sizes; return Array.isArray(v)&&v.length?v.map(Number).filter(n=>n>0):[1,1.5]; };
VIEWS.pulls={
  shell:()=>`<section class="view">
    ${can.order()?`<div class="panel panel-pad sec">
      <h2>New internal order</h2>
      <form class="form" data-form="internal" autocomplete="off">
        ${drawFormFields(null)}
        <div class="form-actions full"><button class="btn primary">Save and draw from inventory</button><span class="hint" id="io-hint"></span></div>
      </form></div>`:''}
    <div class="sec">
      <div class="sec-head"><h2>Recent orders</h2>
        ${A.mode==='demo'&&can.pull()?'<button class="btn sm" data-act="simShop">Simulate a Shopify order</button>':''}
        <div class="filters" data-dyn="pFilters"></div></div>
      <p class="muted" style="margin:0;font-size:.85rem">Every order comes off the yard the moment it's saved. Shopify orders draw on their own; internal orders draw when Jeff saves them.</p>
      <div class="rows" data-dyn="pQueue"></div>
    </div>
    ${can.pull()?`<div class="sec"><div class="sec-head"><h2>Shopify lines on hold</h2><span class="muted" style="font-size:.82rem">These haven't drawn yet. Link the product once and this order, plus every future one, draws automatically.</span></div><div class="rows" data-dyn="pUnmapped"></div></div>`:''}
  </section>`,
  dyn:{
    pFilters(){ return [['all','All'],['internal','Internal'],['shopify','Shopify']].map(([k,l])=>`<button data-act="pullFilter" data-v="${k}" aria-pressed="${UI.pullFilter===k}">${l}</button>`).join(''); },
    pQueue(){
      const f=UI.pullFilter;
      const io=f==='shopify'?[]:S.internalOrders.filter(o=>['pulled','cancelled'].includes(o.status))
        .map(o=>({src:'internal',id:o.id,date:o.pull_on||o.created_at.slice(0,10),at:o.pulled_at||o.created_at,title:o.customer,meta:[o.reference,o.notes,o.created_by_name&&'Entered by '+o.created_by_name].filter(Boolean).join(' · '),product_id:o.product_id,qty:o.qty_yd,status:o.status}));
      const sl=f==='internal'?[]:S.shopifyLines.filter(l=>D.bin[D.lineBin(l)]?.site!=='debris'&&(['pulled','cancelled'].includes(l.status)||(l.status==='ignored'&&l.product_id)))
        .map(l=>({src:'shopify',id:l.id,date:(l.ordered_at||l.created_at).slice(0,10),at:l.ordered_at||l.created_at,title:`${l.order_name||'Shopify order'} · ${l.customer_name||''}`,meta:`${l.title} · ${l.variant_title||''}${l.quantity>1?' × '+l.quantity:''}`,product_id:l.product_id,qty:l.qty_yd,status:l.status==='ignored'?'cancelled':l.status}));
      const rows=[...io,...sl].sort((a,b)=>(b.date.localeCompare(a.date))||String(b.at).localeCompare(String(a.at))).slice(0,200);
      if(!rows.length) return `<div class="empty">No orders yet.</div>`;
      return rows.map(r=>{
        let act='';
        if(can.pull()&&r.status==='pulled'){
          act = r.src==='internal' ? confirmBtn('undoIO','Undo',`data-id="${r.id}"`,'ghost') : confirmBtn('reverseShop','Reverse draw',`data-id="${r.id}"`,'ghost');
        }
        return `<div class="row ${r.status==='cancelled'?'dim':''}">
          <span class="chip ${r.src==='shopify'?'c-info':'c-acc'}">${r.src==='shopify'?'Shopify':'Internal'}</span>
          <div class="main"><span class="t">${esc(prodName(r.product_id))}</span><span class="m">${esc(r.title)}${r.meta?' · '+esc(r.meta):''}</span></div>
          <span class="vol">${fmtN(r.qty)} yd³<small>${fmtUnits(r.qty)}</small></span>
          <span class="date">${esc(fmtDate(r.date))}</span>
          <span class="st">${r.status==='pulled'?'<span class="chip c-ok">Drawn</span>':'<span class="chip c-mute">Reversed</span>'}</span>
          <span class="act">${act}</span></div>`;
      }).join('');
    },
    pUnmapped(){
      if(!D.unmapped.length) return `<div class="empty">Nothing on hold. Every Shopify line drew from inventory.</div>`;
      return D.unmapped.map(l=>{
        const open=UI.mapLine===l.id;
        return `<div class="row">
          <span class="chip c-warn">Shopify</span>
          <div class="main"><span class="t">${esc(l.order_name)} · ${esc(l.title)}</span><span class="m">${esc(l.variant_title||'')}${l.yd_each?' yd':''} × ${l.quantity}${l.qty_yd?' = '+fmtYd(l.qty_yd):''} · ${esc(l.customer_name||'')} · No yard product is linked to this Shopify title</span></div>
          <span class="date">${esc(fmtDate((l.ordered_at||l.created_at).slice(0,10)))}</span>
          <span class="act">${open?'':`<button class="btn sm" data-act="mapOpen" data-id="${l.id}">Link product</button>`}${confirmBtn('ignoreLine','Not yard stock',`data-id="${l.id}"`,'ghost')}</span>
          ${open?`<form class="inline-form form" data-form="mapLine" data-id="${l.id}">
            <label class="field"><span>Yard product</span><select name="product_id" required><option value="">Choose…</option>${S.products.filter(p=>p.active!==false).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
            <label class="field"><span>Yards per item</span><input name="yd_each" type="number" step="0.5" min="0.5" required value="${esc(l.yd_each??'')}"></label>
            <label class="field"><span><input type="checkbox" name="link" checked> Use for all orders of “${esc(l.title)}”</span></label>
            <div class="form-actions"><button class="btn primary sm">Link and draw</button><button type="button" class="btn sm ghost" data-act="mapClose">Close</button></div></form>`:''}
        </div>`;
      }).join('');
    },
  },
};

/* ---------- Backfill ---------- */
VIEWS.backfill={
  shell:()=>`<section class="view">
    ${can.request()?`<details class="panel panel-pad adder" ${UI.prefillBin?'open':''}>
      <summary class="sec-head"><h2>Order product</h2><span class="btn sm primary">New order</span></summary>
      <form class="form" data-form="request" autocomplete="off">
        ${orderFormFields(null, UI.prefillQty||'')}
        <div class="form-actions full"><button class="btn primary">Send order</button><span class="hint" id="rq-hint"></span></div>
      </form></details>`:''}
    <div class="sec"><div class="sec-head"><h2>Product orders</h2><div class="filters" data-dyn="bFilters"></div></div>
      <p class="muted" style="margin:0;font-size:.85rem">Order → schedule a truck → ${can.confirmDelivery()?'confirm the delivery here when it arrives':'the yard confirms the delivery when it arrives'}. Product is added to the bin only when a delivery is confirmed.</p>
      <div class="cols" data-dyn="bBoard"></div></div>
    ${can.confirmDelivery()?`<details class="panel panel-pad adder">
      <summary class="sec-head"><h2>Log a delivery without an order</h2><span class="btn sm">Log delivery</span></summary>
      <form class="form" data-form="haulFree" autocomplete="off">
        <label class="field"><span>Product</span><select id="hf-bin" name="product_id" required data-act-change="haulCalc">${productOptions()}</select></label>
        ${truckFields(null)}
        <label class="field"><span>Date</span><input id="hf-date" name="haul_on" type="date" value="${isoDay()}"></label>
        <label class="field"><span>Hauled by</span><select id="hf-method" name="method"><option value="bulk">Bulk truck</option><option value="slinger">Slinger</option></select></label>
        <label class="field"><span>Status</span><select id="hf-status" name="status"><option value="delivered">Delivered (add to bin now)</option><option value="scheduled">Scheduled (confirm later)</option></select></label>
        <div class="form-actions full"><button class="btn primary">Save</button><span class="hint">Shows on the board as an order with this truck.</span></div>
      </form></details>`:''}
  </section>`,
  dyn:{
    bFilters(){ return [['all','All'],['bulk','Bulk · Kevin'],['slinger','Slinger · Jeff']].map(([k,l])=>`<button data-act="bfFilter" data-v="${k}" aria-pressed="${UI.bfFilter===k}">${l}</button>`).join(''); },
    bBoard(){
      const f=UI.bfFilter;
      const list=S.backfills.filter(r=>r.status!=='cancelled'&&(f==='all'||r.method===f));
      // No separate "In progress" column: orders with a truck en route or partly delivered stay under Scheduled.
      const cols=[['requested','Requested'],['scheduled','Scheduled'],['delivered','Delivered · 14 days']];
      return cols.map(([k,l])=>{
        let items=list.filter(r=>r.status===k||(k==='scheduled'&&r.status==='in_progress'));
        if(k==='delivered') items=items.filter(r=>dayDiff((r.needed_by||r.created_at).slice(0,10))>=-14);
        items.sort((a,b)=>(a.needed_by||'').localeCompare(b.needed_by||''));
        return `<div class="col"><div class="col-h"><h3>${l}</h3><span class="n">${items.length}</span></div>
          ${items.map(reqCard).join('')||'<div class="empty">None</div>'}</div>`;
      }).join('');
    },
  },
};
function haulLine(h){
  // One truck on an order card, with the actions for whoever is looking:
  //   Jeff / admin → Confirm delivered (adds to the bin) · Undo
  //   dispatcher (Kevin for bulk, Jeff for slingers) → Cancel
  const open=['scheduled','en_route'].includes(h.status);
  const disp=can.dispatch(h.method)||can.confirmDelivery();
  let act='';
  if(open&&can.confirmDelivery()) act+=`<button class="btn sm order" data-act="haulStatus" data-v="delivered" data-id="${h.id}">Confirm delivered</button>`;
  if(open&&disp) act+=confirmBtn('haulCancel','Cancel',`data-id="${h.id}"`,'cancel');
  if(h.status==='delivered'&&can.confirmDelivery()) act+=confirmBtn('haulUndo','Undo',`data-id="${h.id}"`,'ghost');
  return `<div class="haul-line"><div class="hl-top"><span>Truck ${esc(h.truck_no)}${h.loads>1?' × '+h.loads:''} · ${esc(fmtDate(h.haul_on))}</span><span class="num">${fmtN(h.volume_yd)} yd³ ${statusChip(h.status==='delivered'?'confirmed':h.status)}</span></div>
    ${act?`<div class="hl-act">${act}</div>`:''}</div>`;
}
function reqCard(r){
  const hs=S.hauls.filter(h=>h.request_id===r.id&&h.status!=='cancelled');
  const del=hs.filter(h=>h.status==='delivered').reduce((s,h)=>s+Number(h.volume_yd),0);
  const sched=hs.reduce((s,h)=>s+Number(h.volume_yd),0);
  const remaining=r1(Math.max(0,r.qty_yd-sched));
  const late=r.status!=='delivered'&&dayDiff(r.needed_by)<0;
  const canD=can.dispatch(r.method)&&r.status!=='delivered';
  const open=UI.openHaulFor===r.id;
  return `<article class="card">
    <div class="top-line"><span class="chip ${r.method==='bulk'?'c-info':'c-acc'}">${METHOD[r.method].label}</span>${late?'<span class="chip c-bad">Late</span>':''}</div>
    <div><div class="big num">${fmtYd(r.qty_yd)}</div><div style="font-weight:600">${esc(prodName(r.product_id))}</div></div>
    <div class="meta">Needed ${esc(whenDate(r.needed_by))} · ${esc(METHOD[r.method].who)} dispatches${r.notes?'<br>'+esc(r.notes):''}</div>
    ${r.method==='bulk'&&remaining>0&&!hs.length?(()=>{ const sug=trucks().map(t=>{ const c=truckCap(t.no,r.product_id,'dry'); return c?`${Math.ceil(remaining/c)} load${Math.ceil(remaining/c)>1?'s':''} on ${esc(t.no)}`:null; }).filter(Boolean);
      return sug.length?`<div class="meta">≈ ${sug.join(' · ')} <span class="muted">(dry)</span></div>`:`<div class="meta" style="color:var(--warn)">No truck capacity on file for this product</div>`; })():''}
    ${hs.length?`<div class="progress" title="${fmtN(del)} of ${fmtN(r.qty_yd)} yd³ delivered"><i style="width:${Math.min(100,del/r.qty_yd*100)}%"></i></div>
      <div class="hauls-mini">${hs.map(haulLine).join('')}</div>`:''}
    ${canD?(open?`<form class="form inline-form" data-form="haul" data-req="${r.id}" data-pid="${r.product_id}" data-remaining="${remaining}" style="grid-template-columns:repeat(auto-fit,minmax(110px,1fr))">
        ${truckFields(r.product_id,{remaining,method:r.method})}
        <label class="field"><span>Date</span><input name="haul_on" type="date" value="${dayDiff(r.needed_by)>=0?r.needed_by:isoDay()}"></label>
        <div class="form-actions full"><button class="btn primary sm">Schedule haul</button><button type="button" class="btn sm ghost" data-act="haulClose">Close</button></div></form>`
      :hs.length?'':`<div class="form-actions"><button class="btn sm primary" data-act="haulOpen" data-id="${r.id}">Schedule truck</button>
        ${r.status==='requested'&&can.request()?confirmBtn('cancelReq','Cancel request',`data-id="${r.id}"`,'cancel'):''}</div>`):''}
    <div class="meta">Requested by ${esc(r.created_by_name||'—')}</div>
  </article>`;
}

/* ---------- Ledger ---------- */
VIEWS.ledger={
  shell:()=>`<section class="view">
    ${can.adjust()?`<div class="panel panel-pad sec"><h2>Count or adjust a bin</h2>
      <form class="form" data-form="adjust" autocomplete="off">
        <label class="field"><span>Bin</span><select id="ad-bin" name="bin_id" required data-hint="ad-hint">${binOptions(null,{bins:D.allBins})}</select></label>
        <div class="field"><span>Type</span><div class="seg">
          <label><input type="radio" name="mode" value="count" checked> Physical count</label>
          <label><input type="radio" name="mode" value="adjust"> Adjust ±</label></div></div>
        ${qtyField('qty','Counted volume or change')}
        <label class="field"><span>Reason</span><input id="ad-note" name="note" maxlength="200" placeholder="Monthly count, spill, mis-pull…"></label>
        <div class="form-actions full"><button class="btn primary">Save to ledger</button><span class="hint" id="ad-hint">A count sets the bin to the number you enter. An adjustment adds or subtracts it (use a minus sign to subtract).</span></div>
      </form></div>`:''}
    <div class="sec"><div class="sec-head"><h2>Ledger</h2>
      <label class="field" style="min-width:220px"><select id="lg-filter" data-act-change="ledgerBin"><option value="">All bins</option>${D.allBins.map(b=>`<option value="${b.id}" ${UI.ledgerBin===b.id?'selected':''}>${esc(b.code)} · ${esc(prodName(b.product_id))}</option>`).join('')}</select></label></div>
      <div class="rows" data-dyn="lList"></div></div>
  </section>`,
  dyn:{
    lList(){
      const list=S.movements.filter(m=>!UI.ledgerBin||m.bin_id===UI.ledgerBin).slice(0,250);
      if(!list.length) return `<div class="empty">No movements yet.</div>`;
      const K={shopify:['Shopify','c-info'],internal:['Internal','c-acc'],backfill:['Backfill','c-ok'],adjustment:['Adjust','c-warn'],count:['Count','c-mute'],intake:['Debris in','c-ok'],grind:['Grind','c-acc'],removal:['Removal','c-warn']};
      return list.map(m=>{ const [l,c]=K[m.kind]||[m.kind,'c-mute'];
        return `<div class="row"><span class="chip ${c}">${l}</span>
          <div class="main"><span class="t">${esc(binLabel(m.bin_id))} · ${esc(prodName(m.product_id))}</span><span class="m">${esc(m.note||'')}${m.created_by_name?' · '+esc(m.created_by_name):''}</span></div>
          <span class="vol" style="color:var(--${m.qty_yd<0?'bad':'ok'})">${signed(Number(m.qty_yd))} yd³</span>
          <span class="date">${esc(fmtDate(m.occurred_on||m.created_at.slice(0,10)))}</span></div>`; }).join('');
    },
  },
};

/* ---------- Setup ---------- */
VIEWS.setup={
  shell:()=>{
    const eb=UI.editBin?S.bins.find(b=>b.id===UI.editBin):null;
    const ep=UI.editProduct?S.products.find(p=>p.id===UI.editProduct):null;
    return `<section class="view">
    <div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <div class="panel panel-pad sec"><h2>${eb?'Edit bin '+esc(eb.code):'Add a bin'}</h2>
        <form class="form" data-form="bin" data-id="${eb?.id||''}" autocomplete="off">
          <label class="field"><span>Bin code</span><input id="bn-code" name="code" required maxlength="12" value="${esc(eb?.code||'')}" placeholder="B-07"></label>
          <label class="field"><span>Product</span><select id="bn-prod" name="product_id"><option value="">Empty / unassigned</option>${S.products.map(p=>`<option value="${p.id}" ${eb?.product_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Capacity yd³</span><input id="bn-cap" name="capacity_yd" type="number" step="0.5" min="0" required value="${esc(eb?.capacity_yd??'')}"></label>
          <label class="field"><span>Reorder at yd³</span><input id="bn-re" name="reorder_yd" type="number" step="0.5" min="0" required value="${esc(eb?.reorder_yd??'')}"></label>
          <label class="field"><span>Sort order</span><input id="bn-sort" name="sort" type="number" step="1" value="${esc(eb?.sort??S.bins.length)}"></label>
          <label class="field"><span>Map column (1–8)</span><input id="bn-mx" name="map_x" type="number" min="1" max="12" step="1" value="${esc(eb?.map_x??'')}"></label>
          <label class="field"><span>Map row</span><input id="bn-my" name="map_y" type="number" min="1" step="1" value="${esc(eb?.map_y??'')}"></label>
          <label class="field"><span>Map height (rows)</span><input id="bn-mh" name="map_h" type="number" min="1" step="1" value="${esc(eb?.map_h??3)}"></label>
          <label class="field"><span><input type="checkbox" name="active" ${eb?.active===false?'':'checked'}> Active</span></label>
          <div class="form-actions full"><button class="btn primary">${eb?'Save bin':'Add bin'}</button>${eb?'<button type="button" class="btn ghost" data-act="editBin" data-id="">Cancel</button>':''}</div>
        </form></div>
      <div class="panel panel-pad sec"><h2>${ep?'Edit product':'Add a product'}</h2>
        <form class="form" data-form="product" data-id="${ep?.id||''}" autocomplete="off">
          <label class="field"><span>Name</span><input id="pr-name" name="name" required maxlength="80" value="${esc(ep?.name||'')}"></label>
          <label class="field"><span>SKU</span><input id="pr-sku" name="sku" maxlength="40" value="${esc(ep?.sku||'')}"></label>
          <label class="field full"><span>Shopify product title(s)</span><input id="pr-titles" name="shopify_titles" maxlength="2000" value="${esc((ep?.shopify_titles||[]).join(', '))}" placeholder="e.g. Premium Hemlock — separate several with commas"></label>
          <label class="field"><span>Haul group (truck capacity)</span><select id="pr-hg" name="haul_group"><option value="">None</option>${Object.entries(HAUL_GROUPS).map(([k,l])=>`<option value="${k}" ${ep?.haul_group===k?'selected':''}>${esc(l)}</option>`).join('')}</select></label>
          <label class="field full"><span>Only when the Shopify variant includes</span><input id="pr-var" name="shopify_variant_match" maxlength="40" value="${esc(ep?.shopify_variant_match||'')}" placeholder="Leave blank, or e.g. Red when one Shopify product feeds two bins"></label>
          <label class="field full"><span>Shopify product ID</span><input id="pr-shop" name="shopify_product_id" inputmode="numeric" value="${esc(ep?.shopify_product_id||'')}" placeholder="Filled in automatically by the first order"></label>
          <div class="form-actions full"><button class="btn primary">${ep?'Save product':'Add product'}</button>${ep?'<button type="button" class="btn ghost" data-act="editProduct" data-id="">Cancel</button>':''}</div>
        </form></div>
    </div>
    <div class="sec"><h2>Bins</h2><div class="tbl-wrap"><table><thead><tr><th>Bin</th><th>Product</th><th style="text-align:right">On hand</th><th style="text-align:right">Capacity</th><th style="text-align:right">Reorder</th><th>Map spot</th><th>Status</th><th></th></tr></thead><tbody>
      ${S.bins.slice().sort((a,b)=>(a.sort-b.sort)||a.code.localeCompare(b.code)).map(b=>`<tr><td><b>${esc(b.code)}</b></td><td>${esc(prodName(b.product_id))}</td><td class="n">${fmtN(S.onHand[b.id]||0)}</td><td class="n">${fmtN(b.capacity_yd)}</td><td class="n">${fmtN(b.reorder_yd)}</td><td class="muted">${b.map_x&&b.map_y?'Col '+b.map_x+' · Row '+b.map_y:'—'}</td><td>${b.active===false?'<span class="chip c-mute">Inactive</span>':'<span class="chip c-ok">Active</span>'}</td><td><button class="btn sm" data-act="editBin" data-id="${b.id}">Edit</button></td></tr>`).join('')||'<tr><td colspan="8" class="muted">No bins yet.</td></tr>'}
    </tbody></table></div></div>
    <div class="sec"><h2>Products</h2><div class="tbl-wrap"><table><thead><tr><th>Product</th><th>Haul group</th><th>Shopify title</th><th>Shopify ID</th><th>Bins</th><th></th></tr></thead><tbody>
      ${S.products.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td class="muted">${esc(HAUL_GROUPS[p.haul_group]||'—')}</td><td>${(p.shopify_titles||[]).length?esc(p.shopify_titles.join(', '))+(p.shopify_variant_match?' <span class="muted">· variant “'+esc(p.shopify_variant_match)+'”</span>':''):'<span class="chip c-warn">Not linked</span>'}</td><td class="num muted">${p.shopify_product_id?esc(p.shopify_product_id):'—'}</td><td>${S.bins.filter(b=>b.product_id===p.id).map(b=>esc(b.code)).join(', ')||'—'}</td><td><button class="btn sm" data-act="editProduct" data-id="${p.id}">Edit</button></td></tr>`).join('')}
    </tbody></table></div></div>
    <div class="sec"><h2>Bulk trucks</h2>
      <p class="muted" style="margin:0;font-size:.85rem">Units per load (1 unit = ${fmtN(ydu())} yd³). Leave a cell blank if the truck doesn't haul that product. These fill in the volume when Kevin schedules a haul.</p>
      <form data-form="trucks" autocomplete="off"><div class="tbl-wrap"><table class="truck-tbl"><thead><tr><th>Truck</th>${Object.values(HAUL_GROUPS).map(l=>`<th colspan="2">${esc(l)}</th>`).join('')}</tr>
        <tr><th></th>${Object.keys(HAUL_GROUPS).map(()=>'<th>Dry</th><th>Wet</th>').join('')}</tr></thead><tbody>
        ${trucks().map(t=>`<tr><td><b>${esc(t.no)}</b></td>${Object.keys(HAUL_GROUPS).map(g=>['dry','wet'].map(c=>{ const v=t.cap?.[g]?.[c]; return `<td><input name="${esc(t.no)}|${g}|${c}" type="number" step="0.25" min="0" value="${v?Math.round(v/ydu()*100)/100:''}" aria-label="Truck ${esc(t.no)} ${esc(HAUL_GROUPS[g])} ${c}"></td>`; }).join('')).join('')}</tr>`).join('')}
      </tbody></table></div>
      <div class="form-actions" style="margin-top:10px"><label class="field" style="max-width:160px"><span>Add a truck #</span><input name="new_truck" inputmode="numeric" maxlength="20"></label><button class="btn primary">Save trucks</button></div></form></div>
    <div class="sec"><h2>Skipped Shopify items</h2>
      <p class="muted" style="margin:0;font-size:.85rem">Orders for these never draw from the yard (fees, bags, seed). Remove one to have its orders held for review instead.</p>
      <div class="filters">${(S.settings.shopify_ignore_titles||[]).map(t=>`<button data-act="unignore" data-t="${esc(t)}" title="Stop skipping">${esc(t)} ✕</button>`).join('')||'<span class="muted">None</span>'}</div></div>
    <div class="split" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
      <div class="panel panel-pad sec"><h2>Units</h2>
        <form class="form" data-form="units"><label class="field"><span>Cubic yards per unit</span><input id="un-yd" name="yd" type="number" step="0.1" min="0.1" value="${ydu()}"></label>
        <label class="field"><span>Tote sizes, yd³ (comma-separated)</span><input id="un-totes" name="totes" value="${esc(toteSizes().join(', '))}"></label>
        <div class="form-actions"><button class="btn primary">Save</button></div></form></div>
      <div class="panel panel-pad sec"><h2>Connection</h2>
        <p class="muted" style="margin:0">${A.mode==='live'?'Connected to Supabase. Changes sync to everyone in real time.':'Running on demo data saved in this browser only. The live database connection is set when the site is deployed.'}</p>
        <!-- Security: the database URL/key are set at deploy time (config.js from environment
             variables). There is deliberately no in-app field to change them, so a page visitor
             cannot point the app at a different backend. -->
        <div class="form-actions">
            ${A.mode==='demo'?confirmBtn('resetDemo','Reset demo data','','')+(store.get('ryt-force-demo',false)&&CONFIG.url?'<button type="button" class="btn" data-act="goLive">Use live data</button>':''):confirmBtn('disconnect','Use demo data','','ghost')}</div>
      </div>
    </div></section>`;
  },
  dyn:{},
};

/* =============================================================
   Render
   ============================================================= */
function header(){
  const tabs=tabsFor();
  const pullBadge=D.unmapped.length;
  const kevinBadge=S.backfills.filter(r=>r.method==='bulk'&&r.status==='requested').length;
  const confirmBadge=S.hauls.filter(h=>['scheduled','en_route'].includes(h.status)&&(h.status==='en_route'||dayDiff(h.haul_on)<=0)).length;
  const badge=t=> t==='pulls'&&pullBadge&&can.pull()?`<span class="badge">${pullBadge}</span>`
    : t==='backfill'&&has('hauling')&&kevinBadge?`<span class="badge">${kevinBadge}</span>`
    : t==='backfill'&&can.confirmDelivery()&&confirmBadge?`<span class="badge" title="Deliveries to confirm">${confirmBadge}</span>`
    : t==='debris'&&can.debris()&&debrisDue()?`<span class="badge" title="Removals due">${debrisDue()}</span>`:'';
  const who = A.mode==='demo'
    ? `<label class="who"><span>Viewing as</span><select id="demo-user" data-act-change="demoUser">${DEMO_USERS.map(u=>`<option value="${u.id}" ${u.name===S.me.name?'selected':''}>${esc(u.name)} · ${ROLES[u.role].label}</option>`).join('')}</select></label>`
    : `<span class="who">${esc(S.me.name)} · ${esc((ROLES[role()]||ROLES.viewer).label)} <button class="btn sm ghost" style="color:inherit" data-act="changePw">Change password</button><button class="btn sm ghost" style="color:inherit" data-act="signOut">Sign out</button></span>`;
  return `<header class="top"><div class="wrap">
      <div class="brand"><h1>Retail Yard</h1><span>Rexius · retail bins · yard debris · hauling</span></div>
      <span class="mode">${A.mode==='demo'?'Demo':'Live'}</span>${who}
    </div><div class="wrap"><nav class="tabs" role="tablist">${tabs.map(t=>`<button role="tab" aria-selected="${UI.tab===t}" data-act="tab" data-tab="${t}">${TAB_LABELS[t]}${badge(t)}</button>`).join('')}</nav></div></header>
    ${A.mode==='demo'?`<div class="demo-note"><div class="wrap"><b>Demo mode.</b>${window.__offlineNote?'<span>Couldn\'t reach the live Supabase database from here, so this is showing example data.</span>':''}<span>Bins, products and orders here are examples, not live yard figures. Switch people in the top bar to see each role.</span></div></div>`:''}`;
}
function render(){
  if(!tabsFor().includes(UI.tab)) UI.tab=tabsFor()[0];
  $('#app').innerHTML=header()+`<main class="wrap" id="main">${VIEWS[UI.tab].shell()}</main>`;
  renderDyn(true);
}
let dynPending=false;
function renderDyn(force){
  const main=$('#main'); if(!main) return;
  const ae=document.activeElement;
  if(!force && ae && ae.closest('[data-dyn]') && /INPUT|SELECT|TEXTAREA/.test(ae.tagName)){ dynPending=true; return; }
  dynPending=false;
  const v=VIEWS[UI.tab];
  main.querySelectorAll('[data-dyn]').forEach(el=>{ const fn=v.dyn[el.dataset.dyn]; if(fn) el.innerHTML=fn(); });
  document.querySelectorAll('[data-hint]').forEach(updateHint);
}
document.addEventListener('click',e=>{ if(e.target&&e.target.id==='bin-modal') closeBinModal(); });   // click outside the pop-up closes it
(()=>{ try{ const mq=window.matchMedia('(max-width: 720px)'); const h=()=>{ if(S&&(UI.tab==='yard'||UI.tab==='debris')) renderDyn(true); }; mq.addEventListener?mq.addEventListener('change',h):mq.addListener(h); }catch{} })();
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&UI.selBin) closeBinModal(); });
document.addEventListener('focusout',()=>setTimeout(()=>{ if(dynPending) renderDyn(); },50));

/* ---------- Bin pop-up ----------
   view  → bin level, scheduled hauls, recent activity, Take out / Order buttons
   draw  → take-out form for this bin
   order → order form for this bin
   Lives outside #main so data refreshes don't wipe a half-filled form. */
function binModalHTML(){
  const b=D.bin[UI.selBin]; if(!b) return '';
  const head=(title,sub)=>`<div class="bm-head"><div><div class="bm-title">${esc(title)}</div><div class="bm-sub">${esc(sub)}</div></div>
    <button class="btn sm ghost bm-close" data-act="selBin" data-id="" aria-label="Close">✕</button></div>`;
  const name=prodName(b.product_id);
  if(b.site==='debris'&&UI.binMode!=='count') return debrisModalHTML(b,head,name);
  if(UI.binMode==='draw') return head('Take out product', `${name} · Bin ${b.code}`)+`
    <button class="btn sm ghost bm-back" data-act="binMode" data-v="view">← Back to bin</button>
    <form class="form" data-form="internal" data-modal="1" autocomplete="off">${drawFormFields(b)}
      <div class="form-actions full"><button class="btn take">Take out product</button><span class="hint" id="io-hint"></span></div></form>`;
  if(UI.binMode==='order'){
    const s=D.stats[b.id]; const fill=Math.max(0, r1((Number(b.capacity_yd)||0)-s.proj))||'';
    return head('Order product', `${name} · Bin ${b.code}`)+`
    <button class="btn sm ghost bm-back" data-act="binMode" data-v="view">← Back to bin</button>
    <form class="form" data-form="request" data-modal="1" autocomplete="off">${orderFormFields(b,fill)}
      <div class="form-actions full"><button class="btn order">Send order</button><span class="hint" id="rq-hint"></span></div></form>`;
  }
  if(UI.binMode==='count'){
    const s=D.stats[b.id];
    return head('Count bin', `${name} · Bin ${b.code}`)+`
    <button class="btn sm ghost bm-back" data-act="binMode" data-v="view">← Back to bin</button>
    <p class="muted" style="margin:0">The tracker shows <b class="num">${fmtYd(s.onHand)}</b> (${fmtUnits(s.onHand)}). Enter what's actually in the bin; the difference is logged in the Ledger.</p>
    <form class="form" data-form="binCount" data-id="${b.id}" autocomplete="off">
      ${qtyField('qty','Counted volume')}
      <label class="field full"><span>Note (optional)</span><input name="note" maxlength="200" placeholder="Weekly count, spill, mis-pull…"></label>
      <div class="form-actions full"><button class="btn primary">Save count</button></div></form>`;
  }
  const hauls=D.openHauls.filter(h=>h.bin_id===b.id).sort((x,y)=>(x.haul_on||'').localeCompare(y.haul_on||''));
  const recent=S.movements.filter(m=>m.bin_id===b.id).slice(0,5);
  const tl=rows=>`<div class="timeline">${rows.join('')}</div>`;
  return head(name, `Bin ${b.code}`)+`
    ${binCard(b)}
    ${b.product_id&&(can.order()||can.request()||can.adjust())?`<div class="bm-actions">
      ${can.order()?'<button class="btn take" data-act="binMode" data-v="draw">Take out product</button>':''}
      ${can.request()?'<button class="btn order" data-act="binMode" data-v="order">Order product</button>':''}
      ${can.adjust()?'<button class="btn" data-act="binMode" data-v="count">Count bin</button>':''}</div>`:''}
    ${hauls.length?`<div class="muted" style="font:500 .7rem var(--f-mono);text-transform:uppercase;letter-spacing:.08em">Coming in</div>
      ${tl(hauls.map(h=>`<div class="tl"><span class="d">${esc(fmtDate(h.haul_on))}</span><span>Truck ${esc(h.truck_no)} (${esc(h.status.replace('_',' '))})</span><span class="q num pos">${signed(Number(h.volume_yd))}</span></div>`))}`:''}
    ${recent.length?`<div class="muted" style="font:500 .7rem var(--f-mono);text-transform:uppercase;letter-spacing:.08em">Recent activity</div>
      ${tl(recent.map(m=>`<div class="tl"><span class="d">${esc(fmtDate(m.occurred_on||m.created_at.slice(0,10)))}</span><span>${esc(m.note||m.kind)}</span><span class="q num ${m.qty_yd<0?'neg':'pos'}">${signed(Number(m.qty_yd))}</span></div>`))}`:''}
    ${can.binCapacity()?`<form class="cap-form" data-form="binCap" data-id="${b.id}" autocomplete="off">
      <label class="field"><span>Bin capacity</span><div class="qty"><input id="cap-${b.id}" name="capacity" type="number" min="1" step="0.5" inputmode="decimal" value="${esc(b.capacity_yd)}" required><span class="cap-unit">yd³</span></div></label>
      <button class="btn sm">Save capacity</button></form>`:''}
`;
}
function debrisModalHTML(b,head,name){
  const back=`<button class="btn sm ghost bm-back" data-act="binMode" data-v="view">← Back to pile</button>`;
  if(DEBRIS_FORMS[UI.binMode]&&can.debris()){
    const [title,cls,btn]=DEBRIS_FORMS[UI.binMode];
    return head(title,`${name} · Pile ${b.code}`)+back+`<form class="form" data-form="debris" data-kind="${UI.binMode}" data-modal="1" autocomplete="off">${debrisFields(UI.binMode,b)}
      <div class="form-actions full"><button class="btn ${cls}">${esc(btn)}</button></div></form>`;
  }
  const sched=S.debris.filter(e=>e.bin_id===b.id&&e.kind==='removal'&&e.status==='scheduled').sort((x,y)=>x.happened_on.localeCompare(y.happened_on));
  const recent=S.movements.filter(m=>m.bin_id===b.id).slice(0,5);
  const label=t=>`<div class="muted" style="font:500 .7rem var(--f-mono);text-transform:uppercase;letter-spacing:.08em">${t}</div>`;
  return head(name,`Yard Debris · Pile ${b.code}`)+`
    ${debrisCard(b)}
    ${can.debris()||can.adjust()?`<div class="bm-actions">
      ${can.debris()&&b.debris_role!=='ground'?'<button class="btn order" data-act="binMode" data-v="intake">Add debris</button>':''}
      ${can.debris()&&b.debris_role==='grind'?'<button class="btn" data-act="binMode" data-v="grind">Record grind</button>':''}
      ${can.debris()?'<button class="btn take" data-act="binMode" data-v="removal">Haul away</button>':''}
      ${can.adjust()?'<button class="btn" data-act="binMode" data-v="count">Count pile</button>':''}</div>`:''}
    ${sched.length?label('Scheduled removals')+`<div class="rows">${sched.map(debrisRemovalRow).join('')}</div>`:''}
    ${recent.length?label('Recent activity')+`<div class="timeline">${recent.map(m=>`<div class="tl"><span class="d">${esc(fmtDate(m.occurred_on||m.created_at.slice(0,10)))}</span><span>${esc(m.note||m.kind)}</span><span class="q num ${m.qty_yd<0?'neg':'pos'}">${signed(Number(m.qty_yd))}</span></div>`).join('')}</div>`:''}
    ${can.binCapacity()?`<form class="cap-form" data-form="binCap" data-id="${b.id}" autocomplete="off">
      <label class="field"><span>Pile capacity</span><div class="qty"><input id="cap-${b.id}" name="capacity" type="number" min="1" step="0.5" inputmode="decimal" value="${esc(b.capacity_yd)}" required><span class="cap-unit">yd³</span></div></label>
      <button class="btn sm">Save capacity</button></form>`:''}`;
}
function renderBinModal(){
  let m=$('#bin-modal');
  if(!m){ m=document.createElement('div'); m.id='bin-modal'; m.hidden=true; document.body.appendChild(m); }
  const open=!!(UI.selBin&&D&&D.bin[UI.selBin]&&(UI.tab==='yard'||UI.tab==='debris'));
  if(!open&&UI.selBin){ UI.selBin=null; }
  m.hidden=!open; document.body.classList.toggle('modal-open',open);
  if(!open){ m.innerHTML=''; return; }
  m.innerHTML=`<div class="bm-panel" role="dialog" aria-modal="true" aria-label="Bin ${esc(D.bin[UI.selBin].code)}">${binModalHTML()}</div>`;
  m.querySelectorAll('[data-hint]').forEach(updateHint);
  if(UI.binMode==='draw') $('#io-cust')?.focus();
  else if(UI.binMode==='order'||UI.binMode==='count') $('#qty-'+UI.tab)?.focus();
  else if(DEBRIS_FORMS[UI.binMode]) $('#bin-modal [name=qty]')?.focus();
}
function closeBinModal(){ UI.selBin=null; UI.binMode='view'; renderBinModal(); renderDyn(true); }

let reloading=null, reloadAgain=false;
async function reload(opts={}){
  // One load at a time; if another change arrives mid-load, load once more after.
  if(reloading){ reloadAgain=true; return reloading; }
  reloading=doReload(opts).finally(()=>{ reloading=null; if(reloadAgain){ reloadAgain=false; reload(); } });
  return reloading;
}
async function doReload({shell=false}={}){
  S=await A.load(); derive();
  if(shell) render(); else { const nav=$('.top'); if(nav) nav.outerHTML=header().split('</header>')[0]+'</header>'; renderDyn(); }
  if(UI.selBin&&UI.binMode==='view') renderBinModal();   // forms in the pop-up are left alone
}
function updateHint(sel){
  const out=$('#'+sel.dataset.hint); if(!out) return;
  const s=D.stats[sel.dataset.hintBin||(sel.dataset.hintProduct?D.defaultBin(sel.value):sel.value)];
  if(!s){ out.textContent=''; out.classList.remove('warn'); return; }
  out.textContent=`${fmtYd(s.onHand)} on hand${s.inc?' · '+fmtN(s.inc)+' yd³ incoming':''}`;
  out.classList.toggle('warn', s.avail<=0);
}

/* =============================================================
   Actions
   ============================================================= */
async function run(fn, ok){
  try{ await fn(); if(ok) toast(ok); await reload(); return true; }
  catch(e){ console.error(e); toast(friendlyError(e), true); await reload().catch(()=>{}); return false; }
}
const ACT={
  tab(d){ UI.selBin=null; renderBinModal(); UI.tab=d.tab; store.set('ryt-tab',UI.tab); UI.prefillBin=null; UI.prefillQty=null; render(); try{ window.scrollTo({top:0}); }catch{} },
  pullFilter(d){ UI.pullFilter=d.v; renderDyn(true); },
  yardView(d){ UI.yardView=d.v; store.set('ryt-yardview',d.v); renderDyn(true); },
  selBin(d){ if(!d.id) return closeBinModal(); UI.selBin=d.id; UI.binMode='view'; renderBinModal(); renderDyn(true); },
  binMode(d){ UI.binMode=d.v; renderBinModal(); },
  countBin(d){ UI.selBin=null; renderBinModal(); UI.tab='ledger'; render(); const sel=$('#ad-bin'); if(sel){ sel.value=d.id; updateHint(sel); $('#qty-ledger')?.focus(); } },
  bfFilter(d){ UI.bfFilter=d.v; renderDyn(true); },
  haulFilter(d){ UI.haulFilter=d.v; renderDyn(true); },
  quickReq(d){
    // From the yard ("Needs attention" list): open the order form in the bin pop-up instead of leaving the map.
    if(UI.tab==='yard'&&D.bin[d.bin]){ UI.selBin=d.bin; UI.binMode='order'; renderBinModal(); renderDyn(true); return; }
    const b=D.bin[d.bin], s=D.stats[d.bin];
    UI.prefillBin=d.bin; UI.prefillQty=Math.max(0, r1((Number(b.capacity_yd)||0) - s.proj)) || '';
    UI.tab='backfill'; render(); UI.prefillBin=null; UI.prefillQty=null;
    $('#qty-backfill')?.focus();
  },
  drawFor(d){
    UI.tab='pulls'; store.set('ryt-tab',UI.tab); render(); try{ window.scrollTo({top:0}); }catch{}
    const b=d.bin&&D.bin[d.bin], sel=$('#io-prod');
    if(b&&sel){ sel.value=b.product_id; updateHint(sel); $('#qty-pulls')?.focus(); } else $('#io-cust')?.focus();
  },
  orderFor(){ UI.tab='backfill'; UI.prefillBin=null; render(); UI.prefillOpen=false; const dt=$('details.adder'); if(dt) dt.open=true; $('#rq-bin')?.focus(); try{ window.scrollTo({top:0}); }catch{} },
  scheduleReq(d){ UI.tab='backfill'; UI.bfFilter='bulk'; UI.openHaulFor=d.id; render(); },
  haulOpen(d){ UI.openHaulFor=d.id; renderDyn(true); const sel=$('[data-form="haul"] [name=truck_sel]'); if(sel){ CHANGE.haulCalc(sel); sel.focus(); } },
  haulClose(){ UI.openHaulFor=null; renderDyn(true); },
  pull(d){ run(()=>A.update(d.src==='shopify'?'shopify_order_lines':'internal_orders',d.id,{status:'pulled'}),'Marked pulled. Bin updated.'); },
  unpull(d){ run(()=>A.update(d.src==='shopify'?'shopify_order_lines':'internal_orders',d.id,{status:d.src==='shopify'?'pending':'open'}),'Pull reversed. Volume returned to the bin.'); },
  reverseShop(d){ run(()=>A.update('shopify_order_lines',d.id,{status:'ignored'}),'Draw reversed. Volume returned to the bin.'); },
  simShop(){
    const opts=D.activeBins.filter(b=>b.product_id&&(D.product[b.product_id]?.shopify_titles||[]).length&&D.defaultBin(b.product_id)===b.id);
    if(!opts.length){ toast('Add a Shopify title to a product in Setup first.',true); return; }
    const b=opts[Math.floor(Math.random()*opts.length)], p=D.product[b.product_id], v=['0.5','1','1','7.5'][Math.floor(Math.random()*4)], qn=v==='1'?1+Math.floor(Math.random()*5):1, yd=r1(Number(v)*qn);
    const n='#R'+(4830+S.shopifyLines.length);
    run(()=>A.insert('shopify_order_lines',{order_name:n,customer_name:'Demo customer',ordered_at:nowISO(),shopify_product_id:p.shopify_product_id,product_id:p.id,title:p.shopify_titles[0],variant_title:p.shopify_variant_match?p.shopify_variant_match+' / '+v:v,quantity:qn,yd_each:Number(v),qty_yd:yd,bin_id:null,status:'pulled'}),
      `Shopify ${n}: ${fmtYd(yd)} ${p.shopify_titles[0]}${p.shopify_variant_match?' ('+p.shopify_variant_match+')':''} drawn from ${b.code}.`);
  },
  undoIO(d){ run(()=>A.update('internal_orders',d.id,{status:'cancelled'}),'Order undone. Volume returned to the bin.'); },
  cancelReq(d){ run(()=>A.update('backfill_requests',d.id,{status:'cancelled'}),'Request cancelled.'); },
  haulStatus(d){ run(()=>A.update('hauls',d.id,{status:d.v}), d.v==='delivered'?'Delivery confirmed. Volume added to the bin.':'Marked en route.'); },
  haulCancel(d){ run(()=>A.update('hauls',d.id,{status:'cancelled'}),'Haul cancelled.'); },
  debrisForm(d){ UI.debrisForm=d.v||null; render(); if(UI.debrisForm) $('[data-form="debris"] select, [data-form="debris"] [name=qty]')?.focus(); },
  debrisDone(d){ run(()=>A.update('debris_events',d.id,{status:'done'}),'Removal confirmed. Volume taken off the pile.'); },
  debrisCancel(d){ run(()=>A.update('debris_events',d.id,{status:'cancelled'}),'Removal cancelled.'); },
  debrisUndo(d){ run(()=>A.update('debris_events',d.id,{status:'cancelled'}),'Undone. The piles are back to where they were.'); },
  haulUndo(d){ run(()=>A.update('hauls',d.id,{status:'scheduled'}),'Delivery undone. Volume taken back out of the bin.'); },
  mapOpen(d){ UI.mapLine=d.id; renderDyn(true); },
  mapClose(){ UI.mapLine=null; renderDyn(true); },
  ignoreLine(d){
    const line=S.shopifyLines.find(l=>l.id===d.id); const t=String(line?.title||'').trim();
    run(async()=>{
      const list=[...new Set([...(S.settings.shopify_ignore_titles||[]),t].filter(Boolean))];
      await A.setSetting('shopify_ignore_titles',list);
      const ids=S.shopifyLines.filter(x=>x.status==='unmapped'&&String(x.title).trim().toLowerCase()===t.toLowerCase()).map(x=>x.id);
      if(ids.length) await A.updateMany('shopify_order_lines',ids,{status:'ignored'});   // one request, not one per line
    },`“${t}” is now skipped. Future orders for it won't touch inventory.`);
  },
  unignore(d){ run(()=>A.setSetting('shopify_ignore_titles',(S.settings.shopify_ignore_titles||[]).filter(x=>x!==d.t)),`“${d.t}” will be held for review again.`).then(()=>render()); },
  editBin(d){ UI.editBin=d.id||null; render(); },
  editProduct(d){ UI.editProduct=d.id||null; render(); },
  resetDemo(){ A.reset(); reload({shell:true}).then(()=>toast('Demo data reset.')); },
  disconnect(){ store.set('ryt-force-demo',true); location.reload(); },
  goLive(){ store.del('ryt-force-demo'); location.reload(); },
  reload(){ location.reload(); },
  async signOut(){ await A.signOut(); location.reload(); },
  changePw(){ changePasswordScreen(); },
};
function truckOf(fd){ const v=fd.get('truck_sel'); return v==='other'?String(fd.get('truck_other')||'').trim():String(v||'').trim(); }
const CHANGE={
  haulTouch(el){ el.dataset.touched='1'; },
  haulCalc(el){
    const f=el.closest('form'); if(!f) return;
    const sel=f.querySelector('[name=truck_sel]'), other=f.querySelector('[data-other-truck]');
    if(other){ other.hidden=sel.value!=='other'; f.querySelector('[name=truck_other]').required=sel.value==='other'; }
    const pid=f.dataset.pid||f.querySelector('[name=product_id]')?.value; const cond=f.querySelector('[name=conditions]').value;
    const loadsEl=f.querySelector('[name=loads]'), vol=f.querySelector('[name=volume]'), hint=f.querySelector('[data-truck-hint]');
    const cap=sel.value==='other'?null:truckCap(sel.value,pid,cond);
    if(el===sel||el.name==='conditions'||el.name==='product_id'){
      const rem=Number(f.dataset.remaining)||0; if(cap&&rem&&el!==loadsEl) loadsEl.value=Math.max(1,Math.ceil(rem/cap));
    }
    const n=Math.max(1,parseInt(loadsEl.value,10)||1);
    if(cap){ vol.value=r1(n*cap); delete vol.dataset.touched;
      hint.textContent=`Truck ${sel.value} carries ${fmtN(cap)} yd³ (${fmtUnits(cap)}) of ${HAUL_GROUPS[D.product[pid]?.haul_group]||'this product'} ${cond} per load · ${n} load${n>1?'s':''} = ${fmtYd(n*cap)}`;
      hint.classList.remove('warn'); }
    else { hint.textContent = !pid ? '' : sel.value==='other' ? 'Enter the volume for this truck.' : `No capacity on file for ${prodName(pid)} on Truck ${sel.value}. Enter the volume.`; hint.classList.toggle('warn',!!pid&&sel.value!=='other'); }
  },
  drawMode(){
    const f=$('[data-form="internal"]'); if(!f) return; const totes=$('#io-mode')?.value==='totes';
    f.querySelectorAll('[data-tote]').forEach(e=>e.hidden=!totes);
    const vol=f.querySelector('[data-vol]'); vol.hidden=totes; vol.style.display=totes?'none':'contents';
    f.querySelector('[name=qty]').required=!totes; $('#io-totes').required=totes;
    if(totes) $('#io-totes').focus(); CHANGE.toteCalc();
  },
  toteCalc(){
    const out=$('#io-calc'); if(!out) return; const n=parseInt($('#io-totes').value,10), size=Number($('#io-tsize').value);
    out.textContent = n>0 ? `${n} tote${n>1?'s':''} × ${fmtN(size)} yd³ = ${fmtYd(n*size)}  (${fmtUnits(n*size)})` : 'Enter how many totes';
  },
  custSel(el){ const w=$('#io-other-wrap'); if(w){ w.hidden=el.value!=='Other'; $('#io-other').required=el.value==='Other'; if(el.value==='Other') $('#io-other').focus(); } },
  demoUser(el){ A.setUser(el.value); reload({shell:true}); },
  ledgerBin(el){ UI.ledgerBin=el.value; renderDyn(true); },
  debrisTruck(el){ const f=el.closest('form'); const o=f?.querySelector('[data-other-truck]'); if(!o) return; o.hidden=el.value!=='other'; const i=f.querySelector('[name=truck_other]'); i.required=el.value==='other'; if(el.value==='other') i.focus(); },
};
document.addEventListener('click',e=>{
  const a=e.target.closest('[data-act]'); if(!a) return;
  if(a.tagName==='SUMMARY') return;
  if(a.dataset.confirm && !a.classList.contains('armed')){
    e.preventDefault(); a.classList.add('armed'); a.textContent='Confirm '+a.dataset.confirm.toLowerCase();
    setTimeout(()=>{ if(a.isConnected){ a.classList.remove('armed'); a.textContent=a.dataset.confirm; } },3500); return;
  }
  const fn=ACT[a.dataset.act]; if(fn){ e.preventDefault(); fn(a.dataset,a); }
});
document.addEventListener('input',e=>{ const el=e.target; if(el.dataset&&el.dataset.actInput&&CHANGE[el.dataset.actInput]) CHANGE[el.dataset.actInput](el); });
document.addEventListener('change',e=>{
  const el=e.target;
  if(el.dataset.actChange&&CHANGE[el.dataset.actChange]) CHANGE[el.dataset.actChange](el);
  if(el.dataset.hint) updateHint(el);
});

const FORM={
  async internal(fd,f){
    let cust=fd.get('customer'); if(cust==='Other'){ const o=fd.get('other').trim(); cust=o?'Other — '+o:'Other'; }
    const pid=fd.get('product_id'); const bin=fd.get('bin_id')||D.defaultBin(pid);   // pop-up: the clicked bin
    const inModal=!!f.dataset.modal;
    const totes=fd.get('mode')==='totes'; const n=parseInt(fd.get('totes'),10), size=Number(fd.get('tote_size'));
    if(totes&&!(n>0)){ toast('Enter how many totes.',true); return; }
    const yd=totes?r1(n*size):toYd(fd);
    if(!(yd>0)){ toast('Enter a volume to draw.',true); return; }
    if(!bin){ toast('That product has no bin. Add one in Setup.',true); return; }
    const toteNote=totes?`${n} × ${fmtN(size)} yd³ tote${n>1?'s':''}`:null;
    const ok=await run(()=>A.insert('internal_orders',{customer:cust,reference:toteNote,bin_id:bin,product_id:pid,tote_count:totes?n:null,tote_size_yd:totes?size:null,
      qty_yd:yd,pull_on:fd.get('pull_on')||isoDay(),status:'pulled',notes:fd.get('notes').trim()||null}),`Took out ${fmtYd(yd)} ${prodName(pid)} for ${cust}${toteNote?' ('+toteNote+')':''}.`);
    if(inModal){ if(ok){ UI.binMode='view'; renderBinModal(); } return; }   // back to the bin, showing the new level
    f.reset(); $('#io-date').value=isoDay(); $('#io-other-wrap').hidden=true; CHANGE.drawMode(); if($('#io-prod')) updateHint($('#io-prod'));
  },
  async request(fd,f){
    const bin=D.bin[fd.get('bin_id')||D.defaultBin(fd.get('product_id'))]; const m=fd.get('method');
    const inModal=!!f.dataset.modal;
    if(!bin){ toast('That product has no bin. Add one in Setup.',true); return; }
    const ok=await run(()=>A.insert('backfill_requests',{bin_id:bin.id,product_id:bin.product_id,qty_yd:toYd(fd),needed_by:fd.get('needed_by')||null,method:m,status:'requested',notes:fd.get('notes').trim()||null}),
      m==='bulk'?'Order sent to Kevin.':'Slinger order added. Schedule it on the board.');
    if(inModal){ if(ok){ UI.binMode='view'; renderBinModal(); } return; }
    f.reset(); $('#rq-date').value=isoDay(1);
  },
  async haul(fd,f){
    const r=S.backfills.find(x=>x.id===f.dataset.req);
    UI.openHaulFor=null;
    const tr=truckOf(fd); if(!tr){ toast('Enter the truck number.',true); return; }
    await run(()=>A.insert('hauls',{request_id:r.id,method:r.method,truck_no:tr,loads:Math.max(1,parseInt(fd.get('loads'),10)||1),conditions:fd.get('conditions'),bin_id:r.bin_id,product_id:r.product_id,volume_yd:r1(fd.get('volume')),haul_on:fd.get('haul_on')||isoDay(),status:'scheduled'}),'Haul scheduled.');
  },
  async haulFree(fd,f){
    // A delivery that arrived (or is booked) without an order: create the order and its truck
    // together, so everything shows on the one Order Product board.
    const pid=fd.get('product_id'); const bin=D.bin[D.defaultBin(pid)];
    if(!bin){ toast('That product has no bin. Add one in Setup.',true); return; }
    const tr=truckOf(fd); if(!tr){ toast('Enter the truck number.',true); return; }
    const vol=r1(fd.get('volume')); if(!(vol>0)){ toast('Enter the volume.',true); return; }
    const day=fd.get('haul_on')||isoDay(), method=fd.get('method'), status=fd.get('status');
    const ok=await run(async()=>{
      const req=await A.insert('backfill_requests',{bin_id:bin.id,product_id:bin.product_id,qty_yd:vol,needed_by:day,method,status:'requested',notes:'Logged delivery (no order placed)'});
      await A.insert('hauls',{request_id:req.id,method,truck_no:tr,loads:Math.max(1,parseInt(fd.get('loads'),10)||1),conditions:fd.get('conditions'),bin_id:bin.id,product_id:bin.product_id,volume_yd:vol,haul_on:day,status});
    }, status==='delivered'?'Delivery logged. Volume added to the bin.':'Delivery scheduled. Confirm it when it arrives.');
    if(ok){ f.reset(); if($('#hf-date')) $('#hf-date').value=isoDay(); }
  },
  async debris(fd,f){
    const kind=f.dataset.kind, inModal=!!f.dataset.modal;
    const qty=r1(fd.get('qty')); if(!(qty>0)){ toast('Enter the volume.',true); return; }
    const b=D.bin[fd.get('bin_id')]; if(!b){ toast('Choose a pile.',true); return; }
    const row={kind,bin_id:b.id,qty_yd:qty,happened_on:fd.get('happened_on')||isoDay(),status:'done',notes:String(fd.get('notes')||'').trim()||null};
    const pn=prodName(b.product_id); let msg;
    if(kind==='intake'){ row.source=String(fd.get('source')||'').trim()||null; msg=`Added ${fmtYd(qty)} to ${pn}.`; }
    else if(kind==='grind'){
      const tq=r1(fd.get('to_qty')); if(!(tq>0)){ toast('Enter how much ground material was made.',true); return; }
      row.to_bin_id=fd.get('to_bin_id'); row.to_qty_yd=tq;
      msg=`Ground ${fmtYd(qty)} of ${pn} into ${fmtYd(tq)} of ${prodName(D.bin[row.to_bin_id]?.product_id)}.`;
    } else {
      const h=truckOf(fd); if(!h){ toast('Enter the hauler.',true); return; }
      row.hauler=h; row.loads=Math.max(1,parseInt(fd.get('loads'),10)||1);
      row.status=fd.get('status')==='scheduled'?'scheduled':'done';
      msg=row.status==='done'?`Hauled away ${fmtYd(qty)} of ${pn}.`:`Removal scheduled: ${fmtYd(qty)} of ${pn}, ${whenDate(row.happened_on)}.`;
    }
    if(row.status==='done'&&dayDiff(row.happened_on)>0){ toast(kind==='removal'?'A haul that already happened can’t be dated in the future. Choose “Schedule” instead.':'The date can’t be in the future.',true); return; }
    const ok=await run(()=>A.insert('debris_events',row),msg);
    if(!ok) return;
    if(inModal){ UI.binMode='view'; renderBinModal(); } else { UI.debrisForm=null; render(); }
  },
  async binCount(fd,f){
    const b=D.bin[f.dataset.id]; if(!b) return;
    const raw=String(fd.get('qty')??'').trim();
    if(raw===''){ toast('Enter the counted volume.',true); return; }
    const v=toYd(fd), cur=D.stats[b.id].onHand, delta=r1(v-cur);
    if(!(v>=0)){ toast('Counted volume can’t be negative.',true); return; }
    if(!delta){ toast(`No change. ${b.code} already reads ${fmtYd(cur)}.`); UI.binMode='view'; renderBinModal(); return; }
    const note=String(fd.get('note')||'').trim();
    const ok=await run(()=>A.insert('movements',{bin_id:b.id,product_id:b.product_id,qty_yd:delta,kind:'count',occurred_on:isoDay(),
      note:`Count: ${fmtN(v)} yd³ (was ${fmtN(cur)})`+(note?' — '+note:'')}),`${prodName(b.product_id)} (${b.code}) set to ${fmtYd(v)}.`);
    if(ok){ UI.binMode='view'; renderBinModal(); }
  },
  async binCap(fd,f){
    const b=D.bin[f.dataset.id]; const cap=r1(fd.get('capacity'));
    if(!(cap>0)){ toast('Enter a capacity above 0.',true); return; }
    if(cap===Number(b.capacity_yd)){ toast('Capacity unchanged.'); return; }
    await run(()=>A.update('bins',b.id,{capacity_yd:cap}),`${prodName(b.product_id)} (${b.code}) capacity set to ${fmtYd(cap)}.`);
  },
  async trucks(fd,f){
    const old=trucks(); const list=old.map(t=>({no:t.no,cap:{}}));
    const toYdKeep=(u,prev)=>{ if(!(u>0)) return null; const y=u*ydu(); return prev&&Math.abs(prev-y)<0.05?prev:Math.round(y*100)/100; };
    list.forEach((t,i)=>Object.keys(HAUL_GROUPS).forEach(g=>{ const pc=old[i].cap?.[g]||{};
      const d=toYdKeep(Number(fd.get(`${t.no}|${g}|dry`)),pc.dry), w=toYdKeep(Number(fd.get(`${t.no}|${g}|wet`)),pc.wet);
      if(d||w) t.cap[g]={dry:d,wet:w}; }));
    const add=String(fd.get('new_truck')||'').trim(); if(add&&!list.some(t=>t.no===add)) list.push({no:add,cap:{}});
    await run(()=>A.setSetting('trucks',list),'Trucks saved.'); render();
  },
  async adjust(fd,f){
    const bin=D.bin[fd.get('bin_id')]; const v=toYd(fd); const cur=D.stats[bin.id].onHand;
    const isCount=fd.get('mode')==='count';
    const delta=r1(isCount?v-cur:v);
    if(!delta){ toast('No change. The bin already reads '+fmtYd(cur)+'.'); return; }
    await run(()=>A.insert('movements',{bin_id:bin.id,product_id:bin.product_id,qty_yd:delta,kind:isCount?'count':'adjustment',occurred_on:isoDay(),
      note:(isCount?`Count: ${fmtN(v)} yd³ (was ${fmtN(cur)})`:'Adjustment')+(fd.get('note').trim()?' — '+fd.get('note').trim():'')}),
      `${bin.code} ${isCount?'set to '+fmtYd(v):'adjusted '+signed(delta)+' yd³'}.`);
    f.reset();
  },
  async mapLine(fd,f){
    const line=S.shopifyLines.find(l=>l.id===f.dataset.id); const pid=fd.get('product_id'); const ydEach=r1(fd.get('yd_each'));
    UI.mapLine=null;
    await run(async()=>{
      await A.update('shopify_order_lines',line.id,{product_id:pid,yd_each:ydEach,qty_yd:r1(ydEach*line.quantity),status:'pulled'});
      if(fd.get('link')){
        const prod=D.product[pid]; const t=cleanStr(line.title||'');
        // Only remember the title if it fits the product's limits (≤10 titles, ≤200 chars), so
        // the line is never drawn while the product update fails.
        const known=(prod.shopify_titles||[]).some(x=>x.toLowerCase()===t.toLowerCase());
        const canLearn=t&&t.length<=200&&(known||(prod.shopify_titles||[]).length<10);
        if(canLearn&&!known) await A.update('products',pid,{shopify_titles:[...(prod.shopify_titles||[]),t],...(!prod.shopify_product_id&&line.shopify_product_id?{shopify_product_id:line.shopify_product_id}:{})});
        if(t) await A.linkTitle(pid,t);   // all other held lines with this title, in one request
      }
    },(()=>{ const prod=D.product[pid]; const t=cleanStr(line.title||'');
      const ok=!fd.get('link')||(t.length<=200&&((prod?.shopify_titles||[]).some(x=>x.toLowerCase()===t.toLowerCase())||(prod?.shopify_titles||[]).length<10));
      return ok?'Linked. The order drew from inventory.':'Linked this order. Its Shopify title is too long or the product already has 10 titles, so future orders will still be held.'; })());
  },
  async bin(fd,f){
    const n=k=>{ const v=fd.get(k); return v===''||v==null?null:Number(v); };
    const row={code:fd.get('code').trim(),product_id:fd.get('product_id')||null,capacity_yd:r1(fd.get('capacity_yd')),reorder_yd:r1(fd.get('reorder_yd')),sort:Number(fd.get('sort'))||0,active:!!fd.get('active'),map_x:n('map_x'),map_y:n('map_y'),map_w:1,map_h:n('map_h')||3};
    const id=f.dataset.id;
    UI.editBin=null;
    await run(()=>id?A.update('bins',id,row):A.insert('bins',row), id?'Bin saved.':'Bin added.');
    render();
  },
  async product(fd,f){
    const shop=fd.get('shopify_product_id').trim();
    const titles=[...new Set(fd.get('shopify_titles').split(',').map(t=>t.trim()).filter(Boolean))];
    const row={name:fd.get('name').trim(),sku:fd.get('sku').trim()||null,shopify_product_id:shop?Number(shop):null,shopify_titles:titles,shopify_variant_match:fd.get('shopify_variant_match').trim()||null,haul_group:fd.get('haul_group')||null};
    const id=f.dataset.id; UI.editProduct=null;
    await run(()=>id?A.update('products',id,row):A.insert('products',{...row,active:true}), id?'Product saved.':'Product added.');
    render();
  },
  async units(fd){
    const sizes=[...new Set(String(fd.get('totes')).split(',').map(x=>Number(x.trim())).filter(n=>n>0))].sort((a,b)=>a-b);
    await run(async()=>{ await A.setSetting('yd_per_unit',Number(fd.get('yd'))); if(sizes.length) await A.setSetting('tote_sizes',sizes); },'Units and tote sizes saved.'); render();
  },
};
document.addEventListener('submit',e=>{
  const f=e.target; if(!f.dataset.form) return; e.preventDefault();
  const btn=f.querySelector('button:not([type="button"])'); if(btn) btn.disabled=true;
  Promise.resolve(FORM[f.dataset.form](new FormData(f),f)).finally(()=>{ if(btn&&btn.isConnected) btn.disabled=false; });
});

/* =============================================================
   Boot
   ============================================================= */
const MIN_PASSWORD=10;
function signInScreen(){
  $('#app').innerHTML=`<div class="signin panel sec">
    <h1 style="font-size:2rem;text-transform:uppercase">Retail Yard</h1>
    <p class="muted" style="margin:0">Sign in with your Rexius email and password.</p>
    <form class="form" id="si-form" style="grid-template-columns:1fr" novalidate>
      <label class="field"><span>Email</span><input id="si-email" type="email" required autocomplete="username" maxlength="254"></label>
      <label class="field"><span>Password</span><input id="si-pass" type="password" required autocomplete="current-password" maxlength="128"></label>
      <div class="form-actions"><button class="btn primary" id="si-btn">Sign in</button>
        <span class="hint" id="si-hint" aria-live="polite"></span></div>
    </form>
    <p class="muted" style="margin:0;font-size:.85rem">Forgot your password or don't have one? Ask an admin to set one for you.</p>
    <button class="btn sm ghost" style="justify-self:start" data-act="disconnect">Use demo data instead</button></div>`;
  /* Sign-in throttling (OWASP A07). Supabase Auth limits password attempts server-side
     (Authentication → Rate Limits). This client-side lockout just stops accidental hammering
     and explains what's happening instead of showing raw errors. */
  const MAX_TRIES=5, LOCK_MS=5*60*1000, LOCK_KEY='ryt-signin-lock';
  let tries=0;
  const hint=$('#si-hint'), btn=$('#si-btn');
  const say=(msg,warn)=>{ hint.textContent=msg; hint.classList.toggle('warn',!!warn); };
  const lockedFor=()=>{ const until=store.get(LOCK_KEY,0); return until>Date.now()?Math.ceil((until-Date.now())/60000):0; };
  const authMessage=err=>{
    const m=String(err?.message||''), st=Number(err?.status||0);
    if(st===429||/rate limit|too many/i.test(m)) return 'Too many sign-in attempts. Wait a few minutes and try again.';
    if(/invalid login|invalid credentials|invalid grant/i.test(m)) return 'Email or password is incorrect.';
    if(/not confirmed/i.test(m)) return 'This account isn’t confirmed yet. Ask an admin to confirm it.';
    return 'Sign-in failed. Try again.';
  };
  $('#si-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const mins=lockedFor(); if(mins){ say(`Too many failed attempts. Try again in ${mins} minute${mins>1?'s':''}.`,true); return; }
    const email=cleanStr($('#si-email').value).toLowerCase(), pw=$('#si-pass').value;
    if(email.length>254||!/^[^\s@]+@rexius\.com$/.test(email)){ say('Use your @rexius.com email address.',true); return; }
    if(!pw||pw.length>128){ say('Enter your password.',true); return; }
    btn.disabled=true; say('Signing in…');
    try{ await A.signInPassword(email,pw); store.del(LOCK_KEY); await start(); }
    catch(err){
      console.error(err);
      if(++tries>=MAX_TRIES){ store.set(LOCK_KEY,Date.now()+LOCK_MS); say('Too many failed attempts. Try again in 5 minutes.',true); }
      else say(authMessage(err),true);
    }
    finally{ if(btn.isConnected) btn.disabled=false; }
  });
}
function changePasswordScreen(){
  $('#app').innerHTML=`<div class="signin panel sec">
    <h2>Change password</h2>
    <form class="form" id="cp-form" style="grid-template-columns:1fr" novalidate>
      <label class="field"><span>New password (at least ${MIN_PASSWORD} characters)</span><input id="cp-1" type="password" autocomplete="new-password" maxlength="128" required></label>
      <label class="field"><span>Type it again</span><input id="cp-2" type="password" autocomplete="new-password" maxlength="128" required></label>
      <div class="form-actions"><button class="btn primary" id="cp-btn">Save new password</button>
        <button type="button" class="btn ghost" data-act="reload">Cancel</button>
        <span class="hint" id="cp-hint" aria-live="polite"></span></div>
    </form></div>`;
  const hint=$('#cp-hint'); const say=(m,w)=>{ hint.textContent=m; hint.classList.toggle('warn',!!w); };
  $('#cp-form').addEventListener('submit',async e=>{
    e.preventDefault();
    const a=$('#cp-1').value, b=$('#cp-2').value;
    if(a.length<MIN_PASSWORD) return say(`Use at least ${MIN_PASSWORD} characters.`,true);
    if(a.length>128) return say('That password is too long.',true);
    if(a!==b) return say('The two passwords don’t match.',true);
    $('#cp-btn').disabled=true;
    try{ await A.changePassword(a); toast('Password changed.'); await start(); }
    catch(err){ console.error(err); say(/same|different/i.test(String(err?.message))?'Choose a password you haven’t used here before.':/weak|short|characters/i.test(String(err?.message))?'That password is too weak. Make it longer.':'Couldn’t change the password. Try again.',true); $('#cp-btn').disabled=false; }
  });
}
function noAccessScreen(){
  $('#app').innerHTML=`<div class="signin panel sec"><h2>No Retail Yard access yet</h2>
    <p>You're signed in, but your account isn't set up for the Retail Yard.</p>
    <p class="muted">Ask an admin to add your email to the Retail Yard user list (Supabase → Table Editor → schema "yard" → user_invites), then reload.</p>
    <div class="form-actions"><button class="btn primary" data-act="reload">Reload</button><button class="btn ghost" data-act="signOut">Sign out</button></div></div>`;
}
/* Auto-refresh: everyone sees changes without reloading the page.
   1. Live: Supabase pushes each change (Shopify orders, other people's entries) → refresh in under a second.
   2. Backup: every 30 s while the page is on screen, in case the live connection dropped
      (phones sleeping, Wi-Fi changes). Paused while the tab is hidden.
   3. Coming back to the tab, or back online → refresh right away and reconnect.
   Forms being filled in are never wiped: open pop-up forms and focused fields are left alone. */
const POLL_MS=30000;
function autoRefresh(){
  let t, unsub=null, retry=null, gen=0;
  const soon=()=>{ clearTimeout(t); t=setTimeout(()=>reload().catch(console.error),400); };
  const connect=()=>{
    clearTimeout(retry); const my=++gen; if(unsub) unsub();
    unsub=A.subscribe(soon,st=>{
      if(my!==gen||st==='SUBSCRIBED') return;   // ignore the old channel closing
      if(st==='CHANNEL_ERROR'||st==='TIMED_OUT'||st==='CLOSED'){ clearTimeout(retry); retry=setTimeout(connect,10000); }
    });
  };
  connect();
  setInterval(()=>{ if(document.visibilityState==='visible') reload().catch(console.error); },POLL_MS);
  const wake=()=>{ if(document.visibilityState==='visible'){ reload().catch(console.error); connect(); } };
  document.addEventListener('visibilitychange',wake);
  window.addEventListener('online',wake);
}
async function start(){
  try{
    if(A.mode==='live' && !(await A.session())) return signInScreen();
    if(A.mode==='live' && !(await A.ensureProfile())) return noAccessScreen();
    S=await A.load(); derive(); render();
    if(A.mode==='live') autoRefresh();
  }catch(e){
    console.error(e);
    const m=String(e?.message||e);
    const hint=/invalid schema|schema must be one of/i.test(m)
      ? 'In Supabase: Project Settings → Data API → Exposed schemas → add "yard" → Save, then reload.'
      : 'Check that schema.sql has been run in Supabase, then reload.';
    $('#app').innerHTML=`<div class="signin panel sec"><h2>Couldn't load the yard</h2><p>${esc(m)}</p>
      <p class="muted">${esc(hint)}</p>
      <button class="btn" data-act="disconnect">Switch to demo data</button></div>`;
  }
}
async function reachable(url,key){
  try{
    const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),6000);
    const r=await fetch(url.replace(/\/$/,'')+'/auth/v1/health',{headers:{apikey:key},signal:ctl.signal}); clearTimeout(t);
    return r.ok||r.status<500;
  }catch{ return false; }
}
(async function boot(){
  try{ store.del('ryt-config'); }catch{}   // purge credentials an older version may have kept in localStorage
  const {url,key,problem}=CONFIG;
  const forceDemo=store.get('ryt-force-demo',false);
  if(problem){
    // Fail closed: never connect with a misconfigured or secret key.
    $('#app').innerHTML=`<div class="signin panel sec"><h2>Site configuration problem</h2><p>${esc(problem)}</p>
      <p class="muted">Fix the deploy environment variables and redeploy. See SECURITY.md.</p></div>`;
    return;
  }
  if(url&&key&&!forceDemo){
    if(!window.supabase){
      $('#app').innerHTML=`<div class="signin panel sec"><h2>Couldn't load the sign-in library</h2>
        <p>The page couldn't load vendor/supabase.js, so it can't connect to the yard database.</p>
        <p class="muted">Make sure the vendor folder was deployed with the site, then reload.</p>
        <div class="form-actions"><button class="btn primary" data-act="reload">Reload</button><button class="btn ghost" data-act="disconnect">Use demo data</button></div></div>`;
      return;
    }
    if(await reachable(url,key)){ A=withValidation(LiveAdapter({url,key})); return start(); }
    A=withValidation(DemoAdapter()); window.__offlineNote=true;
  } else A=withValidation(DemoAdapter());
  start();
})();

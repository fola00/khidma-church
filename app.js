/* =======================================================================
   خِدمة — Church Community App (interactive click-through prototype)
   Client-only demo: persistence via localStorage on this device only.
   ======================================================================= */

const APP_VERSION = 'v6 · readable chat colors';
const STORAGE_PREFIX = 'khidma_church_app_v3_';
const CHURCH_CODE_KEY = 'khidma_church_code';
const DIRECTOR_CODE = '__director__';
const DIRECTOR_EMAIL = 'director@khidma.app';
const DIRECTOR_PASSWORD = 'Director@2026';

/* ---- Supabase sync (shared database, one row per church, keyed by `code`) ---- */
const SUPABASE_URL = 'https://owpkjnbnyfldnmubfzsy.supabase.co';
const SUPABASE_KEY = 'sb_publishable_FeyMhWVyMkFYhOzXllF9ig_08zVqWC8';
const SUPA_HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY, 'Content-Type':'application/json' };
let lastSyncedAt = null;   // updated_at of the last remote state we applied
let syncing = false;       // true while a push is in flight, to avoid overlapping writes

async function fetchRemoteState(code){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?code=eq.${encodeURIComponent(code)}&select=data,updated_at`, { headers: SUPA_HEADERS });
    if(!res.ok) return null;
    const rows = await res.json();
    if(rows && rows[0]) return rows[0];
    return null;
  }catch(e){ console.warn('Supabase fetch failed (offline or blocked):', e); return null; }
}
async function pushRemoteState(code, s){
  if(syncing) return;
  syncing = true;
  try{
    const nowIso = new Date().toISOString();
    await fetch(`${SUPABASE_URL}/rest/v1/app_state?code=eq.${encodeURIComponent(code)}`, {
      method:'PATCH', headers: SUPA_HEADERS,
      body: JSON.stringify({ data: s, updated_at: nowIso })
    });
    lastSyncedAt = nowIso;
  }catch(e){ console.warn('Supabase push failed (offline or blocked):', e); }
  finally{ syncing = false; }
}
async function createRemoteChurch(code, s){
  const nowIso = new Date().toISOString();
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
      method:'POST', headers: {...SUPA_HEADERS, 'Prefer':'resolution=merge-duplicates'},
      body: JSON.stringify({ code, data: s, updated_at: nowIso })
    });
    if(res.ok) return { ok:true, updatedAt: nowIso };
    let detail = '';
    try{ const j = await res.json(); detail = j.message || j.hint || j.details || ''; }catch(e){}
    lastSaveError = `خطأ من قاعدة البيانات (${res.status})${detail ? ': '+detail : ''}`;
    return { ok:false, updatedAt: nowIso, network:false };
  }catch(e){
    console.warn('Supabase create failed (offline or blocked):', e);
    lastSaveError = 'لا يوجد اتصال بالإنترنت (أو الاتصال محجوب).';
    return { ok:false, updatedAt: nowIso, network:true };
  }
}
let lastSaveError = '';
/* ---- sync: the login session stays on THIS device; pushes are merged with the server and never dropped ---- */
let baseState = null;      // last state known to match the server (used for 3-way merge)
let dirty = false;         // local changes not yet confirmed on the server
let pushQueued = false;
const clone = o => JSON.parse(JSON.stringify(o));
const sameJSON = (a,b)=> JSON.stringify(a)===JSON.stringify(b);
const isDemo = ()=> churchCode === 'DEMO';
function adoptRemote(data, updatedAt){
  const keep = (state && state.session) ? state.session : { userId:null };
  state = data;
  if(!state.stages) state.stages = [];
  state.session = keep;            // never take someone else's login from the server
  lastSyncedAt = updatedAt;
  baseState = clone(state);
  saveState(state);
}
function mergeChat(b, l, r){
  const noMsgs = c=>{ const {messages, ...rest} = c || {}; return rest; };
  const seen = new Set(), msgs = [];
  [...(r.messages||[]), ...(l.messages||[])].forEach(m=>{
    const k = m.time+'|'+m.sender+'|'+m.text;
    if(!seen.has(k)){ seen.add(k); msgs.push(m); }
  });
  msgs.sort((x,y)=> new Date(x.time)-new Date(y.time));
  const side = (b && sameJSON(noMsgs(l), noMsgs(b))) ? r : l;   // whoever changed status/claim wins
  return { ...side, messages: msgs };
}
function mergeById(base, local, remote, both){
  const B = new Map((base||[]).map(x=>[x.id,x])), L = new Map((local||[]).map(x=>[x.id,x])), R = new Map((remote||[]).map(x=>[x.id,x]));
  const out = [];
  for(const id of new Set([...R.keys(), ...L.keys()])){
    const l = L.get(id), r = R.get(id), b = B.get(id);
    if(l && r) out.push(both ? both(b,l,r) : (b && sameJSON(l,b) ? r : l));
    else if(l && !r){ if(!b) out.push(l); }      // new here (if it was in base, it was deleted elsewhere)
    else if(r && !l){ if(!b) out.push(r); }      // new elsewhere (if it was in base, we deleted it)
  }
  return out;
}
function mergeStates(base, local, remote){
  const out = { ...remote };
  ['users','classrooms','stages','sectors','attendance','assignments','news','chats','pointsLog','auditLog'].forEach(k=>{
    if(local[k] || remote[k]) out[k] = mergeById(base && base[k], local[k], remote[k], k==='chats' ? mergeChat : null);
  });
  ['settings','emergency'].forEach(k=>{ out[k] = (base && sameJSON(local[k], base[k])) ? remote[k] : local[k]; });
  out.auditLog = (out.auditLog||[]).sort((a,b)=> new Date(b.time)-new Date(a.time)).slice(0,80);
  out.pointsLog = (out.pointsLog||[]).sort((a,b)=> new Date(b.time)-new Date(a.time)).slice(0,150);
  out.session = local.session;
  return out;
}
async function flushPush(){
  if(!churchCode || directorSession || isDemo()) return;
  if(syncing){ pushQueued = true; return; }
  syncing = true;
  let replaced = false;
  try{
    do{
      pushQueued = false;
      const url = `${SUPABASE_URL}/rest/v1/app_state?code=eq.${encodeURIComponent(churchCode)}`;
      const get = await fetch(url+'&select=data,updated_at', { headers: SUPA_HEADERS });
      if(!get.ok) throw new Error('read '+get.status);
      const rows = await get.json();
      const remote = rows && rows[0] && rows[0].data;
      let toPush = state;
      if(remote && Array.isArray(remote.users) && remote.users.length) toPush = mergeStates(baseState, state, remote);
      const nowIso = new Date().toISOString();
      const res = await fetch(url, { method:'PATCH', headers:{...SUPA_HEADERS,'Prefer':'return=minimal'},
        body: JSON.stringify({ data: { ...toPush, session:{userId:null} }, updated_at: nowIso }) });
      if(!res.ok) throw new Error('write '+res.status);
      lastSyncedAt = nowIso;
      baseState = clone(toPush);
      if(toPush !== state && !pushQueued && !sameJSON({...toPush,session:0}, {...state,session:0})){
        const keep = state.session; state = toPush; state.session = keep; saveState(state); replaced = true;
      }
      if(!pushQueued) dirty = false;
    } while(pushQueued);
  }catch(e){ console.warn('Supabase push failed (will retry):', e); }
  finally{ syncing = false; }
  if(replaced) render();
}
// Poll for changes made by other people/devices, and merge them in.
async function pollRemoteState(){
  if(!churchCode || directorSession || isDemo()) return;
  fetchGlobalNews(); // fire-and-forget; refreshes globalNewsCache for the next render
  if(dirty || syncing){ flushPush(); return; }
  const row = await fetchRemoteState(churchCode);
  if(dirty || syncing) return;   // something changed locally while we were fetching
  if(!row || !row.data || !Array.isArray(row.data.users) || !row.data.users.length) return;
  if(!lastSyncedAt || Date.parse(row.updated_at) !== Date.parse(lastSyncedAt)){
    adoptRemote(row.data, row.updated_at);
    render();
  }
}
// Run once at startup: if this church's row already has data, adopt it (so every
// device converges on the same data instead of each keeping its own demo copy).
async function initialSync(){
  if(!churchCode || isDemo()) return;
  fetchGlobalNews();
  const row = await fetchRemoteState(churchCode);
  if(row && row.data && Array.isArray(row.data.users) && row.data.users.length){
    adoptRemote(row.data, row.updated_at);
    render();
  } else {
    const res = await createRemoteChurch(churchCode, { ...state, session:{userId:null} });
    lastSyncedAt = res.updatedAt; baseState = clone(state);
  }
}

function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,9); }
function nowISO(){ return new Date().toISOString(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }

function seedState(){
  const sec1 = uid('sec'), sec2 = uid('sec');
  const st1 = uid('stg'), st2 = uid('stg');
  const c1 = uid('cls'), c2 = uid('cls'), c3 = uid('cls');
  const uAdmin = uid('u'), uSuper = uid('u'), uKh1 = uid('u'), uKh2 = uid('u'),
        uMem1 = uid('u'), uMem2 = uid('u'), uMem3 = uid('u'), uPending = uid('u');
  const a1 = uid('asg');
  return {
    session: { userId: null },
    users: [
      { id:uAdmin, name:'مينا جرجس', email:'admin@demo.com', mobile:'01000000001', address:'شارع الكنيسة، القاهرة',
        password:'admin123', role:'senior_admin', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
      { id:uSuper, name:'فادي رمزي', email:'super@demo.com', mobile:'01000000008', address:'المهندسين',
        password:'super123', role:'super_admin', status:'approved', classroomId:null, stageId:null, sectorId:sec1, points:0, createdAt: nowISO() },
      { id:uKh1, name:'مريم صموئيل', email:'khadim@demo.com', mobile:'01000000002', address:'شارع النصر، الجيزة',
        password:'123456', role:'khadim', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
      { id:uKh2, name:'أندرو فوزي', email:'khadim2@demo.com', mobile:'01000000003', address:'مدينة نصر',
        password:'123456', role:'khadim', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
      { id:uMem1, name:'بيشوي عادل', email:'member@demo.com', mobile:'01000000004', address:'المعادي',
        password:'123456', role:'makhdoum', status:'approved', classroomId:c1, stageId:st1, points:15, createdAt: nowISO() },
      { id:uMem2, name:'مارينا سامح', email:'member2@demo.com', mobile:'01000000005', address:'حلوان',
        password:'123456', role:'makhdoum', status:'approved', classroomId:c1, stageId:st1, points:5, createdAt: nowISO() },
      { id:uMem3, name:'كيرلس ناجي', email:'member3@demo.com', mobile:'01000000006', address:'شبرا',
        password:'123456', role:'makhdoum', status:'approved', classroomId:c1, stageId:st1, points:0, createdAt: nowISO() },
      { id:uPending, name:'جرجس فايز', email:'pending@demo.com', mobile:'01000000007', address:'عين شمس',
        password:'123456', role:'makhdoum', status:'pending', classroomId:null, stageId:st1, points:0, createdAt: nowISO() },
    ],
    sectors: [
      { id:sec1, name:'قطاع الأطفال' },
      { id:sec2, name:'قطاع الشباب' },
    ],
    stages: [
      { id:st1, name:'ابتدائي', sectorId:sec1 },
      { id:st2, name:'إعدادي وثانوي', sectorId:sec2 },
    ],
    classrooms: [
      { id:c1, name:'فصل يوسف الرسول', stageId:st1, servantIds:[uKh1, uKh2] },
      { id:c2, name:'فصل مارمرقس', stageId:st1, servantIds:[uKh2] },
      { id:c3, name:'فصل الأنبا أنطونيوس', stageId:st2, servantIds:[] },
    ],
    attendance: [
      { id:uid('att'), memberId:uMem1, classroomId:c1, date: todayStr(), quddas:true, ijtimaa:false, markedBy:uKh1 },
    ],
    assignments: [
      { id:a1, title:'حفظ مزمور ١٥٠', description:'حفظ المزمور كاملًا وتسميعه للخادم.', points:10, classroomId:c1, createdBy:uKh1, createdAt: nowISO(), completions:{} },
    ],
    news: [
      { id:uid('news'), title:'اجتماع الخدام الشهري', content:'يُرجى حضور جميع الخدام اجتماع الخدمة يوم الجمعة القادم بعد صلاة العشية مباشرة.', authorName:'مينا جرجس', authorId:uAdmin, createdAt: nowISO() },
    ],
    chats: [
      { id:uid('chat'), memberId:uMem2, memberName:'مارينا سامح', status:'unclaimed', claimedById:null, claimedByName:null,
        messages:[ {sender:'member', senderName:'مارينا سامح', text:'سلام أبونا، عايزة أستأذن غياب الأحد الجاي بسبب سفر.', time: nowISO()} ],
        createdAt: nowISO() },
    ],
    settings: { pointsQuddas:5, pointsIjtimaa:5 },
    pointsLog: [],
    emergency: { active:false, byUserId:null, originalRole:null, grantedAt:null, log:[] },
    auditLog: [
      { id:uid('log'), time: nowISO(), actor:'النظام', action:'تم إنشاء التطبيق وتحميل البيانات التجريبية.' },
    ],
  };
}

function freshChurchState(adminName, adminEmail, adminPass){
  const uAdmin = uid('u');
  return {
    session: { userId: null },
    users: [
      { id:uAdmin, name:adminName, email:adminEmail.toLowerCase(), mobile:'', address:'',
        password:adminPass, role:'senior_admin', status:'approved', classroomId:null, stageId:null, sectorId:null, points:0, createdAt: nowISO() },
    ],
    sectors: [],
    stages: [],
    classrooms: [],
    attendance: [],
    assignments: [],
    news: [],
    chats: [],
    settings: { pointsQuddas:5, pointsIjtimaa:5 },
    pointsLog: [],
    emergency: { active:false, byUserId:null, originalRole:null, grantedAt:null, log:[] },
    auditLog: [ { id:uid('log'), time: nowISO(), actor:'النظام', action:'تم إنشاء الكنيسة.' } ],
  };
}

function loadState(code){
  try{
    const raw = localStorage.getItem(STORAGE_PREFIX+code);
    if(raw){
      const s = JSON.parse(raw);
      if(!s.assignments) s.assignments = [];
      if(!s.settings) s.settings = { pointsQuddas:5, pointsIjtimaa:5 };
      if(!s.pointsLog) s.pointsLog = [];
      if(!s.stages) s.stages = [];
      if(!s.sectors) s.sectors = [];
      s.classrooms.forEach(c=>{ if(!c.servantIds) c.servantIds = c.servantId ? [c.servantId] : []; if(c.stageId===undefined) c.stageId = null; });
      s.stages.forEach(st=>{ if(st.sectorId===undefined) st.sectorId = null; });
      s.users.forEach(u=>{ if(typeof u.points !== 'number') u.points = 0; if(u.stageId===undefined) u.stageId = null; if(u.sectorId===undefined) u.sectorId = null; });
      return s;
    }
  }catch(e){ /* fall through */ }
  return null;
}
function saveState(s){
  if(!churchCode || !s) return;
  try{ localStorage.setItem(STORAGE_PREFIX+churchCode, JSON.stringify(s)); }catch(e){ console.warn('storage failed', e); }
}

let churchCode = localStorage.getItem(CHURCH_CODE_KEY) || null;
let directorSession = false;
let directorChurches = [];
let directorGlobalNews = [];
let globalNewsCache = []; // read-only copy any church's app polls, for displaying Director broadcasts
async function fetchGlobalNews(){
  const row = await fetchRemoteState(DIRECTOR_CODE);
  globalNewsCache = (row && row.data && Array.isArray(row.data.globalNews)) ? row.data.globalNews : [];
}

// One-time migration: a device that used this app before church codes existed
// keeps its real data by moving it under a fixed code, 'MAIN', instead of losing it.
(function migrateLegacyStorage(){
  if(churchCode) return;
  const legacy = localStorage.getItem('khidma_church_app_v2');
  if(legacy){
    localStorage.setItem(STORAGE_PREFIX+'MAIN', legacy);
    localStorage.setItem(CHURCH_CODE_KEY, 'MAIN');
    churchCode = 'MAIN';
  }
})();

const emptyShellState = ()=>({ session:{userId:null}, users:[], sectors:[], stages:[], classrooms:[], attendance:[], assignments:[], news:[], chats:[], settings:{pointsQuddas:5,pointsIjtimaa:5}, pointsLog:[], emergency:{active:false,byUserId:null,originalRole:null,grantedAt:null,log:[]}, auditLog:[] });
let state = churchCode ? (loadState(churchCode) || emptyShellState()) : emptyShellState();
let ui = { authTab:'login', activeTab:'news', openChatId:null,
           adminAttClassroom:null, ministrySub:'attendance', adminSub:'pending', toast:null, scanning:false, confirm:null,
           gateCode:'', gateError:'', gateBusy:false, showDirectorLogin:false, directorError:'',
           dirNewName:'', dirNewAdminName:'', dirNewAdminEmail:'', dirNewAdminPass:'', resetPwFor:null };

function persist(){ saveState(state); if(churchCode && !directorSession && !isDemo()){ dirty = true; flushPush(); } }
function log(actor, action){
  state.auditLog.unshift({ id:uid('log'), time: nowISO(), actor, action });
  state.auditLog = state.auditLog.slice(0,80);
}
function showToast(msg){
  ui.toast = msg;
  render();
  setTimeout(()=>{ ui.toast=null; render(); }, 2200);
}
function askConfirm(message, onYes){
  ui.confirm = { message, onYes };
  render();
}
function awardPoints(member, delta, reason, byName){
  member.points = Math.max(0, (member.points||0) + delta);
  state.pointsLog.unshift({ id:uid('pl'), time: nowISO(), memberId:member.id, memberName:member.name, delta, reason, by:byName });
  state.pointsLog = state.pointsLog.slice(0,150);
}

/* ---------- emergency access ---------- */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function currentHourBucket(){ return Math.floor(Date.now() / 3600000); }
function getEmergencyCredential(){
  const bucket = currentHourBucket();
  const rand = mulberry32(bucket * 2654435761 % 2147483647);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = ''; for(let i=0;i<6;i++) code += chars[Math.floor(rand()*chars.length)];
  let pass = ''; for(let i=0;i<6;i++) pass += Math.floor(rand()*10);
  const nextRefresh = (bucket+1) * 3600000;
  return { code, pass, nextRefresh };
}
function checkEmergencyExpiry(){
  if(state.emergency.active){
    const grantedAt = new Date(state.emergency.grantedAt).getTime();
    if(Date.now() - grantedAt > 24*3600*1000) revertEmergency('انتهت صلاحية الوصول الطارئ تلقائيًا بعد ٢٤ ساعة.');
  }
}
function revertEmergency(reason){
  const u = state.users.find(x=>x.id===state.emergency.byUserId);
  if(u && state.emergency.originalRole){ u.role = state.emergency.originalRole; }
  log('النظام', reason || 'تم إنهاء وضع الوصول الطارئ.');
  state.emergency = { active:false, byUserId:null, originalRole:null, grantedAt:null, log: state.emergency.log };
  persist();
}

/* ---------- helpers ---------- */
function currentUser(){ return state.users.find(u=>u.id===state.session.userId) || null; }
function classroomOf(id){ return state.classrooms.find(c=>c.id===id); }
function stageOf(id){ return state.stages.find(s=>s.id===id); }
function classroomsInStage(sid){ return state.classrooms.filter(c=>c.stageId===sid); }
function sectorOf(id){ return state.sectors.find(s=>s.id===id); }
function stagesInSector(sectorId){ return state.stages.filter(s=>s.sectorId===sectorId); }
function classroomsInSectorStages(sectorId){ const ids = stagesInSector(sectorId).map(s=>s.id); return state.classrooms.filter(c=>ids.includes(c.stageId)); }
function membersOfClassroom(cid){ return state.users.filter(u=>u.role==='makhdoum' && u.status==='approved' && u.classroomId===cid); }
function isAdminish(u){ return u && (u.role==='khadim' || u.role==='senior_admin' || u.role==='super_admin'); }
function myClassrooms(u){
  if(u.role==='senior_admin') return state.classrooms;
  if(u.role==='super_admin') return classroomsInSectorStages(u.sectorId);
  return state.classrooms.filter(c=>c.servantIds.includes(u.id));
}
function initials(name){ return (name||'?').trim().split(' ')[0].slice(0,1); }
function fmtTime(iso){ const d=new Date(iso); return d.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'}); }
function fmtDate(iso){ const d=new Date(iso); return d.toLocaleDateString('ar-EG',{day:'numeric',month:'short'}); }
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/* ---------- Self-contained QR code encoder (Model 2, byte mode, EC level L) ----------
   No external library — built directly from the ISO/IEC 18004 spec and round-trip
   verified offline before use, so it doesn't depend on any CDN loading correctly. */
const QR_GF_EXP = new Array(512), QR_GF_LOG = new Array(256);
(function initQRGF(){
  let x = 1;
  for(let i=0;i<255;i++){ QR_GF_EXP[i]=x; QR_GF_LOG[x]=i; x<<=1; if(x&0x100) x^=0x11D; }
  for(let i=255;i<512;i++) QR_GF_EXP[i]=QR_GF_EXP[i-255];
})();
function qrGfMul(a,b){ if(a===0||b===0) return 0; return QR_GF_EXP[QR_GF_LOG[a]+QR_GF_LOG[b]]; }
function qrRsGenPoly(degree){
  let poly=[1];
  for(let i=0;i<degree;i++){
    const root = QR_GF_EXP[i];
    const res = new Array(poly.length+1).fill(0);
    for(let j=0;j<poly.length;j++){ res[j]^=poly[j]; res[j+1]^=qrGfMul(poly[j],root); }
    poly = res;
  }
  return poly;
}
function qrRsEncode(dataCw, ecCount){
  const gen = qrRsGenPoly(ecCount);
  const res = dataCw.concat(new Array(ecCount).fill(0));
  for(let i=0;i<dataCw.length;i++){
    const coef = res[i];
    if(coef!==0){ for(let j=0;j<gen.length;j++){ res[i+j]^=qrGfMul(gen[j],coef); } }
  }
  return res.slice(dataCw.length);
}
const QR_VERSION_INFO = {
  1:{size:21,dataCodewords:19,ecCodewords:7}, 2:{size:25,dataCodewords:34,ecCodewords:10},
  3:{size:29,dataCodewords:55,ecCodewords:15}, 4:{size:33,dataCodewords:80,ecCodewords:20},
};
function qrChooseVersion(byteLen){
  for(const v of [1,2,3,4]){
    const info = QR_VERSION_INFO[v];
    const countBits = v<=9?8:16;
    if(4+countBits+byteLen*8 <= info.dataCodewords*8) return v;
  }
  return 4; // will overflow/truncate for extremely long text, not expected here
}
function qrBuildDataBits(bytes, version){
  const countBits = version<=9?8:16;
  let bits = '0100' + bytes.length.toString(2).padStart(countBits,'0');
  for(const b of bytes) bits += b.toString(2).padStart(8,'0');
  const capacityBits = QR_VERSION_INFO[version].dataCodewords*8;
  bits += '0'.repeat(Math.max(0, Math.min(4, capacityBits-bits.length)));
  while(bits.length % 8 !== 0) bits += '0';
  const padBytes=[0xEC,0x11]; let pi=0;
  while(bits.length < capacityBits){ bits += padBytes[pi%2].toString(2).padStart(8,'0'); pi++; }
  const cws=[]; for(let i=0;i<bits.length;i+=8) cws.push(parseInt(bits.slice(i,i+8),2));
  return cws;
}
function qrIsFunctionModule(size, r, c, version){
  if(r<=7 && c<=7) return true;
  if(r<=7 && c>=size-8) return true;
  if(r>=size-8 && c<=7) return true;
  if(r===6 || c===6) return true;
  if(r===size-8 && c===8) return true;
  if((r===8 && (c<9 || c>=size-8)) || (c===8 && (r<9 || r>=size-7))) return true;
  if(version>=2){ const pos=size-7; if(Math.abs(r-pos)<=2 && Math.abs(c-pos)<=2) return true; }
  return false;
}
function qrPlaceFinder(matrix, r0, c0){
  for(let r=-1;r<=7;r++) for(let c=-1;c<=7;c++){
    const rr=r0+r, cc=c0+c;
    if(rr<0||cc<0||rr>=matrix.length||cc>=matrix.length) continue;
    let dark=false;
    if(r>=0&&r<=6&&c>=0&&c<=6){ if(r===0||r===6||c===0||c===6) dark=true; else if(r>=2&&r<=4&&c>=2&&c<=4) dark=true; }
    matrix[rr][cc]=dark?1:0;
  }
}
function qrPlaceAlignment(matrix, r0, c0){
  for(let r=-2;r<=2;r++) for(let c=-2;c<=2;c++){
    matrix[r0+r][c0+c] = (Math.max(Math.abs(r),Math.abs(c))!==1)?1:0;
  }
}
function qrBuildMatrix(version, dataCodewords, ecCodewords){
  const size = QR_VERSION_INFO[version].size;
  const matrix = Array.from({length:size},()=>new Array(size).fill(null));
  qrPlaceFinder(matrix,0,0); qrPlaceFinder(matrix,0,size-7); qrPlaceFinder(matrix,size-7,0);
  for(let i=8;i<size-8;i++){ matrix[6][i]=(i%2===0)?1:0; matrix[i][6]=(i%2===0)?1:0; }
  matrix[size-8][8]=1;
  if(version>=2) qrPlaceAlignment(matrix, size-7, size-7);
  for(let i=0;i<9;i++){ if(matrix[8][i]===null) matrix[8][i]=0; if(matrix[i][8]===null) matrix[i][8]=0; }
  for(let i=0;i<8;i++){ if(matrix[8][size-1-i]===null) matrix[8][size-1-i]=0; if(matrix[size-1-i][8]===null) matrix[size-1-i][8]=0; }

  const bitStream=[];
  for(const cw of dataCodewords.concat(ecCodewords)){ for(let b=7;b>=0;b--) bitStream.push((cw>>b)&1); }
  let bitIndex=0, col=size-1, dir=-1;
  while(col>0){
    if(col===6) col--;
    for(let i=0;i<size;i++){
      const row = dir===-1 ? size-1-i : i;
      for(const c of [col,col-1]){
        if(qrIsFunctionModule(size,row,c,version)) continue;
        if(matrix[row][c]!==null) continue;
        const bit = bitIndex<bitStream.length ? bitStream[bitIndex] : 0; bitIndex++;
        matrix[row][c] = ((row+c)%2===0) ? (bit^1) : bit;
      }
    }
    dir*=-1; col-=2;
  }
  // format info: EC level L + mask pattern 0
  const fmtVal = parseInt('01000',2); // 2 bits EC-level field + 3 bits mask
  let g2 = fmtVal<<10;
  const genPoly = 0b10100110111;
  for(let i=14;i>=10;i--){ if((g2>>i)&1) g2 ^= genPoly<<(i-10); }
  let fmtBits15 = ((fmtVal<<10)|g2) ^ 0b101010000010010;
  fmtBits15 &= 0x7FFF;
  const fmtArr=[]; for(let i=14;i>=0;i--) fmtArr.push((fmtBits15>>i)&1);
  const posA=[[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  for(let i=0;i<15;i++){ matrix[posA[i][0]][posA[i][1]] = fmtArr[i]; }
  for(let i=0;i<8;i++){ matrix[8][size-1-i] = fmtArr[i]; }
  for(let i=8;i<15;i++){ matrix[size-15+i][8] = fmtArr[i]; }
  return matrix;
}
function generateQRSvg(text){
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = qrChooseVersion(bytes.length);
  const info = QR_VERSION_INFO[version];
  const dataCodewords = qrBuildDataBits(bytes, version);
  const ecCodewords = qrRsEncode(dataCodewords, info.ecCodewords);
  const matrix = qrBuildMatrix(version, dataCodewords, ecCodewords);
  const cell=6, margin=14, dim = info.size*cell + margin*2;
  let rects='';
  for(let r=0;r<info.size;r++) for(let c=0;c<info.size;c++) if(matrix[r][c]) rects += `<rect x="${c*cell+margin}" y="${r*cell+margin}" width="${cell}" height="${cell}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#4A1220">${rects}</g></svg>`;
}


/* =========================================================================
   RENDER
   ========================================================================= */
function render(){
  checkEmergencyExpiry();
  const root = document.getElementById('root');
  const chatEl = document.getElementById('chatInput');
  const typed = chatEl ? chatEl.value : null, hadFocus = chatEl && document.activeElement === chatEl;

  if(directorSession){ root.innerHTML = renderDirector(); bindDirectorEvents(); return; }
  if(!churchCode){ root.innerHTML = renderChurchGate(); bindChurchGateEvents(); return; }

  const u = currentUser();
  if(!u){ root.innerHTML = renderAuth(); bindAuthEvents(); return; }
  if(u.status === 'banned'){ root.innerHTML = renderBanned(u); bindPendingEvents(); return; }
  if(u.status === 'pending'){ root.innerHTML = renderPending(u); bindPendingEvents(); return; }
  if(u.status === 'rejected'){ root.innerHTML = renderRejected(u); bindPendingEvents(); return; }

  root.innerHTML = renderApp(u);
  bindAppEvents(u);
  if(typed){ const el = document.getElementById('chatInput'); if(el){ el.value = typed; if(hadFocus) el.focus(); } }
  if(ui.scanning) startScanner();
}

/* ---------------- CHURCH GATE (entry code) & DIRECTOR ---------------- */
function renderChurchGate(){
  return `
  <div class="auth-wrap">
    <div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title">خِدمة</h1>
    <p class="auth-sub">تطبيق مجتمع الكنيسة — خدام ومخدومين</p>
    ${!ui.showDirectorLogin ? `
      <div class="mb-3"><label class="form-label">كود الكنيسة</label><input class="form-control" type="text" id="gateCodeInput" placeholder="أدخل كود كنيستك" value="${escapeHtml(ui.gateCode||'')}" style="text-transform:uppercase;"></div>
      ${ui.gateError ? `<div class="muted" style="color:var(--bad);margin-bottom:10px;">${escapeHtml(ui.gateError)}</div>` : ''}
      <button class="btn btn-primary" id="gateSubmitBtn" ${ui.gateBusy?'disabled':''}>${ui.gateBusy?'جاري التحقق...':'دخول'}</button>
      <div class="text-center" style="margin-top:16px;"><button class="btn-ghost" id="toDirectorLogin" type="button">دخول كمدير</button></div>
    ` : `
      <h3 style="font-size:14px;color:var(--text-soft);margin-bottom:12px;">دخول المدير</h3>
      <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="dirEmail" placeholder="example@email.com"></div>
      <div class="mb-3"><label class="form-label">كلمة المرور</label><input class="form-control" type="password" id="dirPass" placeholder="••••••••"></div>
      ${ui.directorError ? `<div class="muted" style="color:var(--bad);margin-bottom:10px;">${escapeHtml(ui.directorError)}</div>` : ''}
      <button class="btn btn-primary" id="dirSubmitBtn">دخول</button>
      <div class="text-center" style="margin-top:16px;"><button class="btn-ghost" id="toChurchGate" type="button">رجوع لتسجيل الدخول بكود الكنيسة</button></div>
    `}
    <div class="text-center" style="margin-top:10px;"><button class="btn btn-outline btn-sm install-app-btn" onclick="triggerInstall()">📲 تثبيت التطبيق على الشاشة الرئيسية</button></div>
    <div class="text-center muted" style="margin-top:14px;font-size:11px;">الإصدار ${APP_VERSION}</div>
  </div>`;
}
function bindChurchGateEvents(){
  const toDir = document.getElementById('toDirectorLogin'); if(toDir) toDir.onclick = ()=>{ ui.showDirectorLogin=true; ui.directorError=''; render(); };
  const toGate = document.getElementById('toChurchGate'); if(toGate) toGate.onclick = ()=>{ ui.showDirectorLogin=false; ui.gateError=''; render(); };
  const gateBtn = document.getElementById('gateSubmitBtn');
  if(gateBtn) gateBtn.onclick = async ()=>{
    const input = document.getElementById('gateCodeInput');
    const code = input.value.trim().toUpperCase();
    ui.gateCode = code;
    if(!code){ ui.gateError='أدخل كود الكنيسة.'; render(); return; }
    if(code==='DEMO'){
      churchCode = 'DEMO';
      localStorage.setItem(CHURCH_CODE_KEY, 'DEMO');
      state = loadState('DEMO') || seedState();
      saveState(state);
      render();
      return;
    }
    ui.gateBusy = true; ui.gateError=''; render();
    const row = await fetchRemoteState(code);
    ui.gateBusy = false;
    if(!row || !row.data || !Array.isArray(row.data.users) || !row.data.users.length){
      ui.gateError = 'كود الكنيسة غير صحيح.'; render(); return;
    }
    churchCode = code;
    localStorage.setItem(CHURCH_CODE_KEY, code);
    state = emptyShellState();
    adoptRemote(row.data, row.updated_at);
    render();
  };
  const dirBtn = document.getElementById('dirSubmitBtn');
  if(dirBtn) dirBtn.onclick = async ()=>{
    const email = document.getElementById('dirEmail').value.trim().toLowerCase();
    const pass = document.getElementById('dirPass').value;
    if(email!==DIRECTOR_EMAIL.toLowerCase() || pass!==DIRECTOR_PASSWORD){ ui.directorError='بيانات الدخول غير صحيحة.'; render(); return; }
    directorSession = true; ui.directorError='';
    const row = await fetchRemoteState(DIRECTOR_CODE);
    directorChurches = (row && row.data && Array.isArray(row.data.churches)) ? row.data.churches : [];
    directorGlobalNews = (row && row.data && Array.isArray(row.data.globalNews)) ? row.data.globalNews : [];
    render();
  };
}
function genChurchCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code; let tries=0;
  do{ code=''; for(let i=0;i<6;i++) code+=chars[Math.floor(Math.random()*chars.length)]; tries++; }
  while(directorChurches.some(c=>c.code===code) && tries<50);
  return code;
}
function renderDirector(){
  return `
  <div class="screen">
    <div class="topbar"><div class="titles"><h1>لوحة المدير</h1><div class="sub">إدارة الكنائس</div></div>
      <button class="logoutbtn" id="dirLogoutBtn">خروج</button></div>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:14px 0 8px;">📢 رسالة عامة لكل الكنائس</h3>
    <div class="card p-3 mb-3" style="border:2px solid var(--gold, #C79A3D);">
      <div class="mb-3"><label class="form-label">العنوان</label><input class="form-control" type="text" id="dirNewsTitle" placeholder="عنوان الرسالة"></div>
      <div class="mb-3"><label class="form-label">النص</label><textarea class="form-control" id="dirNewsBody" placeholder="نص الرسالة..."></textarea></div>
      <div id="dirNewsError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
      <button class="btn btn-gold" id="dirSendNewsBtn">إرسال للجميع</button>
    </div>
    ${directorGlobalNews.length ? directorGlobalNews.slice().reverse().map(n=>`
      <div class="card px-3 py-2 mb-3">
        <div class="d-flex justify-content-between align-items-start gap-2"><b>📢 ${escapeHtml(n.title)}</b><button class="btn-ghost" data-del-globalnews="${n.id}" style="color:var(--bad);">حذف</button></div>
        <p class="muted" style="margin-top:4px;">${escapeHtml(n.content)}</p>
        <div class="muted">${fmtDate(n.createdAt)}</div>
      </div>`).join('') : ''}
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">إنشاء كنيسة جديدة</h3>
    <div class="card p-3 mb-3">
      <div class="mb-3"><label class="form-label">اسم الكنيسة</label><input class="form-control" type="text" id="dirNewChurchName" placeholder="مثال: كنيسة الأنبا أنطونيوس"></div>
      <div class="mb-3"><label class="form-label">اسم مدير الكنيسة المؤسس</label><input class="form-control" type="text" id="dirNewAdminName"></div>
      <div class="mb-3"><label class="form-label">بريده الإلكتروني</label><input class="form-control" type="email" id="dirNewAdminEmail"></div>
      <div class="mb-3"><label class="form-label">كلمة مروره</label><input class="form-control" type="password" id="dirNewAdminPass" minlength="4"></div>
      <div id="dirCreateError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
      <button class="btn btn-gold" id="dirCreateBtn">إنشاء الكنيسة</button>
    </div>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الكنائس الحالية (${directorChurches.length})</h3>
    ${directorChurches.length===0 ? `<p class="muted">لا توجد كنائس بعد.</p>` : directorChurches.slice().reverse().map(c=>`
      <div class="card px-3 py-2 mb-3">
        <div class="d-flex justify-content-between align-items-center"><b>${escapeHtml(c.name)}</b><span class="badge rounded-pill badge-gold" style="letter-spacing:2px;">${escapeHtml(c.code)}</span></div>
        <div class="muted" style="margin-top:4px;">أُنشئت: ${new Date(c.createdAt).toLocaleDateString('ar-EG')}</div>
        ${c.synced===false ? `<div class="muted" style="color:var(--bad);margin-top:6px;">⚠ لم يتم حفظها على الإنترنت بعد.</div><button class="btn-ghost" data-retry-sync="${c.code}">إعادة محاولة الحفظ</button>` : ''}
        <div class="d-flex justify-content-end"><button class="btn-ghost" data-del-church="${c.code}" style="color:var(--bad);">🗑 حذف الكنيسة</button></div>
      </div>`).join('')}
  ${ui.confirm ? `<div class="confirm-overlay"><div class="confirm-box"><p>${escapeHtml(ui.confirm.message)}</p><div class="d-flex gap-2 equal-cols"><button class="btn btn-outline btn-sm" id="confirmNo" style="flex:1;">إلغاء</button><button class="btn btn-danger btn-sm" id="confirmYes" style="flex:1;">تأكيد الحذف</button></div></div></div>` : ''}
  </div>`;
}
async function deleteRemoteChurch(code){
  try{
    const res = await fetch(`${SUPABASE_URL}/rest/v1/app_state?code=eq.${encodeURIComponent(code)}`, { method:'DELETE', headers: SUPA_HEADERS });
    if(res.ok) return { ok:true };
    let detail=''; try{ const j=await res.json(); detail=j.message||j.hint||''; }catch(e){}
    lastSaveError = `خطأ من قاعدة البيانات (${res.status})${detail?': '+detail:''}`;
    return { ok:false };
  }catch(e){
    lastSaveError = 'لا يوجد اتصال بالإنترنت (أو الاتصال محجوب).';
    return { ok:false };
  }
}
async function saveDirectorData(){
  return await createRemoteChurch(DIRECTOR_CODE, { churches: directorChurches.map(({pendingState, ...c})=>c), globalNews: directorGlobalNews });
}
function bindDirectorEvents(){
  const confirmYes = document.getElementById('confirmYes');
  if(confirmYes) confirmYes.onclick = ()=>{ const action = ui.confirm && ui.confirm.onYes; ui.confirm = null; if(action) action(); else render(); };
  const confirmNo = document.getElementById('confirmNo');
  if(confirmNo) confirmNo.onclick = ()=>{ ui.confirm = null; render(); };
  document.querySelectorAll('[data-del-church]').forEach(b=>{
    b.onclick = ()=>{
      const code = b.dataset.delChurch;
      const entry = directorChurches.find(c=>c.code===code);
      askConfirm(`حذف كنيسة "${entry.name}" (${code}) نهائيًا؟ سيتم مسح كل أعضائها وبياناتها ولا يمكن التراجع.`, async ()=>{
        const r = await deleteRemoteChurch(code);
        if(!r.ok){ showToast('لم يتم الحذف. '+lastSaveError); render(); return; }
        directorChurches = directorChurches.filter(c=>c.code!==code);
        const s = await saveDirectorData();
        showToast(s.ok ? 'تم حذف الكنيسة.' : 'حُذفت بياناتها لكن تعذّر تحديث القائمة. '+lastSaveError);
        render();
      });
    };
  });
  const logout = document.getElementById('dirLogoutBtn'); if(logout) logout.onclick = ()=>{ directorSession=false; ui.showDirectorLogin=false; render(); };
  const sendNewsBtn = document.getElementById('dirSendNewsBtn');
  if(sendNewsBtn) sendNewsBtn.onclick = async ()=>{
    const title = document.getElementById('dirNewsTitle').value.trim();
    const body = document.getElementById('dirNewsBody').value.trim();
    const err = document.getElementById('dirNewsError');
    if(!title || !body){ err.textContent='أدخل العنوان والنص.'; err.style.display='block'; return; }
    err.style.display='none';
    sendNewsBtn.disabled = true; sendNewsBtn.textContent = 'جاري الإرسال...';
    directorGlobalNews.push({ id: uid('gnews'), title, content: body, createdAt: nowISO() });
    const res = await saveDirectorData();
    showToast(res.ok ? 'تم إرسال الرسالة لكل الكنائس.' : 'لم تُحفظ الرسالة. '+lastSaveError);
    render();
  };
  document.querySelectorAll('[data-del-globalnews]').forEach(b=>{
    b.onclick = async ()=>{
      directorGlobalNews = directorGlobalNews.filter(n=>n.id!==b.dataset.delGlobalnews);
      await saveDirectorData();
      render();
    };
  });
  const createBtn = document.getElementById('dirCreateBtn');
  if(createBtn) createBtn.onclick = async ()=>{
    const name = document.getElementById('dirNewChurchName').value.trim();
    const adminName = document.getElementById('dirNewAdminName').value.trim();
    const adminEmail = document.getElementById('dirNewAdminEmail').value.trim();
    const adminPass = document.getElementById('dirNewAdminPass').value;
    const err = document.getElementById('dirCreateError');
    if(!name || !adminName || !adminEmail || !adminPass){ err.textContent='من فضلك أكمل كل الحقول.'; err.style.display='block'; return; }
    err.style.display='none';
    createBtn.disabled = true; createBtn.textContent = 'جاري الحفظ على الإنترنت...';
    const code = genChurchCode();
    const newState = freshChurchState(adminName, adminEmail, adminPass);
    const churchRes = await createRemoteChurch(code, newState);
    const entry = { code, name, createdAt: nowISO(), synced: churchRes.ok };
    if(!churchRes.ok) entry.pendingState = newState;
    directorChurches.push(entry);
    const listRes = await saveDirectorData();
    if(churchRes.ok && listRes.ok){
      showToast(`تم إنشاء الكنيسة وحفظها على الإنترنت. الكود: ${code}`);
    } else {
      showToast(`تم إنشاء الكود ${code}، لكن لم يُحفظ. ${lastSaveError}`);
    }
    render();
  };
  document.querySelectorAll('[data-retry-sync]').forEach(b=>{
    b.onclick = async ()=>{
      const code = b.dataset.retrySync;
      const entry = directorChurches.find(c=>c.code===code);
      b.textContent = 'جاري إعادة المحاولة...'; b.disabled = true;
      let churchOk = true;
      if(entry.pendingState){
        const r = await createRemoteChurch(code, entry.pendingState);
        churchOk = r.ok;
        if(r.ok) delete entry.pendingState;
      }
      const listRes = churchOk ? await saveDirectorData() : { ok:false };
      if(churchOk && listRes.ok){ entry.synced = true; showToast('تم الحفظ بنجاح.'); }
      else { showToast('لم يُحفظ بعد. '+lastSaveError); }
      render();
    };
  });
}

/* ---------------- AUTH ---------------- */
function crestSVG(size){
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="32" r="30" fill="none" stroke="#C79A3D" stroke-width="2"/>
    <g fill="#C79A3D">
      <path d="M28 10 H36 V26 H52 V34 H36 V54 H28 V34 H12 V26 H28 Z"/>
      <circle cx="32" cy="6" r="4"/><circle cx="26.5" cy="11" r="3.2"/><circle cx="37.5" cy="11" r="3.2"/>
      <circle cx="32" cy="58" r="4"/><circle cx="26.5" cy="53" r="3.2"/><circle cx="37.5" cy="53" r="3.2"/>
      <circle cx="6" cy="32" r="4"/><circle cx="11" cy="26.5" r="3.2"/><circle cx="11" cy="37.5" r="3.2"/>
      <circle cx="58" cy="32" r="4"/><circle cx="53" cy="26.5" r="3.2"/><circle cx="53" cy="37.5" r="3.2"/>
    </g>
  </svg>`;
}

function renderAuth(){
  const tab = ui.authTab;
  return `
  <div class="auth-wrap">
    <div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title">خِدمة</h1>
    <p class="auth-sub">تطبيق مجتمع الكنيسة — خدام ومخدومين</p>
    <div class="authtabs">
      <button data-authtab="login" class="${tab==='login'?'active':''}">تسجيل الدخول</button>
      <button data-authtab="signup" class="${tab==='signup'?'active':''}">حساب جديد</button>
    </div>
    ${tab==='login' ? renderLoginForm() : renderSignupForm()}
    <div class="text-center" style="margin-top:10px;"><button class="btn-ghost" id="leaveChurchBtn" type="button" style="font-size:11.5px;color:var(--text-soft);">كود كنيسة مختلف؟</button></div>
    <div class="text-center muted" style="margin-top:8px;font-size:11px;">الإصدار ${APP_VERSION}</div>
  </div>`;
}
function renderLoginForm(){
  return `
  <form id="loginForm">
    <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="li_email" required placeholder="example@email.com"></div>
    <div class="mb-3"><label class="form-label">كلمة المرور</label><input class="form-control" type="password" id="li_pass" required placeholder="••••••••"></div>
    <div id="loginError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
    <button type="submit" class="btn btn-primary">دخول</button>
  </form>
  <div class="text-center" style="margin-top:14px;">
    <button class="btn-ghost" id="toggleEmergency" type="button">دخول بكود الطوارئ</button>
  </div>
  <div id="emergencyBox" style="display:none;margin-top:10px;">
    <div class="card px-3 py-2 mb-3">
      <div class="mb-3"><label class="form-label">البريد الإلكتروني (لخادم موجود)</label><input class="form-control" type="email" id="em_email" placeholder="example@email.com"></div>
      <div class="d-flex gap-2 equal-cols">
        <div class="mb-3"><label class="form-label">كود الطوارئ</label><input class="form-control" type="text" id="em_code" placeholder="XXXXXX"></div>
        <div class="mb-3"><label class="form-label">كلمة مرور الطوارئ</label><input class="form-control" type="text" id="em_pass" placeholder="000000"></div>
      </div>
      <button class="btn btn-danger" id="emergencyBtn" type="button">تفعيل الوصول الطارئ (٢٤ ساعة)</button>
      <p class="muted" style="margin-top:8px;">يمنحك صلاحيات مدير الكنيسة مؤقتًا، ويعود حسابك تلقائيًا لدوره الأصلي بعد ٢٤ ساعة.</p>
    </div>
  </div>`;
}
function renderSignupForm(){
  return `
  <form id="signupForm">
    <div class="mb-3"><label class="form-label">الاسم بالكامل</label><input class="form-control" type="text" id="su_name" required></div>
    <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="su_email" required></div>
    <div class="mb-3"><label class="form-label">رقم الموبايل</label><input class="form-control" type="tel" id="su_mobile" required></div>
    <div class="mb-3"><label class="form-label">العنوان</label><input class="form-control" type="text" id="su_address" required></div>
    <div class="mb-3"><label class="form-label">كلمة المرور</label><input class="form-control" type="password" id="su_pass" required minlength="4"></div>
    ${state.stages.length ? `
    <div class="mb-3"><label class="form-label">المرحلة</label>
      <select class="form-select" id="su_stage" required>
        <option value="">اختر المرحلة</option>
        ${state.stages.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
      </select>
    </div>` : `<p class="muted" style="margin-bottom:12px;">لم يتم إعداد المراحل العمرية لهذه الكنيسة بعد. يمكنك إرسال الطلب وسيتم تصنيفك لاحقًا.</p>`}
    <div id="signupError" class="muted" style="color:var(--bad);display:none;margin-bottom:10px;"></div>
    <button type="submit" class="btn btn-gold">إرسال طلب الانضمام</button>
    <p class="muted" style="margin-top:10px;text-align:center;">سيتم تسجيلك كـ"مخدوم"، وسيحتاج طلبك موافقة أحد الخدام أو مديري الكنيسة قبل الدخول.</p>
  </form>`;
}
function bindAuthEvents(){
  document.querySelectorAll('[data-authtab]').forEach(b=>{ b.onclick = ()=>{ ui.authTab = b.dataset.authtab; render(); }; });
  const loginForm = document.getElementById('loginForm');
  if(loginForm) loginForm.onsubmit = (e)=>{
    e.preventDefault();
    const email = document.getElementById('li_email').value.trim().toLowerCase();
    const pass = document.getElementById('li_pass').value;
    const u = state.users.find(x=>x.email.toLowerCase()===email && x.password===pass);
    const err = document.getElementById('loginError');
    if(!u){ err.textContent='البريد الإلكتروني أو كلمة المرور غير صحيحة.'; err.style.display='block'; return; }
    if(u.status==='rejected'){ err.textContent='تم رفض هذا الحساب سابقًا. تواصل مع أحد الخدام.'; err.style.display='block'; return; }
    if(u.status==='banned'){ err.textContent='هذا الحساب محظور. تواصل مع مدير الكنيسة.'; err.style.display='block'; return; }
    state.session.userId = u.id; persist(); render();
  };
  const signupForm = document.getElementById('signupForm');
  if(signupForm) signupForm.onsubmit = (e)=>{
    e.preventDefault();
    const email = document.getElementById('su_email').value.trim().toLowerCase();
    const mobile = document.getElementById('su_mobile').value.trim();
    const normMobile = mobile.replace(/\D/g,'');
    const err = document.getElementById('signupError');
    if(state.users.some(x=>x.email.toLowerCase()===email)){ err.textContent='هذا البريد الإلكتروني مسجّل من قبل.'; err.style.display='block'; return; }
    if(normMobile && state.users.some(x=>x.mobile.replace(/\D/g,'')===normMobile)){ err.textContent='رقم الموبايل هذا مسجّل من قبل بحساب آخر.'; err.style.display='block'; return; }
    const nu = { id: uid('u'), name: document.getElementById('su_name').value.trim(), email,
      mobile, address: document.getElementById('su_address').value.trim(),
      password: document.getElementById('su_pass').value, role:'makhdoum', status:'pending', classroomId:null,
      stageId: (document.getElementById('su_stage') ? document.getElementById('su_stage').value : null) || null, points:0, createdAt: nowISO() };
    state.users.push(nu);
    log(nu.name, 'أرسل طلب انضمام جديد (بانتظار الموافقة).');
    state.session.userId = nu.id; persist(); render();
  };
  const leaveBtn = document.getElementById('leaveChurchBtn');
  if(leaveBtn) leaveBtn.onclick = ()=>{
    churchCode = null; localStorage.removeItem(CHURCH_CODE_KEY);
    state = emptyShellState(); render();
  };
  const toggleEm = document.getElementById('toggleEmergency');
  if(toggleEm) toggleEm.onclick = ()=>{ const box = document.getElementById('emergencyBox'); box.style.display = box.style.display==='none' ? 'block' : 'none'; };
  const emBtn = document.getElementById('emergencyBtn');
  if(emBtn) emBtn.onclick = ()=>{
    const email = document.getElementById('em_email').value.trim().toLowerCase();
    const code = document.getElementById('em_code').value.trim().toUpperCase();
    const pass = document.getElementById('em_pass').value.trim();
    const cred = getEmergencyCredential();
    const u = state.users.find(x=>x.email.toLowerCase()===email && (x.role==='khadim'||x.role==='senior_admin') && x.status==='approved');
    if(!u){ showToast('لا يوجد خادم بهذا البريد الإلكتروني.'); return; }
    if(code !== cred.code || pass !== cred.pass){ showToast('كود أو كلمة مرور الطوارئ غير صحيحة.'); return; }
    if(u.role !== 'senior_admin'){
      state.emergency = { active:true, byUserId:u.id, originalRole:u.role, grantedAt: nowISO(), log: state.emergency.log };
      u.role = 'senior_admin';
      log(u.name, 'استخدم كود الطوارئ للحصول على صلاحيات مدير الكنيسة لمدة ٢٤ ساعة.');
      state.emergency.log.unshift({ id:uid('elog'), time: nowISO(), who:u.name });
    }
    state.session.userId = u.id; persist(); showToast('تم تفعيل الوصول الطارئ لمدة ٢٤ ساعة.'); render();
  };
}
function renderPending(u){
  return `<div class="auth-wrap"><div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title" style="font-size:22px;">بانتظار الموافقة</h1>
    <p class="auth-sub">أهلًا ${escapeHtml(u.name)}، تم إرسال طلبك بنجاح.<br>سيصلك إشعار بمجرد موافقة أحد الخدام أو مديري الكنيسة على انضمامك.</p>
    <button class="btn btn-outline" id="logoutBtn2">تسجيل الخروج</button></div>`;
}
function renderRejected(u){
  return `<div class="auth-wrap"><div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title" style="font-size:22px;">تعذّر قبول الطلب</h1>
    <p class="auth-sub">${escapeHtml(u.name)}، لم تتم الموافقة على هذا الحساب. للاستفسار برجاء التواصل مباشرة مع أحد الخدام.</p>
    <button class="btn btn-outline" id="logoutBtn2">تسجيل الخروج</button></div>`;
}
function renderBanned(u){
  return `<div class="auth-wrap"><div class="auth-crest">${crestSVG(64)}</div>
    <h1 class="auth-title" style="font-size:22px;color:var(--bad);">الحساب محظور</h1>
    <p class="auth-sub">${escapeHtml(u.name)}، تم حظر هذا الحساب من الدخول إلى التطبيق. للاستفسار برجاء التواصل مباشرة مع مدير الكنيسة.</p>
    <button class="btn btn-outline" id="logoutBtn2">تسجيل الخروج</button></div>`;
}
function bindPendingEvents(){ const b = document.getElementById('logoutBtn2'); if(b) b.onclick = ()=>{ state.session.userId=null; persist(); render(); }; }

/* ---------------- APP SHELL ---------------- */
function tabsFor(role){
  if(role==='makhdoum') return [
    {id:'news', label:'الأخبار', ic:'📰'}, {id:'mine', label:'حضوري', ic:'✅'}, {id:'chat', label:'الدردشة', ic:'💬'}, {id:'settings', label:'الإعدادات', ic:'⚙️'},
  ];
  const base = [
    {id:'news', label:'الأخبار', ic:'📰'}, {id:'ministry', label:'الخدمة', ic:'🗂️'}, {id:'chat', label:'الدردشة', ic:'💬'},
  ];
  if(role==='senior_admin' || role==='super_admin') base.push({id:'admin', label:'الإدارة', ic:'🛡️'});
  base.push({id:'settings', label:'الإعدادات', ic:'⚙️'});
  return base;
}
function roleLabel(r){ return r==='senior_admin' ? 'مدير الكنيسة' : r==='super_admin' ? 'سوبر أدمن' : r==='khadim' ? 'خادم' : 'مخدوم'; }

function renderApp(u){
  const tabs = tabsFor(u.role);
  if(!tabs.find(t=>t.id===ui.activeTab)) ui.activeTab = 'news';
  let emergencyBanner = '';
  if(state.emergency.active && state.emergency.byUserId===u.id){
    const grantedAt = new Date(state.emergency.grantedAt).getTime();
    const remaining = Math.max(0, 24*3600*1000 - (Date.now()-grantedAt));
    const h = Math.floor(remaining/3600000), m = Math.floor((remaining%3600000)/60000);
    emergencyBanner = `<div class="emergency-banner"><span>⚠️ وضع الوصول الطارئ نشط — يتبقّى ${h} س ${m} د</span><button id="endEmergencyNow">إنهاء الآن</button></div>`;
  }
  return `
  <div class="topbar">
    ${crestSVG(32)}
    <div class="titles"><h1>خِدمة</h1><div class="sub">${roleLabel(u.role)} · ${escapeHtml(u.name.split(' ')[0])}</div></div>
  </div>
  ${emergencyBanner}
  <div class="content" id="contentArea">${renderTab(u, ui.activeTab)}</div>
  <div class="tabbar">${tabs.map(t=>`<button class="tab ${ui.activeTab===t.id?'active':''}" data-tab="${t.id}"><span class="ic">${t.ic}</span>${t.label}</button>`).join('')}</div>
  ${ui.toast ? `<div class="app-toast">${ui.toast}</div>` : ''}
  ${ui.scanning ? renderScanOverlay() : ''}
  ${ui.confirm ? `<div class="confirm-overlay"><div class="confirm-box"><p>${escapeHtml(ui.confirm.message)}</p><div class="d-flex gap-2 equal-cols"><button class="btn btn-outline btn-sm" id="confirmNo" style="flex:1;">إلغاء</button><button class="btn btn-danger btn-sm" id="confirmYes" style="flex:1;">تأكيد</button></div></div></div>` : ''}
  `;
}
function renderTab(u, tab){
  if(tab==='news') return renderNews(u);
  if(tab==='mine') return renderMine(u);
  if(tab==='ministry') return renderMinistry(u);
  if(tab==='chat') return renderChat(u);
  if(tab==='admin') return renderAdmin(u);
  if(tab==='settings') return renderSettings(u);
  return '';
}

/* ---------------- SETTINGS ---------------- */
function renderSettings(u){
  const cls = classroomOf(u.classroomId);
  return `
  <div class="screen">
    <h2 class="section-title">الإعدادات</h2>

    <div class="card p-3 mb-3">
      <b style="font-size:14px;">البيانات الشخصية</b>
      <div class="mb-3" style="margin-top:10px;"><label class="form-label">الاسم بالكامل</label><input class="form-control" type="text" id="set_name" value="${escapeHtml(u.name)}"></div>
      <div class="mb-3"><label class="form-label">البريد الإلكتروني</label><input class="form-control" type="email" id="set_email" value="${escapeHtml(u.email)}"></div>
      <div class="mb-3"><label class="form-label">رقم الموبايل</label><input class="form-control" type="tel" id="set_mobile" value="${escapeHtml(u.mobile)}"></div>
      <div class="mb-3"><label class="form-label">العنوان</label><input class="form-control" type="text" id="set_address" value="${escapeHtml(u.address)}"></div>
      <div id="settingsProfileError" class="muted" style="color:var(--bad);display:none;margin-bottom:8px;"></div>
      <button class="btn btn-gold" id="saveProfileBtn">حفظ التعديلات</button>
      <p class="muted" style="margin-top:8px;">الدور: ${roleLabel(u.role)}${cls ? ' · الفصل: '+escapeHtml(cls.name) : ''}</p>
    </div>

    <div class="card px-3 py-2 mb-3" style="text-align:center;">
      <button class="btn btn-teal install-app-btn" onclick="triggerInstall()">📲 تثبيت التطبيق على الشاشة الرئيسية</button>
    </div>

    <div class="card p-3 mb-3">
      <b style="font-size:14px;">تغيير كلمة المرور</b>
      <div class="mb-3" style="margin-top:10px;"><label class="form-label">كلمة المرور الحالية</label><input class="form-control" type="password" id="set_pass_current"></div>
      <div class="mb-3"><label class="form-label">كلمة المرور الجديدة</label><input class="form-control" type="password" id="set_pass_new" minlength="4"></div>
      <div id="settingsPassError" class="muted" style="color:var(--bad);display:none;margin-bottom:8px;"></div>
      <button class="btn btn-outline" id="changePasswordBtn">تحديث كلمة المرور</button>
    </div>

    <div class="card p-3 mb-3" style="border-color:var(--bad);">
      <b style="font-size:14px;color:var(--bad);">منطقة الخطر</b>
      <p class="muted" style="margin:8px 0 12px;">حذف الحساب نهائي ولا يمكن التراجع عنه.</p>
      <div class="d-flex gap-2 equal-cols">
        <button class="btn btn-outline" id="settingsLogoutBtn">تسجيل الخروج</button>
        <button class="btn btn-danger" id="settingsDeleteBtn">حذف حسابي نهائيًا</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- NEWS ---------------- */
function renderNews(u){
  const canPost = isAdminish(u);
  let items = [...state.news].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  if(!isAdminish(u)) items = items.filter(n=> !n.stageId || n.stageId===u.stageId);
  const globals = [...globalNewsCache].sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
  return `
  <div class="screen">
    <h2 class="section-title">الأخبار والإعلانات</h2>
    ${canPost ? `<div class="card p-3 mb-3">
      <div class="mb-3"><input class="form-control" type="text" id="news_title" placeholder="عنوان الخبر"></div>
      <div class="mb-3"><textarea class="form-control" id="news_body" placeholder="تفاصيل الإعلان..."></textarea></div>
      <div class="mb-3"><label class="form-label">موجّه إلى</label>
        <select class="form-select" id="news_stage">
          ${u.role!=='super_admin' ? `<option value="">الجميع (كل المراحل والفصول في كنيستك)</option>` : ''}
          ${(u.role==='super_admin' ? stagesInSector(u.sectorId) : state.stages).map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-gold" id="postNewsBtn">نشر الإعلان</button>
    </div>` : ''}
    ${globals.map(n=>`
      <div class="card p-3 mb-3" style="border:2px solid var(--gold, #C79A3D);background:linear-gradient(180deg, rgba(199,154,61,.12), transparent);">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <b style="font-size:15.5px;">📢 ${escapeHtml(n.title)}</b>
        </div>
        <p style="margin:8px 0 6px;font-size:14px;line-height:1.8;">${escapeHtml(n.content)}</p>
        <div class="muted" style="font-weight:700;">رسالة عامة من إدارة النظام · ${fmtDate(n.createdAt)}</div>
      </div>`).join('')}
    ${items.length===0 && globals.length===0 ? `<div class="empty"><div class="big">📭</div>لا توجد إعلانات بعد.</div>` :
      items.map(n=>`
      <div class="card p-3 mb-3">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <b style="font-size:15.5px;">${escapeHtml(n.title)}</b>
          ${(u.role==='senior_admin' || n.authorId===u.id) ? `<button class="btn-ghost" data-del-news="${n.id}" style="color:var(--bad);">حذف</button>` : ''}
        </div>
        <p style="margin:8px 0 6px;font-size:14px;line-height:1.8;">${escapeHtml(n.content)}</p>
        <div class="muted">${escapeHtml(n.authorName)} · ${fmtDate(n.createdAt)}${n.stageId && stageOf(n.stageId) ? ' · موجّه إلى: '+escapeHtml(stageOf(n.stageId).name) : ' · للجميع'}</div>
      </div>`).join('')}
  </div>`;
}

/* ---------------- MINE (member: attendance + points + QR) ---------------- */
function renderMine(u){
  const records = state.attendance.filter(a=>a.memberId===u.id).sort((a,b)=> b.date.localeCompare(a.date));
  const totalQ = records.filter(r=>r.quddas).length, totalI = records.filter(r=>r.ijtimaa).length;
  const cls = classroomOf(u.classroomId);
  const myAssignments = state.assignments.filter(a=> !a.classroomId || a.classroomId===u.classroomId);
  return `
  <div class="screen">
    <h2 class="section-title">حضوري ونقاطي</h2>
    <div class="card p-3 mb-3" style="text-align:center;">
      <div class="muted">إجمالي نقاطي</div>
      <div style="font-size:34px;font-weight:800;color:var(--heading);">${u.points||0}</div>
      <div id="qrHolder" style="margin:14px auto 4px;width:150px;height:150px;background:#fff;border-radius:12px;display:flex;align-items:center;justify-content:center;padding:8px;"></div>
      <div class="muted">أظهر هذا الرمز لأحد الخدام لتسجيل حضورك بالمسح</div>
    </div>
    <div class="card px-3 py-2 mb-3">
      <div class="muted">الفصل: ${cls ? escapeHtml(cls.name) : '— غير محدد —'}</div>
      <div class="d-flex gap-2 equal-cols" style="margin-top:10px;">
        <div class="card px-3 py-2 mb-3" style="text-align:center;flex:1;margin:0;"><div style="font-size:20px;font-weight:800;color:var(--ok);">${totalQ}</div><div class="muted">حضور قداس</div></div>
        <div class="card px-3 py-2 mb-3" style="text-align:center;flex:1;margin:0;"><div style="font-size:20px;font-weight:800;color:var(--ok);">${totalI}</div><div class="muted">حضور اجتماع</div></div>
      </div>
    </div>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:16px 0 8px;">تكليفاتي</h3>
    ${myAssignments.length===0 ? `<p class="muted">لا توجد تكليفات حاليًا.</p>` :
      myAssignments.map(a=>{
        const done = !!a.completions[u.id];
        return `<div class="card px-3 py-2 mb-3" style="display:flex;justify-content:space-between;align-items:center;">
          <div><b style="font-size:13.5px;">${escapeHtml(a.title)}</b><div class="muted">${escapeHtml(a.description||'')}</div></div>
          <span class="badge rounded-pill ${done?'badge-ok':'badge-gold'}">${done? '✓ '+a.points+' نقطة' : a.points+' نقطة'}</span>
        </div>`;
      }).join('')
    }
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:16px 0 8px;">سجل الحضور</h3>
    ${records.length===0 ? `<div class="empty"><div class="big">🗒️</div>لا يوجد سجل حضور بعد.</div>` :
      `<div class="card p-3 mb-3"><ul class="plain">${records.map(r=>`
        <li style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);">
          <span>${fmtDate(r.date)}</span>
          <span class="d-flex" style="gap:6px;">
            <span class="badge rounded-pill ${r.quddas?'badge-ok':'badge-bad'}">قداس ${r.quddas?'✓':'✗'}</span>
            <span class="badge rounded-pill ${r.ijtimaa?'badge-ok':'badge-bad'}">اجتماع ${r.ijtimaa?'✓':'✗'}</span>
          </span>
        </li>`).join('')}</ul></div>`}
  </div>`;
}

/* ---------------- MINISTRY (khadim/senior_admin: attendance + assignments + points) ---------------- */
function renderMinistry(u){
  const sub = ui.ministrySub || 'attendance';
  return `
  <div class="screen">
    <h2 class="section-title">الخدمة</h2>
    <div class="segmented">
      <button class="${sub==='attendance'?'active':''}" data-ministry="attendance">الحضور</button>
      <button class="${sub==='assignments'?'active':''}" data-ministry="assignments">التكليفات</button>
      <button class="${sub==='points'?'active':''}" data-ministry="points">النقاط</button>
    </div>
    ${sub==='attendance' ? renderAttendanceAdmin(u) : ''}
    ${sub==='assignments' ? renderAssignments(u) : ''}
    ${sub==='points' ? renderPoints(u) : ''}
  </div>`;
}

function renderAttendanceAdmin(u){
  const viewClassrooms = state.classrooms;
  if(!ui.adminAttClassroom || !state.classrooms.find(c=>c.id===ui.adminAttClassroom)){
    ui.adminAttClassroom = (myClassrooms(u)[0] || viewClassrooms[0] || {}).id || null;
  }
  const activeCls = classroomOf(ui.adminAttClassroom);
  const canEdit = activeCls && myClassrooms(u).some(c=>c.id===activeCls.id);
  const members = activeCls ? membersOfClassroom(activeCls.id) : [];
  const date = todayStr();
  return `
    <div class="segmented">${viewClassrooms.map(c=>`<button class="${ui.adminAttClassroom===c.id?'active':''}" data-cls="${c.id}">${escapeHtml(c.name)}${c.servantIds.includes(u.id)?' (فصلي)':''}</button>`).join('')}</div>
    ${!activeCls ? `<div class="empty"><div class="big">🏫</div>لا توجد فصول بعد.</div>` : `
    <div class="card px-3 py-2 mb-3" style="display:flex;justify-content:space-between;align-items:center;">
      <span class="muted">التاريخ: ${fmtDate(date)} (اليوم)</span>
      ${canEdit ? `<button class="btn btn-teal btn-sm" id="openScanBtn">📷 مسح للحضور</button>` : `<span class="badge rounded-pill badge-ink">عرض فقط</span>`}
    </div>
    <div class="card p-3 mb-3">
      ${members.length===0 ? `<div class="empty">لا يوجد أعضاء في هذا الفصل بعد.</div>` :
        members.map(m=>{
          const rec = state.attendance.find(a=>a.memberId===m.id && a.date===date);
          const q = rec ? rec.quddas : false, i = rec ? rec.ijtimaa : false;
          return `<div class="member-row">
            <div class="avatar">${initials(m.name)}</div>
            <div class="m-name">${escapeHtml(m.name)}<small>${m.points||0} نقطة</small></div>
            <div class="check ${q?'on':''}" ${canEdit?'':'disabled'} data-att="${m.id}" data-field="quddas" title="القداس">${q?'✓':''}</div>
            <div class="check ${i?'on':''}" ${canEdit?'':'disabled'} data-att="${m.id}" data-field="ijtimaa" title="الاجتماع">${i?'✓':''}</div>
          </div>`;
        }).join('')}
    </div>
    <div class="card px-3 py-2 mb-3 muted" style="text-align:center;">✓ يسار = القداس (+${state.settings.pointsQuddas} نقطة) &nbsp;&nbsp; ✓ يمين = الاجتماع (+${state.settings.pointsIjtimaa} نقطة)</div>
    `}`;
}

/* ---------------- ASSIGNMENT PDF FILES (Supabase Storage bucket "assignment-files") ---------------- */
const ASG_BUCKET = 'assignment-files';
const STORAGE_HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY };
function validatePdf(file){
  if(!file) return null;
  if(!(file.type==='application/pdf' || /\.pdf$/i.test(file.name))) return 'الملف لازم يكون PDF.';
  if(file.size > 10*1024*1024) return 'حجم الملف أكبر من ١٠ ميجا.';
  return null;
}
async function uploadAssignmentPdf(file){
  const key = uid('f') + '.pdf';
  let res;
  try{
    res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ASG_BUCKET}/${key}`, {
      method:'POST', headers:{ ...STORAGE_HEADERS, 'Content-Type':'application/pdf' }, body:file });
  }catch(e){ throw new Error('لا يوجد اتصال بالإنترنت.'); }
  if(!res.ok){
    let d=''; try{ const j = await res.json(); d = j.message || j.error || ''; }catch(e){}
    throw new Error(`فشل رفع الملف (${res.status})${d ? ': '+d : ''} — تأكد من تشغيل ملف SQL الخاص بالملفات.`);
  }
  return { name:file.name, size:file.size, key, url:`${SUPABASE_URL}/storage/v1/object/public/${ASG_BUCKET}/${key}` };
}
async function deleteAssignmentPdf(f){
  if(!f || !f.key) return;
  try{ await fetch(`${SUPABASE_URL}/storage/v1/object/${ASG_BUCKET}/${f.key}`, { method:'DELETE', headers: STORAGE_HEADERS }); }catch(e){}
}
function fileSizeLabel(n){ return n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }

function renderAssignments(u){
  const canCreate = isAdminish(u);
  const editableClassrooms = myClassrooms(u);
  const visible = u.role==='senior_admin' ? state.assignments : state.assignments.filter(a=> !a.classroomId || editableClassrooms.some(c=>c.id===a.classroomId));
  const list = visible.slice().sort((a,b)=> (b.pinned?1:0) - (a.pinned?1:0));   // pinned first, others keep their order
  return `
    ${canCreate ? `
    <div class="card p-3 mb-3">
      <b style="font-size:14px;">تكليف جديد</b>
      <div class="mb-3" style="margin-top:10px;"><input class="form-control" type="text" id="asg_title" placeholder="عنوان التكليف"></div>
      <div class="mb-3"><textarea class="form-control" id="asg_desc" placeholder="وصف مختصر (اختياري)"></textarea></div>
      <div class="d-flex gap-2 equal-cols">
        <div class="mb-3"><label class="form-label">قيمة النقاط</label><input class="form-control" type="number" id="asg_points" value="10" min="0"></div>
        <div class="mb-3"><label class="form-label">الفصل</label>
          <select class="form-select" id="asg_cls">
            <option value="">كل الفصول</option>
            ${state.classrooms.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="mb-3"><label class="form-label">ملف PDF (اختياري)</label><input class="form-control" type="file" id="asg_file" accept="application/pdf,.pdf"></div>
      <div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="asg_pinned"><label class="form-check-label" for="asg_pinned">📌 تثبيت التكليف في الأعلى</label></div>
      <button class="btn btn-gold" id="addAssignmentBtn">إضافة التكليف</button>
    </div>` : ''}
    ${list.length===0 ? `<div class="empty"><div class="big">📋</div>لا توجد تكليفات بعد.</div>` :
      list.map(a=>{
        const cls = classroomOf(a.classroomId);
        const members = a.classroomId ? membersOfClassroom(a.classroomId) : state.users.filter(x=>x.role==='makhdoum'&&x.status==='approved');
        const doneCount = Object.keys(a.completions).length;
        return `
        <div class="card p-3 mb-3">
          <div class="d-flex justify-content-between align-items-start">
            <div><b style="font-size:14.5px;">${a.pinned ? '📌 ' : ''}${escapeHtml(a.title)}</b><div class="muted">${escapeHtml(cls?cls.name:'كل الفصول')} · أنجزها ${doneCount}/${members.length}</div></div>
            ${canCreate ? `<div class="d-flex gap-1"><button class="btn-ghost" data-pin-asg="${a.id}">${a.pinned ? 'إلغاء التثبيت' : '📌 تثبيت'}</button><button class="btn-ghost" data-del-asg="${a.id}" style="color:var(--bad);">حذف</button></div>` : ''}
          </div>
          ${a.file ? `<div class="d-flex align-items-center gap-2" style="margin:8px 0;"><a href="${escapeHtml(a.file.url)}" target="_blank" rel="noopener" style="font-weight:700;color:var(--teal);word-break:break-all;">📎 ${escapeHtml(a.file.name)}</a><span class="muted">(${fileSizeLabel(a.file.size||0)})</span>${canCreate ? `<button class="btn-ghost" data-remove-file="${a.id}" style="color:var(--bad);">إزالة</button>` : ''}</div>` : ''}
          ${canCreate ? `<div style="margin:4px 0;"><label class="btn-ghost" for="attach_${a.id}" style="cursor:pointer;">${a.file ? '🔄 استبدال ملف PDF' : '📎 إرفاق ملف PDF'}</label><input type="file" id="attach_${a.id}" data-attach-input="${a.id}" accept="application/pdf,.pdf" hidden></div>` : ''}
          ${a.description ? `<p class="muted" style="margin:6px 0;">${escapeHtml(a.description)}</p>` : ''}
          <div class="d-flex gap-2 equal-cols" style="align-items:center;margin:8px 0 10px;">
            <span class="muted">قيمة النقاط:</span>
            ${canCreate ? `<input class="form-control" type="number" min="0" data-asg-points="${a.id}" value="${a.points}" style="width:70px;padding:6px 8px;border-radius:8px;border:1.5px solid var(--line);">` : `<b>${a.points}</b>`}
          </div>
          ${canCreate ? `<div class="checklist">
            ${members.map(m=>`<label><input type="checkbox" data-asg-check="${a.id}|${m.id}" ${a.completions[m.id]?'checked':''}> ${escapeHtml(m.name)} ${a.completions[m.id]?`<span class="badge rounded-pill badge-ok" style="margin-right:auto;">تم</span>`:''}</label>`).join('')}
          </div>` : ''}
        </div>`;
      }).join('')}
  `;
}

function renderPoints(u){
  const canEditSettings = u.role==='senior_admin';
  const scope = u.role==='senior_admin' ? state.classrooms : myClassrooms(u);
  const memberIds = new Set();
  scope.forEach(c=> membersOfClassroom(c.id).forEach(m=>memberIds.add(m.id)));
  const members = state.users.filter(m=>memberIds.has(m.id)).sort((a,b)=> (b.points||0)-(a.points||0));
  return `
    <div class="card p-3 mb-3">
      <b style="font-size:14px;">إعدادات نقاط الحضور</b>
      <div class="d-flex gap-2 equal-cols" style="margin-top:10px;">
        <div class="mb-3"><label class="form-label">نقاط حضور القداس</label><input class="form-control" type="number" id="pts_quddas" value="${state.settings.pointsQuddas}" min="0" ${canEditSettings?'':'disabled'}></div>
        <div class="mb-3"><label class="form-label">نقاط حضور الاجتماع</label><input class="form-control" type="number" id="pts_ijtimaa" value="${state.settings.pointsIjtimaa}" min="0" ${canEditSettings?'':'disabled'}></div>
      </div>
      ${canEditSettings ? `<button class="btn btn-teal" id="savePointsSettings">حفظ الإعدادات</button>` : `<p class="muted">مدير الكنيسة فقط يمكنه تعديل هذه القيم.</p>`}
    </div>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:16px 0 8px;">نقاط الأعضاء</h3>
    ${members.length===0 ? `<p class="muted">لا يوجد أعضاء في نطاق فصولك بعد.</p>` :
      members.map(m=>`
      <div class="card px-3 py-2 mb-3" style="display:flex;justify-content:space-between;align-items:center;">
        <div class="m-name" style="flex:1;">${escapeHtml(m.name)}</div>
        <div class="points-pill">
          <button data-pts-adj="${m.id}|-1">−</button>
          <span class="val">${m.points||0}</span>
          <button data-pts-adj="${m.id}|1">+</button>
        </div>
      </div>`).join('')}
  `;
}

/* ---------------- CHAT ---------------- */
function renderChat(u){
  if(ui.openChatId){ const chat = state.chats.find(c=>c.id===ui.openChatId); if(chat) return renderChatThread(u, chat); ui.openChatId = null; }
  if(u.role==='makhdoum'){
    let myChat = [...state.chats].filter(c=>c.memberId===u.id).sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt))[0];
    if(!myChat || myChat.status==='closed'){
      return `<div class="screen"><h2 class="section-title">تواصل مع الخدمة</h2>
        <div class="empty"><div class="big">💬</div>${myChat ? 'تم إغلاق محادثتك السابقة.' : 'ليس لديك محادثة حاليًا.'}<br>ابدأ محادثة جديدة مع أحد الخدام.</div>
        <button class="btn btn-gold" id="newChatBtn">بدء محادثة جديدة</button></div>`;
    }
    ui.openChatId = myChat.id;
    return renderChatThread(u, myChat);
  }
  const unclaimed = state.chats.filter(c=>c.status==='unclaimed');
  const mine = state.chats.filter(c=>c.claimedById===u.id && c.status==='claimed');
  return `
  <div class="screen">
    <h2 class="section-title">قائمة الدردشات</h2>
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:0 0 8px;">غير مُستلمة (${unclaimed.length})</h3>
    ${unclaimed.length===0 ? `<p class="muted" style="margin-bottom:16px;">لا توجد محادثات بانتظار الاستلام.</p>` :
      unclaimed.map(c=>`<div class="chat-list-item" data-openchat="${c.id}">
        <div class="avatar">${initials(c.memberName)}</div>
        <div style="flex:1;min-width:0;"><b>${escapeHtml(c.memberName)}</b><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.messages[c.messages.length-1]?.text || '')}</div></div>
        <button class="btn btn-gold btn-sm" data-claim="${c.id}">استلام</button>
      </div>`).join('')}
    <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">محادثاتي (${mine.length})</h3>
    ${mine.length===0 ? `<p class="muted">لا توجد محادثات مستلمة حاليًا.</p>` :
      mine.map(c=>`<div class="chat-list-item" data-openchat="${c.id}">
        <div class="avatar">${initials(c.memberName)}</div>
        <div style="flex:1;min-width:0;"><b>${escapeHtml(c.memberName)}</b><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.messages[c.messages.length-1]?.text || '')}</div></div>
      </div>`).join('')}
  </div>`;
}
function renderChatThread(u, chat){
  const isMember = u.role==='makhdoum';
  const canReply = isMember || chat.claimedById===u.id;
  const statusBadge = chat.status==='unclaimed' ? `<span class="badge rounded-pill badge-gold">بانتظار استلام أحد الخدام</span>`
    : chat.status==='claimed' ? `<span class="badge rounded-pill badge-ok">${isMember ? 'يتحدث معك: '+escapeHtml(chat.claimedByName) : 'مستلمة بواسطتك'}</span>`
    : `<span class="badge rounded-pill badge-ink">تم إغلاق المحادثة</span>`;
  return `
  <div class="screen">
    <div class="d-flex align-items-center gap-2" style="margin-bottom:10px;">
      <button class="btn-ghost" id="backToChatList">‹ رجوع</button>
      <b style="flex:1;">${isMember ? 'محادثتي' : escapeHtml(chat.memberName)}</b>
      ${(!isMember && chat.status==='claimed' && chat.claimedById===u.id) ? `<button class="btn-ghost" id="closeChatBtn" style="color:var(--bad);">إنهاء</button>` : ''}
    </div>
    <div class="card px-3 py-2 mb-3" style="margin-bottom:10px;">${statusBadge}</div>
    <div class="chat-thread">
      <div class="thread-msgs">${chat.messages.map(m=>{
        const cls = (isMember ? m.sender==='member' : m.sender==='admin') ? 'me' : 'them';
        return `<div class="bubble ${cls}">${escapeHtml(m.text)}<span class="t">${fmtTime(m.time)}${m.senderName?' · '+escapeHtml(m.senderName):''}</span></div>`;
      }).join('')}</div>
      ${canReply && chat.status!=='closed' ? `<div class="thread-input"><input class="form-control" type="text" id="chatInput" placeholder="اكتب رسالتك..."><button class="btn btn-primary" id="sendChatBtn">إرسال</button></div>`
        : chat.status==='closed' ? `<p class="muted" style="text-align:center;padding-top:8px;">هذه المحادثة مغلقة.</p>`
        : `<p class="muted" style="text-align:center;padding-top:8px;">بانتظار استلام أحد الخدام قبل أن تتمكن من الرد.</p>`}
    </div>
  </div>`;
}

/* ---------------- ADMIN ---------------- */
function renderAdmin(u){
  const sub = ui.adminSub || 'pending';
  const isDirector = u.role==='senior_admin';
  const pendingUsers = state.users.filter(x=>{
    if(x.status!=='pending') return false;
    if(isDirector) return true;
    return x.stageId && stageOf(x.stageId) && stageOf(x.stageId).sectorId===u.sectorId;
  });
  return `
  <div class="screen">
    <h2 class="section-title">لوحة الإدارة${!isDirector ? ' — '+escapeHtml(sectorOf(u.sectorId) ? sectorOf(u.sectorId).name : 'قطاعك') : ''}</h2>
    <div class="segmented">
      <button class="${sub==='pending'?'active':''}" data-adminsub="pending">طلبات الانتظار ${pendingUsers.length?('('+pendingUsers.length+')'):''}</button>
      <button class="${sub==='people'?'active':''}" data-adminsub="people">الخدام والفصول</button>
      ${isDirector ? `<button class="${sub==='emergency'?'active':''}" data-adminsub="emergency">كود الطوارئ</button>` : ''}
      <button class="${sub==='log'?'active':''}" data-adminsub="log">سجل النشاط</button>
    </div>
    ${sub==='pending' ? renderAdminPending(pendingUsers, u) : ''}
    ${sub==='people' ? renderAdminPeople(u) : ''}
    ${sub==='emergency' && isDirector ? renderAdminEmergency() : ''}
    ${sub==='log' ? renderAdminLog() : ''}
  </div>`;
}
function renderAdminPending(list, u){
  if(list.length===0) return `<div class="empty"><div class="big">✅</div>لا توجد طلبات بانتظار المراجعة.</div>`;
  const isDirector = u.role==='senior_admin';
  const visibleStages = isDirector ? state.stages : stagesInSector(u.sectorId);
  const unstagedClassrooms = isDirector ? state.classrooms.filter(c=>!c.stageId) : [];
  return list.map(p=>`
    <div class="card p-3 mb-3"><b>${escapeHtml(p.name)}</b>
      <div class="muted" style="margin:4px 0;">${escapeHtml(p.email)} · ${escapeHtml(p.mobile)}</div>
      <div class="muted" style="margin-bottom:10px;">${escapeHtml(p.address)}${p.stageId && stageOf(p.stageId) ? ' · طلب مرحلة: '+escapeHtml(stageOf(p.stageId).name) : ''}</div>
      <div class="mb-3" style="margin-bottom:10px;">
        <label class="form-label">الفصل</label>
        <select class="form-select" data-pending-cls="${p.id}" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون فصل (يمكن تعيينه لاحقًا)</option>
          ${visibleStages.map(s=>`<optgroup label="${escapeHtml(s.name)}">
            ${classroomsInStage(s.id).map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
          </optgroup>`).join('')}
          ${unstagedClassrooms.length ? `<optgroup label="بدون مرحلة">${unstagedClassrooms.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : ''}
        </select>
      </div>
      <div class="d-flex gap-2 equal-cols"><button class="btn btn-gold btn-sm" data-approve="${p.id}">✓ قبول</button><button class="btn btn-outline btn-sm" data-reject="${p.id}" style="color:var(--bad);border-color:var(--bad);">✗ رفض</button></div>
    </div>`).join('');
}
function renderAdminPeople(u){
  const isDirector = u.role==='senior_admin';
  const mySectorId = u.role==='super_admin' ? u.sectorId : null;
  const visibleStages = isDirector ? state.stages : stagesInSector(mySectorId);
  const visibleStageIds = visibleStages.map(s=>s.id);
  const visibleClassrooms = isDirector ? state.classrooms : state.classrooms.filter(c=>visibleStageIds.includes(c.stageId));
  const relevantToMe = (x)=>{
    if(isDirector) return true;
    if(x.classroomId && visibleClassrooms.some(c=>c.id===x.classroomId)) return true;
    if(x.stageId && visibleStageIds.includes(x.stageId)) return true;
    if(x.role==='khadim' && state.classrooms.some(c=>visibleStageIds.includes(c.stageId) && c.servantIds.includes(x.id))) return true;
    return false;
  };
  const khadimAll = state.users.filter(x=>x.role==='khadim' && x.status==='approved');
  const khadim = khadimAll.filter(relevantToMe);
  const superAdmins = state.users.filter(x=>x.role==='super_admin' && x.status==='approved');
  const seniors = state.users.filter(x=>x.role==='senior_admin' && x.status==='approved');
  const makhdoumeen = state.users.filter(x=>x.role==='makhdoum' && x.status==='approved').filter(relevantToMe);
  const banned = state.users.filter(x=>x.status==='banned').filter(relevantToMe);
  const dangerButtons = (p)=> p.id===u.id ? `<span class="muted">(حسابك)</span>` : `
    <button class="btn-ghost" data-ban-user="${p.id}" style="color:var(--bad);">حظر</button>
    <button class="btn-ghost" data-delete-user="${p.id}" style="color:var(--bad);">حذف نهائي</button>`;
  const passwordResetBlock = (p)=> `
    <div style="margin-top:8px;">
      ${ui.resetPwFor===p.id ? `
        <div class="d-flex gap-2 equal-cols" style="gap:6px;">
          <input class="form-control" type="text" id="newPwInput_${p.id}" placeholder="كلمة مرور جديدة" style="flex:2;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <button class="btn btn-teal btn-sm" data-save-pw="${p.id}" style="flex:1;">حفظ</button>
          <button class="btn-ghost" data-cancel-pw="${p.id}">إلغاء</button>
        </div>` : `<button class="btn-ghost" data-reset-pw="${p.id}">🔑 تغيير كلمة المرور</button>`}
    </div>`;
  return `
  ${isDirector ? `
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:4px 0 8px;">القطاعات</h3>
  <div class="card px-3 py-2 mb-3 d-flex flex-row gap-2 equal-cols" style="align-items:center;">
    <input class="form-control" type="text" id="newSectorName" placeholder="اسم القطاع الجديد" style="flex:2;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
    <button class="btn btn-gold btn-sm" id="addSectorBtn" style="flex:1;">إضافة</button>
  </div>
  ${state.sectors.map(sec=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex gap-2 equal-cols" style="align-items:center;gap:8px;">
        <input class="form-control" type="text" data-sector-name="${sec.id}" value="${escapeHtml(sec.name)}" style="flex:2;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;">
        <button class="btn btn-teal btn-sm" data-save-sector-name="${sec.id}" style="flex:0;">حفظ</button>
        <button class="btn-ghost" data-del-sector="${sec.id}" style="color:var(--bad);">حذف</button>
      </div>
      <div class="muted" style="margin-top:6px;">عدد المراحل: ${stagesInSector(sec.id).length}</div>
    </div>`).join('')}
  ` : ''}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">المراحل العمرية</h3>
  <div class="card px-3 py-2 mb-3">
    <input class="form-control" type="text" id="newStageName" placeholder="اسم المرحلة الجديدة" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
    ${isDirector ? `<select class="form-select" id="newStageSector" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
      <option value="">بدون قطاع</option>
      ${state.sectors.map(sec=>`<option value="${sec.id}">${escapeHtml(sec.name)}</option>`).join('')}
    </select>` : ''}
    <button class="btn btn-gold btn-sm" id="addStageBtn" style="width:100%;">إضافة</button>
  </div>
  ${visibleStages.map(s=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex gap-2 equal-cols" style="align-items:center;gap:8px;">
        <input class="form-control" type="text" data-stage-name="${s.id}" value="${escapeHtml(s.name)}" style="flex:2;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;">
        <button class="btn btn-teal btn-sm" data-save-stage-name="${s.id}" style="flex:0;">حفظ</button>
        <button class="btn-ghost" data-del-stage="${s.id}" style="color:var(--bad);">حذف</button>
      </div>
      ${isDirector ? `<div class="mb-3" style="margin-top:8px;"><label class="form-label">القطاع</label>
        <select class="form-select" data-stage-sector="${s.id}" style="width:100%;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون قطاع</option>
          ${state.sectors.map(sec=>`<option value="${sec.id}" ${s.sectorId===sec.id?'selected':''}>${escapeHtml(sec.name)}</option>`).join('')}
        </select>
      </div>` : ''}
      <div class="muted" style="margin-top:6px;">عدد الفصول: ${classroomsInStage(s.id).length}</div>
    </div>`).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">إضافة فصل جديد</h3>
  <div class="card px-3 py-2 mb-3">
    <input class="form-control" type="text" id="newClassName" placeholder="اسم الفصل الجديد" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
    <select class="form-select" id="newClassStage" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);margin-bottom:8px;">
      <option value="">بدون مرحلة</option>
      ${visibleStages.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('')}
    </select>
    <button class="btn btn-gold btn-sm" id="addClassroomBtn" style="width:100%;">إضافة الفصل</button>
  </div>
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الفصول وتعيين الخدام (يمكن اختيار أكثر من خادم)</h3>
  ${visibleClassrooms.map(c=>`
    <div class="card p-3 mb-3">
      <div class="d-flex gap-2 equal-cols" style="align-items:center;gap:8px;">
        <input class="form-control" type="text" data-cls-name="${c.id}" value="${escapeHtml(c.name)}" style="flex:2;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);font-weight:700;">
        <button class="btn btn-teal btn-sm" data-save-cls-name="${c.id}" style="flex:0;">حفظ الاسم</button>
      </div>
      <div class="mb-3" style="margin-top:8px;">
        <label class="form-label">المرحلة</label>
        <select class="form-select" data-cls-stage="${c.id}" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون مرحلة</option>
          ${visibleStages.map(s=>`<option value="${s.id}" ${c.stageId===s.id?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="d-flex justify-content-end" style="margin-top:8px;">
        <button class="btn-ghost" data-del-cls="${c.id}" style="color:var(--bad);">حذف الفصل</button>
      </div>
      <div class="checklist" style="margin-top:10px;">
        ${khadimAll.length===0 ? `<span class="muted">لا يوجد خدام معتمدون بعد.</span>` :
          khadimAll.map(k=>`<label><input type="checkbox" data-cls-servant="${c.id}|${k.id}" ${c.servantIds.includes(k.id)?'checked':''}> ${escapeHtml(k.name)}</label>`).join('')}
      </div>
      <div class="muted" style="margin-top:8px;">عدد الأعضاء: ${membersOfClassroom(c.id).length}</div>
    </div>`).join('')}
  ${isDirector ? `
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">مديرو الكنيسة (${seniors.length})</h3>
  ${seniors.map(s=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(s.name)}</span><span class="badge rounded-pill badge-gold">مدير الكنيسة</span></div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">
        ${s.id===u.id ? '' : `<button class="btn-ghost" data-demoteadmin="${s.id}">تخفيض لخادم</button>`}
        ${dangerButtons(s)}
      </div>
    </div>`).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">السوبر أدمن (${superAdmins.length})</h3>
  ${superAdmins.length===0 ? `<p class="muted">لا يوجد سوبر أدمن بعد.</p>` : superAdmins.map(s=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(s.name)}</span><span class="badge rounded-pill badge-gold">سوبر أدمن${s.sectorId && sectorOf(s.sectorId) ? ' — '+escapeHtml(sectorOf(s.sectorId).name) : ''}</span></div>
      <div class="mb-3" style="margin-top:8px;"><label class="form-label">القطاع</label>
        <select class="form-select" data-change-sector="${s.id}" style="width:100%;padding:8px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون قطاع</option>
          ${state.sectors.map(sec=>`<option value="${sec.id}" ${s.sectorId===sec.id?'selected':''}>${escapeHtml(sec.name)}</option>`).join('')}
        </select>
      </div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">
        <button class="btn-ghost" data-demote-super="${s.id}">تخفيض لخادم</button>
        ${dangerButtons(s)}
      </div>
      ${passwordResetBlock(s)}
    </div>`).join('')}
  ` : ''}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الخدام (${khadim.length})</h3>
  ${khadim.map(k=>{
    const servedClasses = state.classrooms.filter(c=>c.servantIds.includes(k.id));
    return `
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(k.name)}</span>${isDirector ? `<button class="btn-ghost" data-promote="${k.id}">ترقية لمدير الكنيسة</button>` : ''}</div>
      <div class="muted" style="margin-top:6px;">${servedClasses.length ? 'يخدم في: ' + servedClasses.map(c=>`${escapeHtml(c.name)}${c.stageId && stageOf(c.stageId) ? ' ('+escapeHtml(stageOf(c.stageId).name)+')' : ''}`).join('، ') : 'لا يخدم في أي فصل حاليًا.'}</div>
      ${isDirector && state.sectors.length ? `
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;align-items:center;">
        <select class="form-select" data-superadmin-sector="${k.id}" style="flex:2;padding:7px 8px;border-radius:8px;border:1.5px solid var(--line);font-size:12.5px;">
          ${state.sectors.map(sec=>`<option value="${sec.id}">${escapeHtml(sec.name)}</option>`).join('')}
        </select>
        <button class="btn-ghost" data-promote-super="${k.id}" style="flex:1;">ترقية لسوبر أدمن</button>
      </div>` : ''}
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">
        <button class="btn-ghost" data-demote="${k.id}">تخفيض لمخدوم</button>
        ${dangerButtons(k)}
      </div>
      ${passwordResetBlock(k)}
    </div>`;}).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">المخدومين (${makhdoumeen.length})</h3>
  ${makhdoumeen.map(m=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(m.name)}</span><button class="btn-ghost" data-promotekh="${m.id}">ترقية لخادم</button></div>
      <div class="mb-3" style="margin-top:8px;">
        <label class="form-label">الفصل</label>
        <select class="form-select" data-assign-cls="${m.id}" style="width:100%;padding:9px 10px;border-radius:8px;border:1.5px solid var(--line);">
          <option value="">بدون فصل</option>
          ${visibleStages.map(s=>`<optgroup label="${escapeHtml(s.name)}">
            ${classroomsInStage(s.id).map(c=>`<option value="${c.id}" ${m.classroomId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}
          </optgroup>`).join('')}
          ${isDirector && state.classrooms.filter(c=>!c.stageId).length ? `<optgroup label="بدون مرحلة">${state.classrooms.filter(c=>!c.stageId).map(c=>`<option value="${c.id}" ${m.classroomId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</optgroup>` : ''}
        </select>
      </div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:8px;justify-content:flex-end;">${dangerButtons(m)}</div>
      ${passwordResetBlock(m)}
    </div>`).join('')}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:18px 0 8px;">الحسابات المحظورة (${banned.length})</h3>
  ${banned.length===0 ? `<p class="muted">لا توجد حسابات محظورة حاليًا.</p>` :
    banned.map(b=>`
    <div class="card px-3 py-2 mb-3">
      <div class="d-flex justify-content-between align-items-center"><span>${escapeHtml(b.name)}</span><span class="badge rounded-pill badge-bad">محظور</span></div>
      <div class="muted" style="margin:4px 0;">${escapeHtml(b.email)} · ${roleLabel(b.role)}</div>
      <div class="d-flex gap-2 equal-cols" style="gap:6px;margin-top:6px;">
        <button class="btn btn-teal btn-sm" data-unban-user="${b.id}">إلغاء الحظر</button>
        <button class="btn btn-outline btn-sm" data-delete-user="${b.id}" style="color:var(--bad);border-color:var(--bad);">حذف نهائي</button>
      </div>
    </div>`).join('')}
  `;
}
function renderAdminEmergency(){
  const cred = getEmergencyCredential();
  const remaining = cred.nextRefresh - Date.now();
  const mm = Math.floor(remaining/60000), ss = Math.floor((remaining%60000)/1000);
  return `
  <div class="card p-3 mb-3">
    <div class="muted" style="margin-bottom:8px;">كود الوصول الطارئ الحالي (يتغيّر تلقائيًا كل ساعة)</div>
    <div class="d-flex" style="gap:10px;">
      <div class="text-center" style="flex:1;background:var(--parchment-2);border-radius:10px;padding:12px;"><div style="font-size:11px;color:var(--text-soft);">الكود</div><div style="font-size:20px;font-weight:800;letter-spacing:3px;color:var(--heading);">${cred.code}</div></div>
      <div class="text-center" style="flex:1;background:var(--parchment-2);border-radius:10px;padding:12px;"><div style="font-size:11px;color:var(--text-soft);">كلمة المرور</div><div style="font-size:20px;font-weight:800;letter-spacing:3px;color:var(--heading);">${cred.pass}</div></div>
    </div>
    <p class="muted" style="text-align:center;margin-top:10px;">يتغير الكود خلال ${mm} د ${ss} ث. يمنح صلاحيات مدير الكنيسة لمدة ٢٤ ساعة ثم يعود المستخدم تلقائيًا لدوره الأصلي.</p>
  </div>
  ${state.emergency.active ? `<div class="card px-3 py-2 mb-3" style="border-color:var(--oxblood);">
    <b style="color:var(--oxblood);">وضع طارئ نشط حاليًا</b>
    <div class="muted">بواسطة: ${escapeHtml((state.users.find(x=>x.id===state.emergency.byUserId)||{}).name || '—')}</div>
    <button class="btn btn-outline btn-sm" style="margin-top:8px;color:var(--bad);border-color:var(--bad);" id="forceEndEmergency">إنهاء الوصول الطارئ الآن</button>
  </div>` : ''}
  <h3 style="font-size:13.5px;color:var(--text-soft);margin:16px 0 8px;">سجل استخدام كود الطوارئ</h3>
  ${state.emergency.log.length===0 ? `<p class="muted">لم يُستخدم كود الطوارئ بعد.</p>` :
    state.emergency.log.map(e=>`<div class="card px-3 py-2 mb-3"><b>${escapeHtml(e.who)}</b><div class="muted">${new Date(e.time).toLocaleString('ar-EG')}</div></div>`).join('')}`;
}
function renderAdminLog(){
  return state.auditLog.map(l=>`<div class="card px-3 py-2 mb-3"><div class="d-flex justify-content-between"><b style="font-size:13px;">${escapeHtml(l.actor)}</b><span class="muted">${new Date(l.time).toLocaleString('ar-EG')}</span></div><div style="font-size:13px;margin-top:3px;">${escapeHtml(l.action)}</div></div>`).join('');
}

/* ---------------- SCANNER ---------------- */
function renderScanOverlay(){
  return `<div class="scan-overlay">
    <div class="scan-top"><span></span><button id="closeScanBtn">✕</button></div>
    <video id="scanVideo" playsinline muted autoplay></video>
    <div class="scan-frame"></div>
    <canvas id="scanCanvas" style="display:none;"></canvas>
    <div class="scan-status" id="scanStatus">وجّه الكاميرا نحو رمز QR الخاص بالعضو</div>
  </div>`;
}
let scanStream = null, scanRAF = null;
function startScanner(){
  const video = document.getElementById('scanVideo');
  if(!video || video.dataset.started) return;
  video.dataset.started = '1';
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    document.getElementById('scanStatus').textContent = 'الكاميرا غير متاحة في هذا المتصفح.'; return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } }).then(stream=>{
    scanStream = stream; video.srcObject = stream; video.play();
    const canvas = document.getElementById('scanCanvas'); const ctx = canvas.getContext('2d');
    function tick(){
      if(!ui.scanning) return;
      if(video.readyState === video.HAVE_ENOUGH_DATA && window.jsQR){
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const img = ctx.getImageData(0,0,canvas.width,canvas.height);
        const code = window.jsQR(img.data, img.width, img.height);
        if(code && code.data){ handleScanResult(code.data); return; }
      }
      scanRAF = requestAnimationFrame(tick);
    }
    scanRAF = requestAnimationFrame(tick);
  }).catch(()=>{ const s = document.getElementById('scanStatus'); if(s) s.textContent = 'تعذّر الوصول إلى الكاميرا. تأكد من إذن الكاميرا.'; });
}
function stopScanner(){
  ui.scanning = false;
  if(scanRAF) cancelAnimationFrame(scanRAF);
  if(scanStream){ scanStream.getTracks().forEach(t=>t.stop()); scanStream = null; }
}
function handleScanResult(data){
  const u = currentUser();
  const match = /^khidma-member:(.+)$/.exec(data.trim());
  const memberId = match ? match[1] : null;
  const member = memberId ? state.users.find(x=>x.id===memberId && x.role==='makhdoum') : null;
  stopScanner();
  if(!member){ showToast('رمز غير صالح.'); render(); return; }
  const cls = classroomOf(ui.adminAttClassroom);
  if(!cls || member.classroomId !== cls.id){ showToast('هذا العضو ليس ضمن الفصل الحالي.'); render(); return; }
  const date = todayStr();
  let rec = state.attendance.find(a=>a.memberId===member.id && a.date===date);
  if(!rec){ rec = { id:uid('att'), memberId:member.id, classroomId:cls.id, date, quddas:false, ijtimaa:false, markedBy:u.id }; state.attendance.push(rec); }
  if(!rec.quddas){ rec.quddas = true; awardPoints(member, state.settings.pointsQuddas, 'حضور القداس (مسح)', u.name); }
  rec.markedBy = u.id;
  log(u.name, `سجّل حضور ${member.name} عبر المسح الضوئي.`);
  persist();
  showToast(`تم تسجيل حضور ${member.name} ✓`);
  render();
}

/* =========================================================================
   EVENT BINDING for app shell
   ========================================================================= */
function bindAppEvents(u){
  document.querySelectorAll('.tab').forEach(b=>{ b.onclick = ()=>{ ui.activeTab = b.dataset.tab; ui.openChatId=null; render(); }; });
  const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
  if(settingsLogoutBtn) settingsLogoutBtn.onclick = ()=>{ askConfirm('تسجيل الخروج؟', ()=>{ state.session.userId=null; persist(); render(); }); };
  const settingsDeleteBtn = document.getElementById('settingsDeleteBtn');
  if(settingsDeleteBtn) settingsDeleteBtn.onclick = ()=>{
    if(u.role==='senior_admin' && state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){
      showToast('لا يمكنك حذف حسابك بصفتك مدير الكنيسة الوحيد المتبقي.'); return;
    }
    askConfirm('حذف حسابك نهائيًا؟ لا يمكن التراجع عن هذا الإجراء، وستُسجَّل خروجك فورًا.', ()=>{
      state.classrooms.forEach(c=>{ c.servantIds = c.servantIds.filter(id=>id!==u.id); });
      state.users = state.users.filter(x=>x.id!==u.id);
      log(u.name, 'حذف حسابه الخاص نهائيًا.');
      state.session.userId = null;
      persist(); render();
    });
  };
  const saveProfileBtn = document.getElementById('saveProfileBtn');
  if(saveProfileBtn) saveProfileBtn.onclick = ()=>{
    const name = document.getElementById('set_name').value.trim();
    const email = document.getElementById('set_email').value.trim().toLowerCase();
    const mobile = document.getElementById('set_mobile').value.trim();
    const address = document.getElementById('set_address').value.trim();
    const normMobile = mobile.replace(/\D/g,'');
    const err = document.getElementById('settingsProfileError');
    if(!name || !email || !mobile || !address){ err.textContent='يرجى تعبئة كل الحقول.'; err.style.display='block'; return; }
    if(state.users.some(x=>x.id!==u.id && x.email.toLowerCase()===email)){ err.textContent='هذا البريد الإلكتروني مستخدم بحساب آخر.'; err.style.display='block'; return; }
    if(normMobile && state.users.some(x=>x.id!==u.id && x.mobile.replace(/\D/g,'')===normMobile)){ err.textContent='رقم الموبايل هذا مسجّل بحساب آخر.'; err.style.display='block'; return; }
    err.style.display='none';
    u.name=name; u.email=email; u.mobile=mobile; u.address=address;
    log(u.name, 'حدّث بياناته الشخصية.'); persist(); showToast('تم حفظ التعديلات.'); render();
  };
  const changePasswordBtn = document.getElementById('changePasswordBtn');
  if(changePasswordBtn) changePasswordBtn.onclick = ()=>{
    const current = document.getElementById('set_pass_current').value;
    const next = document.getElementById('set_pass_new').value;
    const err = document.getElementById('settingsPassError');
    if(current !== u.password){ err.textContent='كلمة المرور الحالية غير صحيحة.'; err.style.display='block'; return; }
    if(!next || next.length<4){ err.textContent='كلمة المرور الجديدة يجب أن تكون ٤ أحرف على الأقل.'; err.style.display='block'; return; }
    err.style.display='none';
    u.password = next;
    log(u.name, 'غيّر كلمة المرور الخاصة به.'); persist(); showToast('تم تحديث كلمة المرور.'); render();
  };
  const confirmYes = document.getElementById('confirmYes');
  if(confirmYes) confirmYes.onclick = ()=>{ const action = ui.confirm && ui.confirm.onYes; ui.confirm = null; if(action) action(); else render(); };
  const confirmNo = document.getElementById('confirmNo');
  if(confirmNo) confirmNo.onclick = ()=>{ ui.confirm = null; render(); };
  const endEm = document.getElementById('endEmergencyNow');
  if(endEm) endEm.onclick = ()=>{ revertEmergency('تم إنهاء الوصول الطارئ يدويًا.'); persist(); render(); };

  // QR code render for member "mine" tab
  const qrHolder = document.getElementById('qrHolder');
  if(qrHolder){
    qrHolder.innerHTML = generateQRSvg('khidma-member:'+u.id);
  }

  // NEWS
  const postNewsBtn = document.getElementById('postNewsBtn');
  if(postNewsBtn) postNewsBtn.onclick = ()=>{
    const title = document.getElementById('news_title').value.trim();
    const body = document.getElementById('news_body').value.trim();
    const stageSel = document.getElementById('news_stage');
    const stageId = stageSel && stageSel.value ? stageSel.value : null;
    if(!title || !body){ showToast('يرجى إدخال العنوان والتفاصيل.'); return; }
    state.news.push({ id:uid('news'), title, content:body, stageId, authorName:u.name, authorId:u.id, createdAt: nowISO() });
    const stage = stageId ? stageOf(stageId) : null;
    log(u.name, stage ? `نشر إعلانًا لمرحلة "${stage.name}": "${title}"` : `نشر إعلانًا: "${title}"`); persist(); render();
  };
  document.querySelectorAll('[data-del-news]').forEach(b=>{ b.onclick = ()=>{ state.news = state.news.filter(n=>n.id!==b.dataset.delNews); log(u.name,'حذف إعلانًا.'); persist(); render(); }; });

  // MINISTRY sub nav
  document.querySelectorAll('[data-ministry]').forEach(b=>{ b.onclick = ()=>{ ui.ministrySub = b.dataset.ministry; render(); }; });

  // ATTENDANCE
  document.querySelectorAll('[data-cls]').forEach(b=>{ b.onclick = ()=>{ ui.adminAttClassroom = b.dataset.cls; render(); }; });
  document.querySelectorAll('[data-att]').forEach(b=>{
    b.onclick = ()=>{
      const memberId = b.dataset.att, field = b.dataset.field, date = todayStr();
      let rec = state.attendance.find(a=>a.memberId===memberId && a.date===date);
      if(!rec){ rec = { id:uid('att'), memberId, classroomId: ui.adminAttClassroom, date, quddas:false, ijtimaa:false, markedBy:u.id }; state.attendance.push(rec); }
      const wasOn = rec[field];
      rec[field] = !rec[field]; rec.markedBy = u.id;
      const m = state.users.find(x=>x.id===memberId);
      const ptsVal = field==='quddas' ? state.settings.pointsQuddas : state.settings.pointsIjtimaa;
      if(m){ awardPoints(m, wasOn ? -ptsVal : ptsVal, (field==='quddas'?'حضور القداس':'حضور الاجتماع'), u.name); }
      log(u.name, `سجّل حضور ${m?m.name:''} (${field==='quddas'?'القداس':'الاجتماع'}: ${rec[field]?'حاضر':'غير حاضر'})`);
      persist(); render();
    };
  });
  const openScanBtn = document.getElementById('openScanBtn');
  if(openScanBtn) openScanBtn.onclick = ()=>{ ui.scanning = true; render(); };
  const closeScanBtn = document.getElementById('closeScanBtn');
  if(closeScanBtn) closeScanBtn.onclick = ()=>{ stopScanner(); render(); };

  // ASSIGNMENTS
  const addAsgBtn = document.getElementById('addAssignmentBtn');
  if(addAsgBtn) addAsgBtn.onclick = async ()=>{
    const title = document.getElementById('asg_title').value.trim();
    if(!title){ showToast('أدخل عنوان التكليف.'); return; }
    const points = parseInt(document.getElementById('asg_points').value,10) || 0;
    const clsId = document.getElementById('asg_cls').value || null;
    const desc = document.getElementById('asg_desc').value.trim();
    const pinned = document.getElementById('asg_pinned').checked;
    const file = document.getElementById('asg_file').files[0] || null;
    const bad = validatePdf(file); if(bad){ showToast(bad); return; }
    let fileInfo = null;
    if(file){
      addAsgBtn.disabled = true; addAsgBtn.textContent = 'جاري رفع الملف...';
      try{ fileInfo = await uploadAssignmentPdf(file); }
      catch(e){ showToast(e.message); addAsgBtn.disabled = false; addAsgBtn.textContent = 'إضافة التكليف'; return; }
    }
    state.assignments.push({ id:uid('asg'), title, description: desc, points, classroomId: clsId, createdBy:u.id, createdAt: nowISO(), completions:{}, pinned, file: fileInfo });
    log(u.name, `أضاف تكليفًا جديدًا: "${title}"`); persist(); render();
  };
  document.querySelectorAll('[data-pin-asg]').forEach(b=>{ b.onclick = ()=>{ const a = state.assignments.find(x=>x.id===b.dataset.pinAsg); a.pinned = !a.pinned; log(u.name, `${a.pinned?'ثبّت':'ألغى تثبيت'} تكليف "${a.title}".`); persist(); render(); }; });
  document.querySelectorAll('[data-attach-input]').forEach(inp=>{
    inp.onchange = async ()=>{
      const a = state.assignments.find(x=>x.id===inp.dataset.attachInput);
      const file = inp.files[0]; const bad = validatePdf(file); if(bad){ showToast(bad); return; }
      showToast('جاري رفع الملف...');
      try{ const info = await uploadAssignmentPdf(file); await deleteAssignmentPdf(a.file); a.file = info; }
      catch(e){ showToast(e.message); return; }
      log(u.name, `أرفق ملف PDF بتكليف "${a.title}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-remove-file]').forEach(b=>{
    b.onclick = ()=>{ const a = state.assignments.find(x=>x.id===b.dataset.removeFile);
      askConfirm('إزالة ملف الـPDF من هذا التكليف؟', async ()=>{ await deleteAssignmentPdf(a.file); a.file = null; log(u.name, `أزال ملف PDF من تكليف "${a.title}".`); persist(); render(); }); };
  });
  document.querySelectorAll('[data-del-asg]').forEach(b=>{ b.onclick = ()=>{ const a = state.assignments.find(x=>x.id===b.dataset.delAsg); if(a) deleteAssignmentPdf(a.file); state.assignments = state.assignments.filter(x=>x.id!==b.dataset.delAsg); log(u.name,'حذف تكليفًا.'); persist(); render(); }; });
  document.querySelectorAll('[data-asg-points]').forEach(inp=>{
    inp.onchange = ()=>{ const a = state.assignments.find(x=>x.id===inp.dataset.asgPoints); a.points = parseInt(inp.value,10)||0; log(u.name, `غيّر قيمة نقاط "${a.title}" إلى ${a.points}.`); persist(); render(); };
  });
  document.querySelectorAll('[data-asg-check]').forEach(chk=>{
    chk.onchange = ()=>{
      const [asgId, memberId] = chk.dataset.asgCheck.split('|');
      const a = state.assignments.find(x=>x.id===asgId); const m = state.users.find(x=>x.id===memberId);
      if(chk.checked){ a.completions[memberId] = nowISO(); awardPoints(m, a.points, `إنجاز تكليف: ${a.title}`, u.name); log(u.name, `اعتمد إنجاز ${m.name} لتكليف "${a.title}" (+${a.points} نقطة).`); }
      else { delete a.completions[memberId]; awardPoints(m, -a.points, `إلغاء تكليف: ${a.title}`, u.name); log(u.name, `ألغى إنجاز ${m.name} لتكليف "${a.title}".`); }
      persist(); render();
    };
  });

  // POINTS
  const savePtsSettings = document.getElementById('savePointsSettings');
  if(savePtsSettings) savePtsSettings.onclick = ()=>{
    state.settings.pointsQuddas = parseInt(document.getElementById('pts_quddas').value,10)||0;
    state.settings.pointsIjtimaa = parseInt(document.getElementById('pts_ijtimaa').value,10)||0;
    log(u.name, 'عدّل قيم نقاط الحضور الافتراضية.'); persist(); showToast('تم حفظ الإعدادات.'); render();
  };
  document.querySelectorAll('[data-pts-adj]').forEach(b=>{
    b.onclick = ()=>{
      const [memberId, delta] = b.dataset.ptsAdj.split('|');
      const m = state.users.find(x=>x.id===memberId);
      awardPoints(m, parseInt(delta,10), 'تعديل يدوي', u.name);
      log(u.name, `عدّل نقاط ${m.name} (${delta>0?'+':''}${delta}).`);
      persist(); render();
    };
  });

  // CHAT
  const newChatBtn = document.getElementById('newChatBtn');
  if(newChatBtn) newChatBtn.onclick = ()=>{ const chat = { id:uid('chat'), memberId:u.id, memberName:u.name, status:'unclaimed', claimedById:null, claimedByName:null, messages:[], createdAt: nowISO() }; state.chats.push(chat); ui.openChatId = chat.id; persist(); render(); };
  document.querySelectorAll('[data-claim]').forEach(b=>{ b.onclick = ()=>{ const chat = state.chats.find(c=>c.id===b.dataset.claim); chat.status='claimed'; chat.claimedById=u.id; chat.claimedByName=u.name; log(u.name, `استلم محادثة مع ${chat.memberName}.`); ui.openChatId = chat.id; persist(); render(); }; });
  document.querySelectorAll('[data-openchat]').forEach(b=>{ b.onclick = ()=>{ ui.openChatId = b.dataset.openchat; render(); }; });
  const backBtn = document.getElementById('backToChatList'); if(backBtn) backBtn.onclick = ()=>{ ui.openChatId=null; render(); };
  const closeChatBtn = document.getElementById('closeChatBtn');
  if(closeChatBtn) closeChatBtn.onclick = ()=>{ const chat = state.chats.find(c=>c.id===ui.openChatId); chat.status='closed'; log(u.name, `أنهى المحادثة مع ${chat.memberName}.`); ui.openChatId=null; persist(); render(); };
  const sendBtn = document.getElementById('sendChatBtn');
  if(sendBtn) sendBtn.onclick = ()=>{
    const input = document.getElementById('chatInput'); const text = input.value.trim(); if(!text) return;
    const chat = state.chats.find(c=>c.id===ui.openChatId); const isMember = u.role==='makhdoum';
    chat.messages.push({ sender: isMember?'member':'admin', senderName:u.name, senderId:u.id, text, time: nowISO() });
    persist(); render();
    setTimeout(()=>{ const el=document.querySelector('.thread-msgs'); if(el) el.scrollTop = el.scrollHeight; },0);
  };

  // ADMIN
  document.querySelectorAll('[data-adminsub]').forEach(b=>{ b.onclick = ()=>{ ui.adminSub = b.dataset.adminsub; render(); }; });
  document.querySelectorAll('[data-approve]').forEach(b=>{ b.onclick = ()=>{ const p = state.users.find(x=>x.id===b.dataset.approve); const sel = document.querySelector(`[data-pending-cls="${p.id}"]`); const clsId = sel && sel.value ? sel.value : null; p.status='approved'; p.classroomId = clsId; const cls = clsId ? classroomOf(clsId) : null; if(cls) p.stageId = cls.stageId; log(u.name, cls ? `وافق على انضمام ${p.name} وعيّنه لفصل "${cls.name}".` : `وافق على انضمام ${p.name}.`); persist(); render(); }; });
  document.querySelectorAll('[data-reject]').forEach(b=>{ b.onclick = ()=>{ const p = state.users.find(x=>x.id===b.dataset.reject); p.status='rejected'; log(u.name, `رفض طلب انضمام ${p.name}.`); persist(); render(); }; });
  const addClassroomBtn = document.getElementById('addClassroomBtn');
  if(addClassroomBtn) addClassroomBtn.onclick = ()=>{
    const name = document.getElementById('newClassName').value.trim();
    const stageId = document.getElementById('newClassStage').value || null;
    if(!name){ showToast('أدخل اسم الفصل.'); return; }
    state.classrooms.push({ id:uid('cls'), name, stageId, servantIds:[] });
    log(u.name, `أضاف فصلًا جديدًا: "${name}".`); persist(); render();
  };
  const addStageBtn = document.getElementById('addStageBtn');
  if(addStageBtn) addStageBtn.onclick = ()=>{
    const name = document.getElementById('newStageName').value.trim();
    if(!name){ showToast('أدخل اسم المرحلة.'); return; }
    const sectorSel = document.getElementById('newStageSector');
    const sectorId = u.role==='super_admin' ? u.sectorId : (sectorSel ? (sectorSel.value || null) : null);
    state.stages.push({ id:uid('stg'), name, sectorId });
    log(u.name, `أضاف مرحلة جديدة: "${name}".`); persist(); render();
  };
  const addSectorBtn = document.getElementById('addSectorBtn');
  if(addSectorBtn) addSectorBtn.onclick = ()=>{
    const name = document.getElementById('newSectorName').value.trim();
    if(!name){ showToast('أدخل اسم القطاع.'); return; }
    state.sectors.push({ id:uid('sec'), name });
    log(u.name, `أضاف قطاعًا جديدًا: "${name}".`); persist(); render();
  };
  document.querySelectorAll('[data-save-sector-name]').forEach(b=>{
    b.onclick = ()=>{
      const secid = b.dataset.saveSectorName;
      const input = document.querySelector(`[data-sector-name="${secid}"]`);
      const newName = input.value.trim();
      if(!newName){ showToast('أدخل اسم القطاع.'); return; }
      const sec = sectorOf(secid); const oldName = sec.name; sec.name = newName;
      log(u.name, `غيّر اسم قطاع "${oldName}" إلى "${newName}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-del-sector]').forEach(b=>{
    b.onclick = ()=>{
      const secid = b.dataset.delSector; const sec = sectorOf(secid);
      askConfirm(`حذف قطاع "${sec.name}"؟ ستصبح مراحله بدون قطاع.`, ()=>{
        state.sectors = state.sectors.filter(x=>x.id!==secid);
        state.stages.forEach(s=>{ if(s.sectorId===secid) s.sectorId=null; });
        state.users.forEach(x=>{ if(x.role==='super_admin' && x.sectorId===secid) x.sectorId=null; });
        log(u.name, `حذف قطاع "${sec.name}".`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-stage-sector]').forEach(sel=>{
    sel.onchange = ()=>{
      const s = stageOf(sel.dataset.stageSector);
      s.sectorId = sel.value || null;
      log(u.name, `غيّر قطاع مرحلة "${s.name}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-promote-super]').forEach(b=>{
    b.onclick = ()=>{
      const k = state.users.find(x=>x.id===b.dataset.promoteSuper);
      const sel = document.querySelector(`[data-superadmin-sector="${k.id}"]`);
      const sectorId = sel.value;
      const sec = sectorOf(sectorId);
      if(!sec){ showToast('اختر قطاعًا أولًا.'); return; }
      k.role='super_admin'; k.sectorId=sectorId; k.classroomId=null;
      log(u.name, `رقّى ${k.name} إلى سوبر أدمن لقطاع "${sec.name}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-change-sector]').forEach(sel=>{
    sel.onchange = ()=>{
      const s = state.users.find(x=>x.id===sel.dataset.changeSector);
      s.sectorId = sel.value || null;
      const sec = s.sectorId ? sectorOf(s.sectorId) : null;
      log(u.name, sec ? `نقل ${s.name} لقطاع "${sec.name}".` : `أزال ${s.name} من قطاعه.`); persist(); render();
    };
  });
  document.querySelectorAll('[data-demote-super]').forEach(b=>{
    b.onclick = ()=>{
      const s = state.users.find(x=>x.id===b.dataset.demoteSuper);
      askConfirm(`تخفيض "${s.name}" إلى خادم؟`, ()=>{
        s.role='khadim'; s.sectorId=null; s.classroomId=null;
        log(u.name, `خفّض ${s.name} إلى خادم.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-save-stage-name]').forEach(b=>{
    b.onclick = ()=>{
      const sid = b.dataset.saveStageName;
      const input = document.querySelector(`[data-stage-name="${sid}"]`);
      const newName = input.value.trim();
      if(!newName){ showToast('أدخل اسم المرحلة.'); return; }
      const s = stageOf(sid); const oldName = s.name; s.name = newName;
      log(u.name, `غيّر اسم مرحلة "${oldName}" إلى "${newName}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-del-stage]').forEach(b=>{
    b.onclick = ()=>{
      const sid = b.dataset.delStage; const s = stageOf(sid);
      askConfirm(`حذف مرحلة "${s.name}"؟ ستصبح فصولها بدون مرحلة.`, ()=>{
        state.stages = state.stages.filter(x=>x.id!==sid);
        state.classrooms.forEach(c=>{ if(c.stageId===sid) c.stageId=null; });
        state.users.forEach(x=>{ if(x.stageId===sid) x.stageId=null; });
        log(u.name, `حذف مرحلة "${s.name}".`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-cls-stage]').forEach(sel=>{
    sel.onchange = ()=>{
      const c = classroomOf(sel.dataset.clsStage);
      c.stageId = sel.value || null;
      log(u.name, `غيّر مرحلة فصل "${c.name}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-reset-pw]').forEach(b=>{ b.onclick = ()=>{ ui.resetPwFor = b.dataset.resetPw; render(); }; });
  document.querySelectorAll('[data-cancel-pw]').forEach(b=>{ b.onclick = ()=>{ ui.resetPwFor = null; render(); }; });
  document.querySelectorAll('[data-save-pw]').forEach(b=>{
    b.onclick = ()=>{
      const pid = b.dataset.savePw;
      const input = document.getElementById(`newPwInput_${pid}`);
      const newPw = input.value;
      if(!newPw || newPw.length<4){ showToast('كلمة المرور يجب ألا تقل عن ٤ أحرف.'); return; }
      const p = state.users.find(x=>x.id===pid); p.password = newPw;
      log(u.name, `غيّر كلمة مرور ${p.name}.`); ui.resetPwFor=null; persist(); showToast('تم تحديث كلمة المرور.'); render();
    };
  });
  document.querySelectorAll('[data-del-cls]').forEach(b=>{
    b.onclick = ()=>{
      const cid = b.dataset.delCls; const cls = classroomOf(cid);
      askConfirm(`حذف "${cls.name}"؟ سيصبح أعضاؤه بدون فصل.`, ()=>{
        state.classrooms = state.classrooms.filter(c=>c.id!==cid);
        state.users.forEach(x=>{ if(x.classroomId===cid) x.classroomId=null; });
        log(u.name, `حذف فصل "${cls.name}".`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-cls-servant]').forEach(chk=>{
    chk.onchange = ()=>{
      const [clsId, khId] = chk.dataset.clsServant.split('|');
      const c = classroomOf(clsId); const k = state.users.find(x=>x.id===khId);
      if(chk.checked){ if(!c.servantIds.includes(khId)) c.servantIds.push(khId); log(u.name, `أضاف ${k.name} كخادم لفصل "${c.name}".`); }
      else { c.servantIds = c.servantIds.filter(id=>id!==khId); log(u.name, `أزال ${k.name} من فصل "${c.name}".`); }
      persist(); render();
    };
  });
  document.querySelectorAll('[data-save-cls-name]').forEach(b=>{
    b.onclick = ()=>{
      const cid = b.dataset.saveClsName;
      const input = document.querySelector(`[data-cls-name="${cid}"]`);
      const newName = input.value.trim();
      if(!newName){ showToast('أدخل اسم الفصل.'); return; }
      const c = classroomOf(cid); const oldName = c.name; c.name = newName;
      log(u.name, `غيّر اسم فصل "${oldName}" إلى "${newName}".`); persist(); render();
    };
  });
  document.querySelectorAll('[data-demoteadmin]').forEach(b=>{
    b.onclick = ()=>{
      const s = state.users.find(x=>x.id===b.dataset.demoteadmin);
      if(state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){ showToast('لا يمكن تخفيض مدير الكنيسة الوحيد المتبقي.'); return; }
      askConfirm(`تخفيض "${s.name}" إلى خادم؟`, ()=>{
        s.role='khadim'; s.classroomId=null;
        log(u.name, `خفّض ${s.name} إلى خادم.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-demote]').forEach(b=>{
    b.onclick = ()=>{
      const k = state.users.find(x=>x.id===b.dataset.demote);
      askConfirm(`تخفيض "${k.name}" إلى مخدوم؟ سيُزال من أي فصول يخدم فيها.`, ()=>{
        k.role='makhdoum'; k.classroomId=null;
        state.classrooms.forEach(c=>{ c.servantIds = c.servantIds.filter(id=>id!==k.id); });
        log(u.name, `خفّض ${k.name} إلى مخدوم.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-promote]').forEach(b=>{ b.onclick = ()=>{ const k = state.users.find(x=>x.id===b.dataset.promote); k.role='senior_admin'; k.classroomId=null; log(u.name, `رقّى ${k.name} إلى مدير الكنيسة.`); persist(); render(); }; });
  document.querySelectorAll('[data-promotekh]').forEach(b=>{ b.onclick = ()=>{ const m = state.users.find(x=>x.id===b.dataset.promotekh); m.role='khadim'; m.classroomId=null; log(u.name, `رقّى ${m.name} إلى خادم.`); persist(); render(); }; });
  document.querySelectorAll('[data-assign-cls]').forEach(sel=>{
    sel.onchange = ()=>{
      const m = state.users.find(x=>x.id===sel.dataset.assignCls);
      const newCls = sel.value ? classroomOf(sel.value) : null;
      m.classroomId = sel.value || null;
      log(u.name, newCls ? `عيّن ${m.name} إلى فصل "${newCls.name}".` : `أزال ${m.name} من فصله.`);
      persist(); render();
    };
  });
  document.querySelectorAll('[data-ban-user]').forEach(b=>{
    b.onclick = ()=>{
      const target = state.users.find(x=>x.id===b.dataset.banUser);
      if(target.role==='senior_admin' && state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){ showToast('لا يمكن حظر مدير الكنيسة الوحيد المتبقي.'); return; }
      askConfirm(`حظر حساب "${target.name}"؟ لن يتمكن من الدخول حتى تُلغي الحظر.`, ()=>{
        target.status='banned';
        if(state.session.userId===target.id) state.session.userId=null;
        log(u.name, `حظر حساب ${target.name}.`); persist(); render();
      });
    };
  });
  document.querySelectorAll('[data-unban-user]').forEach(b=>{
    b.onclick = ()=>{
      const target = state.users.find(x=>x.id===b.dataset.unbanUser);
      target.status='approved';
      log(u.name, `ألغى حظر حساب ${target.name}.`); persist(); render();
    };
  });
  document.querySelectorAll('[data-delete-user]').forEach(b=>{
    b.onclick = ()=>{
      const target = state.users.find(x=>x.id===b.dataset.deleteUser);
      if(target.role==='senior_admin' && state.users.filter(x=>x.role==='senior_admin'&&x.status==='approved').length<=1){ showToast('لا يمكن حذف مدير الكنيسة الوحيد المتبقي.'); return; }
      askConfirm(`حذف حساب "${target.name}" نهائيًا؟ لا يمكن التراجع عن هذا الإجراء.`, ()=>{
        state.users = state.users.filter(x=>x.id!==target.id);
        state.classrooms.forEach(c=>{ c.servantIds = c.servantIds.filter(id=>id!==target.id); });
        if(state.session.userId===target.id) state.session.userId=null;
        log(u.name, `حذف حساب ${target.name} نهائيًا.`); persist(); render();
      });
    };
  });
}

render();
// Pull the latest shared state from the database once at startup, then keep polling
// periodically so changes made by other people/devices show up here too.
initialSync();
setInterval(()=>{ if(currentUser() && !ui.scanning) render(); }, 30000);
setInterval(()=>{ if(!ui.scanning) pollRemoteState(); }, 8000);

/* ---------------- PWA: make the app installable to the home screen ---------------- */
let deferredInstallPrompt = null;
(function setupPWA(){
  try{
    const iconSvg = crestSVG(512).replace('viewBox="0 0 64 64"', 'viewBox="0 0 64 64" style="background:#5A2A27"');
    const iconDataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(iconSvg)));
    const manifest = {
      name: 'خِدمة — تطبيق مجتمع الكنيسة', short_name: 'خِدمة', start_url: './', scope: './',
      display: 'standalone', background_color: '#FBF6EE', theme_color: '#5A2A27', dir: 'rtl', lang: 'ar',
      icons: [
        { src: iconDataUrl, sizes: '512x512', type: 'image/svg+xml', purpose: 'any' },
        { src: iconDataUrl, sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
      ],
    };
    const manifestUrl = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
    const link = document.createElement('link'); link.rel = 'manifest'; link.href = manifestUrl;
    document.head.appendChild(link);
    const appleIcon = document.getElementById('appleTouchIcon'); if(appleIcon) appleIcon.href = iconDataUrl;
  }catch(e){ console.warn('PWA manifest setup failed:', e); }

  if('serviceWorker' in navigator){
    try{
      const swCode = `self.addEventListener('install', e=>self.skipWaiting()); self.addEventListener('activate', e=>self.clients.claim());`;
      const swUrl = URL.createObjectURL(new Blob([swCode], { type: 'application/javascript' }));
      navigator.serviceWorker.register(swUrl).catch(e=>console.warn('Service worker registration failed:', e));
    }catch(e){ console.warn('Service worker setup failed:', e); }
  }
})();
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
});
window.addEventListener('appinstalled', ()=>{ deferredInstallPrompt = null; showToast('تم تثبيت التطبيق بنجاح ✓'); render(); });
async function triggerInstall(){
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  } else {
    showToast('لتثبيت التطبيق: افتح قائمة المتصفح واختر "إضافة إلى الشاشة الرئيسية".');
  }
}

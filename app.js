/* 이포트텍 ERP - 1인 기업용 PWA. 데이터는 이 기기(IndexedDB)에 저장, 원하면 구글 시트로 백업/동기화 */
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const won = n => (Math.round(n || 0)).toLocaleString('ko-KR');
const man = n => { n = n || 0; if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '억'; if (Math.abs(n) >= 1e4) return Math.round(n / 1e4).toLocaleString('ko-KR') + '만'; return won(n); };
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const ymOf = d => d.slice(0, 7);
const ymAdd = (ym, k) => { let [y, m] = ym.split('-').map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return y + '-' + String(m).padStart(2, '0'); };
const ymLabel = ym => { const [y, m] = ym.split('-'); return `${y}년 ${Number(m)}월`; };
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const normName = s => String(s || '').replace(/\(주\)|㈜|주식회사|\(재\)|\(유\)|유한회사|\(사\)|재단법인|[\s()\[\]]/g, '').toLowerCase();
const EVENT_TYPES = ['정기점검', '원격점검', '장애처리', '긴급출동', '부품교체', '설치·이전', '기술지원', '기타'];
const INSPECT_TYPES = ['정기점검', '원격점검'];

/* ---------------- 저장소 ---------------- */
let DB = null;
const IDB = {
  open() { return new Promise((ok, no) => { const r = indexedDB.open('eporttech-erp', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); },
  async get(k) { const db = await this.open(); return new Promise(ok => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => ok(t.result); t.onerror = () => ok(null); }); },
  async set(k, v) { const db = await this.open(); return new Promise(ok => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => ok(); }); }
};
function blankDB() { return { version: 1, settings: { company: '이포트텍', bizNo: '599-01-01772', arStart: '2026-09-01', syncUrl: '', syncToken: '', owner: '', tel: '', email: '', address: '' }, sites: [], invoices: [], events: [], parts: [], deposits: [], manualPaid: {}, orders: [], changes: [], mailSeen: [], quotes: [], billReqs: [], contacts: [], log: [], dunning: {} }; }
async function save() { diffLog(); DB.updated = new Date().toISOString(); await IDB.set('db', DB); invalidate(); schedulePush(); }
async function persist() { await IDB.set('db', DB); invalidate(); } // 동기화 표시만 바꿀 때 (변경으로 치지 않음)

/* ---------------- 자동 동기화: 고치면 몇 초 뒤 시트로 올리고, 앱을 열거나 다시 보면 시트의 새 자료를 받음 ---------------- */
const syncReady = () => !!(DB && DB.settings.syncUrl && DB.settings.syncToken);
const isDirty = () => (DB.updated || '') > (DB.settings.lastSync || '');
let _pushT = null, _pushing = false, _pulling = false;
function schedulePush() { if (!syncReady()) return; clearTimeout(_pushT); _pushT = setTimeout(autoPush, 3000); }
async function pushNow() {
  const s = DB.settings, u = DB.updated; const { syncUrl, syncToken, lastSync, ...rest } = s;
  const r = await fetch(s.syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: syncToken, data: { ...DB, settings: rest, cal: s.calSync === false ? null : calItems() } }) });
  const j = await r.json(); if (!j.ok) throw new Error(j.error || '실패');
  s.lastSync = u; await persist(); syncBadge();
}
async function autoPush() {
  if (!syncReady() || !isDirty() || !navigator.onLine) { syncBadge(); return; }
  if (_pushing) { schedulePush(); return; }
  _pushing = true; syncBadge('올리는 중');
  try { await pushNow(); } catch (e) { syncBadge('동기화 실패'); setTimeout(autoPush, 30000); } finally { _pushing = false; }
}
async function autoPull() {
  if (!syncReady() || !navigator.onLine || _pulling || _pushing) return;
  const first = !DB.settings.lastSync; // 이 기기를 처음 연결했으면 시트 자료가 기준
  if (isDirty() && !first) { await autoPush(); return; } // 이 기기에서 고친 게 먼저
  _pulling = true; syncBadge('확인 중');
  try {
    const s = DB.settings; const r = await fetch(s.syncUrl + (s.syncUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(s.syncToken)); const j = await r.json(); if (!j.ok) throw new Error(j.error || '실패');
    const d = j.data;
    if (d && (first || ((d.updated || '') > (DB.updated || '') && !isDirty()))) {
      const keep = { syncUrl: s.syncUrl, syncToken: s.syncToken, lastSync: d.updated };
      DB = Object.assign(blankDB(), d); DB.settings = Object.assign(blankDB().settings, d.settings, keep); _snap = null; diffLog(); await persist();
      const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (!typing && document.getElementById('modal').classList.contains('hidden')) render(); toast('다른 기기에서 바꾼 내용을 받았습니다');
    } else if (!d) { if (!DB.updated) DB.updated = new Date().toISOString(); DB.settings.lastSync = ''; await autoPush(); }
    syncBadge();
  } catch (e) { syncBadge('동기화 실패'); } finally { _pulling = false; }
  await pullInbox(true);
}
function syncBadge(msg) {
  const b = document.getElementById('syncBadge'); if (!b) return;
  if (!syncReady()) { b.textContent = ''; return; }
  b.textContent = msg || (!navigator.onLine ? '오프라인' : isDirty() ? '올릴 내용 있음' : '동기화됨');
  b.className = 'sync-badge' + (msg === '동기화 실패' ? ' bad' : '');
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') autoPull(); else if (isDirty()) autoPush(); });
window.addEventListener('online', () => autoPull());
setInterval(() => { if (document.visibilityState === 'visible') autoPull(); }, 60000);
let _cache = null; const invalidate = () => { _cache = null; };

/* ---------------- 계산 ---------------- */
function siteForInvoice(inv) {
  if (inv.siteId) return DB.sites.find(s => s.id === inv.siteId) || null;
  if (inv.kind !== '매출') return null; // 매입은 직접 연결한 것만 (사이트 원가)
  let best = null, bestLen = 0; const it = (inv.item || '').toLowerCase();
  for (const s of DB.sites) {
    const bizOk = s.bizNo ? s.bizNo === inv.bizNo : normName(inv.name).includes(normName(s.client));
    if (!bizOk || !s.keyword) continue;
    // 단어 여러 개는 | 또는 , 로 구분 (예: 해병대|해군|계룡대)
    for (const k of String(s.keyword).split(/[|,]/).map(x => x.trim().toLowerCase()).filter(Boolean)) if (it.includes(k) && k.length > bestLen) { best = s; bestLen = k.length; }
  }
  return best;
}
// 서비스 월: 매월 계약은 품목명의 "N월"을 우선, 분기/후불 계약은 작성월
function periodOf(inv, site) {
  const ym = ymOf(inv.date);
  if (site && site.billMonths && site.billMonths.length) return ym;
  const m = inv.item.match(/(\d{1,2})\s*월/);
  if (!m) return ym;
  const n = Number(m[1]); if (n < 1 || n > 12) return ym;
  let [y, mo] = ym.split('-').map(Number);
  if (n > mo + 1) y -= 1; // 예: 1월에 12월분 발행
  return y + '-' + String(n).padStart(2, '0');
}
function calc() {
  if (_cache) return _cache;
  const c = { siteOf: {}, period: {}, cancelled: new Set(), paidBy: {}, bySite: {} };
  const sales = DB.invoices.filter(i => i.kind === '매출');
  for (const i of sales) { const s = siteForInvoice(i); c.siteOf[i.id] = s ? s.id : null; c.period[i.id] = periodOf(i, s); if (s) (c.bySite[s.id] = c.bySite[s.id] || []).push(i); }
  c.costBySite = {}; for (const i of DB.invoices) if (i.kind === '매입' && i.siteId) { c.siteOf[i.id] = i.siteId; (c.costBySite[i.siteId] = c.costBySite[i.siteId] || []).push(i); }
  // 수정(마이너스) 계산서와 원래 계산서를 짝지어 미수금에서 제외
  const negs = sales.filter(i => i.supply < 0);
  for (const n of negs) {
    const cand = sales.filter(p => p.supply === -n.supply && p.bizNo === n.bizNo && p.date <= n.date && !c.cancelled.has(p.id)).sort((a, b) => (b.item === n.item) - (a.item === n.item) || b.date.localeCompare(a.date));
    c.cancelled.add(n.id); if (cand[0]) c.cancelled.add(cand[0].id);
  }
  for (const d of DB.deposits) for (const id of (d.invIds || [])) c.paidBy[id] = { date: d.date, dep: d.id };
  c.credit = {}; for (const d of DB.deposits) if (d.prepaid) c.credit[d.id] = d.amount - (d.invIds || []).reduce((a, id) => a + ((DB.invoices.find(i => i.id === id) || {}).total || 0), 0);
  for (const [id, dt] of Object.entries(DB.manualPaid || {})) if (!c.paidBy[id]) c.paidBy[id] = { date: dt, manual: true };
  _cache = c; return c;
}
const isAdhoc = s => /^수시/.test(s.cycle || '');
const siteActiveIn = (s, ym) => s.active !== false && !s.old && !isAdhoc(s) && (!s.startMonth || ym >= s.startMonth);
const billExpected = (s, ym) => siteActiveIn(s, ym) && Number(s.amount) > 0 && (!s.billMonths || !s.billMonths.length || s.billMonths.includes(Number(ym.slice(5))));
const inspectExpected = (s, ym) => siteActiveIn(s, ym) && (!s.inspectMonths || !s.inspectMonths.length || s.inspectMonths.includes(Number(ym.slice(5))));
function billingStatus(ym) {
  const c = calc();
  return DB.sites.filter(s => billExpected(s, ym)).map(s => {
    const invs = (c.bySite[s.id] || []).filter(i => c.period[i.id] === ym);
    const net = invs.reduce((a, i) => a + i.supply, 0);
    return { site: s, invs, net, done: net > 0 };
  });
}
function inspectStatus(ym) {
  const c = calc();
  return DB.sites.filter(s => inspectExpected(s, ym)).map(s => {
    const ev = DB.events.filter(e => e.siteId === s.id && ymOf(e.date) === ym && INSPECT_TYPES.includes(e.type)).sort((a, b) => a.date.localeCompare(b.date));
    const plan = ym + '-' + String(Math.min(s.visitDay || 25, 28)).padStart(2, '0');
    // 점검 기록이 없어도 그 달 서비스분 계산서가 나갔으면 점검한 것으로 봄
    const byInv = !ev.length && (c.bySite[s.id] || []).some(i => c.period[i.id] === ym && i.supply > 0 && !c.cancelled.has(i.id));
    const done = ev.length > 0 || byInv;
    return { site: s, ev, done, byInv, plan, late: !done && todayStr() > plan };
  }).sort((a, b) => a.done - b.done || a.plan.localeCompare(b.plan));
}
function receivables() {
  const c = calc(), start = DB.settings.arStart || '2000-01-01';
  return DB.invoices.filter(i => i.kind === '매출' && i.date >= start && i.total > 0 && !c.cancelled.has(i.id) && !c.paidBy[i.id])
    .map(i => ({ inv: i, age: daysBetween(i.date, todayStr()) })).sort((a, b) => a.inv.date.localeCompare(b.inv.date));
}
function salesByMonth(year) {
  const r = {}; for (let m = 1; m <= 12; m++) r[year + '-' + String(m).padStart(2, '0')] = 0;
  for (const i of DB.invoices) if (i.kind === '매출' && i.date.startsWith(year)) r[ymOf(i.date)] += i.supply;
  return r;
}
function expectedOfMonth(ym) { return DB.sites.filter(s => billExpected(s, ym)).reduce((a, s) => a + (s.amount || 0), 0); }

/* ---------------- 화면 공통 ---------------- */
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2600); }
function openSheet(html) { $('#sheet').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeSheet() { $('#modal').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeSheet(); });
function pickFile(accept) { return new Promise(ok => { const p = $('#filePicker'); p.value = ''; p.accept = accept || ''; p.onchange = () => ok(p.files[0] || null); p.click(); }); }
function download(name, text, type) { const b = new Blob([text], { type: type || 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
const siteName = id => (DB.sites.find(s => s.id === id) || {}).name || '-';
const row = (l, sub, r, attrs = '') => `<div class="row ${attrs ? 'click' : ''}" ${attrs}><div class="l"><b>${l}</b>${sub ? `<small>${sub}</small>` : ''}</div><div class="r">${r ?? ''}</div></div>`;

// 간단 폼: fields=[{k,label,type,options,value}]
function formSheet(title, fields, onSave, extraBtns = '') {
  const f = fields.map(x => {
    const v = x.value ?? '';
    if (x.type === 'select') return `<label class="f">${x.label}<select name="${x.k}">${x.options.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select></label>`;
    if (x.type === 'textarea') return `<label class="f">${x.label}<textarea name="${x.k}">${esc(v)}</textarea></label>`;
    if (x.type === 'check') return `<label class="f"><input class="chk" type="checkbox" name="${x.k}" ${v ? 'checked' : ''}>${x.label}</label>`;
    return `<label class="f">${x.label}<input name="${x.k}" type="${x.type || 'text'}" value="${esc(v)}" ${x.ph ? `placeholder="${esc(x.ph)}"` : ''} ${x.type === 'number' ? 'inputmode="numeric"' : ''}></label>`;
  }).join('');
  openSheet(`<h2>${title}</h2><form id="fm">${f}<div class="btns"><button class="btn" type="submit">저장</button><button class="btn ghost" type="button" onclick="closeSheet()">닫기</button>${extraBtns}</div></form>`);
  $('#fm').onsubmit = async e => {
    e.preventDefault(); const o = {};
    for (const x of fields) { const el = $('#fm').elements[x.k]; o[x.k] = x.type === 'check' ? el.checked : x.type === 'number' ? Number(String(el.value).replace(/,/g, '')) || 0 : el.value.trim(); }
    if (await onSave(o) !== false) { closeSheet(); await save(); render(); }
  };
}

/* ---------------- 홈 ---------------- */
function viewHome() {
  const ym = ymOf(todayStr()), y = ym.slice(0, 4);
  const ins = inspectStatus(ym), bill = billingStatus(ym), ar = receivables();
  const insDone = ins.filter(x => x.done).length, billDone = bill.filter(x => x.done);
  const billLeft = bill.filter(x => !x.done), arSum = ar.reduce((a, x) => a + x.inv.total, 0);
  const low = DB.parts.filter(p => (p.qty || 0) <= (p.minQty || 0));
  const soon = DB.sites.filter(s => s.active !== false && s.endMonth && s.endMonth <= ymAdd(ym, 2));
  const sm = salesByMonth(y); const ytd = Object.values(sm).reduce((a, b) => a + b, 0);
  let rest = 0; const curNet = bill.reduce((a, x) => a + Math.max(0, x.net), 0);
  rest += Math.max(0, expectedOfMonth(ym) - curNet);
  for (let k = 1; ymAdd(ym, k).startsWith(y); k++) rest += expectedOfMonth(ymAdd(ym, k));
  setBadge();
  return `${todayCard()}
  <div class="grid4">
    <div class="stat" onclick="go('#schedule')"><div class="k">${Number(ym.slice(5))}월 점검</div><div class="v ${insDone < ins.length ? 'org' : 'grn'}">${insDone}/${ins.length}</div><div class="s">${ins.filter(x => x.late).length ? '미점검 ' + ins.filter(x => x.late).length + '곳' : '남은 점검 ' + (ins.length - insDone) + '곳'}</div></div>
    <div class="stat" onclick="go('#invoices')"><div class="k">${Number(ym.slice(5))}월 계산서</div><div class="v ${billLeft.length ? 'org' : 'grn'}">${billDone.length}/${bill.length}</div><div class="s">미발행 ${man(billLeft.reduce((a, x) => a + x.site.amount, 0))}원</div></div>
    <div class="stat" onclick="go('#ar')"><div class="k">미수금</div><div class="v ${ar.length ? 'red' : 'grn'}">${man(arSum)}</div><div class="s">${ar.length}건 (부가세 포함)</div></div>
    <div class="stat" onclick="go('#parts')"><div class="k">재고 부족</div><div class="v ${low.length ? 'red' : ''}">${low.length}</div><div class="s">품목 ${DB.parts.length}개</div></div>
  </div>
  ${dunCard()}
  ${homeMailCards()}
  ${warrantyCard()}
  <div class="card" style="margin-top:12px"><h3>${y}년 매출 <a href="#invoices/forecast">자세히</a></h3>
    <div class="kv"><div>실제 발행</div><div><b>${won(ytd)}</b>원</div><div>남은 예상</div><div>${won(rest)}원 (정기 유지보수)</div><div>연말 예상</div><div><b>${won(ytd + rest)}</b>원</div></div></div>
  <div class="card"><h3>이번 달 아직 점검 안 한 사이트 <a href="#schedule">일정</a></h3>
    ${ins.filter(x => !x.done).slice(0, 8).map(x => row(esc(x.site.name), `${esc(x.site.client)} · 예정 ${x.plan.slice(5)} · ${esc(x.site.inspect || '방문')}`, x.late ? '<span class="badge red">지남</span>' : '<span class="badge">예정</span>', `onclick="quickInspect('${x.site.id}')"`)).join('') || '<div class="empty">모두 점검했습니다 👍</div>'}
    <div class="note">사이트를 누르면 바로 점검 완료로 기록됩니다.</div></div>
  <div class="card"><h3>이번 달 발행할 계산서 <a href="#invoices">계산서</a></h3>
    ${billLeft.map(x => { const rq = reqFor(x.site.id, ym); return row(`${esc(x.site.name)} ${rq ? '<span class="badge blue">발행요청</span>' : ''}`, `${esc(x.site.client)} · ${esc(billItemFor(x.site, ym))}`, `${won(x.site.amount)}<br><button class="btn sm ${rq ? 'ghost' : ''}" onclick="event.stopPropagation();billPrep({siteId:'${x.site.id}',ym:'${ym}'})">${rq ? '요청 수정' : '발행 준비'}</button>`, `onclick="go('#site/${x.site.id}')"`); }).join('') || '<div class="empty">모두 발행했습니다 👍</div>'}</div>
  ${soon.length ? `<div class="card"><h3>계약 만료·갱신 확인</h3>${soon.map(s => row(esc(s.name), esc(s.contract), `<span class="badge ${s.endMonth < ym ? 'red' : 'org'}">${s.endMonth < ym ? '지남' : '임박'} ${s.endMonth}</span>`, `onclick="go('#site/${s.id}')"`)).join('')}</div>` : ''}
  ${ar.length ? `<div class="card"><h3>오래된 미수금 <a href="#ar">전체</a></h3>${ar.slice(0, 5).map(x => row(esc(x.inv.name), `${x.inv.date} · ${esc(x.inv.item)}`, `${won(x.inv.total)}<br><small class="${x.age > 60 ? 'red' : 'sub'}">${x.age}일</small>`)).join('')}</div>` : ''}
  `;
}
async function quickInspect(siteId) {
  const s = DB.sites.find(x => x.id === siteId);
  eventForm({ siteId, date: todayStr(), type: s.inspect === '원격' ? '원격점검' : '정기점검', title: `${Number(todayStr().slice(5, 7))}월 정기점검` });
}

/* ---------------- 일정 ---------------- */
let schedYM = null;
function viewSchedule() {
  const ym = schedYM || ymOf(todayStr());
  const ins = inspectStatus(ym);
  const others = DB.events.filter(e => ymOf(e.date) === ym).sort((a, b) => b.date.localeCompare(a.date));
  const done = ins.filter(x => x.done).length;
  return `
  <div class="monthnav"><button onclick="schedYM='${ymAdd(ym, -1)}';render()">◀</button>${ymLabel(ym)}<button onclick="schedYM='${ymAdd(ym, 1)}';render()">▶</button></div>
  <div class="card"><h3>정기점검 ${done}/${ins.length} <span class="sub" style="font-size:12px;font-weight:400">${Math.round(done / (ins.length || 1) * 100)}%</span></h3>
    <div class="bar"><i style="width:${done / (ins.length || 1) * 100}%"></i></div>
    ${ins.map(x => row(`${esc(x.site.name)} ${x.done ? (x.byInv ? '<span class="badge grn">완료(계산서)</span>' : '<span class="badge grn">완료</span>') : x.late ? '<span class="badge red">미점검</span>' : '<span class="badge">예정</span>'}`,
      x.done ? `${x.ev.map(e => e.date.slice(5) + ' ' + esc(e.type)).join(', ')}` : `예정일 ${x.plan.slice(5)} · ${esc(x.site.inspect || '방문')} · ${esc(x.site.client)}`,
      x.done ? '' : `<button class="btn sm grn" onclick="event.stopPropagation();eventForm({siteId:'${x.site.id}',date:'${ym === ymOf(todayStr()) ? todayStr() : x.plan}',type:'${x.site.inspect === '원격' ? '원격점검' : '정기점검'}',title:'${Number(ym.slice(5))}월 정기점검'})">완료</button> <a class="btn sm ghost" target="_blank" onclick="event.stopPropagation()" href="${gcalUrl(x.site, x.plan)}">캘린더</a>`,
      `onclick="go('#site/${x.site.id}')"`)).join('') || '<div class="empty">점검 대상 사이트가 없습니다</div>'}
  </div>
  <div class="card"><h3>이 달의 작업 기록 <a href="javascript:eventForm({date:'${todayStr()}'})">+ 기록</a></h3>
    ${others.map(e => row(`${esc(siteName(e.siteId))} <span class="badge blue">${esc(e.type)}</span>`, `${e.date} · ${esc(e.title || '')}${e.partId ? ' · 부품 ' + esc(partName(e.partId)) + ' ×' + e.partQty : ''}`, '', `onclick="eventForm(DB.events.find(x=>x.id==='${e.id}'))"`)).join('') || '<div class="empty">기록 없음</div>'}
  </div>
  <div class="btns"><button class="btn ghost" onclick="downloadICS()">앞으로 3개월 일정 캘린더 파일(.ics)</button></div>
  <div class="note">구글 시트 연결 시 점검 예정·발주 납기·앞으로의 작업 기록이 구글 캘린더에 자동으로 올라갑니다(설정에서 끌 수 있음). “캘린더”를 누르면 한 건씩 직접 추가됩니다. 점검 예정일은 사이트 정보의 ‘점검 예정일(매월 며칠)’로 바꿀 수 있습니다.</div>`;
}
function gcalUrl(s, date) {
  const d = date.replace(/-/g, ''); const n = new Date(date); n.setDate(n.getDate() + 1);
  const e = n.getFullYear() + String(n.getMonth() + 1).padStart(2, '0') + String(n.getDate()).padStart(2, '0');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(`[점검] ${s.name}`) + '&dates=' + d + '/' + e + '&details=' + encodeURIComponent(`${s.client} · ${s.equipment || ''}\n${s.note || ''}`);
}
function eventForm(e) {
  e = e || {}; const isNew = !e.id;
  const opts = [['', '(사이트 선택)'], ...DB.sites.map(s => [s.id, s.name])];
  const popts = [['', '(사용 부품 없음)'], ...DB.parts.map(p => [p.id, `${p.name} (재고 ${p.qty})`])];
  formSheet(isNew ? '작업 기록 추가' : '작업 기록 수정', [
    { k: 'siteId', label: '사이트', type: 'select', options: opts, value: e.siteId },
    { k: 'date', label: '날짜', type: 'date', value: e.date || todayStr() },
    { k: 'type', label: '종류', type: 'select', options: EVENT_TYPES, value: e.type || '정기점검' },
    { k: 'title', label: '제목', value: e.title, ph: '예: 11월 정기점검, 디스크 장애 교체' },
    { k: 'memo', label: '내용', type: 'textarea', value: e.memo, ph: '점검 결과, 장애 원인, 조치 내용' },
    { k: 'partId', label: '사용한 부품 (재고에서 빠짐)', type: 'select', options: popts, value: e.partId },
    { k: 'partQty', label: '부품 수량', type: 'number', value: e.partQty || 1 },
    ...(allAssets().length ? [{ k: 'assetId', label: '대상 장비 (장비 대장)', type: 'select', options: [['', '(선택 안 함)'], ...allAssets().filter(x => !e.siteId || x.site.id === e.siteId).map(x => [x.a.id, `${x.site.name} · ${assetLabel(x.a)}`])], value: e.assetId }] : []),
  ], o => {
    if (!o.siteId) { toast('사이트를 선택하세요'); return false; }
    if (!o.partId) o.partQty = 0;
    // 재고 반영: 이전 사용분 되돌리고 새로 차감
    if (!isNew && e.partId) { const p = DB.parts.find(x => x.id === e.partId); if (p) p.qty += e.partQty || 0; }
    if (o.partId) { const p = DB.parts.find(x => x.id === o.partId); if (p) { p.qty -= o.partQty; (p.log = p.log || []).push({ date: o.date, qty: -o.partQty, memo: `${siteName(o.siteId)} ${o.title}` }); } }
    if (isNew) DB.events.push({ id: uid('e'), ...o }); else Object.assign(e, o);
    toast('저장했습니다');
  }, isNew ? '' : `<button class="btn red" type="button" onclick="delEvent('${e.id}')">삭제</button>`);
}
async function delEvent(id) {
  if (!confirm('이 기록을 삭제할까요?')) return;
  const e = DB.events.find(x => x.id === id);
  if (e && e.partId) { const p = DB.parts.find(x => x.id === e.partId); if (p) p.qty += e.partQty || 0; }
  DB.events = DB.events.filter(x => x.id !== id); closeSheet(); await save(); render();
}

/* ---------------- 사이트 ---------------- */
let siteQ = '';
function viewSites() {
  const ym = ymOf(todayStr()); const c = calc();
  const all = DB.sites.filter(s => !siteQ || (s.name + s.client + s.equipment + s.note).toLowerCase().includes(siteQ.toLowerCase()));
  const list = all.filter(s => !s.old), olds = all.filter(s => s.old).map(s => { const iv = (c.bySite[s.id] || []).filter(i => i.supply > 0).sort((a, b) => a.date.localeCompare(b.date)); return { s, iv, from: iv.length ? iv[0].date.slice(0, 7) : '', to: iv.length ? iv[iv.length - 1].date.slice(0, 7) : '', sum: iv.reduce((a, i) => a + i.supply, 0) }; }).sort((a, b) => b.to.localeCompare(a.to) || b.sum - a.sum);
  const ins = Object.fromEntries(inspectStatus(ym).map(x => [x.site.id, x]));
  const total = DB.sites.filter(s => s.active !== false && !s.old).reduce((a, s) => a + (s.billMonths && s.billMonths.length ? s.amount * s.billMonths.length / 12 : s.amount), 0);
  return sitesSeg('sites') + `<div class="toolbar"><input id="siteQ" placeholder="사이트·업체·장비 검색" value="${esc(siteQ)}" oninput="siteQ=this.value;render(true)"><button class="btn" onclick="siteForm()">+ 사이트</button></div>
  <div class="card"><h3>유지보수 사이트 ${DB.sites.filter(s => s.active !== false && !s.old).length}곳 <span class="sub" style="font-size:12px;font-weight:400">월 환산 ${won(total)}원</span></h3>
  ${list.map(s => {
    const last = (c.bySite[s.id] || []).filter(i => i.supply > 0).sort((a, b) => b.date.localeCompare(a.date))[0];
    const st = ins[s.id];
    return row(`${esc(s.name)} ${s.active === false ? '<span class="badge">종료</span>' : st ? (st.done ? '<span class="badge grn">점검완료</span>' : '<span class="badge org">미점검</span>') : ''}`,
      `${esc(s.client)} · ${esc(s.cycle)}${last ? ' · 최근 발행 ' + last.date.slice(2) : ''}`, isAdhoc(s) ? `<small class="sub">올해</small> ${won((c.bySite[s.id] || []).filter(i => i.date.startsWith(ym.slice(0, 4))).reduce((a, i) => a + i.supply, 0))}` : won(s.amount), `onclick="go('#site/${s.id}')"`);
  }).join('') || '<div class="empty">사이트가 없습니다</div>'}</div>
  ${olds.length ? `<details class="card" ${siteQ ? 'open' : ''}><summary><h3 style="display:inline">지난 유지보수 (old) ${olds.length}곳 <span class="sub" style="font-size:12px;font-weight:400">누적 ${won(olds.reduce((a, x) => a + x.sum, 0))}원</span></h3></summary>
  ${olds.map(x => row(`${esc(x.s.name)} <span class="badge">old</span>`, `${esc(x.s.client)} · ${x.from.replace('-', '.')}~${x.to.replace('-', '.')} · ${x.iv.length}건`, won(x.sum), `onclick="go('#site/${x.s.id}')"`)).join('')}</details>` : ''}`;
}
function viewSite(id) {
  const s = DB.sites.find(x => x.id === id); if (!s) return '<div class="empty">없는 사이트</div>';
  const c = calc();
  const invs = (c.bySite[id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const evs = DB.events.filter(e => e.siteId === id);
  const costs = (c.costBySite[id] || []).slice();
  const items = [...costs.map(i => ({ d: i.date, h: `<div class="it inv"><b>매입</b> ${esc(i.item)} <span class="red">-${won(i.supply)}원</span><br><small>${i.date} · ${esc(i.name)}</small></div>`, click: `invDetail('${i.id}')` })),...evs.map(e => ({ d: e.date, h: `<div class="it"><b>${esc(e.type)}</b> ${esc(e.title || '')}<br><small>${e.date}${e.memo ? ' · ' + esc(e.memo) : ''}${e.partId ? ' · 부품 ' + esc(partName(e.partId)) + ' ×' + e.partQty : ''}${e.assetId && assetById(e.assetId) ? ' · 장비 ' + esc(assetLabel(assetById(e.assetId))) : ''}</small></div>`, click: `eventForm(DB.events.find(x=>x.id==='${e.id}'))` })),
    ...invs.map(i => ({ d: i.date, h: `<div class="it inv"><b>계산서</b> ${esc(i.item)} <span class="${i.supply < 0 ? 'red' : ''}">${won(i.supply)}원</span><br><small>${i.date} · ${esc(i.name)} · ${c.cancelled.has(i.id) ? '수정/취소' : c.paidBy[i.id] ? '입금 ' + c.paidBy[i.id].date : (i.date >= DB.settings.arStart ? '<span class="red">미입금</span>' : '')}</small></div>` }))]
    .sort((a, b) => b.d.localeCompare(a.d));
  const yr = todayStr().slice(0, 4); const yrSum = invs.filter(i => i.date.startsWith(yr)).reduce((a, i) => a + i.supply, 0);
  const pf = siteProfit(s, yr);
  const ar = receivables().filter(x => c.siteOf[x.inv.id] === id);
  return `<div class="btns"><a class="btn ghost sm" href="#sites">← 목록</a></div>
  <div class="card"><h3>${esc(s.name)} <a href="javascript:siteForm(DB.sites.find(x=>x.id==='${id}'))">수정</a></h3>
  <div class="kv">
    <div>발행처</div><div>${esc(s.client)} ${s.bizNo ? `<small class="sub">${esc(s.bizNo)}</small>` : ''}</div>
    <div>금액·주기</div><div>${won(s.amount)}원 · ${esc(s.cycle)}${s.billMonths && s.billMonths.length ? ` (${s.billMonths.join('·')}월)` : ''}</div>
    <div>계약</div><div>${esc(s.contract || '-')}</div>
    <div>점검</div><div>${esc(s.inspect || '방문')} · 매월 ${s.visitDay || 25}일경</div>
    <div>장비</div><div>${esc(s.equipment || '-')}</div>
    <div>담당자</div><div>${esc(s.contact || '-')}</div>
    <div>메모</div><div>${esc(s.note || '-')}</div>
    <div>${yr}년 매출</div><div><b>${won(yrSum)}</b>원 · 미수 ${won(ar.reduce((a, x) => a + x.inv.total, 0))}원</div>
    <div>${yr}년 원가</div><div>${won(pf.cost)}원 <small class="sub">(매입 ${won(pf.buy)} + 부품 ${won(pf.parts)})</small></div>
    <div>${yr}년 이익</div><div class="${pf.profit < 0 ? 'red' : 'grn'}"><b>${won(pf.profit)}</b>원${pf.sales ? ` (${Math.round(pf.profit / pf.sales * 100)}%)` : ''}</div>
    ${s.itemTpl ? `<div>품목명 틀</div><div>${esc(s.itemTpl)}</div>` : ''}
  </div>
  <div class="btns"><button class="btn grn" onclick="quickInspect('${id}')">점검 완료 기록</button><button class="btn ghost" onclick="eventForm({siteId:'${id}',type:'장애처리',date:'${todayStr()}'})">장애·출동 기록</button>${s.amount > 0 || isAdhoc(s) ? `<button class="btn ghost" onclick="billPrep({siteId:'${id}'})">계산서 발행 준비</button>` : ''}</div></div>
  ${assetCard(s)}
  <div class="card"><h3>히스토리 <span class="sub" style="font-size:12px;font-weight:400">작업 ${evs.length} · 계산서 ${invs.length}${costs.length ? ' · 매입 ' + costs.length : ''}</span></h3>
  <div class="tl">${items.slice(0, 80).map(x => x.click ? `<div onclick="${x.click}" style="cursor:pointer">${x.h}</div>` : x.h).join('') || '<div class="empty">기록 없음</div>'}</div></div>`;
}
function siteForm(s) {
  s = s || { active: true, visitDay: 25, inspect: '방문', cycle: '매월', billMonths: [], inspectMonths: [] }; const isNew = !s.id;
  formSheet(isNew ? '사이트 추가' : '사이트 수정', [
    { k: 'name', label: '사이트 이름 (최종 고객)', value: s.name },
    { k: 'client', label: '계산서 발행처 (중간업체)', value: s.client },
    { k: 'bizNo', label: '발행처 사업자번호', value: s.bizNo, ph: '000-00-00000' },
    { k: 'keyword', label: '계산서 품목명에 들어가는 단어 (자동 대조용, 여러 개는 | 로 구분)', value: s.keyword, ph: '예: 경기대  또는  해병대|해군|계룡대' },
    { k: 'amount', label: '1회 발행 금액 (공급가액)', type: 'number', value: s.amount },
    { k: 'cycle', label: '주기 (수시 = 정기 계약 없이 기술지원만)', type: 'select', options: ['매월', '분기', '반기', '3개월 후불', '연간', '수시', '기타'], value: s.cycle },
    { k: 'itemTpl', label: '계산서 품목명 틀 (비우면 지난 계산서 품목명에서 달만 바꿈)', value: s.itemTpl, ph: '예: {사이트} {월}월 정기점검  ·  {0월}=05월, {분기}, {년}' },
    { k: 'billMonths', label: '발행하는 달 (매월이면 비워두기, 예: 3,6,9,12)', value: (s.billMonths || []).join(',') },
    { k: 'startMonth', label: '시작 월 (예: 2026-08)', value: s.startMonth },
    { k: 'contract', label: '계약 기간 메모', value: s.contract },
    { k: 'endMonth', label: '계약 종료 월 (만료 알림용, 예: 2026-12)', value: s.endMonth },
    { k: 'inspect', label: '점검 방식', type: 'select', options: ['방문', '원격'], value: s.inspect },
    { k: 'visitDay', label: '점검 예정일 (매월 며칠)', type: 'number', value: s.visitDay },
    { k: 'inspectMonths', label: '점검하는 달 (매월이면 비워두기)', value: (s.inspectMonths || []).join(',') },
    { k: 'equipment', label: '장비 목록', type: 'textarea', value: s.equipment, ph: '예: HP Nimble CS1000, SUN 스토리지, 스위치' },
    { k: 'contact', label: '담당자·연락처', value: s.contact },
    { k: 'note', label: '메모', type: 'textarea', value: s.note },
    { k: 'active', label: '유지보수 진행 중', type: 'check', value: s.active !== false },
  ], o => {
    const months = v => String(v).split(/[,\s·]+/).map(Number).filter(n => n >= 1 && n <= 12);
    o.billMonths = months(o.billMonths); o.inspectMonths = months(o.inspectMonths);
    if (!o.name) { toast('이름을 입력하세요'); return false; }
    if (isNew) DB.sites.push({ id: uid('s'), ...o }); else Object.assign(s, o);
    toast('저장했습니다');
  });
}

/* ---------------- 계산서 ---------------- */
let invYM = null, invTab = 'month', invQ = '', invKind = '매출';
function viewInvoices(sub) {
  if (sub) invTab = sub;
  const seg = `<div class="seg"><a href="#invoices/month" class="${invTab === 'month' ? 'on' : ''}">월별 발행</a><a href="#invoices/req" class="${invTab === 'req' ? 'on' : ''}">발행요청${pendingReqs().length ? ' ' + pendingReqs().length : ''}</a><a href="#invoices/list" class="${invTab === 'list' ? 'on' : ''}">전체 목록</a><a href="#invoices/pl" class="${invTab === 'pl' ? 'on' : ''}">매출·매입</a><a href="#invoices/forecast" class="${invTab === 'forecast' ? 'on' : ''}">매출 예상</a></div>`;
  if (invTab === 'list') return seg + invList();
  if (invTab === 'req') return seg + reqView();
  if (invTab === 'pl') return seg + plView();
  if (invTab === 'forecast') return seg + forecast();
  const ym = invYM || ymOf(todayStr()); const st = billingStatus(ym);
  const exp = st.reduce((a, x) => a + x.site.amount, 0), got = st.reduce((a, x) => a + Math.max(0, x.net), 0);
  const c = calc();
  const extra = DB.invoices.filter(i => i.kind === '매출' && ymOf(i.date) === ym && !c.siteOf[i.id]);
  return seg + `<div class="monthnav"><button onclick="invYM='${ymAdd(ym, -1)}';render()">◀</button>${ymLabel(ym)}<button onclick="invYM='${ymAdd(ym, 1)}';render()">▶</button></div>
  <div class="card"><h3>정기 유지보수 ${st.filter(x => x.done).length}/${st.length}건 발행</h3>
  <div class="kv"><div>예정</div><div>${won(exp)}원</div><div>발행</div><div><b>${won(got)}</b>원</div><div>남음</div><div class="${exp - got > 0 ? 'org' : ''}">${won(Math.max(0, exp - got))}원</div></div>
  ${st.map(x => { const rq = reqFor(x.site.id, ym); return row(`${esc(x.site.name)} ${x.done ? '<span class="badge grn">발행</span>' : rq ? '<span class="badge blue">발행요청</span>' : '<span class="badge org">미발행</span>'}`,
    x.done ? x.invs.filter(i => i.supply > 0).map(i => i.date.slice(5) + ' ' + esc(i.item)).join(' / ') : `${esc(x.site.client)} · ${esc(billItemFor(x.site, ym))}`, x.done ? won(x.net) : `${won(x.site.amount)}<br><button class="btn sm ${rq ? 'ghost' : ''}" onclick="event.stopPropagation();billPrep({siteId:'${x.site.id}',ym:'${ym}'})">${rq ? '요청 수정' : '발행 준비'}</button>`, `onclick="go('#site/${x.site.id}')"`); }).join('')}
  ${st.some(x => !x.done && !reqFor(x.site.id, ym)) ? `<div class="btns"><button class="btn" onclick="billPrepAll('${ym}')">미발행 ${st.filter(x => !x.done && !reqFor(x.site.id, ym)).length}건 모두 발행요청</button></div>` : ''}
  </div>
  <div class="card"><h3>그 외 매출 (비정기) ${extra.length}건 <span class="sub" style="font-size:12px;font-weight:400">${won(extra.reduce((a, i) => a + i.supply, 0))}원</span></h3>
  ${extra.map(i => row(esc(i.name), `${i.date} · ${esc(i.item)}`, won(i.supply), `onclick="invDetail('${i.id}')"`)).join('') || '<div class="empty">없음</div>'}</div>
  <div class="btns"><button class="btn ghost" onclick="billPrep({})">+ 비정기 계산서 발행 준비</button><button class="btn" onclick="importHometax()">홈택스 파일 올리기</button></div>
  <div class="note">홈택스 ‘매출/매입 전자세금계산서 목록조회’에서 받은 엑셀(.xls/.xlsx) 또는 CSV를 올리면 새 계산서만 추가되고, 사업자번호와 품목명으로 사이트에 자동 연결됩니다. 품목명에 “10월” 같은 표시가 있으면 그 달 몫으로 봅니다.</div>`;
}
/* ---------------- 퍼콜·장애처리 (유지보수 외 작업) 월별 ---------------- */
const PC_CATS = [['장애처리', /장애|출동|복구|고장|에러|오류|긴급|디스크 ?교체|부품 ?교체|교체/], ['설치·이전', /설치|이전|이설|구축|마이그|납품|공급|증설/], ['기술지원', /지원|점검|컨설팅|작업|패치|업그레이드/]];
const pcCat = t => (PC_CATS.find(([, re]) => re.test(t || '')) || ['기타'])[0];
const PC_COLOR = { '장애처리': 'red', '설치·이전': '', '기술지원': 'grn', '기타': '' };
// 품목명에 "N월"(N월분, N~M월 포함, "N월 N일" 같은 날짜는 제외)이 있으면 유지보수로 봄
const isMaintItem = t => /(^|[^0-9])(1[0-2]|[1-9])\s*월(?!\s*\d+\s*일)/.test(t || '');
function perCallInvoices() { const c = calc(); return DB.invoices.filter(i => i.kind === '매출' && (!c.siteOf[i.id] || isAdhoc(DB.sites.find(s => s.id === c.siteOf[i.id]) || {})) && !c.cancelled.has(i.id) && i.supply > 0 && !isMaintItem(i.item)); }
let pcYM = null, pcCatF = '전체';
function perCallView() {
  const ym = pcYM || ymOf(todayStr()), year = ym.slice(0, 4);
  const all = perCallInvoices(), okCat = t => pcCatF === '전체' || pcCat(t) === pcCatF;
  const months = Array.from({ length: 12 }, (_, k) => `${year}-${String(k + 1).padStart(2, '0')}`);
  const byM = Object.fromEntries(months.map(m => [m, all.filter(i => ymOf(i.date) === m && okCat(i.item))]));
  const yearSum = months.reduce((a, m) => a + byM[m].reduce((b, i) => b + i.supply, 0), 0), yearCnt = months.reduce((a, m) => a + byM[m].length, 0);
  const max = Math.max(1, ...months.map(m => byM[m].reduce((b, i) => b + i.supply, 0)));
  const invs = byM[ym] || all.filter(i => ymOf(i.date) === ym && okCat(i.item));
  const evs = DB.events.filter(e => ymOf(e.date) === ym && !INSPECT_TYPES.includes(e.type) && okCat(e.type + ' ' + (e.title || ''))).sort((a, b) => a.date.localeCompare(b.date));
  const ods = (DB.orders || []).filter(o => ymOf(o.date) === ym && ['발주', '장애·점검요청'].includes(o.kind) && !['계산서발행', '취소'].includes(o.status) && okCat(o.title));
  const siteName = id => (DB.sites.find(x => x.id === id) || {}).name || '';
  const catSum = PC_CATS.map(([k]) => k).concat('기타').map(k => [k, invs.filter(i => pcCat(i.item) === k)]).filter(([, l]) => l.length);
  return `<div class="toolbar"><select onchange="pcCatF=this.value;render()">${['전체', '장애처리', '설치·이전', '기술지원', '기타'].map(k => `<option ${k === pcCatF ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
  <div class="card"><h3>${year}년 유지보수 외 매출 ${yearCnt}건 <span class="sub" style="font-size:12px;font-weight:400">${won(yearSum)}원</span></h3>
  <div class="pcbars">${months.map(m => { const v = byM[m].reduce((b, i) => b + i.supply, 0); return `<a class="${m === ym ? 'on' : ''}" onclick="pcYM='${m}';render()"><i style="height:${Math.round(v / max * 100)}%"></i><span>${Number(m.slice(5))}월</span><small>${byM[m].length || ''}</small></a>`; }).join('')}</div></div>
  <div class="monthnav"><button onclick="pcYM='${ymAdd(ym, -1)}';render()">◀</button>${ymLabel(ym)}<button onclick="pcYM='${ymAdd(ym, 1)}';render()">▶</button></div>
  <div class="card"><h3>계산서 ${invs.length}건 <span class="sub" style="font-size:12px;font-weight:400">${won(invs.reduce((a, i) => a + i.supply, 0))}원${catSum.length > 1 ? ' · ' + catSum.map(([k, l]) => `${k} ${l.length}`).join(' · ') : ''}</span></h3>
  ${invs.sort((a, b) => a.date.localeCompare(b.date)).map(i => { const k = pcCat(i.item); return row(`${esc(i.item)} <span class="badge ${PC_COLOR[k]}">${k}</span>`, `${i.date.slice(5)} · ${esc(i.name)}`, won(i.supply), `onclick="invDetail('${i.id}')"`); }).join('') || '<div class="empty">없음</div>'}</div>
  ${evs.length ? `<div class="card"><h3>작업 기록 ${evs.length}건</h3>${evs.map(e => row(`${esc(e.title || e.type)} <span class="badge ${PC_COLOR[pcCat(e.type)] || ''}">${esc(e.type)}</span>`, `${e.date.slice(5)} · ${esc(siteName(e.siteId))}`, '', `onclick="go('#site/${e.siteId}')"`)).join('')}</div>` : ''}
  ${ods.length ? `<div class="card"><h3>계산서 전 (발주·요청) ${ods.length}건</h3>${ods.map(o => row(`${esc(o.title)} <span class="badge org">${esc(o.status)}</span>`, `${o.date.slice(5)} · ${esc(o.client || o.customer || '')}`, o.amount ? won(o.amount) : '', `onclick="go('#orders')"`)).join('')}</div>` : ''}
  <div class="note">유지보수 사이트(old 포함)에 연결되지 않고 품목명에 "N월"이 없는 매출 계산서를 퍼콜·장애 작업으로 봅니다. 종류는 품목명 단어(장애·출동·교체 → 장애처리, 설치·이전·납품 → 설치·이전, 지원·작업 → 기술지원)로 나눕니다. 계산서를 눌러 사이트에 연결하면 유지보수로 옮겨 갑니다.</div>`;
}
/* ---------------- 매출·매입 기간별 ---------------- */
let plUnit = '분기', plYear = null, plSel = null;
const qOf = d => `${d.slice(0, 4)}-Q${Math.ceil(Number(d.slice(5, 7)) / 3)}`;
function plKey(d) { return plUnit === '연도' ? d.slice(0, 4) : plUnit === '분기' ? qOf(d) : d.slice(0, 7); }
function plLabel(k) { return plUnit === '연도' ? k + '년' : plUnit === '분기' ? `${k.slice(0, 4)}년 ${k.slice(6)}분기` : ymLabel(k); }
function plView() {
  const years = [...new Set(DB.invoices.map(i => i.date.slice(0, 4)))].sort();
  const yr = plYear || years[years.length - 1] || todayStr().slice(0, 4);
  const inv = DB.invoices.filter(i => plUnit === '연도' || yr === '전체' || i.date.startsWith(yr));
  const g = {}; for (const i of inv) { const k = plKey(i.date); const x = g[k] = g[k] || { s: 0, sn: 0, p: 0, pn: 0 }; if (i.kind === '매출') { x.s += i.supply; x.sn++; } else { x.p += i.supply; x.pn++; } }
  const keys = Object.keys(g).sort().reverse();
  const tot = keys.reduce((a, k) => ({ s: a.s + g[k].s, sn: a.sn + g[k].sn, p: a.p + g[k].p, pn: a.pn + g[k].pn }), { s: 0, sn: 0, p: 0, pn: 0 });
  const max = Math.max(1, ...keys.map(k => Math.max(g[k].s, g[k].p)));
  const sel = plSel && g[plSel] ? plSel : null;
  let detail = '';
  if (sel) {
    const li = inv.filter(i => plKey(i.date) === sel), by = (kind) => { const m = {}; for (const i of li.filter(x => x.kind === kind)) { const k = i.bizNo || i.name; const x = m[k] = m[k] || { name: i.name, n: 0, v: 0 }; x.n++; x.v += i.supply; } return Object.values(m).sort((a, b) => b.v - a.v); };
    const part = (kind) => { const l = by(kind), sum = l.reduce((a, x) => a + x.v, 0); return `<div class="card"><h3>${plLabel(sel)} ${kind}처 ${l.length}곳 <span class="sub" style="font-size:12px;font-weight:400">${won(sum)}원</span></h3>${l.map(x => row(esc(x.name), `${x.n}건 · ${sum ? Math.round(x.v / sum * 100) : 0}%`, won(x.v))).join('') || '<div class="empty">없음</div>'}</div>`; };
    detail = part('매출') + part('매입') + `<div class="btns"><button class="btn ghost" onclick="plSel=null;render()">기간 목록으로</button>${plUnit === '월' ? `<button class="btn ghost" onclick="invQ='${sel}';invTab='list';go('#invoices/list')">이 달 계산서 목록</button>` : ''}</div>`;
  }
  const sel2 = (v, opts, on) => `<select onchange="${on}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  return `<div class="toolbar">${sel2(plUnit, ['연도', '분기', '월'], "plUnit=this.value;plSel=null;render()")}${plUnit === '연도' ? '' : sel2(yr, ['전체', ...years.slice().reverse()], "plYear=this.value;plSel=null;render()")}</div>
  <div class="card"><h3>${plUnit === '연도' || yr === '전체' ? '전체 기간' : yr + '년'} 합계</h3><div class="kv"><div>매출</div><div><b>${won(tot.s)}</b>원 (${tot.sn}건)</div><div>매입</div><div>${won(tot.p)}원 (${tot.pn}건)</div><div>차액</div><div class="${tot.s - tot.p < 0 ? 'red' : 'grn'}">${won(tot.s - tot.p)}원</div></div><div class="note" style="margin-top:6px">공급가액 기준(부가세 제외), 수정(마이너스) 계산서 포함</div></div>
  ${detail || `<div class="card plt"><div class="plh"><span>기간</span><span>매출</span><span>매입</span><span>차액</span></div>
  ${keys.map(k => { const x = g[k]; return `<div class="plr" onclick="plSel='${k}';render();window.scrollTo(0,0)"><span>${plLabel(k)}</span><span>${won(x.s)}<small>${x.sn}건</small><i class="bs" style="width:${Math.round(x.s / max * 100)}%"></i></span><span>${won(x.p)}<small>${x.pn}건</small><i class="bp" style="width:${Math.round(x.p / max * 100)}%"></i></span><span class="${x.s - x.p < 0 ? 'red' : ''}">${won(x.s - x.p)}</span></div>`; }).join('')}
  </div><div class="note">기간을 누르면 그 기간의 매출처·매입처별 합계가 나옵니다.</div>`}`;
}
function invList() {
  const q = invQ.toLowerCase(); const c = calc();
  const list = DB.invoices.filter(i => (invKind === '전체' || i.kind === invKind) && (!q || (i.name + i.item + i.date + i.bizNo).toLowerCase().includes(q))).sort((a, b) => b.date.localeCompare(a.date));
  const sum = list.reduce((a, i) => a + i.supply, 0);
  return `<div class="toolbar"><select onchange="invKind=this.value;render()">${['매출', '매입', '전체'].map(k => `<option ${k === invKind ? 'selected' : ''}>${k}</option>`).join('')}</select><input placeholder="거래처·품목·날짜 검색 (예: 2026-10)" value="${esc(invQ)}" oninput="invQ=this.value;render(true)"></div>
  <div class="card"><h3>${list.length}건 <span class="sub" style="font-size:12px;font-weight:400">공급가액 ${won(sum)}원</span></h3>
  ${list.slice(0, 200).map(i => row(`${esc(i.name)} ${c.siteOf[i.id] ? `<span class="badge blue">${esc(siteName(c.siteOf[i.id]))}</span>` : ''}`, `${i.date} · ${esc(i.item)}`, `<span class="${i.supply < 0 ? 'red' : ''}">${won(i.supply)}</span>`, `onclick="invDetail('${i.id}')"`)).join('')}
  ${list.length > 200 ? `<div class="empty">앞 200건만 보입니다. 검색으로 좁혀 보세요.</div>` : ''}</div>`;
}
function invDetail(id) {
  const i = DB.invoices.find(x => x.id === id); const c = calc();
  const opts = [['', '(자동 연결)'], ...DB.sites.map(s => [s.id, s.name])];
  openSheet(`<h2>세금계산서</h2><div class="kv">
  <div>구분</div><div>${esc(i.kind)}${i.mod ? ' (수정)' : ''}</div><div>작성일자</div><div>${i.date}</div><div>거래처</div><div>${esc(i.name)}<br><small class="sub">${esc(i.bizNo)}</small></div>
  <div>품목</div><div>${esc(i.item)}</div><div>공급가액</div><div>${won(i.supply)}</div><div>세액</div><div>${won(i.tax)}</div><div>합계</div><div><b>${won(i.total)}</b></div>
  <div>승인번호</div><div><small>${esc(i.id)}</small></div>
  <div>입금</div><div>${c.cancelled.has(i.id) ? '수정/취소 건' : c.paidBy[i.id] ? '입금 ' + c.paidBy[i.id].date + (c.paidBy[i.id].manual ? ' (직접 확인)' : ' (통장 대조)') : '<span class="red">미입금</span>'}</div></div>
  <label class="f" style="margin-top:12px">${i.kind === '매출' ? '연결 사이트' : '연결 사이트 (이 매입을 사이트 원가로 잡기)'}<select id="invSite">${(i.kind === '매출' ? opts : [['', '(연결 안 함)'], ...DB.sites.map(s => [s.id, s.name])]).map(([v, l]) => `<option value="${v}" ${v === (i.siteId || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
  <div class="btns"><button class="btn" onclick="saveInvSite('${id}')">저장</button>
  ${i.kind === '매출' && !c.cancelled.has(i.id) ? (c.paidBy[i.id] ? (c.paidBy[i.id].manual ? `<button class="btn ghost" onclick="togglePaid('${id}',false)">미입금으로 되돌리기</button>` : '') : `<button class="btn grn" onclick="togglePaid('${id}',true)">입금 확인 처리</button>`) : ''}
  <button class="btn ghost" onclick="closeSheet()">닫기</button></div>`);
}
async function saveInvSite(id) { const i = DB.invoices.find(x => x.id === id); i.siteId = $('#invSite').value || undefined; closeSheet(); await save(); render(); }
async function togglePaid(id, on) { DB.manualPaid = DB.manualPaid || {}; if (on) DB.manualPaid[id] = todayStr(); else delete DB.manualPaid[id]; closeSheet(); await save(); render(); toast(on ? '입금 확인했습니다' : '되돌렸습니다'); }
function forecast() {
  const ym = ymOf(todayStr()), y = Number(ym.slice(0, 4));
  const years = []; for (let k = y - 5; k <= y; k++) years.push(k);
  const tot = years.map(k => ({ y: k, v: Object.values(salesByMonth(String(k))).reduce((a, b) => a + b, 0) }));
  const sm = salesByMonth(String(y)); let rest = 0;
  const cur = billingStatus(ym).reduce((a, x) => a + Math.max(0, x.net), 0);
  const months = Object.keys(sm).map(m => { let f = 0; if (m === ym) f = Math.max(0, expectedOfMonth(m) - cur); else if (m > ym) f = expectedOfMonth(m); rest += f; return { m, a: sm[m], f }; });
  const mx = Math.max(...months.map(x => x.a + x.f), 1), my = Math.max(...tot.map(x => x.v), tot[tot.length - 1].v + rest, 1);
  const next = []; for (let k = 0; k < 6; k++) { const m = ymAdd(ym, k); next.push({ m, v: expectedOfMonth(m), sites: DB.sites.filter(s => billExpected(s, m)) }); }
  return `<div class="card"><h3>${y}년 월별 매출 <span class="sub" style="font-size:12px;font-weight:400">진한색 실제 · 연한색 예상</span></h3>
  <div class="chart">${months.map(x => `<div class="c"><b>${x.a + x.f ? man(x.a + x.f).replace('만', '') : ''}</b><i class="f" style="height:${x.f / mx * 110}px"></i><i style="height:${Math.max(0, x.a) / mx * 110}px"></i><em>${Number(x.m.slice(5))}월</em></div>`).join('')}</div>
  <div class="kv" style="margin-top:10px"><div>실제 발행</div><div>${won(tot[tot.length - 1].v)}원</div><div>남은 예상</div><div>${won(rest)}원</div><div>연말 예상</div><div><b>${won(tot[tot.length - 1].v + rest)}</b>원</div></div>
  <div class="note">예상은 정기 유지보수 계약만 넣은 값입니다(장애·납품 같은 비정기 매출 제외). 단위: 만원.</div></div>
  <div class="card"><h3>연도별 매출 (공급가액)</h3>
  <div class="chart">${tot.map((x, i) => `<div class="c"><b>${man(x.v + (i === tot.length - 1 ? rest : 0))}</b>${i === tot.length - 1 ? `<i class="f" style="height:${rest / my * 110}px"></i>` : ''}<i style="height:${x.v / my * 110}px"></i><em>${x.y}</em></div>`).join('')}</div></div>
  <div class="card"><h3>앞으로 6개월 정기 매출 예상</h3>${next.map(x => row(ymLabel(x.m), `${x.sites.length}개 사이트`, won(x.v) + '원')).join('')}</div>`;
}

/* ---------------- 미수금 / 통장 ---------------- */
function viewAR() {
  const ar = receivables(); const sum = ar.reduce((a, x) => a + x.inv.total, 0);
  const groups = {}; for (const x of ar) { const k = x.inv.bizNo || x.inv.name; (groups[k] = groups[k] || { name: x.inv.name, list: [], sum: 0 }); groups[k].list.push(x); groups[k].sum += x.inv.total; }
  const unmatched = DB.deposits.filter(d => !(d.invIds || []).length && !d.ignore).sort((a, b) => b.date.localeCompare(a.date));
  return `<div class="card"><h3>미수금 합계 <span class="red">${won(sum)}원</span></h3>
  <div class="note">${DB.settings.arStart} 이후 발행한 매출 계산서 중 통장 입금이 확인되지 않은 건 (부가세 포함 합계금액). 기준일은 설정에서 바꿀 수 있습니다.</div>
  <div class="btns"><button class="btn" onclick="smsSheet()">입금 문자 붙여넣기</button><button class="btn ghost" onclick="importBank()">통장 거래내역 파일</button><button class="btn ghost" onclick="depositForm()">입금 직접 입력</button></div></div>
  ${prepaidCard()}
  ${Object.values(groups).sort((a, b) => b.sum - a.sum).map(g => `<div class="card"><h3>${esc(g.name)} <span>${won(g.sum)}원 ${g.list.some(x => x.age > 30) ? `<button class="btn sm ghost" onclick="dunMail('${esc(g.list[0].inv.bizNo || g.list[0].inv.name)}')">입금 요청 메일</button>` : ''}</span></h3>
    ${g.list.map(x => row(esc(x.inv.item), `${x.inv.date} · ${x.age}일 지남`, `${won(x.inv.total)}${x.age > 60 ? '<br><span class="badge red">60일+</span>' : x.age > 30 ? '<br><span class="badge org">30일+</span>' : ''}`, `onclick="invDetail('${x.inv.id}')"`)).join('')}</div>`).join('') || '<div class="card"><div class="empty">미수금이 없습니다 👍</div></div>'}
  <div class="card"><h3>계산서와 못 맞춘 입금 ${unmatched.length}건</h3>
  ${unmatched.slice(0, 50).map(d => row(esc(d.name), `${d.date}${d.memo ? ' · ' + esc(d.memo) : ''}`, won(d.amount), `onclick="matchDeposit('${d.id}')"`)).join('') || '<div class="empty">없음</div>'}
  <div class="note">누르면 직접 계산서를 골라 연결할 수 있습니다. 개인 입금·이자 같은 건 ‘무시’로 치우세요.</div></div>
  <div class="card"><h3>최근 연결된 입금</h3>${DB.deposits.filter(d => (d.invIds || []).length).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15).map(d => row(esc(d.name), `${d.date} · 계산서 ${d.invIds.length}건`, won(d.amount), `onclick="matchDeposit('${d.id}')"`)).join('') || '<div class="empty">없음</div>'}</div>`;
}
function depositForm() {
  formSheet('입금 직접 입력', [{ k: 'date', label: '입금일', type: 'date', value: todayStr() }, { k: 'name', label: '입금자명', value: '' }, { k: 'amount', label: '금액', type: 'number', value: '' }, { k: 'memo', label: '메모', value: '' }],
    o => { const d = { id: uid('d'), ...o, invIds: [] }; DB.deposits.push(d); invalidate(); autoMatch([d]); toast((d.invIds.length ? '계산서와 연결했습니다' : '맞는 계산서를 못 찾았습니다')); });
}
function matchDeposit(id) {
  const d = DB.deposits.find(x => x.id === id); const ar = receivables().map(x => x.inv);
  const linked = DB.invoices.filter(i => (d.invIds || []).includes(i.id));
  const cands = [...linked, ...ar.filter(i => !linked.includes(i) && (i.date <= d.date || d.prepaid))].slice(0, 80);
  const n = normName(d.name); cands.sort((a, b) => (normName(b.name).includes(n) || n.includes(normName(b.name))) - (normName(a.name).includes(n) || n.includes(normName(a.name))));
  openSheet(`<h2>입금 연결</h2><div class="kv"><div>입금</div><div>${d.date} · ${esc(d.name)} · <b>${won(d.amount)}</b>원</div></div>
  <p class="note">이 입금으로 받은 계산서를 모두 체크하세요(여러 달을 한 번에 받았으면 여러 건). 선택 합계: <b id="selSum">0</b>원 · 차액 <b id="selDiff">0</b>원</p>
  <label class="f"><input class="chk" type="checkbox" id="depPrepaid" ${d.prepaid ? 'checked' : ''}>남는 금액은 선입금으로 두고, 같은 거래처 다음 계산서가 발행되면 자동 연결</label>
  <div id="cands">${cands.map(i => `<label class="row" style="cursor:pointer"><div class="l"><input class="chk" type="checkbox" value="${i.id}" data-t="${i.total}" ${(d.invIds || []).includes(i.id) ? 'checked' : ''}><b style="display:inline">${esc(i.name)}</b><small>${i.date} · ${esc(i.item)}</small></div><div class="r">${won(i.total)}</div></label>`).join('') || '<div class="empty">미수 계산서가 없습니다</div>'}</div>
  <div class="btns"><button class="btn" onclick="saveMatch('${id}')">저장</button><button class="btn ghost" onclick="ignoreDep('${id}')">무시(계산서 아님)</button><button class="btn red" onclick="delDep('${id}')">삭제</button><button class="btn ghost" onclick="closeSheet()">닫기</button></div>`);
  const upd = () => { const sum = [...document.querySelectorAll('#cands input:checked')].reduce((a, x) => a + Number(x.dataset.t), 0); $('#selSum').textContent = won(sum); $('#selDiff').textContent = won(d.amount - sum); };
  document.querySelectorAll('#cands input').forEach(x => x.onchange = upd); upd();
}
async function saveMatch(id) { const d = DB.deposits.find(x => x.id === id); d.invIds = [...document.querySelectorAll('#cands input:checked')].map(x => x.value); d.ignore = false; d.prepaid = $('#depPrepaid').checked; if (d.prepaid) d.payer = d.payer || (DB.invoices.find(i => i.id === d.invIds[0]) || {}).bizNo || ''; closeSheet(); invalidate(); applyPrepaid(); await save(); render(); }
async function ignoreDep(id) { const d = DB.deposits.find(x => x.id === id); d.ignore = true; d.invIds = []; closeSheet(); await save(); render(); }
async function delDep(id) { if (!confirm('입금 내역을 삭제할까요?')) return; DB.deposits = DB.deposits.filter(x => x.id !== id); closeSheet(); await save(); render(); }
// 자동 대조: 금액이 같은 계산서 1건, 아니면 같은 거래처의 여러 건 합계가 같은 조합
function autoMatch(deps) {
  let n = 0;
  for (const d of deps) {
    if ((d.invIds || []).length || d.ignore) continue;
    invalidate();
    const open = receivables().map(x => x.inv).filter(i => i.date <= d.date || daysBetween(d.date, i.date) <= 3);
    const dn = normName(d.name);
    const nameOk = i => { const a = normName(i.name); return dn && a && (a.includes(dn) || dn.includes(a) || (dn.length >= 3 && a.includes(dn.slice(0, 3)))); };
    const same = open.filter(nameOk);
    let pick = same.find(i => i.total === d.amount) || null;
    if (pick) { d.invIds = [pick.id]; n++; continue; }
    const pool = same.slice(0, 18);
    const res = subsetSum(pool, d.amount);
    if (res) { d.invIds = res.map(i => i.id); n++; continue; }
    const exact = open.filter(i => i.total === d.amount);
    if (exact.length === 1) { d.invIds = [exact[0].id]; n++; }
  }
  invalidate(); return n;
}
function subsetSum(items, target) {
  let states = new Map([[0, []]]);
  for (const it of items) {
    const add = [];
    for (const [s, arr] of states) { const ns = s + it.total; if (ns <= target && !states.has(ns)) add.push([ns, [...arr, it]]); }
    for (const [s, a] of add) { states.set(s, a); if (s === target) return a; }
    if (states.size > 20000) break;
  }
  return null;
}

/* ---------------- 재고 ---------------- */
let partQ = '';
const partName = id => (DB.parts.find(p => p.id === id) || {}).name || '(삭제된 부품)';
function viewParts() {
  const list = DB.parts.filter(p => !partQ || (p.name + p.partNo + p.model + p.location + p.note).toLowerCase().includes(partQ.toLowerCase()));
  const val = DB.parts.reduce((a, p) => a + (p.qty || 0) * (p.cost || 0), 0);
  return `<div class="toolbar"><input placeholder="부품명·파트번호·장비 검색" value="${esc(partQ)}" oninput="partQ=this.value;render(true)"><button class="btn" onclick="partForm()">+ 부품</button></div>
  <div class="card"><h3>재고 ${DB.parts.length}품목 <span class="sub" style="font-size:12px;font-weight:400">재고 금액 ${won(val)}원</span></h3>
  ${list.map(p => row(`${esc(p.name)} ${(p.qty || 0) <= (p.minQty || 0) ? '<span class="badge red">부족</span>' : ''}`, `${esc(p.partNo || '')}${p.model ? ' · ' + esc(p.model) : ''}${p.location ? ' · ' + esc(p.location) : ''}`,
    `<b>${p.qty || 0}</b>개<br><button class="btn sm ghost" onclick="event.stopPropagation();moveStock('${p.id}',1)">+입고</button> <button class="btn sm ghost" onclick="event.stopPropagation();moveStock('${p.id}',-1)">−출고</button>`, `onclick="partForm(DB.parts.find(x=>x.id==='${p.id}'))"`)).join('') || '<div class="empty">등록된 부품이 없습니다. “+ 부품”으로 예비 디스크·컨트롤러 등을 넣어 보세요.</div>'}</div>
  <div class="note">작업 기록에서 사용 부품을 고르면 재고가 자동으로 줄어듭니다.</div>`;
}
function partForm(p) {
  p = p || { qty: 0, minQty: 0 }; const isNew = !p.id;
  const log = (p.log || []).slice(-10).reverse().map(l => `<div class="row"><div class="l"><small>${l.date} · ${esc(l.memo || '')}</small></div><div class="r ${l.qty < 0 ? 'red' : 'grn'}">${l.qty > 0 ? '+' : ''}${l.qty}</div></div>`).join('');
  formSheet(isNew ? '부품 추가' : '부품 수정', [
    { k: 'name', label: '부품명', value: p.name, ph: '예: 데이터도메인 4TB 디스크' }, { k: 'partNo', label: '파트번호', value: p.partNo },
    { k: 'model', label: '해당 장비', value: p.model, ph: '예: DD6300, NetApp FAS2650' }, { k: 'qty', label: '현재 수량', type: 'number', value: p.qty },
    { k: 'minQty', label: '최소 보유 수량 (이하이면 부족 알림)', type: 'number', value: p.minQty }, { k: 'location', label: '보관 위치', value: p.location },
    { k: 'cost', label: '구매 단가', type: 'number', value: p.cost }, { k: 'supplier', label: '구매처', value: p.supplier }, { k: 'note', label: '메모', type: 'textarea', value: p.note },
  ], o => { if (!o.name) { toast('부품명을 입력하세요'); return false; } if (isNew) DB.parts.push({ id: uid('p'), log: [], ...o }); else { if (o.qty !== p.qty) (p.log = p.log || []).push({ date: todayStr(), qty: o.qty - p.qty, memo: '수량 수정' }); Object.assign(p, o); } },
    isNew ? '' : `<button class="btn red" type="button" onclick="delPart('${p.id}')">삭제</button>`);
  if (log) $('#fm').insertAdjacentHTML('beforeend', `<h3 style="font-size:14px">최근 입출고</h3>${log}`);
}
async function moveStock(id, sign) {
  const p = DB.parts.find(x => x.id === id); const n = Number(prompt(sign > 0 ? '입고 수량' : '출고 수량', '1')); if (!n) return;
  const memo = prompt('메모 (구매처·사용처 등)', '') || '';
  p.qty = (p.qty || 0) + sign * n; (p.log = p.log || []).push({ date: todayStr(), qty: sign * n, memo }); await save(); render();
}
async function delPart(id) { if (!confirm('부품을 삭제할까요?')) return; DB.parts = DB.parts.filter(x => x.id !== id); closeSheet(); await save(); render(); }

/* ---------------- 파일 가져오기 ---------------- */
async function readTable(file) {
  const buf = await file.arrayBuffer(); let wb;
  if (/\.(csv|txt)$/i.test(file.name)) {
    let t = new TextDecoder('utf-8').decode(buf); if (t.includes('�')) t = new TextDecoder('euc-kr').decode(buf);
    wb = XLSX.read(t.replace(/^﻿/, ''), { type: 'string', raw: true });
  } else wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const out = []; for (const n of wb.SheetNames) out.push(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' }));
  return out;
}
const toNum = v => Number(String(v ?? '').replace(/[,\s원]/g, '')) || 0;
const toDate = v => { const s = String(v || '').trim(); let m = s.match(/(\d{4})[-./년\s]*(\d{1,2})[-./월\s]*(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; } return ''; };
function findHeader(rows, must) { for (let r = 0; r < Math.min(rows.length, 30); r++) { const h = rows[r].map(x => String(x).replace(/\s/g, '')); if (must.every(re => h.some(c => re.test(c)))) return r; } return -1; }
const col = (h, re, not) => h.findIndex(c => re.test(c) && !(not && not.test(c)));
async function importHometax() {
  const f = await pickFile('.xls,.xlsx,.csv'); if (!f) return;
  try {
    const sheets = await readTable(f); let added = 0, seen = 0; const own = (DB.settings.bizNo || '').replace(/-/g, '');
    const fileKind = /매입/.test(f.name) ? '매입' : /매출/.test(f.name) ? '매출' : '';
    for (const rows of sheets) {
      const hr = findHeader(rows, [/승인번호/, /공급가액/]); if (hr < 0) continue;
      const h = rows[hr].map(x => String(x).replace(/\s/g, ''));
      const iKind = col(h, /^구분$/), iDate = col(h, /작성일자/), iId = col(h, /승인번호/), iSup = col(h, /공급가액/), iTax = col(h, /^세액/), iTot = col(h, /합계/), iItem = col(h, /품목명/), iType = col(h, /^종류$|세금계산서분류|분류/);
      const iSupNo = col(h, /공급자(사업자등록)?번호|공급자사업자/, /종사업장|상호|대표/), iBuyNo = col(h, /공급받는자(사업자등록)?번호|공급받는자사업자/, /종사업장|상호|대표/), iCnt = col(h, /거래처번호/);
      const nameCols = h.map((c, i) => [c, i]).filter(([c]) => /상호/.test(c)).map(x => x[1]);
      for (const r of rows.slice(hr + 1)) {
        const id = String(r[iId] || '').trim(); if (!/^\d{8}-/.test(id)) continue; seen++;
        if (DB.invoices.some(i => i.id === id)) continue;
        let kind = iKind >= 0 ? String(r[iKind]).trim() : fileKind; let bizNo = '', name = '';
        const supNo = iSupNo >= 0 ? String(r[iSupNo]).trim() : '', buyNo = iBuyNo >= 0 ? String(r[iBuyNo]).trim() : '';
        if (!kind && supNo) kind = supNo.replace(/-/g, '') === own ? '매출' : '매입';
        if (iCnt >= 0) bizNo = String(r[iCnt]).trim(); else bizNo = kind === '매출' ? buyNo : supNo;
        if (nameCols.length >= 2) name = String(r[kind === '매출' ? nameCols[1] : nameCols[0]] || '').trim(); else if (nameCols.length) name = String(r[nameCols[0]]).trim();
        if (kind !== '매출' && kind !== '매입') continue;
        const supply = toNum(r[iSup]), tax = iTax >= 0 ? toNum(r[iTax]) : 0;
        DB.invoices.push({ id, kind, date: toDate(r[iDate]), bizNo, name, item: iItem >= 0 ? String(r[iItem]).trim() : '', supply, tax, total: iTot >= 0 ? toNum(r[iTot]) : supply + tax, mod: /수정/.test(iType >= 0 ? r[iType] : '') || supply < 0 });
        added++;
      }
    }
    if (!seen) { alert('승인번호·공급가액 열을 찾지 못했습니다. 홈택스 목록조회 엑셀/CSV인지 확인해 주세요.'); return; }
    invalidate(); const rq = reconcileBillReqs(); applyPrepaid(); await save(); render(); toast(`${seen}건 중 새 계산서 ${added}건 추가${rq ? `, 발행요청 ${rq}건 발행 완료로 표시` : ''}`);
  } catch (e) { console.error(e); alert('파일을 읽지 못했습니다: ' + e.message); }
}
async function importBank() {
  const f = await pickFile('.xls,.xlsx,.csv'); if (!f) return;
  try {
    const sheets = await readTable(f); const news = []; let seen = 0;
    for (const rows of sheets) {
      const hr = findHeader(rows, [/거래일|일자|일시|날짜/, /입금|맡기신|들어온/]); if (hr < 0) continue;
      const h = rows[hr].map(x => String(x).replace(/\s/g, ''));
      const iDate = col(h, /거래일|일자|일시|날짜/), iIn = col(h, /입금|맡기신|들어온/, /입금자|입금인/), iName = col(h, /입금자|보낸분|의뢰인|기재내용|적요|내용|받는분|거래내용/), iMemo = col(h, /메모|비고|구분|거래점/);
      for (const r of rows.slice(hr + 1)) {
        const amt = toNum(r[iIn]), date = toDate(r[iDate]); if (!amt || amt <= 0 || !date) continue; seen++;
        const name = String(r[iName] ?? '').trim();
        if (DB.deposits.some(d => d.date === date && d.amount === amt && d.name === name)) continue;
        const d = { id: uid('d'), date, name, amount: amt, memo: iMemo >= 0 ? String(r[iMemo] || '').trim() : '', invIds: [] };
        DB.deposits.push(d); news.push(d);
      }
    }
    if (!seen) { alert('날짜·입금액 열을 찾지 못했습니다. 은행 인터넷뱅킹 “거래내역 조회 → 엑셀 저장” 파일을 올려 주세요.'); return; }
    const n = autoMatch(news); await save(); render(); toast(`입금 ${news.length}건 추가, 계산서와 ${n}건 자동 연결`);
  } catch (e) { console.error(e); alert('파일을 읽지 못했습니다: ' + e.message); }
}

/* ---------------- 설정·백업·구글시트 ---------------- */
function viewSettings() {
  const s = DB.settings;
  return `<div class="card"><h3>기본 설정</h3>
  <label class="f">회사명<input id="stCompany" value="${esc(s.company)}"></label>
  <label class="f">우리 사업자번호 (홈택스 매출/매입 구분용)<input id="stBiz" value="${esc(s.bizNo)}"></label>
  <div class="grid2"><label class="f">대표·견적담당<input id="stOwner" value="${esc(s.owner || '')}"></label><label class="f">전화<input id="stTel" value="${esc(s.tel || '')}"></label></div>
  <label class="f">이메일<input id="stEmail" value="${esc(s.email || '')}"></label>
  <label class="f">주소 (견적서에 표시)<input id="stAddr" value="${esc(s.address || '')}"></label>
  <label class="f">미수금 관리 시작일 (이전 계산서는 입금된 것으로 봄)<input id="stAr" type="date" value="${esc(s.arStart)}"></label>
  <button class="btn" onclick="saveSettings()">저장</button></div>
  <div class="card"><h3>자료 올리기</h3><div class="btns"><button class="btn" onclick="importHometax()">홈택스 계산서 파일</button><button class="btn" onclick="importBank()">통장 거래내역 파일</button></div></div>
  <div class="card"><h3>구글 시트 동기화</h3>
  <div class="note">폰과 PC에서 같은 자료를 쓰려면 구글 시트에 연결하세요. 설치 방법은 함께 드린 ‘사용방법’ 문서를 보세요.</div>
  <label class="f">Apps Script 웹앱 주소<input id="stUrl" value="${esc(s.syncUrl)}" placeholder="https://script.google.com/macros/s/.../exec"></label>
  <label class="f">비밀번호 (Apps Script에 정한 값)<input id="stTok" type="password" value="${esc(s.syncToken)}"></label>
  <div class="btns"><button class="btn" onclick="saveSettings()">저장</button><button class="btn grn" onclick="syncPush()">시트로 올리기</button><button class="btn ghost" onclick="syncPull()">시트에서 받기</button><button class="btn ghost" onclick="pullInbox()">메일 업무 받기</button></div>
  <div class="note">마지막 저장: ${DB.updated ? new Date(DB.updated).toLocaleString('ko-KR') : '-'}${s.lastSync ? ' · 마지막 동기화: ' + new Date(s.lastSync).toLocaleString('ko-KR') : ''}</div></div>
  <div class="card"><h3>구글 캘린더 자동 등록</h3><label class="f"><input class="chk" type="checkbox" id="stCal" ${s.calSync === false ? '' : 'checked'} onchange="DB.settings.calSync=this.checked;save()">점검 예정일·발주 납기·앞으로의 작업 기록을 구글 캘린더에 올리기</label>
  <div class="note">구글 시트로 올릴 때 함께 보내고, Apps Script가 기본 캘린더에 일정을 만들거나 고칩니다. 점검을 끝내면 남은 예정 일정은 지워집니다. (Apps Script를 새 버전으로 배포해야 동작)</div></div>
  ${logCard()}
  <div class="card"><h3>백업</h3><div class="btns"><button class="btn ghost" onclick="exportJSON()">백업 파일 저장</button><button class="btn ghost" onclick="importJSON()">백업·초기 데이터 불러오기</button><button class="btn red" onclick="resetAll()">전체 초기화</button></div>
  <div class="note">구글 시트에 연결돼 있으면 하루 한 번 시트 안에 백업본(_bak_날짜)이 자동으로 남습니다(최근 14개).</div>
  <div class="note">사이트 ${DB.sites.length} · 계산서 ${DB.invoices.length} · 작업기록 ${DB.events.length} · 부품 ${DB.parts.length} · 입금 ${DB.deposits.length}</div></div>`;
}
async function saveSettings() { const s = DB.settings, wasReady = syncReady(); s.company = $('#stCompany').value.trim(); s.bizNo = $('#stBiz').value.trim(); s.arStart = $('#stAr').value || '2000-01-01'; s.syncUrl = $('#stUrl').value.trim(); s.owner = $('#stOwner').value.trim(); s.tel = $('#stTel').value.trim(); s.email = $('#stEmail').value.trim(); s.address = $('#stAddr').value.trim(); s.syncToken = $('#stTok').value;
  if (!wasReady && syncReady()) { s.lastSync = ''; await persist(); toast('저장했습니다. 시트와 맞추는 중…'); render(); autoPull(); return; }
  await save(); toast('저장했습니다'); render(); }
function exportJSON() { download(`이포트텍_ERP_백업_${todayStr()}.json`, JSON.stringify(DB)); }
async function importJSON() {
  const f = await pickFile('.json'); if (!f) return;
  try { const d = JSON.parse(await f.text()); if (!d.sites || !d.invoices) throw new Error('형식이 다릅니다');
    if (DB.sites.length && !confirm('지금 자료를 이 파일 내용으로 바꿀까요?')) return;
    DB = Object.assign(blankDB(), d); DB.settings = Object.assign(blankDB().settings, d.settings || {}); _snap = null; await save(); render(); toast('불러왔습니다');
  } catch (e) { alert('불러오기 실패: ' + e.message); }
}
async function resetAll() { if (!confirm('모든 자료를 지울까요? (먼저 백업을 저장하세요)')) return; const st = DB.settings; DB = blankDB(); DB.settings.syncUrl = st.syncUrl; DB.settings.syncToken = st.syncToken; await save(); render(); }
async function syncPush() {
  const s = DB.settings; if (!s.syncUrl) { toast('웹앱 주소를 먼저 저장하세요'); return; }
  try { toast('올리는 중…'); if (!DB.updated) DB.updated = new Date().toISOString(); await pushNow(); toast('구글 시트에 저장했습니다'); render(); } catch (e) { alert('동기화 실패: ' + e.message); }
}
async function syncPull() {
  const s = DB.settings; if (!s.syncUrl) { toast('웹앱 주소를 먼저 저장하세요'); return; }
  try { toast('받는 중…'); const r = await fetch(s.syncUrl + (s.syncUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(s.syncToken)); const j = await r.json(); if (!j.ok) throw new Error(j.error || '실패');
    if (!j.data) { toast('시트에 저장된 자료가 없습니다'); return; }
    if (!confirm(`시트 자료(${j.data.updated ? new Date(j.data.updated).toLocaleString('ko-KR') : ''})로 이 기기 자료를 바꿀까요?`)) return;
    const keep = { syncUrl: s.syncUrl, syncToken: s.syncToken }; DB = Object.assign(blankDB(), j.data); if (!DB.updated) DB.updated = new Date().toISOString(); DB.settings = Object.assign(blankDB().settings, j.data.settings, keep, { lastSync: DB.updated }); _snap = null; diffLog();
    await persist(); syncBadge(); toast('받았습니다'); render(); await pullInbox(true); } catch (e) { alert('동기화 실패: ' + e.message); }
}

/* ---------------- 발주·요청 (메일 자동 입력) ---------------- */
const ORDER_KINDS = ['발주', '견적요청', '장애·점검요청', '유지보수변경', '기타'];
const ORDER_STATUS = ['접수', '진행', '완료', '계산서발행', '취소'];
let orderFilter = '진행중';
function homeMailCards() {
  const pend = (DB.changes || []).filter(c => !c.done);
  const open = (DB.orders || []).filter(o => ['접수', '진행'].includes(o.status));
  const fresh = open.filter(o => o.status === '접수');
  let h = '';
  if (pend.length) h += `<div class="card" style="margin-top:12px"><h3>메일로 온 유지보수 변경 ${pend.length}건 <a href="#orders">확인</a></h3>${pend.slice(0, 5).map(c => row(`${esc(c.siteName || c.customer || '')} <span class="badge org">확인 필요</span>`, `${c.date} · ${esc(c.summary || c.subject)}`, '', `onclick="changeSheet('${c.id}')"`)).join('')}</div>`;
  if (open.length) h += `<div class="card" style="margin-top:12px"><h3>진행 중인 발주·요청 ${open.length}건 <a href="#orders">전체</a></h3>${fresh.slice(0, 5).map(o => row(`${esc(o.title)} <span class="badge blue">${esc(o.kind)}</span>`, `${o.date} · ${esc(o.client || '')}${o.customer ? ' / ' + esc(o.customer) : ''}`, o.amount ? won(o.amount) : '', `onclick="orderForm(DB.orders.find(x=>x.id==='${o.id}'))"`)).join('') || '<div class="note">새로 들어온 건은 없습니다.</div>'}
    <div class="note">수주 잔고(진행 중 발주 합계): <b>${won(open.filter(o => o.kind === '발주').reduce((a, o) => a + (o.amount || 0), 0))}</b>원</div></div>`;
  return h;
}
function ordersSeg() { return `<div class="seg">${['진행중', '발주', '견적요청', '장애·점검요청', '전체', '견적서'].map(f => `<a href="javascript:orderFilter='${f}';render()" class="${orderFilter === f ? 'on' : ''}">${f.replace('·점검요청', '')}</a>`).join('')}</div>`; }
function viewOrders() {
  if (orderFilter === '견적서') return ordersSeg() + viewQuotes();
  const all = (DB.orders || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const list = all.filter(o => orderFilter === '전체' || (orderFilter === '진행중' ? ['접수', '진행'].includes(o.status) : o.kind === orderFilter));
  const pend = (DB.changes || []).filter(c => !c.done);
  const s = DB.settings;
  return `<div class="seg">${['진행중', '발주', '견적요청', '장애·점검요청', '전체', '견적서'].map(f => `<a href="javascript:orderFilter='${f}';render()" class="${orderFilter === f ? 'on' : ''}">${f.replace('·점검요청', '')}</a>`).join('')}</div>
  <div class="btns"><button class="btn" onclick="orderForm()">+ 직접 입력</button><button class="btn ghost" onclick="pullInbox()">메일 업무 받기</button><button class="btn ghost" onclick="importInboxFile()">메일 업무 파일</button></div>
  ${pend.length ? `<div class="card"><h3>유지보수 변경 확인 ${pend.length}건</h3>${pend.map(c => row(`${esc(c.siteName || c.customer || '(사이트 미지정)')}`, `${c.date} · ${esc(c.summary || c.subject)}`, '<span class="badge org">확인</span>', `onclick="changeSheet('${c.id}')"`)).join('')}</div>` : ''}
  <div class="card"><h3>${orderFilter} ${list.length}건 <span class="sub" style="font-size:12px;font-weight:400">${won(list.reduce((a, o) => a + (o.amount || 0), 0))}원</span></h3>
  ${list.map(o => row(`${esc(o.title)} ${statusBadge(o.status)}`, `${o.date} · <span class="badge blue">${esc(o.kind)}</span> ${esc(o.client || '')}${o.customer ? ' / ' + esc(o.customer) : ''}${o.source === 'mail' ? ' · ✉' : ''}`, o.amount ? won(o.amount) : '', `onclick="orderForm(DB.orders.find(x=>x.id==='${o.id}'))"`)).join('') || '<div class="empty">없습니다</div>'}</div>
  <div class="note">${s.syncUrl ? `메일로 온 발주서·견적요청·장애요청·유지보수 변경은 클로드가 하루 몇 번 메일함을 읽고 구글 시트로 보내 두면, 앱을 열 때 자동으로 여기 들어옵니다. 마지막 받은 시각: ${s.lastInbox ? new Date(s.lastInbox).toLocaleString('ko-KR') : '-'}` : '⚙설정에서 구글 시트를 연결하면 메일로 온 발주·요청이 자동으로 들어옵니다.'}</div>`;
}
const statusBadge = st => `<span class="badge ${st === '접수' ? 'org' : st === '진행' ? 'blue' : st === '취소' ? '' : 'grn'}">${esc(st)}</span>`;
function orderForm(o) {
  o = o || { date: todayStr(), kind: '발주', status: '접수' }; const isNew = !o.id;
  formSheet(isNew ? '발주·요청 입력' : '발주·요청', [
    { k: 'date', label: '받은 날', type: 'date', value: o.date }, { k: 'kind', label: '종류', type: 'select', options: ORDER_KINDS, value: o.kind },
    { k: 'status', label: '상태', type: 'select', options: ORDER_STATUS, value: o.status }, { k: 'title', label: '건명', value: o.title },
    { k: 'client', label: '발주처 (계산서 받을 곳)', value: o.client }, { k: 'customer', label: '최종 고객·사이트', value: o.customer },
    { k: 'siteId', label: '연결 사이트', type: 'select', options: [['', '(없음)'], ...DB.sites.map(s => [s.id, s.name])], value: o.siteId },
    { k: 'amount', label: '금액 (공급가액)', type: 'number', value: o.amount }, { k: 'dueDate', label: '납기·작업일', type: 'date', value: o.dueDate },
    { k: 'summary', label: '내용', type: 'textarea', value: o.summary }, { k: 'contact', label: '담당자', value: o.contact },
  ], v => { if (!v.title) { toast('건명을 입력하세요'); return false; } if (isNew) DB.orders.push({ id: uid('o'), source: 'manual', ...v }); else Object.assign(o, v); toast('저장했습니다'); },
    (o.mailUrl ? `<a class="btn ghost" target="_blank" href="${esc(o.mailUrl)}">메일 보기</a>` : '') + (isNew ? '' : (o.kind === '견적요청' ? `<button class="btn grn" type="button" onclick="quoteFromOrder('${o.id}')">견적서 작성</button>` : '') + (o.kind === '발주' || o.kind === '장애·점검요청' ? `<button class="btn ghost" type="button" onclick="closeSheet();billPrep({orderId:'${o.id}'})">계산서 발행 준비</button>` : '') + `<button class="btn ghost" type="button" onclick="orderToEvent('${o.id}')">작업 기록으로</button><button class="btn red" type="button" onclick="delOrder('${o.id}')">삭제</button>`));
}
async function delOrder(id) { if (!confirm('삭제할까요?')) return; DB.orders = DB.orders.filter(x => x.id !== id); closeSheet(); await save(); render(); }
function orderToEvent(id) { const o = DB.orders.find(x => x.id === id); closeSheet(); eventForm({ siteId: o.siteId, date: todayStr(), type: o.kind === '장애·점검요청' ? '장애처리' : '기술지원', title: o.title, memo: o.summary }); }
function changeSheet(id) {
  const c = DB.changes.find(x => x.id === id); const s = DB.sites.find(x => x.id === c.siteId);
  const labels = { amount: '금액', cycle: '주기', contract: '계약 기간', endMonth: '종료 월', startMonth: '시작 월', equipment: '장비', contact: '담당자', note: '메모', active: '진행 여부' };
  const rows = Object.entries(c.changes || {}).map(([k, v]) => `<div>${labels[k] || k}</div><div>${s ? esc(String(s[k] ?? '-')) + ' → ' : ''}<b>${esc(String(v))}</b></div>`).join('');
  openSheet(`<h2>유지보수 변경 확인</h2><div class="kv"><div>메일</div><div>${c.date} · ${esc(c.from || '')}<br>${esc(c.subject || '')}</div><div>사이트</div><div>${s ? esc(s.name) : '<span class="red">사이트를 못 찾음</span>'}</div><div>요약</div><div>${esc(c.summary || '')}</div>${rows}</div>
  <div class="btns">${s && rows ? `<button class="btn grn" onclick="applyChange('${id}')">사이트에 반영</button>` : ''}${s ? `<button class="btn ghost" onclick="closeSheet();siteForm(DB.sites.find(x=>x.id==='${s.id}'))">직접 수정</button>` : `<button class="btn ghost" onclick="closeSheet();siteForm()">새 사이트로 등록</button>`}
  ${c.mailUrl ? `<a class="btn ghost" target="_blank" href="${esc(c.mailUrl)}">메일 보기</a>` : ''}<button class="btn ghost" onclick="dismissChange('${id}')">확인 완료(반영 안 함)</button></div>`);
}
async function applyChange(id) {
  const c = DB.changes.find(x => x.id === id); const s = DB.sites.find(x => x.id === c.siteId);
  for (const [k, v] of Object.entries(c.changes || {})) if (k !== 'note') s[k] = k === 'amount' ? Number(v) || s.amount : k === 'active' ? !!v : v;
  s.note = ((s.note || '') + `\n${c.date} 메일 반영: ${(c.changes || {}).note || c.summary || c.subject}`).trim();
  DB.events.push({ id: uid('e'), siteId: s.id, date: c.date, type: '기타', title: '유지보수 변경', memo: c.summary || c.subject });
  c.done = 'applied'; closeSheet(); await save(); render(); toast('사이트에 반영했습니다');
}
async function dismissChange(id) { DB.changes.find(x => x.id === id).done = 'dismissed'; closeSheet(); await save(); render(); }
function findSite(name) {
  if (!name) return null; const n = normName(name);
  return DB.sites.find(s => normName(s.name) === n) || DB.sites.find(s => { const a = normName(s.name.replace(/\(.*\)/, '')); return a.length >= 2 && (n.includes(a) || a.includes(n)); }) || null;
}
// 메일 수신함 → 발주·요청 / 유지보수 변경으로 자동 반영
function applyInboxItems(items) {
  let o = 0, c = 0, ev = 0; DB.mailSeen = DB.mailSeen || [];
  for (const it of items) {
    const key = it.mailId || it.id; if (!key || DB.mailSeen.includes(key)) continue; DB.mailSeen.push(key);
    const site = findSite(it.siteName) || findSite(it.customer);
    if (it.kind === '점검완료' && site) { // 점검보고서 메일 → 이번 달 점검 완료로 기록
      if (!DB.events.some(e => e.siteId === site.id && ymOf(e.date) === ymOf(it.date || todayStr()) && INSPECT_TYPES.includes(e.type))) { DB.events.push({ id: uid('e'), siteId: site.id, date: it.date || todayStr(), type: '정기점검', title: it.title || it.subject, memo: (it.summary || '') + ' (메일 자동 기록)' }); ev++; }
      continue;
    }
    if (it.kind === '유지보수변경') { DB.changes.push({ id: uid('c'), date: it.date, from: it.from, subject: it.subject, summary: it.summary, siteId: site ? site.id : '', siteName: site ? site.name : (it.siteName || it.customer || ''), customer: it.customer, changes: it.changes || {}, mailUrl: it.mailUrl }); c++; }
    else { DB.orders.push({ id: uid('o'), source: 'mail', mailId: key, date: it.date || todayStr(), kind: ORDER_KINDS.includes(it.kind) ? it.kind : '기타', status: ORDER_STATUS.includes(it.status) ? it.status : '접수', title: it.title || it.subject, client: it.client || '', customer: it.customer || '', siteId: site ? site.id : '', amount: Number(it.amount) || 0, dueDate: it.dueDate || '', summary: it.summary || '', contact: it.from || '', mailUrl: it.mailUrl || '' }); o++; }
  }
  return { o, c, ev };
}
async function pullInbox(silent) {
  const s = DB.settings; if (!s.syncUrl) { if (!silent) toast('⚙설정에서 구글 시트를 먼저 연결하세요'); return; }
  try {
    const r = await fetch(s.syncUrl + (s.syncUrl.includes('?') ? '&' : '?') + 'inbox=1&token=' + encodeURIComponent(s.syncToken)); const j = await r.json(); if (!j.ok) throw new Error(j.error || '실패');
    const items = j.items || []; const res = applyInboxItems(items); s.lastInbox = new Date().toISOString(); if (items.length) await save(); else await persist();
    if (items.length) await fetch(s.syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: s.syncToken, action: 'ack', ids: items.map(x => x.mailId || x.id) }) });
    render(); if (!silent || res.o || res.c || res.ev) toast(`메일에서 발주·요청 ${res.o}건, 유지보수 변경 ${res.c}건, 점검완료 ${res.ev}건을 받았습니다`);
  } catch (e) { if (!silent) alert('메일 업무 받기 실패: ' + e.message); }
}
async function importInboxFile() {
  const f = await pickFile('.json'); if (!f) return;
  try { const j = JSON.parse(await f.text()); const res = applyInboxItems(Array.isArray(j) ? j : j.items || []); await save(); render(); toast(`발주·요청 ${res.o}건, 변경 ${res.c}건, 점검완료 ${res.ev}건 추가`); } catch (e) { alert('불러오기 실패: ' + e.message); }
}

/* ---------------- 견적서 ---------------- */
const QUOTE_STATUS = ['작성', '발송', '수주', '실주'];
const QUOTE_TEMPLATES = {
  '유지보수': ' 1. 유지보수 기간 : (시작) ~ (종료) (00개월)\n 2. HW 장애 시 장애처리 및 기술지원\n 3. 24 x 7 장애 지원\n 4. 월 정기점검 (방문)\n 5. 세금계산서 매월 말 발행, 발행 후 익월 말 현금 결제',
  '납품': ' 1. 납기 : 발주 후 0주 이내\n 2. 납품 장소 : 귀사 지정 장소\n 3. 무상 보증 : 납품 후 1년\n 4. 결제 조건 : 납품 후 익월 말 현금 결제',
  '기술지원': ' 1. 작업 일정 : 협의\n 2. 작업 내용 : \n 3. 작업 완료 후 세금계산서 발행, 익월 말 현금 결제',
};
function quoteDefaults() {
  return { date: todayStr(), validDays: 30, status: '작성', to: '', attn: '', tel: '', email: '', title: '', unitNote: '(단위 : 원 / VAT 별도)', months: 0,
    items: [{ maker: '', model: '', qty: 1, period: '', unit: 0, amount: 0, note: '' }], conditions: QUOTE_TEMPLATES['유지보수'] };
}
function quoteTotals(q) { const sup = (q.items || []).reduce((a, it) => a + (Number(it.amount) || 0), 0); const vat = Math.round(sup * 0.1); return { sup, vat, tot: sup + vat }; }
function viewQuotes() {
  const list = (DB.quotes || []).slice().sort((a, b) => b.date.localeCompare(a.date) || (b.no || '').localeCompare(a.no || ''));
  return `<div class="btns"><button class="btn" onclick="quoteEdit()">+ 새 견적서</button></div>
  <div class="card"><h3>견적서 ${list.length}건 <span class="sub" style="font-size:12px;font-weight:400">수주 ${won(list.filter(q => q.status === '수주').reduce((a, q) => a + quoteTotals(q).sup, 0))}원</span></h3>
  ${list.map(q => row(`${esc(q.title || '(건명 없음)')} <span class="badge ${q.status === '수주' ? 'grn' : q.status === '발송' ? 'blue' : q.status === '실주' ? '' : 'org'}">${esc(q.status)}</span>`, `${q.date} · ${esc(q.to)}${q.no ? ' · ' + esc(q.no) : ''}`, won(quoteTotals(q).sup), `onclick="quoteEdit('${q.id}')"`)).join('') || '<div class="empty">아직 견적서가 없습니다</div>'}</div>
  <div class="note">견적서를 작성하고 “PDF 저장/인쇄”를 누르면 이포트텍 양식으로 출력됩니다. 인쇄 창에서 대상을 “PDF로 저장”으로 고르면 파일이 됩니다.</div>`;
}
let QD = null; // 편집 중인 견적서
function quoteEdit(id, preset) {
  const src = id ? DB.quotes.find(x => x.id === id) : null;
  QD = src ? JSON.parse(JSON.stringify(src)) : Object.assign(quoteDefaults(), preset || {});
  renderQuoteSheet();
}
function renderQuoteSheet() {
  const q = QD, t = quoteTotals(q);
  const inp = (k, label, type = 'text', ph = '') => `<label class="f">${label}<input data-q="${k}" type="${type}" value="${esc(q[k] ?? '')}" placeholder="${esc(ph)}"></label>`;
  openSheet(`<h2>${q.id ? '견적서 수정' : '새 견적서'}</h2>
  <div class="grid2">${inp('date', '견적 날짜', 'date')}${inp('validDays', '유효기간(일)', 'number')}</div>
  ${inp('title', '건명', 'text', '예: 대한적십자사 혈액관리본부 2026~2028년 스토리지 유지보수 (24개월)')}
  <div class="grid2">${inp('to', '수신 (회사)', 'text', '마이티시스템')}${inp('attn', '담당자', 'text', '김영규 전무님')}</div>
  <div class="grid2">${inp('tel', '연락처')}${inp('email', '이메일')}</div>
  <div class="grid2"><label class="f">상태<select data-q="status">${QUOTE_STATUS.map(s => `<option ${s === q.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label>${inp('unitNote', '단위 표시')}</div>
  <h3 style="font-size:14px;margin:6px 0">품목 <span class="sub" style="font-weight:400;font-size:12px">금액 = 수량 × 단가 × 개월(기간에 숫자) 자동, 직접 고쳐도 됨</span></h3>
  <div id="qItems">${q.items.map((it, i) => `<div class="card" style="padding:10px;background:#f7f9fc">
    <div class="grid2"><input data-i="${i}" data-k="maker" placeholder="제조사" value="${esc(it.maker)}"><input data-i="${i}" data-k="model" placeholder="기종·품목" value="${esc(it.model)}"></div>
    <div class="grid2" style="margin-top:6px"><input data-i="${i}" data-k="qty" inputmode="numeric" placeholder="수량" value="${esc(it.qty)}"><input data-i="${i}" data-k="period" placeholder="기간 (예: 24개월)" value="${esc(it.period)}"></div>
    <div class="grid2" style="margin-top:6px"><input data-i="${i}" data-k="unit" inputmode="numeric" placeholder="단가 (월 단가)" value="${it.unit ? won(it.unit) : ''}"><input data-i="${i}" data-k="amount" inputmode="numeric" placeholder="금액" value="${it.amount ? won(it.amount) : ''}"></div>
    <div style="display:flex;gap:6px;margin-top:6px"><input data-i="${i}" data-k="note" placeholder="비고" value="${esc(it.note)}"><button class="btn sm ghost" type="button" onclick="quoteItem(${i},-1)">삭제</button></div></div>`).join('')}</div>
  <div class="btns"><button class="btn sm ghost" type="button" onclick="quoteItem(-1,1)">+ 품목 추가</button></div>
  <div class="kv" style="margin:8px 0"><div>공급가액</div><div><b id="qSup">${won(t.sup)}</b>원</div><div>부가세</div><div id="qVat">${won(t.vat)}원</div><div>합계</div><div id="qTot">${won(t.tot)}원</div></div>
  <label class="f">견적 조건 <span style="float:right">${Object.keys(QUOTE_TEMPLATES).map(k => `<a href="javascript:quoteTpl('${k}')" style="margin-left:8px">${k}</a>`).join('')}</span><textarea data-q="conditions" style="min-height:140px">${esc(q.conditions)}</textarea></label>
  <div class="btns"><button class="btn" onclick="quoteSave()">저장</button><button class="btn grn" onclick="quoteSave(true)">PDF 저장/인쇄</button>${q.id ? `<button class="btn ghost" onclick="quoteMail()">메일 쓰기</button><button class="btn ghost" onclick="quoteCopy()">복사해서 새로</button>${q.status === '수주' ? '' : `<button class="btn ghost" onclick="quoteWon()">수주 처리</button>`}<button class="btn red" onclick="quoteDel()">삭제</button>` : ''}<button class="btn ghost" onclick="closeSheet()">닫기</button></div>`);
  document.querySelectorAll('#sheet [data-q]').forEach(el => el.oninput = el.onchange = () => { QD[el.dataset.q] = el.type === 'number' ? Number(el.value) : el.value; });
  document.querySelectorAll('#sheet [data-i]').forEach(el => el.oninput = () => {
    const it = QD.items[el.dataset.i], k = el.dataset.k;
    it[k] = ['qty', 'unit', 'amount'].includes(k) ? toNum(el.value) : el.value;
    if (k !== 'amount' && (it.unit || 0) > 0) { const m = Number((String(it.period).match(/\d+/) || [1])[0]) || 1; it.amount = (Number(it.qty) || 0) * it.unit * m; const a = document.querySelector(`#sheet [data-i="${el.dataset.i}"][data-k="amount"]`); if (a) a.value = won(it.amount); }
    const t = quoteTotals(QD); $('#qSup').textContent = won(t.sup); $('#qVat').textContent = won(t.vat) + '원'; $('#qTot').textContent = won(t.tot) + '원';
  });
}
function quoteItem(i, d) { if (d > 0) QD.items.push({ maker: '', model: '', qty: 1, period: QD.items[0] ? QD.items[0].period : '', unit: 0, amount: 0, note: '' }); else QD.items.splice(i, 1); renderQuoteSheet(); }
function quoteTpl(k) { if (QD.conditions && QD.conditions.trim() && !confirm('견적 조건을 “' + k + '” 기본 문구로 바꿀까요?')) return; QD.conditions = QUOTE_TEMPLATES[k]; renderQuoteSheet(); }
async function quoteSave(print) {
  const q = QD; if (!q.title) { toast('건명을 입력하세요'); return; }
  if (!q.id) { q.id = uid('q'); const ymd = q.date.replace(/-/g, ''); const n = (DB.quotes || []).filter(x => (x.no || '').startsWith(ymd)).length + 1; q.no = `${ymd}-${String(n).padStart(2, '0')}`; DB.quotes.push(q); }
  else Object.assign(DB.quotes.find(x => x.id === q.id), q);
  await save(); if (print) quotePrint(q); else { closeSheet(); render(); toast('저장했습니다'); }
}
async function quoteDel() { if (!confirm('견적서를 삭제할까요?')) return; DB.quotes = DB.quotes.filter(x => x.id !== QD.id); closeSheet(); await save(); render(); }
function quoteCopy() { const c = JSON.parse(JSON.stringify(QD)); delete c.id; delete c.no; c.date = todayStr(); c.status = '작성'; QD = c; renderQuoteSheet(); toast('복사본입니다. 고친 뒤 저장하세요'); }
async function quoteWon() {
  const q = DB.quotes.find(x => x.id === QD.id); q.status = '수주';
  DB.orders.push({ id: uid('o'), source: 'quote', quoteId: q.id, date: todayStr(), kind: '발주', status: '접수', title: q.title, client: q.to, customer: '', amount: quoteTotals(q).sup, summary: `견적서 ${q.no} 수주`, contact: q.attn });
  closeSheet(); await save(); render();
  if (/유지보수|유지관리/.test((q.title || '') + (q.conditions || ''))) { siteForm(siteFromQuote(q)); toast('수주 처리했습니다. 유지보수 사이트로 등록할 내용을 확인하고 저장하세요'); }
  else toast('수주 처리하고 발주 목록에 넣었습니다');
}
function quoteMail() {
  const q = QD, t = quoteTotals(q), s = DB.settings;
  const body = `${q.attn || ''}\n\n안녕하세요. ${s.company || '이포트텍'} ${s.owner || ''}입니다.\n요청하신 "${q.title}" 견적서를 첨부와 같이 보내드립니다.\n\n- 공급가액: ${won(t.sup)}원 (VAT 별도)\n- 유효기간: 견적일로부터 ${q.validDays || 30}일\n\n검토 부탁드립니다. 감사합니다.\n\n${s.owner || ''} 드림\n${s.tel || ''}`;
  location.href = `mailto:${encodeURIComponent(q.email || '')}?subject=${encodeURIComponent('[' + (s.company || '이포트텍') + '] ' + q.title + ' 견적서')}&body=${encodeURIComponent(body)}`;
  toast('PDF로 저장한 견적서를 메일에 첨부해 보내세요');
}
function quotePrint(q) {
  const s = DB.settings, t = quoteTotals(q);
  const r = (a, b, c) => `<tr><td class="lb">${a}</td><td>${b}</td><td class="me">${c}</td></tr>`;
  const months = (q.items.find(it => /\d/.test(it.period || '')) || {}).period || '';
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>견적서_${esc(q.to)}_${esc(q.title)}_${q.date.replace(/-/g, '')}</title><style>
  @page{size:A4;margin:14mm 12mm}body{font-family:"Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#000;font-size:12px;margin:0}
  h1{text-align:center;letter-spacing:28px;font-size:28px;margin:6px 0 18px;text-decoration:underline;text-underline-offset:8px}
  .hd{width:100%;border-collapse:collapse;margin-bottom:12px}.hd td{padding:5px 4px;vertical-align:top}.hd .lb{width:84px;white-space:nowrap}.hd .me{text-align:left;width:46%}
  .co{font-size:16px;font-weight:700}.say{text-align:center;font-weight:700;letter-spacing:6px;margin:12px 0}
  .tt{display:flex;justify-content:space-between;font-weight:700;margin:8px 0}
  table.it{width:100%;border-collapse:collapse}table.it th,table.it td{border:1px solid #333;padding:7px 5px;text-align:center}table.it th{background:#e8edf3}
  table.it td.n{text-align:right}table.it .sum td{font-weight:700;background:#f6f8fb}table.it .sum td:first-child{text-align:center;letter-spacing:4px}
  .cond{margin-top:14px;white-space:pre-wrap;line-height:1.8}.end{text-align:center;margin-top:24px;letter-spacing:4px}
  .bar{position:fixed;top:0;left:0;right:0;background:#1f4e79;color:#fff;padding:8px;text-align:center}.bar button{font-size:15px;padding:6px 14px;margin:0 4px}
  @media print{.bar{display:none}}@media screen{body{padding:56px 16px 20px;max-width:800px;margin:0 auto}}
  </style></head><body><div class="bar"><button onclick="print()">PDF 저장 / 인쇄</button><button onclick="close()">닫기</button></div>
  <h1>견적서</h1>
  <table class="hd">${r('수 신 :', esc(q.to), `<span class="co">${esc(s.company || '이포트텍')}</span>`)}${r('담 당 자 :', esc(q.attn), esc(s.address || ''))}${r('연 락 처 :', esc(q.tel), 'TEL : ' + esc(s.tel || ''))}${r('이 메 일 :', esc(q.email), '견적담당 : ' + esc(s.owner || '') + (s.tel ? ' (' + esc(s.tel) + ')' : ''))}${r('견적날짜 :', `${q.date} (유효기간 : 견적일로부터 ${q.validDays || 30}일)`, 'E-Mail : ' + esc(s.email || ''))}</table>
  <div class="say">아 래 와 같 이 견 적 합 니 다.</div>
  <div class="tt"><span>▣ 건 명 : ${esc(q.title)}</span><span style="font-weight:400">${esc(q.unitNote || '')}</span></div>
  <table class="it"><tr><th>제조사</th><th>기 종</th><th>수량</th><th>기간</th><th>단 가</th><th>금 액</th><th>비 고</th></tr>
  ${q.items.map(it => `<tr><td>${esc(it.maker)}</td><td>${esc(it.model)}</td><td>${esc(it.qty)}</td><td>${esc(it.period)}</td><td class="n">${it.unit ? won(it.unit) : ''}</td><td class="n">${it.amount ? won(it.amount) : ''}</td><td>${esc(it.note)}</td></tr>`).join('')}
  <tr class="sum"><td colspan="5">공 급 가 액${months ? ' ( ' + esc(months) + ' )' : ''}</td><td colspan="2" class="n">${won(t.sup)}원</td></tr>
  <tr class="sum"><td colspan="5">부 가 세 (10%)</td><td colspan="2" class="n">${won(t.vat)}원</td></tr>
  <tr class="sum"><td colspan="5">합 계 금 액 (VAT 포함)</td><td colspan="2" class="n">${won(t.tot)}원</td></tr></table>
  ${q.conditions ? `<div class="cond"><b>※ 견적 조건</b>\n${esc(q.conditions)}</div>` : ''}<div class="end">- 이 하 여 백 -</div>
  <script>setTimeout(()=>print(),400)<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { download(`견적서_${q.to}_${q.date}.html`, html, 'text/html'); toast('팝업이 막혀 파일로 저장했습니다. 열어서 인쇄하세요'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
// 발주·요청(견적요청)에서 견적서 바로 시작
function quoteFromOrder(id) {
  const o = DB.orders.find(x => x.id === id); closeSheet();
  const site = o.siteId ? DB.sites.find(s => s.id === o.siteId) : null;
  quoteEdit(null, { title: o.title, to: (o.client || '').replace(/\(.*\)/, '').trim(), email: /@/.test(o.contact || '') ? o.contact : '', orderId: o.id,
    items: [{ maker: '', model: site && site.equipment ? site.equipment : '', qty: 1, period: '', unit: 0, amount: 0, note: '' }] });
}

/* ---------------- 계산서 발행 준비 · 발행요청 (클로드가 홈택스에 채워 둠, 서명은 직접) ---------------- */
const pendingReqs = () => (DB.billReqs || []).filter(r => r.status === '요청');
const reqFor = (siteId, ym) => pendingReqs().find(r => r.siteId === siteId && r.ym === ym);
const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
// 품목명: 사이트의 "품목명 틀"이 있으면 그것, 없으면 지난 계산서 품목명에서 달(N월, N~M월, N분기)만 바꿈
function billItemFor(site, ym) {
  const m = Number(ym.slice(5)), y = ym.slice(0, 4);
  if (site.itemTpl) return site.itemTpl.replace(/\{사이트\}/g, site.name).replace(/\{0월\}/g, String(m).padStart(2, '0')).replace(/\{월\}/g, String(m)).replace(/\{년\}/g, y).replace(/\{분기\}/g, String(Math.ceil(m / 3)));
  const c = calc(); const list = (c.bySite[site.id] || []).filter(i => i.supply > 0 && !c.cancelled.has(i.id)).sort((a, b) => b.date.localeCompare(a.date));
  const last = list[0]; if (!last) return `${site.name} ${m}월 유지보수`;
  const k = monthsBetween(c.period[last.id] || ymOf(last.date), ym); if (!k) return last.item;
  const sh = (n) => { const v = ((Number(n) - 1 + k) % 12 + 12) % 12 + 1; return /^0\d/.test(n) ? String(v).padStart(2, '0') : String(v); };
  let t = last.item.replace(/(\d{1,2})(\s*[~\-]\s*)(\d{1,2})(\s*월)/g, (a, p, s1, q, w) => sh(p) + s1 + sh(q) + w);
  if (t === last.item) t = t.replace(/(\d{1,2}(?:\s*,\s*\d{1,2})+)(\s*월)/g, (a, list, w) => list.replace(/\d{1,2}/g, sh) + w);
  if (t === last.item) t = t.replace(/(^|[^0-9])(\d{1,2})(\s*월)(?!\s*\d+\s*일)/g, (a, pre, n, w) => Number(n) >= 1 && Number(n) <= 12 ? pre + sh(n) + w : a);
  const kq = Math.round(k / 3); if (kq) t = t.replace(/([1-4])(\s*분기)/g, (a, n, w) => String(((Number(n) - 1 + kq) % 4 + 4) % 4 + 1) + w);
  t = t.replace(/20\d\d(\s*년)/g, y + '$1');
  return t;
}
function lookupBizNo(name) {
  if (!name) return ''; const n = normName(name);
  const ct = (DB.contacts || []).find(x => normName(x.name) === n || (n.length >= 2 && normName(x.name).includes(n))); if (ct && ct.bizNo) return ct.bizNo;
  const iv = DB.invoices.filter(i => normName(i.name) === n || (n.length >= 3 && normName(i.name).includes(n))).sort((a, b) => b.date.localeCompare(a.date))[0];
  return iv ? iv.bizNo : '';
}
const contactOf = (bizNo, name) => (DB.contacts || []).find(x => (bizNo && x.bizNo === bizNo) || (!bizNo && name && normName(x.name) === normName(name))) || null;
function billPrep(p) {
  p = p || {}; DB.billReqs = DB.billReqs || [];
  let r = p.id ? DB.billReqs.find(x => x.id === p.id) : null;
  if (!r && p.siteId) r = reqFor(p.siteId, p.ym || ymOf(todayStr()));
  const isNew = !r;
  if (isNew) {
    r = { date: todayStr(), bizNo: '', name: '', item: '', supply: 0, memo: '', recv: '청구' };
    if (p.siteId) { const s = DB.sites.find(x => x.id === p.siteId); const ym = p.ym || ymOf(todayStr()); Object.assign(r, { siteId: s.id, ym, bizNo: s.bizNo || lookupBizNo(s.client), name: s.client, item: isAdhoc(s) ? `${s.name} 기술지원` : billItemFor(s, ym), supply: s.amount || 0 }); }
    if (p.orderId) { const o = DB.orders.find(x => x.id === p.orderId); Object.assign(r, { orderId: o.id, siteId: o.siteId || '', name: o.client || '', bizNo: lookupBizNo(o.client), item: o.title || '', supply: o.amount || 0 }); }
    const ct = contactOf(r.bizNo, r.name); if (ct && ct.taxEmail) r.memo = '수신 ' + ct.taxEmail;
  }
  formSheet(isNew ? '계산서 발행 준비' : '발행요청 수정', [
    { k: 'date', label: '작성일자', type: 'date', value: r.date },
    { k: 'name', label: '공급받는자 (거래처)', value: r.name },
    { k: 'bizNo', label: '사업자번호', value: r.bizNo, ph: '000-00-00000' },
    { k: 'itemName', label: '품목명', value: r.item },
    { k: 'supply', label: '공급가액 (부가세 10%는 자동)', type: 'number', value: r.supply },
    { k: 'recv', label: '영수/청구', type: 'select', options: ['청구', '영수'], value: r.recv || '청구' },
    { k: 'memo', label: '메모 (수신 메일 등, 클로드가 참고)', value: r.memo },
  ], o => {
    o.item = o.itemName; delete o.itemName;
    if (!o.name || !o.supply) { toast('거래처와 공급가액을 입력하세요'); return false; }
    if (!o.bizNo) o.bizNo = lookupBizNo(o.name);
    if (!/^\d{3}-?\d{2}-?\d{5}$/.test(o.bizNo || '')) { toast('사업자번호를 확인하세요 (000-00-00000)'); return false; }
    o.bizNo = o.bizNo.replace(/^(\d{3})-?(\d{2})-?(\d{5})$/, '$1-$2-$3'); o.tax = Math.round(o.supply * 0.1); o.total = o.supply + o.tax;
    if (isNew) DB.billReqs.push({ id: uid('r'), status: '요청', created: new Date().toISOString(), siteId: r.siteId || '', ym: r.ym || '', orderId: r.orderId || '', ...o });
    else Object.assign(r, o);
    toast('발행요청에 넣었습니다. 클로드에게 “발행요청 처리”라고 하면 홈택스에 채워 둡니다');
  }, `<button class="btn ghost" type="button" onclick="reqCopyForm()">글로 복사</button>${isNew ? '' : `<button class="btn red" type="button" onclick="reqCancel('${r.id}')">요청 취소</button>`}`);
}
function reqText(r) { return `${r.date} ${r.name} (${r.bizNo}) / ${r.item} / 공급가 ${won(r.supply)} + 세액 ${won(Math.round(r.supply * 0.1))} = ${won(r.supply + Math.round(r.supply * 0.1))}원 (${r.recv || '청구'})${r.memo ? ' / ' + r.memo : ''}`; }
function copyText(t) { (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('복사했습니다'), () => { prompt('복사하세요', t); }); }
function reqCopyForm() { const f = $('#fm').elements; copyText(reqText({ date: f.date.value, name: f.name.value, bizNo: f.bizNo.value, item: f.itemName.value, supply: toNum(f.supply.value), recv: f.recv.value, memo: f.memo.value })); }
async function reqCancel(id) { const r = DB.billReqs.find(x => x.id === id); r.status = '취소'; closeSheet(); await save(); render(); toast('요청을 취소했습니다'); }
async function billPrepAll(ym) {
  const st = billingStatus(ym).filter(x => !x.done && !reqFor(x.site.id, ym)); DB.billReqs = DB.billReqs || [];
  for (const x of st) { const s = x.site; const ct = contactOf(s.bizNo, s.client); const sup = s.amount || 0;
    DB.billReqs.push({ id: uid('r'), status: '요청', created: new Date().toISOString(), siteId: s.id, ym, orderId: '', date: todayStr(), name: s.client, bizNo: s.bizNo || lookupBizNo(s.client), item: billItemFor(s, ym), supply: sup, tax: Math.round(sup * 0.1), total: sup + Math.round(sup * 0.1), recv: '청구', memo: ct && ct.taxEmail ? '수신 ' + ct.taxEmail : '' }); }
  await save(); render(); toast(`${st.length}건을 발행요청에 넣었습니다`);
}
function reqView() {
  const pend = pendingReqs().sort((a, b) => a.date.localeCompare(b.date)), done = (DB.billReqs || []).filter(r => r.status !== '요청').sort((a, b) => (b.doneAt || b.created || '').localeCompare(a.doneAt || a.created || '')).slice(0, 20);
  const sum = pend.reduce((a, r) => a + r.supply, 0);
  return `<div class="card"><h3>발행 대기 ${pend.length}건 <span class="sub" style="font-size:12px;font-weight:400">공급가 ${won(sum)}원</span></h3>
  ${pend.map(r => row(`${esc(r.item)}`, `${r.date} · ${esc(r.name)} ${esc(r.bizNo)}${r.memo ? ' · ' + esc(r.memo) : ''}`, `${won(r.supply)}<br><small class="sub">+세 ${won(Math.round(r.supply * 0.1))}</small>`, `onclick="billPrep({id:'${r.id}'})"`)).join('') || '<div class="empty">대기 중인 발행요청이 없습니다</div>'}
  <div class="btns"><button class="btn ghost" onclick="billPrep({})">+ 발행 준비</button>${pend.length ? `<button class="btn ghost" onclick="copyText(pendingReqs().map(reqText).join('\\n'))">모두 글로 복사</button>` : ''}</div>
  <div class="note">클로드에게 <b>“발행요청 처리”</b>라고 하면 이 목록을 읽어 홈택스 건별발급 화면에 채우고 “인증 요청” 직전까지 준비합니다. 휴대폰에서 승인(서명)하시면 발급되고, 승인번호를 읽어 계산서 목록에 넣은 뒤 여기서 ‘발행’으로 바뀝니다. 홈택스 파일을 올려도 같은 거래처·금액 계산서가 있으면 자동으로 ‘발행’ 처리됩니다.</div></div>
  ${done.length ? `<div class="card"><h3>최근 처리</h3>${done.map(r => row(`${esc(r.item)} <span class="badge ${r.status === '발행' ? 'grn' : ''}">${esc(r.status)}</span>`, `${r.date} · ${esc(r.name)}${r.invId ? ' · ' + esc(r.invId) : ''}`, won(r.supply), r.invId ? `onclick="invDetail('${r.invId}')"` : '')).join('')}</div>` : ''}`;
}
// 발행요청 ↔ 실제 계산서: 같은 사업자번호·공급가액, 요청 작성일 7일 전 이후 계산서면 발행 완료로 표시
function reconcileBillReqs() {
  let n = 0; const used = new Set((DB.billReqs || []).filter(r => r.invId).map(r => r.invId));
  for (const r of pendingReqs()) {
    const from = (() => { const d = new Date(r.date); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10); })();
    const cands = DB.invoices.filter(i => i.kind === '매출' && !used.has(i.id) && i.bizNo === r.bizNo && i.supply === r.supply && i.date >= from);
    const inv = cands.find(i => i.item.replace(/\s/g, '') === String(r.item).replace(/\s/g, '')) || (cands.length === 1 ? cands[0] : null);
    if (inv) { r.status = '발행'; r.invId = inv.id; r.doneAt = new Date().toISOString(); used.add(inv.id); n++;
      if (r.siteId && !inv.siteId) { const s = siteForInvoice(inv); if (!s || s.id !== r.siteId) inv.siteId = r.siteId; }
      if (r.orderId) { const o = DB.orders.find(x => x.id === r.orderId); if (o && o.status !== '취소') o.status = '계산서발행'; } }
  }
  if (n) invalidate(); return n;
}
// 선입금: 남은 금액이 있으면 같은 거래처의 새 계산서(오래된 것부터)를 자동 연결
function applyPrepaid() {
  let n = 0;
  for (const d of DB.deposits.filter(x => x.prepaid)) {
    invalidate(); let credit = calc().credit[d.id] || 0; if (credit <= 0) continue;
    const biz = d.payer || (DB.invoices.find(i => i.id === (d.invIds || [])[0]) || {}).bizNo;
    const open = receivables().map(x => x.inv).filter(i => (biz ? i.bizNo === biz : normName(i.name).includes(normName(d.name))) && i.total <= credit).sort((a, b) => a.date.localeCompare(b.date));
    for (const i of open) { if (i.total > credit) continue; d.invIds = [...(d.invIds || []), i.id]; credit -= i.total; n++; }
  }
  invalidate(); return n;
}
let _recBusy = false;
function autoReconcile() { if (_recBusy || !DB) return 0; _recBusy = true; try { return (pendingReqs().length ? reconcileBillReqs() : 0) + (DB.deposits.some(d => d.prepaid) ? applyPrepaid() : 0); } finally { _recBusy = false; } }
function prepaidCard() {
  const c = calc(); const l = DB.deposits.filter(d => d.prepaid && (c.credit[d.id] || 0) > 0);
  return l.length ? `<div class="card"><h3>선입금 잔액 ${l.length}건 <span>${won(l.reduce((a, d) => a + c.credit[d.id], 0))}원</span></h3>${l.map(d => row(esc(d.name), `${d.date} 입금 ${won(d.amount)} · 연결 ${(d.invIds || []).length}건`, won(c.credit[d.id]), `onclick="matchDeposit('${d.id}')"`)).join('')}<div class="note">같은 거래처 계산서가 새로 발행되면 자동으로 연결됩니다.</div></div>` : '';
}

/* ---------------- 홈: 오늘 할 일 · 미수 알림 · 보증 만료 ---------------- */
function todoList() {
  const ym = ymOf(todayStr()), bill = billingStatus(ym).filter(x => !x.done), noReq = bill.filter(x => !reqFor(x.site.id, ym));
  const late = inspectStatus(ym).filter(x => x.late), ar60 = receivables().filter(x => x.age > 60), ar30 = receivables().filter(x => x.age > 30 && x.age <= 60);
  const wr = warrantySoon(), low = DB.parts.filter(p => (p.qty || 0) <= (p.minQty || 0) && (p.minQty || 0) > 0), pend = pendingReqs();
  const t = [];
  if (noReq.length) t.push(['🧾', `${Number(ym.slice(5))}월 계산서 미발행 ${noReq.length}건 (${man(noReq.reduce((a, x) => a + x.site.amount, 0))}원)`, '#invoices/month', 'org']);
  if (pend.length) t.push(['✍', `발행요청 ${pend.length}건 서명 대기`, '#invoices/req', 'blue']);
  if (late.length) t.push(['📅', `예정일 지난 미점검 ${late.length}곳`, '#schedule', 'red']);
  if (ar60.length) t.push(['💰', `60일 넘은 미수금 ${ar60.length}건 (${man(ar60.reduce((a, x) => a + x.inv.total, 0))}원)`, '#ar', 'red']);
  if (ar30.length) t.push(['💰', `30일 넘은 미수금 ${ar30.length}건`, '#ar', 'org']);
  if (wr.length) t.push(['🛡', `장비 보증 만료 임박 ${wr.length}대`, '#sites', 'org']);
  if (low.length) t.push(['📦', `재고 부족 ${low.length}품목`, '#parts', 'org']);
  return t;
}
function todayCard() {
  const t = todoList();
  return `<div class="card today"><h3>오늘 할 일 <span class="sub" style="font-size:12px;font-weight:400">${todayStr().slice(5).replace('-', '/')}</span></h3>${t.map(([i, txt, h, cl]) => `<div class="row click" onclick="go('${h}')"><div class="l"><b><span style="margin-right:6px">${i}</span><span class="${cl}">${esc(txt)}</span></b></div><div class="r sub">›</div></div>`).join('') || '<div class="empty">할 일이 없습니다 👍</div>'}</div>`;
}
function setBadge() { try { const n = todoList().length; if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) { } }
function dunCard() {
  const ar = receivables().filter(x => x.age > 30); if (!ar.length) return '';
  const g = {}; for (const x of ar) { const k = x.inv.bizNo || x.inv.name; const o = g[k] = g[k] || { k, name: x.inv.name, n: 0, sum: 0, age: 0 }; o.n++; o.sum += x.inv.total; o.age = Math.max(o.age, x.age); }
  const l = Object.values(g).sort((a, b) => b.age - a.age);
  return `<div class="card" style="margin-top:12px;border-left:4px solid var(--red)"><h3>입금 확인 필요 (30일+) <a href="#ar">미수금</a></h3>${l.map(x => { const dn = (DB.dunning || {})[x.k]; return row(`${esc(x.name)} <span class="badge ${x.age > 60 ? 'red' : 'org'}">${x.age}일</span>`, `${x.n}건${dn ? ' · 요청 메일 ' + dn.slice(5) : ''}`, `${won(x.sum)}<br><button class="btn sm ghost" onclick="event.stopPropagation();dunMail('${esc(x.k)}')">입금 요청</button>`, `onclick="go('#client/${encodeURIComponent(x.k)}')"`); }).join('')}</div>`;
}
async function dunMail(key) {
  const ar = receivables().filter(x => (x.inv.bizNo || x.inv.name) === key); if (!ar.length) return;
  const ct = contactOf(ar[0].inv.bizNo, ar[0].inv.name) || {}; const s = DB.settings;
  const lines = ar.map(x => `- ${x.inv.date} ${x.inv.item} : ${won(x.inv.total)}원`).join('\n');
  const body = `${ct.person ? ct.person + ' ' + (ct.title || '') + '님' : '담당자님'}\n\n안녕하세요. ${s.company || '이포트텍'} ${s.owner || ''}입니다.\n아래 세금계산서 대금이 아직 확인되지 않아 연락드립니다.\n\n${lines}\n합계 ${won(ar.reduce((a, x) => a + x.inv.total, 0))}원 (부가세 포함)\n\n이미 처리하셨다면 양해 부탁드리며, 지급 예정일을 알려주시면 감사하겠습니다.\n\n${s.owner || ''} 드림\n${s.tel || ''}`;
  DB.dunning = DB.dunning || {}; DB.dunning[key] = todayStr(); await save();
  location.href = `mailto:${encodeURIComponent(ct.email || '')}?subject=${encodeURIComponent(`[${s.company || '이포트텍'}] 세금계산서 대금 확인 요청`)}&body=${encodeURIComponent(body)}`;
  if (!ct.email) toast('거래처 이메일이 없습니다. 거래처 화면에서 넣어 두면 다음부터 자동으로 들어갑니다');
}

/* ---------------- 사이트 탭: 사이트 · 거래처 · 수익 ---------------- */
function sitesSeg(on) { return `<div class="seg"><a href="#sites" class="${on === 'sites' ? 'on' : ''}">사이트</a><a href="#clients" class="${on === 'clients' ? 'on' : ''}">거래처</a><a href="#profit" class="${on === 'profit' ? 'on' : ''}">사이트별 수익</a></div>`; }
function siteProfit(s, yr) {
  const c = calc(), inYr = d => !yr || d.startsWith(yr);
  const sales = (c.bySite[s.id] || []).filter(i => inYr(i.date) && !c.cancelled.has(i.id)).reduce((a, i) => a + i.supply, 0);
  const buy = (c.costBySite[s.id] || []).filter(i => inYr(i.date)).reduce((a, i) => a + i.supply, 0);
  const parts = DB.events.filter(e => e.siteId === s.id && e.partId && inYr(e.date)).reduce((a, e) => a + ((DB.parts.find(p => p.id === e.partId) || {}).cost || 0) * (e.partQty || 0), 0);
  return { sales, buy, parts, cost: buy + parts, profit: sales - buy - parts };
}
let profYr = null;
function viewProfit() {
  const years = [...new Set(DB.invoices.map(i => i.date.slice(0, 4)))].sort().reverse(); const yr = profYr || todayStr().slice(0, 4);
  const l = DB.sites.map(s => ({ s, ...siteProfit(s, yr === '전체' ? '' : yr) })).filter(x => x.sales || x.cost).sort((a, b) => b.profit - a.profit);
  const tot = l.reduce((a, x) => ({ sales: a.sales + x.sales, cost: a.cost + x.cost }), { sales: 0, cost: 0 });
  const unl = DB.invoices.filter(i => i.kind === '매입' && !i.siteId && (yr === '전체' || i.date.startsWith(yr))).sort((a, b) => b.date.localeCompare(a.date));
  return sitesSeg('profit') + `<div class="toolbar"><select onchange="profYr=this.value;render()">${['전체', ...years].map(y => `<option ${y === yr ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
  <div class="card"><h3>${yr === '전체' ? '전체 기간' : yr + '년'} 사이트 ${l.length}곳</h3><div class="kv"><div>매출</div><div><b>${won(tot.sales)}</b>원</div><div>원가 (연결된 매입+부품)</div><div>${won(tot.cost)}원</div><div>이익</div><div class="grn"><b>${won(tot.sales - tot.cost)}</b>원</div></div></div>
  <div class="card plt"><div class="plh"><span>사이트</span><span>매출</span><span>원가</span><span>이익</span></div>
  ${l.map(x => `<div class="plr" onclick="go('#site/${x.s.id}')"><span>${esc(x.s.name)}${x.s.old ? ' <small class="sub">old</small>' : ''}</span><span>${won(x.sales)}</span><span>${x.cost ? won(x.cost) : '-'}</span><span class="${x.profit < 0 ? 'red' : ''}">${won(x.profit)}<small>${x.sales ? Math.round(x.profit / x.sales * 100) + '%' : ''}</small></span></div>`).join('')}</div>
  <div class="card"><h3>사이트에 연결 안 된 매입 ${unl.length}건 <span class="sub" style="font-size:12px;font-weight:400">${won(unl.reduce((a, i) => a + i.supply, 0))}원</span></h3>
  ${unl.slice(0, 40).map(i => row(esc(i.name), `${i.date} · ${esc(i.item)}`, won(i.supply), `onclick="invDetail('${i.id}')"`)).join('') || '<div class="empty">없음</div>'}
  <div class="note">부품·장비 매입 계산서를 눌러 사이트를 고르면 그 사이트 원가로 잡혀 이익이 계산됩니다. 작업 기록에 쓴 재고 부품도 구매 단가만큼 원가에 들어갑니다.</div></div>`;
}

/* ---------------- 거래처 주소록 ---------------- */
let cliQ = '';
function clientRows() {
  const m = {}; const yr = todayStr().slice(0, 4); const arL = receivables();
  for (const i of DB.invoices) { const k = i.bizNo || i.name; const x = m[k] = m[k] || { k, bizNo: i.bizNo, name: i.name, sales: 0, buy: 0, n: 0, last: '', ar: 0 }; x.n++; if (i.date >= x.last) { x.last = i.date; x.name = i.name; } if (i.date.startsWith(yr)) { if (i.kind === '매출') x.sales += i.supply; else x.buy += i.supply; } }
  for (const x of arL) { const k = x.inv.bizNo || x.inv.name; if (m[k]) m[k].ar += x.inv.total; }
  for (const ct of DB.contacts || []) { const k = ct.bizNo || ct.name; m[k] = Object.assign(m[k] || { k, bizNo: ct.bizNo, name: ct.name, sales: 0, buy: 0, n: 0, last: '', ar: 0 }, { ct }); }
  return Object.values(m);
}
function viewClients() {
  const q = cliQ.toLowerCase();
  const l = clientRows().filter(x => !q || (x.name + x.bizNo + (x.ct ? x.ct.person + x.ct.email + x.ct.phone : '')).toLowerCase().includes(q)).sort((a, b) => !!b.ct - !!a.ct || (b.sales + b.buy) - (a.sales + a.buy) || b.last.localeCompare(a.last));
  return sitesSeg('clients') + `<div class="toolbar"><input placeholder="거래처·담당자·사업자번호 검색" value="${esc(cliQ)}" oninput="cliQ=this.value;render(true)"><button class="btn" onclick="contactForm({})">+ 거래처</button></div>
  <div class="card"><h3>거래처 ${l.length}곳 <span class="sub" style="font-size:12px;font-weight:400">담당자 등록 ${l.filter(x => x.ct).length}</span></h3>
  ${l.slice(0, 150).map(x => row(`${esc(x.name)} ${x.ct && x.ct.person ? `<span class="badge blue">${esc(x.ct.person)}</span>` : ''}${x.ar ? ' <span class="badge red">미수</span>' : ''}`, `${esc(x.bizNo || '')} · ${x.n}건 · 최근 ${x.last || '-'}${x.ct && x.ct.email ? ' · ' + esc(x.ct.email) : ''}`, x.sales ? won(x.sales) : x.buy ? `<span class="sub">매입 ${won(x.buy)}</span>` : '', `onclick="go('#client/${encodeURIComponent(x.k)}')"`)).join('')}
  ${l.length > 150 ? '<div class="empty">앞 150곳만 보입니다. 검색으로 좁혀 보세요.</div>' : ''}</div>
  <div class="note">계산서에 나온 거래처가 자동으로 나옵니다. 눌러서 담당자·메일·계산서 수신 메일을 넣어 두면 발행 준비와 입금 요청 메일에 자동으로 쓰입니다. 금액은 올해 공급가액.</div>`;
}
function viewClient(k) {
  const x = clientRows().find(r => r.k === k) || { k, bizNo: /^\d{3}-\d{2}-\d{5}$/.test(k) ? k : '', name: k, n: 0 };
  const ct = x.ct || {}; const invs = DB.invoices.filter(i => (i.bizNo || i.name) === k).sort((a, b) => b.date.localeCompare(a.date));
  const ar = receivables().filter(r => (r.inv.bizNo || r.inv.name) === k); const sites = DB.sites.filter(s => s.bizNo && s.bizNo === x.bizNo);
  const byY = {}; for (const i of invs) { const y = i.date.slice(0, 4); byY[y] = byY[y] || { s: 0, p: 0 }; if (i.kind === '매출') byY[y].s += i.supply; else byY[y].p += i.supply; }
  return `<div class="btns"><a class="btn ghost sm" href="#clients">← 거래처</a></div>
  <div class="card"><h3>${esc(ct.name || x.name)} <a href="javascript:contactForm(${esc(JSON.stringify({ k, bizNo: x.bizNo, name: x.name }))})">${x.ct ? '수정' : '담당자 넣기'}</a></h3>
  <div class="kv"><div>사업자번호</div><div>${esc(x.bizNo || '-')}</div>
  <div>담당자</div><div>${esc([ct.person, ct.title].filter(Boolean).join(' ') || '-')}</div>
  <div>전화</div><div>${ct.phone ? `<a href="tel:${esc(ct.phone)}">${esc(ct.phone)}</a>` : '-'}</div>
  <div>이메일</div><div>${ct.email ? `<a href="mailto:${esc(ct.email)}">${esc(ct.email)}</a>` : '-'}</div>
  <div>계산서 수신</div><div>${esc(ct.taxEmail || '-')}</div>
  <div>메모</div><div>${esc(ct.note || '-')}</div>
  <div>미수금</div><div class="${ar.length ? 'red' : ''}">${won(ar.reduce((a, r) => a + r.inv.total, 0))}원 (${ar.length}건)</div>
  ${sites.length ? `<div>사이트</div><div>${sites.map(s => `<a href="#site/${s.id}">${esc(s.name)}</a>`).join(', ')}</div>` : ''}</div>
  <div class="btns">${ar.length ? `<button class="btn" onclick="dunMail('${esc(k)}')">입금 요청 메일</button>` : ''}<button class="btn ghost" onclick="billPrep({});setTimeout(()=>{const f=$('#fm').elements;f.name.value=${esc(JSON.stringify(x.name))};f.bizNo.value=${esc(JSON.stringify(x.bizNo || ''))};},0)">계산서 발행 준비</button></div></div>
  <div class="card"><h3>연도별 거래</h3>${Object.keys(byY).sort().reverse().map(y => row(y + '년', '', `매출 ${won(byY[y].s)}${byY[y].p ? `<br><small class="sub">매입 ${won(byY[y].p)}</small>` : ''}`)).join('') || '<div class="empty">계산서 없음</div>'}</div>
  <div class="card"><h3>최근 계산서 ${invs.length}건</h3>${invs.slice(0, 30).map(i => row(esc(i.item), `${i.date} · ${i.kind}`, won(i.supply), `onclick="invDetail('${i.id}')"`)).join('') || '<div class="empty">없음</div>'}</div>`;
}
function contactForm(p) {
  DB.contacts = DB.contacts || []; const ex = DB.contacts.find(c => (p.bizNo && c.bizNo === p.bizNo) || (!p.bizNo && p.name && c.name === p.name)) || null;
  const c = ex || { name: p.name || '', bizNo: p.bizNo || '' };
  formSheet(ex ? '거래처 수정' : '거래처 담당자 넣기', [
    { k: 'name', label: '회사명', value: c.name }, { k: 'bizNo', label: '사업자번호', value: c.bizNo, ph: '000-00-00000' },
    { k: 'person', label: '담당자', value: c.person, ph: '예: 김영규' }, { k: 'title', label: '직함', value: c.title, ph: '예: 전무' },
    { k: 'phone', label: '전화', type: 'tel', value: c.phone }, { k: 'email', label: '이메일', type: 'email', value: c.email },
    { k: 'taxEmail', label: '계산서 수신 메일', type: 'email', value: c.taxEmail }, { k: 'note', label: '메모', type: 'textarea', value: c.note },
  ], o => { if (!o.name) { toast('회사명을 입력하세요'); return false; } if (ex) Object.assign(ex, o); else DB.contacts.push({ id: uid('c'), ...o }); toast('저장했습니다'); },
    ex ? `<button class="btn red" type="button" onclick="delContact('${ex.id}')">삭제</button>` : '');
}
async function delContact(id) { if (!confirm('담당자 정보를 지울까요? (계산서는 그대로)')) return; DB.contacts = DB.contacts.filter(x => x.id !== id); closeSheet(); await save(); render(); }

/* ---------------- 장비 대장 ---------------- */
const allAssets = () => DB.sites.flatMap(s => (s.assets || []).map(a => ({ site: s, a })));
const assetById = id => (allAssets().find(x => x.a.id === id) || {}).a || null;
const assetLabel = a => [a.maker, a.model].filter(Boolean).join(' ') + (a.serial ? ` (${a.serial})` : '');
function warrantySoon() { const lim = (() => { const d = new Date(); d.setDate(d.getDate() + 60); return d.toISOString().slice(0, 10); })(); return allAssets().filter(x => x.a.warrantyEnd && x.a.warrantyEnd <= lim && x.site.active !== false && !x.site.old); }
function warrantyCard() { const l = warrantySoon(); return l.length ? `<div class="card" style="margin-top:12px"><h3>장비 보증·EOS 만료 ${l.length}대</h3>${l.map(x => row(esc(assetLabel(x.a)), esc(x.site.name), `<span class="badge ${x.a.warrantyEnd < todayStr() ? 'red' : 'org'}">${x.a.warrantyEnd}</span>`, `onclick="go('#site/${x.site.id}')"`)).join('')}</div>` : ''; }
function assetCard(s) {
  const l = s.assets || [];
  return `<div class="card"><h3>장비 대장 ${l.length}대 <a href="javascript:assetForm('${s.id}')">+ 장비</a></h3>
  ${l.map(a => { const n = DB.events.filter(e => e.assetId === a.id).length; return row(`${esc(assetLabel(a))}${a.warrantyEnd ? ` <span class="badge ${a.warrantyEnd < todayStr() ? 'red' : a.warrantyEnd <= ymAdd(ymOf(todayStr()), 2) + '-31' ? 'org' : ''}">보증 ${a.warrantyEnd}</span>` : ''}`, `${esc(a.kind || '')}${a.location ? ' · ' + esc(a.location) : ''}${n ? ' · 작업 ' + n + '건' : ''}${a.note ? ' · ' + esc(a.note) : ''}`, '', `onclick="assetForm('${s.id}','${a.id}')"`); }).join('') || `<div class="empty">등록된 장비가 없습니다${s.equipment ? ' (메모: ' + esc(s.equipment) + ')' : ''}</div>`}</div>`;
}
function assetForm(siteId, id) {
  const s = DB.sites.find(x => x.id === siteId); s.assets = s.assets || []; const a = id ? s.assets.find(x => x.id === id) : { kind: '스토리지' };
  formSheet(id ? '장비 수정' : '장비 추가', [
    { k: 'kind', label: '종류', type: 'select', options: ['스토리지', '서버', '스위치', '백업장비', '테이프', 'UPS', '기타'], value: a.kind },
    { k: 'maker', label: '제조사', value: a.maker, ph: '예: HPE, Dell, IBM' }, { k: 'model', label: '모델', value: a.model, ph: '예: Nimble CS1000' },
    { k: 'serial', label: '시리얼 번호', value: a.serial }, { k: 'location', label: '설치 위치', value: a.location, ph: '예: 본관 전산실 랙3' },
    { k: 'installed', label: '도입일', type: 'date', value: a.installed }, { k: 'warrantyEnd', label: '보증·EOS 만료일', type: 'date', value: a.warrantyEnd },
    { k: 'note', label: '메모 (펌웨어, IP, 구성 등)', type: 'textarea', value: a.note },
  ], o => { if (!o.model && !o.serial) { toast('모델이나 시리얼을 입력하세요'); return false; } if (id) Object.assign(a, o); else s.assets.push({ id: uid('a'), ...o }); toast('저장했습니다'); },
    id ? `<button class="btn red" type="button" onclick="delAsset('${siteId}','${id}')">삭제</button>` : '');
  if (id) { const ev = DB.events.filter(e => e.assetId === id).sort((x, y) => y.date.localeCompare(x.date)); if (ev.length) $('#fm').insertAdjacentHTML('beforeend', `<h3 style="font-size:14px">이 장비 작업 이력</h3>${ev.map(e => `<div class="row"><div class="l"><small>${e.date} · ${esc(e.type)} · ${esc(e.title || '')}</small></div></div>`).join('')}`); }
}
async function delAsset(siteId, id) { if (!confirm('장비를 삭제할까요?')) return; const s = DB.sites.find(x => x.id === siteId); s.assets = s.assets.filter(x => x.id !== id); closeSheet(); await save(); render(); }
// 수주한 유지보수 견적서 → 사이트 등록 내용 미리 채우기
function siteFromQuote(q) {
  const months = Number(((q.items.find(it => /\d/.test(it.period || '')) || {}).period || '').match(/\d+/) || 0) || 0;
  const monthly = q.items.reduce((a, it) => a + (Number(it.unit) || 0) * (Number(it.qty) || 1), 0) || (months ? Math.round(quoteTotals(q).sup / months) : quoteTotals(q).sup);
  const start = ymAdd(ymOf(q.date), 1), end = months ? ymAdd(start, months - 1) : '';
  return { active: true, visitDay: 25, inspect: '방문', cycle: '매월', billMonths: [], inspectMonths: [], name: q.title.replace(/\s*\(?\d+\s*개월\)?\s*$/, '').trim(), client: q.to, bizNo: lookupBizNo(q.to), amount: monthly,
    startMonth: start, endMonth: end, contract: `${start} ~ ${end}${months ? ` (${months}개월)` : ''} · 견적 ${q.no || ''}`, equipment: q.items.map(it => [it.maker, it.model, it.qty > 1 ? '×' + it.qty : ''].filter(Boolean).join(' ')).join(', '), contact: q.attn || '' };
}

/* ---------------- 캘린더 ---------------- */
function calItems() {
  const out = [], today = todayStr(), ym = ymOf(today);
  for (const m of [ym, ymAdd(ym, 1), ymAdd(ym, 2)]) for (const x of inspectStatus(m)) if (!x.done) out.push({ key: `ins:${x.site.id}:${m}`, date: x.plan < today && m === ym ? today : x.plan, title: `[점검] ${x.site.name}`, desc: `${x.site.client} · ${x.site.inspect || '방문'}\n${x.site.equipment || ''}` });
  for (const o of DB.orders || []) if (o.dueDate && o.dueDate >= today && ['접수', '진행'].includes(o.status)) out.push({ key: `ord:${o.id}`, date: o.dueDate, title: `[${o.kind}] ${o.title}`, desc: `${o.client || ''} ${o.customer || ''}\n${o.summary || ''}` });
  for (const e of DB.events) if (e.date >= today) out.push({ key: `ev:${e.id}`, date: e.date, title: `[${e.type}] ${siteName(e.siteId)} ${e.title || ''}`.trim(), desc: e.memo || '' });
  return out;
}
function downloadICS() {
  const z = d => d.replace(/-/g, ''); const nx = d => { const t = new Date(d); t.setDate(t.getDate() + 1); return t.toISOString().slice(0, 10).replace(/-/g, ''); };
  const e = s => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//eporttech-erp//KO', ...calItems().flatMap(x => ['BEGIN:VEVENT', `UID:${x.key.replace(/:/g, '-')}@eporttech-erp`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, `DTSTART;VALUE=DATE:${z(x.date)}`, `DTEND;VALUE=DATE:${nx(x.date)}`, `SUMMARY:${e(x.title)}`, `DESCRIPTION:${e(x.desc)}`, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
  download(`이포트텍_일정_${todayStr()}.ics`, ics, 'text/calendar'); toast('파일을 열면 캘린더에 추가됩니다');
}

/* ---------------- 입금 문자 붙여넣기 ---------------- */
function parseBankText(text) {
  const now = new Date(), Y = now.getFullYear(), out = [];
  const skip = /web발신|은행|뱅크|bank|잔액|출금|계좌|^\s*\d{2,}[-*][\d*-]+\s*$|^[\d\s:./-]+$|입금$|^\s*$|님$|알림|^\[|\]$/i;
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n|(?=\[Web발신\])/i);
  for (const b of blocks) {
    const lines = b.split('\n').map(x => x.trim()).filter(Boolean); let date = '';
    lines.forEach((ln, i) => {
      const dm = ln.match(/(20\d\d)[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/) || ln.match(/(?:^|\D)(\d{1,2})[/.월]\s?(\d{1,2})(?:일)?(?:\s|$|\D)/);
      if (dm) { date = dm.length === 4 ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}` : `${Y}-${dm[1].padStart(2, '0')}-${dm[2].padStart(2, '0')}`; if (date > todayStr()) date = (Y - 1) + date.slice(4); }
      const am = ln.match(/입금\s*:?\s*([\d,]{3,})\s*원?/) || ln.match(/([\d,]{3,})\s*원?\s*입금/);
      if (!am) return; const amount = toNum(am[1]); if (!amount) return;
      let name = ln.replace(am[0], '').replace(/(20\d\d)[.\-/년\s]+\d{1,2}[.\-/월\s]+\d{1,2}일?/, '').replace(/\d{1,2}[/.]\d{1,2}/, '').replace(/\d{1,2}:\d{2}(:\d{2})?/, '').replace(/잔액\s*[\d,]+원?/, '').replace(/[\d*]{2,}-[\d*-]+/, '').replace(/\[.*?\]/g, '').replace(/\s+/g, ' ').trim();
      if (!name || skip.test(name) || /^[\d,\s원]+$/.test(name)) { const cand = [lines[i + 1], lines[i - 1], ...lines.slice(i + 2)].filter(Boolean).find(x => !skip.test(x) && !/[\d,]{4,}/.test(x) && !/\d{1,2}[/.]\d{1,2}/.test(x)); name = cand || ''; }
      name = name.replace(/^(입금자|보낸분)\s*:?\s*/, '').replace(/^(IBK|KB|NH|SC|기업|국민|신한|우리|하나|농협|카카오뱅크|카카오|토스뱅크|토스|케이뱅크|씨티|새마을|우체국)(은행)?\s+/i, '').replace(/[()]$/, '').trim();
      out.push({ date: date || todayStr(), name, amount });
    });
  }
  return out;
}
let _smsRows = [];
function smsSheet() {
  openSheet(`<h2>입금 문자 붙여넣기</h2><p class="note">은행 입금 알림 문자(여러 개 가능)나 거래내역을 복사해 붙여넣으세요. 날짜·입금자·금액을 찾아 미리 보여 줍니다.</p>
  <textarea id="smsTxt" style="width:100%;min-height:160px" placeholder="[Web발신]&#10;[기업은행] 11/25 14:30&#10;입금 1,320,000원&#10;씨큐아이&#10;잔액 12,345,678원"></textarea>
  <div class="btns"><button class="btn" onclick="smsParse()">찾기</button><button class="btn ghost" onclick="closeSheet()">닫기</button></div><div id="smsOut"></div>`);
}
function smsParse() {
  _smsRows = parseBankText($('#smsTxt').value);
  $('#smsOut').innerHTML = _smsRows.length ? `<h3 style="font-size:14px">${_smsRows.length}건 찾음 (고칠 수 있음)</h3>${_smsRows.map((r, i) => `<div class="grid2" style="grid-template-columns:110px 1fr 110px;margin-bottom:6px"><input type="date" value="${r.date}" onchange="_smsRows[${i}].date=this.value"><input value="${esc(r.name)}" onchange="_smsRows[${i}].name=this.value" placeholder="입금자"><input inputmode="numeric" value="${won(r.amount)}" onchange="_smsRows[${i}].amount=toNum(this.value)"></div>`).join('')}<div class="btns"><button class="btn grn" onclick="smsSave()">입금 ${_smsRows.length}건 넣고 자동 대조</button></div>` : '<div class="empty">입금 금액을 찾지 못했습니다. “입금 1,000,000원”처럼 금액 앞뒤에 ‘입금’이 있어야 합니다.</div>';
}
async function smsSave() {
  const news = []; for (const r of _smsRows) { if (!r.amount) continue; if (DB.deposits.some(d => d.date === r.date && d.amount === r.amount && d.name === r.name)) continue; const d = { id: uid('d'), date: r.date, name: r.name, amount: r.amount, memo: '입금 문자', invIds: [] }; DB.deposits.push(d); news.push(d); }
  const n = autoMatch(news); closeSheet(); await save(); render(); toast(`입금 ${news.length}건 추가, 계산서와 ${n}건 자동 연결`);
}

/* ---------------- 변경 기록 ---------------- */
const LOG_COLS = { sites: ['사이트', x => x.name], invoices: ['계산서', x => `${x.name} ${x.item} ${won(x.supply)}`], events: ['작업기록', x => `${siteName(x.siteId)} ${x.title || x.type}`], parts: ['부품', x => `${x.name} (${x.qty})`], deposits: ['입금', x => `${x.name} ${won(x.amount)}`], orders: ['발주', x => x.title], quotes: ['견적서', x => x.title], billReqs: ['발행요청', x => `${x.item} ${won(x.supply)} ${x.status}`], contacts: ['거래처', x => x.name] };
let _snap = null;
function snapOf() { const m = new Map(); for (const k in LOG_COLS) for (const x of DB[k] || []) m.set(k + ':' + x.id, JSON.stringify(x)); return m; }
const deviceName = () => { const u = navigator.userAgent; return /iPhone|iPad/.test(u) ? 'iPhone' : /Android/.test(u) ? '안드로이드' : /Windows/.test(u) ? 'PC' : /Mac/.test(u) ? 'Mac' : '기기'; };
function diffLog() {
  if (!DB) return; if (!_snap) { _snap = snapOf(); return; }
  const now = snapOf(), msgs = [], desc = (key, v) => { const k = key.slice(0, key.indexOf(':')); try { return LOG_COLS[k][1](JSON.parse(v)); } catch (e) { return ''; } };
  for (const [key, v] of now) { const o = _snap.get(key); if (o === v) continue; msgs.push(`${LOG_COLS[key.slice(0, key.indexOf(':'))][0]} ${o ? '수정' : '추가'}: ${desc(key, v)}`); }
  for (const [key, v] of _snap) if (!now.has(key)) msgs.push(`${LOG_COLS[key.slice(0, key.indexOf(':'))][0]} 삭제: ${desc(key, v)}`);
  if (msgs.length) { DB.log = DB.log || []; DB.log.push({ t: new Date().toISOString(), dev: deviceName(), n: msgs.length, m: msgs.slice(0, 15) }); if (DB.log.length > 500) DB.log = DB.log.slice(-500); }
  _snap = now;
}
function logCard() {
  const l = (DB.log || []).slice(-40).reverse();
  return `<details class="card"><summary><h3 style="display:inline">변경 기록 ${(DB.log || []).length}건</h3></summary>${l.map(x => `<div class="row"><div class="l"><b style="font-weight:400;font-size:13px">${x.m.map(esc).join('<br>')}${x.n > x.m.length ? `<br><small class="sub">외 ${x.n - x.m.length}건</small>` : ''}</b><small>${new Date(x.t).toLocaleString('ko-KR')} · ${esc(x.dev || '')}</small></div></div>`).join('') || '<div class="empty">기록 없음</div>'}</details>`;
}

/* ---------------- 라우터 ---------------- */
const TITLES = { clients: '거래처', client: '거래처', profit: '사이트별 수익', tech: '기술지원 (유지보수 외)', orders: '발주 · 견적', home: '이포트텍 ERP', schedule: '유지보수 일정', sites: '사이트', site: '사이트 상세', invoices: '세금계산서', ar: '미수금 · 입금', parts: '부품 재고', settings: '설정' };
function go(h) { location.hash = h; }
function render(keepFocus) {
  const [name, arg] = (location.hash.slice(1) || 'home').split('/');
  const focusId = keepFocus && document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null; const pos = focusId ? focusId.selectionStart : 0; const ph = focusId ? focusId.placeholder : '';
  let html = '';
  if (autoReconcile()) { save(); }
  if (!DB.sites.length && !DB.invoices.length && name !== 'settings') html = `<div class="card"><h3>처음 시작하기</h3><p class="note">자료가 비어 있습니다. 함께 드린 <b>이포트텍_ERP_초기데이터.json</b> 파일을 불러오면 유지보수 사이트 18곳과 2020~2026 세금계산서가 바로 들어갑니다.</p><div class="btns"><button class="btn" onclick="importJSON()">초기 데이터 불러오기</button><button class="btn ghost" onclick="go('#settings')">구글 시트에서 받기</button></div></div>`;
  else html = ({ home: viewHome, schedule: viewSchedule, sites: viewSites, site: () => viewSite(arg), invoices: () => viewInvoices(arg), ar: viewAR, parts: viewParts, tech: perCallView, settings: viewSettings, orders: viewOrders, clients: viewClients, client: () => viewClient(decodeURIComponent(arg || '')), profit: viewProfit }[name] || viewHome)();
  $('#view').innerHTML = html; $('#pageTitle').textContent = TITLES[name] || TITLES.home;
  const tab = ['site', 'clients', 'client', 'profit'].includes(name) ? 'sites' : name; document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (ph) { const el = [...document.querySelectorAll('#view input')].find(x => x.placeholder === ph); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
$('#btnSettings').onclick = () => go('#settings');
(async () => {
  DB = (await IDB.get('db')) || blankDB();
  DB = Object.assign(blankDB(), DB); DB.settings = Object.assign(blankDB().settings, DB.settings); diffLog();
  render(); syncBadge();
  if (syncReady()) autoPull(); else if (DB.settings.syncUrl) pullInbox(true);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

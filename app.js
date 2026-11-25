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
function blankDB() { return { version: 1, settings: { company: '이포트텍', bizNo: '599-01-01772', arStart: '2026-09-01', syncUrl: '', syncToken: '', owner: '', tel: '', email: '', address: '' }, sites: [], invoices: [], events: [], parts: [], deposits: [], manualPaid: {}, orders: [], changes: [], mailSeen: [], quotes: [] }; }
async function save() { DB.updated = new Date().toISOString(); await IDB.set('db', DB); invalidate(); schedulePush(); }
async function persist() { await IDB.set('db', DB); invalidate(); } // 동기화 표시만 바꿀 때 (변경으로 치지 않음)

/* ---------------- 자동 동기화: 고치면 몇 초 뒤 시트로 올리고, 앱을 열거나 다시 보면 시트의 새 자료를 받음 ---------------- */
const syncReady = () => !!(DB && DB.settings.syncUrl && DB.settings.syncToken);
const isDirty = () => (DB.updated || '') > (DB.settings.lastSync || '');
let _pushT = null, _pushing = false, _pulling = false;
function schedulePush() { if (!syncReady()) return; clearTimeout(_pushT); _pushT = setTimeout(autoPush, 3000); }
async function pushNow() {
  const s = DB.settings, u = DB.updated; const { syncUrl, syncToken, lastSync, ...rest } = s;
  const r = await fetch(s.syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: syncToken, data: { ...DB, settings: rest } }) });
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
      DB = Object.assign(blankDB(), d); DB.settings = Object.assign(blankDB().settings, d.settings, keep); await persist();
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
  if (inv.kind !== '매출') return null;
  if (inv.siteId) return DB.sites.find(s => s.id === inv.siteId) || null;
  let best = null;
  for (const s of DB.sites) {
    const bizOk = s.bizNo ? s.bizNo === inv.bizNo : normName(inv.name).includes(normName(s.client));
    if (bizOk && s.keyword && inv.item.toLowerCase().includes(s.keyword.toLowerCase())) { if (!best || s.keyword.length > best.keyword.length) best = s; }
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
  // 수정(마이너스) 계산서와 원래 계산서를 짝지어 미수금에서 제외
  const negs = sales.filter(i => i.supply < 0);
  for (const n of negs) {
    const cand = sales.filter(p => p.supply === -n.supply && p.bizNo === n.bizNo && p.date <= n.date && !c.cancelled.has(p.id)).sort((a, b) => (b.item === n.item) - (a.item === n.item) || b.date.localeCompare(a.date));
    c.cancelled.add(n.id); if (cand[0]) c.cancelled.add(cand[0].id);
  }
  for (const d of DB.deposits) for (const id of (d.invIds || [])) c.paidBy[id] = { date: d.date, dep: d.id };
  for (const [id, dt] of Object.entries(DB.manualPaid || {})) if (!c.paidBy[id]) c.paidBy[id] = { date: dt, manual: true };
  _cache = c; return c;
}
const siteActiveIn = (s, ym) => s.active !== false && (!s.startMonth || ym >= s.startMonth);
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
  return `
  <div class="grid4">
    <div class="stat" onclick="go('#schedule')"><div class="k">${Number(ym.slice(5))}월 점검</div><div class="v ${insDone < ins.length ? 'org' : 'grn'}">${insDone}/${ins.length}</div><div class="s">${ins.filter(x => x.late).length ? '미점검 ' + ins.filter(x => x.late).length + '곳' : '남은 점검 ' + (ins.length - insDone) + '곳'}</div></div>
    <div class="stat" onclick="go('#invoices')"><div class="k">${Number(ym.slice(5))}월 계산서</div><div class="v ${billLeft.length ? 'org' : 'grn'}">${billDone.length}/${bill.length}</div><div class="s">미발행 ${man(billLeft.reduce((a, x) => a + x.site.amount, 0))}원</div></div>
    <div class="stat" onclick="go('#ar')"><div class="k">미수금</div><div class="v ${ar.length ? 'red' : 'grn'}">${man(arSum)}</div><div class="s">${ar.length}건 (부가세 포함)</div></div>
    <div class="stat" onclick="go('#parts')"><div class="k">재고 부족</div><div class="v ${low.length ? 'red' : ''}">${low.length}</div><div class="s">품목 ${DB.parts.length}개</div></div>
  </div>
  ${homeMailCards()}
  <div class="card" style="margin-top:12px"><h3>${y}년 매출 <a href="#invoices/forecast">자세히</a></h3>
    <div class="kv"><div>실제 발행</div><div><b>${won(ytd)}</b>원</div><div>남은 예상</div><div>${won(rest)}원 (정기 유지보수)</div><div>연말 예상</div><div><b>${won(ytd + rest)}</b>원</div></div></div>
  <div class="card"><h3>이번 달 아직 점검 안 한 사이트 <a href="#schedule">일정</a></h3>
    ${ins.filter(x => !x.done).slice(0, 8).map(x => row(esc(x.site.name), `${esc(x.site.client)} · 예정 ${x.plan.slice(5)} · ${esc(x.site.inspect || '방문')}`, x.late ? '<span class="badge red">지남</span>' : '<span class="badge">예정</span>', `onclick="quickInspect('${x.site.id}')"`)).join('') || '<div class="empty">모두 점검했습니다 👍</div>'}
    <div class="note">사이트를 누르면 바로 점검 완료로 기록됩니다.</div></div>
  <div class="card"><h3>이번 달 발행할 계산서 <a href="#invoices">계산서</a></h3>
    ${billLeft.map(x => row(esc(x.site.name), `${esc(x.site.client)} · ${esc(x.site.cycle)}`, won(x.site.amount), `onclick="go('#site/${x.site.id}')"`)).join('') || '<div class="empty">모두 발행했습니다 👍</div>'}</div>
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
  <div class="note">“캘린더”를 누르면 구글 캘린더에 점검 일정이 추가됩니다. 점검 예정일은 사이트 정보의 ‘점검 예정일(매월 며칠)’로 바꿀 수 있습니다.</div>`;
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
  const list = DB.sites.filter(s => !siteQ || (s.name + s.client + s.equipment + s.note).toLowerCase().includes(siteQ.toLowerCase()));
  const ins = Object.fromEntries(inspectStatus(ym).map(x => [x.site.id, x]));
  const total = DB.sites.filter(s => s.active !== false).reduce((a, s) => a + (s.billMonths && s.billMonths.length ? s.amount * s.billMonths.length / 12 : s.amount), 0);
  return `<div class="toolbar"><input id="siteQ" placeholder="사이트·업체·장비 검색" value="${esc(siteQ)}" oninput="siteQ=this.value;render(true)"><button class="btn" onclick="siteForm()">+ 사이트</button></div>
  <div class="card"><h3>유지보수 사이트 ${DB.sites.filter(s => s.active !== false).length}곳 <span class="sub" style="font-size:12px;font-weight:400">월 환산 ${won(total)}원</span></h3>
  ${list.map(s => {
    const last = (c.bySite[s.id] || []).filter(i => i.supply > 0).sort((a, b) => b.date.localeCompare(a.date))[0];
    const st = ins[s.id];
    return row(`${esc(s.name)} ${s.active === false ? '<span class="badge">종료</span>' : st ? (st.done ? '<span class="badge grn">점검완료</span>' : '<span class="badge org">미점검</span>') : ''}`,
      `${esc(s.client)} · ${esc(s.cycle)}${last ? ' · 최근 발행 ' + last.date.slice(2) : ''}`, won(s.amount), `onclick="go('#site/${s.id}')"`);
  }).join('') || '<div class="empty">사이트가 없습니다</div>'}</div>`;
}
function viewSite(id) {
  const s = DB.sites.find(x => x.id === id); if (!s) return '<div class="empty">없는 사이트</div>';
  const c = calc();
  const invs = (c.bySite[id] || []).slice().sort((a, b) => b.date.localeCompare(a.date));
  const evs = DB.events.filter(e => e.siteId === id);
  const items = [...evs.map(e => ({ d: e.date, h: `<div class="it"><b>${esc(e.type)}</b> ${esc(e.title || '')}<br><small>${e.date}${e.memo ? ' · ' + esc(e.memo) : ''}${e.partId ? ' · 부품 ' + esc(partName(e.partId)) + ' ×' + e.partQty : ''}</small></div>`, click: `eventForm(DB.events.find(x=>x.id==='${e.id}'))` })),
    ...invs.map(i => ({ d: i.date, h: `<div class="it inv"><b>계산서</b> ${esc(i.item)} <span class="${i.supply < 0 ? 'red' : ''}">${won(i.supply)}원</span><br><small>${i.date} · ${esc(i.name)} · ${c.cancelled.has(i.id) ? '수정/취소' : c.paidBy[i.id] ? '입금 ' + c.paidBy[i.id].date : (i.date >= DB.settings.arStart ? '<span class="red">미입금</span>' : '')}</small></div>` }))]
    .sort((a, b) => b.d.localeCompare(a.d));
  const yr = todayStr().slice(0, 4); const yrSum = invs.filter(i => i.date.startsWith(yr)).reduce((a, i) => a + i.supply, 0);
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
  </div>
  <div class="btns"><button class="btn grn" onclick="quickInspect('${id}')">점검 완료 기록</button><button class="btn ghost" onclick="eventForm({siteId:'${id}',type:'장애처리',date:'${todayStr()}'})">장애·출동 기록</button></div></div>
  <div class="card"><h3>히스토리 <span class="sub" style="font-size:12px;font-weight:400">작업 ${evs.length} · 계산서 ${invs.length}</span></h3>
  <div class="tl">${items.slice(0, 80).map(x => x.click ? `<div onclick="${x.click}" style="cursor:pointer">${x.h}</div>` : x.h).join('') || '<div class="empty">기록 없음</div>'}</div></div>`;
}
function siteForm(s) {
  s = s || { active: true, visitDay: 25, inspect: '방문', cycle: '매월', billMonths: [], inspectMonths: [] }; const isNew = !s.id;
  formSheet(isNew ? '사이트 추가' : '사이트 수정', [
    { k: 'name', label: '사이트 이름 (최종 고객)', value: s.name },
    { k: 'client', label: '계산서 발행처 (중간업체)', value: s.client },
    { k: 'bizNo', label: '발행처 사업자번호', value: s.bizNo, ph: '000-00-00000' },
    { k: 'keyword', label: '계산서 품목명에 들어가는 단어 (자동 대조용)', value: s.keyword, ph: '예: 경기대' },
    { k: 'amount', label: '1회 발행 금액 (공급가액)', type: 'number', value: s.amount },
    { k: 'cycle', label: '주기', type: 'select', options: ['매월', '분기', '반기', '3개월 후불', '연간', '기타'], value: s.cycle },
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
  const seg = `<div class="seg"><a href="#invoices/month" class="${invTab === 'month' ? 'on' : ''}">월별 발행 점검</a><a href="#invoices/list" class="${invTab === 'list' ? 'on' : ''}">전체 목록</a><a href="#invoices/forecast" class="${invTab === 'forecast' ? 'on' : ''}">매출 예상</a></div>`;
  if (invTab === 'list') return seg + invList();
  if (invTab === 'forecast') return seg + forecast();
  const ym = invYM || ymOf(todayStr()); const st = billingStatus(ym);
  const exp = st.reduce((a, x) => a + x.site.amount, 0), got = st.reduce((a, x) => a + Math.max(0, x.net), 0);
  const c = calc();
  const extra = DB.invoices.filter(i => i.kind === '매출' && ymOf(i.date) === ym && !c.siteOf[i.id]);
  return seg + `<div class="monthnav"><button onclick="invYM='${ymAdd(ym, -1)}';render()">◀</button>${ymLabel(ym)}<button onclick="invYM='${ymAdd(ym, 1)}';render()">▶</button></div>
  <div class="card"><h3>정기 유지보수 ${st.filter(x => x.done).length}/${st.length}건 발행</h3>
  <div class="kv"><div>예정</div><div>${won(exp)}원</div><div>발행</div><div><b>${won(got)}</b>원</div><div>남음</div><div class="${exp - got > 0 ? 'org' : ''}">${won(Math.max(0, exp - got))}원</div></div>
  ${st.map(x => row(`${esc(x.site.name)} ${x.done ? '<span class="badge grn">발행</span>' : '<span class="badge org">미발행</span>'}`,
    x.done ? x.invs.filter(i => i.supply > 0).map(i => i.date.slice(5) + ' ' + esc(i.item)).join(' / ') : `${esc(x.site.client)} · ${esc(x.site.cycle)}`, won(x.done ? x.net : x.site.amount), `onclick="go('#site/${x.site.id}')"`)).join('')}
  </div>
  <div class="card"><h3>그 외 매출 (비정기) ${extra.length}건 <span class="sub" style="font-size:12px;font-weight:400">${won(extra.reduce((a, i) => a + i.supply, 0))}원</span></h3>
  ${extra.map(i => row(esc(i.name), `${i.date} · ${esc(i.item)}`, won(i.supply), `onclick="invDetail('${i.id}')"`)).join('') || '<div class="empty">없음</div>'}</div>
  <div class="btns"><button class="btn" onclick="importHometax()">홈택스 파일 올리기</button></div>
  <div class="note">홈택스 ‘매출/매입 전자세금계산서 목록조회’에서 받은 엑셀(.xls/.xlsx) 또는 CSV를 올리면 새 계산서만 추가되고, 사업자번호와 품목명으로 사이트에 자동 연결됩니다. 품목명에 “10월” 같은 표시가 있으면 그 달 몫으로 봅니다.</div>`;
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
  ${i.kind === '매출' ? `<label class="f" style="margin-top:12px">연결 사이트<select id="invSite">${opts.map(([v, l]) => `<option value="${v}" ${v === (i.siteId || '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : ''}
  <div class="btns">${i.kind === '매출' ? `<button class="btn" onclick="saveInvSite('${id}')">저장</button>` : ''}
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
  <div class="btns"><button class="btn" onclick="importBank()">통장 거래내역 올리기</button><button class="btn ghost" onclick="depositForm()">입금 직접 입력</button></div></div>
  ${Object.values(groups).sort((a, b) => b.sum - a.sum).map(g => `<div class="card"><h3>${esc(g.name)} <span>${won(g.sum)}원</span></h3>
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
  const cands = [...linked, ...ar.filter(i => i.date <= d.date)].slice(0, 80);
  const n = normName(d.name); cands.sort((a, b) => (normName(b.name).includes(n) || n.includes(normName(b.name))) - (normName(a.name).includes(n) || n.includes(normName(a.name))));
  openSheet(`<h2>입금 연결</h2><div class="kv"><div>입금</div><div>${d.date} · ${esc(d.name)} · <b>${won(d.amount)}</b>원</div></div>
  <p class="note">이 입금으로 받은 계산서를 체크하세요. 선택 합계: <b id="selSum">0</b>원</p>
  <div id="cands">${cands.map(i => `<label class="row" style="cursor:pointer"><div class="l"><input class="chk" type="checkbox" value="${i.id}" data-t="${i.total}" ${(d.invIds || []).includes(i.id) ? 'checked' : ''}><b style="display:inline">${esc(i.name)}</b><small>${i.date} · ${esc(i.item)}</small></div><div class="r">${won(i.total)}</div></label>`).join('') || '<div class="empty">미수 계산서가 없습니다</div>'}</div>
  <div class="btns"><button class="btn" onclick="saveMatch('${id}')">저장</button><button class="btn ghost" onclick="ignoreDep('${id}')">무시(계산서 아님)</button><button class="btn red" onclick="delDep('${id}')">삭제</button><button class="btn ghost" onclick="closeSheet()">닫기</button></div>`);
  const upd = () => { $('#selSum').textContent = won([...document.querySelectorAll('#cands input:checked')].reduce((a, x) => a + Number(x.dataset.t), 0)); };
  document.querySelectorAll('#cands input').forEach(x => x.onchange = upd); upd();
}
async function saveMatch(id) { const d = DB.deposits.find(x => x.id === id); d.invIds = [...document.querySelectorAll('#cands input:checked')].map(x => x.value); d.ignore = false; closeSheet(); await save(); render(); }
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
    await save(); render(); toast(`${seen}건 중 새 계산서 ${added}건 추가`);
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
  <div class="card"><h3>백업</h3><div class="btns"><button class="btn ghost" onclick="exportJSON()">백업 파일 저장</button><button class="btn ghost" onclick="importJSON()">백업·초기 데이터 불러오기</button><button class="btn red" onclick="resetAll()">전체 초기화</button></div>
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
    DB = Object.assign(blankDB(), d); DB.settings = Object.assign(blankDB().settings, d.settings || {}); await save(); render(); toast('불러왔습니다');
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
    const keep = { syncUrl: s.syncUrl, syncToken: s.syncToken }; DB = Object.assign(blankDB(), j.data); if (!DB.updated) DB.updated = new Date().toISOString(); DB.settings = Object.assign(blankDB().settings, j.data.settings, keep, { lastSync: DB.updated });
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
    (o.mailUrl ? `<a class="btn ghost" target="_blank" href="${esc(o.mailUrl)}">메일 보기</a>` : '') + (isNew ? '' : (o.kind === '견적요청' ? `<button class="btn grn" type="button" onclick="quoteFromOrder('${o.id}')">견적서 작성</button>` : '') + `<button class="btn ghost" type="button" onclick="orderToEvent('${o.id}')">작업 기록으로</button><button class="btn red" type="button" onclick="delOrder('${o.id}')">삭제</button>`));
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
  closeSheet(); await save(); render(); toast('수주 처리하고 발주 목록에 넣었습니다');
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

/* ---------------- 라우터 ---------------- */
const TITLES = { orders: '발주 · 견적', home: '이포트텍 ERP', schedule: '유지보수 일정', sites: '사이트', site: '사이트 상세', invoices: '세금계산서', ar: '미수금 · 입금', parts: '부품 재고', settings: '설정' };
function go(h) { location.hash = h; }
function render(keepFocus) {
  const [name, arg] = (location.hash.slice(1) || 'home').split('/');
  const focusId = keepFocus && document.activeElement && document.activeElement.tagName === 'INPUT' ? document.activeElement : null; const pos = focusId ? focusId.selectionStart : 0; const ph = focusId ? focusId.placeholder : '';
  let html = '';
  if (!DB.sites.length && !DB.invoices.length && name !== 'settings') html = `<div class="card"><h3>처음 시작하기</h3><p class="note">자료가 비어 있습니다. 함께 드린 <b>이포트텍_ERP_초기데이터.json</b> 파일을 불러오면 유지보수 사이트 18곳과 2020~2026 세금계산서가 바로 들어갑니다.</p><div class="btns"><button class="btn" onclick="importJSON()">초기 데이터 불러오기</button><button class="btn ghost" onclick="go('#settings')">구글 시트에서 받기</button></div></div>`;
  else html = ({ home: viewHome, schedule: viewSchedule, sites: viewSites, site: () => viewSite(arg), invoices: () => viewInvoices(arg), ar: viewAR, parts: viewParts, settings: viewSettings, orders: viewOrders }[name] || viewHome)();
  $('#view').innerHTML = html; $('#pageTitle').textContent = TITLES[name] || TITLES.home;
  const tab = name === 'site' ? 'sites' : name; document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (ph) { const el = [...document.querySelectorAll('#view input')].find(x => x.placeholder === ph); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
}
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
$('#btnSettings').onclick = () => go('#settings');
(async () => {
  DB = (await IDB.get('db')) || blankDB();
  DB = Object.assign(blankDB(), DB); DB.settings = Object.assign(blankDB().settings, DB.settings);
  render(); syncBadge();
  if (syncReady()) autoPull(); else if (DB.settings.syncUrl) pullInbox(true);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();

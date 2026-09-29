/* =========================================================================
   INSURANCE TAB
   Data lives at DATA.insurance = { categories:[], policies:[] } — top-level
   (not per-year) because a policy runs across years. Premiums are stored in
   the policy's own currency and converted with nativeMonthToUsd() wherever
   they're totalled, same as every other tab.
   ========================================================================= */
const INS_FREQ = {
  monthly:    { label:'Monthly',     months:1,  perYear:12 },
  quarterly:  { label:'Quarterly',   months:3,  perYear:4  },
  halfyearly: { label:'Half-yearly', months:6,  perYear:2  },
  yearly:     { label:'Yearly',      months:12, perYear:1  },
  single:     { label:'One-time',    months:0,  perYear:0  }
};
const INS_DEFAULT_CATS = [
  { id:'cat_term',     name:'Term Life',         icon:'🛡️', color:'#C9A961' },
  { id:'cat_health',   name:'Health',            icon:'🩺', color:'#6FA491' },
  { id:'cat_home',     name:'Home',              icon:'🏠', color:'#C06A46' },
  { id:'cat_car',      name:'Car',               icon:'🚗', color:'#9BB6C9' },
  { id:'cat_card',     name:'Credit Card',       icon:'💳', color:'#B98BC9' },
  { id:'cat_travel',   name:'Travel',            icon:'✈️', color:'#8FC0AC' },
  { id:'cat_accident', name:'Personal Accident', icon:'🩹', color:'#D98C64' }
];
const INS_BOUGHT_VIA = ['Agent','Bank','Online','Employer','Broker','Other'];
let insFilterCat = null;

function ensureInsurance(){
  if(!DATA.insurance) DATA.insurance = { categories: INS_DEFAULT_CATS.map(c=>({...c})), policies: [] };
  const ins = DATA.insurance;
  if(!Array.isArray(ins.categories) || !ins.categories.length) ins.categories = INS_DEFAULT_CATS.map(c=>({...c}));
  if(!Array.isArray(ins.policies)) ins.policies = [];
  ins.policies.forEach(p=>{
    if(!Array.isArray(p.nominees)) p.nominees = [];
    if(!Array.isArray(p.paid)) p.paid = [];
    if(!p.currency) p.currency = 'USD';
    if(!INS_FREQ[p.frequency]) p.frequency = 'yearly';
    if(!p.status) p.status = 'active';
    if(p.showInRecurring === undefined) p.showInRecurring = true;
  });
  return ins;
}
function insCat(id){
  return ensureInsurance().categories.find(c=>c.id===id) || { id:'', name:'Other', icon:'📄', color:'#66746E' };
}

/* ---------- safe link builders (user text must never become javascript: URLs) ---------- */
function insTel(s){ const t = String(s||'').replace(/[^0-9+]/g,''); return t ? 'tel:'+t : ''; }
function insMail(s){ const t = String(s||'').trim(); return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(t) ? 'mailto:'+t : ''; }
function insUrl(s){ const t = String(s||'').trim(); return /^https?:\/\/[^\s"'<>]+$/i.test(t) ? t : ''; }

/* ---------- date helpers (all local-calendar, DST-safe via calendarDaysBetween) ---------- */
function insParseDate(s){ if(!s) return null; const d = parseLocalDateParts(s); return new Date(d.year, d.monthIdx, d.day); }
function insAddMonths(base, n){
  const y = base.getFullYear(), m = base.getMonth()+n;
  const last = new Date(y, m+1, 0).getDate();
  return new Date(y, m, Math.min(base.getDate(), last));
}
function insToday(){ const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); }
function insFmtDate(d){ return d.toLocaleDateString('en-US',{month:'short', day:'numeric', year:'numeric'}); }
function insUrgency(days){
  if(days < 0)   return { cls:'over',  txt:`${-days}d overdue` };
  if(days === 0) return { cls:'red',   txt:'due today' };
  if(days <= 15) return { cls:'red',   txt:`in ${days}d` };
  if(days <= 45) return { cls:'amber', txt:`in ${days}d` };
  return { cls:'ok', txt:`in ${days}d` };
}
function insIsActive(p){
  if(p.status !== 'active') return false;
  const end = insParseDate(p.endDate);
  return !(end && end < insToday());
}
function insEffectiveStatus(p){
  if(p.status === 'active'){ const end = insParseDate(p.endDate); if(end && end < insToday()) return 'expired'; }
  return p.status;
}
/* Every due date of a policy between two dates, stepping from its anchor
   (next due, else start date) by the premium frequency. */
function insDueDates(p, from, to){
  const f = INS_FREQ[p.frequency] || INS_FREQ.yearly;
  const anchor = insParseDate(p.nextDue) || insParseDate(p.startDate);
  if(!anchor || !insIsActive(p)) return [];
  const start = insParseDate(p.startDate), end = insParseDate(p.endDate), out = [];
  if(!f.months){ if(anchor >= from && anchor <= to) out.push(anchor); return out; }
  const diff = (from.getFullYear()-anchor.getFullYear())*12 + (from.getMonth()-anchor.getMonth());
  let k = Math.floor(diff / f.months) - 1;
  for(let guard=0; guard<400; guard++, k++){
    const d = insAddMonths(anchor, k*f.months);
    if(d > to) break;
    if(d < from) continue;
    if(start && d < start) continue;
    if(end && d > end) break;
    out.push(d);
  }
  return out;
}
function insNextDue(p){
  if(!insIsActive(p)) return null;
  const explicit = insParseDate(p.nextDue);
  if(explicit) return explicit;
  const t = insToday();
  return insDueDates(p, t, new Date(t.getFullYear()+3, t.getMonth(), t.getDate()))[0] || null;
}

/* ---------- money helpers ---------- */
function insUsd(amount, currency, y, m){
  const now = new Date();
  return nativeMonthToUsd(num(amount), currency, y===undefined ? now.getFullYear() : y, m===undefined ? now.getMonth() : m);
}
function insAnnualUsd(p){ return insIsActive(p) ? insUsd(p.premium, p.currency) * (INS_FREQ[p.frequency].perYear) : 0; }
function insPaidInYearUsd(p, y){
  return sumArr((p.paid||[]).filter(x=>String(x.date||'').startsWith(String(y))).map(x=>{
    const d = insParseDate(x.date);
    return insUsd(x.amount, p.currency, y, d ? d.getMonth() : 0);
  }));
}

/* ---------- render ---------- */
function renderInsurance(){
  const ins = ensureInsurance();
  const y = state.year, now = new Date(), today = insToday();
  const cats = ins.categories;
  const all = ins.policies;
  const active = all.filter(insIsActive);

  const annualTotal = sumArr(active.map(insAnnualUsd));
  const coverTotal = sumArr(active.map(p=>insUsd(p.sumAssured, p.currency)));
  const upcoming = active.map(p=>({p, d:insNextDue(p)})).filter(x=>x.d).sort((a,b)=>a.d-b.d);
  const nextUp = upcoming[0] || null;
  const nextUrg = nextUp ? insUrgency(calendarDaysBetween(today, nextUp.d)) : null;

  /* KPI cards */
  const kpis = `
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Active policies</div><div class="kpi-value">${active.length}</div><div class="kpi-delta flat">${all.length-active.length} inactive</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">Annual premium</div><div class="kpi-value">${fmt$(annualTotal)}</div><div class="kpi-delta flat">≈ ${fmt$(annualTotal/12)} / month</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">Total cover</div><div class="kpi-value">${fmt$(coverTotal)}</div></div>
      <div class="kpi-card ${nextUrg && (nextUrg.cls==='over'||nextUrg.cls==='red') ? 'c-danger' : 'c-gold'}"><div class="kpi-label">Next premium</div>
        <div class="kpi-value" style="font-size:19px;">${nextUp ? escapeHtml(nextUp.p.name) : '—'}</div>
        <div class="kpi-delta ${nextUrg && nextUrg.cls==='ok' ? 'up':'down'}">${nextUp ? insFmtDate(nextUp.d)+' · '+nextUrg.txt : 'nothing scheduled'}</div></div>
    </div>`;

  /* Option 2 — renewal timeline: 12 month columns starting this month */
  const tlStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const tlEnd = new Date(now.getFullYear(), now.getMonth()+12, 0);
  const cols = Array.from({length:12}, (_,i)=>({ date:new Date(now.getFullYear(), now.getMonth()+i, 1), events:[] }));
  const colOf = d => Math.max(0, (d.getFullYear()-tlStart.getFullYear())*12 + d.getMonth()-tlStart.getMonth());
  active.forEach(p=>{
    // Only dates from today onward — earlier steps of the schedule are history
    // (already paid, or superseded by the current next-due date).
    const dues = insDueDates(p, today, tlEnd);
    dues.forEach(d=> cols[colOf(d)].events.push({p, d, type:'due'}));
    // A next-due date that has already passed and wasn't marked paid = overdue.
    const nd = insNextDue(p);
    if(nd && nd < today) cols[colOf(nd)].events.push({p, d:nd, type:'due'});
    const end = insParseDate(p.endDate);
    if(end && end >= today && end <= tlEnd && !dues.some(d=>+d===+end)){
      cols[colOf(end)].events.push({p, d:end, type:'renew'});
    }
  });
  const chip = e=>{
    const u = insUrgency(calendarDaysBetween(today, e.d)), c = insCat(e.p.categoryId);
    const label = e.p.name.length>13 ? e.p.name.slice(0,12)+'…' : e.p.name;
    return `<button class="ins-chip u-${u.cls}" data-ins-edit="${e.p.id}" title="${escapeHtml(e.p.name)} — ${e.type==='renew'?'ends/renews':'premium due'} ${insFmtDate(e.d)} (${u.txt})">${e.type==='renew'?'🔄':c.icon} ${escapeHtml(label)} <b>${e.d.getDate()}</b></button>`;
  };
  const timeline = `
    <div class="card">
      <div class="card-head"><h3>Renewal timeline · next 12 months</h3>
        <span class="ins-legend"><i class="u-over"></i>overdue <i class="u-red"></i>≤ 15 days <i class="u-amber"></i>≤ 45 days <i class="u-ok"></i>later</span></div>
      <div class="ins-timeline">${cols.map((c,i)=>`
        <div class="ins-tl-col ${i===0?'now':''}">
          <div class="ins-tl-month">${MONTHS[c.date.getMonth()]}${c.date.getMonth()===0||i===0 ? ' <span>'+c.date.getFullYear()+'</span>' : ''}</div>
          <div class="ins-tl-body">${c.events.sort((a,b)=>a.d-b.d).map(chip).join('') || '<span class="ins-tl-empty">—</span>'}</div>
        </div>`).join('')}
      </div>
    </div>`;

  /* Option 3 — category cards with a "paid so far this year" ring */
  const catCards = cats.map(c=>{
    const ps = all.filter(p=>p.categoryId===c.id);
    const act = ps.filter(insIsActive);
    const annual = sumArr(act.map(insAnnualUsd));
    const paid = sumArr(ps.map(p=>insPaidInYearUsd(p, y)));
    const pct = annual>0 ? Math.min(100, Math.round(paid/annual*100)) : 0;
    const nd = act.map(insNextDue).filter(Boolean).sort((a,b)=>a-b)[0];
    const u = nd ? insUrgency(calendarDaysBetween(today, nd)) : null;
    const removable = !ps.length && !INS_DEFAULT_CATS.some(d=>d.id===c.id);
    return `
    <div class="ins-cat ${insFilterCat===c.id?'sel':''}" data-ins-filter="${c.id}" style="--c:${c.color}">
      <div class="ins-ring" style="--p:${pct}" title="${pct}% of this year's premium paid (${y})"><span>${pct}%</span></div>
      <div class="ins-cat-main">
        <div class="ins-cat-name">${c.icon} ${escapeHtml(c.name)} ${removable?`<span class="row-del" data-ins-delcat="${c.id}" title="remove empty category">✕</span>`:''}</div>
        <div class="ins-cat-sub">${ps.length} polic${ps.length===1?'y':'ies'} · ${fmt$(annual)}/yr</div>
        ${u ? `<span class="ins-pill u-${u.cls}">next ${nd.toLocaleDateString('en-US',{month:'short',day:'numeric'})} · ${u.txt}</span>` : '<span class="ins-cat-sub">no upcoming premium</span>'}
      </div>
    </div>`;
  }).join('');

  /* Option 5 — analytics numbers */
  const mi = currentSnapshotMonth(y);
  const monthIncome = incomeTotals(y)[mi] || 0;
  const monthlyAvg = annualTotal/12;
  const incomePct = monthIncome>0 ? monthlyAvg/monthIncome*100 : null;
  const yoy = active.filter(p=>num(p.prevPremium)>0 && INS_FREQ[p.frequency].perYear)
    .map(p=>({p, delta:(num(p.premium)-num(p.prevPremium))*INS_FREQ[p.frequency].perYear, pct:(num(p.premium)/num(p.prevPremium)-1)*100}));
  const yoyTotalUsd = sumArr(yoy.map(x=>insUsd(x.delta, x.p.currency)));
  const analytics = `
    <div class="card">
      <div class="card-head"><h3>Where the premium goes</h3><span class="section-sub" style="margin:0;">Annualised, in USD</span></div>
      ${annualTotal>0 ? `<div class="chart-box short"><canvas id="chartInsDonut"></canvas></div>` : '<div class="section-sub" style="padding:24px 0; text-align:center;">Add a policy to see the split.</div>'}
    </div>
    <div class="card">
      <div class="card-head"><h3>Premium cash out by month · ${y}</h3></div>
      ${annualTotal>0 ? `<div class="chart-box short"><canvas id="chartInsBar"></canvas></div>` : '<div class="section-sub" style="padding:24px 0; text-align:center;">Nothing due yet.</div>'}
    </div>
    <div class="card">
      <div class="card-head"><h3>Cash-flow weight</h3></div>
      <div class="ins-meter-label">Insurance ≈ <b>${fmt$(monthlyAvg)}</b> / month${incomePct===null?'':` · <b>${incomePct.toFixed(1)}%</b> of ${MONTHS[mi]} income`}</div>
      ${incomePct===null ? '<div class="section-sub">Add income for this month to see the share.</div>' : `<div class="ins-meter"><i style="width:${Math.min(100,incomePct)}%"></i></div>`}
      <div class="ins-meter-label" style="margin-top:14px;">Change vs last premium</div>
      ${yoy.length ? `<div class="ins-yoy">${yoy.sort((a,b)=>Math.abs(b.pct)-Math.abs(a.pct)).slice(0,4).map(x=>`<span class="ins-pill ${x.pct>0?'u-red':x.pct<0?'u-ok':''}">${escapeHtml(x.p.name)} ${x.pct>=0?'+':''}${x.pct.toFixed(1)}%</span>`).join('')}</div>
        <div class="section-sub" style="margin-top:8px;">Net ${yoyTotalUsd>=0?'+':'−'}${fmt$(Math.abs(yoyTotalUsd))} per year across the policies you've entered a previous premium for.</div>`
        : '<div class="section-sub">Enter "Previous premium" on a policy to track price hikes.</div>'}
    </div>`;

  /* Policy cards */
  const shown = all.filter(p=>!insFilterCat || p.categoryId===insFilterCat)
    .sort((a,b)=>{ const da = insNextDue(a), db = insNextDue(b); if(da&&db) return da-db; return da ? -1 : db ? 1 : a.name.localeCompare(b.name); });
  const kv = (label, val)=> val ? `<div><small>${label}</small><b>${val}</b></div>` : '';
  const polCard = p=>{
    const c = insCat(p.categoryId), st = insEffectiveStatus(p), nd = insNextDue(p);
    const u = nd ? insUrgency(calendarDaysBetween(today, nd)) : null;
    const f = INS_FREQ[p.frequency];
    const nominees = (p.nominees||[]).filter(n=>n.name).map(n=>`${escapeHtml(n.name)}${n.relation?' ('+escapeHtml(n.relation)+')':''}${n.share!==''&&n.share!=null?' · '+escapeHtml(n.share)+'%':''}`).join('<br>');
    const doc = insUrl(p.docUrl);
    return `
    <div class="ins-pol" style="--c:${c.color}">
      <div class="ins-pol-head">
        <div><div class="ins-pol-name">${c.icon} ${escapeHtml(p.name)}</div>
          <div class="ins-pol-sub">${escapeHtml(c.name)}${p.insurer?' · '+escapeHtml(p.insurer):''}${p.policyNo?' · #'+escapeHtml(p.policyNo):''}</div></div>
        <span class="ins-pill ${st==='active'?'u-ok':'u-over'}">${st}</span>
      </div>
      <div class="ins-kv">
        ${kv('Premium', `${fmtNative(num(p.premium), p.currency)} <em>${f.label.toLowerCase()}</em>`)}
        ${kv('Next due', nd ? `${insFmtDate(nd)}<br><span class="ins-pill u-${u.cls}">${u.txt}</span>` : '')}
        ${kv('Cover', num(p.sumAssured)>0 ? fmtNative(num(p.sumAssured), p.currency) : '')}
        ${kv('Insured', escapeHtml(p.insuredFor))}
        ${kv('Bought from', p.boughtFrom||p.boughtVia ? escapeHtml([p.boughtFrom, p.boughtVia && '('+p.boughtVia+')'].filter(Boolean).join(' ')) : '')}
        ${kv('Started', p.startDate ? insFmtDate(insParseDate(p.startDate)) : '')}
        ${kv('Ends / renews', p.endDate ? insFmtDate(insParseDate(p.endDate)) : '')}
        ${kv('Nominee', nominees)}
      </div>
      ${p.notes ? `<div class="ins-note">${escapeHtml(p.notes)}</div>` : ''}
      <div class="ins-actions">
        ${nd && num(p.premium)>0 ? `<button class="btn small sell" data-ins-paid="${p.id}">✓ Mark paid</button>` : ''}
        <button class="btn small" data-ins-edit="${p.id}">✏️ Edit</button>
        ${doc ? `<a class="btn small" href="${escapeHtml(doc)}" target="_blank" rel="noopener noreferrer">📎 Document</a>` : ''}
        <span class="row-del" data-ins-del="${p.id}" title="delete policy" style="margin-left:auto;">✕</span>
      </div>
    </div>`;
  };

  /* Option 6 — contact directory */
  const withContact = all.filter(p=>p.contactName||p.contactPhone||p.contactEmail||p.claimsPhone);
  const contactCard = p=>{
    const c = insCat(p.categoryId);
    const call = insTel(p.contactPhone), mail = insMail(p.contactEmail), claim = insTel(p.claimsPhone);
    return `<div class="ins-contact" style="--c:${c.color}">
      <div class="ins-avatar">${escapeHtml((p.contactName||p.insurer||'?').trim().charAt(0).toUpperCase())}</div>
      <div class="ins-contact-main">
        <div class="ins-pol-name" style="font-size:14px;">${escapeHtml(p.contactName||'Contact not named')}</div>
        <div class="ins-pol-sub">${escapeHtml(p.insurer||'')}${p.insurer?' · ':''}${c.icon} ${escapeHtml(p.name)}</div>
        <div class="ins-actions" style="margin-top:8px;">
          ${call?`<a class="btn small" href="${escapeHtml(call)}">📞 Call</a>`:''}
          ${mail?`<a class="btn small" href="${escapeHtml(mail)}">✉️ Email</a>`:''}
          ${claim?`<a class="btn small danger-outline" href="${escapeHtml(claim)}">🚨 Claims</a>`:''}
        </div>
      </div></div>`;
  };

  document.getElementById('panel-insurance').innerHTML = `
    <div class="section-title">Insurance</div>
    <p class="section-sub">Every policy in one place — who covers what, what you pay, who to call, and who the nominee is. Premiums also appear in the 🔁 Recurring tab.</p>
    <div class="ins-toolbar">
      <button class="btn primary" data-ins-add>+ Add policy</button>
      <button class="btn" data-ins-addcat>+ Add category</button>
      ${insFilterCat ? `<button class="btn ghost" data-ins-filter="">Showing ${escapeHtml(insCat(insFilterCat).name)} — show all</button>` : ''}
    </div>
    ${kpis}
    ${timeline}
    <div class="section-title" style="font-size:17px; margin-top:6px;">Categories</div>
    <div class="ins-cat-grid">${catCards}</div>
    <div class="ins-analytics">${analytics}</div>
    <div class="section-title" style="font-size:17px;">Policies${insFilterCat?' · '+escapeHtml(insCat(insFilterCat).name):''}</div>
    ${shown.length ? `<div class="ins-pol-grid">${shown.map(polCard).join('')}</div>` : `
      <div class="card" style="text-align:center; padding:34px 20px;"><div style="font-size:30px;">🛡️</div>
        <div class="section-sub" style="margin:8px 0 14px;">${all.length ? 'No policies in this category yet.' : 'No policies yet — add your term, health, home and car cover to see everything here.'}</div>
        <button class="btn primary" data-ins-add>+ Add policy</button></div>`}
    <div class="section-title" style="font-size:17px; margin-top:26px;">Contacts &amp; claims</div>
    ${withContact.length ? `<div class="ins-contact-grid">${withContact.map(contactCard).join('')}</div>` : '<div class="section-sub">Add an agent or claims number to a policy and it shows up here with tap-to-call.</div>'}
  `;

  /* charts */
  destroyChart('insDonut'); destroyChart('insBar');
  if(annualTotal>0){
    const rows = cats.map(c=>({c, v:sumArr(active.filter(p=>p.categoryId===c.id).map(insAnnualUsd))})).filter(r=>r.v>0);
    charts.insDonut = safeChart(document.getElementById('chartInsDonut'), {
      type:'doughnut',
      data:{ labels:rows.map(r=>r.c.name), datasets:[{ data:rows.map(r=>Math.round(r.v)), backgroundColor:rows.map(r=>r.c.color), borderColor:'#1C2726', borderWidth:2 }] },
      options:{ responsive:true, maintainAspectRatio:false, cutout:'62%', plugins:{ legend:{ position:'right', labels:{ boxWidth:10, boxHeight:10 } }, tooltip:{ callbacks:{ label:c=>` ${c.label}: ${fmt$(c.parsed)}/yr` } } } }
    });
    const yStart = new Date(y,0,1), yEnd = new Date(y,11,31);
    const byMonth = Array(12).fill(0);
    active.forEach(p=> insDueDates(p, yStart, yEnd).forEach(d=>{ byMonth[d.getMonth()] += insUsd(p.premium, p.currency, y, d.getMonth()); }));
    charts.insBar = safeChart(document.getElementById('chartInsBar'), {
      type:'bar',
      data:{ labels:MONTHS, datasets:[{ label:'Premium due', data:byMonth.map(v=>Math.round(v)), backgroundColor:'#C9A961', borderRadius:4 }] },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } }, scales:{ y:{ grid:{ color:'#26332F' }, ticks:{ callback:v=>'$'+v } }, x:{ grid:{ display:false } } } }
    });
  }

  /* wiring */
  const panel = document.getElementById('panel-insurance');
  panel.querySelectorAll('[data-ins-add]').forEach(el=>el.addEventListener('click', ()=>openPolicyModal()));
  panel.querySelectorAll('[data-ins-addcat]').forEach(el=>el.addEventListener('click', ()=>openInsCategoryModal()));
  panel.querySelectorAll('[data-ins-edit]').forEach(el=>el.addEventListener('click', ()=>{
    const p = ins.policies.find(x=>x.id===el.dataset.insEdit); if(p) openPolicyModal(p);
  }));
  panel.querySelectorAll('[data-ins-filter]').forEach(el=>el.addEventListener('click', ()=>{
    const id = el.dataset.insFilter;
    insFilterCat = (!id || insFilterCat===id) ? null : id;
    renderInsurance();
  }));
  panel.querySelectorAll('[data-ins-delcat]').forEach(el=>el.addEventListener('click', (e)=>{
    e.stopPropagation();
    const c = ins.categories.find(x=>x.id===el.dataset.insDelcat); if(!c) return;
    if(!confirm(`Remove the empty category "${c.name}"?`)) return;
    ins.categories = ins.categories.filter(x=>x.id!==c.id);
    if(insFilterCat===c.id) insFilterCat = null;
    markDirty('insurance', {tab:'insurance', action:'delete', target:'Category '+c.name});
    renderInsurance();
  }));
  panel.querySelectorAll('[data-ins-del]').forEach(el=>el.addEventListener('click', ()=>{
    const p = ins.policies.find(x=>x.id===el.dataset.insDel); if(!p) return;
    if(!confirm(`Delete "${p.name}" and its payment history? This can't be undone.`)) return;
    ins.policies = ins.policies.filter(x=>x.id!==p.id);
    markDirty('insurance', {tab:'insurance', action:'delete', target:p.name});
    renderInsurance();
  }));
  panel.querySelectorAll('[data-ins-paid]').forEach(el=>el.addEventListener('click', ()=>{
    const p = ins.policies.find(x=>x.id===el.dataset.insPaid); if(p) insMarkPaid(p);
  }));
}

/* Records a payment against the current due date and rolls nextDue forward
   one period. Tracker only — it doesn't move money between accounts; log the
   payment in Cash Flow (Add money → Expense) if you want the balance to move. */
function insMarkPaid(p){
  const due = insNextDue(p); if(!due) return;
  const f = INS_FREQ[p.frequency];
  const next = f.months ? insAddMonths(due, f.months) : null;
  if(!confirm(`Mark ${fmtNative(num(p.premium), p.currency)} as paid for ${insFmtDate(due)}?${next?`\nNext due moves to ${insFmtDate(next)}.`:''}`)) return;
  p.paid.push({ date: todayDateStr(), due: toLocalISODate(due), amount: num(p.premium) });
  p.nextDue = next ? toLocalISODate(next) : '';
  markDirty('insurance', {tab:'insurance', action:'edit', target:p.name, field:'paid', newVal:insFmtDate(due)});
  renderInsurance();
  showToast(`${p.name} marked paid`);
}

/* ---------- Add / edit policy modal ---------- */
function openPolicyModal(existing){
  const ins = ensureInsurance();
  const old = document.getElementById('insPolicyOverlay'); if(old) old.remove();
  const p = existing || { name:'', categoryId:ins.categories[0].id, currency:'USD', frequency:'yearly', status:'active', nominees:[{name:'',relation:'',share:''}], showInRecurring:true };
  const banks = (yearData(state.year).banks||[]);
  const v = k => escapeHtml(p[k]==null ? '' : p[k]);
  const opt = (val, label, cur)=>`<option value="${escapeHtml(val)}" ${val===cur?'selected':''}>${escapeHtml(label)}</option>`;

  const overlay = document.createElement('div');
  overlay.id = 'insPolicyOverlay'; overlay.className = 'modal-overlay';
  overlay.innerHTML = `
  <div class="modal-card ins-modal">
    <h3>${existing?'✏️ Edit policy':'🛡️ Add policy'}</h3>
    <p class="modal-sub">Only name and premium are required — fill in the rest whenever you have it.</p>
    <div class="ins-form-grid">
      <div class="modal-field"><label>Policy name</label><input id="ipName" value="${v('name')}" placeholder="e.g. HDFC Click 2 Protect"></div>
      <div class="modal-field"><label>Category</label><select id="ipCat">${ins.categories.map(c=>opt(c.id, c.icon+' '+c.name, p.categoryId)).join('')}<option value="__new__">+ New category…</option></select></div>
      <div class="modal-field"><label>Insurer / company</label><input id="ipInsurer" value="${v('insurer')}" placeholder="e.g. HDFC Life"></div>
      <div class="modal-field"><label>Policy number</label><input id="ipNo" value="${v('policyNo')}"></div>
      <div class="modal-field"><label>Who / what is covered</label><input id="ipInsured" value="${v('insuredFor')}" placeholder="Me, spouse, Honda Civic, flat…"></div>
      <div class="modal-field"><label>Status</label><select id="ipStatus">${['active','lapsed','expired'].map(s=>opt(s, s[0].toUpperCase()+s.slice(1), p.status)).join('')}</select></div>
      <div class="modal-field"><label>Where you bought it</label><input id="ipFrom" value="${v('boughtFrom')}" placeholder="Bank, agent name, website…"></div>
      <div class="modal-field"><label>Bought via</label><select id="ipVia"><option value="">—</option>${INS_BOUGHT_VIA.map(s=>opt(s, s, p.boughtVia)).join('')}</select></div>
      <div class="modal-field"><label>Premium</label><input id="ipPremium" type="number" min="0" step="any" value="${v('premium')}"></div>
      <div class="modal-field"><label>Currency</label><select id="ipCur">${opt('USD','USD',p.currency)}${opt('INR','INR',p.currency)}</select></div>
      <div class="modal-field"><label>Paid</label><select id="ipFreq">${Object.entries(INS_FREQ).map(([k,f])=>opt(k, f.label, p.frequency)).join('')}</select></div>
      <div class="modal-field"><label>Next premium due</label><input id="ipNext" type="date" value="${v('nextDue')}"></div>
      <div class="modal-field"><label>Start date</label><input id="ipStart" type="date" value="${v('startDate')}"></div>
      <div class="modal-field"><label>Ends / renews on</label><input id="ipEnd" type="date" value="${v('endDate')}"></div>
      <div class="modal-field"><label>Cover / sum assured</label><input id="ipCover" type="number" min="0" step="any" value="${v('sumAssured')}"></div>
      <div class="modal-field"><label>Previous premium <span class="hint">optional</span></label><input id="ipPrev" type="number" min="0" step="any" value="${v('prevPremium')}"></div>
      <div class="modal-field"><label>Paid from account <span class="hint">for the Recurring tab check</span></label><select id="ipBank"><option value="">— not linked —</option>${banks.filter(b=>b.type!=='credit').map(b=>opt(b.id, b.name, p.payFromBankId)).join('')}</select></div>
      <div class="modal-field"><label>Document link <span class="hint">https://…</span></label><input id="ipDoc" value="${v('docUrl')}"></div>
    </div>
    <div class="ins-form-section">Contact</div>
    <div class="ins-form-grid">
      <div class="modal-field"><label>Contact person</label><input id="ipCName" value="${v('contactName')}"></div>
      <div class="modal-field"><label>Phone</label><input id="ipCPhone" value="${v('contactPhone')}"></div>
      <div class="modal-field"><label>Email</label><input id="ipCMail" value="${v('contactEmail')}"></div>
      <div class="modal-field"><label>Claims helpline</label><input id="ipClaims" value="${v('claimsPhone')}"></div>
    </div>
    <div class="ins-form-section">Nominees <span id="ipShareTotal" class="hint"></span></div>
    <div id="ipNominees"></div>
    <button class="btn small" id="ipAddNominee" type="button" style="margin-bottom:14px;">+ Add nominee</button>
    <div class="modal-field"><label>Notes</label><textarea id="ipNotes" rows="2">${v('notes')}</textarea></div>
    <label class="ins-check"><input type="checkbox" id="ipRecur" ${p.showInRecurring!==false?'checked':''}> Show this premium in the 🔁 Recurring tab</label>
    <div class="modal-actions" style="margin-top:16px;">
      <button class="btn" id="ipCancel">Cancel</button>
      <button class="btn primary" id="ipSave">${existing?'Save changes':'Add policy'}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const $ = id => overlay.querySelector('#'+id);
  const nomWrap = $('ipNominees');
  let nominees = (p.nominees||[]).map(n=>({...n}));
  if(!nominees.length) nominees = [{name:'',relation:'',share:''}];
  function drawNominees(){
    nomWrap.innerHTML = nominees.map((n,i)=>`
      <div class="ins-nom-row">
        <input data-n="name" data-i="${i}" placeholder="Name" value="${escapeHtml(n.name)}">
        <input data-n="relation" data-i="${i}" placeholder="Relationship" value="${escapeHtml(n.relation)}">
        <input data-n="share" data-i="${i}" type="number" min="0" max="100" step="any" placeholder="Share %" value="${escapeHtml(n.share)}">
        <button class="btn small" type="button" data-nrm="${i}" title="remove">✕</button>
      </div>`).join('');
    nomWrap.querySelectorAll('input').forEach(inp=>inp.addEventListener('input', ()=>{ nominees[+inp.dataset.i][inp.dataset.n] = inp.value; updateShare(); }));
    nomWrap.querySelectorAll('[data-nrm]').forEach(b=>b.addEventListener('click', ()=>{ nominees.splice(+b.dataset.nrm,1); if(!nominees.length) nominees.push({name:'',relation:'',share:''}); drawNominees(); }));
    updateShare();
  }
  function shareTotal(){ return nominees.reduce((a,n)=>a+(parseFloat(n.share)||0),0); }
  function updateShare(){
    const t = shareTotal();
    $('ipShareTotal').textContent = t ? `· total ${t}%` : '';
    $('ipShareTotal').style.color = t>100 ? 'var(--danger)' : '';
  }
  drawNominees();
  $('ipAddNominee').addEventListener('click', ()=>{ nominees.push({name:'',relation:'',share:''}); drawNominees(); });

  $('ipCat').addEventListener('change', (e)=>{
    if(e.target.value !== '__new__') return;
    openInsCategoryModal((newId)=>{
      const cur = existing ? existing.categoryId : ins.categories[0].id;
      $('ipCat').innerHTML = ins.categories.map(c=>opt(c.id, c.icon+' '+c.name, newId||cur)).join('') + '<option value="__new__">+ New category…</option>';
    }, true);
    e.target.value = existing ? existing.categoryId : ins.categories[0].id;
  });

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', e=>{ if(e.target===overlay) close(); });
  $('ipCancel').addEventListener('click', close);
  $('ipSave').addEventListener('click', ()=>{
    const name = $('ipName').value.trim();
    const premium = parseFloat($('ipPremium').value);
    if(!name){ $('ipName').focus(); return; }
    if(isNaN(premium) || premium < 0){ $('ipPremium').focus(); return; }
    if(shareTotal() > 100){ showToast('Nominee shares add up to more than 100%'); return; }
    const num2 = id => { const x = parseFloat($(id).value); return isNaN(x) ? '' : x; };
    const data = {
      name, categoryId:$('ipCat').value, insurer:$('ipInsurer').value.trim(), policyNo:$('ipNo').value.trim(),
      insuredFor:$('ipInsured').value.trim(), status:$('ipStatus').value, boughtFrom:$('ipFrom').value.trim(), boughtVia:$('ipVia').value,
      premium, currency:$('ipCur').value, frequency:$('ipFreq').value, nextDue:$('ipNext').value, startDate:$('ipStart').value, endDate:$('ipEnd').value,
      sumAssured:num2('ipCover'), prevPremium:num2('ipPrev'), payFromBankId:$('ipBank').value, docUrl:$('ipDoc').value.trim(),
      contactName:$('ipCName').value.trim(), contactPhone:$('ipCPhone').value.trim(), contactEmail:$('ipCMail').value.trim(), claimsPhone:$('ipClaims').value.trim(),
      nominees:nominees.filter(n=>n.name.trim()||n.relation.trim()||n.share!=='').map(n=>({name:n.name.trim(), relation:n.relation.trim(), share:n.share===''?'':parseFloat(n.share)})),
      notes:$('ipNotes').value.trim(), showInRecurring:$('ipRecur').checked
    };
    if(existing){ Object.assign(existing, data); }
    else { ins.policies.push({ id:uid(), paid:[], ...data }); }
    markDirty('insurance', {tab:'insurance', action:existing?'edit':'add', target:name});
    close();
    renderInsurance();
    showToast(existing ? 'Policy updated' : 'Policy added');
  });
  $('ipName').focus();
}

/* ---------- Add category modal ---------- */
function openInsCategoryModal(onDone, keepPolicyModal){
  const ins = ensureInsurance();
  const old = document.getElementById('insCatOverlay'); if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'insCatOverlay'; overlay.className = 'modal-overlay';
  overlay.style.zIndex = 320;
  overlay.innerHTML = `
  <div class="modal-card ins-modal" style="width:360px;">
    <h3>+ New category</h3>
    <p class="modal-sub">e.g. Pet, Gadget, Mobile phone, Rent guarantee…</p>
    <div class="modal-field"><label>Name</label><input id="icName" placeholder="Category name"></div>
    <div class="ins-form-grid">
      <div class="modal-field"><label>Icon <span class="hint">any emoji</span></label><input id="icIcon" value="📄" maxlength="4"></div>
      <div class="modal-field"><label>Colour</label><input id="icColor" type="color" value="${PALETTE[ins.categories.length % PALETTE.length]}" style="padding:2px; height:38px;"></div>
    </div>
    <div class="modal-actions"><button class="btn" id="icCancel">Cancel</button><button class="btn primary" id="icSave">Add category</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const $ = id => overlay.querySelector('#'+id);
  const close = ()=> overlay.remove();
  overlay.addEventListener('click', e=>{ if(e.target===overlay) close(); });
  $('icCancel').addEventListener('click', close);
  $('icSave').addEventListener('click', ()=>{
    const name = $('icName').value.trim();
    if(!name){ $('icName').focus(); return; }
    if(ins.categories.some(c=>c.name.toLowerCase()===name.toLowerCase())){ showToast('That category already exists'); return; }
    const cat = { id:'cat_'+uid(), name, icon:$('icIcon').value.trim() || '📄', color:$('icColor').value };
    ins.categories.push(cat);
    markDirty('insurance', {tab:'insurance', action:'add', target:'Category '+name});
    close();
    if(onDone) onDone(cat.id);
    if(!keepPolicyModal) renderInsurance();
  });
  $('icName').focus();
}

/* =========================================================================
   RECURRING-TAB LINK — tab-recurring.js appends this section to its page.
   ========================================================================= */
function insuranceRecurringSectionHtml(){
  if(typeof DATA === 'undefined' || !DATA) return '';
  const ins = ensureInsurance(), y = state.year, today = insToday();
  const rows = ins.policies.filter(p=>insIsActive(p) && p.showInRecurring && INS_FREQ[p.frequency].months && num(p.premium)>0)
    .map(p=>({p, d:insNextDue(p)})).filter(x=>x.d).sort((a,b)=>a.d-b.d);
  if(!rows.length) return '';
  const monthly = sumArr(rows.map(r=>insAnnualUsd(r.p)))/12;
  const snap = currentSnapshotMonth(y);
  const body = rows.map(({p,d})=>{
    const u = insUrgency(calendarDaysBetween(today, d)), c = insCat(p.categoryId), f = INS_FREQ[p.frequency];
    const bank = (yearData(y).banks||[]).find(b=>b.id===p.payFromBankId);
    let funding = '<span style="color:var(--text-dim); font-size:11.5px;">— not linked —</span>';
    if(bank){
      const avail = accountDisplayValueAt(bank, snap) || 0;
      const need = convertCurrency(p.premium, p.currency, bank.currency, y, snap);
      funding = `<div style="font-size:11.5px;"><div>${escapeHtml(bank.name)}</div><div style="color:${avail>=need?'var(--good)':'var(--rust-soft)'}; font-weight:600;">${avail>=need?'✅ Ready':'⚠ Short '+fmtNative(need-avail, bank.currency)}</div></div>`;
    }
    return `<tr>
      <td style="font-weight:600;">${c.icon} ${escapeHtml(p.name)} <span class="debt-tag">${escapeHtml(c.name)}</span></td>
      <td>${fmtNative(num(p.premium), p.currency)}</td>
      <td>${f.label}</td>
      <td style="white-space:nowrap;">${insFmtDate(d)} <span class="ins-pill u-${u.cls}">${u.txt}</span></td>
      <td>${funding}</td></tr>`;
  }).join('');
  return `
    <div class="card" id="insRecurCard">
      <div class="card-head"><h3>🛡️ Insurance premiums</h3>
        <span class="section-sub" style="margin:0;">≈ <b style="color:var(--gold-soft)">${fmt$(monthly,2)}</b> / month · <a href="#" data-ins-goto style="color:var(--teal-soft);">manage in Insurance</a></span></div>
      <div class="table-scroll"><table class="ledger">
        <thead><tr><th>Policy</th><th>Premium</th><th>Frequency</th><th>Next due</th><th>Paid from</th></tr></thead>
        <tbody>${body}</tbody></table></div>
    </div>`;
}
function wireInsuranceRecurringSection(){
  const a = document.querySelector('#insRecurCard [data-ins-goto]');
  if(a) a.addEventListener('click', e=>{ e.preventDefault(); const b = document.querySelector('.tab-btn[data-tab="insurance"]'); if(b) b.click(); });
}
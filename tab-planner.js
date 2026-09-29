/* =========================================================================
   FINANCIAL PLAN TAB
   Modelled on the "Financial_Plan" spreadsheet (details + tax + SIP
   projection) and extended with ideas from online planners: inflation-
   adjusted value, required SIP, step-up vs flat, Coast-FIRE, safe-
   withdrawal income, FIRE number, and a return x step-up sensitivity grid.

   Every field is EDITABLE. Some also AUTO-FILL from the rest of the app
   until you type over them (then they show "edited", with a ↺ to go back):
     - Monthly salary   <- average monthly income (Income tab)
     - Monthly expenses <- average monthly expenses (Expenses tab)
     - Stocks           <- current value of open holdings (Holdings tab)
     - SIP              <- monthly-equivalent of your recurring buys
                           (Holdings -> recurring), or average monthly buys
   The maths lives in planner-engine.js (pure functions, unit-tested).
   Settings persist in DATA.planner (global, like the debt payment plan).
   ========================================================================= */

const PLANNER_FIELDS = {
  name:            {label:'Name',                    kind:'text',  def:''},
  age:             {label:'Current age',             kind:'int',   def:30, min:0,   max:100},
  retireAge:       {label:'Plan to retire by (age)', kind:'int',   def:60, min:1,   max:120},
  salary:          {label:'Monthly salary',          kind:'money', auto:true},
  monthlyExpenses: {label:'Monthly expenses',        kind:'money', auto:true},
  emergency:       {label:'Emergency fund',          kind:'money', defUsd:0},
  stocks:          {label:'Stocks (current value)',  kind:'money', auto:true},
  sip:             {label:'Monthly SIP',             kind:'money', auto:true},
  target:          {label:'Target value (goal)',     kind:'money', defUsd:1000000},
  ret:             {label:'Expected return',         kind:'pct',   def:0.10, min:-0.5, max:0.6},
  stepUp:          {label:'SIP step-up per year',    kind:'pct',   def:0.10, min:0,    max:1},
  inflation:       {label:'Inflation',               kind:'pct',   def:0.06, min:-0.1, max:1},
  swr:             {label:'Safe withdrawal rate',    kind:'pct',   def:0.04, min:0.001, max:0.2},
  stNet:           {label:'Short-term: net return',  kind:'pct',   def:0.14, min:-0.5, max:1},
  stTax:           {label:'Short-term: tax',         kind:'pct',   def:0.20, min:0,    max:1},
  ltNet:           {label:'Long-term: net return',   kind:'pct',   def:0.14, min:-0.5, max:1},
  ltTax:           {label:'Long-term: tax',          kind:'pct',   def:0.125, min:0,   max:1}
};
const PLANNER_TYPE_LABEL = {stock:'Stocks', mf:'Mutual funds', etf:'ETFs', index:'Index', crypto:'Crypto', other:'Other'};

/* ---------- persisted settings ---------- */
function plannerState(){
  if(!DATA.planner || typeof DATA.planner !== 'object') DATA.planner = {};
  const P = DATA.planner;
  if(P.currency !== 'INR' && P.currency !== 'USD') P.currency = 'USD';
  if(!P.ov || typeof P.ov !== 'object') P.ov = {};
  if(!P.opts || typeof P.opts !== 'object') P.opts = {};
  if(!Array.isArray(P.opts.holdingTypes) || !P.opts.holdingTypes.length) P.opts.holdingTypes = ['stock'];
  if(!['auto','recurring','avgBuys'].includes(P.opts.sipMode)) P.opts.sipMode = 'auto';
  if(P.opts.excludedIncome !== null && !Array.isArray(P.opts.excludedIncome)) P.opts.excludedIncome = null; // null = default rule
  return P;
}

/* ---------- currency helpers (engine runs in DISPLAY units) ---------- */
function plannerCur(){ return plannerState().currency; }
function plannerFxRate(){ const f = (typeof _ensureFx === 'function') ? _ensureFx() : null; return (f && f.INR) ? f.INR : FX_FALLBACK_INR; }
function plannerUsdToDisp(usd){ return plannerCur()==='INR' ? usd * plannerFxRate() : usd; }
function plannerSym(c){ return (c||plannerCur())==='INR' ? '₹' : '$'; }
function plannerFmt(v, opts){
  v = plannerNum(v);
  const inr = plannerCur()==='INR', sym = plannerSym();
  const neg = v < 0, a = Math.abs(v);
  const full = () => sym + a.toLocaleString(inr?'en-IN':'en-US', {maximumFractionDigits:0});
  let s;
  if(opts && opts.full) s = full();
  else if(inr){
    if(a >= 1e7) s = '₹' + (a/1e7).toFixed(2) + ' Cr';
    else if(a >= 1e5) s = '₹' + (a/1e5).toFixed(2) + ' L';
    else s = full();
  } else {
    if(a >= 1e9) s = '$' + (a/1e9).toFixed(2) + 'B';
    else if(a >= 1e6) s = '$' + (a/1e6).toFixed(2) + 'M';
    else s = full();
  }
  return (neg ? '-' : '') + s;
}
function plannerInputStr(v, kind){
  if(kind==='pct') return String(Math.round(v*100*1000)/1000);
  return String(Math.round(v*100)/100);
}

/* ---------- auto-fill sources ---------- */
function plannerIncomeExcludedSet(items){
  const P = plannerState();
  if(P.opts.excludedIncome === null){
    // Default: leave out the auto-filled "Retirement" row (your own 401k/
    // NPS contribution mirrored as income — not salary you take home).
    return new Set(items.filter(it => (it.name||'').trim().toLowerCase()==='retirement').map(it=>it.id));
  }
  return new Set(P.opts.excludedIncome);
}
function plannerAutoValues(){
  const y = state.year, P = plannerState();
  const out = {
    salary:{usd:0, has:false, note:'No income entered yet'},
    monthlyExpenses:{usd:0, has:false, note:'No expenses entered yet'},
    stocks:{usd:0, has:false, note:'No open holdings of the selected types'},
    sip:{usd:0, has:false, note:'No recurring buys or recent buys found'}
  };
  const types = new Set(P.opts.holdingTypes);

  try{
    const upto = currentSnapshotMonth(y);
    const items = yearData(y).income || [];
    const excl = plannerIncomeExcludedSet(items);
    const tot = n12();
    items.forEach(it=>{ if(excl.has(it.id)) return; (it.m||[]).forEach((v,i)=>{ tot[i] += nativeMonthToUsd(v, it.currency||'USD', y, i); }); });
    const a = plannerAverageActive(tot, upto);
    if(a.months){ out.salary = {usd:a.avg, has:true, note:`Average of ${a.months} month${a.months===1?'':'s'} with income (${MONTHS[0]}–${MONTHS[upto]} ${y})`}; }
    const e = plannerAverageActive(expenseTotalsCounted(y), upto);
    if(e.months){ out.monthlyExpenses = {usd:e.avg, has:true, note:`Average of ${e.months} month${e.months===1?'':'s'} with expenses`}; }
  }catch(err){ console.warn('[Planner] income/expense auto-fill failed', err); }

  try{
    const held = aggregateAllHoldings(y).filter(h => types.has(h.type));
    /* A holding whose price has never loaded has currentValue 0, which
       would silently understate your stocks. Fall back to what you paid
       (cost basis) for just those, and say so in the note. */
    let fallback = 0;
    const total = held.reduce((s,h)=>{
      if(num(h.currentValue) <= 0 && num(h.invested) > 0){ fallback++; return s + num(h.invested); }
      return s + num(h.currentValue);
    }, 0);
    if(held.length){ out.stocks = {usd: total, has:true, note:`${held.length} open holding${held.length===1?'':'s'} (${[...types].map(t=>PLANNER_TYPE_LABEL[t]||t).join(', ')}) at current prices${fallback?` — ${fallback} without a price yet, counted at cost`:''}`}; }
  }catch(err){ console.warn('[Planner] holdings auto-fill failed', err); }

  try{
    const rec = plannerRecurringSip(y, types), buys = plannerAvgBuys(y, types);
    const mode = P.opts.sipMode;
    let pick = null;
    if(mode==='recurring') pick = rec.count ? rec : null;
    else if(mode==='avgBuys') pick = buys.count ? buys : null;
    else pick = rec.count ? rec : (buys.count ? buys : null);
    if(pick) out.sip = {usd:pick.usd, has:true, note: pick.note};
    out.sipSources = {rec, buys};
  }catch(err){ console.warn('[Planner] SIP auto-fill failed', err); }
  return out;
}
function plannerRecurringSip(y, types){
  let usd = 0, count = 0;
  (yearData(y).investments||[]).forEach(inv=>{
    (inv.holdings||[]).forEach(h=>{
      if(h.status==='closed' || !types.has(h.type||'stock')) return;
      if(!h.recurring || !h.recurring.active) return;
      const norm = _normalizedRecurring(h.recurring);
      const hasSchedule = norm.frequencyType==='daysOfMonth' ? (norm.daysOfMonth && norm.daysOfMonth.length) : !!norm.startDate;
      if(!hasSchedule) return;
      const m = plannerMonthlyEquivalent(norm);
      if(m > 0){ usd += _toUsd(m, inv.currency==='INR' ? 'INR' : 'USD'); count++; }
    });
  });
  return {usd, count, note: `${count} active recurring buy${count===1?'':'s'}, converted to a monthly amount`};
}
function plannerAvgBuys(y, types){
  const now = new Date(); now.setHours(0,0,0,0);
  const start = new Date(now); start.setFullYear(start.getFullYear()-1);
  let usd = 0, count = 0, earliest = null;
  (yearData(y).investments||[]).forEach(inv=>{
    (inv.holdings||[]).forEach(h=>{
      if(!types.has(h.type||'stock')) return;
      (h.lots||[]).forEach(l=>{
        if(l.type==='sell' || !l.date) return;
        const d = new Date(l.date+'T00:00:00');
        if(isNaN(d) || d < start || d > now) return;
        usd += _toUsd(num(l.qty)*num(l.price), inv.currency==='INR' ? 'INR' : 'USD');
        count++;
        if(!earliest || d < earliest) earliest = d;
      });
    });
  });
  const months = earliest ? Math.min(12, Math.max(1, Math.ceil((now-earliest)/(30.4375*86400000)))) : 1;
  return {usd: usd/months, count, note: `Average of ${count} buy${count===1?'':'s'} over the last ${months} month${months===1?'':'s'} (includes any opening-balance lots)`};
}

/* ---------- value resolution: override > auto > default ---------- */
function plannerResolve(key, autos){
  const def = PLANNER_FIELDS[key], P = plannerState(), ov = P.ov[key], cur = plannerCur();
  if(def.kind==='text') return {value: typeof ov==='string' ? ov : def.def, source: typeof ov==='string' ? 'manual':'default'};
  if(def.kind==='money'){
    const a = (autos && autos[key]) ? autos[key] : null;
    const autoDisp = a ? plannerUsdToDisp(a.usd) : null;
    if(ov && typeof ov==='object' && isFinite(ov.v)){
      const value = (ov.c===cur) ? ov.v : plannerUsdToDisp(ov.c==='INR' ? ov.v/plannerFxRate() : ov.v);
      return {value, source:'manual', auto:autoDisp, note: a && a.note};
    }
    if(a) return {value: autoDisp, source:'auto', auto:autoDisp, note:a.note, empty:!a.has};
    return {value: plannerUsdToDisp(def.defUsd||0), source:'default'};
  }
  // int / pct
  if(typeof ov === 'number' && isFinite(ov)) return {value: ov, source:'manual'};
  return {value: def.def, source:'default'};
}
function plannerCollect(){
  const autos = plannerAutoValues();
  const R = {};
  Object.keys(PLANNER_FIELDS).forEach(k => { R[k] = plannerResolve(k, autos); });
  return {R, autos};
}

/* ---------- full analysis ---------- */
function plannerAnalyse(R){
  const v = k => R[k].value;
  const x = {
    age: v('age'), retireAge: v('retireAge'), current: Math.max(0, v('stocks')), sip: Math.max(0, v('sip')),
    stepUp: v('stepUp'), ret: v('ret'), inflation: v('inflation'), target: Math.max(0, v('target'))
  };
  const years = plannerYears(x.age, x.retireAge);
  const proj = plannerProject(x);
  const required = plannerRequiredSip(x);
  const flat = plannerFinal(Object.assign({}, x, {stepUp:0}));
  const reach = plannerReachTarget(x);
  const coast = plannerCoast(x);
  const sens = plannerSensitivity(x);
  const wd = plannerWithdrawal(proj.final, v('swr'), x.inflation, years);
  const fire = plannerFireNumber(v('monthlyExpenses'), x.inflation, years, v('swr'));
  const stPost = plannerPostTax(v('stNet'), v('stTax')), ltPost = plannerPostTax(v('ltNet'), v('ltTax'));
  const realFinal = proj.final / Math.pow(1 + Math.max(-0.99, x.inflation), years);
  const emergencyMonths = v('monthlyExpenses') > 0 ? v('emergency') / v('monthlyExpenses') : null;
  const insights = plannerInsights({
    age:x.age, retireAge:x.retireAge, ret:x.ret, inflation:x.inflation, salary:v('salary'), sip:x.sip,
    requiredSip:required, target:x.target, projected:proj.final, emergencyMonths, monthlyExpenses:v('monthlyExpenses')
  });
  return {x, years, proj, required, flat, reach, coast, sens, wd, fire, stPost, ltPost, realFinal, insights, emergencyMonths};
}

/* ---------- rendering ---------- */
function plannerFieldHtml(key, R, hint){
  const def = PLANNER_FIELDS[key], r = R[key];
  const src = r.source;
  const badge = src==='auto' ? `<span class="pf-badge auto" title="${escapeHtml(r.note||'')}">${r.empty?'auto · no data':'auto'}</span>`
              : src==='manual' ? `<span class="pf-badge edited">edited</span>`
              : `<span class="pf-badge dflt">default</span>`;
  const canReset = src==='manual' && (def.auto || def.kind!=='text');
  const reset = src==='manual' ? `<button class="pf-reset" data-pfreset="${key}" title="${def.auto?'Back to auto-filled value':'Back to default'}">↺</button>` : '';
  const unit = def.kind==='money' ? `<span class="pf-unit">${plannerSym()}</span>` : def.kind==='pct' ? '' : '';
  const suffix = def.kind==='pct' ? '<span class="pf-unit r">%</span>' : def.kind==='int' ? '<span class="pf-unit r">yrs</span>' : '';
  const val = def.kind==='text' ? escapeHtml(r.value) : plannerInputStr(r.value, def.kind==='pct'?'pct':'n');
  const note = (r.note && src==='auto') ? `<div class="pf-note">${escapeHtml(r.note)}</div>`
             : (src==='manual' && r.note && def.auto) ? `<div class="pf-note">Auto value would be ${plannerFmt(r.auto,{full:true})} — ${escapeHtml(r.note)}</div>` : '';
  return `<div class="pf-field">
    <label>${escapeHtml(def.label)}${hint?` <span class="pf-hint">${hint}</span>`:''}</label>
    <div class="pf-inputwrap">${unit}<input class="pf-input ${def.kind==='text'?'txt':''}" data-pf="${key}" type="text" inputmode="${def.kind==='text'?'text':'decimal'}" value="${val}" autocomplete="off">${suffix}${badge}${reset}</div>
    ${note}
  </div>`;
}

function renderPlanner(){
  const y = state.year, P = plannerState();
  const {R, autos} = plannerCollect();
  const A = plannerAnalyse(R);
  const cur = plannerCur();
  const v = k => R[k].value;
  const invItems = yearData(y).income || [];
  const exclSet = plannerIncomeExcludedSet(invItems);
  const sipSrc = autos.sipSources || {rec:{count:0,usd:0}, buys:{count:0,usd:0}};
  const hasYears = A.years > 0;

  const gap = A.proj.final - A.x.target;
  const pctGoal = A.x.target > 0 ? (A.proj.final / A.x.target) * 100 : null;
  const reqTxt = A.required===null ? '—' : plannerFmt(A.required, {full:true}) + '/mo';
  const reqDelta = (A.required!==null && A.required > A.x.sip + 0.5) ? `<div class="kpi-sub" style="color:var(--rust-soft);">+${plannerFmt(A.required - A.x.sip,{full:true})} more than your SIP</div>`
                  : (A.required!==null ? `<div class="kpi-sub" style="color:var(--good);">You're already contributing enough</div>` : '');
  const reachTxt = !A.reach.reached ? 'Not within 80 yrs' : (A.reach.years===0 ? 'Already there' : `Age ${A.reach.age} (${A.reach.years} yrs)`);
  const reachSub = (A.reach.reached && A.reach.years>0 && hasYears)
    ? (A.reach.age <= plannerNum(v('retireAge')) ? `<div class="kpi-sub" style="color:var(--good);">${(plannerNum(v('retireAge'))-A.reach.age)} yr${plannerNum(v('retireAge'))-A.reach.age===1?'':'s'} before your plan</div>`
       : `<div class="kpi-sub" style="color:var(--rust-soft);">${A.reach.age-plannerNum(v('retireAge'))} yr${A.reach.age-plannerNum(v('retireAge'))===1?'':'s'} after your plan</div>`) : '';

  const insightHtml = A.insights.map(i=>{
    const c = i.level==='bad' ? 'var(--danger)' : i.level==='warn' ? 'var(--rust-soft)' : i.level==='good' ? 'var(--good)' : 'var(--teal-soft)';
    const ico = i.level==='bad' ? '⛔' : i.level==='warn' ? '⚠️' : i.level==='good' ? '✅' : 'ℹ️';
    return `<div class="notice" style="border-left:3px solid ${c};">${ico} ${escapeHtml(i.text)}</div>`;
  }).join('');

  const typeChips = HOLDING_TYPES.map(t => `<button class="pf-chip ${P.opts.holdingTypes.includes(t)?'on':''}" data-pftype="${t}">${PLANNER_TYPE_LABEL[t]||t}</button>`).join('');
  const incomeChecks = invItems.length ? invItems.map(it => `<label class="pf-check"><input type="checkbox" data-pfexcl="${escapeHtml(it.id)}" ${exclSet.has(it.id)?'':'checked'}> ${escapeHtml(it.name||'(unnamed)')}</label>`).join('')
    : '<span class="pf-note">No income sources yet — add some on the Income tab.</span>';

  const sensHead = A.sens.steps.map(s=>`<th>${(s*100).toFixed(s*100%1?1:0)}% step-up</th>`).join('');
  const sensRows = A.sens.rets.map((r,i)=>`<tr><td style="font-weight:600;">${(r*100).toFixed(1)}% return${i===1?' <span class="pf-badge auto" style="margin-left:4px;">yours</span>':''}</td>${A.sens.cells[i].map((c,j)=>{
    const hit = A.x.target>0 && c>=A.x.target;
    return `<td style="${i===1 && Math.abs(A.sens.steps[j]-A.x.stepUp)<1e-9 ? 'background:rgba(201,169,97,.10);' : ''} color:${hit?'var(--good)':'var(--text)'};">${plannerFmt(c)}</td>`;
  }).join('')}</tr>`).join('');

  const rowsHtml = A.proj.rows.map((r,i)=>`<tr ${i===A.proj.rows.length-1?'style="font-weight:700;background:rgba(201,169,97,.08);"':''}>
      <td>${r.age}</td><td>${r.year}</td><td>${plannerFmt(r.start,{full:true})}</td><td>${plannerFmt(r.sip,{full:true})}</td>
      <td>${plannerFmt(r.invested,{full:true})}</td><td style="color:${r.growth>=0?'var(--teal-soft)':'var(--rust-soft)'};">${plannerFmt(r.growth,{full:true})}</td>
      <td style="font-weight:600;">${plannerFmt(r.end,{full:true})}</td><td style="color:var(--text-dim);">${plannerFmt(r.real,{full:true})}</td></tr>`).join('');

  const totalInvested = A.proj.rows.length ? A.proj.rows[A.proj.rows.length-1].cumInvested : A.x.current;
  const totalGrowth = A.proj.final - totalInvested;

  const html = `
    <div class="section-title">Financial Plan${v('name') ? ' · '+escapeHtml(v('name')) : ''}</div>
    <p class="section-sub">Will your stocks + SIP reach your goal by the age you want? Salary, stocks and SIP fill in from your Income and Holdings automatically (badge says <b>auto</b>) — type over any field to use your own number, ↺ puts it back.</p>

    <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-bottom:14px;">
      <div class="seg-toggle" style="margin:0;">
        <button class="seg-btn ${cur==='USD'?'active':''}" data-pfcur="USD">$ USD</button>
        <button class="seg-btn ${cur==='INR'?'active':''}" data-pfcur="INR">₹ INR</button>
      </div>
      <span class="pf-note" style="margin:0;">${cur==='INR' ? `Shown in rupees at ₹${plannerFxRate().toFixed(2)} per $` : 'Shown in US dollars'} · typing works like <b>50L</b>, <b>1.2cr</b>, <b>2.5m</b>, <b>40k</b></span>
      <button class="btn small" id="pfResetAll" style="margin-left:auto;">↺ Reset all to auto/defaults</button>
    </div>

    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr));">
      <div class="kpi-card c-gold"><div class="kpi-label">Projected at age ${v('retireAge')}</div><div class="kpi-value">${hasYears?plannerFmt(A.proj.final):'—'}</div><div class="kpi-sub">${hasYears?`${plannerFmt(A.realFinal)} in today's money`:'Set a later retirement age'}</div></div>
      <div class="kpi-card ${gap>=0?'c-teal':'c-danger'}"><div class="kpi-label">${gap>=0?'Surplus vs goal':'Shortfall vs goal'}</div><div class="kpi-value">${hasYears?plannerFmt(Math.abs(gap)):'—'}</div><div class="kpi-sub">${pctGoal===null?'Set a target':`${pctGoal.toFixed(0)}% of ${plannerFmt(A.x.target)} goal`}</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">SIP needed to hit goal</div><div class="kpi-value" style="font-size:20px;">${reqTxt}</div>${reqDelta}</div>
      <div class="kpi-card c-teal"><div class="kpi-label">Age you'd reach the goal</div><div class="kpi-value" style="font-size:20px;">${reachTxt}</div>${reachSub}</div>
    </div>

    ${insightHtml}

    <div class="pf-grid">
      <div class="card">
        <div class="card-head"><h3>Your details</h3></div>
        ${plannerFieldHtml('name', R)}
        ${plannerFieldHtml('age', R)}
        ${plannerFieldHtml('salary', R, 'per month')}
        ${plannerFieldHtml('monthlyExpenses', R, 'per month')}
        ${plannerFieldHtml('emergency', R)}
        ${plannerFieldHtml('stocks', R)}
        ${plannerFieldHtml('sip', R, 'per month')}
        <div class="pf-fieldnote">${A.x.sip>0 && v('salary')>0 ? `SIP is <b>${(A.x.sip/v('salary')*100).toFixed(1)}%</b> of your salary` : ''}${A.emergencyMonths!==null ? `${A.x.sip>0&&v('salary')>0?' · ':''}Emergency fund = <b>${A.emergencyMonths.toFixed(1)}</b> months of expenses` : ''}</div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Goal & assumptions</h3></div>
        ${plannerFieldHtml('target', R)}
        ${plannerFieldHtml('retireAge', R)}
        ${plannerFieldHtml('ret', R, 'per year, used for the projection')}
        ${plannerFieldHtml('stepUp', R, 'SIP grows by this each year')}
        ${plannerFieldHtml('inflation', R)}
        ${plannerFieldHtml('swr', R, 'retirement income rule')}
        <div class="pf-fieldnote">Quick set return → <button class="btn small" data-pfuseret="${A.ltPost}">long-term post-tax (${(A.ltPost*100).toFixed(2)}%)</button> <button class="btn small" data-pfuseret="${A.stPost}">short-term post-tax (${(A.stPost*100).toFixed(2)}%)</button></div>
      </div>
    </div>

    <div class="pf-grid">
      <div class="card">
        <div class="card-head"><h3>Short-term tax calculation</h3></div>
        ${plannerFieldHtml('stNet', R)}
        ${plannerFieldHtml('stTax', R)}
        <div class="pf-result">Post-tax return <b>${(A.stPost*100).toFixed(2)}%</b></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Long-term tax calculation</h3></div>
        ${plannerFieldHtml('ltNet', R)}
        ${plannerFieldHtml('ltTax', R)}
        <div class="pf-result">Post-tax return <b>${(A.ltPost*100).toFixed(2)}%</b></div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Where the auto-filled numbers come from</h3></div>
      <div class="pf-opt"><b>Holdings counted as “stocks”</b> <span class="pf-note" style="display:inline;">(drives the Stocks value and the SIP)</span><div class="pf-chips">${typeChips}</div></div>
      <div class="pf-opt"><b>SIP source</b>
        <select id="pfSipMode" class="pf-select">
          <option value="auto" ${P.opts.sipMode==='auto'?'selected':''}>Auto — recurring buys, else average buys</option>
          <option value="recurring" ${P.opts.sipMode==='recurring'?'selected':''}>Recurring buys only (${sipSrc.rec.count} plan${sipSrc.rec.count===1?'':'s'} · ${plannerFmt(plannerUsdToDisp(sipSrc.rec.usd),{full:true})}/mo)</option>
          <option value="avgBuys" ${P.opts.sipMode==='avgBuys'?'selected':''}>Average monthly buys, last 12 months (${plannerFmt(plannerUsdToDisp(sipSrc.buys.usd),{full:true})}/mo)</option>
        </select>
      </div>
      <div class="pf-opt"><b>Income sources counted in salary</b> <span class="pf-note" style="display:inline;">(untick bonuses, side income, or the auto “Retirement” row to leave them out)</span><div class="pf-checks">${incomeChecks}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Growth projection</h3></div>
      ${hasYears ? '<div class="chart-box tall"><canvas id="chartPlanner"></canvas></div>' : '<div class="section-sub" style="padding:24px 0;text-align:center;">Retirement age must be greater than your current age to project.</div>'}
      ${hasYears ? `<div class="pf-summary"><span>Total put in <b>${plannerFmt(totalInvested)}</b></span><span>Growth <b style="color:var(--teal-soft);">${plannerFmt(totalGrowth)}</b></span><span>Final <b>${plannerFmt(A.proj.final)}</b></span></div>` : ''}
    </div>

    <div class="pf-grid">
      <div class="card">
        <div class="card-head"><h3>Step-up vs. flat SIP</h3></div>
        <div class="pf-stat"><span>With ${(A.x.stepUp*100).toFixed(1)}% yearly step-up</span><b>${plannerFmt(A.proj.final)}</b></div>
        <div class="pf-stat"><span>Same SIP, never increased</span><b>${plannerFmt(A.flat)}</b></div>
        <div class="pf-stat"><span>Extra from stepping up</span><b style="color:var(--good);">+${plannerFmt(A.proj.final - A.flat)}</b></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Coast check (stop investing today)</h3></div>
        <div class="pf-stat"><span>Stocks alone grow to</span><b>${plannerFmt(A.coast.value)}</b></div>
        <div class="pf-stat"><span>Goal</span><b>${plannerFmt(A.x.target)}</b></div>
        <div class="pf-result">${A.x.target<=0 ? 'Set a target to check.' : A.coast.coasting ? '✅ You could <b>coast</b> — your current stocks alone reach the goal.' : `Not yet — you'd still need <b>${plannerFmt(A.x.target - A.coast.value)}</b> from new contributions.`}</div>
      </div>
    </div>

    <div class="pf-grid">
      <div class="card">
        <div class="card-head"><h3>Retirement income (safe withdrawal)</h3></div>
        <div class="pf-stat"><span>Projected corpus supports</span><b>${plannerFmt(A.wd.monthly)}/mo</b></div>
        <div class="pf-stat"><span>…in today's money</span><b>${plannerFmt(A.wd.monthlyReal)}/mo</b></div>
        <div class="pf-stat"><span>Your current expenses</span><b>${v('monthlyExpenses')>0?plannerFmt(v('monthlyExpenses'))+'/mo':'—'}</b></div>
        <div class="pf-result">${v('monthlyExpenses')>0 && hasYears ? (A.wd.monthlyReal >= v('monthlyExpenses') ? '✅ Covers today\'s spending in real terms.' : `Covers <b>${(A.wd.monthlyReal/v('monthlyExpenses')*100).toFixed(0)}%</b> of today's spending in real terms.`) : 'Add expenses to compare.'}</div>
      </div>
      <div class="card">
        <div class="card-head"><h3>FIRE number</h3></div>
        <div class="pf-stat"><span>Corpus to sustain today's expenses at ${(v('swr')*100).toFixed(1)}%</span><b>${A.fire===null?'—':plannerFmt(A.fire)}</b></div>
        <div class="pf-stat"><span>Your goal</span><b>${plannerFmt(A.x.target)}</b></div>
        <div class="pf-result">${A.fire===null||!hasYears ? 'Needs expenses, a valid age gap and a withdrawal rate.' : (A.proj.final >= A.fire ? '✅ Projected corpus meets the FIRE number.' : `Projected corpus is <b>${plannerFmt(A.fire - A.proj.final)}</b> short of it.`)}
          ${A.fire!==null && Math.abs(A.fire - A.x.target) > 1 ? `<button class="btn small" data-pfusetarget="${A.fire}">Use as my goal</button>` : ''}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>What if? Return × step-up</h3></div>
      <div class="table-scroll"><table class="ledger"><thead><tr><th>Projected value at ${v('retireAge')}</th>${sensHead}</tr></thead><tbody>${sensRows}</tbody></table></div>
      <div class="pf-note" style="margin-top:8px;">Green = reaches your goal. Markets never return a flat rate every year — treat this as a range, not a promise.</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Year by year</h3></div>
      ${hasYears ? `<div class="table-scroll"><table class="ledger"><thead><tr><th>Age</th><th>Year</th><th>Start value</th><th>Monthly SIP</th><th>Invested that year</th><th>Growth</th><th>End value</th><th>In today's money</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` : '<div class="section-sub">Nothing to show yet.</div>'}
      <div class="pf-note" style="margin-top:8px;">Same method as your spreadsheet: SIP paid monthly (end of month), return compounds monthly from the yearly rate, SIP steps up each year after the first. This is an estimate, not advice.</div>
    </div>
  `;
  document.getElementById('panel-planner').innerHTML = html;

  /* ---- chart ---- */
  destroyChart('planner');
  if(hasYears){
    const labels = [A.x.age, ...A.proj.rows.map(r=>r.age)];
    const nominal = [A.x.current, ...A.proj.rows.map(r=>r.end)];
    const real = [A.x.current, ...A.proj.rows.map(r=>r.real)];
    const invested = [A.x.current, ...A.proj.rows.map(r=>r.cumInvested)];
    const ds = [
      {label:'Projected value', data:nominal, borderColor:'#C9A961', backgroundColor:'rgba(201,169,97,.12)', fill:true, tension:.25, pointRadius:0},
      {label:"In today's money", data:real, borderColor:'#8FC0AC', tension:.25, pointRadius:0, borderDash:[5,4]},
      {label:'Total invested', data:invested, borderColor:'#A2AEA9', tension:.25, pointRadius:0}
    ];
    if(A.x.target > 0) ds.push({label:'Goal', data: labels.map(()=>A.x.target), borderColor:'#C06A46', pointRadius:0, borderDash:[2,3], borderWidth:1.5});
    charts.planner = safeChart(document.getElementById('chartPlanner'), {
      type:'line', data:{labels, datasets:ds},
      options:{ responsive:true, maintainAspectRatio:false, interaction:{mode:'index', intersect:false},
        plugins:{ legend:{labels:{color:'#A2AEA9', boxWidth:14}}, tooltip:{callbacks:{ title:i=>'Age '+i[0].label, label:c=>` ${c.dataset.label}: ${plannerFmt(c.parsed.y)}` }} },
        scales:{ y:{grid:{color:'#26332F'}, ticks:{color:'#A2AEA9', callback:v=>plannerFmt(v)}}, x:{grid:{display:false}, ticks:{color:'#A2AEA9', maxTicksLimit:14}, title:{display:true, text:'Age', color:'#66746E'}} } }
    });
  }

  attachPlannerHandlers(R);
}

/* ---------- editing ---------- */
function plannerCommitField(key, raw, R){
  const def = PLANNER_FIELDS[key], P = plannerState();
  const before = R[key];
  const text = String(raw).trim();
  const beforeStr = def.kind==='text' ? before.value : plannerInputStr(before.value, def.kind==='pct'?'pct':'n');

  if(text === ''){ // cleared -> back to auto/default (text fields just clear)
    if(def.kind==='text'){ if(P.ov[key] !== undefined){ P.ov[key] = ''; markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:def.label,oldVal:beforeStr,newVal:'(cleared)'}); } }
    else if(P.ov[key] !== undefined){ delete P.ov[key]; markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:def.label,oldVal:beforeStr,newVal:'(auto/default)'}); }
    return true;
  }
  if(def.kind==='text'){
    P.ov[key] = text.slice(0, 60);
  } else if(def.kind==='money'){
    const n = plannerParseAmount(text);
    if(n === null || n < 0){ showToast(`“${text}” isn't a valid amount for ${def.label}`); return false; }
    P.ov[key] = {v:n, c:plannerCur()};
  } else if(def.kind==='int'){
    const n = plannerParseAmount(text);
    if(n === null || n < def.min || n > def.max){ showToast(`${def.label} must be between ${def.min} and ${def.max}`); return false; }
    P.ov[key] = Math.round(n);
  } else { // pct
    const n = plannerParsePercent(text);
    if(n === null || n < def.min || n > def.max){ showToast(`${def.label} must be between ${(def.min*100).toFixed(1).replace(/\.0$/,'')}% and ${(def.max*100).toFixed(0)}%`); return false; }
    P.ov[key] = n;
  }
  markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:def.label,oldVal:beforeStr,newVal:text});
  return true;
}

function attachPlannerHandlers(R){
  const P = plannerState();
  const panel = document.getElementById('panel-planner');

  panel.querySelectorAll('[data-pf]').forEach(inp=>{
    inp.addEventListener('focus', ()=> inp.select());
    inp.addEventListener('keydown', e=>{ if(e.key==='Enter') inp.blur(); });
    inp.addEventListener('change', ()=>{
      plannerCommitField(inp.dataset.pf, inp.value, R);
      renderPlanner(); // always redraw: shows the accepted value, or restores the old one if rejected
    });
  });
  panel.querySelectorAll('[data-pfreset]').forEach(b=> b.addEventListener('click', ()=>{
    const k = b.dataset.pfreset; delete P.ov[k];
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:PLANNER_FIELDS[k].label,oldVal:'(edited)',newVal:'(auto/default)'});
    renderPlanner();
  }));
  panel.querySelectorAll('[data-pfcur]').forEach(b=> b.addEventListener('click', ()=>{
    if(P.currency === b.dataset.pfcur) return;
    P.currency = b.dataset.pfcur;
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'Display currency',oldVal:'',newVal:P.currency});
    renderPlanner();
  }));
  panel.querySelectorAll('[data-pftype]').forEach(b=> b.addEventListener('click', ()=>{
    const t = b.dataset.pftype, list = P.opts.holdingTypes, i = list.indexOf(t);
    if(i > -1){ if(list.length === 1){ showToast('Keep at least one holding type selected'); return; } list.splice(i,1); } else list.push(t);
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'Holding types counted',oldVal:'',newVal:list.join(', ')});
    renderPlanner();
  }));
  const sel = document.getElementById('pfSipMode');
  if(sel) sel.addEventListener('change', ()=>{ P.opts.sipMode = sel.value; markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'SIP source',oldVal:'',newVal:sel.value}); renderPlanner(); });
  panel.querySelectorAll('[data-pfexcl]').forEach(cb=> cb.addEventListener('change', ()=>{
    const items = yearData(state.year).income || [];
    const set = plannerIncomeExcludedSet(items); // materialize current state first
    if(cb.checked) set.delete(cb.dataset.pfexcl); else set.add(cb.dataset.pfexcl);
    P.opts.excludedIncome = [...set];
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'Income sources counted',oldVal:'',newVal:(items.find(i=>i.id===cb.dataset.pfexcl)||{}).name||''});
    renderPlanner();
  }));
  panel.querySelectorAll('[data-pfuseret]').forEach(b=> b.addEventListener('click', ()=>{
    P.ov.ret = Math.round(parseFloat(b.dataset.pfuseret)*10000)/10000;
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'Expected return',oldVal:'',newVal:(P.ov.ret*100).toFixed(2)+'%'});
    renderPlanner();
  }));
  panel.querySelectorAll('[data-pfusetarget]').forEach(b=> b.addEventListener('click', ()=>{
    P.ov.target = {v: Math.round(parseFloat(b.dataset.pfusetarget)), c: plannerCur()};
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'Target value',oldVal:'',newVal:String(P.ov.target.v)});
    renderPlanner();
  }));
  const ra = document.getElementById('pfResetAll');
  if(ra) ra.addEventListener('click', ()=>{
    if(!confirm('Reset every Financial Plan field back to its auto-filled value or default?')) return;
    P.ov = {}; P.opts.excludedIncome = null; P.opts.sipMode = 'auto'; P.opts.holdingTypes = ['stock'];
    markDirty('planner',{tab:'planner',action:'edit',target:'Financial Plan',field:'All fields',oldVal:'',newVal:'reset'});
    renderPlanner();
  });
}
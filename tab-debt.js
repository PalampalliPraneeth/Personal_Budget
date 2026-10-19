/* =========================================================================
   DEBT PAYOFF TAB
   ========================================================================= */
function planRowTotal(plan, row){
  return plan.columns.filter(c=>c.kind==='expense').reduce((a,c)=>a+num(row.values[c.id]),0);
}
function planRowIncome(plan, row){
  return plan.columns.filter(c=>c.kind==='income').reduce((a,c)=>a+num(row.values[c.id]),0);
}
function planRowRemaining(plan, row){
  return planRowIncome(plan,row) - planRowTotal(plan,row);
}

function simulatePayoffWithPlan(debts, plan){
  const items = debts.filter(d=>debtPendingCalc(d)>0).map(d=>{
    const p=debtPendingCalc(d); // USD
    /* BUGFIX (#12b): d.emi is stored in the debt's NATIVE currency (like
       d.total), but `p` (the balance here) is already USD. The old code
       compared d.emi straight against p*1.5 — for an INR debt that meant
       comparing a raw-rupee EMI (often tens of thousands) against a
       dollar-sized cap, so the simulation effectively always used the
       full (huge, rupee-denominated) "USD" EMI as the monthly payment.
       Convert the EMI to USD the same way every other debt figure is. */
    const emiUsd = debtToUsd(d.emi, d);
    return {
      name:d.name, balance:p, rate:(num(d.interest)/100)/12,
      minPay: emiUsd && emiUsd>0 ? Math.min(emiUsd, p*1.5) : Math.max(p*0.03, 25)
    };
  });
  if(items.length===0) return {months:0, perDebt:{}, series:[{month:0,total:0}], payoffDate:new Date(), remainders:[], lastRemaining:0};
  const remainders = plan.rows.map(r=>Math.max(0, planRowRemaining(plan,r)));
  const lastRemaining = remainders.length ? remainders[remainders.length-1] : 0;
  const order = ()=> items.filter(x=>x.balance>0.01).sort((a,b)=> b.rate-a.rate);
  const perDebt = {};
  const series = [{month:0, total: items.reduce((a,b)=>a+b.balance,0)}];
  let month=0;
  const maxMonths = 600;
  while(items.some(x=>x.balance>0.01) && month<maxMonths){
    const extra = month < remainders.length ? remainders[month] : lastRemaining;
    month++;
    items.forEach(x=>{ if(x.balance>0.01) x.balance += x.balance*x.rate; });
    items.forEach(x=>{
      if(x.balance<=0.01) return;
      const pay = Math.min(x.minPay, x.balance);
      x.balance -= pay;
    });
    let pool = extra;
    for(const x of order()){
      if(pool<=0) break;
      if(x.balance<=0.01) continue;
      const pay = Math.min(pool, x.balance);
      x.balance -= pay; pool -= pay;
    }
    items.forEach(x=>{
      if(x.balance<=0.01 && !(x.name in perDebt)) perDebt[x.name]=month;
    });
    series.push({month, total: items.reduce((a,b)=>a+Math.max(b.balance,0),0)});
  }
  const payoffDate = new Date();
  payoffDate.setMonth(payoffDate.getMonth()+month);
  return {months:month, perDebt, series, payoffDate, remainders, lastRemaining};
}

/* ---------- Debt page helpers: display switch, compact rupee text ---------- */
const DEBT_VIEW_KEY = 'ledger:ui:debtView:v1';
function getDebtView(){
  if(!state.debtView){
    let v = null; try{ v = localStorage.getItem(DEBT_VIEW_KEY); }catch(e){}
    state.debtView = (v === 'inr' || v === 'usd') ? v : 'both';
  }
  return state.debtView;
}
function setDebtView(v){
  state.debtView = (v === 'inr' || v === 'usd') ? v : 'both';
  try{ localStorage.setItem(DEBT_VIEW_KEY, state.debtView); }catch(e){}
  try{ if(window.storage) Promise.resolve(window.storage.set(DEBT_VIEW_KEY, JSON.stringify(state.debtView), false)).catch(()=>{}); }catch(e){}
}
/* ₹6.4 L / ₹1.25 Cr style, the way rupee amounts are normally said out loud */
function fmtInrShort(n){
  const v = Math.abs(num(n)), sign = n < 0 ? '-' : '';
  const trim = x => x.toFixed(2).replace(/\.?0+$/, '');
  if(v >= 1e7) return `${sign}₹${trim(v/1e7)} Cr`;
  if(v >= 1e5) return `${sign}₹${trim(v/1e5)} L`;
  return `${sign}₹${Math.round(v).toLocaleString('en-IN')}`;
}

/* Set Original and Pending together, letting "Cleared" (what's already paid) absorb the difference, so changing one of
   Original / Pending never silently changes the other. All values are in the loan's own currency.
   Returns {ok:true}, or {ok:false, msg} if the numbers can't work (the edit is then refused and nothing changes). */
function setOriginalAndPending(d, total, pending){
  const isINR = d.currency === 'INR';
  const fmtD = v => isINR ? fmtInr(v) : fmt$(v, 2);
  if(pending > total + 0.005) return { ok:false, msg:`Pending (${fmtD(pending)}) can't be more than Original (${fmtD(total)}). Raise Original first.` };
  const paidThisYear = sumArr(d.m || []);
  const opening = (total - pending) - paidThisYear;            // the "already cleared" starting amount that makes the maths work
  if(opening < -0.005) return { ok:false, msg:`That would make "cleared" (${fmtD(total - pending)}) smaller than the ${fmtD(paidThisYear)} of payments logged this year. Edit those payments first, or change Pending instead.` };
  d.total = total;
  d.cleared = roundCents(Math.max(opening, 0));
  if(isINR && !(num(d.clearedRate) > 0)) d.clearedRate = liveInrRate();   // keep an existing locked rate; only stamp one if missing
  if(d.carryFromPrior) d.clearedManual = true;                           // otherwise the automatic year-to-year carry would overwrite it
  return { ok:true };
}

function renderDebt(){
  const y = state.year;
  
  /* FIX: ensure paymentPlan exists so mutations persist */
  if(!DATA.paymentPlan) DATA.paymentPlan = {columns:[], rows:[]};
  const plan = DATA.paymentPlan;
  
  const debts = [...yearData(y).debts].sort((a,b)=>{
    const pa = debtPendingCalc(a), pb = debtPendingCalc(b);
    if(pa <= 0 && pb > 0) return 1;
    if(pb <= 0 && pa > 0) return -1;
    return pb - pa;
  });
  // older data: an "already cleared" rupee amount with no rate remembered gets today's rate stamped once, so it stops drifting
  if(lockLegacyClearedRates(debts)){ try{ persistData(true).catch(()=>{}); }catch(e){} }
  const debtView = getDebtView();
  const mismatches = findDebtPaymentCurrencyMismatches();
  const fixNoticeHtml = mismatches.length ? `
    <div class="notice" style="border-color:var(--gold); margin-bottom:14px;">
      ⚠ <b>${mismatches.length} Cash Flow payment${mismatches.length===1?' was':'s were'} saved in the wrong currency</b> — the amount from the bank was copied into the loan without converting it.
      ${mismatches.slice(0,3).map(f => `<div style="font-size:12px; margin-top:4px;">${fmtNative(Math.abs(f.amount), f.bankCur)} paid from ${escapeHtml(f.bank.name)} (${MONTHS[f.monthIdx]} ${f.year}) is counted as <b>${fmtNative(Math.abs(f.stored), f.debtCur)}</b> in ${escapeHtml(f.debt.name)}; it should be <b>${fmtNative(Math.abs(f.expected), f.debtCur)}</b>.</div>`).join('')}
      ${mismatches.length>3 ? `<div style="font-size:12px; margin-top:4px;">…and ${mismatches.length-3} more.</div>` : ''}
      <div style="margin-top:8px;"><button class="btn small primary" id="debtFixCurrency">Fix ${mismatches.length===1?'it':'them'}</button></div>
    </div>` : '';
  const nowD = new Date(), curMonthKey = fxMonthKey(nowD.getFullYear(), nowD.getMonth());
  const fxRowsHtml = MONTHS.map((m,i) => {
    const manual = fxManualRate(y, i), used = fxRateForMonth(y, i), key = fxMonthKey(y, i);
    const rec = (DATA.fxRateHistory || {})[key];
    const src = manual ? '<span style="color:var(--gold-soft);">set by you</span>'
      : (key < curMonthKey && rec && Number(rec.start) > 0 && Number(rec.end) > 0) ? 'recorded average' : (key < curMonthKey ? 'live rate (nothing recorded)' : 'live rate (month not finished)');
    return `<tr><td>${m} ${y}</td>
      <td><input type="text" inputmode="decimal" class="input" data-fxrate="${i}" value="${manual ? String(manual) : ''}" placeholder="${used.toFixed(4).replace(/0+$/,'').replace(/\.$/,'')}" style="width:110px;"></td>
      <td style="color:var(--text-dim); font-size:12px;">${src}</td></tr>`;
  }).join('');
  const fxCardHtml = `
    <details class="card" id="fxRatesCard" ${state.fxCardOpen ? 'open' : ''} style="margin-bottom:20px;">
      <summary style="cursor:pointer; font-weight:600;">₹ per $1 for each month of ${y} <span style="font-weight:400; color:var(--text-dim); font-size:12px;">— set your own monthly rate</span></summary>
      <p class="section-sub" style="margin:10px 0;">Type the rate you want used for a month (for example your bank's monthly average). It applies to <b>that month only</b>, for everything in ₹ — debts, Cash Flow, savings. Leave a box empty to use the recorded or live rate.</p>
      <div class="table-scroll"><table class="ledger" style="min-width:0; width:100%; max-width:520px;"><thead><tr><th>Month</th><th>Rate (₹ per $1)</th><th>Using</th></tr></thead><tbody>${fxRowsHtml}</tbody></table></div>
    </details>`;
  const liveRate = liveInrRate();
  const totalPending = sumArr(debts.map(d=>debtPendingCalc(d)));
  const inrDebts = debts.filter(d => d.currency === 'INR' && debtPendingNative(d) > 0);
  const totalOriginal = sumArr(debts.map(d=>debtOriginalUsd(d)));
  const totalCleared = sumArr(debts.map(d=>debtClearedToDate(d)));
  // rupee view of the totals (USD loans converted at the live rate)
  const inrOf = (d, usdVal, nativeVal) => d.currency === 'INR' ? nativeVal : usdVal * liveRate;
  const totalPendingInr = sumArr(debts.map(d => inrOf(d, debtPendingCalc(d), debtPendingNative(d))));
  const totalClearedInr = sumArr(debts.map(d => inrOf(d, debtClearedToDate(d), debtClearedNative(d))));
  const totalOriginalInr = sumArr(debts.map(d => inrOf(d, debtOriginalUsd(d), num(d.total))));

  if(state.debtShowPaid === undefined) state.debtShowPaid = false;
  const activeDebts = debts.filter(d => !(d.total>0 && debtPendingCalc(d)<=0));
  const paidDebts = debts.filter(d => d.total>0 && debtPendingCalc(d)<=0);

  function debtCardHtml(d){
    const isINR = d.currency === 'INR';
    const clearedUsd = debtClearedToDate(d), pendingUsd = debtPendingCalc(d), origUsd = debtOriginalUsd(d);
    const clearedN = debtClearedNative(d), pendingN = debtPendingNative(d), totalN = num(d.total);
    // progress is measured in the loan's OWN currency (for a rupee loan: rupees paid / rupees owed), so exchange-rate
    // moves can never make a loan look more or less paid off
    const pct = isINR ? (totalN > 0 ? Math.min(100, (clearedN/totalN)*100) : 0) : (origUsd > 0 ? Math.min(100, (clearedUsd/origUsd)*100) : 0);
    const isPaid = d.total>0 && debtPendingCalc(d)<=0;
    const needsTotal = num(d.total)===0;
    const mode = debtRateMode(d);
    const effect = debtRateEffect(d);

    // one amount: rupee loans edit in ₹ and show $ per the view switch; USD loans edit in $ (optionally with ≈ ₹)
    const inrAmount = (field, native, usd, color) => {
      const edit = `<b class="editable-inline" ${color?`style="color:${color}"`:''} contenteditable="true" data-debtfield="${field}" data-id="${d.id}">${fmtInr(native)}</b>`;
      if(debtView === 'inr') return edit;
      if(debtView === 'usd') return `<b ${color?`style="color:${color}"`:''}>${fmt$(usd,2)}</b> <span style="opacity:.7">(${edit})</span>`;
      return `${edit} <span style="opacity:.75">≈ ${fmt$(usd,2)}</span>`;
    };
    const usdExtra = (usd) => debtView === 'inr' ? ` <span style="opacity:.7">≈ ${fmtInr(usd*liveRate)}</span>` : '';

    const foot = isINR ? `
        <span>Cleared: ${inrAmount('clearedNative', clearedN, clearedUsd, 'var(--teal-soft)')} <span style="opacity:.55">(incl. ${fmtInr(sumArr(d.m||[]))} paid this year)</span></span>
        <span>Pending: ${inrAmount('pendingNative', pendingN, pendingUsd, 'var(--rust-soft)')}</span>
        <span>Original: ${inrAmount('total', totalN, origUsd)}</span>`
      : `
        <span>Cleared: <b class="editable-inline" style="color:var(--teal-soft)" contenteditable="true" data-debtfield="clearedDisplay" data-id="${d.id}">${clearedUsd.toFixed(2)}</b> USD${usdExtra(clearedUsd)} <span style="opacity:.55">(incl. ${fmt$(monthlyArrToUsd(d.m, d.currency, y),2)} from monthly payments this year)</span></span>
        <span>Pending: <b class="editable-inline" style="color:var(--rust-soft)" contenteditable="true" data-debtfield="pending" data-id="${d.id}">${fmt$(pendingUsd,2)}</b> USD${usdExtra(pendingUsd)}</span>
        <span>Original: <b class="editable-inline" contenteditable="true" data-debtfield="total" data-id="${d.id}">${d.total}</b> ${d.currency||'USD'}${usdExtra(origUsd)}</span>`;

    const progressText = isINR
      ? `${fmtInrShort(clearedN)} of ${fmtInrShort(totalN)} cleared · <b>${pct.toFixed(0)}%</b>${debtView!=='inr' ? ` <span style="opacity:.6">· ${fmt$(clearedUsd,0)} of ${fmt$(origUsd,0)}</span>` : ''}`
      : `${fmt$(clearedUsd,0)} of ${fmt$(origUsd,0)} cleared · <b>${pct.toFixed(0)}%</b>${debtView==='inr' ? ` <span style="opacity:.6">· ${fmtInrShort(clearedUsd*liveRate)} of ${fmtInrShort(origUsd*liveRate)}</span>` : ''}`;

    const effectHtml = (isINR && effect && debtView !== 'inr') ? `
      <div class="debt-rate-effect" style="margin-top:8px; font-size:12px; color:${effect.effectUsd<0?'var(--good)':'var(--danger)'};">
        ${effect.stronger ? '▲' : '▼'} Exchange rate moved: ₹${effect.ref.toFixed(2)} → ₹${effect.live.toFixed(2)} per $1 since ${effect.refLabel}.
        Same rupees owed, but in dollars it is now worth <b>${fmt$(Math.abs(effect.effectUsd),2)} ${effect.effectUsd<0?'less':'more'}</b>.
      </div>` : '';

    const modeSel = isINR ? `
      <label style="display:inline-flex; gap:6px; align-items:center; font-size:11px; color:var(--text-dim);" title="Only changes how the dollar value of the money you've ALREADY PAID is worked out. What you still owe always uses today's rate.">Dollar value of what I've paid:
        <select class="input" data-ratemode="${d.id}" style="font-size:11px; padding:3px 22px 3px 8px;">
          <option value="locked" ${mode==='locked'?'selected':''}>fixed at each month's rate (recommended)</option>
          <option value="live" ${mode==='live'?'selected':''}>changes with today's rate</option>
        </select></label>` : '';

    return `
    <div class="debt-card" data-debt-id="${d.id}">
      <div class="debt-card-head">
        <div><span class="debt-name">${escapeHtml(d.name)}</span>
          ${isPaid?'<span class="debt-tag" style="color:var(--good); border-color:var(--good);">paid off</span>':''}
          ${needsTotal?'<span class="debt-tag" style="color:var(--gold); border-color:var(--gold);">set total below</span>':''}
        </div>
        <div class="debt-figs">
          <span>Interest <b class="editable-inline" contenteditable="true" data-debtfield="interest" data-id="${d.id}">${d.interest}</b>%/yr</span>
          <span>EMI/min <b class="editable-inline" contenteditable="true" data-debtfield="emi" data-id="${d.id}">${d.emi||0}</b></span>
          <select data-debtcurrency="${d.id}" style="background:var(--bg-card-hi); color:var(--teal-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11px; padding:2px 4px;">
            <option value="USD" ${!isINR?'selected':''}>USD</option>
            <option value="INR" ${isINR?'selected':''}>INR</option>
          </select>
        </div>
      </div>
      <div class="runway ${isPaid?'zero':''}"><div class="runway-fill" style="width:${pct}%"></div></div>
      <div style="font-size:12px; color:var(--text-dim); margin:6px 0 8px;">${progressText}</div>
      <div class="debt-foot">${foot}
      </div>
      ${effectHtml}
      ${modeSel ? `<div style="margin-top:8px;">${modeSel}</div>` : ''}
      ${d.note?`<div class="section-sub" style="margin-top:8px;">⚑ ${escapeHtml(d.note)}</div>`:''}
    </div>`;
  }

  const activeCardsHtml = activeDebts.map(debtCardHtml).join('');
  const paidCardsHtml = paidDebts.map(debtCardHtml).join('');
  const showPaidToggleHtml = !paidDebts.length ? '' : `
    <div style="text-align:center; margin:14px 0 ${state.debtShowPaid?'0':'6px'} 0;">
      <button class="btn small" id="debtShowPaidToggle">${state.debtShowPaid ? '▲ Hide paid off' : `▼ Show ${paidDebts.length} paid off`}</button>
    </div>
    ${state.debtShowPaid ? `<div style="margin-top:14px; display:flex; flex-direction:column; gap:14px;">${paidCardsHtml}</div>` : ''}
  `;

  const sim = simulatePayoffWithPlan(debts, plan);
  
  let freedomText;
  if(debts.length===0) freedomText = 'No debts entered yet.';
  else if(totalPending<=0) freedomText = 'You are debt-free right now.';
  else if(plan.rows.length===0) freedomText = `${sim.months} month${sim.months===1?'':'s'} with minimum payments only — <span style="color:var(--gold-soft)">add a payment plan above to see how fast you can pay it off</span>`;
  else freedomText = `${sim.months} month${sim.months===1?'':'s'} from today — around <span style="color:var(--gold-soft)">${sim.payoffDate.toLocaleDateString('en-US',{month:'long', year:'numeric'})}</span>`;

  /* ---- Payment plan table ---- */
  const hasPlan = plan.columns.length > 0 && plan.rows.length > 0;
  const colHeaders = plan.columns.map(c=>
    `<th>${escapeHtml(c.name)}${c.kind==='memo'?' <span style="opacity:.6;">(memo)</span>':c.kind==='income'?' <span style="opacity:.6;">(income)</span>':''} <span class="row-del" data-delcol="${c.id}" title="remove column">✕</span></th>`
  ).join('');

  const planRowsHtml = hasPlan ? plan.rows.map(r=>{
    const total = planRowTotal(plan,r);
    const remaining = planRowRemaining(plan,r);
    const cells = plan.columns.map(c=>{
      const val = r.values[c.id];
      const display = (val===null||val===undefined) ? '' : val;
      return `<td class="editable ${!display?'zero':''}" contenteditable="true" data-plancell="${r.id}" data-col="${c.id}">${display===''?'–':display}</td>`;
    }).join('');
    return `<tr data-planrow="${r.id}">
      <td>${r.label} <span class="row-del" data-delplanrow="${r.id}">✕</span></td>
      ${cells}
      <td style="font-weight:600;">${fmt$(total,2)}</td>
      <td style="font-weight:700; color:${remaining>=0?'var(--teal-soft)':'var(--rust-soft)'}">${fmt$(remaining,2)}</td>
    </tr>`;
  }).join('') : '';

  const planTable = hasPlan ? `
    <div class="table-scroll">
      <table class="ledger">
        <thead><tr><th>Month</th>${colHeaders}<th>Total</th><th>Remaining</th></tr></thead>
        <tbody id="planBody">${planRowsHtml}</tbody>
      </table>
    </div>
    <div class="addcat-row">
      <input type="text" id="newPlanRow" placeholder="New month, e.g. May 2027…">
      <button class="btn small" id="addPlanRowBtn">+ Add month</button>
    </div>
    <div class="addcat-row">
      <input type="text" id="newPlanCol" placeholder="New column, e.g. Investment…">
      <select id="newPlanColKind" style="background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:7px 10px; font-family:var(--font-body); font-size:12.5px;">
        <option value="expense">Counts against remaining</option>
        <option value="income">Adds to remaining (income)</option>
        <option value="memo">Memo only — not counted</option>
      </select>
      <button class="btn small" id="addPlanColBtn">+ Add column</button>
    </div>
  ` : `
    <div class="notice" style="text-align:center; padding:24px;">
      <b style="color:var(--gold-soft);">No payment plan yet.</b><br>
      Add your expected salary and expenses month-by-month below. Whatever's "Remaining" each month goes toward your highest-interest debt first.
    </div>
    <div class="addcat-row" style="justify-content:center;">
      <input type="text" id="newPlanCol" placeholder="e.g. Salary" style="min-width:120px;">
      <select id="newPlanColKind" style="background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:7px; padding:7px 10px; font-family:var(--font-body); font-size:12.5px;">
        <option value="income">Income</option>
        <option value="expense">Expense</option>
        <option value="memo">Memo</option>
      </select>
      <button class="btn primary small" id="addPlanColBtn">+ Add first column</button>
    </div>
  `;

  const html = `
    <div class="section-title">Debt Payoff Planner · ${y}</div>
    <p class="section-sub">What's left, what it costs monthly, and when it disappears based on a real month-by-month plan.</p>
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:14px;">
      <span style="font-size:11.5px; color:var(--text-dim);">Show amounts as</span>
      <button class="pill ${debtView==='both'?'active':''}" data-debtview="both">₹ + $</button>
      <button class="pill ${debtView==='inr'?'active':''}" data-debtview="inr">₹ only</button>
      <button class="pill ${debtView==='usd'?'active':''}" data-debtview="usd">$ only</button>
    </div>
    ${inrDebts.length || debts.some(d=>d.currency==='INR') ? `<div class="notice" style="margin-bottom:14px;">₹ loans are entered in rupees. <b>Still owed</b> is shown in dollars at today's live rate — <b>₹${liveRate.toFixed(2)} = $1</b>${(typeof fxLastFetch!=='undefined' && fxLastFetch) ? ` <span style="opacity:.6">(checked ${new Date(fxLastFetch).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})})</span>` : ''} — so it moves with the rate. <b>What you've already paid</b> stays at the rate from when you paid it (you can change that per loan).</div>` : ''}

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);">
      ${debtView==='inr' ? `
      <div class="kpi-card c-danger"><div class="kpi-label">Total Pending</div><div class="kpi-value">${fmtInrShort(totalPendingInr)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">Already Cleared</div><div class="kpi-value">${fmtInrShort(totalClearedInr)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Original Debt Total</div><div class="kpi-value">${fmtInrShort(totalOriginalInr)}</div></div>` : `
      <div class="kpi-card c-danger"><div class="kpi-label">Total Pending</div><div class="kpi-value">${fmt$(totalPending)}</div>${(debtView==='both' && inrDebts.length) ? `<div class="kpi-delta flat">incl. ${fmtInrShort(sumArr(inrDebts.map(d=>debtPendingNative(d))))} in ₹ loans</div>` : ''}</div>
      <div class="kpi-card c-teal"><div class="kpi-label">Already Cleared</div><div class="kpi-value">${fmt$(totalCleared)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Original Debt Total</div><div class="kpi-value">${fmt$(totalOriginal)}</div></div>`}
    </div>

    ${fixNoticeHtml}
    <div class="card">
      <div class="card-head"><h3>Loans</h3></div>
      ${activeCardsHtml || (paidDebts.length ? '' : '<div class="section-sub" style="padding:20px 0; text-align:center;">No debts yet. Add one below.</div>')}
      ${showPaidToggleHtml}
      <div class="addcat-row">
        <input type="text" id="newDebtName" placeholder="New loan / debt name…">
        <input type="number" id="newDebtTotal" placeholder="Total owed" style="width:110px;">
        <input type="number" id="newDebtInterest" placeholder="Interest %" step="0.1" style="width:90px;">
        <button class="btn primary small" id="addDebtBtn">+ Add debt</button>
      </div>
    </div>

    ${fxCardHtml}

    <div class="card">
      <div class="card-head"><h3>Payment plan</h3><span class="section-sub" style="margin:0;">Lay out expected salary and expenses month by month. Whatever's "Remaining" each month goes toward your highest-interest debt first — after the last planned month, that same "Remaining" amount keeps repeating.</span></div>
      ${planTable}

      <div class="freedom-banner" style="margin-top:18px;">
        <div><div class="small">DEBT-FREE PROJECTION</div><div class="big">${freedomText}</div></div>
        <div class="small">based on ${fmt$(totalPending)} pending today, minimum payments, plus each month's "Remaining" above</div>
      </div>
      <div class="chart-box"><canvas id="chartPayoff"></canvas></div>
    </div>
  `;
  document.getElementById('panel-debt').innerHTML = html;

  /* ---- Debt inline edits ---- */
  document.querySelectorAll('.editable-inline').forEach(el=>{
    el.addEventListener('focus', ()=>{ el.dataset.origRaw = el.textContent; });
    el.addEventListener('blur', ()=>{
      if(el.textContent === el.dataset.origRaw) return;
      const id = el.dataset.id, field = el.dataset.debtfield;
      const d = debts.find(x=>x.id===id);
      const isINR = d.currency === 'INR';
      const evaluated = evalExpr(el.textContent.replace(/[$₹,]/g,''));
      const safeV = evaluated===null ? 0 : evaluated;
      // "Cleared" and "Pending" are shown/edited in USD; convert back to the
      // debt's native currency before storing (d.cleared / d.total are always
      // native currency).
      const usdToNative = (usd)=> isINR ? usd * ((typeof fxRates!=='undefined' && fxRates && fxRates.INR) ? fxRates.INR : FX_FALLBACK_INR) : usd;
      if(field==='clearedDisplay'){
        const beforeDisplay = debtClearedToDate(d);
        if(beforeDisplay===safeV) return;
        const clearedNativeTotal = usdToNative(safeV);
        d.cleared = clearedNativeTotal - sumArr(d.m);
        if(d.carryFromPrior) d.clearedManual = true;   // your number wins over the automatic carry
      } else if(field==='clearedNative'){
        // INR debts: you typed rupees, store rupees as-is (no conversion at all)
        const beforeNative = debtClearedNative(d);
        if(Math.abs(beforeNative - safeV) < 0.005) return;
        d.cleared = safeV - sumArr(d.m||[]);
        d.clearedRate = liveInrRate();                 // the amount you just typed is locked at today's rate
        if(d.carryFromPrior) d.clearedManual = true;
      } else if(field==='pendingNative' || field==='pending'){
        /* Editing PENDING never touches ORIGINAL: Original stays put and "Cleared" adjusts (Original = Cleared + Pending). */
        const newPending = field==='pending' ? usdToNative(safeV) : safeV;
        if(Math.abs(debtPendingNative(d) - newPending) < 0.005) return;
        const res = setOriginalAndPending(d, num(d.total), newPending);
        if(!res.ok){ showToast(res.msg); renderDebt(); return; }
      } else if(field==='total'){
        /* Editing ORIGINAL never touches PENDING: Pending stays put and "Cleared" adjusts. A brand-new loan whose total
           hasn't been set yet (0) just gets its total, so pending starts as total minus whatever is cleared. */
        if(num(d.total) === safeV) return;
        if(num(d.total) <= 0){ d.total = safeV; }
        else {
          const res = setOriginalAndPending(d, safeV, debtPendingNative(d));
          if(!res.ok){ showToast(res.msg); renderDebt(); return; }
        }
      } else {
        if(d[field]===safeV) return;
        d[field] = safeV;
      }
      markDirty('debt', {tab:'debt', action:'edit', target:d.name, field:field, oldVal:el.dataset.origRaw, newVal:safeV});
      renderDebt();
    });
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){e.preventDefault(); el.blur();}});
  });

  /* ---- Debt currency select ---- */
  document.querySelectorAll('[data-debtcurrency]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const d = debts.find(x=>x.id===sel.dataset.debtcurrency);
      if(!d || d.currency===sel.value) return;
      const hasAmounts = num(d.total) > 0 || num(d.cleared) > 0 || (d.m||[]).some(v => num(v) !== 0);
      if(hasAmounts && !confirm(`Change ${d.name} from ${d.currency||'USD'} to ${sel.value}?\n\nThis only changes the label. Your existing amounts (total, cleared, payments) are NOT converted — the same numbers will simply be read as ${sel.value}.\n\nOK = change the label    Cancel = keep ${d.currency||'USD'}`)){ renderDebt(); return; }
      d.currency = sel.value;
      markDirty('debt', {tab:'debt', action:'edit', target:d.name, field:'currency', oldVal:d.currency, newVal:sel.value});
      renderDebt();
    });
  });


  /* ---- Display switch (₹ + $ / ₹ only / $ only) ---- */
  document.querySelectorAll('[data-debtview]').forEach(b => b.addEventListener('click', ()=>{ setDebtView(b.dataset.debtview); renderDebt(); }));

  /* ---- Per-loan: count cleared amounts at the rate when paid (locked) or today's live rate ---- */
  document.querySelectorAll('[data-ratemode]').forEach(sel => sel.addEventListener('change', ()=>{
    const d = debts.find(x => x.id === sel.dataset.ratemode); if(!d) return;
    d.rateMode = sel.value === 'live' ? 'live' : 'locked';
    markDirty('debt', {tab:'debt', action:'edit', target:d.name, field:'rateMode', oldVal:'', newVal:d.rateMode});
    renderDebt();
  }));

  /* ---- Repair Cash Flow payments saved in the wrong currency ---- */
  const fixBtn = document.getElementById('debtFixCurrency');
  if(fixBtn) fixBtn.addEventListener('click', ()=>{
    const n = fixDebtPaymentCurrencyMismatches(mismatches);
    markDirty('debt', {tab:'debt', action:'edit', target:'Debt payments', field:'currency repair', oldVal:'', newVal:n + ' fixed'});
    try{ markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Debt payments', field:'currency repair', oldVal:'', newVal:n + ' fixed'}); }catch(e){}
    showToast(`Fixed ${n} payment${n===1?'':'s'} — press Save to keep it`);
    renderDebt();
  });

  /* ---- Your own monthly rate ---- */
  const fxCard = document.getElementById('fxRatesCard');
  if(fxCard) fxCard.addEventListener('toggle', ()=>{ state.fxCardOpen = fxCard.open; });
  document.querySelectorAll('[data-fxrate]').forEach(inp => {
    const commit = ()=>{
      const i = parseInt(inp.dataset.fxrate, 10);
      const raw = inp.value.trim().replace(/[₹,\s]/g,'');
      const before = fxManualRate(y, i);
      if(raw === ''){ if(before === null) return; setManualFxRate(y, i, 0); }
      else {
        const v = evalExpr(raw);
        if(v === null || !(v >= 20 && v <= 300)){ showToast('Enter a rate between 20 and 300 (₹ per $1), like 92.8745'); renderDebt(); return; }
        if(before !== null && Math.abs(before - v) < 1e-9) return;
        setManualFxRate(y, i, v);
      }
      markDirty('debt', {tab:'debt', action:'edit', target:'Exchange rate', field:MONTHS[i] + ' ' + y, oldVal:before === null ? 'auto' : before, newVal:fxManualRate(y, i) === null ? 'auto' : fxManualRate(y, i)});
      renderDebt();
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); commit(); } });
  });

  /* ---- Show/hide paid-off debts ---- */
  const showPaidBtn = document.getElementById('debtShowPaidToggle');
  if(showPaidBtn) showPaidBtn.addEventListener('click', ()=>{
    state.debtShowPaid = !state.debtShowPaid; renderDebt();
  });

  /* ---- Add debt ---- */
  document.getElementById('addDebtBtn').addEventListener('click', ()=>{
    const nameInp = document.getElementById('newDebtName');
    const totalInp = document.getElementById('newDebtTotal');
    const intInp = document.getElementById('newDebtInterest');
    const name = nameInp.value.trim();
    if(!name){ nameInp.focus(); return; }
    
    /* FIX: push to the REAL data array, not the local sorted copy */
    yearData(y).debts.push({
      id:uid(), name,
      total: parseFloat(totalInp.value)||0,
      cleared:0,
      interest: parseFloat(intInp.value)||0,
      emi:0,
      currency:'USD',
      m:n12()
    });
    
    markDirty('debt', {tab:'debt', action:'add', target:name});
    renderDebt();
  });

  /* ---- Plan cell edits ---- */
  if(hasPlan){
    document.querySelectorAll('[data-plancell]').forEach(td=>{
      td.addEventListener('focus', ()=>{
        td.dataset.origRaw = td.textContent;
        if(td.textContent==='–') td.textContent='';
      });
      td.addEventListener('blur', ()=>{
        if(td.textContent === td.dataset.origRaw) return;
        const rowId = td.dataset.plancell, colId = td.dataset.col;
        const row = plan.rows.find(r=>r.id===rowId);
        const raw = td.textContent.trim().replace(/[$,]/g,'');
        let v = raw===''? null : evalExpr(raw);
        const before = row.values[colId]===undefined ? null : row.values[colId];
        if(before===v) return;
        row.values[colId] = v===null ? null : roundCents(v);
        td.textContent = v===null ? '–' : roundCents(v);
        td.classList.toggle('zero', !v);
        markDirty('debt', {tab:'debt', action:'edit', target:'plan '+row.label, field:plan.columns.find(c=>c.id===colId)?.name, oldVal:before, newVal:v});
        renderDebt();
      });
      td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
    });

    document.querySelectorAll('[data-delplanrow]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const idx = plan.rows.findIndex(r=>r.id===el.dataset.delplanrow);
        if(idx>-1 && confirm('Remove this month from the plan?')){ plan.rows.splice(idx,1); markDirty('debt', {tab:'debt', action:'delete', target:'plan month'}); renderDebt(); }
      });
    });

    document.querySelectorAll('[data-delcol]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const idx = plan.columns.findIndex(c=>c.id===el.dataset.delcol);
        if(idx>-1 && confirm('Remove the "'+plan.columns[idx].name+'" column?')){
          /* BUGFIX (#12a): the old code read plan.columns[idx].name for the
             markDirty log AFTER splicing that very column out of the array.
             For the LAST column, idx now equals the array's new (shorter)
             length, so plan.columns[idx] is undefined and .name crashed.
             Capture the name before splicing. */
          const removedName = plan.columns[idx].name;
          const removedId = plan.columns[idx].id;
          plan.columns.splice(idx,1);
          plan.rows.forEach(r=>{ delete r.values[removedId]; });
          markDirty('debt', {tab:'debt', action:'delete', target:'column '+removedName});
          renderDebt();
        }
      });
    });

    document.getElementById('addPlanRowBtn').addEventListener('click', ()=>{
      const inp = document.getElementById('newPlanRow');
      const label = inp.value.trim();
      if(!label){ inp.focus(); return; }
      plan.rows.push({id:uid(), label, values:{}});
      markDirty('debt', {tab:'debt', action:'add', target:'plan month '+label});
      renderDebt();
    });
  }

  document.getElementById('addPlanColBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newPlanCol');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    const kind = document.getElementById('newPlanColKind').value;
    plan.columns.push({id:uid(), name, kind});
    markDirty('debt', {tab:'debt', action:'add', target:'column '+name});
    renderDebt();
  });

  /* ---- Chart ---- */
  destroyChart('payoff');
  if(sim.series.length > 1){
    charts.payoff = safeChart(document.getElementById('chartPayoff'), {
      type:'line',
      data:{ labels: sim.series.map(s=>'M'+s.month), datasets:[
        {label:'Remaining balance', data: sim.series.map(s=>s.total), borderColor:'#C06A46', backgroundColor:'rgba(192,106,70,0.12)', fill:true, tension:.25, pointRadius:0}
      ]},
      options:{ responsive:true, maintainAspectRatio:false,
        plugins:{legend:{display:false}},
        scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}, ticks:{maxTicksLimit:12}} } }
    });
  } else {
    const box = document.getElementById('chartPayoff');
    if(box && box.parentElement) box.parentElement.innerHTML = '<div class="section-sub" style="padding:30px 0; text-align:center;">Add debts with a total above $0 to see the payoff projection chart.</div>';
  }
}
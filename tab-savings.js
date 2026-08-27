/* =========================================================================
   SAVINGS TAB — savings accounts with a monthly balance + an interest rate.
   Same add/edit/delete pattern as the Bank Accounts table on Cash Flow.
   ========================================================================= */
function ensureSavingsMigration(){
  const y = state.year;
  if(!yearData(y).savingsAccounts) yearData(y).savingsAccounts = [];
  yearData(y).savingsAccounts.forEach(s=>{
    if(!s.m) s.m = n12();
    if(s.interestRate===undefined || s.interestRate===null) s.interestRate = 0;
    if(!s.currency) s.currency = 'USD';
  });
}

function monthlyInterestEstimate(balance, annualRatePct){
  return num(balance) * (num(annualRatePct)/100) / 12;
}

function savingsBalanceForInterest(acc, monthIdx){
  const months = acc.m || [];
  let balance = 0;
  for(let i=0; i<=monthIdx; i++){
    const v = num(months[i]);
    if(v > 0) balance = v;
  }
  return balance;
}

function renderSavingsAccountsSection(y, accounts, activeMonthIdx, scopeLabel){
  const balAt = (acc, i)=> num((acc.m||[])[i]);
  const totalSavedLatest = accounts.reduce((a,acc)=>a+balAt(acc, activeMonthIdx>=0?activeMonthIdx:0),0);
  const totalAnnualInterest = accounts.reduce((a,acc)=>a + savingsBalanceForInterest(acc, activeMonthIdx>=0?activeMonthIdx:0) * (num(acc.interestRate)/100), 0);
  const avgRate = accounts.length ? (accounts.reduce((a,acc)=>a+num(acc.interestRate),0)/accounts.length) : 0;

  const rows = accounts.map(acc=>{
    const cells = MONTHS.map((_,i)=>{
      const v = (acc.m||[])[i];
      const val = v===null||v===undefined ? '' : v;
      const tip = monthCellFxTip(v, acc.currency, y, i);
      return `<td class="editable ${!val?'zero':''} ${tip?'has-tip':''}" contenteditable="true" data-sfield="m" data-sid="${acc.id}" data-idx="${i}" ${tip?`data-tip="${tip.replace(/"/g,'&quot;')}"`:''}>${val===''?'–':roundCents(val)}</td>`;
    }).join('');
    const total = sumArr(acc.m||[]);
    const effectiveBal = savingsBalanceForInterest(acc, activeMonthIdx>=0?activeMonthIdx:0);
    const estInterest = monthlyInterestEstimate(effectiveBal, acc.interestRate) * 12;
    return `<tr data-savings-id="${acc.id}">
      <td style="font-weight:600;">${acc.name} <span class="row-del" data-delsavings="${acc.id}">✕</span></td>
      ${cells}
      <td style="font-weight:700;">${fmt$(total,2)}</td>
      <td class="editable" contenteditable="true" data-sfield="rate" data-sid="${acc.id}" style="text-align:center;">${num(acc.interestRate).toFixed(2)}%</td>
      <td style="color:var(--text-dim); font-size:11px;">${acc.currency||'USD'}</td>
      <td style="color:var(--good); font-size:11.5px;">${fmt$(estInterest,2)}/yr</td>
    </tr>`;
  }).join('');

  return `
    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Total saved (${scopeLabel})</div><div class="kpi-value">${fmt$(totalSavedLatest)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">Accounts</div><div class="kpi-value">${accounts.length}</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">Average interest rate</div><div class="kpi-value">${avgRate.toFixed(2)}%</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Projected annual interest</div><div class="kpi-value">${fmt$(totalAnnualInterest)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Savings accounts — month by month</h3><span class="section-sub" style="margin:0;">Enter your end-of-month balance for each account, plus its current interest rate (APY %).</span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Account</th>${monthHeaderCells()}<th>Year</th><th>Interest %</th><th>Currency</th><th>Est. interest</th></tr></thead>
          <tbody id="savingsBody">${rows}
            <tr class="total-row"><td>Total across accounts</td>${MONTHS.map((_,i)=>{
              const t = accounts.reduce((a,acc)=>a+num((acc.m||[])[i]),0);
              return `<td>${t>0?fmt$(t):'—'}</td>`;
            }).join('')}<td>${fmt$(accounts.reduce((a,acc)=>a+sumArr(acc.m||[]),0))}</td><td></td><td></td><td>${fmt$(totalAnnualInterest)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="addcat-row" style="margin-top:14px;">
        <input type="text" id="newSavingsName" placeholder="New savings account, e.g. HDFC Savings, Ally, Marcus…" style="min-width:200px;">
        <input type="number" id="newSavingsRate" placeholder="Interest % (APY)" step="0.01" min="0" style="width:130px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
        <select id="newSavingsCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addSavingsBtn">+ Add account</button>
      </div>
    </div>
  `;
}

function attachSavingsAccountsHandlers(y, accounts){
  /* ---- Balance cell handlers ---- */
  document.querySelectorAll('#savingsBody [data-sfield="m"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const acc = accounts.find(x=>x.id===td.dataset.sid);
      if(!acc) return;
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : evalExpr(raw);
      if(!acc.m) acc.m = n12();
      const before = acc.m[idx];
      if(before===v) return;
      acc.m[idx] = v;
      markDirty('savings', {tab:'savings', action:'edit', target:'Savings '+acc.name, field:MONTHS[idx], oldVal:before===null?'empty':before, newVal:v===null?'empty':v});
      renderSavings();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  /* ---- Interest rate cell handler ---- */
  document.querySelectorAll('#savingsBody [data-sfield="rate"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const acc = accounts.find(x=>x.id===td.dataset.sid);
      if(!acc) return;
      const raw = td.textContent.trim().replace(/[%\s]/g,'');
      let v = evalExpr(raw);
      if(v===null || isNaN(v) || v<0) v = 0;
      const before = acc.interestRate;
      acc.interestRate = v;
      markDirty('savings', {tab:'savings', action:'edit', target:'Savings '+acc.name+' rate', oldVal:before+'%', newVal:v+'%'});
      renderSavings();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  /* ---- Delete account ---- */
  document.querySelectorAll('[data-delsavings]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = accounts.findIndex(x=>x.id===el.dataset.delsavings);
      if(idx>-1 && confirm('Remove "'+accounts[idx].name+'"?')){
        const name = accounts[idx].name;
        accounts.splice(idx,1);
        markDirty('savings', {tab:'savings', action:'delete', target:'Savings '+name});
        renderSavings();
      }
    });
  });

  /* ---- Add account ---- */
  const addBtn = document.getElementById('addSavingsBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    const inp = document.getElementById('newSavingsName');
    const name = inp.value.trim();
    const rateInp = document.getElementById('newSavingsRate');
    const rate = evalExpr(rateInp.value) || 0;
    const currency = document.getElementById('newSavingsCurrency').value;
    if(!name){ inp.focus(); return; }
    accounts.push({id:uid(), name, m:n12(), interestRate:rate, currency});
    markDirty('savings', {tab:'savings', action:'add', target:'Savings '+name});
    renderSavings();
  });
}

function renderSavings(){
  const y = state.year;
  ensureSavingsMigration();
  ensureGoalsMigration();
  ensureRetirementMigration();
  if(state.savingsSubTab === undefined) state.savingsSubTab = 'accounts';
  const accounts = yearData(y).savingsAccounts;
  const goals = yearData(y).savingsGoals;
  const retAccounts = yearData(y).retirementAccounts;

  const latestDataMonth = currentSnapshotMonth(y);
  const selectedMonthIndex = state.month === 'ALL' ? latestDataMonth : Number(state.month);
  const activeMonthIdx = Number.isInteger(selectedMonthIndex) ? selectedMonthIndex : latestDataMonth;

  const scopeLabel = state.month === 'ALL' ? 'Full Year' : MONTHS[activeMonthIdx];

  const sub = state.savingsSubTab;
  const sectionHtml = sub==='retirement' ? renderRetirementSection(y, retAccounts)
    : sub==='goals' ? renderGoalsSection(y, goals, accounts, activeMonthIdx)
    : renderSavingsAccountsSection(y, accounts, activeMonthIdx, scopeLabel);

  const html = `
    <div class="section-title">Savings · ${y}</div>
    <p class="section-sub">Track your savings accounts, savings goals, and retirement accounts — each in its own tab below. Every balance cell is editable — type over it to correct a month.</p>

    <div class="seg-toggle">
      <button class="seg-btn ${sub==='accounts'?'active':''}" data-savingssub="accounts">🏦 Savings accounts <span class="seg-count">${accounts.length}</span></button>
      <button class="seg-btn ${sub==='goals'?'active':''}" data-savingssub="goals">🎯 Savings goals <span class="seg-count">${goals.length}</span></button>
      <button class="seg-btn ${sub==='retirement'?'active':''}" data-savingssub="retirement">🧓 Retirement <span class="seg-count">${retAccounts.length}</span></button>
    </div>

    ${sectionHtml}
  `;
  document.getElementById('panel-savings').innerHTML = html;

  document.querySelectorAll('[data-savingssub]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.savingsSubTab = btn.dataset.savingssub;
      renderSavings();
    });
  });

  if(sub==='accounts') attachSavingsAccountsHandlers(y, accounts);
  if(sub==='goals') attachGoalsHandlers(y, goals, accounts);
  if(sub==='retirement') attachRetirementHandlers(y, retAccounts);
}

/* =========================================================================
   SAVINGS GOALS — hybrid: link to an existing account (auto-tracked) or
   track contributions manually on the goal's own monthly grid.
   ========================================================================= */
function renderGoalsSection(y, goals, accounts, activeMonthIdx){
  const totalTargetUsd = sumArr(goals.map(g=>goalTargetUsd(g, accounts)));
  const totalContributedUsd = sumArr(goals.map(g=>goalContributedUsd(g, accounts, activeMonthIdx)));
  const overallPct = totalTargetUsd>0 ? Math.min(100, (totalContributedUsd/totalTargetUsd)*100) : 0;

  const accountOptions = accounts.map(a=>`<option value="${a.id}">${a.name} (${a.currency||'USD'})</option>`).join('');

  const cards = goals.map(g=>{
    const acc = goalLinkedAccount(g, accounts);
    const cur = goalEffectiveCurrency(g, accounts);
    const target = goalTargetUsd(g, accounts);
    const contributed = goalContributedUsd(g, accounts, activeMonthIdx);
    const pending = Math.max(target - contributed, 0);
    const pct = target>0 ? Math.min(100, (contributed/target)*100) : 0;
    const reached = target>0 && contributed >= target;
    const nativeContributed = acc ? num((acc.m||[])[activeMonthIdx>=0?activeMonthIdx:0]) : sumArr(g.m||[]);
    const nativeTarget = num(g.targetAmount);

    // A light "at this pace, done by ~" estimate from average monthly contribution so far.
    let etaNote = '';
    if(!reached && !acc){
      const monthsWithData = (g.m||[]).filter(v=>num(v)>0).length;
      const avgPerMonth = monthsWithData>0 ? sumArr(g.m||[])/monthsWithData : 0;
      if(avgPerMonth > 0){
        const monthsLeft = Math.ceil((num(g.targetAmount) - sumArr(g.m||[])) / avgPerMonth);
        if(monthsLeft > 0 && monthsLeft < 600){
          const d = new Date(); d.setMonth(d.getMonth()+monthsLeft);
          etaNote = `<div class="section-sub" style="margin:4px 0 0; opacity:.75;">At your recent pace, ~${d.toLocaleDateString('en-US',{month:'short',year:'numeric'})}</div>`;
        }
      }
    }

    const monthCells = !acc ? MONTHS.map((_,i)=>{
      const v = (g.m||[])[i];
      const val = v===null||v===undefined ? '' : v;
      const tip = monthCellFxTip(v, g.currency, y, i);
      return `<td class="editable ${!val?'zero':''} ${tip?'has-tip':''}" contenteditable="true" data-gfield="m" data-gid="${g.id}" data-idx="${i}" ${tip?`data-tip="${tip.replace(/"/g,'&quot;')}"`:''}>${val===''?'–':roundCents(val)}</td>`;
    }).join('') : MONTHS.map(()=>`<td style="color:var(--text-faint);">—</td>`).join('');

    return `
    <div class="debt-card" data-goal-id="${g.id}">
      <div class="debt-card-head">
        <div><span class="debt-name">${g.icon||'🎯'} ${g.name}</span>
          ${reached?'<span class="debt-tag" style="color:var(--good); border-color:var(--good);">🎉 goal reached</span>':''}
          ${acc?`<span class="debt-tag" style="color:var(--teal-soft); border-color:var(--teal-soft);">linked · ${acc.name}</span>`:'<span class="debt-tag">manual tracking</span>'}
        </div>
        <div class="debt-figs">
          <label style="display:flex;align-items:center;gap:4px;">Link
            <select data-goal-link="${g.id}" style="background:var(--bg-card-hi); color:var(--teal-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11px; padding:2px 4px;">
              <option value="">— not linked —</option>
              ${accounts.map(a=>`<option value="${a.id}" ${g.linkedAccountId===a.id?'selected':''}>${a.name}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
      <div class="runway"><div class="runway-fill" style="width:${pct}%; ${reached?'background:var(--good);':''}"></div></div>
      <div class="debt-foot">
        <span>Contributed: <b style="color:var(--teal-soft)">${fmt$(contributed,2)}</b> USD${cur==='INR'?` <span style="opacity:.55">(${fmtInrSafe(nativeContributed)})</span>`:''}</span>
        <span>Pending: <b style="color:var(--rust-soft)">${fmt$(pending,2)}</b> USD</span>
        <span>Target: <b class="editable-inline" contenteditable="true" data-goalfield="target" data-id="${g.id}">${nativeTarget}</b> ${cur} ${cur==='INR'?`<span style="opacity:.55">(${fmt$(target,2)})</span>`:''}
          <span class="row-del" data-delgoal="${g.id}">✕</span>
        </span>
      </div>
      ${etaNote}
    </div>
    ${!acc ? `
    <div class="table-scroll" style="margin:6px 0 16px;">
      <table class="ledger"><thead><tr><th style="width:140px;">${g.name} — monthly</th>${monthHeaderCells()}<th>Year</th></tr></thead>
      <tbody><tr>${monthCells}<td style="font-weight:700;">${fmt$(sumArr(g.m||[]),2)}</td></tr></tbody></table>
    </div>` : ''}`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h3>Savings goals</h3><span class="section-sub" style="margin:0;">Link a goal to a real account to auto-track it, or leave it unlinked and log contributions yourself.</span></div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr); margin-bottom:18px;">
        <div class="kpi-card c-gold"><div class="kpi-label">Goals</div><div class="kpi-value">${goals.length}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Total target</div><div class="kpi-value">${fmt$(totalTargetUsd)}</div></div>
        <div class="kpi-card c-rust"><div class="kpi-label">Total contributed</div><div class="kpi-value">${fmt$(totalContributedUsd)}</div></div>
        <div class="kpi-card c-gold"><div class="kpi-label">Overall progress</div><div class="kpi-value">${overallPct.toFixed(0)}%</div></div>
      </div>
      ${goals.length ? cards : '<div class="section-sub" style="padding:10px 0; text-align:center;">No goals yet — add one below.</div>'}
      <div class="addcat-row" style="margin-top:6px; flex-wrap:wrap;">
        <input type="text" id="newGoalName" placeholder="Goal name, e.g. Emergency Fund, Japan trip…" style="min-width:200px;">
        <input type="number" id="newGoalTarget" placeholder="Target amount" step="0.01" min="0" style="width:140px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
        <select id="newGoalLink" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="">— not linked (track manually) —</option>
          ${accountOptions}
        </select>
        <select id="newGoalCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addGoalBtn">+ Add goal</button>
      </div>
    </div>
  `;
}

function attachGoalsHandlers(y, goals, accounts){
  document.querySelectorAll('[data-gfield="m"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const g = goals.find(x=>x.id===td.dataset.gid);
      if(!g) return;
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : evalExpr(raw);
      if(!g.m) g.m = n12();
      const before = g.m[idx];
      if(before===v) return;
      g.m[idx] = v;
      markDirty('savings', {tab:'savings', action:'edit', target:'Goal '+g.name, field:MONTHS[idx], oldVal:before===null?'empty':before, newVal:v===null?'empty':v});
      renderSavings();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  document.querySelectorAll('[data-goalfield="target"]').forEach(el=>{
    el.addEventListener('blur', ()=>{
      const g = goals.find(x=>x.id===el.dataset.id);
      if(!g) return;
      const raw = el.textContent.trim().replace(/[$₹,]/g,'');
      let v = evalExpr(raw);
      if(v===null || isNaN(v) || v<0) v = 0;
      const before = g.targetAmount;
      if(before===v) return;
      g.targetAmount = v;
      markDirty('savings', {tab:'savings', action:'edit', target:'Goal '+g.name+' target', oldVal:before, newVal:v});
      renderSavings();
    });
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
  });

  document.querySelectorAll('[data-goal-link]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const g = goals.find(x=>x.id===sel.dataset.goalLink);
      if(!g) return;
      g.linkedAccountId = sel.value || null;
      markDirty('savings', {tab:'savings', action:'edit', target:'Goal '+g.name+' link', oldVal:'', newVal: sel.value ? accounts.find(a=>a.id===sel.value)?.name : 'unlinked'});
      renderSavings();
    });
  });

  document.querySelectorAll('[data-delgoal]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = goals.findIndex(x=>x.id===el.dataset.delgoal);
      if(idx>-1 && confirm('Remove "'+goals[idx].name+'"?')){
        const name = goals[idx].name;
        goals.splice(idx,1);
        markDirty('savings', {tab:'savings', action:'delete', target:'Goal '+name});
        renderSavings();
      }
    });
  });

  const addBtn = document.getElementById('addGoalBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    const inp = document.getElementById('newGoalName');
    const name = inp.value.trim();
    const target = parseFloat(document.getElementById('newGoalTarget').value) || 0;
    const linkedAccountId = document.getElementById('newGoalLink').value || null;
    const currency = document.getElementById('newGoalCurrency').value;
    if(!name){ inp.focus(); return; }
    goals.push({id:uid(), name, targetAmount:target, currency, linkedAccountId, m:n12(), icon:'🎯'});
    markDirty('savings', {tab:'savings', action:'add', target:'Goal '+name});
    renderSavings();
  });
}

/* =========================================================================
   RETIREMENT ACCOUNTS (401k / IRA / etc.) — two parallel monthly streams:
   what you put in and what your employer matched. Increasing a monthly
   contribution later in the year is just typing a new number in that
   month's cell, same as every other tab.
   ========================================================================= */
function renderRetirementSection(y, retAccounts){
  const totalBalance = sumArr(retAccounts.map(r=>retirementAccountTotalBalance(r)));
  const totalSelfYear = sumArr(retAccounts.map(r=>sumArr((r.mSelf||[]).map(v=>retirementToUsd(v,r)))));
  const totalEmployerYear = sumArr(retAccounts.map(r=>sumArr((r.mEmployer||[]).map(v=>retirementToUsd(v,r)))));
  const totalProjectedGrowth = sumArr(retAccounts.map(r=>retirementProjectedAnnualGrowth(r)));

  const rows = retAccounts.map(r=>{
    const selfCells = MONTHS.map((_,i)=>{
      const v = (r.mSelf||[])[i];
      const val = v===null||v===undefined ? '' : v;
      const tip = monthCellFxTip(v, r.currency, y, i);
      return `<td class="editable ${!val?'zero':''} ${tip?'has-tip':''}" contenteditable="true" data-rfield="mSelf" data-rid="${r.id}" data-idx="${i}" ${tip?`data-tip="${tip.replace(/"/g,'&quot;')}"`:''}>${val===''?'–':roundCents(val)}</td>`;
    }).join('');
    const employerCells = MONTHS.map((_,i)=>{
      const v = (r.mEmployer||[])[i];
      const val = v===null||v===undefined ? '' : v;
      const tip = monthCellFxTip(v, r.currency, y, i);
      return `<td class="editable ${!val?'zero':''} ${tip?'has-tip':''}" contenteditable="true" data-rfield="mEmployer" data-rid="${r.id}" data-idx="${i}" ${tip?`data-tip="${tip.replace(/"/g,'&quot;')}"`:''}>${val===''?'–':roundCents(val)}</td>`;
    }).join('');
    const selfTotal = sumArr(r.mSelf||[]);
    const employerTotal = sumArr(r.mEmployer||[]);
    const projGrowth = retirementProjectedAnnualGrowth(r);
    return `
    <tr data-ret-id="${r.id}" style="border-top:2px solid var(--line-soft);">
      <td rowspan="2" style="font-weight:600; vertical-align:middle;">${r.name} <span class="row-del" data-delret="${r.id}">✕</span>
        <div style="font-size:10px; color:var(--text-faint); margin-top:4px;">${r.currency||'USD'} · prior: <b class="editable-inline" contenteditable="true" data-retfield="priorSelf" data-id="${r.id}">${num(r.priorSelf)}</b> you / <b class="editable-inline" contenteditable="true" data-retfield="priorEmployer" data-id="${r.id}">${num(r.priorEmployer)}</b> employer</div>
      </td>
      <td style="color:var(--gold-soft); font-size:11px; font-weight:600;">You</td>
      ${selfCells}
      <td style="font-weight:700;">${fmt$(selfTotal,2)}</td>
      <td rowspan="2" class="editable-inline" contenteditable="true" data-retfield="returnRate" data-id="${r.id}" style="text-align:center; vertical-align:middle;">${num(r.returnRate).toFixed(2)}%</td>
      <td rowspan="2" style="color:var(--good); font-size:11.5px; vertical-align:middle;">${fmt$(projGrowth,2)}/yr</td>
    </tr>
    <tr data-ret-id="${r.id}">
      <td style="color:var(--teal-soft); font-size:11px; font-weight:600;">Employer</td>
      ${employerCells}
      <td style="font-weight:700;">${fmt$(employerTotal,2)}</td>
    </tr>`;
  }).join('');

  return `
    <div class="card">
      <div class="card-head"><h3>Retirement (401k / IRA)</h3><span class="section-sub" style="margin:0;">Track your contribution and any employer match, month by month. Bump a later month's number any time you increase how much goes in. Set each account's expected annual return/interest rate to see a projected yearly growth estimate.</span></div>
      <div class="kpi-grid" style="grid-template-columns:repeat(5,1fr); margin-bottom:18px;">
        <div class="kpi-card c-gold"><div class="kpi-label">Total balance (you + employer)</div><div class="kpi-value">${fmt$(totalBalance)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Your contributions (${y})</div><div class="kpi-value">${fmt$(totalSelfYear)}</div></div>
        <div class="kpi-card c-rust"><div class="kpi-label">Employer match (${y})</div><div class="kpi-value">${fmt$(totalEmployerYear)}</div></div>
        <div class="kpi-card c-gold"><div class="kpi-label">Projected annual growth</div><div class="kpi-value">${fmt$(totalProjectedGrowth)}</div></div>
        <div class="kpi-card c-teal"><div class="kpi-label">Accounts</div><div class="kpi-value">${retAccounts.length}</div></div>
      </div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Account</th><th></th>${monthHeaderCells()}<th>Year</th><th>Return %</th><th>Est. growth</th></tr></thead>
          <tbody id="retirementBody">${rows || '<tr><td colspan="17" class="section-sub" style="text-align:center; padding:14px 0;">No retirement accounts yet — add one below.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="addcat-row" style="margin-top:14px; flex-wrap:wrap;">
        <input type="text" id="newRetName" placeholder="e.g. Fidelity 401k, Vanguard IRA…" style="min-width:200px;">
        <input type="number" id="newRetPriorSelf" placeholder="Prior contributions — you" step="0.01" style="width:170px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
        <input type="number" id="newRetPriorEmployer" placeholder="Prior contributions — employer" step="0.01" style="width:190px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
        <input type="number" id="newRetRate" placeholder="Return / interest % (annual)" step="0.01" min="0" style="width:180px;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;">
        <select id="newRetCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addRetBtn">+ Add retirement account</button>
      </div>
    </div>
  `;
}

function attachRetirementHandlers(y, retAccounts){
  document.querySelectorAll('[data-rfield]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const r = retAccounts.find(x=>x.id===td.dataset.rid);
      if(!r) return;
      const field = td.dataset.rfield;
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : evalExpr(raw);
      if(!r[field]) r[field] = n12();
      const before = r[field][idx];
      if(before===v) return;
      r[field][idx] = v;
      markDirty('savings', {tab:'savings', action:'edit', target:'Retirement '+r.name+(field==='mSelf'?' (you)':' (employer)'), field:MONTHS[idx], oldVal:before===null?'empty':before, newVal:v===null?'empty':v});
      renderSavings();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  document.querySelectorAll('[data-retfield]').forEach(el=>{
    el.addEventListener('blur', ()=>{
      const r = retAccounts.find(x=>x.id===el.dataset.id);
      if(!r) return;
      const field = el.dataset.retfield;
      const isPct = field === 'returnRate';
      const raw = el.textContent.trim().replace(isPct ? /[%\s]/g : /[$₹,]/g,'');
      let v = evalExpr(raw);
      if(v===null || isNaN(v) || v<0) v = 0;
      const before = r[field];
      if(before===v) return;
      r[field] = v;
      markDirty('savings', {tab:'savings', action:'edit', target:'Retirement '+r.name+' prior', field, oldVal:before, newVal:v});
      renderSavings();
    });
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
  });

  document.querySelectorAll('[data-delret]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = retAccounts.findIndex(x=>x.id===el.dataset.delret);
      if(idx>-1 && confirm('Remove "'+retAccounts[idx].name+'"?')){
        const name = retAccounts[idx].name;
        retAccounts.splice(idx,1);
        markDirty('savings', {tab:'savings', action:'delete', target:'Retirement '+name});
        renderSavings();
      }
    });
  });

  const addBtn = document.getElementById('addRetBtn');
  if(addBtn) addBtn.addEventListener('click', ()=>{
    const inp = document.getElementById('newRetName');
    const name = inp.value.trim();
    const priorSelf = parseFloat(document.getElementById('newRetPriorSelf').value) || 0;
    const priorEmployer = parseFloat(document.getElementById('newRetPriorEmployer').value) || 0;
    const currency = document.getElementById('newRetCurrency').value;
    const returnRate = parseFloat(document.getElementById('newRetRate').value) || 0;
    if(!name){ inp.focus(); return; }
    retAccounts.push({id:uid(), name, currency, priorSelf, priorEmployer, returnRate, mSelf:n12(), mEmployer:n12()});
    markDirty('savings', {tab:'savings', action:'add', target:'Retirement '+name});
    renderSavings();
  });
}

/* Local fallback in case fmtInr isn't loaded yet in some load order. */
function fmtInrSafe(v){
  if(typeof fmtInr === 'function') return fmtInr(v);
  const neg = v<0;
  const s = Math.abs(num(v)).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});
  return (neg?'-₹':'₹')+s;
}
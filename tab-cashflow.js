/* =========================================================================
   CASH FLOW TAB
   ========================================================================= */
/* Timezone-safe date parsing (parseLocalDateParts, toLocalISODate) now lives
   in core-data.js, shared by every tab — see that file for why it matters. */

function ensureBanksMigration(){
  const y = state.year;
  if(!yearData(y).banks) yearData(y).banks = [];
  // Migrate old banks (balance/lastUpdated) to new format (m array)
  yearData(y).banks.forEach(b => {
    if(!b.m) b.m = n12();
    // If old single balance exists, stuff it into current month as a starting point
    if(b.balance !== undefined && b.balance !== null && b.m.every(v => v === null)){
      const today = new Date();
      const cm = today.getMonth();
      b.m[cm] = num(b.balance);
      delete b.balance;
      delete b.lastUpdated;
    }
    if(!b.type) b.type = 'checking';
    if(b.type==='credit' && b.creditLimit===undefined) b.creditLimit = null;
    if(!b.transactions) b.transactions = [];
    if(b.lastUpdatedAt===undefined) b.lastUpdatedAt = null;
    repairBankBalancesFromTransactions(b);
  });
}

/* One-time, ongoing self-heal for data written before the carry-forward fix.
   Any month that has logged transactions gets recomputed as
   (correct running balance carried in) + (that month's own transaction total) —
   rather than trusting whatever number is currently sitting in that cell, which
   for months touched by the old bug is simply that month's own delta with no
   carry-in at all. Months with NO transactions (including any you set purely by
   typing a number into the Advanced table) are left completely untouched, since
   there's no transaction log to verify them against and they may be intentional. */
function repairBankBalancesFromTransactions(bank){
  const deltaByMonth = new Array(12).fill(0);
  const touched = new Array(12).fill(false);
  (bank.transactions||[]).forEach(t=>{
    const i = t.monthIdx;
    if(i==null || i<0 || i>11) return;
    deltaByMonth[i] += num(t.amount);
    touched[i] = true;
  });
  if(!touched.some(Boolean)) return; // no transaction log to reconcile against

  let carry = null; // the correct running balance as we sweep forward through the year
  let changed = false;
  for(let i=0;i<12;i++){
    if(touched[i]){
      const correct = roundCents((carry ?? 0) + deltaByMonth[i]);
      if(bank.m[i] !== correct){ bank.m[i] = correct; changed = true; }
      carry = correct;
    } else if(bank.m[i]!=null){
      // A manual entry with no transactions this month — trust it as the new baseline.
      carry = bank.m[i];
    }
    // else: blank month, nothing to reconcile, carry stays what it was.
  }
  if(changed){
    // Not the user's own edit, but it does need to actually reach storage —
    // otherwise this "fix" only lasts until the page reloads and the old
    // wrong numbers come back down from Supabase again.
    markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Bank '+bank.name+' (auto-corrected)', field:'monthly balances', newVal:'recalculated from transaction history'});
  }
}
const BANK_TYPE_LABELS = { checking:'Checking', savings:'Savings', credit:'Credit Card', other:'Other' };
function timeAgo(ts){
  if(!ts) return 'no updates yet';
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return mins+' minute'+(mins===1?'':'s')+' ago';
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return hrs+' hour'+(hrs===1?'':'s')+' ago';
  const days = Math.floor(hrs/24);
  if(days < 30) return days+' day'+(days===1?'':'s')+' ago';
  const months = Math.floor(days/30);
  return months+' month'+(months===1?'':'s')+' ago';
}

/* ---------- Expense-category lookup (used by Add Money's "Expense" option) ---------- */
function flattenExpenseCategories(y){
  const groups = yearData(y).expenseGroups || [];
  const list = [];
  groups.forEach(g=>{
    (g.categories||[]).forEach(c=>{
      list.push({ id:c.id, name:c.name, groupId:g.id, groupName:g.name });
    });
  });
  return list;
}
function findExpenseCategoryById(y, catId){
  const groups = yearData(y).expenseGroups || [];
  for(const g of groups){
    const c = (g.categories||[]).find(x=>x.id===catId);
    if(c) return { cat:c, group:g };
  }
  return null;
}

/* ---------- Additive breakdown chain (so hover/edit shows the running composition, e.g. "1000+200+1000") ---------- */
function appendAdditiveTerm(raw, prevVal, term){
  const base = raw!=null ? raw : (prevVal ? String(prevVal) : null);
  return base!=null ? (base + '+' + term) : String(roundCents(prevVal + term));
}
function stripAdditiveTerm(raw, term){
  if(raw==null) return null;
  const suffix = '+'+term;
  if(raw.endsWith(suffix)) return raw.slice(0, -suffix.length) || null;
  if(raw === String(term)) return null;
  return null; // chain doesn't match exactly (e.g. hand-edited since) — safest fallback is to clear it
}

let cashflowFullYearView = false;

function renderCashFlow(){
  const y = state.year;
  const rows = computeCashFlow(y);
  const isFullYear = state.month==='ALL';
  const mi = isFullYear ? currentSnapshotMonth(y) : Number(state.month);
  const thisRow = rows[mi];
  const prevRow = mi>0 ? rows[mi-1] : null;

  const isMonthScope = state.month !== 'ALL';
  const showFullYear = cashflowFullYearView || !isMonthScope;
  const monthsToShow = showFullYear ? [0,1,2,3,4,5,6,7,8,9,10,11] : [mi];

  /* ---- Banks & credit cards ---- */
  ensureBanksMigration();
  const allAccounts = yearData(y).banks;
  const banks = allAccounts.filter(b=>b.type!=='credit');       // real cash accounts
  const creditCards = allAccounts.filter(b=>b.type==='credit'); // liabilities, tracked separately

  /* ---- Cash summary card + clickable bank list (Monarch-style) ---- */
  const bankUsdAt = (b, i) => accountDisplayUsdAt(b, y, i); // cash: $0 if blank · credit: carries real owed balance
  const cashSnapIdx = currentSnapshotMonth(y);
  const cashTotal = sumArr(banks.map(b => bankUsdAt(b, cashSnapIdx) || 0));
  const cashPrevTotal = cashSnapIdx>0 ? sumArr(banks.map(b => bankUsdAt(b, cashSnapIdx-1) || 0)) : null;
  const cashDelta = cashPrevTotal===null ? null : cashTotal - cashPrevTotal;
  const cashDeltaPct = (cashPrevTotal && cashPrevTotal!==0) ? (cashDelta/Math.abs(cashPrevTotal))*100 : null;

  const creditOwedTotal = sumArr(creditCards.map(b => -(bankUsdAt(b, cashSnapIdx) || 0)));

  // Same components Net Worth uses, so "% of assets" lines up with Overview.
  const invCurrentForAssets = sumArr(yearData(y).investments.map(it => {
    const platRows = (it.holdings && it.holdings.length && typeof platformHoldings === 'function') ? platformHoldings(y, it.id) : [];
    if(platRows.length) return sumArr(platRows.map(r=>r.currentValueUSD));
    return nativeMonthToUsd(num(it.currentValue), it.currency, y, cashSnapIdx);
  }));
  const savingsForAssets = sumArr((yearData(y).savingsAccounts||[]).map(acc=>nativeMonthToUsd(num((acc.m||[])[cashSnapIdx]), acc.currency, y, cashSnapIdx)));
  const retirementForAssets = sumArr((yearData(y).retirementAccounts||[]).map(r=>retirementAccountTotalBalance(r)));
  const totalAssets = cashTotal + invCurrentForAssets + savingsForAssets + retirementForAssets;
  const cashPctOfAssets = totalAssets>0 ? (cashTotal/totalAssets)*100 : null;

  const bankRows = banks.map(b=>{
    const bal = bankUsdAt(b, cashSnapIdx);
    const initial = (b.name||'?').trim().charAt(0).toUpperCase() || '?';
    return `
    <div class="bank-row" data-bank-open="${b.id}">
      <div class="bank-row-icon">${initial}</div>
      <div class="bank-row-main">
        <div class="bank-row-name">${b.name}</div>
        <div class="bank-row-sub">${BANK_TYPE_LABELS[b.type]||'Checking'}</div>
      </div>
      <div class="bank-row-right">
        <div class="bank-row-balance">${bal===null?'—':fmt$(bal,2)}</div>
        <div class="bank-row-sub">${timeAgo(b.lastUpdatedAt)}</div>
      </div>
    </div>`;
  }).join('');

  const creditRows = creditCards.map(b=>{
    const bal = bankUsdAt(b, cashSnapIdx);
    const owed = bal===null ? 0 : Math.max(0,-bal);
    const hasLimit = b.creditLimit!=null && b.creditLimit>0;
    const pctUsed = hasLimit ? (owed/b.creditLimit)*100 : null;
    const pctColor = pctUsed===null ? 'var(--text-dim)' : pctUsed>=70 ? 'var(--rust-soft)' : pctUsed>=30 ? 'var(--gold-soft)' : 'var(--good)';
    const initial = (b.name||'?').trim().charAt(0).toUpperCase() || '?';
    return `
    <div class="bank-row" data-bank-open="${b.id}">
      <div class="bank-row-icon">${initial}</div>
      <div class="bank-row-main">
        <div class="bank-row-name">${b.name} <span class="row-del" data-editlimit="${b.id}" title="edit credit limit">✎</span></div>
        <div class="bank-row-sub">${hasLimit ? `${fmt$(b.creditLimit,0)} limit · <span style="color:${pctColor};">${pctUsed.toFixed(0)}% used</span>` : 'No preset limit'}</div>
      </div>
      <div class="bank-row-right">
        <div class="bank-row-balance" style="color:${owed>0?'var(--rust-soft)':'var(--good)'}">${bal===null?'—':(owed>0?fmt$(owed,2)+' owed':'Paid off')}</div>
        <div class="bank-row-sub">${hasLimit ? fmt$(Math.max(0,b.creditLimit-owed),2)+' available' : timeAgo(b.lastUpdatedAt)}</div>
      </div>
    </div>`;
  }).join('');

  const cashCard = `
    <div class="card cash-summary-card">
      <div class="cash-summary-head">
        <div class="cash-summary-title">Cash</div>
        <div class="cash-summary-value">${fmt$(cashTotal,2)}</div>
      </div>
      <div class="cash-summary-sub">
        ${cashDelta===null ? `<span class="section-sub" style="margin:0;">no prior month in ${y}</span>` : `
          <span class="cash-delta ${cashDelta>=0?'up':'down'}">${cashDelta>=0?'↑':'↓'} ${fmt$(Math.abs(cashDelta),2)}${cashDeltaPct===null?'':' ('+(cashDelta>=0?'+':'-')+Math.abs(cashDeltaPct).toFixed(1)+'%)'}</span>
          <span class="cash-delta-period">${MONTHS[cashSnapIdx-1]||'prior'} → ${MONTHS[cashSnapIdx]}</span>
        `}
        ${cashPctOfAssets===null?'':`<span class="cash-pct-assets">${cashPctOfAssets.toFixed(0)}% of assets</span>`}
      </div>
      <div class="bank-row-list">
        ${bankRows || '<div class="section-sub" style="padding:14px 0; text-align:center; margin:0;">No bank accounts yet — add one below.</div>'}
      </div>
      <div class="addcat-row" style="margin-top:14px;">
        <input type="text" id="newBankName" placeholder="New bank name, e.g. HDFC, Schwab, Chase…" style="min-width:200px;">
        <select id="newBankType" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="other">Other</option>
        </select>
        <select id="newBankCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addBankBtn">+ Add bank</button>
      </div>
    </div>
  `;

  const cardsWithLimit = creditCards.filter(b=>b.creditLimit!=null && b.creditLimit>0);
  const totalLimit = sumArr(cardsWithLimit.map(b=>b.creditLimit));
  const totalOwedWithLimit = sumArr(cardsWithLimit.map(b=>Math.max(0,-(bankUsdAt(b, cashSnapIdx)||0))));
  const overallPct = totalLimit>0 ? (totalOwedWithLimit/totalLimit)*100 : null;

  const creditCard = `
    <div class="card cash-summary-card">
      <div class="cash-summary-head">
        <div class="cash-summary-title">Credit Cards</div>
        <div class="cash-summary-value" style="color:${creditOwedTotal>0?'var(--rust-soft)':'var(--good)'}">${fmt$(creditOwedTotal,2)} owed</div>
      </div>
      <p class="section-sub" style="margin-top:0;">A credit card is a liability, not income — it isn't added here. Log each purchase as an <b>Expense</b> from "+ Add money" below (it raises what's owed); when you pay the statement, log a <b>Transfer</b> from the paying bank to the card (it clears what's owed and lowers that bank's balance) — by month end the two match up automatically. This total is excluded from "Cash" above and from the reconciliation table, since it's debt, not cash on hand.
      ${overallPct===null ? '' : ` Across cards with a set limit, you're using <b>${overallPct.toFixed(0)}%</b> of ${fmt$(totalLimit,0)} available (cards with no preset limit, like an Amex with no fixed cap, aren't counted here).`}</p>
      <div class="bank-row-list">
        ${creditRows || '<div class="section-sub" style="padding:14px 0; text-align:center; margin:0;">No credit cards yet — add one below.</div>'}
      </div>
      <div class="addcat-row" style="margin-top:14px; flex-wrap:wrap;">
        <input type="text" id="newCreditName" placeholder="New card name, e.g. Amex Blue Cash…" style="min-width:180px;">
        <input type="number" id="newCreditLimit" min="0" step="any" placeholder="Credit limit (blank = no preset limit)" style="min-width:220px; background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
        <select id="newCreditCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addCreditBtn">+ Add credit card</button>
      </div>
    </div>
  `;

  const deltaHtml = (curr, prev)=>{
    if(prev===null) return `<div class="kpi-delta flat">no prior month in ${y}</div>`;
    const d = curr - prev.carryOut;
    return `<div class="kpi-delta ${d>=0?'up':'down'}">${d>=0?'▲':'▼'} ${fmt$(Math.abs(d))} vs ${MONTHS[mi-1]}</div>`;
  };

  const editCell = (i, field, value, extraClass)=>{
    const overridden = cfOverride(y,i,field)!==undefined;
    return `<td class="editable cf-cell ${extraClass||''} ${overridden?'overridden':''}" contenteditable="true" data-cfcell="${i}" data-cffield="${field}" title="${overridden?'Manually overridden — clear the cell to go back to the calculated value':''}">${fmt$(value,2)}</td>`;
  };

  /* ---- Cash Flow Month-by-Month Table (respects the month picker up top; toggle to see the full year) ---- */
  const tableRows = monthsToShow.map(i=>{
    const r = rows[i];
    return `
    <tr>
      <td>${MONTHS[i]}</td>
      ${editCell(i,'carryIn', r.carryIn)}
      ${editCell(i,'income', r.income)}
      ${editCell(i,'expenses', r.expenses)}
      ${editCell(i,'card', r.card)}
      ${editCell(i,'debtPaid', r.debtPaid)}
      ${editCell(i,'retirement', r.retirement)}
      <td style="font-weight:600; color:${r.netFlow>=0?'var(--teal-soft)':'var(--rust-soft)'}">${r.netFlow>=0?'+':''}${fmt$(r.netFlow,2)}</td>
      <td style="font-weight:700; color:var(--gold-soft)">${fmt$(r.carryOut,2)}</td>
    </tr>`;
  }).join('');

  /* ---- Reconciliation row: computed cash vs bank balances (credit cards excluded — they're debt, not cash) ---- */
  const reconcileRows = monthsToShow.map(i=>{
    const r = rows[i];
    const bankTotal = banks.reduce((a,b)=>a+bankDisplayUsdAt(b,y,i),0);
    const diff = bankTotal - r.carryOut;
    const match = Math.abs(diff) < 1;
    const hasBankData = banks.length > 0; // blank months are a real $0 now, not "no data yet"
    return `<tr>
      <td>${MONTHS[i]}</td>
      <td style="color:var(--gold-soft); font-weight:600;">${fmt$(r.carryOut,2)}</td>
      <td style="color:var(--teal-soft); font-weight:600;">${hasBankData?fmt$(bankTotal,2):'—'}</td>
      <td style="color:${match?'var(--good)':Math.abs(diff)<100?'var(--gold-soft)':'var(--danger)'}; font-weight:600;">
        ${hasBankData?(match?'✓':(diff>=0?'+':'')+fmt$(diff,2)):'—'}
      </td>
    </tr>`;
  }).join('');

  /* ---- Banks Month-by-Month Table (like Expenses) — respects the month picker ---- */
  function accountMonthRows(list){
    return list.map(b=>{
      const isCreditRow = b.type==='credit';
      const cells = monthsToShow.map(i=>{
        const val = accountDisplayValueAt(b, i); // cash: 0 if blank · credit: real carried owed balance
        const explicit = (b.m||[])[i];
        const isCarried = isCreditRow && (explicit===null || explicit===undefined) && val!==0;
        const tip = isCarried ? 'Carried forward from an earlier month — start typing to log a charge or payment for this month' : '';
        return `<td class="editable ${!val?'zero':''} ${isCarried?'carried-cell':''}" contenteditable="true" data-bfield="m" data-bid="${b.id}" data-idx="${i}" title="${tip}">${val}</td>`;
      }).join('');
      const total = sumArr(b.m||[]);
      return `<tr data-bank-id="${b.id}">
        <td style="font-weight:600;">${b.name} <span class="row-del" data-delbank="${b.id}">✕</span></td>
        ${cells}
        <td style="font-weight:700;">${fmt$(total,2)}</td>
        <td style="color:var(--text-dim); font-size:11px;">${b.currency||'USD'}</td>
      </tr>`;
    }).join('');
  }
  const bankMonthRows = accountMonthRows(banks);
  const creditMonthRows = accountMonthRows(creditCards);

  const viewToggleHtml = `
    <div class="view-toggle">
      ${isMonthScope ? `<button class="btn small" id="cashflowViewToggle">${showFullYear && cashflowFullYearView ? '◀ Show only '+MONTHS[mi] : 'Show full year →'}</button>` : `<span class="section-sub" style="margin:0;">Showing the full year — pick a specific month above to narrow the tables.</span>`}
    </div>
  `;

  const html = `
    <div class="section-title">Cash Flow · ${y}</div>
    <p class="section-sub">What you actually have on hand: income, minus categorized spending, minus card bill payments, minus debt payments, minus your own retirement contribution — carried forward month over month. Every cell below is editable — type over anything to correct it for a specific month; clear a cell to go back to the calculated value.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Carried in from ${mi>0?MONTHS[mi-1]:'prior year'}</div><div class="kpi-value">${fmt$(thisRow.carryIn)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">${MONTHS[mi]} net flow</div><div class="kpi-value">${thisRow.netFlow>=0?'+':''}${fmt$(thisRow.netFlow)}</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">Card + debt + retirement this month</div><div class="kpi-value">${fmt$(thisRow.card+thisRow.debtPaid+thisRow.retirement)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Cash on hand, end of ${MONTHS[mi]}</div><div class="kpi-value">${fmt$(thisRow.carryOut)}</div>${deltaHtml(thisRow.carryOut, prevRow)}</div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Running cash balance</h3></div>
      <div class="chart-box tall"><canvas id="chartCashRunning"></canvas></div>
    </div>

    ${viewToggleHtml}

    <div class="card">
      <div class="card-head"><h3>Month by month — computed cash flow</h3></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Month</th><th>Carry-in</th><th>Income</th><th>Expenses</th><th>Card Paid</th><th>Debt Paid</th><th>Retirement</th><th>Net Flow</th><th>Carry-out</th></tr></thead>
          <tbody id="cfBody">${tableRows}</tbody>
        </table>
      </div>
      <div class="section-sub" style="margin-top:10px; margin-bottom:0;">
        <b>How this works:</b> <b>Carry-in</b> is what you had at the start. <b>Income</b> adds to it. <b>Expenses</b>, <b>Card Paid</b>, <b>Debt Paid</b>, and <b>Retirement</b> (your own contribution — employer match isn't your cash, so it's excluded) subtract. The result is <b>Net Flow</b>. <b>Carry-out</b> = Carry-in + Net Flow. That carry-out becomes next month's carry-in automatically.
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Reconciliation — computed vs. actual bank balances</h3></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Month</th><th>Computed Cash</th><th>Banks Total</th><th>Difference</th></tr></thead>
          <tbody>${reconcileRows}</tbody>
        </table>
      </div>
      <div class="section-sub" style="margin-top:10px; margin-bottom:0;">
        Enter your actual bank balances below month by month. <b>✓</b> means your tracked numbers match reality. If there's a gap, you missed income, an expense, a transfer, or a debt payment. Credit cards are excluded here — they're debt, not cash.
      </div>
    </div>

    ${cashCard}
    ${creditCard}

    <div class="card">
      <div class="card-head"><h3>Advanced: bank accounts, month by month</h3><span class="section-sub" style="margin:0;">Direct editing for any month — the card above only touches the current month via "Add money." A month left blank counts as $0 here and everywhere else (the card, the reconciliation total) — it's never silently carried forward from an earlier month.</span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Bank / Account</th>${monthHeaderCells(monthsToShow)}<th>Year</th><th>Currency</th></tr></thead>
          <tbody id="bankBody">${bankMonthRows}
            <tr class="total-row"><td>Total across banks</td>${monthsToShow.map(i=>{
              const t = banks.reduce((a,b)=>a+bankDisplayUsdAt(b,y,i),0);
              return `<td>${fmt$(t)}</td>`;
            }).join('')}<td>${fmt$(banks.reduce((a,b)=>a+sumArr(b.m||[]),0))}</td><td></td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Advanced: credit cards, month by month</h3><span class="section-sub" style="margin:0;">Values here are the balance owed at month end (0 = paid in full, and a blank month is treated as 0 — not carried forward).</span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Card</th>${monthHeaderCells(monthsToShow)}<th>Year</th><th>Currency</th></tr></thead>
          <tbody id="creditBody">${creditMonthRows || `<tr><td colspan="${monthsToShow.length+3}" class="section-sub" style="text-align:center;">No credit cards yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('panel-cashflow').innerHTML = html;

  /* ---- Cash flow cell handlers ---- */
  document.querySelectorAll('#cfBody [data-cfcell]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.prev = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.prev) return;
      const i = Number(td.dataset.cfcell), field = td.dataset.cffield;
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      if(raw===''){
        setCfOverride(y, i, field, null);
      } else {
        const v = parseFloat(raw);
        if(!isNaN(v)) setCfOverride(y, i, field, v);
        else return;
      }
      markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Cash Flow '+MONTHS[i], field:field, oldVal:td.dataset.prev, newVal:raw});
      renderCashFlow();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  /* ---- Bank / credit-card month cell handlers ---- */
  document.querySelectorAll('#bankBody [data-bfield="m"], #creditBody [data-bfield="m"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const b = allAccounts.find(x=>x.id===td.dataset.bid);
      if(!b) return;
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : parseFloat(raw);
      if(isNaN(v)) v = null;
      if(!b.m) b.m = n12();
      const before = b.m[idx];
      if(before===v) return;
      b.m[idx] = v;
      b.lastUpdatedAt = Date.now();
      td.textContent = v===null?'–':roundCents(v);
      td.classList.toggle('zero', !v);
      markDirty('cashflow', {tab:'cashflow', action:'edit', target:(b.type==='credit'?'Credit card ':'Bank ')+b.name, field:MONTHS[idx], oldVal:before===null?'empty':before, newVal:v===null?'empty':v});
      renderCashFlow();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  /* ---- Delete bank / credit card ---- */
  document.querySelectorAll('[data-delbank]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const idx = allAccounts.findIndex(x=>x.id===el.dataset.delbank);
      if(idx>-1 && confirm('Remove "'+allAccounts[idx].name+'"?')){
        const name = allAccounts[idx].name;
        allAccounts.splice(idx,1);
        markDirty('cashflow', {tab:'cashflow', action:'delete', target:'Bank '+name});
        renderCashFlow();
      }
    });
  });

  /* ---- Open bank/credit-card detail (Monarch-style click-through) ---- */
  document.querySelectorAll('[data-bank-open]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const b = allAccounts.find(x=>x.id===el.dataset.bankOpen);
      if(b) openBankDetailModal(b, y);
    });
  });

  /* ---- Add bank ---- */
  document.getElementById('addBankBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newBankName');
    const name = inp.value.trim();
    const type = document.getElementById('newBankType').value;
    const currency = document.getElementById('newBankCurrency').value;
    if(!name){ inp.focus(); return; }
    allAccounts.push({id:uid(), name, m:n12(), currency, type, transactions:[], lastUpdatedAt:null});
    markDirty('cashflow', {tab:'cashflow', action:'add', target:'Bank '+name});
    renderCashFlow();
  });

  /* ---- Add credit card ---- */
  document.getElementById('addCreditBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newCreditName');
    const name = inp.value.trim();
    const currency = document.getElementById('newCreditCurrency').value;
    const limitRaw = document.getElementById('newCreditLimit').value.trim();
    const creditLimit = limitRaw==='' ? null : Math.abs(parseFloat(limitRaw));
    if(!name){ inp.focus(); return; }
    allAccounts.push({id:uid(), name, m:n12(), currency, type:'credit', creditLimit: isNaN(creditLimit)?null:creditLimit, transactions:[], lastUpdatedAt:null});
    markDirty('cashflow', {tab:'cashflow', action:'add', target:'Credit card '+name});
    renderCashFlow();
  });

  /* ---- Edit an existing card's credit limit (leave blank for no preset limit, e.g. Amex Gold) ---- */
  document.querySelectorAll('[data-editlimit]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const b = allAccounts.find(x=>x.id===el.dataset.editlimit);
      if(!b) return;
      const current = b.creditLimit!=null ? String(b.creditLimit) : '';
      const entered = prompt('Credit limit for '+b.name+' (in '+(b.currency||'USD')+') — leave blank if this card has no preset limit:', current);
      if(entered===null) return; // cancelled
      const trimmed = entered.trim();
      const newLimit = trimmed==='' ? null : Math.abs(parseFloat(trimmed));
      b.creditLimit = (newLimit===null || isNaN(newLimit)) ? null : newLimit;
      markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Credit card '+b.name, field:'credit limit', newVal: b.creditLimit===null?'no preset limit':b.creditLimit});
      renderCashFlow();
    });
  });

  /* ---- View toggle ---- */
  const viewToggle = document.getElementById('cashflowViewToggle');
  if(viewToggle){
    viewToggle.addEventListener('click', ()=>{ cashflowFullYearView = !cashflowFullYearView; renderCashFlow(); });
  }

  /* ---- Charts ---- */
  destroyChart('cashRunning');
  charts.cashRunning = safeChart(document.getElementById('chartCashRunning'), {
    type:'line',
    data:{ labels: MONTHS, datasets:[
      {label:'Cash on hand (end of month)', data: rows.map(r=>r.carryOut), borderColor:'#C9A961', backgroundColor:'rgba(201,169,97,0.12)', fill:true, tension:.3},
      {label:'Net flow', data: rows.map(r=>r.netFlow), borderColor:'#6FA491', borderDash:[4,3], tension:.3, pointRadius:2}
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10,boxHeight:10}}},
      scales:{ y:{grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });
}

/* ---------- Reverse & delete a single transaction (used by the ✕ next to each line in the bank/card detail modal) ---------- */
/* ---------- Undo everything a transaction did (balance, linked income/expense, transfer pair) ----------
   Shared by both Delete and Edit — Edit is "reverse the old one, then create the new one" under the hood,
   using this exact same math so there's only one place that can get it wrong. Does NOT remove txn from
   bank.transactions itself — callers decide when/whether to do that. */
function reverseTransactionEffects(bank, y, txn){
  const idx = txn.monthIdx;

  // 1. Reverse this account's balance for that month.
  if(bank.m && bank.m[idx]!=null){
    bank.m[idx] = roundCents(num(bank.m[idx]) - num(txn.amount));
  }

  // 2. Reverse the linked income / expense effect, if any.
  if(txn.category==='income' && txn.refId){
    const src = (yearData(y).income||[]).find(s=>s.id===txn.refId);
    if(src && src.m){
      const term = txn.refDelta!=null ? txn.refDelta : txn.amount; // fallback for older saved transactions
      src.m[idx] = roundCents(num(src.m[idx]) - term);
      if(src.raw) src.raw[idx] = stripAdditiveTerm(src.raw[idx], term);
    }
  }
  if(txn.category==='expense' && txn.refId){
    const found = findExpenseCategoryById(y, txn.refId);
    if(found && found.cat.m){
      // Original effect: withdraw (amount<0) added abs(amount) as spend; deposit (amount>0) subtracted it.
      const term = txn.refDelta!=null ? txn.refDelta : (txn.amount<0 ? Math.abs(txn.amount) : -Math.abs(txn.amount));
      found.cat.m[idx] = roundCents(num(found.cat.m[idx]) - term);
      if(found.cat.raw) found.cat.raw[idx] = term>0 ? stripAdditiveTerm(found.cat.raw[idx], term) : null;
    }
  }

  // 3. Reverse the paired leg of a transfer, and delete that mirrored transaction too.
  if(txn.category==='transfer' && txn.transferPairBankId){
    const otherBank = (yearData(y).banks||[]).find(b=>b.id===txn.transferPairBankId);
    if(otherBank){
      if(otherBank.m && otherBank.m[idx]!=null){
        otherBank.m[idx] = roundCents(num(otherBank.m[idx]) + num(txn.amount));
      }
      otherBank.transactions = (otherBank.transactions||[]).filter(t=>t.id!==txn.transferPairTxnId);
    }
  }
}

function deleteBankTransaction(bank, y, txn){
  const warnExtra = txn.category==='income' ? ' and that income entry'
    : txn.category==='expense' ? ' and that expense category'
    : txn.category==='transfer' ? ' and the other account it moved to/from'
    : '';
  if(!confirm('Delete this transaction? This will undo its effect on the balance'+warnExtra+'.')) return;

  const idx = txn.monthIdx;
  reverseTransactionEffects(bank, y, txn);
  bank.transactions = (bank.transactions||[]).filter(t=>t.id!==txn.id);

  markDirty('cashflow', {tab:'cashflow', action:'delete', target:'Transaction — '+bank.name, field:MONTHS[idx], oldVal:(txn.amount>=0?'+':'')+txn.amount.toFixed(2)});
  renderCashFlow();
  openBankDetailModal(bank, y, idx); // reopen refreshed, staying on the same month
}

/* ---------- Bank / credit-card detail modal (Monarch-style click-through) ---------- */
function openBankDetailModal(bank, y, monthIdxArg){
  const old = document.getElementById('bankDetailOverlay');
  if(old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'bankDetailOverlay';
  overlay.className = 'modal-overlay';

  const isCredit = bank.type==='credit';
  const monthIdx = monthIdxArg!=null ? monthIdxArg : (state.month==='ALL' ? currentSnapshotMonth(y) : Number(state.month));
  const balUsd = accountDisplayUsdAt(bank, y, monthIdx);
  const prevBalUsd = monthIdx>0 ? accountDisplayUsdAt(bank, y, monthIdx-1) : null;
  const delta = prevBalUsd===null ? null : balUsd - prevBalUsd;
  const txns = [...(bank.transactions||[])]
    .filter(t=>t.monthIdx===undefined || t.monthIdx===monthIdx)
    .sort((a,b)=> (b.date||'').localeCompare(a.date||''))
    .slice(0,10);

  const txnRows = txns.map(t=>{
    const catLabel = t.category==='income' ? '💰 Income' : t.category==='expense' ? '🧾 Expense' : t.category==='transfer' ? '🔁 Transfer' : '📝 Other';
    const color = num(t.amount)>=0 ? 'var(--good)' : 'var(--danger)';
    return `<div class="bank-txn-row">
      <div class="bank-txn-main">
        <div class="bank-txn-date">${t.date}</div>
        <div class="bank-txn-cat">${catLabel}${t.note?' · '+t.note:''}</div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <div class="bank-txn-amt" style="color:${color};">${num(t.amount)>=0?'+':''}${fmt$(t.amount,2)}</div>
        <span class="row-del" data-edittxn="${t.id}" title="edit this transaction">✎</span>
        <span class="row-del" data-deltxn="${t.id}" title="delete this transaction">✕</span>
      </div>
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="modal-card" style="width:420px;">
      <h3>${isCredit?'💳':'🏦'} ${bank.name}</h3>
      <p class="modal-sub">${isCredit?'Credit Card':(BANK_TYPE_LABELS[bank.type]||'Checking')} · ${bank.currency||'USD'}</p>
      <div class="modal-field" style="margin-bottom:10px;">
        <label>Month</label>
        <select id="bankDetailMonth" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          ${MONTHS.map((m,i)=>`<option value="${i}" ${i===monthIdx?'selected':''}>${m} ${y}</option>`).join('')}
        </select>
      </div>
      <div class="modal-preview">
        <span class="label">${isCredit?'Owed':'Balance'} (${MONTHS[monthIdx]})</span>
        <span class="value">${isCredit ? fmt$(Math.max(0,-balUsd),2) : fmt$(balUsd,2)}</span>
      </div>
      ${!isCredit ? '' : (bank.creditLimit!=null && bank.creditLimit>0
          ? `<div class="section-sub" style="margin:-8px 0 10px;">${fmt$(Math.max(0,bank.creditLimit-Math.max(0,-balUsd)),2)} available of ${fmt$(bank.creditLimit,0)} limit <span class="row-del" data-editlimit="${bank.id}" style="margin-left:4px;">✎ edit limit</span></div>`
          : `<div class="section-sub" style="margin:-8px 0 10px;">No preset limit <span class="row-del" data-editlimit="${bank.id}" style="margin-left:4px;">✎ set a limit</span></div>`)}
      ${delta===null ? '' : `<div class="section-sub" style="margin:4px 0 14px;">${delta>=0?'↑':'↓'} ${fmt$(Math.abs(delta),2)} vs ${MONTHS[monthIdx-1]}</div>`}
      <div style="max-height:220px; overflow-y:auto; margin-bottom:18px;">
        ${txnRows || `<div class="section-sub" style="text-align:center; padding:14px 0;">No transactions logged for ${MONTHS[monthIdx]} — anything you add here will show up in this list, each with an ✕ to remove it.</div>`}
      </div>
      <div class="modal-actions" style="justify-content:space-between;">
        <button class="btn" id="bankDetailCloseBtn">Close</button>
        <button class="btn primary" id="bankDetailAddMoneyBtn">+ Add money</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('#bankDetailMonth').addEventListener('change', (e)=>{
    openBankDetailModal(bank, y, Number(e.target.value));
  });

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#bankDetailCloseBtn').addEventListener('click', close);
  overlay.querySelector('#bankDetailAddMoneyBtn').addEventListener('click', ()=>{
    close();
    openAddMoneyModal(bank, y, monthIdx);
  });
  overlay.querySelectorAll('[data-deltxn]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const txn = (bank.transactions||[]).find(t=>t.id===el.dataset.deltxn);
      if(txn) deleteBankTransaction(bank, y, txn);
    });
  });
  overlay.querySelectorAll('[data-edittxn]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const txn = (bank.transactions||[]).find(t=>t.id===el.dataset.edittxn);
      if(txn){ close(); openAddMoneyModal(bank, y, txn.monthIdx, txn); }
    });
  });
  const editLimitLink = overlay.querySelector('[data-editlimit]');
  if(editLimitLink){
    editLimitLink.addEventListener('click', (e)=>{
      e.stopPropagation();
      const current = bank.creditLimit!=null ? String(bank.creditLimit) : '';
      const entered = prompt('Credit limit for '+bank.name+' (in '+(bank.currency||'USD')+') — leave blank if this card has no preset limit:', current);
      if(entered===null) return;
      const trimmed = entered.trim();
      const newLimit = trimmed==='' ? null : Math.abs(parseFloat(trimmed));
      bank.creditLimit = (newLimit===null || isNaN(newLimit)) ? null : newLimit;
      markDirty('cashflow', {tab:'cashflow', action:'edit', target:'Credit card '+bank.name, field:'credit limit', newVal: bank.creditLimit===null?'no preset limit':bank.creditLimit});
      renderCashFlow();
      openBankDetailModal(bank, y, monthIdx);
    });
  }
}

/* ---------- Add Money modal ----------
   Everything additive (income/expense/deposit/withdraw) is ADDED to whatever's
   already there for that month, never replacing it — and any stale "raw
   breakdown" on the affected income/expense cell is cleared so its hover
   tooltip and edit view immediately reflect the new total, not the old one.
   ========================================================================= */
/* ---------- Add Money modal ----------
   Everything additive (income/expense/deposit/withdraw) is ADDED to whatever's
   already there for that month, never replacing it. Income/expense hover
   tooltips get an extended breakdown chain (e.g. "1000+200+1000") rather than
   being wiped, and the exact delta applied is stored on the transaction so
   deleting it later unwinds precisely — chain and all.
   ========================================================================= */
function openAddMoneyModal(bank, y, monthIdxArg, editingTxn){
  const old = document.getElementById('addMoneyOverlay');
  if(old) old.remove();

  const isEdit = !!editingTxn;
  const isCredit = bank.type==='credit';
  const incomeSources = yearData(y).income || [];
  const expenseGroups = yearData(y).expenseGroups || [];
  const otherAccounts = (yearData(y).banks||[]).filter(b=>b.id!==bank.id);
  const hasCreditDestination = otherAccounts.some(b=>b.type==='credit');
  const today = new Date();
  // Default the date into whichever month was open in the detail modal — same
  // day-of-month as today when that's valid for the target month, else the 1st.
  // When editing, always start from the transaction's own date instead.
  let defaultDate = today;
  if(monthIdxArg!=null && monthIdxArg!==today.getMonth()){
    const day = Math.min(today.getDate(), new Date(y, monthIdxArg+1, 0).getDate());
    defaultDate = new Date(y, monthIdxArg, day);
  }
  const todayISO = isEdit ? editingTxn.date : toLocalISODate(defaultDate);

  const prefillCategory = isEdit ? editingTxn.category : (isCredit ? 'expense' : 'income');
  const prefillAmount = isEdit ? Math.abs(editingTxn.amount) : '';
  const prefillDirection = isEdit ? (editingTxn.amount<0 ? 'withdraw' : 'deposit') : (isCredit ? 'withdraw' : 'deposit');
  const prefillNote = isEdit ? (editingTxn.userNote != null ? editingTxn.userNote : editingTxn.note) : '';
  const prefillExpenseFound = (isEdit && editingTxn.category==='expense' && editingTxn.refId) ? findExpenseCategoryById(y, editingTxn.refId) : null;
  const prefillExpenseGroupId = prefillExpenseFound ? prefillExpenseFound.group.id : null;

  const transferLabel = isCredit
    ? '🔁 Pay bill (transfer from a bank)'
    : hasCreditDestination
      ? '🔁 Transfer between accounts (or pay a credit card bill)'
      : '🔁 Transfer between my own accounts';
  const expenseLabel = isCredit ? '🧾 Log a charge (raises what\u2019s owed)' : '🧾 Expense (adds to a spending category too)';
  const otherLabel = isCredit ? '📝 Set / correct the balance owed' : '📝 Other / balance correction';

  const overlay = document.createElement('div');
  overlay.id = 'addMoneyOverlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card" style="width:420px;">
      <h3>${isEdit ? '✎ Edit transaction' : '+ Add money'} — ${bank.name}</h3>
      <p class="modal-sub">${isEdit ? 'Saving re-applies this from scratch: the old effect on the balance and any linked income/expense/transfer is undone first, then these values are applied fresh.' : "Adds to this account's balance for the month you pick — on top of anything already there, never replacing it. Tag it Income/Expense and the linked source or category updates too."}</p>
      <div class="modal-field">
        <label>Amount (${bank.currency||'USD'})</label>
        <input type="number" id="amAmount" min="0" step="any" placeholder="0.00" value="${prefillAmount}">
      </div>
      <div class="modal-field" id="amDirectionWrap">
        <label>Direction</label>
        <select id="amDirection" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          <option value="deposit" ${prefillDirection==='deposit'?'selected':''}>Deposit (+)</option>
          <option value="withdraw" ${prefillDirection==='withdraw'?'selected':''}>Withdraw (−)</option>
        </select>
      </div>
      <div class="modal-field">
        <label>Date</label>
        <input type="date" id="amDate" value="${todayISO}">
      </div>
      <div class="modal-field">
        <label>Category</label>
        <select id="amCategory" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          <option value="income" ${prefillCategory==='income'?'selected':''}>💰 Income (adds to your Income tab too)</option>
          <option value="expense" ${prefillCategory==='expense'?'selected':''}>${expenseLabel}</option>
          <option value="transfer" ${prefillCategory==='transfer'?'selected':''}>${transferLabel}</option>
          <option value="other" ${prefillCategory==='other'?'selected':''}>${otherLabel}</option>
        </select>
      </div>
      <div class="modal-field" id="amIncomeSrcWrap">
        <label>Which income source? <span class="hint">uses the month from the date above</span></label>
        <select id="amIncomeSrc" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          ${incomeSources.map(s=>`<option value="${s.id}" ${isEdit && editingTxn.category==='income' && editingTxn.refId===s.id?'selected':''}>${s.name}</option>`).join('')}
          <option value="__new__">+ New income source…</option>
        </select>
      </div>
      <div class="modal-field" id="amNewIncomeNameWrap" style="display:none;">
        <label>New income source name</label>
        <input type="text" id="amNewIncomeName" placeholder="e.g. Paycheck, Freelance, Side gig…">
      </div>
      <div class="modal-field" id="amExpenseGroupWrap">
        <label>Which group?</label>
        <select id="amExpenseGroup" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          ${expenseGroups.map(g=>`<option value="${g.id}" ${prefillExpenseGroupId===g.id?'selected':''}>${g.name}</option>`).join('')}
          <option value="__newgroup__" ${expenseGroups.length?'':'selected'}>+ New group…</option>
        </select>
      </div>
      <div class="modal-field" id="amNewExpenseGroupNameWrap" style="display:${expenseGroups.length?'none':'block'};">
        <label>New group name</label>
        <input type="text" id="amNewExpenseGroupName" placeholder="e.g. Living Expenses, Wants…">
      </div>
      <div class="modal-field" id="amExpenseCatWrap">
        <label>Which category? <span class="hint">uses the month from the date above</span></label>
        <select id="amExpenseCat" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;"></select>
      </div>
      <div class="modal-field" id="amNewExpenseNameWrap" style="display:none;">
        <label>New category name</label>
        <input type="text" id="amNewExpenseName" placeholder="e.g. Groceries, Gas, Dining…">
      </div>
      <div class="modal-field" id="amTransferWrap">
        <label>Transfer with which account?</label>
        <select id="amTransferBank" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          ${otherAccounts.map(b=>`<option value="${b.id}" ${isEdit && editingTxn.category==='transfer' && editingTxn.transferPairBankId===b.id?'selected':''}>${b.name}${b.type==='credit'?' (credit card)':''}</option>`).join('')}
        </select>
        ${otherAccounts.length===0?'<div class="section-sub" style="margin-top:6px;">Add another bank or credit card first to transfer between accounts.</div>':''}
      </div>
      <div class="modal-field" id="amOtherModeWrap" style="display:none;">
        <label>How do you want to update this?</label>
        <select id="amOtherMode" style="width:100%; background:var(--bg); border:1px solid var(--line); color:var(--text); border-radius:8px; padding:9px 12px; font-family:var(--font-mono); font-size:13.5px;">
          <option value="additive">Add or withdraw an amount</option>
          <option value="set">Set the exact ${isCredit?'balance owed':'balance'} for this month</option>
        </select>
      </div>
      <div class="section-sub" id="amAmountHint" style="margin:-8px 0 14px; display:none;"></div>
      <div class="modal-field">
        <label>Note <span class="hint">optional</span></label>
        <input type="text" id="amNote" placeholder="e.g. Biweekly paycheck" value="${(prefillNote||'').replace(/"/g,'&quot;')}">
      </div>
      <div class="modal-actions">
        <button class="btn" id="amCancelBtn">Cancel</button>
        <button class="btn primary" id="amSaveBtn">${isEdit ? 'Save changes' : 'Add'}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const categorySelect = overlay.querySelector('#amCategory');
  const directionWrap = overlay.querySelector('#amDirectionWrap');
  const directionSelect = overlay.querySelector('#amDirection');
  const incomeSrcWrap = overlay.querySelector('#amIncomeSrcWrap');
  const incomeSrcSelect = overlay.querySelector('#amIncomeSrc');
  const newIncomeNameWrap = overlay.querySelector('#amNewIncomeNameWrap');
  const expenseGroupWrap = overlay.querySelector('#amExpenseGroupWrap');
  const expenseGroupSelect = overlay.querySelector('#amExpenseGroup');
  const newExpenseGroupNameWrap = overlay.querySelector('#amNewExpenseGroupNameWrap');
  const expenseCatWrap = overlay.querySelector('#amExpenseCatWrap');
  const expenseCatSelect = overlay.querySelector('#amExpenseCat');
  const newExpenseNameWrap = overlay.querySelector('#amNewExpenseNameWrap');
  const transferWrap = overlay.querySelector('#amTransferWrap');
  const otherModeWrap = overlay.querySelector('#amOtherModeWrap');
  const otherModeSelect = overlay.querySelector('#amOtherMode');
  const amountHint = overlay.querySelector('#amAmountHint');

  // ---- Cascading group → category dropdown ----
  function populateCatSelect(groupId){
    if(groupId==='__newgroup__'){
      expenseCatSelect.innerHTML = `<option value="__new__">+ New category…</option>`;
      return;
    }
    const group = expenseGroups.find(g=>g.id===groupId);
    const cats = group ? (group.categories||[]) : [];
    expenseCatSelect.innerHTML = cats.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')
      + `<option value="__new__">+ New category…</option>`;
  }
  populateCatSelect(expenseGroupSelect.value);
  if(isEdit && editingTxn.category==='expense' && editingTxn.refId){
    expenseCatSelect.value = editingTxn.refId;
  }
  expenseGroupSelect.addEventListener('change', ()=>{ populateCatSelect(expenseGroupSelect.value); syncVisibility(); });

  // ---- Direction: relabel + smart default per category, unless the user has manually touched it
  //      (or we're editing, where the prefilled direction should win over any smart default) ----
  let directionTouched = isEdit;
  directionSelect.addEventListener('change', ()=>{ directionTouched = true; });
  function updateDirectionForCategory(cat){
    let depositLabel = 'Deposit (+)', withdrawLabel = 'Withdraw (−)', defaultDir = 'deposit';
    if(cat==='expense'){ depositLabel = 'Refund received (+)'; withdrawLabel = 'Purchase / spent (−)'; defaultDir = 'withdraw'; }
    else if(cat==='transfer'){ depositLabel = 'Received from the other account (+)'; withdrawLabel = 'Sent to the other account (−)'; defaultDir = 'withdraw'; }
    else if(cat==='income'){ depositLabel = 'Received (+)'; withdrawLabel = 'Correction (−)'; defaultDir = 'deposit'; }
    directionSelect.options[0].textContent = depositLabel;
    directionSelect.options[1].textContent = withdrawLabel;
    if(!directionTouched) directionSelect.value = defaultDir;
  }

  function syncVisibility(){
    const cat = categorySelect.value;
    incomeSrcWrap.style.display = cat==='income' ? 'block' : 'none';
    newIncomeNameWrap.style.display = (cat==='income' && incomeSrcSelect.value==='__new__') ? 'block' : 'none';

    expenseGroupWrap.style.display = cat==='expense' ? 'block' : 'none';
    expenseCatWrap.style.display = cat==='expense' ? 'block' : 'none';
    const addingNewGroup = cat==='expense' && expenseGroupSelect.value==='__newgroup__';
    newExpenseGroupNameWrap.style.display = addingNewGroup ? 'block' : 'none';
    newExpenseNameWrap.style.display = (cat==='expense' && expenseCatSelect.value==='__new__') ? 'block' : 'none';

    transferWrap.style.display = cat==='transfer' ? 'block' : 'none';

    otherModeWrap.style.display = cat==='other' ? 'block' : 'none';
    const setMode = cat==='other' && otherModeSelect.value==='set';
    directionWrap.style.display = setMode ? 'none' : 'block';
    amountHint.style.display = setMode ? 'block' : 'none';
    amountHint.textContent = setMode ? `Enter the exact ${isCredit?'amount you currently owe':'balance you currently have'} — this replaces this month's number instead of adding to it.` : '';

    updateDirectionForCategory(cat);
  }
  categorySelect.addEventListener('change', syncVisibility);
  incomeSrcSelect.addEventListener('change', syncVisibility);
  expenseCatSelect.addEventListener('change', syncVisibility);
  otherModeSelect.addEventListener('change', syncVisibility);
  syncVisibility();

  function close(){ overlay.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e){ if(e.key==='Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#amCancelBtn').addEventListener('click', close);

  overlay.querySelector('#amSaveBtn').addEventListener('click', ()=>{
    const category = categorySelect.value;
    const isSetMode = category==='other' && otherModeSelect.value==='set';

    const amountInp = overlay.querySelector('#amAmount');
    let amount = parseFloat(amountInp.value);
    if(isNaN(amount) || amount<0 || (!isSetMode && amount===0)){ amountInp.focus(); return; }
    const rawAmountEntered = amount; // unsigned, as typed — used directly by "set exact balance" mode
    const direction = directionSelect.value;
    if(!isSetMode && direction==='withdraw') amount = -amount;

    const dateStr = overlay.querySelector('#amDate').value;
    if(!dateStr){ overlay.querySelector('#amDate').focus(); return; }
    const monthIdx = parseLocalDateParts(dateStr).monthIdx;
    const note = overlay.querySelector('#amNote').value.trim();

    if(category==='transfer' && otherAccounts.length===0){
      showToast('Add another bank or credit card first to transfer between accounts.');
      return;
    }

    // If editing, undo the old transaction's effects now — every validation
    // above has already passed, so we never destroy the old entry on a form
    // that's about to fail. The rest of this handler then runs exactly as it
    // would for a brand-new "Add money," creating the replacement.
    if(editingTxn){
      reverseTransactionEffects(bank, y, editingTxn);
      bank.transactions = (bank.transactions||[]).filter(t=>t.id!==editingTxn.id);
    }

    // 1. This account's balance. Normally ADDS to whatever's already there for
    //    that month; "set exact balance" mode replaces it instead, and the
    //    resulting delta is what actually gets stored on the transaction log
    //    (so deleting it later still reverses it correctly either way).
    if(!bank.m) bank.m = n12();
    // An explicit value already sitting in THIS month (e.g. typed into the
    // Advanced table) always wins. Otherwise: credit cards always carry the
    // real owed balance forward (debt doesn't reset itself); cash only
    // carries an earlier month's balance in if this account actually has a
    // transaction log to justify it — otherwise cash starts from $0.
    const prevBankVal = accountCarryValueAt(bank, monthIdx);
    let bankDelta;
    if(isSetMode){
      const newVal = isCredit ? -Math.abs(rawAmountEntered) : Math.abs(rawAmountEntered);
      bankDelta = roundCents(newVal - prevBankVal);
      bank.m[monthIdx] = newVal;
    } else {
      bankDelta = amount;
      bank.m[monthIdx] = roundCents(prevBankVal + amount);
    }
    bank.lastUpdatedAt = Date.now();

    let refType = null, refId = null, refDelta = null, linkedName = null;
    let transferBankId = null, transferPairTxnId = null, finalNote = note;

    // 2. If tagged Income, ADD to that income source's month too, extending its
    //    hover breakdown chain (e.g. "1000+200" → "1000+200+1000") instead of
    //    wiping it, so the newest top-up is visible on hover just like manual edits.
    if(category==='income' && amount>0){
      let srcId = incomeSrcSelect.value;
      const incomeList = yearData(y).income;
      if(srcId==='__new__'){
        const newName = overlay.querySelector('#amNewIncomeName').value.trim();
        if(!newName){ overlay.querySelector('#amNewIncomeName').focus(); return; }
        const newSrc = {id:uid(), name:newName, m:n12(), raw:n12()};
        incomeList.push(newSrc);
        srcId = newSrc.id;
        linkedName = newName;
      }
      const src = incomeList.find(s=>s.id===srcId);
      if(src){
        if(!src.raw) src.raw = n12();
        const prevVal = num(src.m[monthIdx]);
        src.m[monthIdx] = roundCents(prevVal + amount);
        src.raw[monthIdx] = appendAdditiveTerm(src.raw[monthIdx], prevVal, amount);
        refType = 'income'; refId = srcId; refDelta = amount;
        linkedName = linkedName || src.name;
      }
    }

    // 3. If tagged Expense, ADD (or, on a refund, subtract) from that category's
    //    month too — same breakdown-chain treatment on a genuine purchase.
    if(category==='expense'){
      let groupId = expenseGroupSelect.value;
      let groups = yearData(y).expenseGroups;
      if(!groups) groups = yearData(y).expenseGroups = [];
      if(groupId==='__newgroup__'){
        const newGroupName = overlay.querySelector('#amNewExpenseGroupName').value.trim();
        if(!newGroupName){ overlay.querySelector('#amNewExpenseGroupName').focus(); return; }
        const newGroup = {id:uid(), name:newGroupName, categories:[], excludeFromTotal:/credit card/i.test(newGroupName)};
        groups.push(newGroup);
        groupId = newGroup.id;
      }
      const group = groups.find(g=>g.id===groupId);
      let catId = expenseCatSelect.value;
      if(catId==='__new__'){
        const newCatName = overlay.querySelector('#amNewExpenseName').value.trim();
        if(!newCatName){ overlay.querySelector('#amNewExpenseName').focus(); return; }
        const newCat = {id:uid(), name:newCatName, m:n12(), raw:n12(), notes:''};
        group.categories.push(newCat);
        catId = newCat.id;
        linkedName = newCatName;
      }
      const found = findExpenseCategoryById(y, catId);
      if(found){
        const cat = found.cat;
        if(!cat.m) cat.m = n12();
        if(!cat.raw) cat.raw = n12();
        const prevVal = num(cat.m[monthIdx]);
        // Purchase/withdraw (amount<0) adds spend. Refund/deposit (amount>0) removes spend.
        const delta = amount<0 ? Math.abs(amount) : -Math.abs(amount);
        cat.m[monthIdx] = roundCents(prevVal + delta);
        cat.raw[monthIdx] = delta>0 ? appendAdditiveTerm(cat.raw[monthIdx], prevVal, delta) : null;
        refType = 'expense'; refId = catId; refDelta = delta;
        linkedName = linkedName || cat.name;
      }
    }

    // 4. If tagged Transfer, apply the opposite delta to the other account,
    //    and log a mirrored transaction there so either side can be deleted cleanly.
    const txnId = uid();
    if(category==='transfer'){
      transferBankId = overlay.querySelector('#amTransferBank').value;
      const otherBank = otherAccounts.find(b=>b.id===transferBankId);
      if(otherBank){
        if(!otherBank.m) otherBank.m = n12();
        otherBank.m[monthIdx] = roundCents(num(otherBank.m[monthIdx]) - amount);
        otherBank.lastUpdatedAt = Date.now();
        transferPairTxnId = uid();
        if(!otherBank.transactions) otherBank.transactions = [];
        otherBank.transactions.push({
          id: transferPairTxnId, date: dateStr, amount: -amount, category:'transfer',
          note: (note?note+' · ':'') + 'Transfer '+(amount>=0?'from ':'to ')+bank.name, userNote: note,
          monthIdx, transferPairBankId: bank.id, transferPairTxnId: txnId
        });
        finalNote = (note?note+' · ':'') + 'Transfer '+(amount>=0?'from ':'to ')+otherBank.name;
        linkedName = otherBank.name;
      }
    }

    // 5. Transaction log, for the history list in the detail view (with an ✕ to undo it later).
    //    `amount` here is the actual delta applied to THIS account's balance —
    //    bankDelta for a normal add/withdraw/transfer, or the computed jump for "set exact balance".
    if(!bank.transactions) bank.transactions = [];
    bank.transactions.push({
      id: txnId, date: dateStr, amount: bankDelta, category, note: finalNote, userNote: note, monthIdx,
      refType, refId, refDelta, transferPairBankId: transferBankId||null, transferPairTxnId: transferPairTxnId||null
    });

    markDirty('cashflow', {tab:'cashflow', action: isEdit?'edit':'add', target:(isCredit?'Credit card ':'Bank ')+bank.name+(isSetMode?' — balance set':' — '+(amount>=0?'deposit':'withdrawal'))+(isEdit?' (edited)':''),
      field:MONTHS[monthIdx], newVal: isSetMode ? bank.m[monthIdx] : (amount>=0?'+':'')+amount.toFixed(2) + (linkedName?' → '+category+': '+linkedName:'')});
    close();
    renderCashFlow();

    if(isSetMode){
      showToast(bank.name+' '+(isCredit?'owed balance set to '+fmt$(Math.abs(bank.m[monthIdx]),2):'balance set to '+fmt$(bank.m[monthIdx],2)));
    } else if(isEdit){
      showToast('Transaction updated — '+bank.name+' now '+(amount>=0?'+':'')+fmt$(Math.abs(amount),2)+(linkedName && category!=='transfer'?' · '+(category==='income'?'to '+linkedName+' income':'under '+linkedName):''));
    } else {
      showToast((amount>=0?'+':'')+fmt$(Math.abs(amount),2)+' '+(amount>=0?'added to':'withdrawn from')+' '+bank.name+(linkedName && category!=='transfer'?' · '+(category==='income'?'added to '+linkedName+' income':'logged under '+linkedName):''));
    }
    if(isEdit) openBankDetailModal(bank, y, monthIdx); // return to the transaction list, refreshed
  });

  overlay.querySelector('#amAmount').focus();
}
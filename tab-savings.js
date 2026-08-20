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

function renderSavings(){
  const y = state.year;
  ensureSavingsMigration();
  const accounts = yearData(y).savingsAccounts;

  const latestDataMonth = findLatestMonthWithData(y);
  const selectedMonthIndex = state.month === 'ALL' ? latestDataMonth : Number(state.month);
  const activeMonthIdx = Number.isInteger(selectedMonthIndex) ? selectedMonthIndex : latestDataMonth;
  const balAt = (acc, i)=> num((acc.m||[])[i]);

  const totalSavedLatest = accounts.reduce((a,acc)=>a+balAt(acc, activeMonthIdx>=0?activeMonthIdx:0),0);
  const totalAnnualInterest = accounts.reduce((a,acc)=>a + savingsBalanceForInterest(acc, activeMonthIdx>=0?activeMonthIdx:0) * (num(acc.interestRate)/100), 0);
  const avgRate = accounts.length ? (accounts.reduce((a,acc)=>a+num(acc.interestRate),0)/accounts.length) : 0;

  const scopeLabel = state.month === 'ALL' ? 'Full Year' : MONTHS[activeMonthIdx];

  /* ---- Savings accounts — month by month table ---- */
  const rows = accounts.map(acc=>{
    const cells = MONTHS.map((_,i)=>{
      const v = (acc.m||[])[i];
      const val = v===null||v===undefined ? '' : v;
      return `<td class="editable ${!val?'zero':''}" contenteditable="true" data-sfield="m" data-sid="${acc.id}" data-idx="${i}">${val===''?'–':val}</td>`;
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

  const html = `
    <div class="section-title">Savings · ${y}</div>
    <p class="section-sub">Track your savings accounts month by month, along with each account's interest rate. Every balance cell is editable — type over it to correct a month.</p>

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
  document.getElementById('panel-savings').innerHTML = html;

  /* ---- Balance cell handlers ---- */
  document.querySelectorAll('#savingsBody [data-sfield="m"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const acc = accounts.find(x=>x.id===td.dataset.sid);
      if(!acc) return;
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : parseFloat(raw);
      if(isNaN(v)) v = null;
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
      let v = parseFloat(raw);
      if(isNaN(v) || v<0) v = 0;
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
  document.getElementById('addSavingsBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newSavingsName');
    const name = inp.value.trim();
    const rateInp = document.getElementById('newSavingsRate');
    const rate = parseFloat(rateInp.value) || 0;
    const currency = document.getElementById('newSavingsCurrency').value;
    if(!name){ inp.focus(); return; }
    accounts.push({id:uid(), name, m:n12(), interestRate:rate, currency});
    markDirty('savings', {tab:'savings', action:'add', target:'Savings '+name});
    renderSavings();
  });
}
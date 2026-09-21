/* =========================================================================
   RECURRING TAB
   ========================================================================= */
/* A dedicated home for every recurring buy across every platform — this used
   to be buried as a sub-view you had to know to click inside Holdings
   (state.holdingsSubView === 'recurring'). Same underlying data and the same
   edit/remove/confirm actions — collectRecurringRows(), openRecurringModal(),
   openConfirmBuyModal() are all shared with tab-holdings.js, not duplicated
   here, so a plan you edit from either tab stays in sync automatically. */

function renderRecurring(){
  const y = state.year;
  const investments = yearData(y).investments || [];
  const recurringRows = collectRecurringRows(y, null); // null = every platform, already sorted by next date

  const nextUpcoming = recurringRows[0] || null;
  const activeCount = recurringRows.length;
  const platformCount = new Set(recurringRows.map(r=>r.platformId)).size;

  // Rough "per month" total — daysOfMonth/monthly/quarterly plans count once
  // (quarterly divided by 3), weekly ~4.33x, biweekly ~2.17x. It's an
  // estimate for the KPI card, not used for any real funding math below.
  const fx = (typeof _ensureFx === 'function' ? _ensureFx().INR : null) || 95.0;
  const monthlyEstimateUsd = sumArr(recurringRows.map(r=>{
    const inv = investments.find(i=>i.id===r.platformId);
    const isINR = inv && inv.currency==='INR';
    const usd = isINR ? r.amount/fx : r.amount;
    const norm = (inv && inv.holdings.find(h=>h.id===r.holdingId) || {}).recurring;
    const freq = norm ? (norm.frequencyType || (norm.daysOfMonth?.length ? 'daysOfMonth' : 'monthly')) : 'monthly';
    if(freq==='weekly') return usd*4.33;
    if(freq==='biweekly') return usd*2.17;
    if(freq==='quarterly') return usd/3;
    if(freq==='daysOfMonth') return usd*(norm.daysOfMonth?.length||1);
    return usd; // monthly
  }));

  // Funding check per row — is there enough sitting in the linked account,
  // in the investment's own currency, right now? Same account snapshot used
  // everywhere else in the app (currentSnapshotMonth), same cross-currency
  // conversion (convertCurrency) used for the Add Money modal's linking.
  const cashSnapIdx = currentSnapshotMonth(y);
  const fundingHtml = (r)=>{
    if(!r.bankAccountId){
      return `<span style="color:var(--text-dim); font-size:11.5px;">— not linked —</span>`;
    }
    const bank = (yearData(y).banks||[]).find(b=>b.id===r.bankAccountId);
    if(!bank) return `<span style="color:var(--text-dim); font-size:11.5px;">account not found</span>`;
    const inv = investments.find(i=>i.id===r.platformId);
    const investCurrency = (inv && inv.currency) || 'USD';
    const available = accountDisplayValueAt(bank, cashSnapIdx) || 0;
    const neededInBankCurrency = convertCurrency(r.amount, investCurrency, bank.currency, y, cashSnapIdx);
    const ok = available >= neededInBankCurrency;
    const shortBy = neededInBankCurrency - available;
    return `<div style="font-size:11.5px;">
      <div>${bank.name}</div>
      <div style="color:${ok?'var(--good)':'var(--rust-soft)'}; font-weight:600;">
        ${ok ? '✅ Ready' : `⚠ Short ${fmtNative(shortBy, bank.currency)}`}
      </div>
    </div>`;
  };

  const html = `
    <div class="section-title">Recurring · ${y}</div>
    <p class="section-sub">Every scheduled recurring buy across every platform, in one place — a tracker, not an auto-trader. Add or change one from here, or from 🔁 on a holding in the Holdings tab; either way stays in sync.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-teal"><div class="kpi-label">Active Plans</div><div class="kpi-value">${activeCount}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Across Platforms</div><div class="kpi-value">${platformCount}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">~Per Month (USD)</div><div class="kpi-value">${fmt$(monthlyEstimateUsd,2)}</div></div>
      <div class="kpi-card c-gold"><div class="kpi-label">Next Up</div><div class="kpi-value" style="font-size:15px;">${nextUpcoming ? `${nextUpcoming.symbol} · ${nextUpcoming.nextDate}` : '—'}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>All recurring buys</h3></div>
      ${!recurringRows.length ? `
        <div class="section-sub" style="padding:24px 0; text-align:center;">
          No recurring plans yet. Go to <b style="color:var(--gold-soft);">Holdings</b>, open a position, and click 🔁 to set one up — it'll show up here automatically.
        </div>
      ` : `
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Platform</th><th>Holding</th><th>Amount / buy</th><th>Schedule</th><th>Funding</th><th>Next date</th><th>Est. shares</th><th></th></tr></thead>
          <tbody>${recurringRows.map(r => `
            <tr>
              <td><span class="debt-tag" style="font-size:10px;">${r.platformName}</span></td>
              <td style="font-weight:600;">${r.symbol} ${r.name && r.name!==r.symbol ? `<span style="color:var(--text-dim); font-weight:400;">· ${r.name}</span>` : ''}</td>
              <td ${r.tAmount?`data-tip="${r.tAmount}" class="has-tip"`:''}>${r.dAmount}</td>
              <td><span class="debt-tag">${r.scheduleLabel}</span></td>
              <td>${fundingHtml(r)}</td>
              <td style="font-family:var(--font-mono); font-size:12px; color:var(--gold-soft); font-weight:600;">${r.nextDate||'—'}</td>
              <td style="font-family:var(--font-mono); font-size:12px;">${r.estShares.toFixed(4)}</td>
              <td style="white-space:nowrap;">${r.alreadyConfirmed
                ? `<span style="color:var(--teal-soft); font-family:var(--font-mono); font-size:11px; margin-right:8px;" title="Already confirmed for ${r.nextDate}">✓ Confirmed</span>`
                : `<span class="row-del" data-confirmbuy="${r.platformId}|${r.holdingId}|${r.nextDate}" title="Confirm this buy happened" style="margin-right:8px; cursor:pointer; color:var(--teal-soft);">✓ Confirm</span>`
              }<span class="row-del" data-editrecur="${r.platformId}|${r.holdingId}" title="Edit" style="margin-right:8px; cursor:pointer;">✏️</span><span class="row-del" data-removerecur="${r.platformId}|${r.holdingId}" title="Remove">✕</span></td>
            </tr>
          `).join('')}</tbody>
        </table>
      </div>
      `}
    </div>
  `;
  document.getElementById('panel-recurring').innerHTML = html;

  /* ---- Wiring — identical actions to Holdings' recurring sub-view ---- */
  function _findRecurHolding(key){
    const [platformId, holdingId] = key.split('|');
    const inv2 = investments.find(i => i.id === platformId);
    return inv2 ? inv2.holdings.find(x => x.id === holdingId) : null;
  }
  document.querySelectorAll('[data-editrecur]').forEach(el => el.addEventListener('click', ()=>{
    const h = _findRecurHolding(el.dataset.editrecur);
    if(!h) return;
    openRecurringModal(h, y,
      (config) => {
        h.recurring = { active: true, ...config };
        markDirty(); renderRecurring();
        showToast(`Recurring buy updated for ${h.symbol}`);
      },
      () => {
        h.recurring = null;
        markDirty(); renderRecurring();
        showToast(`Recurring buy removed for ${h.symbol}`);
      }
    );
  }));
  document.querySelectorAll('[data-removerecur]').forEach(el => el.addEventListener('click', ()=>{
    const h = _findRecurHolding(el.dataset.removerecur);
    if(!h) return;
    if(confirm(`Remove the recurring plan for ${h.symbol}?`)){
      h.recurring = null; markDirty(); renderRecurring();
    }
  }));
  document.querySelectorAll('[data-confirmbuy]').forEach(el => el.addEventListener('click', ()=>{
    const [platformId, holdingId, scheduledDate] = el.dataset.confirmbuy.split('|');
    const inv2 = investments.find(i => i.id === platformId);
    const h = inv2 && inv2.holdings.find(x => x.id === holdingId);
    if(!h) return;
    openConfirmBuyModal(h, scheduledDate, (qty, price, date) => {
      h.lots.push({id: uid(), type:'buy', qty, price, date});
      recalcHolding(h);
      if(h.recurring) h.recurring.lastConfirmedFor = scheduledDate;
      markDirty('holdings');
      renderRecurring();
      showToast(`Added ${qty.toFixed(4)} ${h.symbol} @ ${fmt$(price,2)} from recurring buy`);
    });
  }));
}
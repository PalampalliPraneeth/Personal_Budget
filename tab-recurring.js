/* =========================================================================
   RECURRING TAB
   ========================================================================= */
/* A dedicated home for every recurring buy across every platform — this used
   to be buried as a sub-view you had to know to click inside Holdings
   (state.holdingsSubView === 'recurring'). Same underlying data and the same
   edit/remove/confirm actions — collectRecurringRows(), openRecurringModal(),
   openConfirmBuyModal() are all shared with tab-holdings.js, not duplicated
   here, so a plan you edit from either tab stays in sync automatically. */

/* Next N occurrence dates for one plan (not just the single next one) —
   same per-frequency logic as tab-holdings.js's nextRecurringDateForPlan(),
   just continuing past each date found instead of stopping at the first. */
function nextNOccurrences(norm, count){
  const dates = [];
  const today = new Date(); today.setHours(0,0,0,0);

  if(norm.frequencyType === 'daysOfMonth'){
    if(!norm.daysOfMonth || !norm.daysOfMonth.length) return dates;
    const sorted = [...norm.daysOfMonth].sort((a,b)=>a-b);
    for(let i=0; i<36 && dates.length<count; i++){
      const y = today.getFullYear(), m = today.getMonth()+i;
      for(const d of sorted){
        if(dates.length>=count) break;
        const day = _clampDayOfMonth(d, y, m);
        const candidate = new Date(y, m, day); candidate.setHours(0,0,0,0);
        if(candidate >= today) dates.push(toLocalISODate(candidate));
      }
    }
    return dates;
  }
  if(!norm.startDate) return dates;
  const start = new Date(norm.startDate+'T00:00:00'); start.setHours(0,0,0,0);

  if(norm.frequencyType === 'monthly' || norm.frequencyType === 'quarterly'){
    const monthStep = norm.frequencyType==='quarterly' ? 3 : 1;
    const anchorDay = start.getDate();
    for(let k=0; k<1000 && dates.length<count; k++){
      const y = start.getFullYear(), m = start.getMonth()+k*monthStep;
      const day = _clampDayOfMonth(anchorDay, y, m);
      const candidate = new Date(y, m, day); candidate.setHours(0,0,0,0);
      if(candidate >= today) dates.push(toLocalISODate(candidate));
    }
    return dates;
  }
  const stepDays = norm.frequencyType==='weekly' ? 7 : norm.frequencyType==='biweekly' ? 14 : 1;
  let cursor = new Date(start);
  if(cursor < today){
    const diffDays = Math.floor((today-cursor)/86400000);
    const steps = Math.ceil(diffDays/stepDays);
    cursor.setDate(cursor.getDate()+steps*stepDays);
  }
  while(dates.length<count){
    dates.push(toLocalISODate(cursor));
    cursor = new Date(cursor); cursor.setDate(cursor.getDate()+stepDays);
  }
  return dates;
}

function renderRecurring(){
  const y = state.year;
  const investments = yearData(y).investments || [];
  const recurringRows = collectRecurringRows(y, null); // null = every platform, already sorted by next date

  const nextUpcoming = recurringRows[0] || null;
  const activeCount = recurringRows.length;
  const platformCount = new Set(recurringRows.map(r=>r.platformId)).size;
  const fx = (typeof _ensureFx === 'function' ? _ensureFx().INR : null) || 95.0;

  // Rough "per month" total — daysOfMonth/monthly/quarterly plans count once
  // (quarterly divided by 3), weekly ~4.33x, biweekly ~2.17x. It's an
  // estimate for the KPI card, not used for any real funding math below.
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
  function fundingCheck(r){
    if(!r.bankAccountId) return { bank:null, ok:null };
    const bank = (yearData(y).banks||[]).find(b=>b.id===r.bankAccountId);
    if(!bank) return { bank:null, ok:null };
    const inv = investments.find(i=>i.id===r.platformId);
    const investCurrency = (inv && inv.currency) || 'USD';
    const available = accountDisplayValueAt(bank, cashSnapIdx) || 0;
    const neededInBankCurrency = convertCurrency(r.amount, investCurrency, bank.currency, y, cashSnapIdx);
    return { bank, ok: available>=neededInBankCurrency, available, needed: neededInBankCurrency, shortBy: neededInBankCurrency-available };
  }
  const fundingHtml = (r)=>{
    const fc = fundingCheck(r);
    if(!r.bankAccountId) return `<span style="color:var(--text-dim); font-size:11.5px;">— not linked —</span>`;
    if(!fc.bank) return `<span style="color:var(--text-dim); font-size:11.5px;">account not found</span>`;
    return `<div style="font-size:11.5px;">
      <div>${fc.bank.name}</div>
      <div style="color:${fc.ok?'var(--good)':'var(--rust-soft)'}; font-weight:600;">
        ${fc.ok ? '✅ Ready' : `⚠ Short ${fmtNative(fc.shortBy, fc.bank.currency)}`}
      </div>
    </div>`;
  };

  /* ---- Next 3 upcoming DATES (not events) — every stock due on each of
     the next 3 distinct calendar days, grouped together. Funding is
     checked PER DATE PER BANK, not per stock: if two buys the same day
     both draw from Wells Fargo, they're competing for the same balance,
     so checking each one individually against the full balance would
     understate the real shortfall. ---- */
  const dateMap = {}; // date -> [entries]
  recurringRows.forEach(r=>{
    const inv = investments.find(i=>i.id===r.platformId);
    const h = inv && inv.holdings.find(x=>x.id===r.holdingId);
    if(!h || !h.recurring) return;
    const norm = _normalizedRecurring(h.recurring);
    nextNOccurrences(norm, 6).forEach(date=>{
      if(!dateMap[date]) dateMap[date] = [];
      dateMap[date].push(r);
    });
  });
  const next3Dates = Object.keys(dateMap).sort().slice(0,3);

  function fundingSummaryForDate(entries){
    // Group by bank, summing what's actually needed from each one that day.
    const byBank = new Map(); // bankId -> {bank, neededNative}
    const unlinked = [];
    entries.forEach(r=>{
      if(!r.bankAccountId){ unlinked.push(r); return; }
      const bank = (yearData(y).banks||[]).find(b=>b.id===r.bankAccountId);
      if(!bank){ unlinked.push(r); return; }
      const inv = investments.find(i=>i.id===r.platformId);
      const investCurrency = (inv && inv.currency) || 'USD';
      const neededInBankCurrency = convertCurrency(r.amount, investCurrency, bank.currency, y, cashSnapIdx);
      if(!byBank.has(bank.id)) byBank.set(bank.id, {bank, neededNative:0});
      byBank.get(bank.id).neededNative += neededInBankCurrency;
    });
    const lines = Array.from(byBank.values()).map(({bank, neededNative})=>{
      const available = accountDisplayValueAt(bank, cashSnapIdx) || 0;
      const ok = available >= neededNative;
      return `<div style="font-size:11.5px; margin-top:2px;">
        <b>${bank.name}</b> needs ${fmtNative(neededNative, bank.currency)} total ·
        <span style="color:${ok?'var(--good)':'var(--rust-soft)'}; font-weight:600;">
          ${ok ? '✅ has enough' : `⚠ short ${fmtNative(neededNative-available, bank.currency)}`}
        </span>
      </div>`;
    });
    if(unlinked.length) lines.push(`<div style="font-size:11.5px; color:var(--text-dim); margin-top:2px;">${unlinked.length} with no funding account linked</div>`);
    return lines.join('');
  }

  /* ---- This month's recurring investment mix, by platform — every
     occurrence (not just each plan's next one) that lands within the
     current calendar month, summed in USD and grouped by platform. This
     is "where is more of my money actually going this month", not just a
     snapshot of one buy per platform. ---- */
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth()+1, 1);
  const monthStartIso = toLocalISODate(monthStart), monthEndIso = toLocalISODate(monthEnd);
  const platformMonthTotals = {};
  recurringRows.forEach(r=>{
    const inv = investments.find(i=>i.id===r.platformId);
    const h = inv && inv.holdings.find(x=>x.id===r.holdingId);
    if(!h || !h.recurring) return;
    const norm = _normalizedRecurring(h.recurring);
    const isINR = inv.currency === 'INR';
    const usdAmount = isINR ? r.amount/fx : r.amount;
    // Enough lookahead to safely cover a month even for a quarterly plan lurking just past it.
    nextNOccurrences(norm, 40).forEach(date=>{
      if(date >= monthStartIso && date < monthEndIso){
        platformMonthTotals[r.platformName] = (platformMonthTotals[r.platformName]||0) + usdAmount;
      }
    });
  });
  const monthAllocSorted = Object.entries(platformMonthTotals).sort((a,b)=>b[1]-a[1]);
  const monthAllocLabels = monthAllocSorted.map(e=>e[0]);
  const monthAllocVals = monthAllocSorted.map(e=>e[1]);
  const monthAllocTotal = sumArr(monthAllocVals);
  const monthName = now.toLocaleDateString('en-US',{month:'long'});

  const html = `
    <div class="section-title">Recurring · ${y}</div>
    <p class="section-sub">Every scheduled recurring buy across every platform, in one place — a tracker, not an auto-trader. Add or change one from here, or from 🔁 on a holding in the Holdings tab; either way stays in sync.</p>

    <div class="card">
      <div class="card-head"><h3>${monthName} — where it's going</h3><span class="section-sub" style="margin:0;">Total: <b style="color:var(--gold-soft)">${fmt$(monthAllocTotal,2)}</b> across ${monthAllocLabels.length} platform${monthAllocLabels.length===1?'':'s'}</span></div>
      ${!monthAllocLabels.length ? `
        <div class="section-sub" style="padding:20px 0; text-align:center;">Nothing scheduled to land in ${monthName} yet.</div>
      ` : `<div class="chart-box" style="max-width:420px; margin:0 auto;"><canvas id="chartRecurMonthAlloc"></canvas></div>`}
    </div>

    <div class="card">
      <div class="card-head"><h3>Next 3 upcoming days</h3></div>
      ${!next3Dates.length ? `
        <div class="section-sub" style="padding:20px 0; text-align:center;">No upcoming buys scheduled.</div>
      ` : `
      <div style="display:flex; flex-direction:column; gap:16px;">
        ${next3Dates.map(date=>{
          const entries = dateMap[date];
          const dayTotalsByCurrency = {};
          entries.forEach(r=>{
            const inv = investments.find(i=>i.id===r.platformId);
            const cur = (inv && inv.currency) || 'USD';
            dayTotalsByCurrency[cur] = (dayTotalsByCurrency[cur]||0) + r.amount;
          });
          const totalStr = Object.entries(dayTotalsByCurrency).map(([cur,amt])=>fmtNative(amt,cur)).join(' + ');
          const prettyDate = new Date(date+'T00:00:00').toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'});

          // Group this date's buys by platform, so 2+ platforms on the same
          // day read as clearly separate blocks with their own subtotal,
          // instead of one flat list where the platform name is buried.
          const byPlatform = new Map();
          entries.forEach(r=>{
            if(!byPlatform.has(r.platformId)) byPlatform.set(r.platformId, {name:r.platformName, platformId:r.platformId, rows:[]});
            byPlatform.get(r.platformId).rows.push(r);
          });

          const platformBlocks = Array.from(byPlatform.values()).map(p=>{
            const inv = investments.find(i=>i.id===p.platformId);
            const cur = (inv && inv.currency) || 'USD';
            const platformTotal = sumArr(p.rows.map(r=>r.amount));
            return `
            <div style="padding:9px 12px; background:var(--bg); border-radius:8px;">
              <div style="display:flex; justify-content:space-between; align-items:baseline;">
                <span style="font-weight:600; color:var(--gold-soft); font-size:13px;">${p.name}</span>
                <span style="font-size:12px; color:var(--text-dim);">${fmtNative(platformTotal,cur)} needed</span>
              </div>
              <div style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
                ${p.rows.map(r=>`
                  <div style="display:flex; justify-content:space-between; font-size:12.5px; color:var(--text);">
                    <span>${r.symbol}</span>
                    <span ${r.tAmount?`data-tip="${r.tAmount}" class="has-tip"`:''}>${r.dAmount}</span>
                  </div>
                `).join('')}
              </div>
            </div>`;
          }).join('');

          return `
          <div style="background:var(--bg-card-hi); border-radius:12px; padding:14px 16px;">
            <div style="display:flex; justify-content:space-between; align-items:baseline; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
              <div style="font-size:15px; font-weight:600; color:var(--text);">${prettyDate}</div>
              <div style="font-size:12px; color:var(--text-dim);">${entries.length} buy${entries.length===1?'':'s'} · <b style="color:var(--gold-soft);">${totalStr}</b> total</div>
            </div>
            <div style="display:flex; flex-direction:column; gap:8px;">
              ${platformBlocks}
            </div>
            <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--line-soft);">
              ${fundingSummaryForDate(entries)}
            </div>
          </div>`;
        }).join('')}
      </div>
      `}
    </div>

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

  /* ---- Chart: this month's allocation by platform ---- */
  destroyChart('recurMonthAlloc');
  if(monthAllocLabels.length){
    charts.recurMonthAlloc = safeChart(document.getElementById('chartRecurMonthAlloc'), {
      type:'doughnut',
      data:{ labels:monthAllocLabels, datasets:[{data:monthAllocVals, backgroundColor:monthAllocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor:'#1C2726', borderWidth:2}] },
      options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
        plugins:{
          legend:{position:'right', labels:{boxWidth:9,boxHeight:9, font:{size:10.5}}},
          tooltip:{ callbacks:{ label:(ctx)=>{
            const val = ctx.raw;
            const pct = monthAllocTotal>0 ? ((val/monthAllocTotal)*100).toFixed(1) : 0;
            return `${ctx.label}: ${fmt$(val)} (${pct}%)`;
          }}}
        } }
    });
  }

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
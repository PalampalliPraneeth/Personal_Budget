/* =========================================================================
   ASSETS TAB
   ========================================================================= */
/* Things you own outright that aren't cash, a brokerage holding, or a
   retirement account — real estate, vehicles, jewelry, business equity,
   anything else. Deliberately separate from Investments: your Indian
   Stocks / US Stocks / Crypto are already tracked (and already counted
   toward net worth) over there, grouped by category exactly the same way
   this tab groups its own categories — nothing here duplicates that.

   An asset can optionally link to an existing Debt tab entry (e.g. a house
   linked to its mortgage) purely for DISPLAY — showing "Equity: $200k"
   instead of making you do that subtraction yourself. It changes nothing
   about the actual net worth math: the linked debt is already being
   subtracted via the normal debt total regardless of any link, so linking
   an asset to it doesn't double-count or need special-casing there. */

const ASSET_CATS = ['Real Estate','Vehicle','Jewelry','Business Equity','Other'];
function allAssetCategories(){
  if(!DATA.customAssetCategories) DATA.customAssetCategories = [];
  return ASSET_CATS.concat(DATA.customAssetCategories.filter(c=>!ASSET_CATS.includes(c)));
}

function ensureAssetsMigration(y){
  if(!yearData(y).assets) yearData(y).assets = [];
  const debts = yearData(y).debts || [];
  yearData(y).assets.forEach(a=>{
    if(!a.currency) a.currency = 'USD';
    if(a.currentValue===undefined || a.currentValue===null) a.currentValue = 0;
    if(a.purchasePrice===undefined) a.purchasePrice = null;
    if(a.purchaseDate===undefined) a.purchaseDate = null;
    if(a.linkedDebtId===undefined) a.linkedDebtId = null;
    // If the linked debt was deleted from the Debt tab since this was set,
    // clear the stale reference rather than silently pointing at nothing —
    // the dropdown already shows "— none —" in that case, so this just
    // makes the underlying data match what's actually displayed.
    if(a.linkedDebtId && !debts.find(d=>d.id===a.linkedDebtId)) a.linkedDebtId = null;
    if(!a.category) a.category = 'Other';
  });
}

function assetCurrentUsd(a, y, monthIdx){
  return nativeMonthToUsd(a.currentValue, a.currency, y, monthIdx);
}

function renderAssets(){
  const y = state.year;
  ensureAssetsMigration(y);
  const assets = [...yearData(y).assets].sort((a,b)=>{
    const cats = allAssetCategories();
    const ai = cats.indexOf(a.category), bi = cats.indexOf(b.category);
    return (ai===-1?99:ai) - (bi===-1?99:bi);
  });
  const debts = yearData(y).debts || [];
  const monthIdx = currentSnapshotMonth(y);

  const totalAssetsUsd = sumArr(assets.map(a=>assetCurrentUsd(a,y,monthIdx)));
  const linkedDebtUsd = sumArr(assets.filter(a=>a.linkedDebtId).map(a=>{
    const d = debts.find(x=>x.id===a.linkedDebtId);
    return d ? debtPendingCalc(d) : 0;
  }));
  const netEquityUsd = totalAssetsUsd - linkedDebtUsd;
  const gainableAssets = assets.filter(a=>a.purchasePrice!=null && a.purchasePrice>0);
  const totalGainUsd = sumArr(gainableAssets.map(a=>{
    const cv = assetCurrentUsd(a,y,monthIdx);
    const pv = nativeMonthToUsd(a.purchasePrice, a.currency, y, monthIdx);
    return cv - pv;
  }));

  /* ---- Allocation by category (same chart pattern as Investments) ---- */
  const alloc = {};
  assets.forEach(a=>{ alloc[a.category] = (alloc[a.category]||0) + assetCurrentUsd(a,y,monthIdx); });
  const allocSorted = Object.entries(alloc).sort((a,b)=>b[1]-a[1]);
  const allocLabels = allocSorted.map(e=>e[0]);
  const allocVals = allocSorted.map(e=>e[1]);

  let lastCat = null;
  const rows = assets.map(a=>{
    const catHeaderRow = a.category !== lastCat ? (()=>{
      lastCat = a.category;
      return `<tr><td colspan="9" style="background:var(--bg-card-hi); color:var(--gold-soft); font-family:var(--font-mono); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; padding:6px 10px;">${a.category}</td></tr>`;
    })() : '';

    const linkedDebt = a.linkedDebtId ? debts.find(d=>d.id===a.linkedDebtId) : null;
    const debtPendingUsd = linkedDebt ? debtPendingCalc(linkedDebt) : 0;
    const equityUsd = linkedDebt ? assetCurrentUsd(a,y,monthIdx) - debtPendingUsd : null;

    const hasCost = a.purchasePrice!=null && a.purchasePrice>0;
    const gainUsd = hasCost ? assetCurrentUsd(a,y,monthIdx) - nativeMonthToUsd(a.purchasePrice, a.currency, y, monthIdx) : null;

    return catHeaderRow + `<tr data-row-id="${a.id}">
      <td><span class="ledger-name-text editable-inline" contenteditable="true" data-field="name" data-id="${a.id}" title="${(a.name||'').replace(/"/g,'&quot;')}">${a.name}</span> <span class="row-del" data-delasset="${a.id}">✕</span></td>
      <td>
        <select data-catsel="${a.id}" style="background:var(--bg-card-hi); color:var(--gold-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11.5px; padding:3px 4px;">
          ${allAssetCategories().map(c => `<option value="${c}" ${a.category===c?'selected':''}>${c}</option>`).join('')}
          <option value="__new__">+ New category…</option>
        </select>
      </td>
      <td>
        <select data-currency="${a.id}" style="background:var(--bg-card-hi); color:var(--teal-soft); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11.5px; padding:3px 4px;">
          <option value="USD" ${a.currency==='USD'?'selected':''}>USD</option>
          <option value="INR" ${a.currency==='INR'?'selected':''}>INR</option>
        </select>
      </td>
      <td class="editable" contenteditable="true" data-field="currentValue" data-id="${a.id}">${fmtNative(a.currentValue, a.currency)}</td>
      <td class="editable" contenteditable="true" data-field="purchasePrice" data-id="${a.id}">${hasCost ? fmtNative(a.purchasePrice, a.currency) : '–'}</td>
      <td style="${gainUsd===null?'':'color:'+(gainUsd>=0?'var(--good)':'var(--danger)')+';font-weight:600;'}">${gainUsd===null?'–':(gainUsd>=0?'+':'')+fmt$(gainUsd,2)}</td>
      <td>
        <select data-linkdebt="${a.id}" style="background:var(--bg-card-hi); color:var(--text); border:1px solid var(--line); border-radius:5px; font-family:var(--font-mono); font-size:11px; padding:3px 4px; max-width:150px;">
          <option value="">— none —</option>
          ${debts.map(d=>`<option value="${d.id}" ${a.linkedDebtId===d.id?'selected':''}>${d.name}</option>`).join('')}
        </select>
      </td>
      <td style="${equityUsd===null?'color:var(--text-dim);':'font-weight:600;'}">${equityUsd===null?'—':fmt$(equityUsd,2)}</td>
    </tr>`;
  }).join('');

  const html = `
    <div class="section-title">Assets · ${y}</div>
    <p class="section-sub">Real estate, vehicles, jewelry, business equity, anything else you own outright. Separate from Investments (your stocks/crypto are already tracked there) — this is everything else that counts toward net worth.</p>

    <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
      <div class="kpi-card c-gold"><div class="kpi-label">Total Assets (USD)</div><div class="kpi-value">${fmt$(totalAssetsUsd,2)}</div></div>
      <div class="kpi-card c-danger"><div class="kpi-label">Linked Debt (USD)</div><div class="kpi-value">${fmt$(linkedDebtUsd,2)}</div></div>
      <div class="kpi-card c-teal"><div class="kpi-label">Net Equity (USD)</div><div class="kpi-value">${fmt$(netEquityUsd,2)}</div></div>
      <div class="kpi-card ${totalGainUsd>=0?'c-teal':'c-danger'}"><div class="kpi-label">Gain / Loss (USD)</div><div class="kpi-value">${totalGainUsd>=0?'+':''}${fmt$(totalGainUsd,2)}</div></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Allocation by category (USD)</h3></div>
      <div class="chart-box" style="max-width:420px; margin:0 auto;"><canvas id="chartAssetAlloc"></canvas></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>All assets</h3></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Asset</th><th>Category</th><th>Currency</th><th>Current Value</th><th>Purchase Price</th><th>Gain/Loss</th><th>Linked Debt</th><th>Equity</th></tr></thead>
          <tbody id="assetsBody">${rows}
            <tr class="total-row"><td>Total</td><td></td><td></td><td>${fmt$(totalAssetsUsd,2)}</td><td></td><td style="${totalGainUsd>=0?'color:var(--good);':'color:var(--danger);'}">${totalGainUsd>=0?'+':''}${fmt$(totalGainUsd,2)}</td><td></td><td>${fmt$(netEquityUsd,2)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="addcat-row">
        <input type="text" id="newAssetName" placeholder="New asset name, e.g. House, Car…">
        <select id="newAssetCategory" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          ${allAssetCategories().map(c=>`<option value="${c}">${c}</option>`).join('')}
          <option value="__new__">+ New category…</option>
        </select>
        <select id="newAssetCurrency" style="background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:7px;padding:7px 10px;font-size:12.5px;">
          <option value="USD">USD</option>
          <option value="INR">INR</option>
        </select>
        <button class="btn primary small" id="addAssetBtn">+ Add asset</button>
      </div>
    </div>
  `;
  document.getElementById('panel-assets').innerHTML = html;

  /* ---- Handlers ---- */
  document.getElementById('assetsBody').querySelectorAll('td.editable').forEach(td=>{
    td.addEventListener('focus', ()=>{
      td.dataset.origRaw = td.textContent;
      if(td.textContent==='–') td.textContent = '';
    });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const id = td.dataset.id, field = td.dataset.field;
      const a = assets.find(x=>x.id===id);
      if(!a) return;
      const raw = td.textContent.trim().replace(/[$₹,]/g,'');
      const v = raw==='' ? null : evalExpr(raw);
      if(field==='currentValue'){
        a.currentValue = (v===null || isNaN(v)) ? 0 : Math.max(0, v);
      } else if(field==='purchasePrice'){
        a.purchasePrice = (v===null || isNaN(v) || v<=0) ? null : v;
      }
      markDirty('assets', {tab:'assets', action:'edit', target:a.name, field});
      renderAssets();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  document.getElementById('assetsBody').querySelectorAll('[data-field="name"]').forEach(el=>{
    el.addEventListener('focus', ()=>{ el.dataset.origRaw = el.textContent; });
    el.addEventListener('blur', ()=>{
      const a = assets.find(x=>x.id===el.dataset.id);
      const val = el.textContent.trim();
      if(!val){ el.textContent = a.name; return; }
      if(a.name===val) return;
      a.name = val;
      markDirty('assets', {tab:'assets', action:'edit', target:a.name, field:'name'});
      renderAssets();
    });
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
  });

  document.querySelectorAll('[data-delasset]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const realAssets = yearData(y).assets;
      const idx = realAssets.findIndex(x=>x.id===el.dataset.delasset);
      if(idx>-1 && confirm('Remove "'+realAssets[idx].name+'"?')){
        realAssets.splice(idx,1);
        markDirty('assets', {tab:'assets', action:'delete', target:realAssets[idx]?.name||'asset'});
        renderAssets();
      }
    });
  });

  document.querySelectorAll('[data-catsel]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const a = assets.find(x=>x.id===sel.dataset.catsel);
      if(sel.value==='__new__'){
        const name = prompt('New asset category name (e.g. Land, Art, Equipment)…');
        const trimmed = (name||'').trim();
        if(!trimmed){ renderAssets(); return; }
        if(!DATA.customAssetCategories) DATA.customAssetCategories = [];
        if(!allAssetCategories().includes(trimmed)) DATA.customAssetCategories.push(trimmed);
        a.category = trimmed;
      } else {
        a.category = sel.value;
      }
      markDirty('assets', {tab:'assets', action:'edit', target:a.name, field:'category'});
      renderAssets();
    });
  });

  document.querySelectorAll('[data-currency]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const a = assets.find(x=>x.id===sel.dataset.currency);
      a.currency = sel.value;
      markDirty('assets', {tab:'assets', action:'edit', target:a.name, field:'currency'});
      renderAssets();
    });
  });

  document.querySelectorAll('[data-linkdebt]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const a = assets.find(x=>x.id===sel.dataset.linkdebt);
      a.linkedDebtId = sel.value || null;
      markDirty('assets', {tab:'assets', action:'edit', target:a.name, field:'linkedDebtId'});
      renderAssets();
    });
  });

  document.getElementById('addAssetBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newAssetName');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    let category = document.getElementById('newAssetCategory').value;
    if(category==='__new__'){
      const newCat = prompt('New asset category name (e.g. Land, Art, Equipment)…');
      const trimmed = (newCat||'').trim();
      if(!trimmed) return;
      if(!DATA.customAssetCategories) DATA.customAssetCategories = [];
      if(!allAssetCategories().includes(trimmed)) DATA.customAssetCategories.push(trimmed);
      category = trimmed;
    }
    const currency = document.getElementById('newAssetCurrency').value;
    yearData(y).assets.push({id:uid(), name, category, currency, currentValue:0, purchasePrice:null, purchaseDate:null, linkedDebtId:null});
    markDirty('assets', {tab:'assets', action:'add', target:name});
    renderAssets();
  });

  /* ---- Chart ---- */
  destroyChart('assetAlloc');
  const allocTotal = allocVals.reduce((a,b)=>a+b,0);
  charts.assetAlloc = safeChart(document.getElementById('chartAssetAlloc'), {
    type:'doughnut',
    data:{ labels:allocLabels, datasets:[{data:allocVals, backgroundColor:allocLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor:'#1C2726', borderWidth:2}] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
      plugins:{
        legend:{position:'right', labels:{boxWidth:9,boxHeight:9, font:{size:10.5}}},
        tooltip:{ callbacks:{ label:(ctx)=>{
          const val = ctx.raw;
          const pct = allocTotal>0 ? ((val/allocTotal)*100).toFixed(1) : 0;
          return `${ctx.label}: ${fmt$(val)} (${pct}%)`;
        }}}
      } }
  });
}
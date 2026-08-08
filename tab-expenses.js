/* =========================================================================
   EXPENSES TAB
   ========================================================================= */
let collapsedGroups = {};
let expenseFullYearView = false;
let editingGroupId = null; // tracks which group name is being edited

function renderExpenses(){
  const y = state.year;
  const groups = yearData(y).expenseGroups;
  const debts = yearData(y).debts;
  const isMonthScope = state.month !== 'ALL';
  const showFullYear = expenseFullYearView || !isMonthScope;
  const monthsToShow = showFullYear ? [0,1,2,3,4,5,6,7,8,9,10,11] : [Number(state.month)];
  const scopeMonths = monthRange();

  const incNow = sumRange(incomeTotals(y), scopeMonths);
  const expNoCard = sumRange(expenseTotalsCounted(y), scopeMonths);
  const cardNow = sumRange(expenseTotalsExcluded(y), scopeMonths);
  const expWithCard = expNoCard + cardNow;
  const netAfterCard = incNow - expWithCard;
  const scopeLabel = state.month==='ALL' ? 'full year' : MONTHS[Number(state.month)];

  // Data for the pie chart (current scope only, excludes "counted out" groups)
  const pieGroups = groups
    .filter(g => !g.excludeFromTotal)
    .map(g => ({ name: g.name, total: sumRange(groupTotals(g), scopeMonths) }))
    .filter(g => g.total > 0)
    .sort((a,b) => b.total - a.total);
  const pieLabels = pieGroups.map(g => g.name);
  const pieVals   = pieGroups.map(g => g.total);

  const lastUpdated = yearData(y).expensesLastUpdated;

  let groupsHtml = groups.map((g, gi)=>{
    const totalsAll = groupTotals(g);
    const totalsShown = monthsToShow.map(i=>totalsAll[i]);
    const collapsed = collapsedGroups[g.id];
    const isEditing = editingGroupId === g.id;

    return `
    <div class="group-block ${collapsed?'collapsed':''}" data-group-id="${g.id}">
      <div class="group-head" data-toggle="${g.id}">
        <h4 style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span class="g-caret">▾</span>
          ${isEditing ? `
            <input type="text" class="group-name-input" value="${g.name.replace(/"/g,'&quot;')}" data-group-input="${g.id}" style="background:var(--bg);color:var(--text);border:1px solid var(--gold);border-radius:6px;padding:4px 10px;font-family:var(--font-display);font-size:15px;font-weight:600;min-width:120px;max-width:260px;">
            <span class="group-save" data-savegroup="${g.id}" title="Save name" style="cursor:pointer;color:var(--good);font-size:16px;user-select:none;">✓</span>
          ` : `
            <span class="group-name-text">${g.name}</span>
            <span class="group-edit" data-editgroup="${g.id}" title="Rename group" style="cursor:pointer;color:var(--text-faint);font-size:13px;opacity:0.55;user-select:none;">✏️</span>
          `}
          ${g.excludeFromTotal?'<span class="debt-tag" style="margin-left:8px;">excluded from totals</span>':''}
        </h4>
        <div class="g-total">
          <label style="font-family:var(--font-mono); font-size:10.5px; color:var(--text-dim); display:inline-flex; gap:6px; align-items:center; cursor:pointer; margin-right:14px;" onclick="event.stopPropagation()">
            <input type="checkbox" data-excltoggle="${g.id}" ${g.excludeFromTotal?'':'checked'}> counts in totals
          </label>
          ${fmt$(sumArr(totalsAll),2)} <span class="row-del" data-delgroup="${g.id}" title="remove group" style="margin-left:10px;">✕</span>
        </div>
      </div>
      <div class="group-body">
        <div class="table-scroll">
          <table class="ledger">
            <thead><tr><th>Category</th>${monthHeaderCells(monthsToShow)}<th>Year</th><th>Notes</th></tr></thead>
            <tbody id="grpbody-${g.id}">
              ${g.categories.map(c=>makeEditableRow(c, monthsToShow)).join('')}
              <tr class="total-row"><td>Total</td>${totalsShown.map(t=>`<td>${fmt$(t)}</td>`).join('')}<td>${fmt$(sumArr(totalsAll))}</td><td></td></tr>
            </tbody>
          </table>
        </div>
        <div class="addcat-row">
          <input type="text" placeholder="New category in ${g.name}…" data-newcat="${g.id}">
          <button class="btn small" data-addcat="${g.id}">+ Add category</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const debtRowsHtml = debts.map(d=>{
    const cells = monthsToShow.map(i=>{
      const v = d.m[i];
      const val = v===null||v===undefined ? '' : v;
      return `<td class="editable ${!val?'zero':''}" contenteditable="true" data-debtpay="${d.id}" data-idx="${i}">${val===''?'–':val}</td>`;
    }).join('');
    return `<tr>
      <td>${d.name}</td>
      ${cells}
      <td style="font-weight:600;">${fmt$(sumArr(d.m),2)}</td>
      <td style="color:var(--text-dim);">${fmt$(debtPendingCalc(d),2)} left</td>
    </tr>`;
  }).join('');

  const html = `
    <div class="section-title">Expenses · ${y}</div>
    <p class="section-sub">Grouped by category. Click any figure to edit it — type over an existing amount to append to it (e.g. "30+40") and hover to see the breakdown later. Add new line items inside a group, or start an entirely new group below. Toggle "counts in totals" off for any group that just tracks a payment or transfer (like paying down a credit card) rather than new spending — otherwise it gets counted twice.</p>

    <div class="last-updated-row">
      <span>Last updated:</span>
      <input type="datetime-local" id="lastUpdatedInput" value="${lastUpdated ? lastUpdated.slice(0,16) : ''}">
      <button class="btn small" id="lastUpdatedNowBtn">Set to now</button>
    </div>

    <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(170px,1fr));">
      <div class="kpi-card c-gold"><div class="kpi-label">Total Income (${scopeLabel})</div><div class="kpi-value">${fmt$(incNow)}</div></div>
      <div class="kpi-card c-rust"><div class="kpi-label">Total Expense (${scopeLabel})</div><div class="kpi-value">${fmt$(expNoCard)}</div></div>
      <div class="kpi-card c-danger"><div class="kpi-label">Actual Expenses incl. card (${scopeLabel})</div><div class="kpi-value">${fmt$(expWithCard)}</div></div>
      <div class="kpi-card ${netAfterCard>=0?'c-teal':'c-danger'}"><div class="kpi-label">Net after card (${scopeLabel})</div><div class="kpi-value">${fmt$(netAfterCard)}</div></div>
    </div>

    <div class="view-toggle">
      ${isMonthScope ? `<button class="btn small" id="expenseViewToggle">${showFullYear && expenseFullYearView ? '◀ Show only '+MONTHS[Number(state.month)] : 'Show full year →'}</button>` : `<span class="section-sub" style="margin:0;">Showing the full year — pick a specific month above to narrow the tables.</span>`}
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-head"><h3>All groups over the year</h3></div>
        <div class="chart-box tall"><canvas id="chartExpAll"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Where money went (${scopeLabel})</h3></div>
        <div class="chart-box tall"><canvas id="chartExpPie"></canvas></div>
      </div>
    </div>

    ${groupsHtml}

    <div class="card">
      <div class="card-head"><h3>Add a new expense group</h3></div>
      <div class="addcat-row">
        <input type="text" id="newGroupName" placeholder="e.g. Pets, Childcare, Side Hustle…">
        <button class="btn primary small" id="addGroupBtn">+ Add group</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Debt Paid Off</h3><span class="section-sub" style="margin:0;">Editable here or on the Debt Payoff tab — both stay in sync automatically.</span></div>
      <div class="table-scroll">
        <table class="ledger">
          <thead><tr><th>Loan</th>${monthHeaderCells(monthsToShow)}<th>Year</th><th>Remaining</th></tr></thead>
          <tbody id="debtPayBody">${debtRowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
  document.getElementById('panel-expenses').innerHTML = html;

  groups.forEach(g=>{
    attachEditableHandlers(document.getElementById('grpbody-'+g.id), g.categories, renderExpenses);
  });

  document.getElementById('lastUpdatedInput').addEventListener('change', (e)=>{
    yearData(y).expensesLastUpdated = e.target.value ? new Date(e.target.value).toISOString() : null;
    markDirty(); renderExpenses();
  });
  document.getElementById('lastUpdatedNowBtn').addEventListener('click', ()=>{
    yearData(y).expensesLastUpdated = new Date().toISOString();
    markDirty(); renderExpenses();
  });

  const viewToggle = document.getElementById('expenseViewToggle');
  if(viewToggle){
    viewToggle.addEventListener('click', ()=>{ expenseFullYearView = !expenseFullYearView; renderExpenses(); });
  }

  document.querySelectorAll('#debtPayBody [data-debtpay]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const d = debts.find(x=>x.id===td.dataset.debtpay);
      const idx = Number(td.dataset.idx);
      const raw = td.textContent.trim().replace(/[$,]/g,'');
      let v = raw===''? null : parseFloat(raw);
      if(isNaN(v)) v = null;
      const before = d.m[idx]===undefined ? null : d.m[idx];
      if(before===v) return;
      d.m[idx] = v;
      td.textContent = v===null?'–':v;
      td.classList.toggle('zero', !v);
      markDirty(); renderExpenses();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });

  document.querySelectorAll('[data-excltoggle]').forEach(cb=>{
    cb.addEventListener('click', (e)=>e.stopPropagation());
    cb.addEventListener('change', ()=>{
      const g = groups.find(x=>x.id===cb.dataset.excltoggle);
      g.excludeFromTotal = !cb.checked;
      markDirty(); renderExpenses();
    });
  });
  document.querySelectorAll('[data-toggle]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      if(e.target.closest('[data-delgroup]') || e.target.closest('.group-edit') || e.target.closest('.group-save') || e.target.closest('.group-name-input')) return;
      const id = el.dataset.toggle;
      collapsedGroups[id] = !collapsedGroups[id];
      renderExpenses();
    });
  });
  document.querySelectorAll('[data-delgroup]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      const id = el.dataset.delgroup;
      const idx = groups.findIndex(g=>g.id===id);
      if(idx>-1 && confirm('Remove the entire "'+groups[idx].name+'" group?')){
        groups.splice(idx,1); markDirty(); renderExpenses();
      }
    });
  });

  /* ---- Group name editing: pencil -> input -> tick ---- */
  document.querySelectorAll('[data-editgroup]').forEach(el=>{
    el.addEventListener('click', (e)=>{
      e.stopPropagation();
      editingGroupId = el.dataset.editgroup;
      renderExpenses();
      requestAnimationFrame(()=>{
        const inp = document.querySelector(`[data-group-input="${editingGroupId}"]`);
        if(inp){ inp.focus(); inp.select(); }
      });
    });
  });

  document.querySelectorAll('[data-savegroup]').forEach(el=>{
    el.addEventListener('mousedown', (e)=>{
      e.preventDefault(); // prevent input blur from firing so we handle save once
      e.stopPropagation();
      const id = el.dataset.savegroup;
      const inp = document.querySelector(`[data-group-input="${id}"]`);
      if(!inp) return;
      const newName = inp.value.trim();
      if(newName){
        const g = groups.find(x=>x.id===id);
        if(g && g.name !== newName){ g.name = newName; markDirty(); }
      }
      editingGroupId = null;
      renderExpenses();
    });
  });

  document.querySelectorAll('[data-group-input]').forEach(el=>{
    el.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); el.blur(); }
    });
    el.addEventListener('blur', ()=>{
      const id = el.dataset.groupInput;
      const newName = el.value.trim();
      if(newName){
        const g = groups.find(x=>x.id===id);
        if(g && g.name !== newName){ g.name = newName; markDirty(); }
      }
      editingGroupId = null;
      renderExpenses();
    });
  });

  document.querySelectorAll('[data-addcat]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const gid = btn.dataset.addcat;
      const inp = document.querySelector(`[data-newcat="${gid}"]`);
      const name = inp.value.trim();
      if(!name){ inp.focus(); return; }
      const g = groups.find(x=>x.id===gid);
      g.categories.push({id:uid(), name, m:n12(), raw:n12(), notes:''});
      markDirty(); renderExpenses();
    });
  });
  document.getElementById('addGroupBtn').addEventListener('click', ()=>{
    const inp = document.getElementById('newGroupName');
    const name = inp.value.trim();
    if(!name){ inp.focus(); return; }
    groups.push({id:uid(), name, excludeFromTotal:/credit card/i.test(name), categories:[{id:uid(), name:'General', m:n12(), raw:n12(), notes:''}]});
    markDirty(); renderExpenses();
  });

  /* ---- Charts ---- */
  const pieTotal = pieVals.reduce((a,b)=>a+b,0);

  destroyChart('expPie');
  charts.expPie = safeChart(document.getElementById('chartExpPie'), {
    type:'doughnut',
    data:{ labels:pieLabels, datasets:[{ data:pieVals, backgroundColor:pieLabels.map((_,i)=>PALETTE[i%PALETTE.length]), borderColor:'#1C2726', borderWidth:2 }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'60%',
      plugins:{
        legend:{position:'right', labels:{boxWidth:9, boxHeight:9, font:{size:10.5}}},
        tooltip:{
          callbacks:{
            label: function(ctx){
              const v = ctx.raw;
              const pct = pieTotal > 0 ? ((v/pieTotal)*100).toFixed(1) : 0;
              return ` ${ctx.label}: ${fmt$(v)} (${pct}%)`;
            }
          }
        }
      } }
  });

  destroyChart('expAll');
  const allGroupsDatasets = groups.map((g,i) => ({
    label: g.name,
    data: groupTotals(g),
    backgroundColor: PALETTE[i % PALETTE.length],
    stack: 'expenses'
  }));
  charts.expAll = safeChart(document.getElementById('chartExpAll'), {
    type: 'bar',
    data: { labels: MONTHS, datasets: allGroupsDatasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 9, boxHeight: 9, font: { size: 10 } } } },
      scales: {
        x: { stacked: true, grid: { display: false } },
        y: { stacked: true, grid: { color: '#26332F' }, ticks: { callback: v => '$'+v } }
      }
    }
  });
}
/* =========================================================================
   BUDGET TAB
   Monthly budget-vs-actual for every income source and expense category.
   Always shows a single month (budgeting a whole year at once doesn't map
   to a real workflow) — if "All months" is selected up top, falls back to
   the current/most-recent month with a note, same convention used elsewhere
   (see currentSnapshotMonth()).
   ========================================================================= */
const BUDGET_TYPE_LABELS = { fixed:'Fixed', flexible:'Flexible', nonmonthly:'Non-Monthly' };
const BUDGET_TYPE_ORDER = ['fixed','flexible','nonmonthly'];

function budgetRowHtml(c, monthIdx, kind){
  // kind: 'income' | 'expense' — only changes the color rule for "remaining"
  const budget = num((c.budget||[])[monthIdx]);
  const actual = num((c.m||[])[monthIdx]);
  const remaining = budget - actual;
  const pct = budget > 0 ? Math.min(100, Math.round((actual/budget)*100)) : (actual>0 ? 100 : 0);
  const over = kind==='expense' ? remaining < -0.005 : false;
  return `
  <div class="budget-row" data-budget-row="${c.id}">
    <span class="budget-row-name">${c.name}</span>
    <span class="budget-row-field">
      <label>Budget</label>
      <input type="number" step="any" class="budget-input" data-budget-cat="${c.id}" data-budget-kind="${kind}" value="${budget || ''}" placeholder="0">
    </span>
    <span class="budget-row-field readout">
      <label>Actual</label>
      <span>${fmt$(actual,2)}</span>
    </span>
    <span class="budget-row-field readout">
      <label>Remaining</label>
      <span class="${over?'bad':'good'}">${remaining<0?'-':''}${fmt$(Math.abs(remaining),2)}</span>
    </span>
    <div class="budget-row-bar-wrap">
      <div class="runway ${over?'over':''}"><div class="runway-fill" style="width:${pct}%;"></div></div>
    </div>
  </div>`;
}

function renderBudget(){
  const y = state.year;
  ensureBudgetMigration(y);
  syncAutoIncomeRows(y);

  const usingAllMonths = state.month === 'ALL';
  const monthIdx = usingAllMonths ? currentSnapshotMonth(y) : Number(state.month);
  const monthLabel = `${MONTHS[monthIdx]} ${y}`;

  const incomeItems = yearData(y).income || [];
  const groups = yearData(y).expenseGroups || [];

  const incomeBudgetTotal = sumArr(incomeItems.map(c=>num((c.budget||[])[monthIdx])));
  const incomeActualTotal = sumArr(incomeItems.map(c=>num((c.m||[])[monthIdx])));

  const groupRollups = groups.map(g=>{
    const catBudget = sumArr((g.categories||[]).map(c=>num((c.budget||[])[monthIdx])));
    const catActual = sumArr((g.categories||[]).map(c=>num((c.m||[])[monthIdx])));
    return { group:g, budget:catBudget, actual:catActual };
  });

  const byType = {fixed:[], flexible:[], nonmonthly:[]};
  groupRollups.forEach(r => (byType[r.group.budgetType] || byType.flexible).push(r));

  const typeSummary = BUDGET_TYPE_ORDER.map(t=>{
    const list = byType[t];
    const budget = sumArr(list.map(r=>r.budget));
    const actual = sumArr(list.map(r=>r.actual));
    return { type:t, budget, actual, remaining:budget-actual };
  });

  const totalExpenseBudget = sumArr(typeSummary.map(t=>t.budget));
  const totalExpenseActual = sumArr(typeSummary.map(t=>t.actual));
  const leftToBudget = incomeBudgetTotal - totalExpenseBudget;

  const groupBlockHtml = (g)=>{
    const collapsed = !!g.collapsed; // same field Expenses tab now persists — same group object, same id, same state
    const rollup = groupRollups.find(r=>r.group.id===g.id);
    return `
    <div class="group-block ${collapsed?'collapsed':''}" data-group-id="${g.id}">
      <div class="group-head" data-toggle="${g.id}">
        <h4 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <span class="g-caret">▾</span>${g.name}
          <select class="budget-type-select" data-budget-type-group="${g.id}" title="How this group counts toward Left to budget">
            ${BUDGET_TYPE_ORDER.map(t=>`<option value="${t}" ${g.budgetType===t?'selected':''}>${BUDGET_TYPE_LABELS[t]}</option>`).join('')}
          </select>
        </h4>
        <span class="g-total">${fmt$(rollup.actual,2)} <span style="color:var(--text-faint);">/ ${fmt$(rollup.budget,2)} budgeted</span></span>
      </div>
      <div class="group-body">
        ${(g.categories||[]).length ? (g.categories||[]).map(c=>budgetRowHtml(c, monthIdx, 'expense')).join('') : '<div class="section-sub" style="margin:0;">No categories in this group yet — add one on the Expenses tab.</div>'}
      </div>
    </div>`;
  };

  const sidebarTypeRow = (t)=>{
    const pct = t.budget>0 ? Math.min(100, Math.round((t.actual/t.budget)*100)) : (t.actual>0?100:0);
    const over = t.remaining < -0.005;
    return `
    <div class="budget-side-type">
      <div class="budget-side-type-head">
        <span>${BUDGET_TYPE_LABELS[t.type]}</span>
        <span class="section-sub" style="margin:0;">${fmt$(t.budget,2)} budget</span>
      </div>
      <div class="runway ${over?'over':''}"><div class="runway-fill" style="width:${pct}%;"></div></div>
      <div class="budget-side-type-foot">
        <b>${fmt$(t.actual,2)}</b> spent
        <span class="${over?'bad':'good'}" style="margin-left:auto;">${over?'over by '+fmt$(Math.abs(t.remaining),2):fmt$(t.remaining,2)+' remaining'}</span>
      </div>
    </div>`;
  };

  const html = `
    <div class="section-title">Budget · ${monthLabel}</div>
    <p class="section-sub">
      Set a target per category for the month, and watch it fill in as actuals come in from Income/Expenses.
      ${usingAllMonths ? `Budgeting is always one month at a time — pick a month up top to edit a different one; showing <b>${monthLabel}</b> for now.` : ''}
    </p>

    <div class="grid-2">
      <div>
        <div class="card">
          <div class="card-head"><h3>Income</h3><span class="section-sub" style="margin:0;">Budget total: <b style="color:var(--gold-soft)">${fmt$(incomeBudgetTotal,2)}</b></span></div>
          ${incomeItems.length ? incomeItems.map(c=>budgetRowHtml(c, monthIdx, 'income')).join('') : '<div class="section-sub" style="margin:0;">No income sources yet — add one on the Income tab.</div>'}
        </div>

        <div class="card-head" style="margin:22px 0 4px;"><h3 style="font-size:15px;">Expenses</h3></div>
        ${groups.length ? groups.map(groupBlockHtml).join('') : '<div class="card"><div class="section-sub" style="margin:0;">No expense groups yet — add one on the Expenses tab.</div></div>'}
      </div>

      <div>
        <div class="card budget-hero-card">
          <div class="budget-hero-value ${leftToBudget<0?'bad':'good'}">${leftToBudget<0?'-':''}${fmt$(Math.abs(leftToBudget),2)}</div>
          <div class="section-sub" style="text-align:center; margin:2px 0 0;">Left to budget</div>
        </div>
        <div class="card">
          <div class="card-head"><h3 style="font-size:15px;">Summary</h3></div>
          ${typeSummary.map(sidebarTypeRow).join('')}
        </div>
      </div>
    </div>
  `;
  document.getElementById('panel-budget').innerHTML = html;

  // ---- Wiring ----
  document.querySelectorAll('[data-toggle]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.toggle;
      const g = groups.find(x=>x.id===id);
      if(!g) return;
      g.collapsed = !g.collapsed;
      markDirty('expenses', {tab:'expenses', action:'edit', target:'Group '+g.name, field:'collapsed', newVal:g.collapsed});
      renderBudget();
    });
  });

  document.querySelectorAll('[data-budget-type-group]').forEach(el=>{
    el.addEventListener('click', e=> e.stopPropagation()); // don't also toggle collapse
    el.addEventListener('change', ()=>{
      const g = groups.find(x=>x.id===el.dataset.budgetTypeGroup);
      if(!g) return;
      const oldVal = BUDGET_TYPE_LABELS[g.budgetType];
      g.budgetType = el.value;
      markDirty('budget', {tab:'budget', field:'budgetType', target:g.name, oldVal, newVal:BUDGET_TYPE_LABELS[g.budgetType]});
      renderBudget();
    });
  });

  document.querySelectorAll('.budget-input').forEach(el=>{
    el.addEventListener('click', e=> e.stopPropagation());
    el.addEventListener('blur', ()=>{
      const id = el.dataset.budgetCat;
      const kind = el.dataset.budgetKind;
      const list = kind==='income' ? incomeItems : groups.flatMap(g=>g.categories||[]);
      const c = list.find(x=>x.id===id);
      if(!c) return;
      const newVal = roundCents(num(parseFloat(el.value)));
      const oldVal = num((c.budget||[])[monthIdx]);
      if(newVal === oldVal) return;
      if(!Array.isArray(c.budget)) c.budget = n12();
      c.budget[monthIdx] = newVal;
      markDirty('budget', {tab:'budget', field:'budget', target:c.name, oldVal:fmt$(oldVal,2), newVal:fmt$(newVal,2)});
      renderBudget();
    });
    el.addEventListener('keydown', e=>{ if(e.key==='Enter') el.blur(); });
  });
}
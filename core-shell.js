const TABS = [
  {id:'overview', label:'Overview', icon:'🧭'},
  {id:'cashflow', label:'Cash Flow', icon:'💵'},
  {id:'income', label:'Income', icon:'💰'},
  {id:'expenses', label:'Expenses', icon:'🧾'},
  {id:'budget', label:'Budget', icon:'📋'},
  {id:'savings', label:'Savings', icon:'🏦'},
  {id:'investments', label:'Investments', icon:'📈'},
  {id:'holdings', label:'Holdings', icon:'📦'},
  {id:'debt', label:'Debt Payoff', icon:'🎯'},
  {id:'data', label:'Data & Import', icon:'📤'}
];

function guardAndSwitch(doSwitch){
  if(isDirty && storageMode!=='unavailable'){
    if(confirm('You have unsaved changes. Save them now before continuing?')){
      persistData(false).then(doSwitch);
      return;
    }
  }
  doSwitch();
}

const SIDEBAR_COLLAPSED_KEY = 'ledger:sidebarCollapsed';

function closeMobileSidebar(){
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  if(sidebar) sidebar.classList.remove('mobile-open');
  if(backdrop) backdrop.classList.remove('show');
}

function initSidebar(){
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');
  const mobileToggle = document.getElementById('sidebarToggleMobile');
  const collapseBtn = document.getElementById('sidebarCollapseBtn');
  if(!sidebar) return;

  // Desktop collapse — a plain UI preference (not ledger data), remembered
  // across reloads via ordinary localStorage. Wrapped in try/catch since
  // private-browsing modes can throw on access; falls back to expanded.
  let collapsed = false;
  try{ collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; }catch(e){ /* default to expanded */ }
  sidebar.classList.toggle('collapsed', collapsed);

  if(collapseBtn){
    collapseBtn.addEventListener('click', ()=>{
      const nowCollapsed = !sidebar.classList.contains('collapsed');
      sidebar.classList.toggle('collapsed', nowCollapsed);
      try{ localStorage.setItem(SIDEBAR_COLLAPSED_KEY, nowCollapsed ? '1' : '0'); }catch(e){}
    });
  }

  // Mobile off-canvas drawer — hamburger opens it, tapping the backdrop,
  // pressing Escape, or picking a nav item (see the tab click handler above)
  // all close it.
  if(mobileToggle){
    mobileToggle.addEventListener('click', ()=>{
      sidebar.classList.add('mobile-open');
      if(backdrop) backdrop.classList.add('show');
    });
  }
  if(backdrop) backdrop.addEventListener('click', closeMobileSidebar);
  document.addEventListener('keydown', (e)=>{ if(e.key==='Escape') closeMobileSidebar(); });
}

async function renderActivityDropdown(){
  const container = document.getElementById('activityDropdownContent');
  if(!container) return;
  await loadLogs();

  const html = `
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
      <h4 style="margin:0;">Activity — last 15 days</h4>
      <span style="font-family:var(--font-mono); font-size:10px; color:var(--text-faint);">ID: ${localStorage.getItem('ledger:supabase:user')?.slice(0,16)||'unknown'}…</span>
    </div>

    <div style="max-height:60vh; overflow-y:auto;">
      ${changeLog.length ? changeLog.map((e, i) => `
        <div style="padding:10px 0; border-bottom:1px solid var(--line-soft); ${i===0?'border-top:1px solid var(--line-soft);':''}">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="font-family:var(--font-mono); font-size:10.5px; color:var(--gold-soft); font-weight:600; line-height:1.4;">${e.summary}</div>
            <div style="font-family:var(--font-mono); font-size:10px; color:var(--text-dim); white-space:nowrap; flex-shrink:0;">${new Date(e.ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</div>
          </div>
          ${e.details && e.details.length ? `
            <div style="margin-top:6px; padding-left:10px; border-left:2px solid var(--line);">
              ${e.details.slice(0,5).map(d => `
                <div style="font-size:11px; color:var(--text-dim); margin:3px 0; display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                  <span style="color:var(--text); font-weight:500;">${d.target}</span>
                  ${d.field ? `<span style="color:var(--text-faint);">(${d.field})</span>` : ''}
                  ${d.action==='edit' && d.oldVal!==undefined ? `
                    <span style="font-family:var(--font-mono); font-size:11px;">
                      <span style="color:var(--text-faint); text-decoration:line-through;">${d.oldVal}</span>
                      <span style="color:var(--gold-soft); margin:0 4px;">→</span>
                      <span style="color:var(--good);">${d.newVal}</span>
                    </span>
                  ` : ''}
                  ${d.action==='add' ? '<span style="color:var(--good); font-size:10px;">[+ added]</span>' : ''}
                  ${d.action==='delete' ? '<span style="color:var(--danger); font-size:10px;">[✕ deleted]</span>' : ''}
                </div>
              `).join('')}
              ${e.details.length > 5 ? `<div style="font-size:10px; color:var(--text-faint); margin-top:4px;">+${e.details.length-5} more changes</div>` : ''}
            </div>
          ` : ''}
        </div>
      `).join('') : '<div style="color:var(--text-faint); padding:20px 0; text-align:center;">No activity recorded yet.</div>'}
    </div>

    <div style="margin-top:14px; padding-top:10px; border-top:1px solid var(--line); font-size:10.5px; color:var(--text-faint); text-align:center;">
      Location tracking is disabled.
    </div>
  `;
  container.innerHTML = html;
}

function initShell(){
  const today = new Date();
  document.getElementById('todayStr').textContent = today.toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit'});

  const yearSel = document.getElementById('yearSelect');
  Object.keys(DATA).filter(k=>/^\d+$/.test(k)).sort((a,b)=>b-a).forEach(y=>{
    const o = document.createElement('option'); o.value=y; o.textContent=y; yearSel.appendChild(o);
  });
  state.year = Object.keys(DATA).includes('2026') ? 2026 : Number(Object.keys(DATA).filter(k=>/^\d+$/.test(k))[0]);
  yearSel.value = state.year;
  yearSel.addEventListener('change', ()=>{ guardAndSwitch(()=>{ state.year = Number(yearSel.value); state.month='ALL'; refreshMonthOptions(); renderActive(); }); });

  refreshMonthOptions();
  document.getElementById('monthSelect').addEventListener('change', (e)=>{ guardAndSwitch(()=>{ state.month = e.target.value; renderActive(); }); });

  const tabsEl = document.getElementById('tabs');
  const panelsEl = document.getElementById('panels');
  TABS.forEach((t,i)=>{
    const b = document.createElement('button');
    b.className='tab-btn'+(i===0?' active':'');
    b.dataset.tab=t.id;
    b.title = t.label;
    b.innerHTML = `<span class="tab-icon">${t.icon}</span><span class="tab-label">${t.label}</span>`;
    b.addEventListener('click', ()=>{
      closeMobileSidebar(); // tapping any item closes the off-canvas drawer, regardless of the guard outcome below
      guardAndSwitch(()=>{
        document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById('panel-'+t.id).classList.add('active');
        renderActive();
      });
    });
    tabsEl.appendChild(b);
    const p = document.createElement('div');
    p.className='panel'+(i===0?' active':'');
    p.id='panel-'+t.id;
    panelsEl.appendChild(p);
  });

  initSidebar();

  document.getElementById('exportBtn').addEventListener('click', ()=>{
    const blob = new Blob([JSON.stringify(DATA,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download='budget-ledger-data.json'; a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('headerSaveBtn').addEventListener('click', ()=>persistData(false));
  document.getElementById('saveBarSaveBtn').addEventListener('click', ()=>persistData(false));
  document.getElementById('saveBarDiscardBtn').addEventListener('click', ()=>{
    if(confirm('This throws away every change since your last save. Continue?')) discardChanges();
  });
  document.getElementById('lockBtn').addEventListener('click', ()=>{
    guardAndSwitch(async ()=>{
      currentRole = null;
      await forgetSession();
      showPinOverlay((role)=>{ currentRole=role; logAccess(role); initShellReadonlyRefresh(); renderActive(); });
    });
  });

  /* ---- Activity bell (admin only) ---- */
  const bell = document.getElementById('activityBell');
  const dropdown = document.getElementById('activityDropdown');
  if(currentRole==='admin' && bell){
    bell.style.display = '';
    bell.addEventListener('click', async (e)=>{
      e.stopPropagation();
      const isOpen = dropdown.style.display === 'block';
      if(!isOpen){
        await renderActivityDropdown(); // fresh fetch every open
        dropdown.style.display = 'block';
      } else {
        dropdown.style.display = 'none';
      }
    });
    document.addEventListener('click', (e)=>{
      if(dropdown.style.display==='block' && !dropdown.contains(e.target) && e.target!==bell){
        dropdown.style.display = 'none';
      }
    });
  } else if(bell){
    bell.style.display = 'none';
  }

  window.addEventListener('beforeunload', (e)=>{
    if(isDirty){ e.preventDefault(); e.returnValue=''; }
  });

  const tipEl = document.getElementById('cellTooltip');
  document.addEventListener('mouseover', (e)=>{
    const td = e.target.closest('[data-tip]');
    if(!td) return;
    tipEl.textContent = td.getAttribute('data-tip');
    const rect = td.getBoundingClientRect();
    tipEl.style.left = (rect.left + rect.width/2) + 'px';
    tipEl.style.top = (rect.top - 8) + 'px';
    tipEl.style.transform = 'translate(-50%, -100%)';
    tipEl.classList.add('show');
  });
  document.addEventListener('mouseout', (e)=>{
    if(e.target.closest('[data-tip]')) tipEl.classList.remove('show');
  });

  initShellReadonlyRefresh();
}

function initShellReadonlyRefresh(){
  if(currentRole==='readonly'){
    document.querySelector('.footer-note').textContent = 'You are in read-only mode — editing is turned off. Use the 🔒 button and the admin PIN to make changes.';
  } else {
    document.querySelector('.footer-note').textContent = "Every figure here lives in your browser's private storage for this ledger — edit a cell, add a category, or drop in a new spreadsheet any time.";
  }
}

function refreshMonthOptions(){
  const sel = document.getElementById('monthSelect');
  sel.innerHTML='';
  const optAll = document.createElement('option'); optAll.value='ALL'; optAll.textContent='Full Year';
  sel.appendChild(optAll);
  MONTHS.forEach((m,i)=>{ const o=document.createElement('option'); o.value=i; o.textContent=m+' '+state.year; sel.appendChild(o); });
  state.month = String(currentSnapshotMonth(state.year));
  sel.value = state.month;
  document.getElementById('scopeStr').textContent = state.year + ' · ' + MONTHS[Number(state.month)];
}
function updateScopeStr(){
  document.getElementById('scopeStr').textContent = state.year + ' · ' + (state.month==='ALL' ? 'Full Year' : MONTHS[Number(state.month)]);
}

function renderActive(){
  updateScopeStr();
  const active = document.querySelector('.tab-btn.active').dataset.tab;
  if(active==='overview') renderOverview();
  if(active==='cashflow') renderCashFlow();
  if(active==='income') renderIncome();
  if(active==='expenses') renderExpenses();
  if(active==='budget') renderBudget();
  if(active==='savings') renderSavings(); 
  if(active==='investments') renderInvestments();
  if(active==='holdings') renderHoldings();
  if(active==='debt') renderDebt();
  if(active==='data') renderDataTab();
  applyReadOnlyGuard();
}

function destroyChart(key){ if(charts[key]){ charts[key].destroy(); delete charts[key]; } }
function safeChart(canvasEl, config){
  if(typeof Chart==='undefined' || !canvasEl){
    if(canvasEl && canvasEl.parentElement){
      canvasEl.parentElement.innerHTML = '<div class="section-sub" style="padding:20px 0;">Chart unavailable — charting library failed to load.</div>';
    }
    return null;
  }
  return new Chart(canvasEl, config);
}

const chartFont = { family:"'IBM Plex Mono', monospace", size:11 };
/* Chart.defaults are applied inside boot(), once Chart.js is confirmed loaded */

/* =========================================================================
   OVERVIEW TAB
   ========================================================================= */
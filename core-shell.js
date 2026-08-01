const TABS = [
  {id:'overview', label:'Overview'},
  {id:'cashflow', label:'Cash Flow'},
  {id:'income', label:'Income'},
  {id:'expenses', label:'Expenses'},
  {id:'investments', label:'Investments'},
  {id:'holdings', label:'Holdings'},
  {id:'debt', label:'Debt Payoff'},
  {id:'data', label:'Data & Import'}
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

function renderActivityDropdown(){
  const container = document.getElementById('activityDropdownContent');
  if(!container) return;
  const html = `
    <h4>Activity — last 15 days</h4>
    <div class="grid-2" style="grid-template-columns:1fr 1fr; gap:16px;">
      <div>
        <div style="font-family:var(--font-mono); font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-dim); margin-bottom:8px;">Save history</div>
        <div class="table-scroll" style="max-height:220px; overflow-y:auto;">
          <table class="ledger">
            <thead><tr><th>When</th><th>What</th></tr></thead>
            <tbody>
              ${changeLog.length ? changeLog.map(e=>`<tr><td style="font-family:var(--font-mono); font-size:11px; white-space:nowrap;">${new Date(e.ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</td><td>${e.summary}</td></tr>`).join('') : '<tr><td colspan="2" style="color:var(--text-faint);">No saves recorded yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
      <div>
        <div style="font-family:var(--font-mono); font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-dim); margin-bottom:8px;">Login history</div>
        <div class="table-scroll" style="max-height:220px; overflow-y:auto;">
          <table class="ledger">
            <thead><tr><th>When</th><th>Access</th><th>Location</th></tr></thead>
            <tbody>
              ${accessLog.length ? accessLog.map(e=>`<tr><td style="font-family:var(--font-mono); font-size:11px; white-space:nowrap;">${new Date(e.ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</td><td>${e.role==='admin'?'Admin':'Read-only'}</td><td style="font-family:var(--font-mono); font-size:11px;">${e.locationText}</td></tr>`).join('') : '<tr><td colspan="3" style="color:var(--text-faint);">No logins recorded yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="section-sub" style="margin-top:10px; margin-bottom:0; font-size:11px;">Location is only ever your browser's approximate coordinates — nothing is sent outside this app.</div>
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
    b.innerHTML = `<span class="tab-index">0${i+1}</span>${t.label}`;
    b.addEventListener('click', ()=>{
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
    bell.addEventListener('click', (e)=>{
      e.stopPropagation();
      const isOpen = dropdown.style.display === 'block';
      dropdown.style.display = isOpen ? 'none' : 'block';
      if(!isOpen) renderActivityDropdown();
    });
    document.addEventListener('click', (e)=>{
      if(dropdown.style.display==='block' && !dropdown.contains(e.target) && e.target!==bell){
        dropdown.style.display = 'none';
      }
    });
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
  const latest = findLatestMonthWithData(state.year);
  const today = new Date();
  const defaultMonth = (state.year===today.getFullYear()) ? Math.min(today.getMonth(), latest>=0?Math.max(latest,today.getMonth()):today.getMonth()) : latest;
  state.month = String(latest>=0? latest : (today.getMonth()));
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
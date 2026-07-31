/* =========================================================================
   LIBRARY LOADER — load Chart.js and SheetJS ourselves and wait for them,
   rather than relying on <script src> parse-order (unreliable in sandboxed
   preview iframes).
   ========================================================================= */
function loadScript(src){
  return new Promise((resolve, reject)=>{
    const s = document.createElement('script');
    s.src = src;
    s.onload = ()=>resolve(src);
    s.onerror = ()=>reject(new Error('Failed to load '+src));
    document.head.appendChild(s);
  });
}
const CHART_SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://unpkg.com/chart.js@4.4.4/dist/chart.umd.min.js'
];
const XLSX_SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'
];
async function loadFirstWorking(sources, checkFn){
  for(const src of sources){
    try{ await loadScript(src); if(checkFn()) return true; }catch(e){ /* try next */ }
  }
  return checkFn();
}

/* =========================================================================
   DATA MODEL
   ========================================================================= */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_ALIASES = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};

function n12(){ return new Array(12).fill(null); }
function uid(){ return 'id'+Math.random().toString(36).slice(2,10); }

// ---- category color palette (used across groups/investment types) ----
const PALETTE = ['#C9A961','#6FA491','#C06A46','#8FC0AC','#D98C64','#7FAE79','#9BB6C9','#B98BC9','#E4CE94','#5F8C7A'];

function buildDefaultData(){
  return {
    2026: {
      income: [
        {id:uid(), name:'Wages Week 1', m:[null,2729.16,40,3016.99,3016.99,3016.99,3050.55,null,null,null,null,null]},
        {id:uid(), name:'Wages Week 2', m:[null,3007,3007,3016.99,3016.99,3016.99,3050.55,null,null,null,null,null]},
        {id:uid(), name:'Wages Week (Kooli Pani, phone bill reimbursement)', m:[1600,null,null,null,null,240,null,null,null,null,null,null]},
        {id:uid(), name:'Wages Week (taxes, HSA money)', m:[null,5215,30,169.39,110.01,null,null,null,null,null,null,null]}
      ],
      expenseGroups: [
        {id:uid(), name:'Home', categories:[
          {id:uid(), name:'Mortgage', m:[850,800,800,800,800,400,null,null,null,null,null,null]},
          {id:uid(), name:'Insurance', m:n12()},
          {id:uid(), name:'Deposit', m:[null,null,800,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Utilities', m:[109,null,94.38,59.1,59.86,59.67,37.43,null,null,null,null,null]},
          {id:uid(), name:'College expenses (car, gas, coffee, flights)', m:[null,null,501.65,null,688.1,293.3,null,null,null,null,null,null]}
        ]},
        {id:uid(), name:'Daily Living', categories:[
          {id:uid(), name:'Split Wise', m:[90,270,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Groceries (Indian)', m:[308,244,27.64,58.3,20,39.58,null,null,null,null,null,null]},
          {id:uid(), name:'Shifting to new places', m:[null,85,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Walmart', m:[null,null,99.05,196.92,144.18,119.07,60.73,null,null,null,null,null]},
          {id:uid(), name:'Dining out', m:[null,1.87,34.04,72.48,23.69,40.28,9.24,null,null,null,null,null]},
          {id:uid(), name:'Other home (Amazon, Dollar Tree, Costco)', m:[96.25,64,13.23,58.96,null,63.71,null,null,null,null,null,null]},
          {id:uid(), name:'Fun activities (games, outdoors)', m:[null,null,null,null,7.28,37.14,null,null,null,null,null,null]}
        ]},
        {id:uid(), name:'Transportation', categories:[
          {id:uid(), name:'Public transportation', m:[4,50.84,22.5,10.21,11.32,2.32,24.04,null,null,null,null,null]},
          {id:uid(), name:'Friends transportation', m:[null,8.5,2.25,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Cabs', m:[null,5.34,null,null,null,null,null,null,null,null,null,null]}
        ]},
        {id:uid(), name:'Credit Card Spend', excludeFromTotal:true, categories:[
          {id:uid(), name:'Chase', m:[48,252,300,100,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Amex (fee)', m:[8.95,null,null,null,null,325,null,null,null,null,null,null]},
          {id:uid(), name:'Capital One', m:n12()},
          {id:uid(), name:'Discover', m:[null,176.62,200,100,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Citi', m:n12()},
          {id:uid(), name:'BOFA', m:n12()}
        ]},
        {id:uid(), name:'Vacations', categories:[
          {id:uid(), name:'Trips', m:[null,519,null,41,null,416.71,307.58,null,null,null,null,null]},
          {id:uid(), name:'Accommodations', m:[null,67,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Movies', m:[null,null,23.37,null,null,10,null,null,null,null,null,null]},
          {id:uid(), name:'Airlines', m:[421,null,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Rental car', m:n12()}
        ]},
        {id:uid(), name:'Dues / Subscriptions', categories:[
          {id:uid(), name:'Internet connection', m:[51.54,51.52,51.51,51.5,56.54,56.54,null,null,null,null,null,null]},
          {id:uid(), name:'Wifi', m:[10,null,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Youtube', m:[null,null,3.67,3.83,null,4.5,null,null,null,null,null,null]},
          {id:uid(), name:'Apple & Google One', m:[2.99,2.99,2.99,2.99,2.99,2.99,null,null,null,null,null,null]}
        ]},
        {id:uid(), name:'Personal', categories:[
          {id:uid(), name:'Self learning (Open API)', m:[null,null,null,null,26.55,null,null,null,null,null,null,null]},
          {id:uid(), name:'Clothing', m:[null,5,null,null,39.8,95.6,45,null,null,null,null,null]},
          {id:uid(), name:'Gifts', m:[null,null,null,null,null,99.81,21.1,null,null,null,null,null]},
          {id:uid(), name:'Salon / barber', m:[11.99,null,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Self care (sunscreen, moisturizer)', m:[null,null,null,108.3,107.1,14.25,null,null,null,null,null,null]},
          {id:uid(), name:'Health care (checkups)', m:[null,null,70,null,null,null,null,null,null,null,null,null]}
        ]},
        {id:uid(), name:'Financial Obligations', categories:[
          {id:uid(), name:'Family loan sendings', m:[1000,4490.99,4700,1800,1400,1650,221,null,null,null,null,null]},
          {id:uid(), name:'Family expenses', m:[null,null,3400,1800,769,null,null,null,null,null,null,null]},
          {id:uid(), name:'Income tax (additional)', m:[null,150,null,null,null,null,null,null,null,null,null,null]},
          {id:uid(), name:'Second masters', m:[43,789.52,766.52,789.52,1669,1700,470.99,null,null,null,null,null]},
          {id:uid(), name:'Other obligations (family, India)', m:[null,null,null,null,null,101.53,null,null,null,null,null,null]}
        ]},
        {id:uid(), name:'Misc Payments', categories:[
          {id:uid(), name:'Other (gambling, ups)', m:[null,80,null,84.55,null,null,null,null,null,null,null,null]}
        ]}
      ],
      investments: [
        {id:uid(), name:'Loans Given', category:'Other', m:[null,null,3000,4000,null,null,null,null,null,null,null,null], currentValue:7000, invested:7000},
        {id:uid(), name:'Robinhood', category:'US Stocks', m:[null,null,null,49.44,30,45,30,null,null,null,null,null], currentValue:2900, invested:2857.44},
        {id:uid(), name:'Coin by Zerodha MF', category:'Indian Stocks', m:[null,271.94,1011.41,427.47,null,null,null,null,null,null,null,null], currentValue:1802.31, invested:1865.82},
        {id:uid(), name:'Groww', category:'Indian Stocks', m:[null,null,null,159.15,158.86,null,null,null,null,null,null,null], currentValue:1559.89, invested:1397.01},
        {id:uid(), name:'Fidelity', category:'US Stocks', m:n12(), currentValue:2082, invested:1381},
        {id:uid(), name:'Zerodha', category:'Indian Stocks', m:[null,null,433.08,null,null,null,null,null,null,null,null,null], currentValue:1391.26, invested:1374.02},
        {id:uid(), name:'Angel Investing', category:'Angel Investing', m:[null,null,null,1180,null,null,529.81,null,null,null,null,null], currentValue:1180, invested:1709.81},
        {id:uid(), name:'Angel One', category:'Indian Stocks', m:n12(), currentValue:754.75, invested:1130.37},
        {id:uid(), name:'Coinbase', category:'Crypto', m:n12(), currentValue:30, invested:42},
        {id:uid(), name:'Coin DCX', category:'Crypto', m:n12(), currentValue:0, invested:0}
      ],
      debts: [
        {id:uid(), name:'Home Loan', total:22100.72, cleared:2167.77, interest:9.6, emi:23000, m:n12(), note:'EMI figure may be recorded in home currency, not USD.'},
        {id:uid(), name:'Education Loan', total:9920.79, cleared:0, interest:9.65, emi:12675, m:n12(), note:'EMI figure may be recorded in home currency, not USD.'},
        {id:uid(), name:'Gold Loan', total:31599.82, cleared:-1000, interest:9.0, emi:null, m:[null,null,null,null,null,1000,null,null,null,null,null,null]},
        {id:uid(), name:'Personal Loan', total:15215.16, cleared:13423.72, interest:12.1, emi:0, m:n12()},
        {id:uid(), name:'US Credit Cards', total:8200, cleared:3032.42, interest:0, emi:null, m:[null,null,null,null,null,null,3153.58,null,null,null,null,null]},
        {id:uid(), name:'Car Loan', total:5687.02, cleared:687.02, interest:8, emi:null, m:[null,5000,null,null,null,null,null,null,null,null,null,null]},
        {id:uid(), name:'Bike Loan', total:1844.07, cleared:1844.07, interest:8, emi:null, m:n12()},
        {id:uid(), name:'My HDFC Personal Loan', total:400, cleared:-50, interest:0, emi:null, m:[75,75,75,75,75,75,null,null,null,null,null,null]}
      ]
    },
    2025: {
      income: [
        {id:uid(), name:'Wages Week 1', m:[null,null,null,null,null,null,null,2209.39,2790.32,2793.8,2793.8,null]},
        {id:uid(), name:'Wages Week 2', m:[null,null,null,null,null,null,null,180.25,2793,2793.8,1500,null]},
        {id:uid(), name:'Wages Week 3', m:[null,null,null,null,null,null,null,2530.16,null,null,null,null]},
        {id:uid(), name:'Wages Week 4', m:[null,null,null,null,null,null,null,3192.17,null,null,null,null]}
      ],
      expenseGroups: [
        {id:uid(), name:'Home', categories:[
          {id:uid(), name:'Mortgage', m:[null,null,null,null,null,null,null,450,585,550,550,null]},
          {id:uid(), name:'Insurance', m:[null,null,null,null,null,null,null,2.29,null,null,null,null]},
          {id:uid(), name:'Deposit', m:[null,null,null,null,null,null,null,null,550,null,null,null]},
          {id:uid(), name:'Utilities', m:[null,null,null,null,null,null,null,42.66,null,29,56.67,null]}
        ]},
        {id:uid(), name:'Daily Living', categories:[
          {id:uid(), name:'Split Wise', m:[null,null,null,null,null,null,null,null,null,8.24,null,null]},
          {id:uid(), name:'Groceries', m:[null,null,null,null,null,null,null,26,73.34,78.74,24.25,null]},
          {id:uid(), name:'Dining out', m:[null,null,null,null,null,null,null,37.08,53,46.28,6.95,null]},
          {id:uid(), name:'Other home expenses', m:[null,null,null,null,null,null,null,130.61,2.26,null,null,null]}
        ]},
        {id:uid(), name:'Transportation', categories:[
          {id:uid(), name:'Public transportation', m:[null,null,null,null,null,null,null,101.25,265.8,null,null,null]},
          {id:uid(), name:'Friends transportation', m:[null,null,null,null,null,null,15,15,null,null,null,null]},
          {id:uid(), name:'Cabs', m:[null,null,null,null,null,null,null,null,16.15,null,32,null]}
        ]},
        {id:uid(), name:'Credit Card Spend', excludeFromTotal:true, categories:[
          {id:uid(), name:'Chase', m:[null,null,null,null,null,null,null,null,40,41,44,null]},
          {id:uid(), name:'Amex', m:[null,null,null,null,null,null,null,95.25,400,1700,900,null]},
          {id:uid(), name:'Capital One', m:n12()},
          {id:uid(), name:'Discover', m:[null,null,null,null,null,null,null,0,124,null,null,null]},
          {id:uid(), name:'Citi', m:n12()},
          {id:uid(), name:'BOFA', m:n12()}
        ]},
        {id:uid(), name:'Vacations', categories:[
          {id:uid(), name:'Trips', m:[null,null,null,null,null,null,null,null,null,null,226.92,null]},
          {id:uid(), name:'Movies', m:[null,null,null,null,null,null,null,26.49,37.52,26.49,null,null]},
          {id:uid(), name:'Airlines', m:[null,null,null,null,null,null,null,80,null,586,null,null]}
        ]},
        {id:uid(), name:'Dues / Subscriptions', categories:[
          {id:uid(), name:'Internet connection', m:[null,null,null,null,null,null,null,18.75,41.81,51.93,null,null]},
          {id:uid(), name:'Wifi', m:[null,null,null,null,null,null,null,4.57,8,8,10,10]},
          {id:uid(), name:'Apple & Google One', m:[null,null,null,null,null,null,null,null,2.35,2.99,2.99,null]}
        ]},
        {id:uid(), name:'Personal', categories:[
          {id:uid(), name:'Clothing', m:[null,null,null,null,null,null,null,null,null,11.01,null,null]},
          {id:uid(), name:'Salon / barber', m:[null,null,null,null,null,null,null,12.99,null,null,null,null]},
          {id:uid(), name:'Self care', m:[null,null,null,null,null,null,null,null,null,60.63,13.94,null]}
        ]},
        {id:uid(), name:'Financial Obligations', categories:[
          {id:uid(), name:'Family loan sendings', m:[null,null,null,null,null,null,null,3838.61,4950,2900,1400,null]},
          {id:uid(), name:'Other obligations (family, India)', m:[null,null,null,null,null,null,null,null,null,64.72,93.47,null]}
        ]},
        {id:uid(), name:'Misc Payments', categories:[
          {id:uid(), name:'Other', m:n12()}
        ]}
      ],
      investments: [
        {id:uid(), name:'Robinhood', category:'US Stocks', m:[null,null,null,null,null,null,null,872.95,null,344,155,null], currentValue:1049.46, invested:2484.8},
        {id:uid(), name:'Fidelity', category:'US Stocks', m:[null,null,null,null,null,null,null,30,null,30,null,null], currentValue:1504.91, invested:1445.32},
        {id:uid(), name:'Angel One', category:'Indian Stocks', m:[null,null,null,null,null,null,null,79.93,null,null,null,null], currentValue:2773.36, invested:3228.83},
        {id:uid(), name:'Groww', category:'Indian Stocks', m:[null,null,null,null,null,null,null,285.46,null,null,null,null], currentValue:900.99, invested:1000.79},
        {id:uid(), name:'Coinbase', category:'Crypto', m:[null,null,null,null,null,null,null,0,null,null,null,null], currentValue:37.94, invested:42},
        {id:uid(), name:'Coin DCX', category:'Crypto', m:n12(), currentValue:0, invested:0},
        {id:uid(), name:'Wazirx', category:'Crypto', m:n12(), currentValue:0, invested:0}
      ],
      debts: [
        {id:uid(), name:'Home Loan', total:21237.06, cleared:0, interest:9.6, emi:null, m:n12()},
        {id:uid(), name:'Education Loan', total:9220.79, cleared:0, interest:9.65, emi:null, m:n12()},
        {id:uid(), name:'Gold Loan', total:16184.06, cleared:0, interest:9.0, emi:null, m:n12()},
        {id:uid(), name:'Personal Loan', total:9943.62, cleared:4877.66, interest:12.1, emi:null, m:n12()},
        {id:uid(), name:'US Credit Cards', total:8435.16, cleared:0, interest:0, emi:null, m:n12()}
      ]
    }
  };
}

function buildDefaultPaymentPlan(){
  const colSalary=uid(), colCollegeFees=uid(), colRent=uid(), colGrocery=uid(), colUtilities=uid(), colTrips=uid(), colCollege=uid(), colMisc=uid();
  const columns = [
    {id:colSalary, name:'Salary', kind:'income'},
    {id:colCollegeFees, name:'College Fees (paid outside this budget)', kind:'memo'},
    {id:colRent, name:'Rent', kind:'expense'},
    {id:colGrocery, name:'Grocery', kind:'expense'},
    {id:colUtilities, name:'Utilities', kind:'expense'},
    {id:colTrips, name:'Trips', kind:'expense'},
    {id:colCollege, name:'College', kind:'expense'},
    {id:colMisc, name:'Misc', kind:'expense'}
  ];
  function row(label, vals){
    return {id:uid(), label, values:{
      [colSalary]:vals[0], [colCollegeFees]:vals[1], [colRent]:vals[2], [colGrocery]:vals[3],
      [colUtilities]:vals[4], [colTrips]:vals[5], [colCollege]:vals[6], [colMisc]:vals[7]
    }};
  }
  const rows = [
    row('September 2026', [6000,3800,400,150,50,null,null,150]),
    row('October 2026',   [6000,null,400,150,50,null,null,150]),
    row('November 2026',  [6000,null,400,150,50,null,null,150]),
    row('December 2026',  [6000,null,400,150,50,null,null,150]),
    row('January 2027',   [6000,3800,400,150,50,800,500,150]),
    row('February 2027',  [6000,null,400,150,50,null,null,150]),
    row('March 2027',     [6000,null,400,150,50,null,null,150]),
    row('April 2027',     [6000,null,400,150,50,null,500,150])
  ];
  return {columns, rows};
}

/* =========================================================================
   STATE + PERSISTENCE
   ========================================================================= */
let DATA = null;
let state = { year: 2026, month: 'ALL' };
let charts = {};
const STORAGE_KEY = 'ledger:data:v1';

async function loadData(){
  try{
    const res = await window.storage.get(STORAGE_KEY, false);
    if(res && res.value){
      DATA = JSON.parse(res.value);
      if(!DATA.paymentPlan) DATA.paymentPlan = buildDefaultPaymentPlan();
      lastSavedSnapshot = JSON.stringify(DATA);
      return;
    }
  }catch(e){ /* not found or storage unavailable */ }
  DATA = buildDefaultData();
  DATA.paymentPlan = buildDefaultPaymentPlan();
  await persistData(true);
}

let isDirty = false;
let lastSavedSnapshot = null;
let dirtyTabs = new Set();
let storageMode = 'unknown'; // 'connected' | 'unavailable' (API missing entirely) | 'failing' (API present but calls erroring)

function markDirty(tabId){
  isDirty = true;
  if(tabId) dirtyTabs.add(tabId);
  updateSaveUI();
}

async function probeStorage(){
  if(typeof window.storage === 'undefined'){
    // This happens when the page is viewed outside Claude's own preview pane
    // (e.g. the file was downloaded and opened directly) — window.storage
    // simply doesn't exist there, so there's nothing to retry.
    storageMode = 'unavailable';
    updateSaveUI();
    return;
  }
  try{
    const res = await window.storage.set('ledger:probe', String(Date.now()), false);
    storageMode = res ? 'connected' : 'failing';
  }catch(e){ storageMode = 'failing'; }
  updateSaveUI();
}

async function persistData(silent, attempt){
  attempt = attempt || 1;
  if(typeof window.storage === 'undefined'){
    storageMode = 'unavailable';
    updateSaveUI();
    if(!silent) showToast("This page has no connection to Claude's storage right now, so nothing outside this tab will remember your edits. Export data regularly to keep a real backup.");
    return;
  }
  try{
    const res = await window.storage.set(STORAGE_KEY, JSON.stringify(DATA), false);
    if(!res) throw new Error('empty response from storage');
    lastSavedSnapshot = JSON.stringify(DATA);
    isDirty = false;
    dirtyTabs.clear();
    storageMode = 'connected';
    updateSaveUI();
    logChange('Saved changes' + (silent ? ' (auto)' : ''));
    if(!silent) showToast('Saved');
  }catch(e){
    if(attempt < 3){
      await new Promise(r=>setTimeout(r, attempt*800));
      return persistData(silent, attempt+1);
    }
    storageMode = 'failing';
    updateSaveUI();
    if(!silent) showToast('Still could not save after a few tries. Your changes are safe in this tab for now — try again shortly, or click Export data to keep a backup you can reload later.');
  }
}

function discardChanges(){
  if(!lastSavedSnapshot) return;
  DATA = JSON.parse(lastSavedSnapshot);
  isDirty = false;
  dirtyTabs.clear();
  updateSaveUI();
  renderActive();
  showToast('Changes discarded');
}

function updateSaveUI(){
  const bar = document.getElementById('saveBar');
  const discardBtn = document.getElementById('saveBarDiscardBtn');
  const saveBtn = document.getElementById('saveBarSaveBtn');
  if(bar){
    const msgEl = bar.querySelector('.save-bar-msg');
    if(storageMode==='unavailable'){
      bar.classList.add('show');
      if(msgEl) msgEl.innerHTML = "No connection to persistent storage in this view — changes stay in this tab only. <b>Export data</b> now and then to keep a real backup.";
      if(discardBtn) discardBtn.style.display='none';
      if(saveBtn) saveBtn.style.display='none';
    } else if(storageMode==='failing'){
      bar.classList.add('show');
      if(msgEl) msgEl.textContent = "Couldn't reach storage on the last attempt — your edits are still here. Try Save again, or Export data as a backup.";
      if(discardBtn) discardBtn.style.display='';
      if(saveBtn) saveBtn.style.display='';
    } else {
      bar.classList.toggle('show', isDirty);
      if(msgEl) msgEl.textContent = 'You have unsaved changes.';
      if(discardBtn) discardBtn.style.display='';
      if(saveBtn) saveBtn.style.display='';
    }
  }
  const headerBtn = document.getElementById('headerSaveBtn');
  if(headerBtn){
    headerBtn.classList.toggle('primary', isDirty && storageMode!=='unavailable');
    if(storageMode==='unavailable'){
      headerBtn.textContent = '⚠ No storage'; headerBtn.title = "This view has no connection to persistent storage — use Export data instead.";
      headerBtn.disabled = true; headerBtn.style.opacity='0.5';
    } else {
      headerBtn.disabled = false; headerBtn.style.opacity='1';
      headerBtn.title = storageMode==='failing' ? 'Last save failed — click to retry' : 'Save all changes now';
      headerBtn.textContent = storageMode==='failing' ? '⚠ Retry save' : (isDirty ? '● Save changes' : 'Save');
    }
  }
}

function showToast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* =========================================================================
   CHANGE / ACCESS LOGS — kept for the last 15 days, shown on the Data tab
   ========================================================================= */
const CHANGELOG_KEY = 'ledger:changelog:v1';
const ACCESSLOG_KEY = 'ledger:accesslog:v1';
let changeLog = [];
let accessLog = [];
function pruneOld(list){
  const cutoff = Date.now() - 15*24*60*60*1000;
  return list.filter(e=>e.ts>=cutoff);
}
async function loadLogs(){
  try{ const r = await window.storage.get(CHANGELOG_KEY, false); changeLog = r&&r.value ? JSON.parse(r.value) : []; }catch(e){ changeLog=[]; }
  try{ const r = await window.storage.get(ACCESSLOG_KEY, false); accessLog = r&&r.value ? JSON.parse(r.value) : []; }catch(e){ accessLog=[]; }
  changeLog = pruneOld(changeLog);
  accessLog = pruneOld(accessLog);
}
async function logChange(summary){
  changeLog.unshift({ts:Date.now(), summary});
  changeLog = pruneOld(changeLog).slice(0,200);
  try{ await window.storage.set(CHANGELOG_KEY, JSON.stringify(changeLog), false); }catch(e){}
}
async function logAccess(role){
  let locationText = 'location unavailable';
  try{
    const pos = await new Promise((res,rej)=>{
      if(!navigator.geolocation) return rej();
      navigator.geolocation.getCurrentPosition(res, rej, {timeout:2500});
    });
    locationText = pos.coords.latitude.toFixed(2)+', '+pos.coords.longitude.toFixed(2);
  }catch(e){ /* denied, unavailable, or timed out — logged without location */ }
  accessLog.unshift({ts:Date.now(), role, locationText});
  accessLog = pruneOld(accessLog).slice(0,200);
  try{ await window.storage.set(ACCESSLOG_KEY, JSON.stringify(accessLog), false); }catch(e){}
}

/* =========================================================================
   HELPERS: numbers, sums, formatting
   ========================================================================= */
function num(v){ return (typeof v === 'number' && !isNaN(v)) ? v : 0; }
function sumArr(arr){ return arr.reduce((a,b)=>a+num(b),0); }
function debtClearedToDate(d){ return num(d.cleared) + sumArr(d.m); }
function debtPendingCalc(d){ return Math.max(num(d.total) - debtClearedToDate(d), 0); }
function fmt$(v, decimals){
  decimals = decimals===undefined? 0 : decimals;
  const neg = v<0;
  const s = Math.abs(v).toLocaleString('en-US',{minimumFractionDigits:decimals, maximumFractionDigits:decimals});
  return (neg? '-$':'$')+s;
}
function pct(v){ return (v*100).toFixed(1)+'%'; }
function monthRange(){
  return state.month==='ALL' ? [0,1,2,3,4,5,6,7,8,9,10,11] : [Number(state.month)];
}
function yearData(y){ return DATA[y] || DATA[state.year]; }

function groupTotals(group){ // sum across categories per month -> array[12]
  const out = n12().map(()=>0);
  group.categories.forEach(c=>{ c.m.forEach((v,i)=> out[i]+=num(v)); });
  return out;
}
function incomeTotals(y){
  const out = n12().map(()=>0);
  yearData(y).income.forEach(c=> c.m.forEach((v,i)=> out[i]+=num(v)));
  return out;
}
function expenseTotalsAllGroups(y){
  const out = n12().map(()=>0);
  yearData(y).expenseGroups.forEach(g=>{
    const gt = groupTotals(g);
    gt.forEach((v,i)=> out[i]+=v);
  });
  return out;
}
function expenseTotalsCounted(y){
  const out = n12().map(()=>0);
  yearData(y).expenseGroups.forEach(g=>{
    if(g.excludeFromTotal) return;
    const gt = groupTotals(g);
    gt.forEach((v,i)=> out[i]+=v);
  });
  return out;
}
function expenseTotalsExcluded(y){
  const out = n12().map(()=>0);
  yearData(y).expenseGroups.forEach(g=>{
    if(!g.excludeFromTotal) return;
    const gt = groupTotals(g);
    gt.forEach((v,i)=> out[i]+=v);
  });
  return out;
}
function investContribTotals(y){
  const out = n12().map(()=>0);
  yearData(y).investments.forEach(inv=> inv.m.forEach((v,i)=> out[i]+=num(v)));
  return out;
}
function sumRange(arr, months){ return months.reduce((a,i)=>a+num(arr[i]),0); }

function findLatestMonthWithData(y){
  const inc = incomeTotals(y), exp = expenseTotalsAllGroups(y);
  let last = 0;
  for(let i=0;i<12;i++){ if(inc[i]>0 || exp[i]>0) last=i; }
  return last;
}

/* =========================================================================
   CASH FLOW: income minus categorized spend minus card bill payments minus
   debt payments, carried month to month (and year to year). Every figure
   can be overridden per month directly in the Cash Flow table.
   ========================================================================= */
function debtPaymentTotals(y){
  const out = n12().map(()=>0);
  yearData(y).debts.forEach(d=> d.m.forEach((v,i)=> out[i]+=num(v)));
  return out;
}
function cfOverride(y, i, field){
  const yd = yearData(y);
  const o = yd.cashFlowOverrides && yd.cashFlowOverrides[i];
  return (o && o[field]!==undefined && o[field]!==null) ? o[field] : undefined;
}
function setCfOverride(y, i, field, value){
  const yd = yearData(y);
  if(!yd.cashFlowOverrides) yd.cashFlowOverrides = {};
  if(!yd.cashFlowOverrides[i]) yd.cashFlowOverrides[i] = {};
  if(value===null || value===undefined){ delete yd.cashFlowOverrides[i][field]; }
  else { yd.cashFlowOverrides[i][field] = value; }
}
function getAutoYearStart(y){
  const prevY = y-1;
  if(DATA[prevY]) return computeCashFlow(prevY)[11].carryOut;
  return 0;
}
function computeCashFlow(y){
  const incBase = incomeTotals(y), expBase = expenseTotalsCounted(y), cardBase = expenseTotalsExcluded(y), debtBase = debtPaymentTotals(y);
  let running = getAutoYearStart(y);
  const rows = [];
  for(let i=0;i<12;i++){
    const income = cfOverride(y,i,'income') ?? incBase[i];
    const expenses = cfOverride(y,i,'expenses') ?? expBase[i];
    const card = cfOverride(y,i,'card') ?? cardBase[i];
    const debtPaid = cfOverride(y,i,'debtPaid') ?? debtBase[i];
    const carryInOverride = cfOverride(y,i,'carryIn');
    const carryIn = carryInOverride!==undefined ? carryInOverride : running;
    const netFlow = income - expenses - card - debtPaid;
    const carryOut = carryIn + netFlow;
    rows.push({
      income, expenses, card, debtPaid, netFlow, carryIn, carryOut,
      incomeOverridden: cfOverride(y,i,'income')!==undefined,
      expensesOverridden: cfOverride(y,i,'expenses')!==undefined,
      cardOverridden: cfOverride(y,i,'card')!==undefined,
      debtPaidOverridden: cfOverride(y,i,'debtPaid')!==undefined,
      carryInOverridden: carryInOverride!==undefined
    });
    running = carryOut;
  }
  return rows;
}

/* =========================================================================
   INIT / SHELL
   ========================================================================= */

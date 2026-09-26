/* =========================================================================
   DATA / IMPORT TAB
   ========================================================================= */
/* BUGFIX: same root cause as evalExpr in shared-editable.js -- the old
   fallback here (parseFloat on a char-stripped string) silently truncated
   "100-30" to 100 because parseFloat stops at the first invalid character
   once it hits the interior "-". Rewritten to only accept a plain number
   or a full +/- expression matched end-to-end, never a truncated prefix. */
function parseNumCell(v){
  if(v===null || v===undefined || v==='') return null;
  if(typeof v==='number') return v;
  if(typeof v==='string'){
    const cleaned = v.trim().replace(/,/g,''); // strip thousands separators
    if(cleaned==='') return null;
    if(/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return parseFloat(cleaned);
    const noSpace = cleaned.replace(/\s+/g,'');
    if(/^[+-]?\d+(\.\d+)?([+-]\d+(\.\d+)?)*$/.test(noSpace)){
      try{
        const r = Function('"use strict";return ('+noSpace+')')();
        return (typeof r==='number' && isFinite(r)) ? r : null;
      }catch(e){ return null; }
    }
    // Last resort for messy spreadsheet cells like "$1,234.56" -- strip
    // currency symbols, but only accept a single clean number this way,
    // never a truncated prefix of something messier like "100-30".
    const stripped = cleaned.replace(/[()$₹]/g,'');
    if(/^[+-]?\d+(\.\d+)?$/.test(stripped)) return parseFloat(stripped);
    return null;
  }
  return null;
}
function isMonthHeaderRow(row){
  const slice = row.slice(1,13).map(v=> (v||'').toString().trim().toLowerCase().slice(0,3));
  let hits=0; slice.forEach(s=>{ if(MONTH_ALIASES[s]!==undefined) hits++; });
  return hits>=8;
}

function parseYearSheet(rows){
  const income=[]; const expenseGroups=[]; const investments=[]; const debts=[];
  let i=0;
  while(i<rows.length){
    const row = rows[i] || [];
    const label = (row[0]||'').toString().trim();
    if(label && isMonthHeaderRow(row)){
      const groupName = label;
      const isIncome = /^income$/i.test(groupName);
      const isInvest = /^invest/i.test(groupName);
      const isLoan = /^loan payments?$/i.test(groupName);
      i++;
      const cats=[];
      while(i<rows.length){
        const r = rows[i]||[];
        const first = (r[0]||'').toString().trim();
        if(/^total$/i.test(first)){ i++; break; }
        if(first==='' ){ i++; continue; }
        if(isMonthHeaderRow(r)) break; // next group started without explicit Total row
        if(isLoan){
          debts.push({
            id:uid(), name:first,
            pending: parseNumCell(r[14]) ?? 0,
            total: parseNumCell(r[15]) ?? 0,
            cleared: parseNumCell(r[16]) ?? 0,
            interest: (parseNumCell(r[17])||0) * ((parseNumCell(r[17])||0) < 1 ? 100 : 1),
            emi: parseNumCell(r[18]),
            m: Array.from({length:12}, (_,k)=>parseNumCell(r[k+1]))
          });
        } else if(isInvest){
          investments.push({
            id:uid(), name:first, category:'Other',
            m: Array.from({length:12}, (_,k)=>parseNumCell(r[k+1])),
            currentValue: parseNumCell(r[13]) ?? 0,
            invested: parseNumCell(r[14]) ?? 0
          });
        } else {
          cats.push({ id:uid(), name:first, m: Array.from({length:12}, (_,k)=>parseNumCell(r[k+1])) });
        }
        i++;
      }
      if(isIncome){ income.push(...cats); }
      else if(!isInvest && !isLoan){ expenseGroups.push({id:uid(), name:groupName, excludeFromTotal:/credit card/i.test(groupName), categories:cats}); }
    } else {
      i++;
    }
  }
  return {income, expenseGroups, investments, debts};
}

function renderDataTab(){
  const html = `
    <div class="section-title">Data & Import</div>
    <p class="section-sub">Upload a new spreadsheet to refresh a year's numbers, export what's here, or reset back to empty.</p>

    <div class="card">
      <div class="card-head"><h3>Import a spreadsheet</h3></div>
      <div class="notice">Works best with a workbook shaped like your original tracker: a sheet named for the year (e.g. <b>2026</b>), with group headers like <b>INCOME</b>, <b>HOME</b>, <b>Investment</b>, or <b>Loan Payments</b> followed by <b>JAN…DEC</b> columns, each ending in a <b>Total</b> row. Re-uploading it any time refreshes this ledger — including brand-new categories you've added in Excel.</div>
      <div class="dropzone" id="dropzone">
        <div>📄 Drop an .xlsx file here, or click to browse</div>
        <div style="font-size:11px; margin-top:6px; color:var(--text-faint);">Data is parsed entirely in your browser — nothing is uploaded anywhere.</div>
        <input type="file" id="fileInput" accept=".xlsx,.xls">
      </div>
      <div id="importStatus" style="margin-top:12px; font-family:var(--font-mono); font-size:12px; color:var(--text-dim);"></div>
    </div>

    <div class="card">
      <div class="card-head"><h3>Housekeeping</h3></div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" id="exportBtn2">Export current data (.json)</button>
      </div>
    </div>
  `;
  document.getElementById('panel-data').innerHTML = html;

  const dz = document.getElementById('dropzone');
  const fi = document.getElementById('fileInput');
  dz.addEventListener('click', ()=>fi.click());
  ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev,(e)=>{e.preventDefault(); dz.classList.add('drag');}));
  ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,(e)=>{e.preventDefault(); dz.classList.remove('drag');}));
  dz.addEventListener('drop', (e)=>{ const f=e.dataTransfer.files[0]; if(f) handleFile(f); });
  fi.addEventListener('change', (e)=>{ const f=e.target.files[0]; if(f) handleFile(f); });

  document.getElementById('exportBtn2').addEventListener('click', ()=>document.getElementById('exportBtn').click());
  /* "Reset to empty" removed on purpose — it wiped and saved over the
     entire DATA object (every tab, every year) behind a single confirm(),
     with no undo beyond a manual export. If you ever want it back:
  document.getElementById('resetBtn').addEventListener('click', async ()=>{
    if(confirm('This wipes everything and resets to empty. Continue?')){
      DATA = buildDefaultData(); DATA.paymentPlan = buildDefaultPaymentPlan(); await persistData(true); showToast('Reset to empty'); refreshMonthOptions(); renderActive();
    }
  });
  */

  /* BUGFIX (data loss): this used to do `DATA[yr] = parsed;` — a wholesale
     replacement of the entire year object with no confirmation. Two
     problems with that:
       1. parseYearSheet() only ever returns income/expenseGroups/
          investments/debts — it has no idea about savingsAccounts,
          retirementAccounts, savingsGoals, assets, cashFlowOverrides, or
          portfolioSnapshots, so replacing the whole year object silently
          wiped all of those every time you re-imported a spreadsheet.
       2. It also silently wiped `holdings` on every investment (the
          per-lot detail from the Holdings tab), because the spreadsheet
          rows for an "Investment" group only carry a name + monthly
          totals, never lot-level holdings.
     Fix: merge instead of replace — keep everything the spreadsheet
     doesn't know about untouched, re-attach existing holdings to
     investments matched by name, and ask for confirmation up front so a
     drag-and-drop mistake can't wipe a year silently. */
  function handleFile(file){
    const status = document.getElementById('importStatus');
    status.textContent = 'Reading '+file.name+'…';
    const reader = new FileReader();
    reader.onload = (e)=>{
      try{
        const wb = XLSX.read(e.target.result, {type:'array', cellDates:true});
        const toImport = [];
        [2026,2025].forEach(yr=>{
          const sheetName = wb.SheetNames.find(n=> n.trim()===String(yr));
          if(!sheetName) return;
          const ws = wb.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(ws, {header:1, raw:true, defval:null});
          const parsed = parseYearSheet(rows);
          if(parsed.income.length || parsed.expenseGroups.length || parsed.investments.length || parsed.debts.length){
            toImport.push({yr, parsed});
          }
        });
        if(!toImport.length){
          status.innerHTML = '<span style="color:var(--danger)">No matching "2025"/"2026" sheet with the expected layout was found.</span> The sheet names in your file were: '+wb.SheetNames.join(', ');
          return;
        }
        const yearList = toImport.map(x=>x.yr).join(' and ');
        const confirmed = confirm(
          'This will replace Income, Expenses, Investments, and Debt totals for '+yearList+' with what\'s in this spreadsheet.\n\n'+
          'Savings accounts, retirement accounts, savings goals, assets, and any Holdings-tab lot detail on your investments will be kept as-is — the spreadsheet doesn\'t carry that information.\n\n'+
          'Continue?'
        );
        if(!confirmed){ status.textContent = 'Import cancelled — nothing changed.'; return; }
        toImport.forEach(({yr, parsed})=>{
          const existing = DATA[yr] || {};
          // Re-attach existing holdings/currency to investments matched by
          // name, so re-importing the same spreadsheet doesn't blow away
          // the lot-level detail you built up on the Holdings tab.
          const oldInvByName = {};
          (existing.investments||[]).forEach(inv=>{ oldInvByName[(inv.name||'').trim().toLowerCase()] = inv; });
          parsed.investments.forEach(inv=>{
            const old = oldInvByName[(inv.name||'').trim().toLowerCase()];
            inv.holdings = old && old.holdings ? old.holdings : [];
            inv.currency = old ? (old.currency || 'USD') : (inv.currency || 'USD');
          });
          DATA[yr] = {
            income: parsed.income,
            expenseGroups: parsed.expenseGroups,
            investments: parsed.investments,
            debts: parsed.debts,
            savingsAccounts: existing.savingsAccounts || [],
            retirementAccounts: existing.retirementAccounts || [],
            savingsGoals: existing.savingsGoals || [],
            assets: existing.assets || [],
            cashFlowOverrides: existing.cashFlowOverrides || {},
            portfolioSnapshots: existing.portfolioSnapshots || []
          };
        });
        persistData(true);
        status.innerHTML = '<span style="color:var(--good)">✓ Import complete.</span> Your Overview, Income, Expenses, Investments and Debt tabs now reflect the new file. Savings, goals, and holdings detail were kept.';
        showToast('Spreadsheet imported');
        refreshMonthOptions();
        renderActive();
      }catch(err){
        status.innerHTML = '<span style="color:var(--danger)">Could not read that file: '+err.message+'</span>';
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

/* =========================================================================
   BOOT
   ========================================================================= */
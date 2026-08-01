/* =========================================================================
   DATA / IMPORT TAB
   ========================================================================= */
function parseNumCell(v){
  if(v===null || v===undefined || v==='') return null;
  if(typeof v==='number') return v;
  if(typeof v==='string'){
    const s = v.trim();
    if(/^-?[0-9.]+$/.test(s)) return parseFloat(s);
    if(/^[0-9.+\s]+$/.test(s)){ try{ return Function('"use strict";return ('+s.replace(/\s+/g,'')+')')(); }catch(e){ return null; } }
    const f = parseFloat(s.replace(/[^0-9.\-]/g,''));
    return isNaN(f)? null : f;
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
    <p class="section-sub">

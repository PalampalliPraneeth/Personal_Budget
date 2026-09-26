/* =========================================================================
   EDITABLE TABLE BUILDER (shared by income / expenses / investments)
   ========================================================================= */
/* BUGFIX: this used to fail on two common inputs:
     - "1,234"  -> old code fell through to a bare parseFloat("1,234"),
                   which JS parses only up to the comma and returns 1.
     - "100-30" -> old code required a literal "+" to treat input as a sum,
                   so this fell through to parseFloat("100-30"), which also
                   stops at the first invalid character and returns 100 —
                   silently dropping the "-30" instead of computing 70.
   Fix: strip thousands-separator commas first, then only ever return a
   number when the ENTIRE input is a valid plain number or a full chain of
   +/- terms (validated end-to-end by EXPR, not just parsed from the front).
   Anything else — letters, "1.2.3", a trailing operator like "100+", a
   malformed "100--30" — is refused (returns null) rather than guessed at,
   so a bad entry can't silently save the wrong number. */
function evalExpr(s){
  if(s===null || s===undefined) return null;
  const cleaned = s.trim().replace(/,/g,''); // strip thousands separators, e.g. "1,234" -> "1234"
  if(cleaned==='') return null;
  const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;
  if(PLAIN_NUMBER.test(cleaned)) return parseFloat(cleaned);
  const noSpace = cleaned.replace(/\s+/g,'');
  // A chain of +/- terms across the WHOLE string, e.g. "100-30", "50+25.50",
  // "-40+10-5". Using $ at the end (not just parsing a prefix) is what
  // makes "100-30" correctly compute 70 instead of silently truncating to 100.
  const EXPR = /^[+-]?\d+(\.\d+)?([+-]\d+(\.\d+)?)*$/;
  if(EXPR.test(noSpace)){
    try{
      const v = Function('"use strict";return ('+noSpace+')')();
      if(typeof v!=='number' || !isFinite(v)) return null;
      // Guard against binary floating-point artifacts (e.g. 590+69.82 ->
      // 659.8199999999999) — these are currency amounts, so round to cents.
      return Math.round((v + Number.EPSILON) * 100) / 100;
    }catch(e){ return null; }
  }
  return null;
}
function formatTip(raw, currency){
  if(!raw) return null;
  const noSpace = raw.replace(/\s+/g,'');
  // Split into signed terms, e.g. "100-30+5" -> ["100","-30","+5"], so the
  // breakdown tooltip works for subtraction too, not just addition.
  const parts = noSpace.match(/[+-]?\d+(\.\d+)?/g);
  if(!parts || parts.length<2) return null;
  const total = parts.reduce((a,b)=>a+(parseFloat(b)||0),0);
  const display = parts.map((p,i)=> i===0 ? p : (p[0]==='-' ? ' - '+p.slice(1) : ' + '+p.replace(/^\+/,''))).join('');
  return display + ' = ' + fmtNative(total, currency);
}

function makeEditableRow(item, monthsToShow, opts){
  opts = opts || {};
  monthsToShow = monthsToShow || [0,1,2,3,4,5,6,7,8,9,10,11];
  if(!item.raw) item.raw = n12();
  if(item.notes===undefined) item.notes = '';
  if(!item.currency) item.currency = 'USD';
  const locked = !!opts.locked;
  const cells = monthsToShow.map(i=>{
    const v = item.m[i];
    const val = v===null||v===undefined ? '' : v;
    const displayVal = val==='' ? '' : Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    if(locked){
      return `<td class="locked-cell ${!val?'zero':''}" title="${(opts.lockedTip||'Auto-calculated').replace(/"/g,'&quot;')}">${displayVal===''?'–':displayVal}</td>`;
    }
    const tip = formatTip(item.raw[i], item.currency);
    return `<td class="editable ${!val?'zero':''} ${tip?'has-tip':''}" contenteditable="true" data-field="m" data-idx="${i}" data-id="${item.id}" ${tip?`data-tip="${tip.replace(/"/g,'&quot;')}"`:''}>${displayVal===''?'–':displayVal}</td>`;
  }).join('');
  const total = sumArr(item.m);
  const safeName = (item.name||'').replace(/"/g,'&quot;');
  const nameLabel = locked
    ? `<span class="ledger-name-text" title="${safeName}">${item.name}</span> <span class="tag-auto" title="${(opts.lockedTip||'Auto-calculated').replace(/"/g,'&quot;')}">🔗 auto</span>`
    : `<span class="ledger-name-text editable-inline" contenteditable="true" data-field="name" data-id="${item.id}" title="${safeName}">${item.name}</span>`;
  return `<tr data-row-id="${item.id}">
    <td>${nameLabel} <span class="row-del" data-del="${item.id}" title="remove">✕</span></td>
    ${cells}
    <td style="font-weight:600;">${fmtNative(total, item.currency)}</td>
    <td class="editable notes-cell" contenteditable="true" data-field="notes" data-id="${item.id}">${item.notes||''}</td>
    <td style="color:var(--text-dim); font-size:11px;">${item.currency}</td>
  </tr>`;
}

function attachEditableHandlers(container, items, onChange, tabName){
  tabName = tabName || 'data';
  container.querySelectorAll('td.editable[data-field="m"]').forEach(td=>{
    td.addEventListener('focus', ()=>{
      const item = items.find(x=>x.id===td.dataset.id);
      const idx = Number(td.dataset.idx);
      td.dataset.origRaw = td.textContent;
      const raw = item.raw && item.raw[idx];
      td.textContent = raw!=null ? raw : (item.m[idx]!=null ? item.m[idx] : '');
    });
    td.addEventListener('blur', ()=>{
      const id = td.dataset.id, idx = Number(td.dataset.idx);
      const item = items.find(x=>x.id===id);
      let entered = td.textContent.trim();
      const prevDisplay = item.m[idx]!=null ? String(item.m[idx]) : '';
      const prevRaw = (item.raw && item.raw[idx]) || prevDisplay;
      
      if((entered.startsWith('+') || entered.startsWith('-')) && prevRaw && prevRaw !== entered){
        entered = prevRaw + entered;
      }
      
      if(entered === prevRaw){ td.textContent = item.m[idx]==null ? '–' : item.m[idx]; return; }
      if(!item.raw) item.raw = n12();
      if(entered===''){
        item.m[idx] = null; item.raw[idx] = null;
        td.textContent = '–'; td.classList.add('zero');
        td.removeAttribute('data-tip'); td.classList.remove('has-tip');
        markDirty(tabName, {tab: tabName, action: 'edit', target: item.name, field: MONTHS[idx], oldVal: prevDisplay || 'empty', newVal: 'empty'});
        onChange && onChange();
        return;
      }
      const v = evalExpr(entered);
      const hasBreakdown = /\+/.test(entered);
      item.m[idx] = v===null ? null : roundCents(v);
      item.raw[idx] = hasBreakdown ? entered : null;
      td.textContent = v===null ? '–' : roundCents(v);
      td.classList.toggle('zero', !v);
      const tip = formatTip(item.raw[idx], item.currency);
      if(tip){ td.dataset.tip = tip; td.classList.add('has-tip'); }
      else { td.removeAttribute('data-tip'); td.classList.remove('has-tip'); }
      markDirty(tabName, {tab: tabName, action: 'edit', target: item.name, field: MONTHS[idx], oldVal: prevDisplay || 'empty', newVal: v});
      onChange && onChange();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });
  container.querySelectorAll('td.editable[data-field="notes"]').forEach(td=>{
    td.addEventListener('focus', ()=>{ td.dataset.origRaw = td.textContent; });
    td.addEventListener('blur', ()=>{
      if(td.textContent === td.dataset.origRaw) return;
      const item = items.find(x=>x.id===td.dataset.id);
      const val = td.textContent.trim();
      if(item.notes===val) return;
      item.notes = val;
      markDirty(tabName, {tab: tabName, action: 'edit', target: item.name, field: 'notes', oldVal: td.dataset.origRaw, newVal: val});
      onChange && onChange();
    });
    td.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); td.blur(); } });
  });
  container.querySelectorAll('[data-field="name"]').forEach(el=>{
    el.addEventListener('focus', ()=>{ el.dataset.origRaw = el.textContent; });
    el.addEventListener('blur', ()=>{
      const item = items.find(x=>x.id===el.dataset.id);
      const val = el.textContent.trim();
      if(!val){ el.textContent = item.name; return; } // don't allow blanking the name
      if(item.name===val) return;
      const before = item.name;
      item.name = val;
      el.title = val;
      markDirty(tabName, {tab: tabName, action: 'edit', target: before, field: 'name', oldVal: before, newVal: val});
      onChange && onChange();
    });
    el.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
  });
  container.querySelectorAll('[data-del]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const id = el.dataset.del;
      const idx = items.findIndex(x=>x.id===id);
      if(idx>-1 && confirm('Remove "'+items[idx].name+'"?')){
        const name = items[idx].name;
        items.splice(idx,1);
        markDirty(tabName, {tab: tabName, action: 'delete', target: name});
        onChange && onChange();
      }
    });
  });
}

function monthHeaderCells(monthsToShow){
  const list = monthsToShow || [0,1,2,3,4,5,6,7,8,9,10,11];
  return list.map(i=>`<th>${MONTHS[i]}</th>`).join('');
}
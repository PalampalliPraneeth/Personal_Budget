/* =========================================================================
   EDITABLE TABLE BUILDER (shared by income / expenses / investments)
   ========================================================================= */
function evalExpr(s){
  const cleaned = s.trim();
  if(/^-?[0-9.]+$/.test(cleaned)) return parseFloat(cleaned);
  if(/^[0-9.+\-\s]+$/.test(cleaned) && /\+/.test(cleaned)){
    try{
      const v = Function('"use strict";return ('+cleaned.replace(/\s+/g,'')+')')();
      return (typeof v==='number' && isFinite(v)) ? v : null;
    }catch(e){ return null; }
  }
  const f = parseFloat(cleaned);
  return isNaN(f) ? null : f;
}
function formatTip(raw){
  if(!raw) return null;
  const parts = raw.replace(/\s+/g,'').split('+').filter(Boolean);
  if(parts.length<2) return null;
  const total = parts.reduce((a,b)=>a+(parseFloat(b)||0),0);
  return parts.join(' + ') + ' = ' + fmt$(total,2);
}

function makeEditableRow(item, monthsToShow){
  monthsToShow = monthsToShow || [0,1,2,3,4,5,6,7,8,9,10,11];
  if(!item.raw) item.raw = n12();
  if(item.notes===undefined) item.notes = '';
  const cells = monthsToShow.map(i=>{
    const v = item.m[i];
    const val = v===null||v===undefined ? '' : v;
    const displayVal = val==='' ? '' : Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const tip = formatTip(item.raw[i]);
    return `<td class="editable ${!val?'zero':''} ${tip?'has-tip':''}" contenteditable="true" data-field="m" data-idx="${i}" data-id="${item.id}" ${tip?`data-tip="${tip.replace(/"/g,'&quot;')}"`:''}>${displayVal===''?'–':displayVal}</td>`;
  }).join('');
  const total = sumArr(item.m);
  return `<tr data-row-id="${item.id}">
    <td>${item.name} <span class="row-del" data-del="${item.id}" title="remove">✕</span></td>
    ${cells}
    <td style="font-weight:600;">${fmt$(total,2)}</td>
    <td class="editable notes-cell" contenteditable="true" data-field="notes" data-id="${item.id}">${item.notes||''}</td>
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
      item.m[idx] = v;
      item.raw[idx] = hasBreakdown ? entered : null;
      td.textContent = v===null ? '–' : v;
      td.classList.toggle('zero', !v);
      const tip = formatTip(item.raw[idx]);
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
function goToTab(tabId, highlightSelector){
  guardAndSwitch(()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tabId));
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id==='panel-'+tabId));
    if(tabId==='expenses' && highlightSelector){
      const m = highlightSelector.match(/data-group-id="([^"]+)"/);
      if(m) collapsedGroups[m[1]] = false;
    }
    renderActive();
    if(highlightSelector){
      requestAnimationFrame(()=>{
        const el = document.querySelector(highlightSelector);
        if(el){
          el.scrollIntoView({behavior:'smooth', block:'center'});
          el.classList.add('flash-highlight');
          setTimeout(()=>el.classList.remove('flash-highlight'), 1600);
        }
      });
    }
  });
}

/* =========================================================================
   MONEY FLOW SANKEY  —  hand-built SVG, no chart library needed.
   Income sources → Total Income → where it went. Any node with more than
   one item underneath it (a group's categories, an investment's holdings,
   a debt's loans) can be clicked to fan out into its own column on the
   right — expanded by default so the full breakdown is visible at a glance;
   click a node to collapse it if you want a calmer view.
   ========================================================================= */
let sankeyExpanded = {}; // { nodeId: true|false } — explicit overrides. Everything expands by default except Income (its individual pay sources stay collapsed until clicked), and this survives re-renders in this session.
function isSankeyNodeExpanded(id){
  if(id==='grp:income') return sankeyExpanded[id] === true;
  return sankeyExpanded[id] !== false;
}

/* Combine every item below `pct` of grandTotal into one "Other" node, so a
   long tail of tiny slivers doesn't clutter (or, worse, visually collide
   with) the diagram. Only kicks in when there are 2+ small items — bucketing
   a single small item would just be renaming it for no reason. Kinds in
   `alwaysKeep` are exempt (e.g. Savings/Shortfall are meaningful regardless
   of size, never worth hiding inside "Other"). */
function bucketSmallSlices(items, grandTotal, bucketIdBase, alwaysKeep){
  if(!items.length || !grandTotal) return items;
  const threshold = grandTotal * 0.02;
  const big = [], small = [];
  items.forEach(it=>{
    if((alwaysKeep && alwaysKeep.has(it.kind)) || it.value >= threshold) big.push(it);
    else small.push(it);
  });
  if(small.length < 2) return items;
  const otherTotal = sumArr(small.map(x=>x.value));
  big.push({
    id: 'other:'+bucketIdBase, name: `Other (${small.length} smaller)`, value: otherTotal,
    kind:'other', children: small.map(x=>({ id:x.id, name:x.name, value:x.value, kind:x.kind }))
  });
  return big.sort((a,b)=> b.value-a.value);
}

/* Sum a 12-slot monthly array — either the whole year, or just one month,
   depending on the global month selector at the top of the app (state.month).
   null monthIdx means "Full Year". */
function scopedSumArr(arr, monthIdx){
  if(monthIdx===null || monthIdx===undefined) return sumArr(arr);
  return num((arr||[])[monthIdx]);
}
/* Same idea for a currency-aware monthly array (INR entries locked to
   each month's own FX rate — see core-data.js monthlyArrToUsd). */
function scopedMonthlyArrToUsd(arr, currency, year, monthIdx){
  if(monthIdx===null || monthIdx===undefined) return monthlyArrToUsd(arr, currency, year);
  return nativeMonthToUsd((arr||[])[monthIdx], currency, year, monthIdx);
}
function buildSankeyData(y){
  // Follows the global month dropdown at the top of the app — pick a
  // specific month there and this diagram (and only this diagram; the KPI
  // cards above stay full-year) scopes down to that month's flows.
  const monthIdx = (state.month === 'ALL' || state.month === undefined || state.month === null) ? null : Number(state.month);

  let incomeItems = yearData(y).income
    .map(it => ({ id:'incitem:'+it.id, name: it.name, value: scopedSumArr(it.m, monthIdx), kind:'incomeItem' }))
    .filter(x => x.value > 0.005)
    .sort((a,b)=> b.value - a.value);
  const totalIncome = sumArr(incomeItems.map(x=>x.value));

  const groups = yearData(y).expenseGroups.filter(g=>!g.excludeFromTotal);
  let groupNodes = groups.map(g=>{
    const cats = g.categories
      .map(c=>({ id:'cat:'+c.id, name:c.name, value: scopedSumArr(c.m, monthIdx), kind:'category', parentGroupId:g.id }))
      .filter(c=>c.value>0.005)
      .sort((a,b)=> b.value-a.value);
    const total = sumArr(cats.map(c=>c.value));
    return { id:'grp:'+g.id, name:g.name, value: total, kind:'group', groupId:g.id, _rawChildren: cats };
  }).filter(n=>n.value>0.005);

  let investItems = yearData(y).investments.map(inv=>{
    const usd = scopedMonthlyArrToUsd(inv.m, inv.currency, y, monthIdx);
    return { id:'inv:'+inv.id, name:inv.name, value: usd, kind:'investmentItem' };
  }).filter(x=>x.value>0.005).sort((a,b)=>b.value-a.value);
  const investTotal = sumArr(investItems.map(x=>x.value));

  let debtItems = yearData(y).debts.map(d=>{
    const usd = scopedMonthlyArrToUsd(d.m, d.currency, y, monthIdx);
    return { id:'debtitem:'+d.id, name:d.name, value: usd, kind:'debtItem', debtId:d.id };
  }).filter(x=>x.value>0.005).sort((a,b)=>b.value-a.value);
  const debtTotal = sumArr(debtItems.map(x=>x.value));

  // Retirement: only YOUR contribution counts as money leaving your pocket —
  // employer match never passed through your income, so it can't be an
  // outflow here without breaking the diagram's inflow=outflow balance.
  let retirementItems = (yearData(y).retirementAccounts||[]).map(r=>{
    const usd = scopedMonthlyArrToUsd(r.mSelf||[], r.currency, y, monthIdx);
    return { id:'retitem:'+r.id, name:r.name, value: usd, kind:'retirementItem' };
  }).filter(x=>x.value>0.005).sort((a,b)=>b.value-a.value);
  const retirementTotal = sumArr(retirementItems.map(x=>x.value));

  const totalOut = sumArr(groupNodes.map(n=>n.value)) + investTotal + debtTotal + retirementTotal;
  const leftover = totalIncome - totalOut;
  const grandTotal = Math.max(
    leftover < -0.005 ? totalOut : totalIncome,
    totalOut + Math.max(leftover, 0),
    0.01
  );

  // Now that grandTotal is known, bucket every small tail — inside each
  // group's categories, inside Investments/Debt/Retirement, inside Income
  // sources — using ONE consistent "under 2% of the whole diagram" rule.
  groupNodes.forEach(n=>{
    const bucketed = bucketSmallSlices(n._rawChildren, grandTotal, n.id);
    n.children = bucketed.length > 1 ? bucketed : [];
    delete n._rawChildren;
  });
  investItems = bucketSmallSlices(investItems, grandTotal, 'investments');
  debtItems = bucketSmallSlices(debtItems, grandTotal, 'debt');
  retirementItems = bucketSmallSlices(retirementItems, grandTotal, 'retirement');
  incomeItems = bucketSmallSlices(incomeItems, grandTotal, 'income');

  const investNode = investTotal>0.005 ? { id:'grp:investments', name:'Investments', value:investTotal, kind:'investments', children: investItems.length>1 ? investItems : [] } : null;
  const debtNode = debtTotal>0.005 ? { id:'grp:debt', name:'Debt Paid Off', value:debtTotal, kind:'debt', children: debtItems.length>1 ? debtItems : [] } : null;
  const retirementNode = retirementTotal>0.005 ? { id:'grp:retirement', name:'Retirement', value:retirementTotal, kind:'retirement', children: retirementItems.length>1 ? retirementItems : [] } : null;

  let outNodes = [...groupNodes];
  if(investNode) outNodes.push(investNode);
  if(debtNode) outNodes.push(debtNode);
  if(retirementNode) outNodes.push(retirementNode);

  // Income is ONE bar by default ("Income") — click it to fan out into
  // individual paychecks/sources, same interaction as every outflow bar.
  let inNodes = [];
  if(incomeItems.length){
    inNodes.push({ id:'grp:income', name:'Income', value: totalIncome, kind:'income', children: incomeItems.length>1 ? incomeItems : [] });
  }

  let grandInflow = totalIncome;
  if(leftover < -0.005){
    inNodes.push({ id:'shortfall', name:'From Savings / Credit', value:-leftover, kind:'shortfall', children:[] });
    grandInflow = totalOut;
  } else if(leftover > 0.005){
    outNodes.push({ id:'grp:savings', name:'Net Savings', value:leftover, kind:'savings', children:[] });
  }

  // Bucket the top-level columns too (e.g. several sub-2% expense groups),
  // but never hide Savings/Shortfall — those stay visible at any size.
  const ALWAYS_KEEP = new Set(['savings','shortfall']);
  outNodes = bucketSmallSlices(outNodes, grandTotal, 'out-top', ALWAYS_KEEP);
  inNodes = bucketSmallSlices(inNodes, grandTotal, 'in-top', ALWAYS_KEEP);

  inNodes.sort((a,b)=> b.value-a.value);
  outNodes.sort((a,b)=> b.value-a.value);

  return { inNodes, outNodes, grandTotal: Math.max(grandInflow, sumArr(outNodes.map(n=>n.value)), 0.01) };
}

const SANKEY_KIND_COLOR = {
  incomeItem:'#C9A961', income:'#C9A961', shortfall:'#C6584C',
  investments:'#6FA491', investmentItem:'#8FC0AC',
  debt:'#C6584C', debtItem:'#D98C64',
  retirement:'#9BB6C9', retirementItem:'#B9CBDA',
  savings:'#7FAE79', category:null, other:'#8A9490' // group/category colored via PALETTE below
};

function sankeyRibbon(x0,x1, sy0,sy1, ty0,ty1){
  const xi = (x0+x1)/2;
  return `M${x0},${sy0} C${xi},${sy0} ${xi},${ty0} ${x1},${ty0} L${x1},${ty1} C${xi},${ty1} ${xi},${sy1} ${x0},${sy1} Z`;
}

/* Stack a column of nodes top-to-bottom using ONE shared $-per-px scale, so
   every column stays proportionally honest against the others. `reserveFor`
   (optional) lets a node claim MORE vertical space than its own $-driven
   height — used when a node is expanded and its children need more room
   than the node itself, so the next sibling gets pushed down instead of
   the expanded children overlapping it. Returns the laid-out nodes plus
   the final cursor position (the true bottom edge of this column). */
function sankeyLayoutColumn(nodes, scale, top, gap, reserveFor){
  let y = top;
  const laid = nodes.map(n=>{
    const h = Math.max(n.value*scale, n.value>0 ? 1.5 : 0);
    const node = {...n, y0:y, y1:y+h};
    const slot = reserveFor ? Math.max(h, reserveFor(n)) : h;
    y += slot + gap;
    return node;
  });
  return { nodes: laid, bottom: nodes.length ? y - gap : top };
}

/* Allocate money from a column of source nodes into a column of target
   nodes proportionally (a waterfall pour, left to right), producing the
   individual ribbon segments to draw. Works for 1-to-many, many-to-1, or
   many-to-many without needing to know which dollar paid for what. */
function sankeyFlows(sources, targets, scale){
  const flows = [];
  let si = 0;
  if(!sources.length || !targets.length) return flows;
  let sRemain = sources[0].value, sCursor = sources[0].y0;
  targets.forEach(t=>{
    let tRemain = t.value, tCursor = t.y0;
    while(tRemain > 0.0005 && si < sources.length){
      const amt = Math.min(tRemain, sRemain);
      if(amt > 0.0005){
        flows.push({ sy0:sCursor, sy1:sCursor+amt*scale, ty0:tCursor, ty1:tCursor+amt*scale, sourceColor: sources[si]._color, targetColor: t._color });
        sCursor += amt*scale; tCursor += amt*scale;
        sRemain -= amt; tRemain -= amt;
      }
      if(sRemain <= 0.0005){ si++; if(si<sources.length){ sRemain = sources[si].value; sCursor = sources[si].y0; } }
    }
  });
  return flows;
}

function renderSankeySVG(data, y){
  const NODE_W = 16, GAP = 11, TOP = 26, LABEL_MIN_H = 24;
  const incomeExpanded = data.inNodes.some(n=>n.id==='grp:income' && n.children.length && isSankeyNodeExpanded(n.id));
  const expandedOut = data.outNodes.filter(n=>n.children && n.children.length && isSankeyNodeExpanded(n.id));
  const hasOutExpansion = expandedOut.length > 0;

  const colHeight = (nodes, scale) => nodes.length
    ? nodes.reduce((a,n)=>a+Math.max(n.value*scale,1.5),0) + GAP*(nodes.length-1)
    : 0;

  // Fix the $-per-px scale directly from a baseline height — independent of
  // how tall the content ends up, so there's no risk of the two circling
  // each other and diverging.
  const BASE_VALUE_HEIGHT = 420;
  const scale = BASE_VALUE_HEIGHT / data.grandTotal;

  // A node that's expanded may need MORE vertical room for its children than
  // its own $-driven height — reserve that extra room in the column layout
  // itself, so the next sibling gets pushed down instead of the expanded
  // children spilling over and colliding with whatever comes next.
  const reserveOut = (n) => (n.children && n.children.length && isSankeyNodeExpanded(n.id)) ? colHeight(n.children, scale) : 0;
  const reserveIn = (n) => (n.id==='grp:income' && incomeExpanded) ? colHeight(n.children, scale) : 0;

  const inLayout = sankeyLayoutColumn(data.inNodes, scale, TOP, GAP, reserveIn);
  const outLayout = sankeyLayoutColumn(data.outNodes, scale, TOP, GAP, reserveOut);
  const inLaid = inLayout.nodes, outLaid = outLayout.nodes;

  // The true plot height is simply how far each column's own layout (now
  // collision-safe) actually extends — no separate estimation needed.
  const plotH = Math.max(inLayout.bottom, outLayout.bottom, TOP + 260) - TOP;
  const svgH = TOP + plotH + 26;

  // Lay out columns left→right, growing the canvas only as far as needed.
  const LABEL_ZONE = 226, FLOW_GAP = 250, EXPAND_GAP = 70;
  let x = 8;
  let col0X = null;
  if(incomeExpanded){ col0X = x; x += NODE_W + LABEL_ZONE + EXPAND_GAP; }
  const colInX = x; x += NODE_W + LABEL_ZONE + FLOW_GAP;
  const colOutX = x; x += NODE_W + LABEL_ZONE;
  let col4X = null;
  if(hasOutExpansion){ x += EXPAND_GAP; col4X = x; x += NODE_W + LABEL_ZONE; }
  const svgW = x + 10;

  function nodeColor(n, idx){
    if(n.kind==='category' || n.kind==='group') return PALETTE[idx % PALETTE.length];
    return SANKEY_KIND_COLOR[n.kind] || PALETTE[idx % PALETTE.length];
  }
  inLaid.forEach((n,i)=> n._color = nodeColor(n,i));
  outLaid.forEach((n,i)=> n._color = nodeColor(n,i));

  let col0Laid = [];
  if(incomeExpanded){
    const incomeParent = inLaid.find(n=>n.id==='grp:income');
    col0Laid = sankeyLayoutColumn(incomeParent.children, scale, incomeParent.y0, GAP).nodes;
    col0Laid.forEach((n,i)=> n._color = nodeColor(n, i+2));
  }

  const childCols = {};
  expandedOut.forEach(n=>{
    const parent = outLaid.find(o=>o.id===n.id);
    const laid = sankeyLayoutColumn(n.children, scale, parent.y0, GAP).nodes;
    laid.forEach((k,i)=> k._color = PALETTE[(i+3) % PALETTE.length]);
    childCols[n.id] = laid;
  });

  let defs = `<filter id="skShadow" x="-60%" y="-60%" width="220%" height="220%">
      <feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000" flood-opacity="0.4"/>
    </filter>
    <linearGradient id="skSheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="20%" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.10"/>
    </linearGradient>`;
  let links = '', nodesHtml = '';
  let gradId = 0;

  function nodeRect(x, n, color, extraAttrs, titleText, extraClass){
    const h = n.y1 - n.y0;
    const cls = 'sk-node' + (extraClass ? ' '+extraClass : '');
    return `<g filter="url(#skShadow)">
      <rect x="${x}" y="${n.y0}" width="${NODE_W}" height="${h}" rx="3.5" fill="${color}" class="${cls}" ${extraAttrs}><title>${titleText}</title></rect>
      <rect x="${x}" y="${n.y0}" width="${NODE_W}" height="${h}" rx="3.5" fill="url(#skSheen)" pointer-events="none"/>
    </g>`;
  }

  function drawFlows(x0, x1, sources, targets){
    sankeyFlows(sources, targets, scale).forEach(f=>{
      gradId++;
      const gid = `skgrad${y}_${gradId}`;
      defs += `<linearGradient id="${gid}" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0%" stop-color="${f.sourceColor}" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="${f.targetColor}" stop-opacity="0.16"/>
      </linearGradient>`;
      links += `<path d="${sankeyRibbon(x0,x1,f.sy0,f.sy1,f.ty0,f.ty1)}" fill="url(#${gid})" class="sk-link"/>`;
    });
  }

  /* "Other" buckets can't be expanded past col4 (no 5th column) — instead of
     a caret that does nothing, their tooltip just lists what's inside. */
  function nodeTitle(n){
    if(n.kind !== 'other') return `${n.name}: ${fmt$(n.value,2)}`;
    const list = n.children.map(c=>`${c.name} ${fmt$(c.value,2)}`).join('  ·  ');
    return `${n.name} — ${fmt$(n.value,2)} total:  ${list}`;
  }

  // Long names ("College expenses (car, gas, coffee, flights...)") would run
  // off the edge of the diagram — trim to a sensible length at a word
  // boundary for the label itself; the full name is always still in the
  // hover tooltip via nodeTitle.
  function shortName(name, maxChars){
    maxChars = maxChars || 26;
    const s = String(name).trim();
    if(s.length <= maxChars) return s;
    let cut = s.slice(0, maxChars);
    const lastSpace = cut.lastIndexOf(' ');
    if(lastSpace > maxChars*0.5) cut = cut.slice(0, lastSpace);
    return cut.replace(/[\s/,-]+$/, '') + '…';
  }

  function addNodeLabel(x, n, align, expandable){
    const midY = (n.y0+n.y1)/2;
    const h = n.y1-n.y0;
    const pct = data.grandTotal>0 ? ((n.value/data.grandTotal)*100).toFixed(1) : '0.0';
    const tx = align==='right' ? x+NODE_W+9 : x-9;
    const anchor = align==='right' ? 'start' : 'end';
    const canExpand = expandable!==false && n.children && n.children.length;
    const caret = canExpand ? (isSankeyNodeExpanded(n.id) ? '▾ ' : '▸ ') : '';
    const label = shortName(n.name);
    // Always show at least a compact one-line label, WITH percentage — a
    // thin bar (a small dollar amount) is exactly the case where a hidden
    // label or missing percentage is most confusing, since there's nothing
    // else on screen identifying it.
    if(h >= LABEL_MIN_H){
      nodesHtml += `<text x="${tx}" y="${midY-4}" text-anchor="${anchor}" class="sk-label-name">${caret}${label}</text>
        <text x="${tx}" y="${midY+11}" text-anchor="${anchor}" class="sk-label-val">${fmt$(n.value,0)} <tspan class="sk-label-pct">(${pct}%)</tspan></text>`;
    } else {
      nodesHtml += `<text x="${tx}" y="${midY+4}" text-anchor="${anchor}" class="sk-label-name">${caret}${label} · ${fmt$(n.value,0)} <tspan class="sk-label-pct">(${pct}%)</tspan></text>`;
    }
  }

  // ---- Column 0: individual income sources (only if Income is expanded) ----
  if(incomeExpanded){
    const incomeTarget = inLaid.find(n=>n.id==='grp:income');
    drawFlows(col0X+NODE_W, colInX, col0Laid, [incomeTarget]);
    col0Laid.forEach(n=>{
      nodesHtml += nodeRect(col0X, n, n._color, `data-sankey-goto="income"`, nodeTitle(n));
      addNodeLabel(col0X, n, 'right', false);
    });
  }

  // ---- Column: Income / From Savings·Credit ----
  drawFlows(colInX+NODE_W, colOutX, inLaid, outLaid);
  inLaid.forEach(n=>{
    let clickAttr = '';
    if(n.kind==='income'){
      clickAttr = n.children.length ? `data-sankey-toggle="${n.id}"` : `data-sankey-goto="income"`;
    } else if(n.kind==='shortfall'){
      clickAttr = `data-sankey-goto="cashflow"`;
    }
    const titleSuffix = n.children.length ? ' — click to '+(incomeExpanded?'collapse':'expand') : '';
    nodesHtml += nodeRect(colInX, n, n._color, clickAttr, `${nodeTitle(n)}${titleSuffix}`, incomeExpanded && n.id==='grp:income' ? 'sk-node-expanded' : '');
    addNodeLabel(colInX, n, 'right');
  });

  // ---- Column: where it went ----
  outLaid.forEach(n=>{
    const isExpanded = expandedOut.some(e=>e.id===n.id);
    let clickAttr = '';
    if(n.children && n.children.length){
      clickAttr = `data-sankey-toggle="${n.id}"`;
    } else if(n.kind==='group'){
      clickAttr = `data-sankey-goto="expenses" data-sankey-highlight="[data-group-id=&quot;${n.groupId}&quot;]"`;
    } else if(n.kind==='investments'){
      clickAttr = `data-sankey-goto="investments"`;
    } else if(n.kind==='debt'){
      clickAttr = `data-sankey-goto="debt"`;
    } else if(n.kind==='retirement'){
      clickAttr = `data-sankey-goto="savings"`;
    } else if(n.kind==='savings'){
      clickAttr = `data-sankey-goto="cashflow"`;
    }
    const titleSuffix = n.children&&n.children.length ? ' — click to '+(isExpanded?'collapse':'expand') : '';
    nodesHtml += nodeRect(colOutX, n, n._color, clickAttr, `${nodeTitle(n)}${titleSuffix}`, isExpanded?'sk-node-expanded':'');
    addNodeLabel(colOutX, n, 'right');

    if(isExpanded){
      const kids = childCols[n.id];
      drawFlows(colOutX+NODE_W, col4X, [n], kids);
      kids.forEach(k=>{
        let kAttr = '';
        if(k.kind==='category') kAttr = `data-sankey-goto="expenses" data-sankey-highlight="[data-group-id=&quot;${k.parentGroupId}&quot;]"`;
        else if(k.kind==='investmentItem') kAttr = `data-sankey-goto="investments"`;
        else if(k.kind==='debtItem') kAttr = `data-sankey-goto="debt" data-sankey-highlight="[data-debt-id=&quot;${k.debtId}&quot;]"`;
        else if(k.kind==='retirementItem') kAttr = `data-sankey-goto="savings"`;
        // k.kind==='other' at this depth intentionally gets no click — there's
        // no 5th column to expand into, so its tooltip lists the contents instead.
        nodesHtml += nodeRect(col4X, k, k._color, kAttr, nodeTitle(k));
        addNodeLabel(col4X, k, 'right', false);
      });
    }
  });


  return `
  <div class="sankey-scroll">
    <svg viewBox="0 0 ${svgW} ${svgH}" class="sankey-svg" style="aspect-ratio:${svgW}/${svgH};" preserveAspectRatio="xMinYMin meet">
      <defs>${defs}</defs>
      <g class="sk-links">${links}</g>
      <g class="sk-nodes">${nodesHtml}</g>
    </svg>
  </div>`;
}


function attachSankeyHandlers(){
  document.querySelectorAll('#sankeyWrap [data-sankey-toggle]').forEach(el=>{
    el.style.cursor = 'pointer';
    el.addEventListener('click', ()=>{
      const key = el.getAttribute('data-sankey-toggle');
      sankeyExpanded[key] = !isSankeyNodeExpanded(key);
      refreshSankey();
    });
  });
  document.querySelectorAll('#sankeyWrap [data-sankey-goto]').forEach(el=>{
    el.style.cursor = 'pointer';
    el.addEventListener('click', ()=>{
      goToTab(el.getAttribute('data-sankey-goto'), el.getAttribute('data-sankey-highlight') || undefined);
    });
  });
}

function refreshSankey(){
  const y = state.year;
  const wrap = document.getElementById('sankeyWrap');
  if(!wrap) return;
  wrap.innerHTML = renderSankeySVG(buildSankeyData(y), y);
  attachSankeyHandlers();
}

/* =========================================================================
   UPCOMING RECURRING INVESTMENTS  —  pulled straight from the same
   recurring-buy plans set up on individual holdings (Holdings → 🔁), just
   filtered to "not happened yet" and sorted by date. Read-only here; go to
   Holdings to edit/confirm a plan.
   ========================================================================= */
function buildUpcomingRecurring(y){
  // Defensive: don't assume Holdings' migration already ran for this year.
  if(typeof ensureHoldingsMigration === 'function') ensureHoldingsMigration();
  const investments = yearData(y).investments || [];
  const fx = (typeof _ensureFx === 'function') ? (_ensureFx().INR || 95.0)
    : ((typeof fxRates!=='undefined' && fxRates && fxRates.INR) ? fxRates.INR : 95.0);
  const today = new Date(); today.setHours(0,0,0,0);
  const todayISO = today.toISOString().slice(0,10);

  const rows = [];
  investments.forEach(inv=>{
    const isINR = inv.currency === 'INR';
    (inv.holdings || []).forEach(h=>{
      if(!h.recurring || !h.recurring.active) return;
      const norm = _normalizedRecurring(h.recurring);
      const hasSchedule = norm.frequencyType === 'daysOfMonth' ? (norm.daysOfMonth && norm.daysOfMonth.length) : !!norm.startDate;
      if(!hasSchedule) return;
      const nextDate = nextRecurringDateForPlan(norm);
      if(!nextDate || nextDate < todayISO) return; // no date, or already in the past — not "upcoming"
      const amountNative = num(norm.amount);
      if(amountNative <= 0) return; // guard against a stray $0 plan
      const amountUsd = isINR ? amountNative / fx : amountNative;
      rows.push({
        platformId: inv.id, platformName: inv.name || 'Unnamed platform', isINR,
        symbol: h.symbol || h.name || '—', name: h.name,
        amountNative, amountUsd,
        scheduleLabel: recurringScheduleLabel(norm),
        nextDate, alreadyConfirmed: !!(nextDate && norm.lastConfirmedFor === nextDate)
      });
    });
  });
  rows.sort((a,b)=> a.nextDate < b.nextDate ? -1 : a.nextDate > b.nextDate ? 1 : a.platformName.localeCompare(b.platformName));

  const byPlatform = {};
  rows.forEach(r=>{
    if(!byPlatform[r.platformId]) byPlatform[r.platformId] = { platformId:r.platformId, name:r.platformName, totalUsd:0, count:0 };
    byPlatform[r.platformId].totalUsd += r.amountUsd;
    byPlatform[r.platformId].count += 1;
  });
  const platformTotals = Object.values(byPlatform).sort((a,b)=> b.totalUsd - a.totalUsd);
  const colorOf = {};
  platformTotals.forEach((p,i)=> colorOf[p.platformId] = PALETTE[i % PALETTE.length]);

  // Group by calendar date — this is the number that actually matters for
  // "do I have enough in the bank on that day", since several plans can
  // land on the same date across different platforms. Within each date,
  // also split by platform — the thing you actually need before transferring
  // money is "how much goes into Fidelity today" vs the flat day total.
  const byDate = {};
  rows.forEach(r=>{
    if(!byDate[r.nextDate]) byDate[r.nextDate] = { date:r.nextDate, totalUsd:0, rows:[], byPlatform:{} };
    const g = byDate[r.nextDate];
    g.totalUsd += r.amountUsd;
    g.rows.push(r);
    if(!g.byPlatform[r.platformId]) g.byPlatform[r.platformId] = { platformId:r.platformId, name:r.platformName, totalUsd:0, count:0 };
    g.byPlatform[r.platformId].totalUsd += r.amountUsd;
    g.byPlatform[r.platformId].count += 1;
  });
  const dateGroups = Object.values(byDate).sort((a,b)=> a.date < b.date ? -1 : 1);
  dateGroups.forEach(g=>{ g.platformBreakdown = Object.values(g.byPlatform).sort((a,b)=> b.totalUsd - a.totalUsd); });

  return { rows, dateGroups, platformTotals, colorOf, grandTotalUsd: sumArr(rows.map(r=>r.amountUsd)) };
}

function _fmtUpcomingDate(iso){
  const d = new Date(iso+'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diffDays = Math.round((d-today)/86400000);
  if(diffDays===0) return 'Today';
  if(diffDays===1) return 'Tomorrow';
  if(diffDays>1 && diffDays<=6) return d.toLocaleDateString('en-US',{weekday:'short', month:'short', day:'numeric'});
  const opts = { month:'short', day:'numeric' };
  if(d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

function renderUpcomingRecurringCard(y){
  const data = buildUpcomingRecurring(y);

  if(!data.rows.length){
    // Distinguish "nothing set up" from "nothing due soon" so the message
    // actually points to something actionable.
    const anyPlansAtAll = (yearData(y).investments||[]).some(inv=>(inv.holdings||[]).some(h=>h.recurring && h.recurring.active));
    const msg = anyPlansAtAll
      ? `No upcoming occurrences — your recurring plans may have already been confirmed, or their next dates fall later than what's tracked.`
      : `No recurring buys set up yet. Head to Holdings and click 🔁 on a position to schedule one.`;
    return `
    <div class="card">
      <div class="card-head"><h3>Upcoming recurring investments</h3></div>
      <div class="section-sub" style="padding:14px 0; text-align:center; margin:0;">${msg}</div>
    </div>`;
  }

  const chips = data.platformTotals.map(p=>`
    <div class="recur-chip" style="border-color:${data.colorOf[p.platformId]}44;">
      <span class="recur-chip-dot" style="background:${data.colorOf[p.platformId]};"></span>
      <span class="recur-chip-name">${p.name}</span>
      <span class="recur-chip-amt">${fmt$(p.totalUsd,2)}</span>
      <span class="recur-chip-count">${p.count} buy${p.count===1?'':'s'}</span>
    </div>`).join('');

  const rowsHtml = data.dateGroups.map(g=>{
    const rowsForDate = g.rows.map(r=>{
      const color = data.colorOf[r.platformId];
      const displayAmt = r.isINR ? fmt$(r.amountUsd,2) : fmt$(r.amountNative,2);
      const tip = r.isINR ? `data-tip="${fmtInr(r.amountNative).replace(/"/g,'&quot;')}" class="has-tip"` : '';
      return `
      <div class="recur-row" data-recur-goto="1" title="Open in Holdings">
        <span class="recur-row-dot" style="background:${color};"></span>
        <div class="recur-row-main">
          <div class="recur-row-name">${r.symbol}${r.name && r.name!==r.symbol ? ` <span class="recur-row-sub">· ${r.name}</span>` : ''}${r.alreadyConfirmed ? ' <span class="recur-row-confirmed">✓ confirmed</span>' : ''}</div>
          <div class="recur-row-platform">${r.platformName} · <span class="recur-row-schedule">${r.scheduleLabel}</span></div>
        </div>
        <div class="recur-row-amt" ${tip}>${displayAmt}</div>
      </div>`;
    }).join('');
    const multi = g.rows.length > 1;
    // Spell out exactly how much goes into each platform due that day —
    // shown whether there's one platform or several, so "Fidelity: $200" is
    // always visible, not just when there's a split to explain.
    const platformSplitHtml = `
      <div class="recur-date-split">
        <span class="recur-date-split-label">${g.platformBreakdown.length>1?'Split by account:':'Account:'}</span>
        ${g.platformBreakdown.map(p=>`
          <span class="recur-split-chip" style="border-color:${data.colorOf[p.platformId]}55;">
            <span class="recur-chip-dot" style="background:${data.colorOf[p.platformId]};"></span>
            ${p.name} <b>${fmt$(p.totalUsd,2)}</b>
          </span>`).join('')}
      </div>`;
    return `
    <div class="recur-date-group">
      <div class="recur-date-head">
        <span class="recur-date-label">${_fmtUpcomingDate(g.date)}</span>
        <span class="recur-date-total">${fmt$(g.totalUsd,2)}${multi ? ` <span class="recur-date-count">needed · ${g.rows.length} plans</span>` : ` <span class="recur-date-count">needed</span>`}</span>
      </div>
      ${platformSplitHtml}
      ${rowsForDate}
    </div>`;
  }).join('');

  return `
  <div class="card">
    <div class="card-head"><h3>Upcoming recurring investments</h3><span class="section-sub" style="margin:0;">${fmt$(data.grandTotalUsd,2)} scheduled across ${data.platformTotals.length} platform${data.platformTotals.length===1?'':'s'}</span></div>
    <div class="recur-chips">${chips}</div>
    <div class="recur-list">${rowsHtml}</div>
    <div class="section-sub" style="margin:10px 0 0;">Click any plan to open it in Holdings.</div>
  </div>`;
}

/* =========================================================================
   SAVINGS GOALS — small side card next to Debt runway. Reuses the same
   goal helpers as the Savings tab so progress here always matches there.
   ========================================================================= */
function renderSavingsGoalsMiniCard(y){
  if(typeof ensureGoalsMigration === 'function') ensureGoalsMigration();
  const goals = yearData(y).savingsGoals || [];
  const accounts = yearData(y).savingsAccounts || [];
  const latest = findLatestMonthWithData(y);
  const monthIdx = latest>=0 ? latest : 0;

  if(!goals.length){
    return `
    <div class="card mini-goals-card">
      <div class="card-head"><h3>Saving goals</h3></div>
      <div class="section-sub" style="padding:14px 0; text-align:center; margin:0;">No goals yet — add one on the Savings tab.</div>
    </div>`;
  }

  const items = goals.slice(0,4).map((g,i)=>{
    const target = goalTargetUsd(g, accounts);
    const contributed = goalContributedUsd(g, accounts, monthIdx);
    const pct = target>0 ? Math.min(100, (contributed/target)*100) : 0;
    const color = PALETTE[i % PALETTE.length];
    return `
    <div class="mini-goal-row" data-goto="savings" data-savings-goto-sub="goals">
      <div class="mini-goal-icon" style="background:${color}22; color:${color};">${g.icon||'🎯'}</div>
      <div class="mini-goal-main">
        <div class="mini-goal-name">${g.name}</div>
        <div class="mini-goal-amt">${fmt$(contributed,2)} of ${fmt$(target,2)}</div>
        <div class="runway"><div class="runway-fill" style="width:${pct}%; background:${color};"></div></div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="card mini-goals-card">
    <div class="card-head"><h3>Saving goals</h3><span class="mini-card-link" data-goto="savings" data-savings-goto-sub="goals">Show more ›</span></div>
    <div class="mini-goal-list">${items}</div>
  </div>`;
}

function renderOverview(){
  const y = state.year;
  const prevY = y-1;
  const hasPrevYear = !!DATA[prevY];
  const incT = incomeTotals(y), expT = expenseTotalsCounted(y), cardT = expenseTotalsExcluded(y);
  const incNow = sumArr(incT), expNow = sumArr(expT), cardNow = sumArr(cardT);
  const net = incNow - expNow; 
  const hasExcluded = yearData(y).expenseGroups.some(g=>g.excludeFromTotal);

  const incPrevYear = hasPrevYear ? sumArr(incomeTotals(prevY)) : 0;
  const expPrevYear = hasPrevYear ? sumArr(expenseTotalsCounted(prevY)) : 0;

  const cfRows = computeCashFlow(y);
  const cfIdx = findLatestMonthWithData(y);
  const cashOnHand = cfRows[cfIdx].carryOut;
  const cashPrevMonth = cfIdx>0 ? cfRows[cfIdx-1].carryOut : null;

  const fx = (typeof fxRates !== 'undefined' && fxRates && fxRates.INR) ? fxRates.INR : 84.0;
  const invCurrent = sumArr(yearData(y).investments.map(i => {
    if (i.currency === 'INR') return num(i.currentValue) / fx;
    return num(i.currentValue);
  }));

  const savingsCurrent = sumArr((yearData(y).savingsAccounts||[]).map(acc=>{
    const latest = findLatestMonthWithData(y);
    const bal = num((acc.m||[])[latest>=0?latest:0]);
    return acc.currency==='INR' ? bal/fx : bal;
  }));
  const retirementCurrent = sumArr((yearData(y).retirementAccounts||[]).map(r=>retirementAccountTotalBalance(r)));

  const debts = yearData(y).debts;
  const debtPending = sumArr(debts.map(d=>debtPendingCalc(d)));
  const netWorth = cashOnHand + invCurrent + savingsCurrent + retirementCurrent - debtPending;

  const deltaHtml = (curr,prev,inverse)=>{
    if(!hasPrevYear) return `<div class="kpi-delta flat">no ${prevY} data to compare</div>`;
    if(prev===0 && curr===0) return `<div class="kpi-delta flat">flat vs ${prevY}</div>`;
    const d = prev===0 ? 100 : ((curr-prev)/Math.abs(prev))*100;
    const goodDir = inverse ? d<=0 : d>=0;
    const arrow = d>=0 ? '▲' : '▼';
    return `<div class="kpi-delta ${goodDir?'up':'down'}">${arrow} ${Math.abs(d).toFixed(1)}% vs ${prevY}</div>`;
  };

  const html = `
  <div class="section-title">Overview</div>
  <p class="section-sub">Full-year snapshot for ${y}${hasPrevYear?', compared against '+prevY:''} — the KPI cards and charts below always show the whole year, regardless of the month selector above (that selector still drives Cash Flow, Expenses, and Debt Payoff). The <b>"Where it went"</b> diagram further down is the one exception — it follows the month selector, so pick a specific month up top to see just that month's flow. Click any card or chart segment to jump to where that figure comes from.</p>

  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fit, minmax(170px,1fr));">
    <!-- NET WORTH: now first -->
    <div class="kpi-card ${netWorth>=0?'c-gold':'c-danger'}">
      <div class="kpi-label">Net Worth</div>
      <div class="kpi-value">${fmt$(netWorth)}</div>
      <div class="kpi-delta flat">cash + investments + savings + retirement − debt</div>
    </div>

    <div class="kpi-card c-gold clickable" data-goto="income">
      <div class="kpi-label">Income (${y})</div>
      <div class="kpi-value">${fmt$(incNow)}</div>
      ${deltaHtml(incNow, incPrevYear)}
    </div>
    <div class="kpi-card c-rust clickable" data-goto="expenses">
      <div class="kpi-label">Expenses (${y})</div>
      <div class="kpi-value">${fmt$(expNow)}</div>
      ${deltaHtml(expNow, expPrevYear, true)}
    </div>

    <!-- NET SAVINGS: hidden for now -->
    <!--
    <div class="kpi-card ${net>=0?'c-teal':'c-danger'}">
      <div class="kpi-label">Net Savings (${y})</div>
      <div class="kpi-value">${fmt$(net)}</div>
      ${deltaHtml(net, incPrevYear-expPrevYear)}
    </div>
    -->

    <div class="kpi-card c-gold clickable" data-goto="cashflow">
      <div class="kpi-label">Cash on Hand, end of ${MONTHS[cfIdx]}</div>
      <div class="kpi-value">${fmt$(cashOnHand)}</div>
      ${cashPrevMonth===null ? '<div class="kpi-delta flat">no prior month in '+y+'</div>' : `<div class="kpi-delta ${cashOnHand>=cashPrevMonth?'up':'down'}">${cashOnHand>=cashPrevMonth?'▲':'▼'} ${fmt$(Math.abs(cashOnHand-cashPrevMonth))} vs ${MONTHS[cfIdx-1]}</div>`}
    </div>
    <div class="kpi-card c-teal clickable" data-goto="investments">
      <div class="kpi-label">Invested (current value)</div>
      <div class="kpi-value">${fmt$(invCurrent)}</div>
      <div class="kpi-delta flat">across ${yearData(y).investments.length} holdings</div>
    </div>
    <div class="kpi-card c-danger clickable" data-goto="debt">
      <div class="kpi-label">Debt Remaining</div>
      <div class="kpi-value">${fmt$(debtPending)}</div>
      <div class="kpi-delta flat">across ${debts.filter(d=>debtPendingCalc(d)>0).length} open loans</div>
    </div>
  </div>

  ${hasExcluded ? `<div class="notice">Card payments of <b>${fmt$(cardNow)}</b> this year aren't added into Expenses above — they're excluded by default since those purchases are already counted under their own category (groceries, dining, etc.) when you swipe. They still reduce your real cash balance though — see the <b>Cash Flow</b> tab.</div>` : ''}

  <div class="card">
    <div class="card-head"><h3>Income vs. expenses, month by month</h3></div>
    <div class="chart-box tall"><canvas id="chartTrend"></canvas></div>
  </div>

  <div class="card sankey-card">
    <div class="card-head"><h3>Where ${state.month==='ALL'||state.month===undefined ? y : MONTHS[Number(state.month)]+' '+y} went</h3></div>
    <div id="sankeyWrap">${renderSankeySVG(buildSankeyData(y), y)}</div>
    <div class="section-sub" style="margin-top:10px; margin-bottom:0;">Click a bar with a ▸ to open its breakdown · click any other bar to jump to that tab. Change the month up top to see a different period.</div>
  </div>

  ${renderUpcomingRecurringCard(y)}

  <div class="overview-split-row">
    <div class="card">
      <div class="card-head"><h3>Debt runway</h3><span class="section-sub" style="margin:0;">${fmt$(debtPending)} left of ${fmt$(sumArr(debts.map(d=>debtOriginalUsd(d))))} originally owed · click a bar to open that loan</span></div>
      <div class="chart-box short"><canvas id="chartDebtMini"></canvas></div>
    </div>
    ${renderSavingsGoalsMiniCard(y)}
  </div>
  `;
  document.getElementById('panel-overview').innerHTML = html;

  document.querySelectorAll('#panel-overview [data-goto]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const sub = el.dataset.savingsGotoSub;
      if(sub && el.dataset.goto==='savings') state.savingsSubTab = sub;
      goToTab(el.dataset.goto);
    });
  });
  document.querySelectorAll('#panel-overview [data-recur-goto]').forEach(el=>{
    el.addEventListener('click', ()=> goToTab('holdings'));
  });
  attachSankeyHandlers();

  destroyChart('trend'); destroyChart('debtmini');

  const netT = MONTHS.map((_,i)=> num(incT[i]) - num(expT[i]));
  charts.trend = safeChart(document.getElementById('chartTrend'), {
    type:'bar',
    data:{ labels:MONTHS, datasets:[
      {type:'bar', label:'Income', data:incT, backgroundColor:'#C9A961', borderRadius:4, barPercentage:0.6, order:2},
      {type:'bar', label:'Expenses', data:expT, backgroundColor:'#C06A46', borderRadius:4, barPercentage:0.6, order:2},
      {type:'line', label:'Net', data:netT, borderColor:'#EEE7D8', backgroundColor:'#EEE7D8', borderWidth:2,
        tension:0.4, cubicInterpolationMode:'monotone', fill:false, pointRadius:3, pointBackgroundColor:'#EEE7D8',
        pointBorderColor:'#0F1719', pointBorderWidth:1, order:1},
    ]},
    options:{ responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10, boxHeight:10}}},
      onClick:(evt,els)=>{ if(els.length && els[0].datasetIndex!==2) goToTab(els[0].datasetIndex===0?'income':'expenses'); },
      onHover:(evt,els)=>{ evt.native.target.style.cursor = els.length?'pointer':'default'; },
      scales:{ y:{ grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v}}, x:{grid:{display:false}} } }
  });

  const debtsSorted = debts.slice().sort((a,b)=> debtPendingCalc(b)-debtPendingCalc(a));
  charts.debtmini = safeChart(document.getElementById('chartDebtMini'), {
    type:'bar',
    data:{ labels: debtsSorted.map(d=>d.name), datasets:[
      {label:'Cleared', data:debtsSorted.map(d=>debtClearedToDate(d)), backgroundColor:'#6FA491', stack:'s'},
      {label:'Pending', data:debtsSorted.map(d=>debtPendingCalc(d)), backgroundColor:'#C06A46', stack:'s'}
    ]},
    options:{ indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{legend:{labels:{boxWidth:10,boxHeight:10}}},
      onClick:(evt,els)=>{ if(els.length){ const d=debtsSorted[els[0].index]; goToTab('debt', `[data-debt-id="${d.id}"]`); } },
      onHover:(evt,els)=>{ evt.native.target.style.cursor = els.length?'pointer':'default'; },
      scales:{ x:{ stacked:true, grid:{color:'#26332F'}, ticks:{callback:v=>'$'+v} }, y:{stacked:true, grid:{display:false}} } }
  });
}
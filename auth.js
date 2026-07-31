/* =========================================================================
   ACCESS GATE — a soft PIN lock, not real security (see caveat shown on screen)
   ========================================================================= */
const ADMIN_PIN = '7663';
const READONLY_PIN = '0906';
const SESSION_KEY = 'ledger:session:v1';
const SESSION_TTL_MS = 12*60*60*1000; // remembered for 12 hours, then re-prompts
let currentRole = null;

async function tryRememberedSession(){
  try{
    if(typeof window.storage === 'undefined') return null;
    const res = await window.storage.get(SESSION_KEY, false);
    if(res && res.value){
      const s = JSON.parse(res.value);
      if(s && s.role && s.expiresAt && Date.now() < s.expiresAt) return s.role;
    }
  }catch(e){ /* no remembered session — fall through to PIN prompt */ }
  return null;
}
async function rememberSession(role){
  try{ await window.storage.set(SESSION_KEY, JSON.stringify({role, expiresAt: Date.now()+SESSION_TTL_MS}), false); }catch(e){}
}
async function forgetSession(){
  try{ await window.storage.delete(SESSION_KEY, false); }catch(e){}
}

function showPinOverlay(onSuccess){
  const old = document.getElementById('pinOverlay');
  if(old) old.remove();
  const overlay = document.createElement('div');
  overlay.id = 'pinOverlay';
  overlay.className = 'pin-overlay';
  overlay.innerHTML = `
    <div class="pin-card">
      <h2>The Ledger</h2>
      <p>Enter your 4-digit PIN</p>
      <div class="pin-dots" id="pinDots">${'<span class="pin-dot"></span>'.repeat(4)}</div>
      <div class="pin-keypad" id="pinKeypad">
        ${[1,2,3,4,5,6,7,8,9].map(n=>`<button class="pin-key" data-num="${n}">${n}</button>`).join('')}
        <button class="pin-key" data-action="clear">Clear</button>
        <button class="pin-key" data-num="0">0</button>
        <button class="pin-key" data-action="back">⌫</button>
      </div>
      <div class="pin-error" id="pinError">&nbsp;</div>
      <div class="pin-caveat">This PIN only keeps the ledger from casual glances — the code lives in this page itself, so it isn't real security. Don't rely on it to protect anything you truly need to keep private. Once entered, it's remembered for 12 hours so you won't be asked on every refresh.</div>
    </div>
  `;
  document.body.appendChild(overlay);
  let entered = '';
  const dotsEl = ()=>overlay.querySelectorAll('.pin-dot');
  function updateDots(){ dotsEl().forEach((d,i)=> d.classList.toggle('filled', i<entered.length)); }
  function tryPin(){
    if(entered===ADMIN_PIN){ overlay.remove(); rememberSession('admin'); onSuccess('admin'); }
    else if(entered===READONLY_PIN){ overlay.remove(); rememberSession('readonly'); onSuccess('readonly'); }
    else{
      overlay.querySelector('#pinError').textContent = 'Incorrect PIN — try again';
      entered=''; updateDots();
    }
  }
  overlay.querySelectorAll('[data-num]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      if(entered.length>=4) return;
      entered += btn.dataset.num;
      updateDots();
      if(entered.length===4) tryPin();
    });
  });
  overlay.querySelector('[data-action="clear"]').addEventListener('click', ()=>{ entered=''; updateDots(); overlay.querySelector('#pinError').textContent='\u00a0'; });
  overlay.querySelector('[data-action="back"]').addEventListener('click', ()=>{ entered=entered.slice(0,-1); updateDots(); });
}

function applyReadOnlyGuard(){
  if(currentRole!=='readonly') return;
  document.querySelectorAll('[contenteditable="true"]').forEach(el=>{ el.contentEditable='false'; el.classList.add('ro-locked'); });
  document.querySelectorAll('.row-del').forEach(el=> el.style.display='none');
  document.querySelectorAll('#panels button, #panels input, #panels select').forEach(el=>{ el.disabled = true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; });
  const hsb = document.getElementById('headerSaveBtn'); if(hsb) hsb.style.display='none';
  const bar = document.getElementById('saveBar'); if(bar) bar.classList.remove('show');
}

async function proceedAfterAuth(role){
  currentRole = role;
  const panelsEl = document.getElementById('panels');
  panelsEl.innerHTML = '<div class="section-sub" id="bootStatus" style="padding:30px 0;">Loading charting library…</div>';

  const chartOk = await loadFirstWorking(CHART_SOURCES, ()=>typeof Chart!=='undefined');
  if(chartOk){
    Chart.defaults.color = '#A2AEA9';
    Chart.defaults.font.family = "'IBM Plex Mono', monospace";
    Chart.defaults.font.size = 11;
    Chart.defaults.borderColor = '#33433F';
  }
  if(!chartOk){
    document.getElementById('bootStatus').innerHTML =
      '<span style="color:var(--danger)">Could not load the charting library from any CDN.</span> ' +
      'This can happen if your network blocks cdnjs.cloudflare.com / jsdelivr.net / unpkg.com. ' +
      'Everything except the charts (tables, editing, debt calculator, import) will still work below once you continue.';
  }
  const xlsxOk = await loadFirstWorking(XLSX_SOURCES, ()=>typeof XLSX!=='undefined');

  await probeStorage();
  await loadData();
  await loadLogs();
  await logAccess(role);
  panelsEl.innerHTML = '';
  initShell();
  renderActive();

  if(!xlsxOk){
    showToast('Spreadsheet import unavailable (library failed to load)');
  }
}

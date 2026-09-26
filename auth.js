/* =========================================================================
   ACCESS GATE — a soft PIN lock, not real security (see caveat shown on screen)
   ========================================================================= */
const ADMIN_PIN = '2186';
const READONLY_PIN = '3868';
const SESSION_KEY = 'ledger:session:v1';
const SESSION_TTL_MS = 0; // remembered for 12 hours, then re-prompts
let currentRole = null;

/* BUGFIX (#19a): there used to be no limit on wrong-PIN attempts at all —
   someone (or a script) could sit there guessing all 10,000 four-digit
   combinations with nothing slowing them down. This adds a simple
   lockout: 5 wrong attempts in a row locks the keypad for 30 seconds.
   It's in-memory only (resets on page reload) since this whole PIN is
   already documented as a soft "casual glance" deterrent, not real
   security — but "no limit at all" was strictly worse than a basic
   cooldown, so this raises the floor a bit. */
let failedPinAttempts = 0;
let pinLockUntil = 0;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 30000;

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
  let lockoutTimer = null;
  const dotsEl = ()=>overlay.querySelectorAll('.pin-dot');
  function updateDots(){ dotsEl().forEach((d,i)=> d.classList.toggle('filled', i<entered.length)); }
  function cleanup(){ document.removeEventListener('keydown', onKeydown); if(lockoutTimer) clearInterval(lockoutTimer); overlay.remove(); }
  function setKeypadDisabled(disabled){
    overlay.querySelectorAll('.pin-key').forEach(btn => btn.disabled = disabled);
  }
  function startLockoutCountdown(){
    setKeypadDisabled(true);
    entered=''; updateDots();
    const tick = ()=>{
      const msLeft = pinLockUntil - Date.now();
      if(msLeft <= 0){
        clearInterval(lockoutTimer); lockoutTimer = null;
        setKeypadDisabled(false);
        overlay.querySelector('#pinError').textContent = '\u00a0';
        return;
      }
      overlay.querySelector('#pinError').textContent = `Too many wrong attempts — try again in ${Math.ceil(msLeft/1000)}s`;
    };
    tick();
    lockoutTimer = setInterval(tick, 500);
  }
  if(Date.now() < pinLockUntil) startLockoutCountdown();
  function tryPin(){
    if(Date.now() < pinLockUntil) return; // BUGFIX (#19a): ignore attempts submitted during lockout
    if(entered===ADMIN_PIN){ failedPinAttempts=0; cleanup(); rememberSession('admin'); onSuccess('admin'); }
    else if(entered===READONLY_PIN){ failedPinAttempts=0; cleanup(); rememberSession('readonly'); onSuccess('readonly'); }
    else{
      failedPinAttempts++;
      entered=''; updateDots();
      if(failedPinAttempts >= PIN_MAX_ATTEMPTS){
        pinLockUntil = Date.now() + PIN_LOCKOUT_MS;
        failedPinAttempts = 0;
        startLockoutCountdown();
      } else {
        overlay.querySelector('#pinError').textContent = `Incorrect PIN — try again (${PIN_MAX_ATTEMPTS - failedPinAttempts} attempt${PIN_MAX_ATTEMPTS - failedPinAttempts===1?'':'s'} left before a 30s lockout)`;
      }
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

  /* Physical keyboard: digits, Backspace, Escape (clear) */
  function onKeydown(e){
    if(Date.now() < pinLockUntil) return; // BUGFIX (#19a): keyboard entry bypassed the disabled keypad buttons
    if(e.key >= '0' && e.key <= '9'){
      e.preventDefault();
      if(entered.length>=4) return;
      entered += e.key;
      updateDots();
      if(entered.length===4) tryPin();
    } else if(e.key === 'Backspace'){
      e.preventDefault();
      entered = entered.slice(0,-1); updateDots();
    } else if(e.key === 'Escape'){
      e.preventDefault();
      entered=''; updateDots(); overlay.querySelector('#pinError').textContent='\u00a0';
    }
  }
  document.addEventListener('keydown', onKeydown);
  overlay.tabIndex = -1;
  overlay.focus();
}

function applyReadOnlyGuard(){
  if(currentRole!=='readonly') return;
  document.querySelectorAll('[contenteditable="true"]').forEach(el=>{ el.contentEditable='false'; el.classList.add('ro-locked'); });
  document.querySelectorAll('.row-del').forEach(el=> el.style.display='none');
  document.querySelectorAll('#panels button, #panels input, #panels select').forEach(el=>{ el.disabled = true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; });
  const hsb = document.getElementById('headerSaveBtn'); if(hsb) hsb.style.display='none';
  const bar = document.getElementById('saveBar'); if(bar) bar.classList.remove('show');
  /* BUGFIX (#19b): the activity/change log is admin-only info (it can
     reveal balances and edits via its change descriptions), but its bell
     button's visibility was only ever set once, in initShell(), based on
     whatever currentRole was AT PAGE LOAD. Locking and re-entering the
     readonly PIN never re-ran that check, so a bell left visible from an
     earlier admin session stayed visible (and clickable — its handler
     didn't check role either) after switching to readonly. Belt-and-
     suspenders fix: hide it and close any open dropdown here too, in
     addition to the click-time role check now in core-shell.js. */
  const bell = document.getElementById('activityBell'); if(bell) bell.style.display='none';
  const dropdown = document.getElementById('activityDropdown'); if(dropdown) dropdown.style.display='none';
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
  /* BUGFIX (#6 — data loss risk): a load failure (network error, storage
     down) used to be indistinguishable from "brand-new empty ledger" —
     loadData() would fall back to buildDefaultData() either way, opening
     an empty app that your next Save would then write over the real
     cloud copy. Now loadData() sets dataLoadFailed instead of quietly
     building an empty ledger, so we stop here and offer Retry rather than
     ever rendering (and risking a save from) an empty ledger. */
  if(typeof dataLoadFailed !== 'undefined' && dataLoadFailed){
    panelsEl.innerHTML = `
      <div class="section-sub" style="padding:40px 20px; text-align:center;">
        <div style="font-size:15px; color:var(--danger); margin-bottom:10px;">⚠ Couldn't load your data</div>
        <div style="max-width:480px; margin:0 auto 18px auto;">
          This looks like a connection problem, not an empty ledger — so nothing has been changed or saved.
          Please check your connection and retry rather than continuing, which could otherwise save an empty
          ledger over your real data.
        </div>
        <button class="btn primary" id="dataLoadRetryBtn">Retry</button>
      </div>`;
    const retryBtn = document.getElementById('dataLoadRetryBtn');
    if(retryBtn) retryBtn.addEventListener('click', ()=>{ proceedAfterAuth(role); });
    return;
  }
  // Get the live FX rate BEFORE the first render, not lazily whenever the
  // person happens to visit Investments/Holdings — otherwise Overview's
  // Net Worth briefly computes with no rate at all (or a stale one) on
  // first load, then jumps once you visit a tab that triggers the fetch.
  if(typeof ensureFxRates === 'function'){
    try{ await ensureFxRates(); }catch(e){ /* fall back to whatever ensureFxRates already handles internally */ }
  }
  panelsEl.innerHTML = '';
  initShell();
  renderActive();

  if(!xlsxOk){
    showToast('Spreadsheet import unavailable (library failed to load)');
  }
}
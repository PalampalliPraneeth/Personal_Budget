/* storage-bridge.js — Supabase backend for The Ledger */
(function(){
  // ==================== REPLACE THESE TWO LINES ====================
  const SUPABASE_URL = 'https://dkwdzvwaoxekicycednh.supabase.co'; // ← your URL
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrd2R6dndhb3hla2ljeWNlZG5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MDUyMTYsImV4cCI6MjEwMTA4MTIxNn0.GM5__BLAfksdQhZ-udTeAsXZwSpvzXfd8JHPB9_B-Hc';        // ← your anon key
  // =================================================================
  
  const LEDGER_ID = 'the-ledger-main-7663';
  // Safety: strip /rest/v1 if accidentally pasted
  let cleanUrl = SUPABASE_URL.trim().replace(/\/+$/, '');
  if (cleanUrl.endsWith('/rest/v1')) {
    cleanUrl = cleanUrl.slice(0, -'/rest/v1'.length).replace(/\/+$/, '');
  }

window.PRICE_PROXY_URL = 'https://dkwdzvwaoxekicycednh.supabase.co/functions/v1/hyper-task';

  let sb = null;
  let useSupabase = false;

  const looksReal = cleanUrl.length > 20 
    && SUPABASE_ANON_KEY.length > 20 
    && !SUPABASE_ANON_KEY.includes('...');

  if (looksReal && typeof supabase !== 'undefined') {
    try {
      sb = supabase.createClient(cleanUrl, SUPABASE_ANON_KEY);
      useSupabase = true;
    } catch(e) { console.error('Supabase init failed:', e); }
  }

  // Use the SAME user ID everywhere so data syncs across devices
  let userId = LEDGER_ID;
  localStorage.setItem('ledger:supabase:user', userId);

  const supaStorage = {
    /* BUGFIX (data loss risk): this used to swallow EVERY failure — a real
       network error, a timeout, Supabase being down — into the exact same
       `return null` as "this key genuinely has no data yet". The caller
       (loadData in core-data.js) couldn't tell the two apart, so a network
       hiccup on page load looked identical to a brand-new empty ledger.
       That opened an empty ledger in the browser, and the NEXT save would
       overwrite the real cloud copy with that emptiness.
       Fix: only return null when Supabase genuinely has no row for this
       key (a clean, error-free response with no data). Any real error is
       THROWN so the caller can tell "no data" apart from "couldn't check"
       and refuse to treat the latter as if it were the former. */
    async get(key, isShared){
      if (!sb) throw new Error('Supabase client not initialized');
      const { data, error } = await sb
        .from('ledger_data')
        .select('data_json')
        .eq('user_id', userId)
        .eq('data_key', key)
        .maybeSingle();
      if (error) throw error; // a real fetch/API error — not "no data"
      if (!data) return null; // genuinely no row for this key yet
      const asString = typeof data.data_json === 'string'
        ? data.data_json
        : JSON.stringify(data.data_json);
      return { value: asString };
    },
    async set(key, value, isShared){
      if (!sb) return false;
      try {
        let jsonVal;
        try { jsonVal = JSON.parse(value); } catch(e) { jsonVal = value; }
        const { error } = await sb
          .from('ledger_data')
          .upsert(
            { 
              user_id: userId, 
              data_key: key, 
              data_json: jsonVal, 
              updated_at: new Date().toISOString() 
            },
            { onConflict: 'user_id,data_key' }
          );
        return !error;
      } catch(e) { return false; }
    },
    async delete(key, isShared){
      if (!sb) return false;
      try {
        const { error } = await sb
          .from('ledger_data')
          .delete()
          .eq('user_id', userId)
          .eq('data_key', key);
        return !error;
      } catch(e) { return false; }
    }
  };

  const localStorageBackend = {
    async get(key, isShared){
      try{ const raw = localStorage.getItem(key); return raw !== null ? { value: raw } : null; }
      catch(e){ return null; }
    },
    async set(key, value, isShared){
      try{ localStorage.setItem(key, value); return true; }
      catch(e){ return false; }
    },
    async delete(key, isShared){
      try{ localStorage.removeItem(key); return true; }
      catch(e){ return false; }
    }
  };

  window.storage = useSupabase ? supaStorage : localStorageBackend;
  console.log('[Ledger Storage]', useSupabase ? 'Supabase cloud (' + cleanUrl + ')' : 'localStorage fallback');
})();
/* storage-bridge.js — Supabase backend for The Ledger */
(function(){
  // ==================== REPLACE THESE TWO LINES ====================
  const SUPABASE_URL = 'https://dkwdzvwaoxekicycednh.supabase.co/rest/v1/'; // ← your URL
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRrd2R6dndhb3hla2ljeWNlZG5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MDUyMTYsImV4cCI6MjEwMTA4MTIxNn0.GM5__BLAfksdQhZ-udTeAsXZwSpvzXfd8JHPB9_B-Hc';        // ← your anon key
  // =================================================================

  let sb = null;
  let useSupabase = false;

  // Only try Supabase if you actually pasted real credentials
  const looksReal = SUPABASE_URL.length > 20 
    && SUPABASE_ANON_KEY.length > 20 
    && !SUPABASE_ANON_KEY.includes('...');

  if (looksReal && typeof supabase !== 'undefined') {
    try {
      sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      useSupabase = true;
    } catch(e) { console.error('Supabase init failed:', e); }
  }

  // Persistent anonymous user id for this browser
  let userId = localStorage.getItem('ledger:supabase:user');
  if (!userId) {
    userId = 'u_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
    localStorage.setItem('ledger:supabase:user', userId);
  }

  // Supabase backend
  const supaStorage = {
    async get(key, isShared){
      if (!sb) return null;
      try {
        const { data, error } = await sb
          .from('ledger_data')
          .select('data_json')
          .eq('user_id', userId)
          .eq('data_key', key)
          .maybeSingle();
        if (error || !data) return null;
        const asString = typeof data.data_json === 'string' 
          ? data.data_json 
          : JSON.stringify(data.data_json);
        return { value: asString };
      } catch(e) { return null; }
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

  // localStorage fallback (works immediately if Supabase isn't configured yet)
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
  console.log('[Ledger Storage]', useSupabase ? 'Supabase cloud' : 'localStorage fallback (paste Supabase credentials to enable cloud sync)');
})();

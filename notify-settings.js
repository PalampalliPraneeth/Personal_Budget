/* notify-settings.js — stores the email address recurring-buy reminders get
   sent to. The SENDING happens server-side on a schedule (see
   send-recurring-reminders.ts) — this file only handles reading/writing
   where that address lives, using the same window.storage every other
   piece of data already goes through. */

const NOTIFY_EMAIL_KEY = 'notify:email';

function isValidEmail(str){
  // Deliberately simple — good enough to catch typos, not meant to be a
  // full RFC 5322 validator. The real check is whether mail actually arrives.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((str||'').trim());
}

async function getNotifyEmail(){
  try{
    const result = await window.storage.get(NOTIFY_EMAIL_KEY, false);
    if(!result) return null;
    // Supabase's jsonb column auto-decodes on the way back out, so a value
    // saved as JSON.stringify('user@example.com') can come back as the
    // ALREADY-UNWRAPPED plain string user@example.com instead of the
    // quoted JSON form — JSON.parse() on that throws. Fall back to the raw
    // value in that case rather than losing the email. (Same defensive
    // pattern send-recurring-reminders.ts's loadKey() already uses.)
    try { return JSON.parse(result.value); }
    catch(e){ return result.value; }
  }catch(e){
    return null; // key doesn't exist yet — not an error
  }
}

async function setNotifyEmail(email){
  const trimmed = (email||'').trim();
  if(!isValidEmail(trimmed)) return { ok:false, reason:'invalid' };
  const result = await window.storage.set(NOTIFY_EMAIL_KEY, JSON.stringify(trimmed), false);
  return result ? { ok:true } : { ok:false, reason:'storage-failed' };
}

async function clearNotifyEmail(){
  try{ await window.storage.delete(NOTIFY_EMAIL_KEY, false); }catch(e){}
  return { ok:true };
}
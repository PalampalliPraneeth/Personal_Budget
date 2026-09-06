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
    return result ? JSON.parse(result.value) : null;
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
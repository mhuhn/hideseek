import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_KEY.includes('YOUR-');

export const sb = configured
  ? createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'hideseek-auth' },
    })
  : null;

let sessionPromise = null;

/** Anonyme Anmeldung – einmal pro Gerät, danach bleibt die Sitzung erhalten. */
export function ensureSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const { data } = await sb.auth.getSession();
      if (data.session) return data.session;
      const { data: d2, error } = await sb.auth.signInAnonymously();
      if (error) {
        sessionPromise = null;
        if (/anonymous/i.test(error.message)) {
          throw new Error('Die anonyme Anmeldung ist in Supabase noch nicht eingeschaltet.');
        }
        throw new Error(error.message);
      }
      return d2.session;
    })();
  }
  return sessionPromise;
}

function cleanError(msg = '') {
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Keine Verbindung zum Server.';
  if (/JWT|token/i.test(msg)) return 'Anmeldung abgelaufen – bitte App neu laden.';
  return msg;
}

/** Aufruf einer Datenbank-Funktion; Fehlermeldungen kommen auf Deutsch vom Server. */
export async function rpc(name, args = {}) {
  await ensureSession();
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(cleanError(error.message));
  return data;
}

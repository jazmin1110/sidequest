// Public Supabase settings. The publishable key is SAFE to ship in the browser —
// row level security (see schema.sql) is what protects the data.
export const SUPABASE_URL = 'https://evesekdtnytedukcogxr.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable__L12drkaMT8baIXh9B3lvw_urXcRDBh';
// Public key for web push reminders (the matching private key lives only in Supabase as an edge function secret).
export const VAPID_PUBLIC_KEY = 'BHbjsegh6IhWByHs5w3Wx6bZuT5NMXI4KrlcT25YjQH8AQi6w8nxgYP1GhAY0KT09BEnTQzO8cIO_aTcRKnHjyQ';

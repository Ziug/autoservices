import {readFileSync} from 'node:fs';
import {createClient} from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf('=');
    return i === -1 ? [line, ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  })
);

const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: {autoRefreshToken: false, persistSession: false}
});

const {data, error} = await client.functions.invoke('assistant', {
  body: {
    slug: 'graphite-detailing',
    audience: 'client',
    message: 'Запиши меня завтра в любое время на полировку, зовут тестовый, 89990001122, бмв',
    messageCount: 1,
    bookingDraft: {serviceSlug: null, day: null, time: null, customerName: '', customerPhone: '', vehicle: ''},
    idempotencyKey: crypto.randomUUID(),
  },
});

console.log('ERROR:', error ? JSON.stringify(error, null, 2) : 'none');
console.log('DATA:', JSON.stringify(data, null, 2));

// Zirconix — Expo push delivery
//
// Invoked by the notifications_push trigger (pg_net) with { notification_id }.
// It re-reads the notification server-side rather than trusting anything in the
// request body, so the worst a spurious call can do is re-send a push that was
// already legitimately generated, to the director it already belonged to.
//
// Expo's push API needs no credentials for a normal project — the ExponentPushToken
// itself is the address. The service-role key here is only for reading the
// notification and the recipient's token past RLS.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    return json({ error: 'function is missing its Supabase environment' }, 500);
  }

  let notificationId: string | undefined;
  try {
    notificationId = (await req.json())?.notification_id;
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  if (!notificationId) {
    return json({ error: 'notification_id is required' }, 400);
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: note, error } = await db
    .from('notifications')
    .select('id, title, body, kind, disbursement_id, pushed_at, directors!inner(expo_push_token)')
    .eq('id', notificationId)
    .single();

  if (error || !note) {
    return json({ error: 'notification not found' }, 404);
  }

  // pg_net retries, and a director does not want the same alert twice.
  if (note.pushed_at) {
    return json({ skipped: 'already pushed' }, 200);
  }

  const token = (note.directors as { expo_push_token: string | null })?.expo_push_token;
  if (!token) {
    return json({ skipped: 'recipient has no push token' }, 200);
  }

  const res = await fetch(EXPO_PUSH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify([
      {
        to: token,
        title: note.title,
        body: note.body,
        sound: 'default',
        priority: 'high',
        // Lets the app deep-link straight to the transfer that needs a vote.
        data: { kind: note.kind, disbursement_id: note.disbursement_id },
      },
    ]),
  });

  const receipt = await res.json().catch(() => null);

  if (!res.ok) {
    return json({ error: 'expo rejected the push', status: res.status, receipt }, 502);
  }

  // Only stamp on success, so a failed send is retried rather than silently lost.
  await db
    .from('notifications')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', note.id);

  return json({ delivered: true, receipt }, 200);
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

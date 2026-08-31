// Zirconix — push delivery: native (Expo) and web (Web Push), one notification
//
// Invoked by the notifications_push trigger (pg_net) with { notification_id,
// vapid_public_key, vapid_private_key }. It re-reads the notification
// server-side rather than trusting anything else in the request body, so the
// worst a spurious call can do is re-send a push that was already legitimately
// generated, to the director it already belonged to.
//
// A director can have an Expo token (native app) and/or several web push
// subscriptions (one per browser/device that granted permission) — every
// channel that exists for them gets the same notification.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

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

  let body: {
    notification_id?: string;
    vapid_public_key?: string;
    vapid_private_key?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'body must be JSON' }, 400);
  }
  if (!body.notification_id) {
    return json({ error: 'notification_id is required' }, 400);
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: note, error } = await db
    .from('notifications')
    .select(
      'id, title, body, kind, disbursement_id, pushed_at, director_id, directors!inner(expo_push_token)',
    )
    .eq('id', body.notification_id)
    .single();

  if (error || !note) {
    return json({ error: 'notification not found' }, 404);
  }

  if (note.pushed_at) {
    return json({ skipped: 'already pushed' }, 200);
  }

  const payload = JSON.stringify({
    title: note.title,
    body: note.body,
    kind: note.kind,
    disbursement_id: note.disbursement_id,
    url: note.disbursement_id ? '/approvals' : note.expenditure_id ? '/expenditures' : '/',
  });

  const results: Record<string, unknown> = {};

  // ── Native (Expo) ────────────────────────────────────────────────────────
  const expoToken = (note.directors as { expo_push_token: string | null })?.expo_push_token;
  if (expoToken) {
    try {
      const res = await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify([
          {
            to: expoToken,
            title: note.title,
            body: note.body,
            sound: 'default',
            priority: 'high',
            data: { kind: note.kind, disbursement_id: note.disbursement_id },
          },
        ]),
      });
      results.expo = { ok: res.ok, status: res.status, receipt: await res.json().catch(() => null) };
    } catch (e) {
      results.expo = { ok: false, error: String(e) };
    }
  }

  // ── Web push ─────────────────────────────────────────────────────────────
  if (body.vapid_public_key && body.vapid_private_key) {
    webpush.setVapidDetails(
      'mailto:support@gbmines.com',
      body.vapid_public_key,
      body.vapid_private_key,
    );

    const { data: subs } = await db
      .from('web_push_subscriptions')
      .select('id, endpoint, p256dh, auth_key')
      .eq('director_id', note.director_id);

    const webResults = await Promise.all(
      (subs ?? []).map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth_key },
            },
            payload,
          );
          return { id: sub.id, ok: true };
        } catch (e) {
          // 404/410 = the browser or OS has torn down this subscription
          // (permission revoked, site data cleared, device deregistered). It
          // will never succeed again, so stop trying rather than erroring on
          // every future notification for as long as the row exists.
          const status = (e as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            await db.from('web_push_subscriptions').delete().eq('id', sub.id);
            return { id: sub.id, ok: false, pruned: true };
          }
          return { id: sub.id, ok: false, error: String(e) };
        }
      }),
    );
    results.web = webResults;
  }

  await db
    .from('notifications')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', note.id);

  return json({ delivered: true, results }, 200);
});

function json(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

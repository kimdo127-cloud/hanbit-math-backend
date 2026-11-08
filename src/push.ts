// 앱 푸시 (웹 푸시): 새 알림을 그 가족 보호자의 기기들로 보낸다
// 키(VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY)가 없으면 보내지 않는다 → 알림함에는 그대로 쌓임
// 만료된 구독(404·410)은 지운다
import webpush from "web-push";
import { pool, SCHEMA } from "./db/pool";
import type { AppNotification } from "./logic/types";

const pub = process.env.VAPID_PUBLIC_KEY;
const priv = process.env.VAPID_PRIVATE_KEY;
const ready = !!(pub && priv);
if (ready) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@hanbit.kr", pub!, priv!);

export async function savePushSubscription(parentId: number, sub: unknown) {
  const s = sub as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth) throw new Error("bad subscription");
  await pool.query(
    `INSERT INTO ${SCHEMA}.push_subscriptions (parent_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET parent_id = EXCLUDED.parent_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [parentId, s.endpoint, s.keys.p256dh, s.keys.auth],
  );
}

export async function removePushSubscription(parentId: number, endpoint: string) {
  await pool.query(`DELETE FROM ${SCHEMA}.push_subscriptions WHERE parent_id = $1 AND endpoint = $2`, [parentId, endpoint]);
}

export async function hasPushSubscription(parentId: number) {
  const r = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.push_subscriptions WHERE parent_id = $1`, [parentId]);
  return r.rows[0].n > 0;
}

export async function sendPush(list: AppNotification[]) {
  if (!ready || !list.length) return;
  for (const n of list) {
    const subs = await pool.query(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM ${SCHEMA}.push_subscriptions s JOIN ${SCHEMA}.parents p ON p.id = s.parent_id WHERE p.family_id = $1`,
      [n.family_id],
    );
    for (const s of subs.rows) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: n.title, body: n.body, link: n.link }), { TTL: 3600 });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await pool.query(`DELETE FROM ${SCHEMA}.push_subscriptions WHERE id = $1`, [s.id]);
        else console.error("push", code, (e as Error).message);
      }
    }
  }
}

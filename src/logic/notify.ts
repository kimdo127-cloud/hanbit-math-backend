// 학부모 알림: 알림함에 쌓고, 요청이 끝나면 앱 푸시로도 보낸다 (api.controller → push.ts)
import { nextId } from "../db/store";
import { TODAY } from "./seed";
import type { AppNotification, DB, NotificationKind } from "./types";

export const nowAt = () => `${TODAY}T${new Date().toTimeString().slice(0, 5)}`;

export function notify(db: DB, n: { family_id: number; student_id: number | null; kind: NotificationKind; title: string; body: string; link: string }) {
  const row: AppNotification = { id: nextId(db.notifications), ...n, created_at: nowAt(), read_at: null };
  db.notifications.push(row);
  return row;
}

// 학생 → 가족 (알림은 가족 단위로 보낸다)
export const familyOf = (db: DB, studentId: number) => db.students.find((s) => s.id === studentId)!.family_id;

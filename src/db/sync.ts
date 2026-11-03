// hw2 표 ↔ 메모리 DB 객체. 저장할 때는 새로 생긴 줄 INSERT, 바뀐 줄 UPDATE, 사라진 줄 DELETE
import type { PoolClient } from "pg";
import type { DB } from "../logic/types";

// 외래키 순서 (부모 → 자식). 지울 때는 반대로
export const TABLES: (keyof DB)[] = [
  "families",
  "parents",
  "students",
  "student_contacts",
  "staff",
  "staff_tokens",
  "classes",
  "class_schedules",
  "enrollments",
  "class_sessions",
  "attendances",
  "makeups",
  "payments",
  "activity_logs",
];

// 시각(time)·일시(timestamp) 칸은 화면 코드가 쓰는 모양("17:00", "2026-10-29T16:50")으로 맞춘다
const TIME_COLS = new Set(["start_time", "end_time", "checked_at"]);
const TS_COLS: Record<string, string[]> = { staff_tokens: ["created_at", "expires_at", "used_at"], makeups: ["requested_at"], activity_logs: ["at"] };

// 표 14개를 왕복 한 번에 읽는다 (원격 DB에서 표마다 따로 읽으면 느리다)
export async function loadAll(client: PoolClient): Promise<DB> {
  const parts = TABLES.map((t) => `'${t}', (SELECT coalesce(json_agg(x ORDER BY x.id), '[]'::json) FROM ${t} x)`).join(", ");
  const { rows } = await client.query(`SELECT json_build_object(${parts}) AS db`);
  const db = rows[0].db as Record<string, Record<string, unknown>[]>;
  for (const t of TABLES) {
    for (const r of db[t]) {
      for (const c of Object.keys(r)) {
        const v = r[c];
        if (typeof v !== "string") continue;
        if (TIME_COLS.has(c)) r[c] = v.slice(0, 5);
        else if (TS_COLS[t]?.includes(c)) r[c] = v.slice(0, 16);
      }
    }
  }
  return db as unknown as DB;
}

type Row = Record<string, unknown> & { id: number };

async function insert(client: PoolClient, t: string, r: Row) {
  const cols = Object.keys(r);
  await client.query(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
}

export async function syncChanges(client: PoolClient, before: DB, after: DB) {
  // 1) 사라진 줄 먼저 지운다 (자식 표 → 부모 표). 같은 값으로 다시 넣을 때 UNIQUE에 걸리지 않게
  //    예: 강좌 시간표를 바꾸면 (강좌, 요일) 줄을 지우고 새로 넣는다
  for (const t of [...TABLES].reverse()) {
    const ids = new Set((after[t] as unknown as Row[]).map((r) => r.id));
    const gone = (before[t] as unknown as Row[]).map((r) => r.id).filter((id) => !ids.has(id));
    if (gone.length) await client.query(`DELETE FROM ${t} WHERE id = ANY($1)`, [gone]);
  }
  // 2) 바뀐 줄 UPDATE, 새 줄 INSERT (부모 표 → 자식 표)
  for (const t of TABLES) {
    const old = new Map((before[t] as unknown as Row[]).map((r) => [r.id, r]));
    for (const r of after[t] as unknown as Row[]) {
      const o = old.get(r.id);
      if (!o) await insert(client, t, r);
      else if (JSON.stringify(o) !== JSON.stringify(r)) {
        const cols = Object.keys(r).filter((c) => c !== "id" && JSON.stringify(o[c]) !== JSON.stringify(r[c]));
        if (cols.length) await client.query(`UPDATE ${t} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [r.id, ...cols.map((c) => r[c])]);
      }
    }
  }
}

// 시연 데이터 넣기: 여러 줄을 한 번에 (원격 DB에 줄마다 보내면 몇 분 걸린다)
export async function insertAll(client: PoolClient, db: DB) {
  for (const t of TABLES) {
    const rows = db[t] as unknown as Row[];
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const per = Math.max(1, Math.floor(60000 / cols.length)); // PostgreSQL 파라미터 한도 안에서
    for (let i = 0; i < rows.length; i += per) {
      const chunk = rows.slice(i, i + per);
      const values = chunk.map((_, r) => `(${cols.map((_, c) => `$${r * cols.length + c + 1}`).join(",")})`).join(",");
      await client.query(`INSERT INTO ${t} (${cols.join(",")}) VALUES ${values}`, chunk.flatMap((r) => cols.map((c) => r[c] ?? null)));
    }
  }
}

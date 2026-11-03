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

export async function loadAll(client: PoolClient): Promise<DB> {
  const db = {} as Record<string, unknown[]>;
  for (const t of TABLES) db[t] = (await client.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
  return db as unknown as DB;
}

type Row = Record<string, unknown> & { id: number };

async function insert(client: PoolClient, t: string, r: Row) {
  const cols = Object.keys(r);
  await client.query(`INSERT INTO ${t} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => r[c]));
}

export async function syncChanges(client: PoolClient, before: DB, after: DB) {
  const deletes: [string, number[]][] = [];
  for (const t of TABLES) {
    const old = new Map((before[t] as unknown as Row[]).map((r) => [r.id, r]));
    const cur = after[t] as unknown as Row[];
    const seen = new Set<number>();
    for (const r of cur) {
      seen.add(r.id);
      const o = old.get(r.id);
      if (!o) await insert(client, t, r);
      else if (JSON.stringify(o) !== JSON.stringify(r)) {
        const cols = Object.keys(r).filter((c) => c !== "id" && JSON.stringify(o[c]) !== JSON.stringify(r[c]));
        if (cols.length) await client.query(`UPDATE ${t} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [r.id, ...cols.map((c) => r[c])]);
      }
    }
    const gone = [...old.keys()].filter((id) => !seen.has(id));
    if (gone.length) deletes.push([t, gone]);
  }
  for (const [t, ids] of deletes.reverse()) await client.query(`DELETE FROM ${t} WHERE id = ANY($1)`, [ids]);
}

export async function insertAll(client: PoolClient, db: DB) {
  for (const t of TABLES) for (const r of db[t] as unknown as Row[]) await insert(client, t, r);
}

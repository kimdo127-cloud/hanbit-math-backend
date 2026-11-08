// 요청 하나 = 트랜잭션 하나.
// 요청을 시작할 때 hw2의 표를 읽어 메모리에 올리고(loadDB), 로직이 바꾼 줄만 골라 DB에 쓴다(saveDB → sync).
// 화면에서 쓰던 규칙 코드(logic/*-api.ts)를 거의 그대로 서버로 옮기기 위한 방식. 데이터가 작은 학원 규모라 가능하다.
// 트랜잭션은 SERIALIZABLE: 두 사람이 동시에 마지막 자리를 신청하면 한쪽은 충돌로 다시 시도되고, 정원 검사를 다시 거친다.
import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import type { DB } from "../logic/types";
import { pool } from "./pool";
import { TABLES, loadAll, syncChanges } from "./sync";

interface Ctx {
  db: DB;
  snapshot: string; // 읽어 왔을 때의 상태 (바뀐 줄을 찾는 기준)
  dirty: boolean;
  parentId: number | null;
  staffId: number | null;
}
const als = new AsyncLocalStorage<Ctx>();
const ctx = () => {
  const c = als.getStore();
  if (!c) throw new Error("요청 밖에서 DB를 쓰려고 했어요.");
  return c;
};

export function loadDB(): DB {
  return ctx().db;
}
export function saveDB(_db: DB) {
  ctx().dirty = true;
}
export function nextId(rows: { id: number }[]) {
  return rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}
export function resetDB() {
  throw new Error("resetDB는 서버에서 직접 부르지 않아요.");
}

// 로그인한 사람 (토큰에서 꺼내 넣는다)
export const getSessionParentId = () => ctx().parentId;
export const setSessionParentId = (id: number | null) => (ctx().parentId = id);
export const getSessionStaffId = () => ctx().staffId;
export const setSessionStaffId = (id: number | null) => (ctx().staffId = id);

export async function runRequest<T>(who: { parentId: number | null; staffId: number | null }, fn: () => Promise<T>) {
  for (let attempt = 1; ; attempt++) {
    const client: PoolClient = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const db = await loadAll(client);
      const c: Ctx = { db, snapshot: JSON.stringify(db), dirty: false, ...who };
      const result = await als.run(c, fn);
      const before = JSON.parse(c.snapshot) as DB;
      if (c.dirty) await syncChanges(client, before, c.db);
      await client.query("COMMIT");
      // 이번 요청에서 새로 생긴 알림 → 커밋 뒤 앱 푸시로 보낸다 (api.controller)
      const oldIds = new Set(before.notifications.map((n) => n.id));
      const notifications = c.dirty ? c.db.notifications.filter((n) => !oldIds.has(n.id)) : [];
      return { result, parentId: c.parentId, staffId: c.staffId, notifications };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      // 동시에 같은 줄을 바꿔 충돌 → 처음부터 다시 (최대 3번)
      if ((e as { code?: string }).code === "40001" && attempt < 3) continue;
      throw e;
    } finally {
      client.release();
    }
  }
}

export { TABLES };

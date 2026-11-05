// PostgreSQL 연결 (Render). 날짜·시각은 화면 코드가 쓰던 문자열 모양 그대로 돌려준다
import "../env";
import { Pool, types } from "pg";

types.setTypeParser(1082, (v) => v); // date → "2026-10-29"
types.setTypeParser(1083, (v) => v.slice(0, 5)); // time → "17:00"
types.setTypeParser(1114, (v) => v.replace(" ", "T").slice(0, 16)); // timestamp → "2026-10-29T16:50"

export const SCHEMA = process.env.DB_SCHEMA || "hw2";
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) throw new Error("DB_SCHEMA 이름이 올바르지 않아요.");

const url = process.env.DATABASE_URL;
export const pool = new Pool({
  connectionString: url,
  // Render 외부 주소는 SSL이 필요하다 (내부 주소는 필요 없음)
  ssl: url && /render\.com/.test(url) ? { rejectUnauthorized: false } : undefined,
  max: 5,
});
pool.on("connect", (c) => {
  c.query(`SET search_path TO ${SCHEMA}`);
});

// hw2 스키마에 표를 만들고 시연 데이터를 넣는다:  npm run build && npm run db:setup
// 주의: hw2 안의 한빛수학 표를 지우고 다시 만든다 (1주차 표는 다른 스키마라 건드리지 않음)
import "../env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSeed } from "../logic/seed";
import { pool, SCHEMA } from "./pool";
import { insertAll } from "./sync";

export async function setupDB() {
  const sql = readFileSync(join(__dirname, "..", "..", "src", "db", "schema.sql"), "utf8").replaceAll("__SCHEMA__", SCHEMA);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(`SET search_path TO ${SCHEMA}`);
    await insertAll(client, createSeed());
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  setupDB()
    .then(() => {
      console.log(`${SCHEMA} 스키마에 표와 시연 데이터를 만들었어요.`);
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

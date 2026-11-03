// 코어 웹(/api/web/*)과 어드민(/api/admin/*)이 함께 쓰는 API
// 화면의 lib/api.ts 함수 이름 그대로 부른다: POST /api/web/getMe  { args: [...] }
// - 로그인 상태는 토큰(JWT)으로: 고객 토큰은 web 함수만, 직원 토큰은 admin 함수만 쓸 수 있다
// - 권한(관리자·매니저·멤버, 자기 가족만)과 업무 규칙은 logic/*-api.ts 안에서 검사하고, 거절 이유를 쉬운 말로 돌려준다
// - DB가 막은 것(중복·범위)은 DB 오류를 쉬운 말로 바꿔 돌려준다
import { Body, Controller, Get, Headers, HttpException, Param, Post } from "@nestjs/common";
import { sign, verify } from "jsonwebtoken";
import { pool } from "./db/pool";
import { runRequest } from "./db/store";
import { setupDB } from "./db/setup";
import * as adminApi from "./logic/admin-api";
import * as webApi from "./logic/web-api";

const SECRET = process.env.JWT_SECRET || "dev-only-secret";
type Who = { t: "parent" | "staff"; id: number };

// 화면에서 부르면 안 되는 내부 함수는 막는다
const HIDDEN = new Set(["ApiError", "default"]);
const APIS: Record<string, Record<string, unknown>> = { web: webApi, admin: adminApi };

// DB 제약 이름 → 쉬운 말 (DBeaver로 직접 넣어도 같은 규칙으로 막힘)
const DB_RULES: Record<string, string> = {
  enrollments_one_active: "이미 같은 강좌를 듣고 있어요. (DB가 막음)",
  attendances_session_id_student_id_key: "이 수업의 출결은 이미 있어요. (DB가 막음)",
  makeups_absence_id_key: "이 결석은 이미 보강을 신청했어요. (DB가 막음)",
  payments_student_id_class_id_month_key: "이 달 납부 기록이 이미 있어요. (DB가 막음)",
  parents_email_key: "이미 가입한 이메일이에요. (DB가 막음)",
  staff_email_key: "이미 쓰고 있는 이메일이에요. (DB가 막음)",
  class_schedules_check: "끝 시각은 시작 시각보다 늦어야 해요. (DB가 막음)",
  classes_capacity_check: "정원은 1명 이상이어야 해요. (DB가 막음)",
};

@Controller()
export class ApiController {
  @Get("health")
  async health() {
    await pool.query("SELECT 1");
    return { ok: true };
  }

  @Post("api/:app/:fn")
  async call(@Param("app") app: string, @Param("fn") fn: string, @Body() body: { args?: unknown[] }, @Headers("authorization") auth?: string) {
    // 시연 데이터 다시 넣기 (배포에서는 ALLOW_RESET=false)
    if (fn === "resetDemo") {
      if (process.env.ALLOW_RESET !== "true") throw new HttpException({ message: "이 서버에서는 초기화할 수 없어요." }, 403);
      await setupDB();
      return { data: true };
    }
    const mod = APIS[app];
    const f = mod?.[fn];
    if (!mod || typeof f !== "function" || HIDDEN.has(fn)) throw new HttpException({ message: "없는 기능이에요." }, 404);

    let who: Who | null = null;
    if (auth?.startsWith("Bearer ")) {
      try {
        who = verify(auth.slice(7), SECRET) as Who;
      } catch {
        who = null; // 만료·위조 토큰은 로그인 안 한 것으로
      }
    }
    // 고객 토큰으로 어드민 함수, 직원 토큰으로 고객 함수는 못 쓴다
    const parentId = app === "web" && who?.t === "parent" ? who.id : null;
    const staffId = app === "admin" && who?.t === "staff" ? who.id : null;

    try {
      const out = await runRequest({ parentId, staffId }, async () => (f as (...a: unknown[]) => unknown)(...(body?.args ?? [])));
      // 로그인·가입으로 로그인한 사람이 바뀌었으면 새 토큰을 준다
      const newId = app === "web" ? out.parentId : out.staffId;
      const oldId = app === "web" ? parentId : staffId;
      const token = newId && newId !== oldId ? sign({ t: app === "web" ? "parent" : "staff", id: newId } satisfies Who, SECRET, { expiresIn: "7d" }) : undefined;
      return { data: out.result ?? null, token };
    } catch (e) {
      const err = e as { status?: number; message?: string; code?: string; constraint?: string };
      if (err.code === "23505" || err.code === "23514" || err.code === "23503") {
        throw new HttpException({ message: DB_RULES[err.constraint ?? ""] ?? `DB 규칙에 맞지 않아요 (${err.constraint}).` }, 409);
      }
      if (typeof err.status === "number" && err.message) throw new HttpException({ message: err.message }, err.status);
      console.error(e);
      throw new HttpException({ message: "서버에서 문제가 생겼어요. 잠시 후 다시 시도해 주세요." }, 500);
    }
  }
}

// 코어 웹(/api/web/*)과 어드민(/api/admin/*)이 함께 쓰는 API
// 화면의 lib/api.ts 함수 이름 그대로 부른다: POST /api/web/getMe  { args: [...] }
// - 로그인 상태는 토큰(JWT)으로: 고객 토큰은 web 함수만, 직원 토큰은 admin 함수만 쓸 수 있다
// - 권한(관리자·매니저·멤버, 자기 가족만)과 업무 규칙은 logic/*-api.ts 안에서 검사하고, 거절 이유를 쉬운 말로 돌려준다
// - DB가 막은 것(중복·범위)은 DB 오류를 쉬운 말로 바꿔 돌려준다
import { Body, Controller, Get, Headers, HttpException, Param, Post } from "@nestjs/common";
import { sign, verify } from "jsonwebtoken";
import { pool, SCHEMA } from "./db/pool";
import { runRequest } from "./db/store";
import { setupDB } from "./db/setup";
import { hasPushSubscription, removePushSubscription, savePushSubscription, sendPush } from "./push";
import * as adminApi from "./logic/admin-api";
import * as webApi from "./logic/web-api";

const SECRET = process.env.JWT_SECRET || "dev-only-secret";
type Who = { t: "parent" | "staff"; id: number };

// 화면에서 부르면 안 되는 내부 함수는 막는다
const HIDDEN = new Set(["ApiError", "default", "familyInfoText"]);
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
  family_contacts_family_id_phone_key: "이 가족에 이미 등록된 번호예요. (DB가 막음)",
  family_contacts_one_primary: "대표 번호는 가족마다 하나만 정할 수 있어요. (DB가 막음)",
  students_kiosk_code_key: "이미 다른 학생이 쓰는 출석 번호예요. (DB가 막음)",
  invitations_one_live: "이 가족에게 아직 쓸 수 있는 초대가 있어요. (DB가 막음)",
  level_tests_check: "레벨테스트 합계 점수가 영역 점수의 합과 달라요. (DB가 막음)",
  level_tests_student_id_kind_tested_on_key: "같은 날 같은 종류의 레벨테스트 기록이 이미 있어요. (DB가 막음)",
  classes_capacity_check: "정원은 1명 이상이어야 해요. (DB가 막음)",
};

// Dify 지식의 파일 이름 → 고객이 아는 규정 이름
const REG_NAMES: [string, string][] = [
  ["01", "수강료 규정"],
  ["02", "출결·보강 규정"],
  ["03", "환불·상담 규정"],
];
const asked = new Map<number, number[]>(); // 보호자별 최근 질문 시각 (분당 10회 제한)

// 챗봇 문의 기록: 휴대폰 번호는 가려서 저장 (개인정보 최소화)
const maskPhone = (t: string) => t.replace(/01[016789][-\s]?\d{3,4}[-\s]?\d{4}/g, "010-****-****");
const nowLocal = () => {
  const d = new Date(); // main.ts에서 TZ=Asia/Seoul
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
async function saveChatLog(parentId: number, question: string, answer: string | null, regulations: string[], status: "answered" | "unknown" | "error") {
  try {
    await pool.query(
      `INSERT INTO ${SCHEMA}.chat_logs (asked_at, parent_id, question, answer, regulations, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [nowLocal(), parentId, maskPhone(question), answer === null ? null : maskPhone(answer), [...new Set(regulations)].join(", "), status],
    );
  } catch (e) {
    console.error("chat_logs 저장 실패", e); // 기록 실패가 답을 막지는 않는다
  }
}

function verifyWho(auth: string | undefined): Who | null {
  try {
    return auth?.startsWith("Bearer ") ? (verify(auth.slice(7), SECRET) as Who) : null;
  } catch {
    return null;
  }
}

@Controller()
export class ApiController {
  private async askRegulation(auth: string | undefined, question: unknown) {
    const who = verifyWho(auth);
    if (who?.t !== "parent") throw new HttpException({ message: "로그인이 필요해요." }, 401);
    const q = typeof question === "string" ? question.trim() : "";
    if (!q) throw new HttpException({ message: "궁금한 점을 입력해 주세요." }, 400);
    if (q.length > 300) throw new HttpException({ message: "질문은 300자 안으로 줄여 주세요." }, 400);
    const now = Date.now();
    const recent = (asked.get(who.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= 10) throw new HttpException({ message: "잠시 후 다시 물어봐 주세요. (1분에 10번까지)" }, 429);
    asked.set(who.id, [...recent, now]);

    const key = process.env.DIFY_API_KEY;
    if (!key) throw new HttpException({ message: "규정 묻기가 아직 연결되지 않았어요." }, 503);
    // 가족 메모(family_info): 질문마다 DB에서 새로 만든다. 로그인한 가족 것만 담기고 Dify에는 저장되지 않는다
    // Dify 앱의 입력 변수 family_info(문단)로 받는다. 규정 검색은 질문(query)으로만 하므로 메모가 검색을 흐리지 않는다
    const familyInfo = (await runRequest({ parentId: who.id, staffId: null }, async () => webApi.familyInfoText())).result;
    const res = await fetch(`${process.env.DIFY_API_URL || "https://api.dify.ai/v1"}/chat-messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ inputs: { family_info: familyInfo }, query: q, response_mode: "blocking", user: `parent-${who.id}` }),
    }).catch(() => null);
    if (!res || !res.ok) {
      console.error("dify", res?.status, res && (await res.text()).slice(0, 300));
      await saveChatLog(who.id, q, null, [], "error");
      throw new HttpException({ message: "지금은 답을 가져오지 못했어요. 잠시 후 다시 시도해 주세요." }, 502);
    }
    const out = (await res.json()) as { answer?: string; metadata?: { retriever_resources?: { document_name: string; content: string; score?: number }[] } };
    // 근거: 검색된 조항 원문 (자세히 보기). 파일 이름 대신 고객용 규정 이름
    // 조항(제n조)만 근거로 본다. 문서 머리말·구분선 조각은 뺀다
    const sources = (out.metadata?.retriever_resources ?? []).filter((r) => /^제\d+조/.test(r.content.trim())).map((r) => ({
      regulation: REG_NAMES.find(([p]) => r.document_name.startsWith(p))?.[1] ?? "학원 규정",
      content: r.content,
    }));
    const answer = out.answer ?? "";
    const unknown = /규정에 없는 내용/.test(answer);
    // 규정으로 답하면 마지막 줄에 📄 근거 안내가 붙는다. 없으면 가족 메모(우리 아이 정보)로 답한 것 → 규정 근거를 붙이지 않는다
    const personal = !unknown && !answer.includes("📄");
    await saveChatLog(who.id, q, answer, unknown ? [] : personal ? ["가족 정보"] : sources.map((x) => x.regulation), unknown ? "unknown" : "answered");
    return { answer, sources: personal ? [] : sources };
  }

  // 어드민 > 챗봇 문의 내역 (관리자·매니저만)
  private async listChatLogs(auth: string | undefined) {
    const who = verifyWho(auth);
    if (who?.t !== "staff") throw new HttpException({ message: "로그인이 필요해요." }, 401);
    const me = (await pool.query(`SELECT role, is_active FROM ${SCHEMA}.staff WHERE id = $1`, [who.id])).rows[0];
    if (!me?.is_active) throw new HttpException({ message: "로그인이 필요해요." }, 401);
    if (me.role === "member") throw new HttpException({ message: "관리자·매니저만 볼 수 있어요." }, 403);
    const r = await pool.query(
      `SELECT l.id, l.asked_at, l.question, l.answer, l.regulations, l.status, p.name AS parent_name, p.email AS parent_email
       FROM ${SCHEMA}.chat_logs l LEFT JOIN ${SCHEMA}.parents p ON p.id = l.parent_id
       ORDER BY l.asked_at DESC, l.id DESC LIMIT 500`,
    );
    return r.rows;
  }

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
    // 규정 묻기: 화면 → 백엔드 → Dify. Dify 키는 백엔드 설정값에만 둔다 (브라우저에 두면 누구나 꺼내 씀)
    if (app === "web" && fn === "askRegulation") return { data: await this.askRegulation(auth, body?.args?.[0]) };
    if (app === "admin" && fn === "listChatLogs") return { data: await this.listChatLogs(auth) };
    // 앱 푸시 구독: 업무 데이터가 아니라 따로 저장 (요청마다 불러오지 않음)
    if (app === "web" && ["savePushSubscription", "removePushSubscription", "getPushStatus"].includes(fn)) {
      const who = verifyWho(auth);
      if (who?.t !== "parent") throw new HttpException({ message: "로그인이 필요해요." }, 401);
      if (fn === "savePushSubscription") await savePushSubscription(who.id, body?.args?.[0]).catch(() => { throw new HttpException({ message: "알림을 켜지 못했어요. 다시 시도해 주세요." }, 400); });
      if (fn === "removePushSubscription") await removePushSubscription(who.id, String(body?.args?.[0] ?? ""));
      return { data: fn === "getPushStatus" ? await hasPushSubscription(who.id) : true };
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
      // 새 알림은 응답을 기다리게 하지 않고 뒤에서 푸시로 보낸다
      if (out.notifications.length) void sendPush(out.notifications).catch((e) => console.error("push", e));
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

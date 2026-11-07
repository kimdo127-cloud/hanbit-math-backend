// 어드민 화면은 이 파일만 부른다. 지금은 목업 DB, 백엔드를 붙이면 함수 안을 fetch로 바꾼다.
// 규칙 검사는 여기(= 나중의 백엔드)에 둔다. 화면은 거절 메시지만 보여 준다.
import {
  activeCount,
  attendanceRows,
  attendanceSummary,
  currentMonth,
  enrollmentsInMonth,
  monthRange,
  paymentRows,
  sessionStart,
  toMin,
  type AttendanceSummary,
  type PaymentRow,
} from "./calc";
import { checkPw, mockHash, TODAY } from "./seed";
import { inviteCode } from "./invite";
import { ADVANCE_PASS, canAdvance, judgeLevel, latestPlacement, LEVEL_MAX, LEVEL_TEST_KIND_LABEL, nextRegularTest } from "./level";
import { getSessionStaffId, loadDB, nextId, saveDB, setSessionStaffId } from "../db/store";
import type { ActivityLog, AttendanceStatus, ClassLevel, ClassRoom, ClassSchedule, DB, Grade, LevelTest, LevelTestKind, Staff, Student } from "./types";

// 변경 이력 남기기 (직원이 한 일). 백엔드에서는 같은 트랜잭션 안에서 activity_logs에 INSERT
function addLog(db: DB, me: Staff, studentId: number | null, entity: ActivityLog["entity"], action: ActivityLog["action"], summary: string) {
  const now = new Date().toTimeString().slice(0, 5);
  db.activity_logs.push({ id: nextId(db.activity_logs), at: `${TODAY}T${now}`, actor_type: "staff", actor_id: me.id, actor_name: me.name, student_id: studentId, entity, action, summary });
}
const STATUS_KO: Record<AttendanceStatus, string> = { present: "출석", late: "지각", absent: "결석" };
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export class ApiError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const wait = async () => {}; // 목업의 지연 흉내는 서버에서 뺀다
export const today = () => TODAY;
export const GRADE_LABEL: Record<Grade, string> = { 7: "중1", 8: "중2", 9: "중3", 10: "고1", 11: "고2", 12: "고3" };
export const WEEKDAY = "일월화수목금토";

export type StaffPublic = Omit<Staff, "password_hash"> & { invited: boolean }; // invited: 초대 수락 전
const pub = (s: Staff): StaffPublic => {
  const rest: Partial<Staff> = { ...s };
  delete rest.password_hash; // 비밀번호 해시는 화면으로 내보내지 않는다
  return { ...(rest as Omit<Staff, "password_hash">), invited: s.password_hash === null };
};

/* ---------- 권한 ---------- */

function requireStaff(): Staff {
  const s = loadDB().staff.find((x) => x.id === getSessionStaffId());
  if (!s || !s.is_active) throw new ApiError("로그인이 필요해요.", 401);
  return s;
}

function requireAdmin(): Staff {
  const s = requireStaff();
  if (s.role !== "admin") throw new ApiError("관리자만 할 수 있어요.", 403);
  return s;
}

// 매니저 이상 (수납·환불·보강 대신 신청·학생 관리)
function requireManager(): Staff {
  const s = requireStaff();
  if (s.role === "member") throw new ApiError("매니저 이상만 할 수 있어요.", 403);
  return s;
}

export const ROLE_LABEL: Record<Staff["role"], string> = { admin: "관리자", manager: "매니저", member: "멤버" };
// 등급별로 보이는 메뉴 (권한 매트릭스 ⑧과 맞춤)
export const canSee = (role: Staff["role"], menu: "makeups" | "payments" | "students" | "staff") =>
  menu === "staff" ? role === "admin" : role !== "member";

/* ---------- 계정 ---------- */

export async function login(email: string, password: string) {
  await wait();
  const s = loadDB().staff.find((x) => x.email === email.trim().toLowerCase());
  if (s && s.password_hash === null) throw new ApiError("아직 비밀번호를 정하지 않았어요. 초대 메일의 링크에서 먼저 정해 주세요.", 403);
  if (!s || !checkPw(password, s.password_hash)) throw new ApiError("이메일 또는 비밀번호가 맞지 않아요.", 401);
  if (!s.is_active) throw new ApiError("사용이 멈춘 계정이에요. 관리자에게 문의해 주세요.", 403);
  setSessionStaffId(s.id);
}

export function logout() {
  setSessionStaffId(null);
}

export function currentStaff(): StaffPublic | null {
  const s = loadDB().staff.find((x) => x.id === getSessionStaffId());
  return s && s.is_active ? pub(s) : null;
}

export async function changePassword(current: string, next: string) {
  await wait();
  const me = requireStaff();
  if (!checkPw(current, me.password_hash)) throw new ApiError("지금 비밀번호가 맞지 않아요.");
  if (next.length < 8) throw new ApiError("새 비밀번호는 8자 이상이어야 해요.");
  if (next === current) throw new ApiError("지금 비밀번호와 다른 비밀번호로 정해 주세요.");
  const db = loadDB();
  const s = db.staff.find((x) => x.id === me.id)!;
  s.password_hash = mockHash(next);
  saveDB(db);
}

/* ---------- 초대·재설정 링크 ----------
 * 관리자는 비밀번호를 모른다. 링크를 메일로 보내고, 직원이 직접 비밀번호를 정한다
 * 링크는 한 번만 쓰고 24시간 뒤 만료. 새 링크를 보내면 이전 링크는 못 쓴다
 * 목업: 메일 대신 시연용 링크를 돌려준다. 백엔드: 메일 발송(예: Resend) + 토큰은 해시로 저장
 */
const LINK_HOURS = 24;
const mockNow = () => `${TODAY}T${new Date().toTimeString().slice(0, 5)}`;
function issueToken(db: DB, staffId: number, purpose: "invite" | "reset") {
  const now = mockNow();
  db.staff_tokens.filter((t) => t.staff_id === staffId && !t.used_at).forEach((t) => (t.used_at = now)); // 이전 링크 무효
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  const token = Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const exp = new Date(now + ":00");
  exp.setHours(exp.getHours() + LINK_HOURS);
  const expires_at = `${exp.getFullYear()}-${String(exp.getMonth() + 1).padStart(2, "0")}-${String(exp.getDate()).padStart(2, "0")}T${exp.toTimeString().slice(0, 5)}`;
  db.staff_tokens.push({ id: nextId(db.staff_tokens), staff_id: staffId, token, purpose, created_at: now, expires_at, used_at: null });
  return { link: `/set-password?token=${token}`, expiresAt: expires_at };
}

export async function checkToken(token: string) {
  await wait();
  const db = loadDB();
  const t = db.staff_tokens.find((x) => x.token === token);
  if (!t) return { state: "invalid" as const };
  const s = db.staff.find((x) => x.id === t.staff_id)!;
  const state = t.used_at ? ("used" as const) : t.expires_at < mockNow() ? ("expired" as const) : ("ok" as const);
  return { state, purpose: t.purpose, name: s.name, email: s.email };
}

export async function setPasswordWithToken(token: string, pw: string) {
  await wait();
  const db = loadDB();
  const t = db.staff_tokens.find((x) => x.token === token);
  if (!t || t.used_at) throw new ApiError("이미 쓴 링크예요. 관리자에게 새 링크를 요청해 주세요.");
  if (t.expires_at < mockNow()) throw new ApiError("링크가 만료됐어요. 관리자에게 새 링크를 요청해 주세요.");
  if (pw.length < 8) throw new ApiError("비밀번호는 8자 이상이어야 해요.");
  const s = db.staff.find((x) => x.id === t.staff_id)!;
  s.password_hash = mockHash(pw);
  t.used_at = mockNow();
  db.activity_logs.push({ id: nextId(db.activity_logs), at: mockNow(), actor_type: "staff", actor_id: s.id, actor_name: s.name, student_id: null, entity: "staff", action: "update", summary: `${t.purpose === "invite" ? "초대 수락 · 비밀번호 설정" : "비밀번호 재설정"}: ${s.name}` });
  saveDB(db);
}

// 로그인 화면 '비밀번호를 잊었어요': 가입 여부를 알려 주지 않도록 항상 같은 안내
export async function requestReset(email: string) {
  await wait();
  const db = loadDB();
  const s = db.staff.find((x) => x.email === email.trim().toLowerCase() && x.is_active && x.password_hash !== null);
  if (!s) return { demoLink: null };
  const r = issueToken(db, s.id, "reset");
  saveDB(db);
  return { demoLink: r.link };
}

/* ---------- 직원 관리 (관리자만) ---------- */

export async function listStaff() {
  await wait();
  requireAdmin();
  return loadDB().staff.map((s) => ({ ...pub(s), lastLink: lastLink(s.id) }));
}

export interface StaffInput {
  email: string;
  name: string;
  role: Staff["role"];
  position: Staff["position"];
  subject: string | null;
}

export async function createStaff(input: StaffInput): Promise<{ id: number; link: string; expiresAt: string }> {
  await wait();
  const me = requireAdmin();
  const db = loadDB();
  const email = input.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError("이메일 형식을 확인해 주세요.");
  if (!input.name.trim()) throw new ApiError("이름을 입력해 주세요.");
  // 최종: DB UNIQUE
  if (db.staff.some((s) => s.email === email)) throw new ApiError("이미 쓰고 있는 이메일이에요.", 409);
  const id = nextId(db.staff);
  db.staff.push({
    id,
    email,
    password_hash: null, // 초대 링크에서 본인이 정한다
    name: input.name.trim(),
    role: input.role,
    position: input.position,
    subject: input.subject?.trim() || null,
    is_active: true,
  });
  addLog(db, me, null, "staff", "create", `직원 등록: ${input.name.trim()} (${input.position} · ${ROLE_LABEL[input.role]})`);
  const r = issueToken(db, id, "invite");
  saveDB(db);
  return { id, ...r };
}

export async function updateStaff(id: number, input: StaffInput) {
  await wait();
  const me = requireAdmin();
  const db = loadDB();
  const s = db.staff.find((x) => x.id === id);
  if (!s) throw new ApiError("없는 직원이에요.", 404);
  const email = input.email.trim().toLowerCase();
  if (db.staff.some((x) => x.email === email && x.id !== id)) throw new ApiError("이미 쓰고 있는 이메일이에요.", 409);
  if (s.id === me.id && input.role !== "admin") throw new ApiError("내 계정의 관리자 권한은 뺄 수 없어요.");
  const before = `${s.position} · ${ROLE_LABEL[s.role]}`;
  Object.assign(s, { email, name: input.name.trim(), role: input.role, position: input.position, subject: input.subject?.trim() || null });
  addLog(db, me, null, "staff", "update", `직원 정보 수정: ${s.name} (${before} → ${s.position} · ${ROLE_LABEL[s.role]})`);
  saveDB(db);
}

export async function setStaffActive(id: number, active: boolean) {
  await wait();
  const me = requireAdmin();
  if (id === me.id) throw new ApiError("내 계정은 멈출 수 없어요.");
  const db = loadDB();
  const s = db.staff.find((x) => x.id === id);
  if (!s) throw new ApiError("없는 직원이에요.", 404);
  if (!active && db.classes.some((c) => c.teacher_id === id))
    throw new ApiError(`${s.name}님이 맡은 강좌가 있어요. 담당 강사를 먼저 바꿔 주세요.`);
  s.is_active = active;
  addLog(db, me, null, "staff", active ? "update" : "end", `${active ? "계정 다시 사용" : "계정 사용 중지"}: ${s.name}`);
  saveDB(db);
}

// 관리자가 재설정 링크(또는 초대 수락 전이면 초대 링크)를 다시 보낸다. 기존 비밀번호는 링크를 쓸 때까지 그대로
export async function sendStaffLink(id: number) {
  await wait();
  const me = requireAdmin();
  const db = loadDB();
  const s = db.staff.find((x) => x.id === id);
  if (!s) throw new ApiError("없는 직원이에요.", 404);
  const purpose = s.password_hash === null ? "invite" : "reset";
  const r = issueToken(db, id, purpose);
  addLog(db, me, null, "staff", "update", `${purpose === "invite" ? "초대 링크 다시 보냄" : "비밀번호 재설정 링크 보냄"}: ${s.name}`);
  saveDB(db);
  return { purpose, email: s.email, ...r };
}

// 마지막으로 보낸 링크 상태 (상세 패널에 표시)
export function lastLink(id: number) {
  const t = [...loadDB().staff_tokens].reverse().find((x) => x.staff_id === id);
  if (!t) return null;
  const state = t.used_at ? "used" : t.expires_at < mockNow() ? "expired" : "pending";
  return { purpose: t.purpose, created: t.created_at, expires: t.expires_at, state, link: `/set-password?token=${t.token}` };
}

/* ---------- 강좌 ---------- */

export interface ClassInfo extends ClassRoom {
  teacherName: string;
  schedules: ClassSchedule[];
  count: number;
  nextDate: string | null; // 다음 수업일 (수강 등록 시작일)
}

function classInfo(db: DB, c: ClassRoom): ClassInfo {
  return {
    ...c,
    teacherName: db.staff.find((t) => t.id === c.teacher_id)?.name ?? "-",
    schedules: db.class_schedules.filter((s) => s.class_id === c.id).sort((a, b) => a.weekday - b.weekday),
    count: activeCount(db, c.id),
    nextDate: db.class_sessions.filter((x) => x.class_id === c.id && x.date > TODAY).sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? null,
  };
}

export function scheduleText(ss: ClassSchedule[]) {
  if (!ss.length) return "-";
  const same = ss.every((s) => s.start_time === ss[0].start_time && s.end_time === ss[0].end_time);
  return same
    ? `${ss.map((s) => WEEKDAY[s.weekday]).join("·")} ${ss[0].start_time}~${ss[0].end_time}`
    : ss.map((s) => `${WEEKDAY[s.weekday]} ${s.start_time}~${s.end_time}`).join(", ");
}

// 강사는 담당 강좌만 (권한 매트릭스 **)
const visible = (me: Staff, c: ClassRoom) => me.role !== "member" || c.teacher_id === me.id;

export async function listClasses(): Promise<ClassInfo[]> {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  return db.classes
    .filter((c) => visible(me, c))
    .map((c) => classInfo(db, c))
    .sort((a, b) => a.target_grade - b.target_grade || a.name.localeCompare(b.name));
}

export async function listTeachers(): Promise<StaffPublic[]> {
  await wait();
  requireStaff();
  return loadDB().staff.filter((s) => s.position === "강사" && s.is_active).map(pub);
}

export interface ClassInput {
  name: string;
  target_grade: Grade;
  teacher_id: number;
  capacity: number;
  monthly_fee: number;
  level: ClassLevel; // 기본 · 심화 · 최상위 (레벨테스트 판정과 같은 값)
  description: string;
  textbook: string;
  schedules: { weekday: number; start_time: string; end_time: string }[];
  plan: string[]; // 진도 계획: 앞으로의 수업일에 회차 순서대로 들어간다
}

const overlap = (a: { start_time: string; end_time: string }, b: { start_time: string; end_time: string }) =>
  a.start_time < b.end_time && b.start_time < a.end_time;

export async function saveClass(id: number | null, input: ClassInput) {
  await wait();
  const me = requireAdmin();
  const db = loadDB();
  if (!input.name.trim()) throw new ApiError("강좌 이름을 입력해 주세요.");
  if (input.schedules.length === 0) throw new ApiError("수업 요일을 하나 이상 골라 주세요.");
  // 최종: DB CHECK (end_time > start_time)
  if (input.schedules.some((s) => s.end_time <= s.start_time)) throw new ApiError("끝 시각은 시작 시각보다 늦어야 해요.");
  if (input.capacity < 1) throw new ApiError("정원은 1명 이상이어야 해요.");
  if (!["기본", "심화", "최상위"].includes(input.level)) throw new ApiError("수준은 기본·심화·최상위 중에서 골라 주세요.");
  if (id !== null && input.capacity < activeCount(db, id)) throw new ApiError(`지금 ${activeCount(db, id)}명이 다니고 있어서 정원을 더 줄일 수 없어요.`);
  // B5 같은 강사 시간 겹침 (최종: 백엔드 — 강좌·시간표 두 테이블을 함께 봐야 함)
  const teacherClasses = db.classes.filter((c) => c.teacher_id === input.teacher_id && c.id !== id);
  for (const s of input.schedules) {
    for (const c of teacherClasses) {
      const hit = db.class_schedules.find((cs) => cs.class_id === c.id && cs.weekday === s.weekday && overlap(cs, s));
      if (hit) {
        const t = db.staff.find((x) => x.id === input.teacher_id)?.name;
        throw new ApiError(`${t}님은 ${WEEKDAY[s.weekday]}요일 ${hit.start_time}~${hit.end_time}에 ${c.name} 수업이 있어요.`, 409);
      }
    }
  }

  const fields = {
    name: input.name.trim(),
    target_grade: input.target_grade,
    teacher_id: input.teacher_id,
    capacity: input.capacity,
    monthly_fee: input.monthly_fee,
    level: input.level,
    description: input.description.trim(),
    textbook: input.textbook.trim(),
  };
  let classId = id;
  if (id === null) {
    classId = nextId(db.classes);
    db.classes.push({ id: classId, ...fields });
  } else {
    const c = db.classes.find((x) => x.id === id);
    if (!c) throw new ApiError("없는 강좌예요.", 404);
    Object.assign(c, fields);
  }
  // 시간표 교체 + 앞으로의 수업일 다시 만들기 (지난 수업일은 출결 기록 때문에 그대로)
  db.class_schedules = db.class_schedules.filter((s) => s.class_id !== classId);
  input.schedules.forEach((s) => db.class_schedules.push({ id: nextId(db.class_schedules), class_id: classId!, ...s }));
  const used = new Set(db.attendances.map((a) => a.session_id).concat(db.makeups.map((m) => m.session_id)));
  db.class_sessions = db.class_sessions.filter((s) => s.class_id !== classId || s.date <= TODAY || used.has(s.id));
  const end = new Date(2026, 10, 30);
  for (let d = new Date(TODAY + "T00:00"); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (ds <= TODAY) continue;
    if (input.schedules.some((s) => s.weekday === d.getDay()) && !db.class_sessions.some((s) => s.class_id === classId && s.date === ds))
      db.class_sessions.push({ id: nextId(db.class_sessions), class_id: classId!, date: ds, topic: null });
  }
  // 진도 계획을 앞으로의 수업일에 회차 순서대로 넣는다 (계획이 수업일보다 적으면 나머지는 비움)
  db.class_sessions
    .filter((s) => s.class_id === classId && s.date > TODAY)
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((s, i) => (s.topic = input.plan[i]?.trim() || null));
  addLog(db, me, null, "class", id === null ? "create" : "update", `강좌 ${id === null ? "등록" : "수정"}: ${fields.name}`);
  saveDB(db);
}

export interface RosterRow {
  enrollmentId: number;
  student: Student;
  start_date: string;
  attendance: AttendanceSummary;
  offGrade: boolean; // 대상 학년이 아닌 학생 (선행·복습)
}

export async function getClassDetail(id: number, month = currentMonth()) {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const c = db.classes.find((x) => x.id === id);
  if (!c || !visible(me, c)) throw new ApiError("없는 강좌예요.", 404);
  const roster: RosterRow[] = db.enrollments
    .filter((e) => e.class_id === id && e.end_date === null)
    .map((e) => {
      const s = db.students.find((x) => x.id === e.student_id)!;
      return { enrollmentId: e.id, student: s, start_date: e.start_date, attendance: attendanceSummary(db, s.id, month), offGrade: s.grade !== c.target_grade };
    })
    .sort((a, b) => a.student.name.localeCompare(b.student.name));
  const sessions = db.class_sessions.filter((s) => s.class_id === id).sort((a, b) => a.date.localeCompare(b.date));
  const plan = sessions.filter((s) => s.date > TODAY).map((s) => ({ date: s.date, topic: s.topic }));
  const recent = sessions.filter((s) => s.date <= TODAY).slice(-4).reverse().map((s) => ({ date: s.date, topic: s.topic }));
  return { cls: classInfo(db, c), roster, plan, recent };
}

/* ---------- 학생 ---------- */

export interface StudentRow {
  student: Student;
  classes: string[];
  offGrade: boolean; // 대상 학년이 아닌 강좌를 다님 (선행·복습)
  active: boolean; // 다니는 강좌가 있음
  enrolledBefore: boolean; // 수강 기록이 있음 (없으면 등록만 하고 수강 전)
  attendance: AttendanceSummary;
  unpaid: number;
  level: string | null; // 최근 레벨테스트 판정 (정기·입학)
}

export async function listStudents(month = currentMonth()): Promise<StudentRow[]> {
  await wait();
  requireManager();
  const db = loadDB();
  return db.students
    .map((s) => {
      const act = db.enrollments.filter((e) => e.student_id === s.id && e.end_date === null).map((e) => db.classes.find((c) => c.id === e.class_id)!);
      return {
      student: s,
      classes: act.map((c) => c.name),
      offGrade: act.some((c) => c.target_grade !== s.grade),
      active: act.length > 0,
      enrolledBefore: db.enrollments.some((e) => e.student_id === s.id),
      attendance: attendanceSummary(db, s.id, month),
      unpaid: paymentRows(db, s, month).filter((p) => p.status === "unpaid").reduce((t, p) => t + p.amount, 0),
      level: latestPlacement(db, s.id)?.result_level ?? null,
      };
    })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.student.grade - b.student.grade || a.student.name.localeCompare(b.student.name));
}

export async function getStudentDetail(id: number, month = currentMonth()) {
  await wait();
  requireManager();
  const db = loadDB();
  const s = db.students.find((x) => x.id === id);
  if (!s) throw new ApiError("없는 학생이에요.", 404);
  const siblings = db.students.filter((x) => x.family_id === s.family_id && x.id !== s.id);
  return {
    student: s,
    siblings,
    parent: db.parents.find((p) => p.family_id === s.family_id) ?? null,
    contacts: db.student_contacts.filter((c) => c.student_id === id),
    enrollments: db.enrollments
      .filter((e) => e.student_id === id)
      .sort((a, b) => Number(a.end_date !== null) - Number(b.end_date !== null))
      .map((e) => {
        const c = db.classes.find((x) => x.id === e.class_id)!;
        return { ...e, className: c.name, offGrade: c.target_grade !== s.grade };
      }),
    attendance: attendanceSummary(db, id, month),
    records: attendanceRows(db, id, month), // 이번 달 출결 기록 (등원 시각·수업 내용)
    payments: paymentRows(db, s, month),
    paymentHistory: [...new Set(db.payments.filter((p) => p.student_id === id).map((p) => p.month))]
      .sort((a, b) => b.localeCompare(a))
      .flatMap((m) => paymentRows(db, s, m).map((r) => ({ ...r, month: m }))),
    logs: db.activity_logs.filter((l) => l.student_id === id).sort((a, b) => b.at.localeCompare(a.at)),
    levelTests: db.level_tests.filter((t) => t.student_id === id).sort((a, b) => b.tested_on.localeCompare(a.tested_on) || b.id - a.id).map(viewTest),
    canAdvance: canAdvance(db, id),
  };
}

export async function updateStudent(id: number, input: { name: string; grade: Grade; school: string; birth_date: string }) {
  await wait();
  const me = requireManager();
  if (!input.name.trim() || !input.school.trim() || !input.birth_date) throw new ApiError("이름, 학교, 생년월일을 확인해 주세요.");
  const db = loadDB();
  const s = db.students.find((x) => x.id === id);
  if (!s) throw new ApiError("없는 학생이에요.", 404);
  const before = `${s.name} · ${GRADE_LABEL[s.grade]} · ${s.school} · ${s.birth_date}`;
  Object.assign(s, { name: input.name.trim(), grade: input.grade, school: input.school.trim(), birth_date: input.birth_date });
  const after = `${s.name} · ${GRADE_LABEL[s.grade]} · ${s.school} · ${s.birth_date}`;
  if (before !== after) addLog(db, me, id, "student", "update", `학생 정보 수정: ${before} → ${after}`);
  saveDB(db);
}

// 학생 등록 (상담 후 학원이 한다). 보호자 번호가 학부모 앱 가입의 열쇠가 된다
// 이미 등록된 보호자 번호면 그 가족에 붙인다 (형제 → 둘째 할인)
export async function createStudent(input: { name: string; grade: Grade; school: string; birth_date: string; guardians: { relation: string; phone: string }[] }) {
  await wait();
  const me = requireManager();
  if (!input.name.trim() || !input.school.trim() || !input.birth_date) throw new ApiError("이름, 학교, 생년월일을 확인해 주세요.");
  const guardians = input.guardians.map((g) => ({ relation: g.relation.trim(), phone: g.phone.trim() })).filter((g) => g.relation || g.phone);
  if (guardians.length === 0) throw new ApiError("보호자 연락처를 한 개 이상 넣어 주세요. 학부모 앱 가입에 쓰여요.");
  if (guardians.some((g) => !g.relation || !/^[0-9-]{9,13}$/.test(g.phone))) throw new ApiError("보호자 관계와 휴대폰 번호를 확인해 주세요.");
  const db = loadDB();
  const digits = (p: string) => p.replace(/[^0-9]/g, "");
  const linked = db.student_contacts.filter((c) => guardians.some((g) => digits(g.phone) === digits(c.phone)));
  const known = linked[0];
  const sameKid = db.students.find((s) => linked.some((c) => c.student_id === s.id) && s.name === input.name.trim());
  if (sameKid) throw new ApiError(`${sameKid.name} 학생은 이미 등록되어 있어요.`, 409);
  let familyId = known ? db.students.find((s) => s.id === known.student_id)!.family_id : null;
  if (familyId === null) {
    familyId = nextId(db.families);
    db.families.push({ id: familyId, name: `${input.name.trim()} 가족` });
  }
  const sid = nextId(db.students);
  db.students.push({ id: sid, family_id: familyId, name: input.name.trim(), grade: input.grade, school: input.school.trim(), birth_date: input.birth_date });
  guardians.forEach((g) => db.student_contacts.push({ id: nextId(db.student_contacts), student_id: sid, relation: g.relation, phone: g.phone }));
  const sibling = known ? db.students.find((s) => s.id === known.student_id)!.name : null;
  addLog(db, me, sid, "student", "create", `학생 등록: ${input.name.trim()} · ${GRADE_LABEL[input.grade]} · ${input.school.trim()}${sibling ? ` (${sibling} 학생과 같은 가족)` : ""}`);
  saveDB(db);
  // 초대 문자에 넣을 가입 링크 코드 (보호자 번호마다 하나)
  return { id: sid, sibling, invites: guardians.map((g) => ({ relation: g.relation, phone: g.phone, code: inviteCode(g.phone) })) };
}

export async function endEnrollment(enrollmentId: number, endDate: string) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const e = db.enrollments.find((x) => x.id === enrollmentId);
  if (!e) throw new ApiError("없는 수강이에요.", 404);
  if (e.end_date) throw new ApiError("이미 중단된 수강이에요.");
  if (endDate < e.start_date) throw new ApiError("수강 중단일은 시작일보다 빠를 수 없어요.");
  e.end_date = endDate;
  addLog(db, me, e.student_id, "enrollment", "end", `수강 중단: ${db.classes.find((c) => c.id === e.class_id)!.name} (${md(endDate)}, 운영 처리)`);
  saveDB(db);
}

/* ---------- 출결 ---------- */

export async function listSessionDates(classId: number, month: string): Promise<string[]> {
  await wait();
  requireStaff();
  const { start, end } = monthRange(month);
  return loadDB()
    .class_sessions.filter((s) => s.class_id === classId && s.date >= start && s.date <= end)
    .map((s) => s.date)
    .sort();
}

export interface SheetRow {
  student: Student;
  status: AttendanceStatus | null;
  checkedAt: string | null;
  source: "kiosk" | "staff" | null;
  offGrade: boolean;
}

export async function getAttendanceSheet(classId: number, date: string) {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const cls = db.classes.find((c) => c.id === classId);
  if (!cls || !visible(me, cls)) throw new ApiError("담당 강좌만 볼 수 있어요.", 403);
  const session = db.class_sessions.find((s) => s.class_id === classId && s.date === date);
  if (!session) throw new ApiError("이 날은 수업이 없어요.", 404);
  const rows: SheetRow[] = db.enrollments
    .filter((e) => e.class_id === classId && e.start_date <= date && (e.end_date === null || e.end_date > date))
    .map((e) => {
      const s = db.students.find((x) => x.id === e.student_id)!;
      const a = db.attendances.find((x) => x.session_id === session.id && x.student_id === s.id);
      return { student: s, status: a?.status ?? null, checkedAt: a?.checked_at ?? null, source: a?.source ?? null, offGrade: s.grade !== cls.target_grade };
    })
    .sort((a, b) => a.student.name.localeCompare(b.student.name));
  // 이 수업에 보강으로 들어오는 학생 (보강 → 결석 기록 → 학생)
  const makeupStudents = db.makeups
    .filter((m) => m.session_id === session.id)
    .map((m) => {
      const abs = db.attendances.find((a) => a.id === m.absence_id)!;
      const s = db.students.find((x) => x.id === abs.student_id)!;
      const absSession = db.class_sessions.find((x) => x.id === abs.session_id)!;
      return { student: s, fromClass: db.classes.find((c) => c.id === absSession.class_id)!.name, absentDate: absSession.date };
    });
  return { sessionId: session.id, date, startTime: sessionStart(db, session), topic: session.topic, future: date > TODAY, rows, makeupStudents };
}

// 등원 시각으로 지각을 정한다 (강좌 시작 시각보다 늦으면 지각)
export function statusByTime(start: string, checkedAt: string): AttendanceStatus {
  return toMin(checkedAt) > toMin(start) ? "late" : "present";
}

export async function saveAttendance(sessionId: number, entries: { studentId: number; status: AttendanceStatus; checkedAt: string | null }[]) {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const session = db.class_sessions.find((s) => s.id === sessionId);
  if (!session) throw new ApiError("없는 수업일이에요.", 404);
  const cls = db.classes.find((c) => c.id === session.class_id)!;
  if (!visible(me, cls)) throw new ApiError("담당 강좌만 출결을 입력할 수 있어요.", 403);
  if (session.date > TODAY) throw new ApiError("아직 오지 않은 수업일이에요.");
  const label = (st: AttendanceStatus, t: string | null) => `${STATUS_KO[st]}${t ? `(${t})` : ""}`;
  for (const { studentId, status, checkedAt } of entries) {
    if (status !== "absent" && !checkedAt) throw new ApiError("출석·지각은 등원 시각이 있어야 해요.");
    // 같은 학생·같은 수업일 출결은 하나 (최종: DB UNIQUE) → 있으면 고침
    const a = db.attendances.find((x) => x.session_id === sessionId && x.student_id === studentId);
    const value = { status, checked_at: status === "absent" ? null : checkedAt, source: "staff" as const };
    if (a) {
      if (a.status === "absent" && status !== "absent" && db.makeups.some((m) => m.absence_id === a.id))
        throw new ApiError("보강을 신청한 결석이에요. 보강을 먼저 취소해 주세요.");
      // 바뀐 게 없으면 그대로 (키오스크 기록을 강사 기록으로 덮지 않게)
      if (a.status === value.status && a.checked_at === value.checked_at) continue;
      // 처음 입력은 이력에 남기지 않고, 이미 있던 출결을 바꿀 때만 남긴다
      addLog(db, me, studentId, "attendance", "update", `출결 수정 ${md(session.date)} ${cls.name}: ${label(a.status, a.checked_at)} → ${label(value.status, value.checked_at)}`);
      Object.assign(a, value);
    } else db.attendances.push({ id: nextId(db.attendances), session_id: sessionId, student_id: studentId, ...value });
  }
  saveDB(db);
}

/* ---------- 보강 (고객이 앱에서 신청, 운영은 조회 + 전화 요청 시 대신 신청·취소) ---------- */

export type MakeupState = "available" | "booked" | "done" | "full" | "expired";

export interface MakeupRow {
  attendanceId: number;
  student: Student;
  date: string; // 결석일
  className: string;
  deadline: string;
  state: MakeupState;
  booked: { makeupId: number; date: string; className: string; time: string; requestedAt: string } | null;
}

function timeOf(db: DB, classId: number, date: string) {
  const sc = db.class_schedules.find((y) => y.class_id === classId && y.weekday === new Date(date + "T00:00").getDay());
  return sc ? `${sc.start_time}~${sc.end_time}` : "";
}

function sessionHeadcount(db: DB, sessionId: number) {
  const sess = db.class_sessions.find((s) => s.id === sessionId)!;
  const regular = db.enrollments.filter(
    (e) => e.class_id === sess.class_id && e.start_date <= sess.date && (e.end_date === null || e.end_date > sess.date),
  ).length;
  const makeups = db.makeups.filter((m) => m.session_id === sessionId).length;
  return { regular, makeups };
}

export interface MakeupSlot {
  sessionId: number;
  date: string;
  className: string;
  time: string;
  regular: number;
  makeups: number;
  capacity: number;
}

// 결석한 강좌가 아닌, 같은 학년 강좌의 같은 달 수업일 중 오늘 이후·자리 있는 날
function slotsFor(db: DB, attendanceId: number): MakeupSlot[] {
  const abs = db.attendances.find((a) => a.id === attendanceId)!;
  const absSess = db.class_sessions.find((s) => s.id === abs.session_id)!;
  const student = db.students.find((s) => s.id === abs.student_id)!;
  const { end } = monthRange(absSess.date.slice(0, 7));
  return db.class_sessions
    .filter((s) => s.class_id !== absSess.class_id && s.date > absSess.date && s.date > TODAY && s.date <= end)
    .map((s) => ({ s, c: db.classes.find((c) => c.id === s.class_id)! }))
    .filter(({ c }) => c.target_grade === student.grade)
    .map(({ s, c }) => ({ sessionId: s.id, date: s.date, className: c.name, time: timeOf(db, c.id, s.date), ...sessionHeadcount(db, s.id), capacity: c.capacity }))
    .filter((x) => x.regular + x.makeups < x.capacity)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 이번 달 결석 전체와 보강 상태 (결석 1건마다 보강 1회)
export async function listMakeups(month = currentMonth()): Promise<MakeupRow[]> {
  await wait();
  requireManager();
  const db = loadDB();
  const { start, end } = monthRange(month);
  return db.attendances
    .filter((a) => a.status === "absent")
    .map((a) => ({ a, sess: db.class_sessions.find((x) => x.id === a.session_id)! }))
    .filter(({ sess }) => sess.date >= start && sess.date <= end)
    .map(({ a, sess }) => {
      const mk = db.makeups.find((m) => m.absence_id === a.id);
      const ms = mk ? db.class_sessions.find((x) => x.id === mk.session_id)! : null;
      const booked =
        mk && ms ? { makeupId: mk.id, date: ms.date, className: db.classes.find((c) => c.id === ms.class_id)!.name, time: timeOf(db, ms.class_id, ms.date), requestedAt: mk.requested_at } : null;
      const deadline = end;
      const state: MakeupState = booked ? (booked.date > TODAY ? "booked" : "done") : deadline < TODAY ? "expired" : slotsFor(db, a.id).length ? "available" : "full";
      return { attendanceId: a.id, student: db.students.find((s) => s.id === a.student_id)!, date: sess.date, className: db.classes.find((c) => c.id === sess.class_id)!.name, deadline, state, booked };
    })
    .sort((x, y) => x.date.localeCompare(y.date));
}

export async function listMakeupSlots(attendanceId: number): Promise<MakeupSlot[]> {
  await wait();
  requireManager();
  return slotsFor(loadDB(), attendanceId);
}

export async function createMakeup(attendanceId: number, sessionId: number) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const abs = db.attendances.find((a) => a.id === attendanceId);
  if (!abs || abs.status !== "absent") throw new ApiError("결석한 수업만 보강을 신청할 수 있어요.");
  // 결석 1건에 보강 1건 (최종: DB UNIQUE)
  if (db.makeups.some((m) => m.absence_id === attendanceId)) throw new ApiError("이 결석은 이미 보강을 신청했어요.", 409);
  const absSess = db.class_sessions.find((s) => s.id === abs.session_id)!;
  const target = db.class_sessions.find((s) => s.id === sessionId);
  if (!target) throw new ApiError("없는 수업일이에요.", 404);
  if (target.class_id === absSess.class_id) throw new ApiError("보강은 다른 강좌 수업에 넣어야 해요.");
  if (target.date.slice(0, 7) !== absSess.date.slice(0, 7)) throw new ApiError("보강은 결석한 달 안에만 신청할 수 있어요.");
  if (target.date <= TODAY) throw new ApiError("지난 수업에는 보강을 신청할 수 없어요.");
  // B7 그날 인원(원래 학생 + 보강 학생)이 정원을 넘으면 안 됨 (최종: 백엔드)
  const cls = db.classes.find((c) => c.id === target.class_id)!;
  const { regular, makeups } = sessionHeadcount(db, sessionId);
  if (regular + makeups >= cls.capacity)
    throw new ApiError(`${cls.name} ${Number(target.date.slice(5, 7))}월 ${Number(target.date.slice(8))}일 수업은 원래 ${regular}명 + 보강 ${makeups}명으로 정원 ${cls.capacity}명이 찼어요.`, 409);
  db.makeups.push({ id: nextId(db.makeups), absence_id: attendanceId, session_id: sessionId, requested_at: `${TODAY}T${new Date().toTimeString().slice(0, 5)}` });
  addLog(db, me, abs.student_id, "makeup", "create", `보강 대신 신청: ${md(absSess.date)} 결석분 → ${md(target.date)} ${cls.name} (전화 요청)`);
  saveDB(db);
}

export async function deleteMakeup(makeupId: number) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const mk = db.makeups.find((m) => m.id === makeupId);
  if (!mk) throw new ApiError("없는 보강이에요.", 404);
  const sess = db.class_sessions.find((s) => s.id === mk.session_id)!;
  if (sess.date <= TODAY) throw new ApiError("이미 지난 보강은 취소할 수 없어요.");
  db.makeups = db.makeups.filter((m) => m.id !== makeupId);
  const abs = db.attendances.find((a) => a.id === mk.absence_id)!;
  addLog(db, me, abs.student_id, "makeup", "cancel", `보강 취소: ${md(sess.date)} ${db.classes.find((c) => c.id === sess.class_id)!.name} (운영 처리)`);
  saveDB(db);
}

/* ---------- 수납 ---------- */

export async function listPayments(month: string): Promise<(PaymentRow & { grade: Grade })[]> {
  await wait();
  requireManager();
  const db = loadDB();
  return db.students
    .filter((s) => enrollmentsInMonth(db, s.id, month).length > 0)
    .flatMap((s) => paymentRows(db, s, month).map((p) => ({ ...p, grade: s.grade })))
    .sort((a, b) => Number(a.status === "paid") - Number(b.status === "paid") || a.studentName.localeCompare(b.studentName));
}

export async function markPaid(studentId: number, classId: number, month: string, paidAt: string) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const s = db.students.find((x) => x.id === studentId)!;
  const row = paymentRows(db, s, month).find((p) => p.classId === classId);
  if (!row) throw new ApiError("그 달에 다니지 않은 강좌예요.");
  // 낸 금액은 그때 기준으로 저장 (형제가 수강을 중단해도 바뀌지 않게)
  const p = db.payments.find((x) => x.student_id === studentId && x.class_id === classId && x.month === month);
  if (p) {
    if (p.paid_at) throw new ApiError("이미 납부 처리됐어요.");
    p.paid_amount = row.amount;
    p.paid_at = paidAt;
  } else db.payments.push({ id: nextId(db.payments), student_id: studentId, class_id: classId, month, paid_amount: row.amount, paid_at: paidAt });
  addLog(db, me, studentId, "payment", "create", `납부 등록: ${Number(month.slice(5))}월 ${row.className} ${row.amount.toLocaleString()}원 (${md(paidAt)} 납부)`);
  saveDB(db);
}

export async function cancelPaid(studentId: number, classId: number, month: string) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const p = db.payments.find((x) => x.student_id === studentId && x.class_id === classId && x.month === month);
  if (p) {
    addLog(db, me, studentId, "payment", "cancel", `납부 취소: ${Number(month.slice(5))}월 ${db.classes.find((c) => c.id === classId)!.name} ${(p.paid_amount ?? 0).toLocaleString()}원`);
    p.paid_amount = null;
    p.paid_at = null;
    saveDB(db);
  }
}

/* ---------- 환불 (수강 중단 → 5일 안에 환불, 학원법 시행령 별표4) ---------- */

export const REFUND_DAYS = 5;

const addDays = (d: string, n: number) => {
  const t = new Date(d + "T00:00");
  t.setDate(t.getDate() + n);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T00:00").getTime() - new Date(a + "T00:00").getTime()) / 86400000);

function refundCalc(db: DB, e: { student_id: number; class_id: number; start_date: string; end_date: string }) {
  const month = e.end_date.slice(0, 7);
  const { start, end } = monthRange(month);
  const sessions = db.class_sessions.filter((x) => x.class_id === e.class_id && x.date >= start && x.date <= end && x.date >= e.start_date);
  const done = sessions.filter((x) => x.date < e.end_date).length; // 중단일부터는 수업을 듣지 않는다
  const total = sessions.length;
  const ratio = total === 0 || done === 0 ? 1 : done < total / 3 ? 2 / 3 : done < total / 2 ? 1 / 2 : 0;
  const pay = db.payments.find((p) => p.student_id === e.student_id && p.class_id === e.class_id && p.month === month && p.paid_at);
  const paid = pay?.paid_amount ?? 0;
  return {
    month,
    done,
    total,
    paid,
    amount: Math.floor((paid * ratio) / 10) * 10,
    rule: done === 0 ? "수업 시작 전 · 전액" : ratio === 2 / 3 ? "1/3 지나기 전 · 2/3" : ratio === 1 / 2 ? "1/2 지나기 전 · 1/2" : "1/2 지남 · 환불 없음",
  };
}

export interface RefundRow {
  enrollmentId: number;
  student: Student;
  className: string;
  endDate: string;
  due: string; // 환불 기한
  dLeft: number; // 기한까지 남은 날 (음수면 지남)
  calc: ReturnType<typeof refundCalc>;
  refundedAt: string | null;
  refundAmount: number | null;
}

export const fmtRefundDue = (r: { dLeft: number; due: string }) => (r.dLeft === 0 ? "오늘까지" : `D-${r.dLeft} · ${r.due.slice(5).replace("-", "/")}까지`);

export async function listRefunds(): Promise<RefundRow[]> {
  await wait();
  requireManager();
  const db = loadDB();
  return db.enrollments
    .filter((e) => e.end_date)
    .map((e) => {
      const due = addDays(e.end_date!, REFUND_DAYS);
      return {
        enrollmentId: e.id,
        student: db.students.find((s) => s.id === e.student_id)!,
        className: db.classes.find((c) => c.id === e.class_id)!.name,
        endDate: e.end_date!,
        due,
        dLeft: daysBetween(TODAY, due),
        calc: refundCalc(db, { ...e, end_date: e.end_date! }),
        refundedAt: e.refunded_at,
        refundAmount: e.refund_amount,
      };
    })
    .sort((a, b) => Number(!!a.refundedAt) - Number(!!b.refundedAt) || a.due.localeCompare(b.due));
}

export async function markRefunded(enrollmentId: number, amount: number, date: string) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const e = db.enrollments.find((x) => x.id === enrollmentId);
  if (!e || !e.end_date) throw new ApiError("수강 중단된 기록만 환불 처리할 수 있어요.");
  if (e.refunded_at) throw new ApiError("이미 환불 처리됐어요.", 409);
  if (amount < 0) throw new ApiError("환불 금액을 확인해 주세요.");
  const { paid } = refundCalc(db, { ...e, end_date: e.end_date });
  if (amount > paid) throw new ApiError(`낸 금액(${paid.toLocaleString()}원)보다 많이 돌려줄 수 없어요.`);
  e.refund_amount = amount;
  e.refunded_at = date;
  addLog(db, me, e.student_id, "refund", "create", `환불 기록: ${amount.toLocaleString()}원 (${md(date)})`);
  saveDB(db);
}

/* ---------- 대시보드 ---------- */

export async function getDashboard() {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const month = currentMonth();
  const wd = new Date(TODAY + "T00:00").getDay();
  const todayClasses = db.class_schedules
    .filter((s) => s.weekday === wd)
    .map((s) => ({ s, c: db.classes.find((c) => c.id === s.class_id)! }))
    .filter(({ c }) => visible(me, c))
    .sort((a, b) => a.s.start_time.localeCompare(b.s.start_time))
    .map(({ s, c }) => {
      const sess = db.class_sessions.find((x) => x.class_id === c.id && x.date === TODAY);
      const atts = sess ? db.attendances.filter((a) => a.session_id === sess.id) : [];
      const expected = sess ? db.enrollments.filter((e) => e.class_id === c.id && e.start_date <= TODAY && (e.end_date === null || e.end_date > TODAY)).length : 0;
      const makeupIn = sess ? db.makeups.filter((m) => m.session_id === sess.id).length : 0;
      return {
        classId: c.id,
        name: c.name,
        time: `${s.start_time}~${s.end_time}`,
        teacher: db.staff.find((t) => t.id === c.teacher_id)?.name ?? "",
        topic: sess?.topic ?? null,
        expected,
        makeupIn,
        arrived: atts.filter((a) => a.status !== "absent").length,
        absent: atts.filter((a) => a.status === "absent").length,
        late: atts.filter((a) => a.status === "late").length,
        done: atts.length > 0,
        start: s.start_time,
        missing: Math.max(0, expected - atts.filter((a) => db.enrollments.some((e) => e.student_id === a.student_id && e.class_id === c.id)).length),
      };
    });
  const unpaid = db.students.flatMap((s) => paymentRows(db, s, month).filter((p) => p.status === "unpaid"));
  const refundsDue = db.enrollments
    .filter((e) => e.end_date && !e.refunded_at)
    .map((e) => {
      const due = addDays(e.end_date!, REFUND_DAYS);
      return { enrollmentId: e.id, name: db.students.find((s) => s.id === e.student_id)!.name, className: db.classes.find((c) => c.id === e.class_id)!.name, due, dLeft: daysBetween(TODAY, due), amount: refundCalc(db, { ...e, end_date: e.end_date! }).amount };
    })
    .sort((a, b) => a.due.localeCompare(b.due));
  const makeupsUpcoming = db.makeups
    .map((m) => ({ m, s: db.class_sessions.find((x) => x.id === m.session_id)! }))
    .filter(({ s }) => s.date > TODAY && s.date <= addDays(TODAY, 7)).length;
  const nearFull = db.classes
    .map((c) => ({ name: c.name, left: c.capacity - activeCount(db, c.id) }))
    .filter((c) => c.left <= 1)
    .sort((a, b) => a.left - b.left);
  // 멤버(강사)는 담당 강좌 수업만 보고, 수납·환불은 보지 않는다
  const member = me.role === "member";
  return { me: pub(me), month, today: TODAY, todayClasses, unpaid: member ? [] : unpaid, refundsDue: member ? [] : refundsDue, makeupsUpcoming, nearFull, member };
}

/* ---------- 등원 키오스크 (입구 태블릿, 학생이 직접) ----------
 * 보호자 연락처 뒷자리 4자리 → 오늘 수업이 있는 학생 → 이름 눌러 등원
 * 등원 시각은 누른 시각, 강좌 시작보다 늦으면 자동 지각. 보호자에게 등원 알림(목업에서는 표시만)
 */
export interface KioskCandidate {
  studentId: number;
  name: string;
  grade: Grade;
  sessionId: number;
  className: string;
  start: string;
  checkedAt: string | null; // 이미 등원했으면 시각
  makeup: boolean; // 보강으로 오는 수업
}

function todaySessionsFor(db: DB, studentId: number) {
  const regular = db.enrollments
    .filter((e) => e.student_id === studentId && e.start_date <= TODAY && (e.end_date === null || e.end_date > TODAY))
    .map((e) => db.class_sessions.find((x) => x.class_id === e.class_id && x.date === TODAY))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => ({ x, makeup: false }));
  const makeups = db.makeups
    .filter((m) => db.attendances.find((a) => a.id === m.absence_id)?.student_id === studentId)
    .map((m) => db.class_sessions.find((x) => x.id === m.session_id)!)
    .filter((x) => x.date === TODAY)
    .map((x) => ({ x, makeup: true }));
  return [...regular, ...makeups];
}

export async function kioskLookup(last4: string): Promise<KioskCandidate[]> {
  await wait();
  requireStaff(); // 키오스크 태블릿은 직원 계정으로 로그인해 둔다
  if (!/^\d{4}$/.test(last4)) throw new ApiError("번호 4자리를 눌러 주세요.");
  const db = loadDB();
  const ids = [...new Set(db.student_contacts.filter((c) => c.phone.replace(/\D/g, "").endsWith(last4)).map((c) => c.student_id))];
  return ids.flatMap((id) => {
    const st = db.students.find((x) => x.id === id)!;
    return todaySessionsFor(db, id).map(({ x, makeup }) => {
      const a = db.attendances.find((y) => y.session_id === x.id && y.student_id === id);
      return { studentId: id, name: st.name, grade: st.grade, sessionId: x.id, className: db.classes.find((c) => c.id === x.class_id)!.name, start: sessionStart(db, x), checkedAt: a?.checked_at ?? null, makeup };
    });
  });
}

export async function kioskCheckIn(studentId: number, sessionId: number) {
  await wait();
  requireStaff();
  const db = loadDB();
  const sess = db.class_sessions.find((x) => x.id === sessionId);
  if (!sess || sess.date !== TODAY) throw new ApiError("오늘 수업이 아니에요.");
  const a = db.attendances.find((y) => y.session_id === sessionId && y.student_id === studentId);
  if (a?.checked_at) throw new ApiError(`이미 ${a.checked_at}에 등원했어요.`, 409);
  const now = new Date().toTimeString().slice(0, 5);
  const status = statusByTime(sessionStart(db, sess), now);
  if (a) Object.assign(a, { status, checked_at: now, source: "kiosk" as const });
  else db.attendances.push({ id: nextId(db.attendances), session_id: sessionId, student_id: studentId, status, checked_at: now, source: "kiosk" });
  saveDB(db);
  const st = db.students.find((x) => x.id === studentId)!;
  return { name: st.name, time: now, status, late: status === "late" ? toMin(now) - toMin(sessionStart(db, sess)) : 0, className: db.classes.find((c) => c.id === sess.class_id)!.name };
}

/* ---------- 수강 등록 (운영이 대신) ----------
 * 고객 앱 수강 신청과 같은 규칙(정원, 이미 수강 중이면 거절). 단 학년이 달라도 등록 가능 (선행·복습은 상담·레벨 테스트 후 학원만),
 * 시작일은 그 강좌의 다음 수업일(시스템이 정함). 접수 경로를 함께 남긴다
 */
export const ENROLL_CHANNELS = ["상담 후 배정", "전화 요청", "방문 요청", "기타"] as const;
export type EnrollChannel = (typeof ENROLL_CHANNELS)[number];

export function nextSessionDate(classId: number) {
  return loadDB().class_sessions.filter((x) => x.class_id === classId && x.date > TODAY).sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? null;
}

export async function enrollByStaff(studentId: number, classId: number, channel: EnrollChannel, memo: string) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const s = db.students.find((x) => x.id === studentId);
  const c = db.classes.find((x) => x.id === classId);
  if (!s || !c) throw new ApiError("학생이나 강좌를 찾을 수 없어요.", 404);
  // B2 같은 강좌 동시 수강 불가 (최종: DB 부분 UNIQUE)
  if (db.enrollments.some((e) => e.student_id === s.id && e.class_id === c.id && e.end_date === null)) throw new ApiError(`${s.name} 학생은 이미 ${c.name} 강좌를 듣고 있어요.`, 409);
  // B3 정원 (최종: 백엔드 + 트랜잭션)
  if (activeCount(db, c.id) >= c.capacity) throw new ApiError(`${c.name} 강좌는 정원 ${c.capacity}명이 다 찼어요.`, 409);
  const start = nextSessionDate(c.id);
  if (!start) throw new ApiError("예정된 수업이 없어 지금은 등록할 수 없어요.");
  db.enrollments.push({ id: nextId(db.enrollments), student_id: s.id, class_id: c.id, start_date: start, end_date: null, refund_amount: null, refunded_at: null });
  addLog(db, me, s.id, "enrollment", "create", `수강 등록: ${c.name} (${md(start)} 시작) · ${channel}${memo.trim() ? ` · ${memo.trim()}` : ""}${s.grade !== c.target_grade ? " · 학년 다른 강좌" : ""}`);
  saveDB(db);
  return { start };
}


/* ---------- 레벨테스트 ---------- */
// 정기(2월·8월) · 입학 · 선행. 판정은 점수로 백엔드가 계산한다 (직원이 레벨을 고르지 않음)
// 입력 권한: 관리자·매니저는 모든 학생, 멤버(강사)는 담당 강좌 학생만

export interface LevelTestView extends LevelTest {
  kindLabel: string;
  staffName: string;
}
function viewTest(t: LevelTest): LevelTestView {
  return { ...t, kindLabel: LEVEL_TEST_KIND_LABEL[t.kind], staffName: loadDB().staff.find((x) => x.id === t.staff_id)?.name ?? "" };
}
export const levelTestRules = () => ({ max: LEVEL_MAX, advancePass: ADVANCE_PASS, nextRegular: nextRegularTest(TODAY) });

function canEditStudentTests(db: DB, me: Staff, studentId: number) {
  if (me.role !== "member") return true;
  return db.enrollments.some((e) => e.student_id === studentId && e.end_date === null && db.classes.find((c) => c.id === e.class_id)?.teacher_id === me.id);
}

export interface LevelScoreInput {
  concept: number;
  type: number;
  advanced: number;
  memo?: string;
}
function checkScores(x: LevelScoreInput) {
  const ok = (v: number, max: number) => Number.isInteger(v) && v >= 0 && v <= max;
  if (!ok(x.concept, LEVEL_MAX.concept) || !ok(x.type, LEVEL_MAX.type) || !ok(x.advanced, LEVEL_MAX.advanced))
    throw new ApiError(`점수를 확인해 주세요. 개념 0~${LEVEL_MAX.concept}, 유형 0~${LEVEL_MAX.type}, 심화 0~${LEVEL_MAX.advanced}점이에요.`);
}

// 점수 → 판정까지 채운 한 줄 (같은 학생·종류·날짜가 있으면 고쳐 쓴다)
function putTest(db: DB, me: Staff, student: Student, kind: LevelTestKind, testedOn: string, x: LevelScoreInput) {
  checkScores(x);
  const testGrade = (kind === "advance" ? student.grade + 1 : student.grade) as Grade;
  if (testGrade > 12) throw new ApiError("고3은 선행 테스트를 볼 수 없어요.");
  const total = x.concept + x.type + x.advanced;
  const row = {
    student_id: student.id,
    kind,
    tested_on: testedOn,
    test_grade: testGrade,
    concept_score: x.concept,
    type_score: x.type,
    advanced_score: x.advanced,
    total_score: total,
    result_level: judgeLevel(x.concept, x.type, x.advanced),
    advance_ok: kind === "advance" && total >= ADVANCE_PASS,
    staff_id: me.id,
    memo: (x.memo ?? "").trim(),
  };
  const old = db.level_tests.find((t) => t.student_id === student.id && t.kind === kind && t.tested_on === testedOn);
  const label = `${LEVEL_TEST_KIND_LABEL[kind]} 레벨테스트 ${md(testedOn)}`;
  if (old) {
    if (old.total_score === total && old.concept_score === x.concept && old.type_score === x.type && old.memo === row.memo) return;
    addLog(db, me, student.id, "level_test", "update", `${label} 수정: ${old.total_score}점(${old.result_level}) → ${total}점(${row.result_level})`);
    Object.assign(old, row);
  } else {
    db.level_tests.push({ id: nextId(db.level_tests), ...row });
    addLog(db, me, student.id, "level_test", "create", `${label}: ${total}점 · ${row.result_level}${kind === "advance" ? (row.advance_ok ? " · 선행 통과" : " · 선행 미통과") : ""}`);
  }
}

// 학생 상세에서 한 건 입력 (입학·선행 같은 수시 테스트, 정기 테스트 개별 입력)
export async function addLevelTest(studentId: number, input: LevelScoreInput & { kind: LevelTestKind; testedOn: string }) {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const s = db.students.find((x) => x.id === studentId);
  if (!s) throw new ApiError("없는 학생이에요.", 404);
  if (!canEditStudentTests(db, me, studentId)) throw new ApiError("담당 강좌 학생만 입력할 수 있어요.", 403);
  if (!["regular", "entry", "advance"].includes(input.kind)) throw new ApiError("테스트 종류를 골라 주세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.testedOn) || input.testedOn > TODAY) throw new ApiError("시험 날짜는 오늘이나 지난 날짜여야 해요.");
  putTest(db, me, s, input.kind, input.testedOn, input);
  saveDB(db);
}

export async function deleteLevelTest(testId: number) {
  await wait();
  const me = requireManager();
  const db = loadDB();
  const t = db.level_tests.find((x) => x.id === testId);
  if (!t) return;
  db.level_tests = db.level_tests.filter((x) => x.id !== testId);
  addLog(db, me, t.student_id, "level_test", "cancel", `${LEVEL_TEST_KIND_LABEL[t.kind]} 레벨테스트 ${md(t.tested_on)} 기록 삭제 (${t.total_score}점 · ${t.result_level})`);
  saveDB(db);
}

// 정기 테스트 일괄 입력 표: 강좌 수강생 전체를 한 화면에서 (학생 50명이면 한 번에 50건)
export interface LevelSheetRow {
  student: Student;
  test: LevelTestView | null; // 이 날짜에 이미 입력한 결과
  previous: { tested_on: string; total_score: number; result_level: string } | null; // 그 전 결과 (비교용)
}
export async function getLevelTestSheet(classId: number, testedOn: string) {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const cls = db.classes.find((c) => c.id === classId);
  if (!cls || !visible(me, cls)) throw new ApiError("담당 강좌만 볼 수 있어요.", 403);
  const rows: LevelSheetRow[] = db.enrollments
    .filter((e) => e.class_id === classId && e.end_date === null)
    .map((e) => db.students.find((x) => x.id === e.student_id)!)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => {
      const t = db.level_tests.find((x) => x.student_id === s.id && x.kind === "regular" && x.tested_on === testedOn);
      const prev = db.level_tests
        .filter((x) => x.student_id === s.id && x.kind !== "advance" && x.tested_on < testedOn)
        .sort((a, b) => b.tested_on.localeCompare(a.tested_on))[0];
      return { student: s, test: t ? viewTest(t) : null, previous: prev ? { tested_on: prev.tested_on, total_score: prev.total_score, result_level: prev.result_level } : null };
    });
  return { cls: { id: cls.id, name: cls.name, level: cls.level }, testedOn, rows };
}

export async function saveLevelTestSheet(classId: number, testedOn: string, entries: (LevelScoreInput & { studentId: number })[]) {
  await wait();
  const me = requireStaff();
  const db = loadDB();
  const cls = db.classes.find((c) => c.id === classId);
  if (!cls || !visible(me, cls)) throw new ApiError("담당 강좌만 입력할 수 있어요.", 403);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(testedOn) || testedOn > TODAY) throw new ApiError("시험 날짜는 오늘이나 지난 날짜여야 해요.");
  const roster = new Set(db.enrollments.filter((e) => e.class_id === classId && e.end_date === null).map((e) => e.student_id));
  for (const x of entries) {
    if (!roster.has(x.studentId)) throw new ApiError("이 강좌 수강생만 입력할 수 있어요.", 403);
    const s = db.students.find((k) => k.id === x.studentId)!;
    try {
      putTest(db, me, s, "regular", testedOn, x);
    } catch (e) {
      throw new ApiError(`${s.name}: ${(e as Error).message}`);
    }
  }
  saveDB(db);
  return { saved: entries.length };
}


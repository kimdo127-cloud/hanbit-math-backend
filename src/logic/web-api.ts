// 화면은 이 파일만 부른다. 지금은 목업 DB를 쓰고, 백엔드를 붙이면 함수 안을 fetch로 바꾼다.
// 규칙 검사도 여기(= 나중의 백엔드)에 둔다. 화면은 거절 메시지만 보여 준다.
import {
  activeCount,
  attendanceRows,
  attendanceSummary,
  currentMonth,
  monthRange,
  shiftMonth,
  paymentRows,
  type AttendanceRow,
  type AttendanceSummary,
  type PaymentRow,
} from "./calc";
import { checkPw, mockHash, TODAY } from "./seed";
import { hashInviteCode } from "./invite";
import { canAdvance, latestAdvance, latestPlacement, LEVEL_TEST_KIND_LABEL, nextRegularTest, recommendClasses, regularTestDates, upcomingRegularTest } from "./level";
import { getSessionParentId, loadDB, nextId, saveDB, setSessionParentId } from "../db/store";
import type { ActivityLog, ClassRoom, DB, ClassSchedule, Enrollment, FamilyContact, Grade, LevelTest, Parent, Student } from "./types";

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
// 변경 이력 남기기 (고객이 한 일). 백엔드에서는 같은 트랜잭션 안에서 activity_logs에 INSERT
function addLog(db: DB, studentId: number, entity: ActivityLog["entity"], action: ActivityLog["action"], summary: string) {
  const p = requireParent();
  const now = new Date().toTimeString().slice(0, 5);
  db.activity_logs.push({ id: nextId(db.activity_logs), at: `${TODAY}T${now}`, actor_type: "parent", actor_id: p.id, actor_name: p.name, student_id: studentId, entity, action, summary });
}

export class ApiError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const wait = async () => {}; // 목업의 지연 흉내는 서버에서 뺀다

function requireParent(): Parent {
  const id = getSessionParentId();
  const db = loadDB();
  const p = db.parents.find((x) => x.id === id);
  if (!p) throw new ApiError("로그인이 필요해요.", 401);
  return p;
}

// 자기 가족 학생만 접근 가능
function requireOwnStudent(studentId: number): Student {
  const parent = requireParent();
  const s = loadDB().students.find((x) => x.id === studentId);
  if (!s || s.family_id !== parent.family_id) throw new ApiError("볼 수 없는 학생이에요.", 403);
  return s;
}

export const GRADE_LABEL: Record<Grade, string> = { 7: "중1", 8: "중2", 9: "중3", 10: "고1", 11: "고2", 12: "고3" };
export const today = () => TODAY;

/* ---------- 계정 ---------- */

export async function login(email: string, password: string) {
  await wait();
  const p = loadDB().parents.find((x) => x.email === email.trim().toLowerCase());
  if (!p || !checkPw(password, p.password_hash)) throw new ApiError("이메일 또는 비밀번호가 맞지 않아요.", 401);
  setSessionParentId(p.id);
}

// 회원가입 1단계에서 미리 확인 (최종 판단은 가입 때 DB UNIQUE)
export async function checkEmail(email: string) {
  await wait();
  const e = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(e)) throw new ApiError("이메일 형식을 확인해 주세요.");
  if (loadDB().parents.some((p) => p.email === e)) throw new ApiError("이미 가입된 이메일이에요.", 409);
}

// 가입은 학원이 등록한 보호자 번호로만 한다 (한빛수학 한 곳의 앱 = 등록 학부모 전용)
// 학원(어드민)이 상담 후 학생과 보호자 번호를 등록 → 보호자가 그 번호 + 자녀 이름으로 가입 → 가족이 자동 연결
export const ACADEMY_PHONE = "02-000-0000";
const digits = (p: string) => p.replace(/[^0-9]/g, "");

const nowAt = () => `${TODAY}T${new Date().toTimeString().slice(0, 5)}`;

// 초대 확인: 학원이 발급한 초대(invitations)의 코드여야 하고, 3일 안 · 한 번만 · 가장 최근 초대만 쓸 수 있다
// 입력한 번호는 초대 문자를 받은 번호(대표 번호)와 같아야 하고, 자녀 이름은 그 가족의 학생과 같아야 한다
function findInvitation(db: DB, phone: string, childName: string, code?: string) {
  const ph = digits(phone);
  if (ph.length < 9) throw new ApiError("휴대폰 번호를 확인해 주세요.");
  const inv = code?.trim() ? db.invitations.find((x) => x.token_hash === hashInviteCode(code)) : undefined;
  if (!inv) throw new ApiError(`학원에서 받은 초대 문자의 링크로 가입해 주세요. 문의: 한빛수학(${ACADEMY_PHONE})`, 403);
  if (inv.used_at) throw new ApiError("이미 가입에 쓴 초대 링크예요. 가입한 이메일로 로그인해 주세요.", 409);
  if (inv.revoked_at) throw new ApiError("학원에서 새 초대 문자를 보내서 이 링크는 쓸 수 없어요. 가장 최근에 받은 문자의 링크로 가입해 주세요.", 410);
  if (inv.expires_at < nowAt()) throw new ApiError(`초대 링크 기간(3일)이 지났어요. 한빛수학(${ACADEMY_PHONE})에 다시 보내 달라고 요청해 주세요.`, 410);
  if (digits(inv.phone) !== ph) throw new ApiError("초대 문자를 받은 휴대폰 번호를 입력해 주세요.", 403);
  const child = db.students.find((s) => s.family_id === inv.family_id && s.name === childName.trim());
  if (!child) throw new ApiError("자녀 이름이 학원에 등록된 정보와 달라요. 다시 확인해 주세요.", 404);
  if (db.parents.some((p) => p.family_id === inv.family_id)) throw new ApiError("이미 가입된 가족이에요. 가입한 이메일로 로그인해 주세요.", 409);
  return inv;
}

// 회원가입 1단계: 학원에 등록된 보호자인지 확인 → 연결될 자녀를 보여 준다
export async function checkGuardian(phone: string, childName: string, code?: string) {
  await wait();
  const db = loadDB();
  const familyId = findInvitation(db, phone, childName, code).family_id;
  return {
    children: db.students
      .filter((s) => s.family_id === familyId)
      .sort((a, b) => a.birth_date.localeCompare(b.birth_date))
      .map((s) => ({ name: s.name, grade: s.grade, school: s.school })),
  };
}

export async function signup(input: { email: string; password: string; name: string; phone: string; childName: string; code?: string }) {
  await wait();
  const db = loadDB();
  const inv = findInvitation(db, input.phone, input.childName, input.code);
  const familyId = inv.family_id;
  const email = input.email.trim().toLowerCase();
  if (!input.name.trim()) throw new ApiError("이름을 입력해 주세요.");
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError("이메일 형식을 확인해 주세요.");
  if (input.password.length < 8) throw new ApiError("비밀번호는 8자 이상이어야 해요.");
  // 최종에는 DB UNIQUE가 막는다
  if (db.parents.some((p) => p.email === email)) throw new ApiError("이미 가입된 이메일이에요.", 409);
  const parentId = nextId(db.parents);
  db.parents.push({ id: parentId, family_id: familyId, email, password_hash: mockHash(input.password), name: input.name.trim(), created_at: TODAY });
  inv.used_at = nowAt(); // 한 번만 쓴다
  saveDB(db);
  setSessionParentId(parentId);
}

export function logout() {
  setSessionParentId(null);
}

export function isLoggedIn() {
  return getSessionParentId() !== null && loadDB().parents.some((p) => p.id === getSessionParentId());
}

export async function getMe() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const children = db.students
    .filter((s) => s.family_id === parent.family_id)
    .sort((a, b) => a.birth_date.localeCompare(b.birth_date))
    .map((s) => ({ ...s, contacts: familyContacts(db, parent.family_id) })); // 연락처는 가족 공통
  return { parent: { id: parent.id, name: parent.name, email: parent.email }, children };
}

/* ---------- 홈 (D4 학부모 요약) ---------- */

export interface ChildSummary {
  student: Student;
  classes: string[];
  attendance: AttendanceSummary;
  payments: PaymentRow[];
}

export async function getHome(month = currentMonth()): Promise<{ parentName: string; month: string; children: ChildSummary[] }> {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const children = db.students
    .filter((s) => s.family_id === parent.family_id)
    .sort((a, b) => a.birth_date.localeCompare(b.birth_date))
    .map((s) => ({
      student: s,
      classes: db.enrollments
        .filter((e) => e.student_id === s.id && e.end_date === null)
        .map((e) => db.classes.find((c) => c.id === e.class_id)!.name),
      attendance: attendanceSummary(db, s.id, month),
      payments: paymentRows(db, s, month),
    }));
  return { parentName: parent.name, month, children };
}

/* ---------- 수강 ---------- */

export interface ClassInfo extends ClassRoom {
  teacherName: string;
  schedules: ClassSchedule[];
  count: number; // 현재 인원 (계산)
}

function classInfo(c: ClassRoom): ClassInfo {
  const db = loadDB();
  return {
    ...c,
    teacherName: db.staff.find((t) => t.id === c.teacher_id)?.name ?? "",
    schedules: db.class_schedules.filter((s) => s.class_id === c.id),
    count: activeCount(db, c.id),
  };
}

export async function listEnrollments(studentId: number): Promise<(Enrollment & { cls: ClassInfo })[]> {
  await wait();
  requireOwnStudent(studentId);
  const db = loadDB();
  return db.enrollments
    .filter((e) => e.student_id === studentId)
    .sort((a, b) => Number(a.end_date !== null) - Number(b.end_date !== null) || b.start_date.localeCompare(a.start_date))
    .map((e) => ({ ...e, cls: classInfo(db.classes.find((c) => c.id === e.class_id)!) }));
}

// 자녀 학년에 맞는 강좌만 보여 준다 (학년 규칙은 신청 때 다시 검사)
export async function listClassesFor(studentId: number): Promise<(ClassInfo & { enrolled: boolean })[]> {
  await wait();
  const s = requireOwnStudent(studentId);
  const db = loadDB();
  return db.classes
    .filter((c) => c.target_grade === s.grade)
    .map((c) => ({
      ...classInfo(c),
      enrolled: db.enrollments.some((e) => e.student_id === s.id && e.class_id === c.id && e.end_date === null),
    }));
}

export async function enroll(studentId: number, classId: number, startDate: string) {
  await wait();
  const s = requireOwnStudent(studentId);
  const db = loadDB();
  const c = db.classes.find((x) => x.id === classId);
  if (!c) throw new ApiError("없는 강좌예요.", 404);
  if (startDate < TODAY) throw new ApiError("시작일은 오늘 이후로 골라 주세요.");
  // B2 같은 강좌 동시 수강 불가 (최종: DB 부분 UNIQUE)
  if (db.enrollments.some((e) => e.student_id === s.id && e.class_id === c.id && e.end_date === null))
    throw new ApiError(`${s.name} 학생은 이미 ${c.name}에 다니고 있어요.`, 409);
  // B4 학년이 다르면 학부모는 신청할 수 없다. 선행·복습은 상담·레벨 테스트 후 학원(어드민)만 등록한다
  if (s.grade !== c.target_grade)
    throw new ApiError(`선행 수강은 학원 상담과 레벨 테스트 후에 등록해 드려요. 한빛수학(${ACADEMY_PHONE})으로 문의해 주세요.`, 403);
  // B3 정원 (최종: 백엔드 + 트랜잭션)
  if (activeCount(db, c.id) >= c.capacity)
    throw new ApiError(`${c.name} 강좌는 정원 ${c.capacity}명이 다 찼어요. 다른 강좌를 골라 주세요.`, 409);

  db.enrollments.push({ id: nextId(db.enrollments), student_id: s.id, class_id: c.id, start_date: startDate, end_date: null, refund_amount: null, refunded_at: null });
  addLog(db, s.id, "enrollment", "create", `수강 신청: ${c.name} (${startDate} 시작)`);
  saveDB(db);
}

// 수강 중단: 기록은 지우지 않고 수강 중단일만 남긴다 (환불 계산 근거)
export async function withdraw(enrollmentId: number, endDate: string) {
  await wait();
  const db = loadDB();
  const e = db.enrollments.find((x) => x.id === enrollmentId);
  if (!e) throw new ApiError("없는 수강이에요.", 404);
  requireOwnStudent(e.student_id);
  if (e.end_date) throw new ApiError("이미 중단된 수강이에요.");
  if (endDate < e.start_date) throw new ApiError("수강 중단일은 시작일보다 빠를 수 없어요.");
  e.end_date = endDate;
  addLog(db, e.student_id, "enrollment", "end", `수강 중단: ${db.classes.find((c) => c.id === e.class_id)!.name} (${endDate})`);
  saveDB(db);
}

/* ---------- 출결 ---------- */

export async function getAttendance(studentId: number, month: string): Promise<{ rows: AttendanceRow[]; summary: AttendanceSummary }> {
  await wait();
  requireOwnStudent(studentId);
  const db = loadDB();
  return { rows: attendanceRows(db, studentId, month), summary: attendanceSummary(db, studentId, month) };
}

/* ---------- 납부 ---------- */

export async function getPayments(month: string): Promise<PaymentRow[]> {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  return db.students
    .filter((s) => s.family_id === parent.family_id)
    .sort((a, b) => a.birth_date.localeCompare(b.birth_date))
    .flatMap((s) => paymentRows(db, s, month));
}


/* ---------- 내 정보 관리 (비밀번호 · 자녀 정보) ---------- */

export async function changePassword(current: string, next: string) {
  await wait();
  const me = requireParent();
  if (!checkPw(current, me.password_hash)) throw new ApiError("지금 비밀번호가 맞지 않아요.");
  if (next.length < 8) throw new ApiError("새 비밀번호는 8자 이상이어야 해요.");
  if (next === current) throw new ApiError("지금과 다른 비밀번호로 정해 주세요.");
  const db = loadDB();
  db.parents.find((p) => p.id === me.id)!.password_hash = mockHash(next);
  saveDB(db);
}

export async function updateChild(studentId: number, input: { name: string; school: string; grade: Grade; birth_date: string }) {
  await wait();
  requireOwnStudent(studentId);
  if (!input.name.trim() || !input.school.trim() || !input.birth_date) throw new ApiError("이름, 학교, 생년월일을 확인해 주세요.");
  const db = loadDB();
  const s = db.students.find((x) => x.id === studentId)!;
  // 학년은 수강 강좌와 이어져 있어 학원만 바꾼다
  if (input.grade !== s.grade) throw new ApiError(`학년 변경은 학원에서 해 드려요. 한빛수학(${ACADEMY_PHONE})으로 문의해 주세요.`, 403);
  const before = `${s.name} · ${GRADE_LABEL[s.grade]} · ${s.school}`;
  Object.assign(s, { name: input.name.trim(), school: input.school.trim(), birth_date: input.birth_date });
  addLog(db, s.id, "student", "update", `학생 정보 수정: ${before} → ${s.name} · ${GRADE_LABEL[s.grade]} · ${s.school}`);
  saveDB(db);
}

// 자녀는 학원이 등록한다 (같은 보호자 번호로 등록하면 이 가족에 자동으로 붙음)
export async function addChild() {
  await wait();
  requireParent();
  throw new ApiError(`자녀는 학원에서 등록해 드려요. 등록하면 앱에 자동으로 연결돼요. 한빛수학(${ACADEMY_PHONE})`, 403);
}

/* ---------- 보강 신청 · 취소 ---------- */
// 결정 사항: 결석 1건마다 보강 1회. 결석한 달 안에서, 다른 강좌(같은 학년)의 앞으로 있을 수업 중 자리가 남은 수업만 신청할 수 있다.
// (과제 규정 "한 달 결석 2회 이상이면 1회"와 다름 → 재질문 대상)

export interface MakeupSlot {
  sessionId: number;
  date: string;
  className: string;
  time: string;
  left: number; // 남은 자리 = 정원 - (원래 인원 + 보강 인원)
}

export type MakeupState = "available" | "booked" | "done" | "full" | "expired";

export interface AbsenceMakeup {
  attendanceId: number;
  date: string;
  className: string;
  deadline: string; // 신청 가능 마지막 날 (결석한 달의 말일)
  state: MakeupState;
  slots: MakeupSlot[];
  booked: { makeupId: number; date: string; className: string; time: string } | null;
}

function headcount(sessionId: number) {
  const db = loadDB();
  const sess = db.class_sessions.find((s) => s.id === sessionId)!;
  const regular = db.enrollments.filter(
    (e) => e.class_id === sess.class_id && e.start_date <= sess.date && (e.end_date === null || e.end_date > sess.date),
  ).length;
  return regular + db.makeups.filter((m) => m.session_id === sessionId).length;
}

function timeOf(classId: number, date: string) {
  const sc = loadDB().class_schedules.find((y) => y.class_id === classId && y.weekday === new Date(date + "T00:00").getDay());
  return sc ? `${sc.start_time}~${sc.end_time}` : "";
}

function absenceMakeups(studentId: number): AbsenceMakeup[] {
  const db = loadDB();
  const s = db.students.find((x) => x.id === studentId)!;
  return db.attendances
    .filter((a) => a.student_id === studentId && a.status === "absent")
    .map((a) => {
      const sess = db.class_sessions.find((x) => x.id === a.session_id)!;
      const deadline = monthRange(sess.date.slice(0, 7)).end;
      const mk = db.makeups.find((m) => m.absence_id === a.id);
      let booked = null;
      if (mk) {
        const ms = db.class_sessions.find((x) => x.id === mk.session_id)!;
        booked = { makeupId: mk.id, date: ms.date, className: db.classes.find((c) => c.id === ms.class_id)!.name, time: timeOf(ms.class_id, ms.date) };
      }
      const slots: MakeupSlot[] = mk
        ? []
        : db.class_sessions
            .filter((x) => x.class_id !== sess.class_id && x.date > sess.date && x.date > TODAY && x.date <= deadline)
            .map((x) => ({ x, c: db.classes.find((c) => c.id === x.class_id)! }))
            .filter(({ c }) => c.target_grade === s.grade)
            .map(({ x, c }) => ({ sessionId: x.id, date: x.date, className: c.name, time: timeOf(c.id, x.date), left: c.capacity - headcount(x.id) }))
            .filter((x) => x.left > 0)
            .sort((p, q) => p.date.localeCompare(q.date));
      const state: MakeupState = booked
        ? booked.date > TODAY ? "booked" : "done"
        : deadline < TODAY ? "expired" : slots.length ? "available" : "full";
      return { attendanceId: a.id, date: sess.date, className: db.classes.find((c) => c.id === sess.class_id)!.name, deadline, state, slots, booked };
    })
    .sort((p, q) => q.date.localeCompare(p.date));
}

export async function getMakeups(studentId: number) {
  await wait();
  requireOwnStudent(studentId);
  return absenceMakeups(studentId);
}

export async function requestMakeup(attendanceId: number, sessionId: number) {
  await wait();
  const db = loadDB();
  const abs = db.attendances.find((a) => a.id === attendanceId);
  if (!abs || abs.status !== "absent") throw new ApiError("결석한 수업만 보강을 신청할 수 있어요.");
  const s = requireOwnStudent(abs.student_id);
  // 결석 1건에 보강 1건 (최종: DB UNIQUE)
  if (db.makeups.some((m) => m.absence_id === attendanceId)) throw new ApiError("이 결석은 이미 보강을 신청했어요.", 409);
  const absSess = db.class_sessions.find((x) => x.id === abs.session_id)!;
  const target = db.class_sessions.find((x) => x.id === sessionId);
  if (!target) throw new ApiError("없는 수업이에요.", 404);
  const cls = db.classes.find((c) => c.id === target.class_id)!;
  if (target.class_id === absSess.class_id) throw new ApiError("보강은 다른 강좌 수업에만 들어갈 수 있어요.");
  if (target.date.slice(0, 7) !== absSess.date.slice(0, 7) || target.date <= TODAY) throw new ApiError("결석한 달 안의 앞으로 있을 수업만 고를 수 있어요.");
  if (cls.target_grade !== s.grade) throw new ApiError("같은 학년 강좌 수업만 고를 수 있어요.");
  if (headcount(sessionId) >= cls.capacity) throw new ApiError(`${cls.name} 그날 수업은 자리가 다 찼어요. 다른 날을 골라 주세요.`, 409);
  db.makeups.push({ id: nextId(db.makeups), absence_id: attendanceId, session_id: sessionId, requested_at: `${TODAY}T${new Date().toTimeString().slice(0, 5)}` });
  addLog(db, s.id, "makeup", "create", `보강 신청: ${md(absSess.date)} 결석분 → ${md(target.date)} ${cls.name}`);
  saveDB(db);
}

export async function cancelMakeup(makeupId: number) {
  await wait();
  const db = loadDB();
  const m = db.makeups.find((x) => x.id === makeupId);
  if (!m) throw new ApiError("없는 보강이에요.", 404);
  const abs = db.attendances.find((a) => a.id === m.absence_id)!;
  requireOwnStudent(abs.student_id);
  const sess = db.class_sessions.find((x) => x.id === m.session_id)!;
  if (sess.date <= TODAY) throw new ApiError("이미 지난 보강은 취소할 수 없어요.");
  db.makeups = db.makeups.filter((x) => x.id !== makeupId);
  addLog(db, abs.student_id, "makeup", "cancel", `보강 취소: ${md(sess.date)} ${db.classes.find((c) => c.id === sess.class_id)!.name}`);
  saveDB(db);
}

/* ---------- 홈 (선택한 자녀 요약) ---------- */

export async function getChildHome(studentId: number, month = currentMonth()) {
  await wait();
  const s = requireOwnStudent(studentId);
  const db = loadDB();
  const classes = db.enrollments
    .filter((e) => e.student_id === s.id && e.end_date === null)
    .map((e) => classInfo(db.classes.find((c) => c.id === e.class_id)!));
  const mk = absenceMakeups(s.id);
  // 오늘 수업(없으면 다음 수업): 등원 여부·시각
  const classIds = classes.map((c) => c.id);
  const upcoming = db.class_sessions.filter((x) => classIds.includes(x.class_id) && x.date >= TODAY).sort((x, y) => x.date.localeCompare(y.date));
  const nextDate = upcoming[0]?.date ?? null;
  const today = upcoming
    .filter((x) => x.date === nextDate)
    .map((x) => {
      const c = classes.find((k) => k.id === x.class_id)!;
      const wd = new Date(x.date + "T00:00:00").getDay();
      const sch = c.schedules.find((k) => k.weekday === wd);
      const att = db.attendances.find((a) => a.session_id === x.id && a.student_id === s.id) ?? null;
      return { date: x.date, className: c.name, start: sch?.start_time ?? "", end: sch?.end_time ?? "", topic: x.topic, status: att?.status ?? null, checkedAt: att?.checked_at ?? null };
    });
  return {
    student: s,
    classes,
    today,
    isToday: nextDate === TODAY,
    attendance: attendanceSummary(db, s.id, month),
    payments: paymentRows(db, s, month),
    makeupOpen: mk.filter((x) => x.state === "available").length,
    makeupBooked: mk.filter((x) => x.state === "booked"),
  };
}

export async function getFamilyUnpaid() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const months = [...new Set(db.payments.map((p) => p.month))].filter((m) => m <= currentMonth());
  const rows = db.students
    .filter((s) => s.family_id === parent.family_id)
    .flatMap((s) => months.flatMap((m) => paymentRows(db, s, m)))
    .filter((r) => r.status === "unpaid");
  return { total: rows.reduce((t, r) => t + r.amount, 0), count: rows.length, items: rows.map((r) => `${r.studentName} ${Number(r.month.slice(5))}월`) };
}

/* ---------- 납부 내역 (월별 묶음) ---------- */

export async function getPaymentHistory() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const kids = db.students.filter((s) => s.family_id === parent.family_id).sort((a, b) => a.birth_date.localeCompare(b.birth_date));
  const months = new Set<string>();
  kids.forEach((k) => db.enrollments.filter((e) => e.student_id === k.id).forEach((e) => {
    for (let m = e.start_date.slice(0, 7); m <= currentMonth() && (!e.end_date || m <= e.end_date.slice(0, 7)); m = shiftMonth(m, 1)) months.add(m);
  }));
  return [...months]
    .sort((a, b) => b.localeCompare(a))
    .map((m) => ({ month: m, rows: kids.flatMap((k) => paymentRows(db, k, m)) }))
    .filter((g) => g.rows.length > 0);
}

/* ---------- 보호자 연락처 (가족 단위로 한 번만 저장) ---------- */

const familyContacts = (db: DB, familyId: number): FamilyContact[] =>
  db.family_contacts.filter((c) => c.family_id === familyId).sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.id - b.id);

export async function getFamilyContacts() {
  await wait();
  const parent = requireParent();
  return familyContacts(loadDB(), parent.family_id);
}

export async function addFamilyContact(relation: string, phone: string) {
  await wait();
  const parent = requireParent();
  if (!relation.trim() || !/^[0-9-]{9,13}$/.test(phone.trim())) throw new ApiError("관계와 연락처를 확인해 주세요.");
  const db = loadDB();
  if (db.family_contacts.some((c) => c.family_id === parent.family_id && digits(c.phone) === digits(phone)))
    throw new ApiError("이미 등록된 번호예요.", 409); // 최종: DB UNIQUE(family_id, phone)
  db.family_contacts.push({ id: nextId(db.family_contacts), family_id: parent.family_id, relation: relation.trim(), phone: phone.trim(), is_primary: false });
  saveDB(db);
}

// 대표 번호는 학원이 바꾼다 (초대·안내 문자의 기준). 보호자는 대표가 아닌 번호만 지운다
export async function removeFamilyContact(contactId: number) {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const c = db.family_contacts.find((x) => x.id === contactId && x.family_id === parent.family_id);
  if (!c) return;
  if (c.is_primary) throw new ApiError(`대표 번호는 지울 수 없어요. 바꾸려면 한빛수학(${ACADEMY_PHONE})에 요청해 주세요.`);
  db.family_contacts = db.family_contacts.filter((x) => x.id !== contactId);
  saveDB(db);
}

/* ---------- 수강 중단 전 안내 (남은 수업 · 보강 기회 · 예상 환불) ---------- */
// 학원법 시행령 별표4: 시작 전 전액, 1/3 경과 전 2/3, 1/2 경과 전 1/2, 그 뒤 없음 (그 달 총 수업 기준)

export async function getWithdrawInfo(enrollmentId: number, endDate: string) {
  await wait();
  const db = loadDB();
  const e = db.enrollments.find((x) => x.id === enrollmentId);
  if (!e) throw new ApiError("없는 수강이에요.", 404);
  const s = requireOwnStudent(e.student_id);
  const month = endDate.slice(0, 7);
  const { start, end } = monthRange(month);
  const sessions = db.class_sessions.filter((x) => x.class_id === e.class_id && x.date >= start && x.date <= end && x.date >= e.start_date);
  const done = sessions.filter((x) => x.date < endDate).length; // 중단일부터는 수업을 듣지 않는다
  const total = sessions.length;
  const ratio = total === 0 || done === 0 ? 1 : done < total / 3 ? 2 / 3 : done < total / 2 ? 1 / 2 : 0;
  const pay = db.payments.find((p) => p.student_id === s.id && p.class_id === e.class_id && p.month === month && p.paid_at);
  const paid = pay?.paid_amount ?? 0;
  const makeupLeft = absenceMakeups(s.id).filter((x) => x.state === "available").length;
  return {
    remaining: total - done,
    total,
    makeupLeft,
    paid,
    refund: Math.floor((paid * ratio) / 10) * 10,
    rule: done === 0 ? "수업 시작 전이라 전액 환불" : ratio === 2 / 3 ? "1/3 지나기 전이라 2/3 환불" : ratio === 1 / 2 ? "1/2 지나기 전이라 1/2 환불" : "1/2이 지나 환불 없음",
  };
}

/* ---------- 이번 주 수업 (월~일, 가족 전체: 정규 수업 + 신청한 보강) ---------- */

export interface WeekItem {
  date: string;
  studentId: number;
  className: string;
  time: string;
  makeup: boolean;
}

export async function getFamilyWeek() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const t = new Date(TODAY + "T00:00");
  const mon = new Date(t);
  mon.setDate(t.getDate() - ((t.getDay() + 6) % 7));
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const kids = db.students.filter((s) => s.family_id === parent.family_id);
  const items: WeekItem[] = [];
  kids.forEach((k) => {
    const classIds = db.enrollments.filter((e) => e.student_id === k.id && e.end_date === null).map((e) => e.class_id);
    db.class_sessions
      .filter((x) => classIds.includes(x.class_id) && days.includes(x.date))
      .forEach((x) => items.push({ date: x.date, studentId: k.id, className: db.classes.find((c) => c.id === x.class_id)!.name, time: timeOf(x.class_id, x.date), makeup: false }));
    db.makeups.forEach((m) => {
      const ab = db.attendances.find((a) => a.id === m.absence_id);
      const ms = db.class_sessions.find((x) => x.id === m.session_id)!;
      if (ab?.student_id === k.id && days.includes(ms.date))
        items.push({ date: ms.date, studentId: k.id, className: db.classes.find((c) => c.id === ms.class_id)!.name, time: timeOf(ms.class_id, ms.date), makeup: true });
    });
  });
  items.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return { days, items };
}

/* ---------- 학원 수강 목록 (전체 강좌) ---------- */

// 우리 아이가 다니는 강좌면 이름을 붙여 준다
export async function listAllClasses() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const kids = db.students.filter((s) => s.family_id === parent.family_id);
  return db.classes.map((c) => ({
    ...classInfo(c),
    myKids: kids.filter((k) => db.enrollments.some((e) => e.student_id === k.id && e.class_id === c.id && e.end_date === null)).map((k) => k.name),
    // 최근 레벨테스트 판정이 이 강좌 레벨과 같은 같은 학년 아이 ("우리 아이 레벨")
    levelKids: kids.filter((k) => k.grade === c.target_grade && latestPlacement(db, k.id)?.result_level === c.level).map((k) => k.name),
  }));
}

// 강좌 상세: 기본 정보 + 앞으로의 진도 계획 + 아이별 신청 가능 여부
export async function getClassDetail(classId: number) {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const c = db.classes.find((x) => x.id === classId);
  if (!c) throw new ApiError("없는 강좌예요.", 404);
  const plan = db.class_sessions
    .filter((s) => s.class_id === c.id && s.date > TODAY)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8)
    .map((s) => ({ date: s.date, topic: s.topic }));
  const kids = db.students
    .filter((s) => s.family_id === parent.family_id)
    .sort((a, b) => a.birth_date.localeCompare(b.birth_date) || a.id - b.id)
    .map((k) => ({
      id: k.id,
      name: k.name,
      grade: k.grade,
      enrolled: db.enrollments.some((e) => e.student_id === k.id && e.class_id === c.id && e.end_date === null),
      gradeDiff: k.grade !== c.target_grade, // 선행·복습: 앱에서는 신청 불가, 상담 안내
    }));
  const done = db.class_sessions.filter((s) => s.class_id === c.id && s.date <= TODAY).length;
  return { cls: classInfo(c), plan, kids, done, firstDate: firstSessionDate(c.id) };
}

// 첫 수업일: 오늘 이후 그 강좌의 가장 가까운 수업일 (학원 시간표 기준, 사용자가 고르지 않음)
export function firstSessionDate(classId: number) {
  return loadDB().class_sessions.filter((s) => s.class_id === classId && s.date > TODAY).sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? null;
}

// 여러 자녀 한 번에 신청 (쌍둥이 등). 정원은 신청 인원만큼 남아 있어야 한다. 시작일은 시스템이 정한다
export async function enrollMany(studentIds: number[], classId: number) {
  await wait();
  const db = loadDB();
  const c = db.classes.find((x) => x.id === classId);
  if (!c) throw new ApiError("없는 강좌예요.", 404);
  const startDate = firstSessionDate(classId);
  if (!startDate) throw new ApiError("예정된 수업이 없어 지금은 신청할 수 없어요.");
  const left = c.capacity - activeCount(db, c.id);
  if (studentIds.length > left) throw new ApiError(`${c.name} 강좌는 ${left}자리만 남아 있어요. 신청할 자녀 수를 줄여 주세요.`, 409);
  for (const id of studentIds) await enroll(id, classId, startDate);
}

// 앞으로의 수업 (캘린더 예정 표시): 오늘 이후, 다니는 강좌의 수업일
export async function getPlanned(studentId: number, month: string) {
  await wait();
  requireOwnStudent(studentId);
  const db = loadDB();
  const classIds = db.enrollments.filter((e) => e.student_id === studentId && e.end_date === null).map((e) => e.class_id);
  return db.class_sessions
    .filter((x) => classIds.includes(x.class_id) && x.date > TODAY && x.date.startsWith(month))
    .map((x) => ({ date: x.date, className: db.classes.find((c) => c.id === x.class_id)!.name, time: timeOf(x.class_id, x.date), topic: x.topic }));
}


/* ---------- 레벨테스트 (MY › 자녀 · 홈 안내 · 캘린더) ---------- */

export interface LevelTestView extends LevelTest {
  kindLabel: string;
}
const viewTest = (t: LevelTest): LevelTestView => ({ ...t, kindLabel: LEVEL_TEST_KIND_LABEL[t.kind] });

// 자녀의 레벨테스트 기록 + 반 편성에 쓰는 최근 결과 + 선행 상담 가능 여부
export async function getLevelTests(studentId: number) {
  await wait();
  const s = requireOwnStudent(studentId);
  const db = loadDB();
  const latest = latestPlacement(db, s.id);
  // 맞는 반: 챗봇과 같은 추천 규칙 (같은 학년 · 최근 판정과 같은 레벨 · 지금 다니지 않는 반)
  const rec = recommendClasses(db, s, TODAY);
  return {
    tests: db.level_tests.filter((t) => t.student_id === s.id).sort((a, b) => b.tested_on.localeCompare(a.tested_on) || b.id - a.id).map(viewTest),
    latest: latest ? viewTest(latest) : null,
    canAdvance: canAdvance(db, s.id),
    nextRegular: nextRegularTest(TODAY),
    recommend: rec.items.map((r) => ({ classId: r.cls.id, name: r.cls.name, seatsLeft: r.seatsLeft, overlap: r.overlap })),
  };
}

// 홈 안내 카드: 정기 레벨테스트 14일 전부터 (2월·8월)
export async function getLevelTestNotice() {
  await wait();
  requireParent();
  return upcomingRegularTest(TODAY);
}

// 캘린더: 그 달의 정기 레벨테스트 날짜
export async function getLevelTestDates(month: string) {
  await wait();
  requireParent();
  return regularTestDates(Number(month.slice(0, 4))).filter((d) => d.startsWith(month));
}

/* ---------- 챗봇에 넘기는 가족 메모 (family_info) ---------- */
// 백엔드가 질문마다 새로 만든다. Dify는 이 메모와 규정 문서만 보고 답한다 (DB에 직접 접근하지 않음)
// 담는 것: 로그인한 가족의 자녀별 반·다음 수업·이번 달 출결·보강·수강료·최근 레벨테스트·추천 반
// 담지 않는 것: 다른 가족, 연락처, 이메일, 비밀번호
const WD = ["일", "월", "화", "수", "목", "금", "토"];
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function familyInfoText(): string {
  const parent = requireParent();
  const db = loadDB();
  const month = currentMonth();
  const kids = db.students.filter((s) => s.family_id === parent.family_id).sort((a, b) => a.birth_date.localeCompare(b.birth_date) || a.id - b.id);
  const lines = [`기준일 ${TODAY} · 보호자 ${parent.name}`];
  for (const k of kids) {
    lines.push("", `[${k.name} · ${GRADE_LABEL[k.grade]}]`);
    const active = db.enrollments.filter((e) => e.student_id === k.id && e.end_date === null).map((e) => db.classes.find((c) => c.id === e.class_id)!);
    lines.push(
      `- 듣는 반: ${
        active.length
          ? active
              .map((c) => {
                const sch = db.class_schedules.filter((x) => x.class_id === c.id).sort((a, b) => a.weekday - b.weekday);
                return `${c.name}(${c.level}) ${sch.map((x) => WD[x.weekday]).join("·")} ${sch[0]?.start_time ?? ""}~${sch[0]?.end_time ?? ""}`;
              })
              .join(", ")
          : "없음"
      }`,
    );
    const ids = active.map((c) => c.id);
    const next = db.class_sessions.filter((x) => ids.includes(x.class_id) && x.date >= TODAY).sort((a, b) => a.date.localeCompare(b.date))[0];
    if (next) lines.push(`- 다음 수업: ${next.date === TODAY ? "오늘 " : ""}${md(next.date)}(${WD[new Date(next.date + "T00:00").getDay()]}) ${timeOf(next.class_id, next.date).split("~")[0]} ${db.classes.find((c) => c.id === next.class_id)!.name}`);
    const a = attendanceSummary(db, k.id, month);
    lines.push(`- 이번 달(${Number(month.slice(5))}월) 출결: 출석 ${a.present} · 지각 ${a.late} · 결석 ${a.absent}`);
    const mk = absenceMakeups(k.id).filter((x) => x.state !== "expired");
    const open = mk.filter((x) => x.state === "available" || x.state === "full");
    const booked = mk.filter((x) => x.state === "booked");
    lines.push(
      `- 보강: ${open.length ? `신청 가능 ${open.length}회 (${open.map((x) => `${md(x.date)} 결석분, ${md(x.deadline)}까지${x.state === "full" ? ", 지금 빈자리 없음" : ""}`).join(" / ")})` : "신청할 보강 없음"}${
        booked.length ? ` · 예약됨 ${booked.map((x) => `${md(x.booked!.date)} ${x.booked!.className}`).join(", ")}` : ""
      }`,
    );
    const pays = paymentRows(db, k, month);
    lines.push(`- 이번 달 수강료: ${pays.length ? pays.map((p) => `${p.className} ${won(p.amount)} ${p.status === "paid" ? "납부 완료" : "미납"}`).join(", ") : "청구 없음"}`);
    const t = latestPlacement(db, k.id);
    lines.push(
      t
        ? `- 최근 레벨테스트: ${md(t.tested_on)} ${LEVEL_TEST_KIND_LABEL[t.kind]} · ${t.total_score}점(개념 ${t.concept_score}/40 · 유형 ${t.type_score}/40 · 심화 ${t.advanced_score}/20) · 판정 ${t.result_level}`
        : "- 최근 레벨테스트: 기록 없음 (반 추천은 레벨테스트 후 가능)",
    );
    if (t) {
      const prev = db.level_tests.filter((x) => x.student_id === k.id && x.kind !== "advance" && x.tested_on < t.tested_on).sort((a, b) => b.tested_on.localeCompare(a.tested_on))[0];
      if (prev) lines.push(`- 지난 테스트 대비: ${md(prev.tested_on)} ${prev.total_score}점(${prev.result_level}) → ${t.total_score}점(${t.result_level}), ${t.total_score - prev.total_score >= 0 ? "+" : ""}${t.total_score - prev.total_score}점`);
      const areas = [["수와 연산", t.area_number], ["변화와 관계", t.area_change], ["도형과 측정", t.area_shape], ["자료와 가능성", t.area_data]].filter((a): a is [string, number] => a[1] !== null);
      if (areas.length) {
        const weak = [...areas].sort((a, b) => a[1] - b[1])[0];
        lines.push(`- 분야별 정답률: ${areas.map(([l, v]) => `${l} ${v}%`).join(", ")} · 가장 약한 분야: ${weak[0]}`);
      }
      if (t.memo) lines.push(`- 선생님 코멘트: ${t.memo}`);
    }
    lines.push(`- 다음 정기 레벨테스트: ${md(nextRegularTest(TODAY))}(토)`);
    const adv = latestAdvance(db, k.id);
    if (adv) lines.push(`- 선행 테스트: ${md(adv.tested_on)} ${adv.total_score}점 · ${adv.advance_ok ? "통과" : "미통과"}`);
    if (t) {
      const rec = recommendClasses(db, k, TODAY);
      const ok = rec.items.filter((r) => r.seatsLeft > 0 && !r.overlap);
      const other = rec.items.filter((r) => !(r.seatsLeft > 0 && !r.overlap));
      lines.push(
        `- 추천 반(같은 학년 · ${rec.level}): ${ok.length ? ok.map((r) => `${r.cls.name} 자리 ${r.seatsLeft}`).join(", ") : "지금 신청 가능한 반 없음"}${
          other.length ? ` / 참고: ${other.map((r) => `${r.cls.name}(${r.seatsLeft === 0 ? "마감" : "지금 시간표와 겹침"})`).join(", ")}` : ""
        }`,
      );
      if (canAdvance(db, k.id)) lines.push("- 선행반: 상담 대상 (선행은 앱 신청 불가, 상담 후 학원이 신청)");
    }
  }
  return lines.join("\n");
}


/* ---------- 알림함 · 앱 푸시 ---------- */
// 알림은 가족 단위로 쌓인다 (등원·지각·하원·결석, 레벨테스트 결과, 보강 확정, 미납). 지우지 않고 읽음만 표시

export async function listNotifications() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  return db.notifications.filter((n) => n.family_id === parent.family_id).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id).slice(0, 100);
}

export async function getUnreadCount() {
  await wait();
  const parent = requireParent();
  return loadDB().notifications.filter((n) => n.family_id === parent.family_id && !n.read_at).length;
}

// 알림함을 열면 모두 읽음
export async function markNotificationsRead() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const at = `${TODAY}T${new Date().toTimeString().slice(0, 5)}`;
  db.notifications.filter((n) => n.family_id === parent.family_id && !n.read_at).forEach((n) => (n.read_at = at));
  saveDB(db);
}

// 웹 푸시 공개키 (브라우저가 구독할 때 쓴다). 서버에 키가 없으면 null → 화면은 알림함만 보여 준다
export function getPushKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

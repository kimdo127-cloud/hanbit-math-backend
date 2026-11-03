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
import { getSessionParentId, loadDB, nextId, saveDB, setSessionParentId } from "../db/store";
import type { ActivityLog, ClassRoom, DB, ClassSchedule, Enrollment, Grade, Parent, Student, StudentContact } from "./types";

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

export interface SignupChild {
  name: string;
  grade: Grade;
  school: string;
  birth_date: string;
}

export async function signup(input: {
  email: string;
  password: string;
  name: string;
  phone: string;
  relation: string;
  children: SignupChild[];
}) {
  await wait();
  const db = loadDB();
  const email = input.email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError("이메일 형식을 확인해 주세요.");
  if (input.password.length < 8) throw new ApiError("비밀번호는 8자 이상이어야 해요.");
  // 최종에는 DB UNIQUE가 막는다
  if (db.parents.some((p) => p.email === email)) throw new ApiError("이미 가입된 이메일이에요.", 409);
  if (input.children.length === 0) throw new ApiError("자녀를 한 명 이상 등록해 주세요.");

  const familyId = nextId(db.families);
  db.families.push({ id: familyId, name: `${input.name} 가족` });
  const parentId = nextId(db.parents);
  db.parents.push({
    id: parentId,
    family_id: familyId,
    email,
    password_hash: mockHash(input.password),
    name: input.name,
    created_at: TODAY,
  });
  input.children.forEach((c) => {
    const sid = nextId(db.students);
    db.students.push({ id: sid, family_id: familyId, ...c });
    db.student_contacts.push({ id: nextId(db.student_contacts), student_id: sid, relation: input.relation, phone: input.phone });
  });
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
    .map((s) => ({ ...s, contacts: db.student_contacts.filter((c) => c.student_id === s.id) }));
  return { parent: { id: parent.id, name: parent.name, email: parent.email }, children };
}

export async function addContact(studentId: number, relation: string, phone: string): Promise<StudentContact> {
  await wait();
  requireOwnStudent(studentId);
  if (!relation.trim() || !/^[0-9-]{9,13}$/.test(phone.trim())) throw new ApiError("관계와 연락처를 확인해 주세요.");
  const db = loadDB();
  const c = { id: nextId(db.student_contacts), student_id: studentId, relation: relation.trim(), phone: phone.trim() };
  db.student_contacts.push(c);
  saveDB(db);
  return c;
}

export async function removeContact(contactId: number) {
  await wait();
  const db = loadDB();
  const c = db.student_contacts.find((x) => x.id === contactId);
  if (!c) return;
  requireOwnStudent(c.student_id);
  if (db.student_contacts.filter((x) => x.student_id === c.student_id).length <= 1)
    throw new ApiError("연락처는 최소 하나는 있어야 해요.");
  db.student_contacts = db.student_contacts.filter((x) => x.id !== contactId);
  saveDB(db);
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
  // B4 학년이 달라도 신청 가능 (선행·복습 수강). 화면에서 안내만 한다
  // B3 정원 (최종: 백엔드 + 트랜잭션)
  if (activeCount(db, c.id) >= c.capacity)
    throw new ApiError(`${c.name} 강좌는 정원 ${c.capacity}명이 다 찼어요. 다른 강좌를 골라 주세요.`, 409);

  db.enrollments.push({ id: nextId(db.enrollments), student_id: s.id, class_id: c.id, start_date: startDate, end_date: null, refund_amount: null, refunded_at: null });
  addLog(db, s.id, "enrollment", "create", `수강 신청: ${c.name} (${startDate} 시작)${s.grade !== c.target_grade ? " · 학년 다른 강좌" : ""}`);
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
  const before = `${s.name} · ${GRADE_LABEL[s.grade]} · ${s.school}`;
  Object.assign(s, { name: input.name.trim(), school: input.school.trim(), grade: input.grade, birth_date: input.birth_date });
  addLog(db, s.id, "student", "update", `학생 정보 수정: ${before} → ${s.name} · ${GRADE_LABEL[s.grade]} · ${s.school}`);
  saveDB(db);
}

export async function addChild(input: { name: string; school: string; grade: Grade; birth_date: string; relation: string; phone: string }) {
  await wait();
  const parent = requireParent();
  if (!input.name.trim() || !input.school.trim() || !input.birth_date) throw new ApiError("이름, 학교, 생년월일을 확인해 주세요.");
  if (!input.relation.trim() || !/^[0-9-]{9,13}$/.test(input.phone.trim())) throw new ApiError("보호자 관계와 연락처를 확인해 주세요.");
  const db = loadDB();
  const sid = nextId(db.students);
  db.students.push({ id: sid, family_id: parent.family_id, name: input.name.trim(), school: input.school.trim(), grade: input.grade, birth_date: input.birth_date });
  db.student_contacts.push({ id: nextId(db.student_contacts), student_id: sid, relation: input.relation.trim(), phone: input.phone.trim() });
  saveDB(db);
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
    (e) => e.class_id === sess.class_id && e.start_date <= sess.date && (e.end_date === null || e.end_date >= sess.date),
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

/* ---------- 보호자 연락처 (화면에서는 가족 단위로 묶어서) ---------- */

export async function getFamilyContacts() {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const kids = db.students.filter((s) => s.family_id === parent.family_id);
  const map = new Map<string, { relation: string; phone: string; children: { id: number; name: string }[] }>();
  db.student_contacts
    .filter((c) => kids.some((k) => k.id === c.student_id))
    .forEach((c) => {
      const key = c.relation + "|" + c.phone;
      if (!map.has(key)) map.set(key, { relation: c.relation, phone: c.phone, children: [] });
      map.get(key)!.children.push({ id: c.student_id, name: kids.find((k) => k.id === c.student_id)!.name });
    });
  return [...map.values()];
}

export async function addFamilyContact(relation: string, phone: string, studentIds: number[]) {
  await wait();
  if (!relation.trim() || !/^[0-9-]{9,13}$/.test(phone.trim())) throw new ApiError("관계와 연락처를 확인해 주세요.");
  if (studentIds.length === 0) throw new ApiError("연락받을 자녀를 하나 이상 골라 주세요.");
  studentIds.forEach((id) => requireOwnStudent(id));
  const db = loadDB();
  studentIds.forEach((id) => {
    if (!db.student_contacts.some((c) => c.student_id === id && c.phone === phone.trim() && c.relation === relation.trim()))
      db.student_contacts.push({ id: nextId(db.student_contacts), student_id: id, relation: relation.trim(), phone: phone.trim() });
  });
  saveDB(db);
}

export async function removeFamilyContact(relation: string, phone: string) {
  await wait();
  const parent = requireParent();
  const db = loadDB();
  const kids = db.students.filter((s) => s.family_id === parent.family_id);
  for (const k of kids) {
    const mine = db.student_contacts.filter((c) => c.student_id === k.id);
    if (mine.some((c) => c.phone === phone && c.relation === relation) && mine.length <= 1)
      throw new ApiError(`${k.name}의 연락처가 하나뿐이라 지울 수 없어요. 다른 연락처를 먼저 추가해 주세요.`);
  }
  db.student_contacts = db.student_contacts.filter((c) => !(kids.some((k) => k.id === c.student_id) && c.phone === phone && c.relation === relation));
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
  const done = sessions.filter((x) => x.date <= endDate).length;
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
      gradeDiff: k.grade !== c.target_grade, // 선행·복습: 신청은 되고 안내만
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

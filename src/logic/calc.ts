// 저장하지 않고 계산하는 값. 백엔드에서도 같은 로직(또는 SQL 뷰)으로 옮긴다.
import { TODAY } from "./seed";
import type { AttendanceStatus, ClassRoom, DB, Student } from "./types";

export const SIBLING_DISCOUNT = 0.1;
export const LATE_PER_ABSENCE = 3;

export function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

export function currentMonth() {
  return TODAY.slice(0, 7);
}

export function shiftMonth(month: string, diff: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + diff, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// 그 달에 한 번이라도 다닌 수강
export function enrollmentsInMonth(db: DB, studentId: number, month: string) {
  const { start, end } = monthRange(month);
  return db.enrollments.filter(
    (e) => e.student_id === studentId && e.start_date <= end && (e.end_date === null || e.end_date >= start),
  );
}

// 강좌 현재 인원: 수강 중단하지 않은 수강 수 (저장하지 않음)
export function activeCount(db: DB, classId: number, date = TODAY) {
  return db.enrollments.filter(
    (e) => e.class_id === classId && e.start_date <= date && (e.end_date === null || e.end_date > date),
  ).length;
}

// 형제 할인: 그 달에 다니는 형제 중 나이순 둘째부터
export function hasSiblingDiscount(db: DB, student: Student, month: string) {
  const siblings = db.students
    .filter((s) => s.family_id === student.family_id && enrollmentsInMonth(db, s.id, month).length > 0)
    .sort((a, b) => a.birth_date.localeCompare(b.birth_date));
  return siblings.findIndex((s) => s.id === student.id) > 0;
}

export function feeFor(db: DB, student: Student, cls: ClassRoom, month: string) {
  const discount = hasSiblingDiscount(db, student, month);
  const amount = discount ? Math.round(cls.monthly_fee * (1 - SIBLING_DISCOUNT)) : cls.monthly_fee;
  return { amount, discount };
}

export interface AttendanceRow {
  attendanceId: number;
  date: string;
  className: string;
  status: AttendanceStatus;
  checkedAt: string | null; // 등원 시각
  topic: string | null; // 수업 내용
  startTime: string; // 수업 시작 시각
  lateMin: number; // 지각이면 몇 분 늦었는지
  makeup: { date: string; className: string } | null;
}

export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export function sessionStart(db: DB, s: { class_id: number; date: string }) {
  const wd = new Date(s.date + "T00:00:00").getDay();
  return db.class_schedules.find((c) => c.class_id === s.class_id && c.weekday === wd)?.start_time ?? "";
}

export function attendanceRows(db: DB, studentId: number, month: string): AttendanceRow[] {
  const { start, end } = monthRange(month);
  return db.attendances
    .filter((a) => a.student_id === studentId)
    .map((a) => {
      const s = db.class_sessions.find((x) => x.id === a.session_id)!;
      return { a, s };
    })
    .filter(({ s }) => s.date >= start && s.date <= end)
    .sort((x, y) => y.s.date.localeCompare(x.s.date))
    .map(({ a, s }) => {
      const mk = db.makeups.find((m) => m.absence_id === a.id);
      let makeup = null;
      if (mk) {
        const ms = db.class_sessions.find((x) => x.id === mk.session_id)!;
        makeup = { date: ms.date, className: db.classes.find((c) => c.id === ms.class_id)!.name };
      }
      return {
        attendanceId: a.id,
        date: s.date,
        className: db.classes.find((c) => c.id === s.class_id)!.name,
        status: a.status,
        checkedAt: a.checked_at,
        topic: s.topic,
        startTime: sessionStart(db, s),
        lateMin: a.status === "late" && a.checked_at ? toMin(a.checked_at) - toMin(sessionStart(db, s)) : 0,
        makeup,
      };
    });
}

export interface AttendanceSummary {
  total: number;
  present: number;
  late: number;
  absent: number;
  effectiveAbsent: number; // 결석 + 지각 3회당 1
  rate: number | null; // %
  makeups: number;
  needsMakeup: boolean; // 보강을 아직 신청하지 않은 결석이 있음 (결석 1건마다 보강 1회)
}

export function attendanceSummary(db: DB, studentId: number, month: string): AttendanceSummary {
  const rows = attendanceRows(db, studentId, month);
  const present = rows.filter((r) => r.status === "present").length;
  const late = rows.filter((r) => r.status === "late").length;
  const absent = rows.filter((r) => r.status === "absent").length;
  const effectiveAbsent = absent + Math.floor(late / LATE_PER_ABSENCE);
  const total = rows.length;
  const makeups = rows.filter((r) => r.makeup).length;
  return {
    total,
    present,
    late,
    absent,
    effectiveAbsent,
    rate: total ? Math.round(((total - effectiveAbsent) / total) * 100) : null,
    makeups,
    needsMakeup: absent > makeups,
  };
}

export interface PaymentRow {
  studentId: number;
  studentName: string;
  classId: number;
  className: string;
  month: string;
  amount: number; // 청구 금액 (계산)
  discount: boolean;
  partial: { count: number; total: number } | null; // 달 중간에 시작: 남은 수업 수만큼만 청구
  paidAmount: number | null;
  paidAt: string | null;
  status: "paid" | "unpaid" | "upcoming"; // upcoming: 아직 오지 않은 달
}

// 첫 달 수강료: 달 중간에 시작하면 그달 수업 수 중 남은 수업 수만큼만 (회차 기준, 10원 단위 버림)
// 환불도 회차 기준(학원법)이라 들어올 때와 나갈 때 기준을 맞춘다
function firstMonthShare(db: DB, classId: number, startDate: string, month: string) {
  const { start, end } = monthRange(month);
  const sessions = db.class_sessions.filter((x) => x.class_id === classId && x.date >= start && x.date <= end);
  const count = sessions.filter((x) => x.date >= startDate).length;
  return { count, total: sessions.length };
}

export function paymentRows(db: DB, student: Student, month: string): PaymentRow[] {
  return enrollmentsInMonth(db, student.id, month).flatMap((e): PaymentRow[] => {
    const cls = db.classes.find((c) => c.id === e.class_id)!;
    const fee = feeFor(db, student, cls, month);
    const { discount } = fee;
    let amount = fee.amount;
    let partial: PaymentRow["partial"] = null;
    if (e.start_date.slice(0, 7) === month) {
      const share = firstMonthShare(db, cls.id, e.start_date, month);
      if (share.count === 0) return []; // 그달 수업이 없으면 청구 없음
      if (share.count < share.total) {
        partial = share;
        amount = Math.floor((amount * share.count) / share.total / 10) * 10;
      }
    }
    const p = db.payments.find((x) => x.student_id === student.id && x.class_id === cls.id && x.month === month);
    return [{
      studentId: student.id,
      studentName: student.name,
      classId: cls.id,
      className: cls.name,
      month,
      amount,
      discount,
      partial,
      paidAmount: p?.paid_amount ?? null,
      paidAt: p?.paid_at ?? null,
      status: p?.paid_at ? ("paid" as const) : month > currentMonth() ? ("upcoming" as const) : ("unpaid" as const),
    }];
  });
}

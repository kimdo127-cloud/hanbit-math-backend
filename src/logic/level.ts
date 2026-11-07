// 레벨테스트 규칙: 판정 · 정기 일정 · 반 추천. 판정은 AI가 아니라 이 규칙(시스템)이 한다
import { activeCount, toMin } from "./calc";
import type { ClassLevel, ClassRoom, DB, LevelTest, LevelTestKind, Student } from "./types";

export const LEVEL_TEST_KIND_LABEL: Record<LevelTestKind, string> = { regular: "정기", entry: "입학", advance: "선행" };
export const LEVEL_MAX = { concept: 40, type: 40, advanced: 20 } as const;
export const ADVANCE_PASS = 70; // 선행 테스트 통과 점수

// 판정 기준 (총점 + 영역 조건). 총점이 높아도 개념이 약하면 기본
// 기본: 총점 69 이하 또는 개념 24 미만 / 심화: 총점 70 이상·개념 24 이상 / 최상위: 총점 90 이상·심화 15 이상
export function judgeLevel(concept: number, type: number, advanced: number): ClassLevel {
  const total = concept + type + advanced;
  if (total < 70 || concept < 24) return "기본";
  if (total >= 90 && advanced >= 15) return "최상위";
  return "심화";
}

// 정기 레벨테스트: 2월·8월 셋째 주 토요일 (새 학기 반 편성 직전). 입학·선행 테스트는 수시
function thirdSaturday(year: number, month: number) {
  const first = new Date(year, month - 1, 1);
  const day = 1 + ((6 - first.getDay() + 7) % 7) + 14;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function regularTestDates(year: number) {
  return [thirdSaturday(year, 2), thirdSaturday(year, 8)];
}
export function nextRegularTest(today: string) {
  const y = Number(today.slice(0, 4));
  return [...regularTestDates(y), ...regularTestDates(y + 1)].find((d) => d >= today)!;
}
// 홈 안내 카드: 정기 테스트 14일 전부터 당일까지
export function upcomingRegularTest(today: string) {
  const d = nextRegularTest(today);
  const days = Math.round((new Date(d + "T00:00").getTime() - new Date(today + "T00:00").getTime()) / 86400000);
  return days <= 14 ? { date: d, daysLeft: days } : null;
}

// 반 편성에 쓰는 결과 = 가장 최근 정기·입학 테스트 (선행 테스트는 '선행 가능' 여부만 본다)
export function latestPlacement(db: DB, studentId: number): LevelTest | null {
  return (
    db.level_tests
      .filter((t) => t.student_id === studentId && t.kind !== "advance")
      .sort((a, b) => b.tested_on.localeCompare(a.tested_on) || b.id - a.id)[0] ?? null
  );
}
export function latestAdvance(db: DB, studentId: number): LevelTest | null {
  return db.level_tests.filter((t) => t.student_id === studentId && t.kind === "advance").sort((a, b) => b.tested_on.localeCompare(a.tested_on) || b.id - a.id)[0] ?? null;
}
// 선행 상담 대상: 최근 판정 최상위 + 선행 테스트 통과
export function canAdvance(db: DB, studentId: number) {
  return latestPlacement(db, studentId)?.result_level === "최상위" && !!latestAdvance(db, studentId)?.advance_ok;
}

// 지금 다니는 반들과 시간이 겹치는지
function overlaps(db: DB, studentId: number, cls: ClassRoom, today: string) {
  const mine = db.enrollments
    .filter((e) => e.student_id === studentId && (e.end_date === null || e.end_date > today))
    .flatMap((e) => db.class_schedules.filter((s) => s.class_id === e.class_id));
  return db.class_schedules
    .filter((s) => s.class_id === cls.id)
    .some((s) => mine.some((m) => m.weekday === s.weekday && toMin(m.start_time) < toMin(s.end_time) && toMin(s.start_time) < toMin(m.end_time)));
}

export interface ClassRecommendation {
  cls: ClassRoom;
  seatsLeft: number;
  overlap: boolean;
}
// 추천 규칙: 같은 학년 + 최근 판정 레벨과 같은 반 + 지금 듣지 않는 반. 자리·시간은 함께 알려 준다 (선행반은 추천하지 않음)
export function recommendClasses(db: DB, student: Student, today: string): { level: ClassLevel | null; items: ClassRecommendation[] } {
  const t = latestPlacement(db, student.id);
  if (!t) return { level: null, items: [] };
  const enrolled = new Set(db.enrollments.filter((e) => e.student_id === student.id && (e.end_date === null || e.end_date > today)).map((e) => e.class_id));
  const items = db.classes
    .filter((c) => c.target_grade === student.grade && c.level === t.result_level && !enrolled.has(c.id))
    .map((c) => ({ cls: c, seatsLeft: Math.max(0, c.capacity - activeCount(db, c.id, today)), overlap: overlaps(db, student.id, c, today) }))
    .sort((a, b) => Number(a.overlap) - Number(b.overlap) || b.seatsLeft - a.seatsLeft);
  return { level: t.result_level, items };
}

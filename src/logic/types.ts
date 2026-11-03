// DB 테이블과 같은 구조 (hw2 스키마 초안). 백엔드를 붙여도 이 타입은 그대로 쓴다.

export type Grade = 7 | 8 | 9 | 10 | 11 | 12; // 중1=7 … 고3=12
export type AttendanceStatus = "present" | "late" | "absent";

export interface Family {
  id: number;
  name: string;
}

export interface Parent {
  id: number;
  family_id: number;
  email: string; // UNIQUE
  password_hash: string;
  name: string;
  created_at: string; // 연락처는 student_contacts에만 저장
}

export interface Student {
  id: number;
  family_id: number;
  name: string;
  grade: Grade;
  school: string;
  birth_date: string; // 형제 순서(둘째 할인) 기준
}

export interface StudentContact {
  id: number;
  student_id: number;
  relation: string; // 엄마, 아빠 …
  phone: string;
}

export interface Staff {
  id: number;
  email: string;
  password_hash: string | null; // null = 초대 수락 전 (본인이 초대 링크에서 비밀번호를 정해야 로그인 가능)
  name: string;
  role: "admin" | "manager" | "member"; // 권한 등급: 관리자(전체) · 매니저(업무 전반, 설정·계정 제외) · 멤버(담당 강좌만)
  position: "원장" | "강사" | "실장";
  subject: string | null;
  is_active: boolean;
}

// 초대·비밀번호 재설정 링크 (관리자는 비밀번호를 모른다). 한 번만 쓰고, 24시간 뒤 만료
export interface StaffToken {
  id: number;
  staff_id: number;
  token: string; // 링크에 들어가는 무작위 값 (백엔드에서는 해시로 저장)
  purpose: "invite" | "reset";
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export interface ClassRoom {
  id: number;
  name: string;
  target_grade: Grade;
  teacher_id: number;
  capacity: number; // 기본 8
  monthly_fee: number;
  level: string; // 수준: 기본 · 심화 · 내신 대비 등
  description: string; // 강좌 소개
  textbook: string; // 교재 (교재비 별도)
}

export interface ClassSchedule {
  id: number;
  class_id: number;
  weekday: number; // 0=일 … 6=토
  start_time: string; // "17:00"
  end_time: string;
}

export interface Enrollment {
  id: number;
  student_id: number;
  class_id: number;
  start_date: string;
  end_date: string | null; // 수강 중단일. 기록은 지우지 않음
  refund_amount: number | null; // 환불 금액 (운영이 환불 처리 때 기록)
  refunded_at: string | null;
}

export interface ClassSession {
  id: number;
  class_id: number;
  date: string; // UNIQUE(class_id, date)
  topic: string | null; // 수업 내용(진도). 강사가 출결 입력 때 적음
}

export interface Attendance {
  id: number;
  session_id: number;
  student_id: number; // UNIQUE(session_id, student_id)
  status: AttendanceStatus;
  checked_at: string | null; // 등원 시각 "HH:MM" (결석이면 null). 지각 여부는 강좌 시작 시각과 비교
  source: "kiosk" | "staff"; // 기록 방법: 입구 키오스크(학생이 직접) · 강사(결석 처리·수정)
}

export interface Makeup {
  id: number;
  absence_id: number; // attendances.id, UNIQUE (결석 1건당 보강 1건). 학생은 결석 기록에서 찾음
  session_id: number; // 보강 들어갈 다른 강좌 수업일
  requested_at: string; // 고객이 신청한 일시
}

export interface Payment {
  id: number;
  student_id: number;
  class_id: number;
  month: string; // "2026-10", UNIQUE(student_id, class_id, month)
  paid_amount: number | null; // 낸 금액은 그때 기준으로 저장
  paid_at: string | null;
}

// 변경 이력: 누가(고객/직원) · 언제 · 무엇을 · 어떻게 바꿨는지. 지우지 않고 쌓기만 한다
export type LogEntity = "student" | "enrollment" | "attendance" | "makeup" | "payment" | "refund" | "class" | "staff";
export type LogAction = "create" | "update" | "end" | "cancel";
export interface ActivityLog {
  id: number;
  at: string; // "2026-10-29T16:50"
  actor_type: "parent" | "staff";
  actor_id: number;
  actor_name: string; // 기록 당시 이름 (나중에 이름이 바뀌어도 그대로)
  student_id: number | null; // 학생과 관련 없는 변경(강좌·직원)은 null
  entity: LogEntity;
  action: LogAction;
  summary: string; // "출결 수정: 결석 → 지각(17:12)"
}

export interface DB {
  families: Family[];
  parents: Parent[];
  students: Student[];
  student_contacts: StudentContact[];
  staff: Staff[];
  classes: ClassRoom[];
  class_schedules: ClassSchedule[];
  enrollments: Enrollment[];
  class_sessions: ClassSession[];
  attendances: Attendance[];
  makeups: Makeup[];
  payments: Payment[];
  activity_logs: ActivityLog[];
  staff_tokens: StaffToken[];
}

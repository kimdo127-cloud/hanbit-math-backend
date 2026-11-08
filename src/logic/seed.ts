import { compareSync, hashSync } from "bcryptjs";
// 빈 화면을 보지 않게 넣는 가상 데이터. 나중에 백엔드 시드 SQL로 옮긴다.
import type { ActivityLog, AppNotification, AttendanceStatus, ClassLevel, DB, Grade } from "./types";
import { judgeLevel } from "./level";
import { addHours, hashInviteCode, INVITE_HOURS, newInviteCode } from "./invite";

// 목업 기준일. 백엔드를 붙이면 서버의 오늘 날짜로 바뀐다.
// 강좌 소개 (상세 화면용)
const CLASS_INFO: Record<string, { level: ClassLevel; description: string; textbook: string }> = {
  "중1 개념 기본": { level: "기본", description: "중학 수학을 처음 시작하는 강좌예요. 개념을 천천히 짚고, 매 수업 끝에 확인 문제로 이해했는지 점검해요.", textbook: "개념원리 중학 수학 1-2" },
  "중2 내신 대비": { level: "기본", description: "교과서 개념과 유형 문제를 함께 다뤄요. 학교 진도에 맞춰 내신 시험 3주 전부터는 기출 위주로 준비해요.", textbook: "개념원리 중학 수학 2-2 · 쎈 중2-2" },
  "중2 심화": { level: "심화", description: "개념을 알고 있는 학생이 응용·심화 문제를 푸는 강좌예요. 서술형 풀이를 매주 첨삭해요.", textbook: "블랙라벨 중2-2" },
  "중2 금요 보충": { level: "기본", description: "주 1회 금요일에 듣는 보충 강좌예요. 한 주 동안 배운 내용을 복습하고 부족한 유형을 채워요.", textbook: "쎈 중2-2" },
  "중3 내신 + 고등 선행": { level: "심화", description: "중3 내신과 고등 수학 준비를 함께 해요. 2학기에는 고1 공통수학 선행을 시작해요.", textbook: "개념원리 중학 수학 3-2 · 고등 공통수학1" },
  "고1 공통수학 내신": { level: "기본", description: "고1 공통수학 내신 강좌예요. 학교별 기출을 분석해 시험 범위에 맞춘 문제를 풀어요.", textbook: "개념원리 공통수학1 · 학교 부교재" },
  "고2 수학Ⅰ·Ⅱ 수능 기초": { level: "기본", description: "수학Ⅰ·Ⅱ 개념을 정리하고 수능형 문제에 익숙해지는 강좌예요.", textbook: "수학의 정석 수학Ⅰ · 수능특강" },
};

// 학년별 진도 (수업 내용 시연용)
const TOPICS: Record<number, string[]> = {
  7: ["소인수분해", "최대공약수와 최소공배수", "정수와 유리수", "정수의 사칙계산", "문자와 식", "일차방정식 풀이", "일차방정식 활용", "좌표평면과 그래프", "정비례와 반비례", "기본 도형", "작도와 합동", "단원 평가"],
  8: ["유리수와 순환소수", "지수법칙", "단항식의 계산", "다항식의 계산", "일차부등식", "연립방정식 풀이", "연립방정식 활용", "일차함수와 그래프", "일차함수의 기울기", "일차함수와 일차방정식", "이등변삼각형의 성질", "단원 평가"],
  9: ["제곱근의 뜻", "무리수와 실수", "근호를 포함한 식의 계산", "다항식의 곱셈", "인수분해", "이차방정식 풀이", "근의 공식", "이차함수의 그래프", "삼각비", "원의 성질", "대푯값과 산포도", "단원 평가"],
  10: ["다항식의 연산", "나머지정리", "인수분해", "복소수", "이차방정식", "이차함수", "여러 가지 방정식", "부등식", "평면좌표", "직선의 방정식", "원의 방정식", "단원 평가"],
  11: ["지수", "로그", "지수함수", "로그함수", "삼각함수", "사인법칙", "등차수열", "등비수열", "수열의 합", "수학적 귀납법", "함수의 극한", "단원 평가"],
};

export const TODAY = "2026-10-29";

// 목업 전용 해시 (백엔드에서는 bcrypt). 비밀번호 원문은 저장하지 않는다.
// 비밀번호는 bcrypt 해시로만 저장한다 (원문 저장 금지). 목업 때 이름(mockHash)을 그대로 두고 속만 바꿨다
export function mockHash(pw: string): string {
  return hashSync(pw, 10);
}
export function checkPw(pw: string, hash: string | null): boolean {
  return !!hash && compareSync(pw, hash);
}

const FILLER_NAMES = [
  "이도윤", "박지호", "최서연", "정예준", "강하은", "조민준", "윤지우", "장서윤",
  "임주원", "한지민", "오시우", "서다은", "신유준", "권채원", "황도현", "안수아",
  "송은우", "류지안", "전하준", "홍예린", "고건우", "문서아", "양시윤", "배윤서",
  "백준서", "허지유", "남우진", "노하윤", "심재윤", "유나연", "구민재", "진소율",
  "엄태윤", "채아린", "원지환", "천예나", "방승우", "공다인",
];

function dateStr(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function createSeed(): DB {
  const db: DB = {
    families: [],
    parents: [],
    students: [],
    family_contacts: [],
    staff: [],
    classes: [],
    class_schedules: [],
    enrollments: [],
    class_sessions: [],
    attendances: [],
    makeups: [],
    payments: [],
    activity_logs: [],
    staff_tokens: [],
    level_tests: [],
    invitations: [],
    notifications: [],
  };

  // 직원
  db.staff.push(
    { id: 1, email: "admin@hanbit.kr", password_hash: mockHash("admin1234"), name: "정원장", role: "admin", position: "원장", subject: null, is_active: true },
    { id: 2, email: "park@hanbit.kr", password_hash: mockHash("staff1234"), name: "박선생", role: "member", position: "강사", subject: "중등 수학", is_active: true },
    { id: 3, email: "choi@hanbit.kr", password_hash: mockHash("staff1234"), name: "최선생", role: "member", position: "강사", subject: "중등 수학", is_active: true },
    { id: 4, email: "lee@hanbit.kr", password_hash: mockHash("staff1234"), name: "이선생", role: "member", position: "강사", subject: "고등 수학", is_active: true },
    { id: 5, email: "office@hanbit.kr", password_hash: mockHash("staff1234"), name: "한실장", role: "manager", position: "실장", subject: null, is_active: true },
  );

  // 강좌: [이름, 학년, 강사, 요일들, 시작, 끝, 채울 인원(시연 가족 제외)]
  const classDefs: [string, Grade, number, number[], string, string, number][] = [
    ["중1 개념 기본", 7, 2, [1, 3], "17:00", "19:00", 6],
    ["중2 내신 대비", 8, 2, [2, 4], "17:00", "19:00", 5],
    ["중2 심화", 8, 3, [1, 3], "19:30", "21:30", 8], // 정원 마감 시연
    ["중3 내신 + 고등 선행", 9, 3, [2, 4], "19:30", "21:30", 4],
    ["고1 공통수학 내신", 10, 4, [1, 3], "19:30", "21:30", 7],
    ["고2 수학Ⅰ·Ⅱ 수능 기초", 11, 4, [2, 4], "20:00", "22:00", 3],
    ["중2 금요 보충", 8, 4, [5], "17:00", "19:00", 4], // 금요일 강좌: 보강 들어갈 자리 시연
  ];
  let schedId = 1;
  classDefs.forEach(([name, grade, teacher, days, s, e], i) => {
    const id = i + 1;
    db.classes.push({ id, name, target_grade: grade, teacher_id: teacher, capacity: 8, monthly_fee: 280000, ...CLASS_INFO[name] });
    days.forEach((wd) => db.class_schedules.push({ id: schedId++, class_id: id, weekday: wd, start_time: s, end_time: e }));
  });

  // 수업일: 9월 1일 ~ 11월 30일 (기준일 이후는 예정)
  let sessId = 1;
  for (let d = new Date(2026, 8, 1); d <= new Date(2026, 10, 30); d.setDate(d.getDate() + 1)) {
    const wd = d.getDay();
    db.class_schedules.filter((cs) => cs.weekday === wd).forEach((cs) => {
      const grade = db.classes.find((c) => c.id === cs.class_id)!.target_grade;
      const list = TOPICS[grade] ?? TOPICS[8];
      const n = db.class_sessions.filter((x) => x.class_id === cs.class_id).length;
      db.class_sessions.push({ id: sessId++, class_id: cs.class_id, date: dateStr(d), topic: list[n % list.length] });
    });
  }

  // 시연 가족: 김씨네 (형제 2명)
  db.families.push({ id: 1, name: "김서준·김하린 가족" });
  db.parents.push({ id: 1, family_id: 1, email: "demo@hanbit.kr", password_hash: mockHash("hanbit1234"), name: "김민정", created_at: "2026-08-20" });
  db.students.push(
    { id: 1, family_id: 1, name: "김서준", grade: 8, school: "한빛중학교", birth_date: "2012-04-11", kiosk_code: "2580" },
    { id: 2, family_id: 1, name: "김하린", grade: 7, school: "한빛중학교", birth_date: "2013-09-02", kiosk_code: "1357" },
  );
  // 연락처는 가족 단위 (서준·하린 남매가 같은 번호를 공유). 대표 = 초대 문자를 받는 번호
  db.family_contacts.push(
    { id: 1, family_id: 1, relation: "엄마", phone: "010-1234-5678", is_primary: true },
    { id: 2, family_id: 1, relation: "아빠", phone: "010-8765-4321", is_primary: false },
  );
  db.enrollments.push(
    { id: 1, student_id: 1, class_id: 2, start_date: "2026-09-01", end_date: null, refund_amount: null, refunded_at: null }, // 서준 중2 내신 대비
    { id: 2, student_id: 2, class_id: 1, start_date: "2026-09-01", end_date: null, refund_amount: null, refunded_at: null }, // 하린 중1 개념 기본
  );

  // 다른 가족 학생들로 강좌 채우기
  let studentId = 3;
  let enrollId = 3;
  let familyId = 2;
  let nameIdx = 0;
  classDefs.forEach(([, grade, , , , , fill], i) => {
    for (let k = 0; k < fill; k++) {
      db.families.push({ id: familyId, name: `${FILLER_NAMES[nameIdx % FILLER_NAMES.length]} 가족` });
      db.students.push({ id: studentId, family_id: familyId, name: FILLER_NAMES[nameIdx % FILLER_NAMES.length], grade, school: "한빛중학교", birth_date: "2012-01-01", kiosk_code: String(3000 + studentId * 17) });
      db.enrollments.push({ id: enrollId++, student_id: studentId, class_id: i + 1, start_date: "2026-09-01", end_date: null, refund_amount: null, refunded_at: null });
      // 보호자 연락처 (키오스크에서 뒷자리 4자리로 찾음)
      db.family_contacts.push({ id: db.family_contacts.length + 1, family_id: familyId, relation: k % 2 ? "아빠" : "엄마", phone: `010-${2000 + studentId * 13}-${String(1000 + ((studentId * 379) % 9000)).padStart(4, "0")}`, is_primary: true });
      studentId++;
      familyId++;
      nameIdx++;
    }
  });

  // 운영 시연: 수강 중단·환불 (고1 강좌 1명은 환불 대기, 고2 강좌 1명은 환불 완료)
  const g1 = db.enrollments.find((e) => e.class_id === 5)!;
  g1.end_date = "2026-10-12";
  const g2 = db.enrollments.find((e) => e.class_id === 6)!;
  Object.assign(g2, { end_date: "2026-10-05", refund_amount: 186660, refunded_at: "2026-10-08" });
  // 운영 시연: 학년이 다른 강좌 수강(선행) — 중1 학생이 중2 금요 보충
  db.families.push({ id: familyId, name: "윤채원 가족" });
  db.students.push({ id: studentId, family_id: familyId, name: "윤채원", grade: 7, school: "한빛중학교", birth_date: "2013-03-02", kiosk_code: "7788" });
  db.enrollments.push({ id: enrollId++, student_id: studentId, class_id: 7, start_date: "2026-10-02", end_date: null, refund_amount: null, refunded_at: null });
  db.family_contacts.push({ id: db.family_contacts.length + 1, family_id: familyId, relation: "엄마", phone: "010-4455-7788", is_primary: true });
  // 초대 시연: 김씨네는 가입 완료, 윤채원 가족은 초대 발급(유효), 이도윤 가족은 초대 만료 → 어드민에서 다시 보내기
  // 코드는 무작위라 시드에서는 아무도 모른다 (시연 가입은 어드민에서 새로 발급)
  const invite = (family_id: number, phone: string, created_at: string, used_at: string | null) =>
    db.invitations.push({ id: db.invitations.length + 1, family_id, phone, token_hash: hashInviteCode(newInviteCode()), created_by: 5, created_at, expires_at: addHours(created_at, INVITE_HOURS), used_at, revoked_at: null });
  invite(1, "010-1234-5678", "2026-08-20T15:10", "2026-08-20T21:05");
  invite(familyId, "010-4455-7788", "2026-10-28T16:00", null);
  invite(2, db.family_contacts.find((c) => c.family_id === 2)!.phone, "2026-10-20T15:00", null);

  // 출결: 기준일까지 기록. 시연 학생은 정해진 패턴, 나머지는 대부분 출석
  const demoPattern: Record<number, Record<string, AttendanceStatus>> = {
    // 서준(화·목): 10월 지각 3, 결석 2 → 보강 필요
    1: {
      "2026-10-06": "late", "2026-10-08": "absent", "2026-10-13": "late",
      "2026-10-20": "absent", "2026-10-22": "late",
      "2026-09-15": "absent",
    },
    // 하린(월·수): 10월 지각 1
    2: { "2026-10-14": "late" },
  };
  let attId = 1;
  db.enrollments.forEach((en) => {
    db.class_sessions
      .filter((s) => s.class_id === en.class_id && s.date >= en.start_date && (en.end_date ? s.date < en.end_date : s.date <= TODAY))
      .forEach((s, idx) => {
        // 오늘 저녁 수업(18시 이후 시작)은 아직 등원 전 → 키오스크 시연용으로 비워 둔다
        const wd0 = new Date(s.date + "T00:00:00").getDay();
        if (s.date === TODAY && db.class_schedules.find((c) => c.class_id === s.class_id && c.weekday === wd0)!.start_time >= "18:00") return;
        let status: AttendanceStatus = "present";
        if (demoPattern[en.student_id]) status = demoPattern[en.student_id][s.date] ?? "present";
        else if ((en.student_id * 7 + idx) % 23 === 0) status = "absent";
        else if ((en.student_id * 5 + idx) % 17 === 0) status = "late";
        // 등원 시각: 출석은 시작 0~12분 전, 지각은 시작 5~24분 후, 결석은 없음
        const wd = new Date(s.date + "T00:00:00").getDay();
        const start = db.class_schedules.find((c) => c.class_id === s.class_id && c.weekday === wd)!.start_time;
        const [h, m] = start.split(":").map(Number);
        const off = status === "present" ? -((en.student_id * 3 + idx * 5) % 13) : 5 + ((en.student_id + idx * 7) % 20);
        const t = h * 60 + m + off;
        const checked_at = status === "absent" ? null : `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
        // 등원은 키오스크(학생이 직접), 결석은 강사가 확인해 처리
        // 하원: 지난 수업은 끝나는 시각 무렵에 찍었다고 둔다 (오늘 수업은 아직 수업 중)
        const end = db.class_schedules.find((c) => c.class_id === s.class_id && c.weekday === wd)!.end_time;
        const [eh, em] = end.split(":").map(Number);
        const lt = eh * 60 + em + ((en.student_id + idx) % 9);
        const left_at = checked_at && s.date < TODAY ? `${String(Math.floor(lt / 60)).padStart(2, "0")}:${String(lt % 60).padStart(2, "0")}` : null;
        db.attendances.push({ id: attId++, session_id: s.id, student_id: en.student_id, status, checked_at, left_at, source: status === "absent" ? "staff" : "kiosk" });
      });
  });

  // 서준의 9월 결석은 중2 심화 수업으로 보강 완료
  const sepAbsence = db.attendances.find((a) => {
    const s = db.class_sessions.find((x) => x.id === a.session_id)!;
    return a.student_id === 1 && s.date === "2026-09-15";
  });
  const sepMakeupSession = db.class_sessions.find((s) => s.class_id === 3 && s.date === "2026-09-16");
  if (sepAbsence && sepMakeupSession) {
    db.makeups.push({ id: 1, absence_id: sepAbsence.id, session_id: sepMakeupSession.id, requested_at: "2026-09-15T21:00" });
  }

  // 납부: 9월은 모두 납부, 10월은 하린만 미납(시연) + 일부 미납
  let payId = 1;
  db.enrollments.forEach((en) => {
    ["2026-09", "2026-10"].forEach((month) => {
      const unpaid = month === "2026-10" && (en.student_id === 2 || en.student_id % 9 === 0);
      db.payments.push({
        id: payId++,
        student_id: en.student_id,
        class_id: en.class_id,
        month,
        paid_amount: unpaid ? null : en.student_id === 2 ? 252000 : 280000,
        paid_at: unpaid ? null : `${month}-05`,
      });
    });
  });

  // 레벨테스트 시연: 입학 테스트(8/20, 한실장 입력) — 반 레벨에 맞춘 점수. 정기 테스트는 2월·8월 셋째 토요일
  // 서준: 심화 판정인데 기본반을 다님 → 심화반 추천(마감) / 하린: 최상위 + 선행 테스트 통과 → 선행 상담 대상
  // 분야별 정답률(중등만): 점수 비율을 기준으로 학생마다 조금씩 다르게
  const areas = (grade: number, total: number, seed: number) => {
    if (grade > 9) return { area_number: null, area_change: null, area_shape: null, area_data: null };
    const v = (k: number) => Math.max(0, Math.min(100, total + (((seed * k) % 31) - 15)));
    return { area_number: v(7), area_change: v(11), area_shape: v(13), area_data: v(17) };
  };
  const addTest = (studentId: number, kind: "regular" | "entry" | "advance", tested_on: string, grade: number, c: number, t: number, a: number, staff_id: number, memo = "", fixed?: [number, number, number, number]) => {
    const total = c + t + a;
    db.level_tests.push({
      id: db.level_tests.length + 1, student_id: studentId, kind, tested_on, test_grade: grade as Grade,
      concept_score: c, type_score: t, advanced_score: a, total_score: total, result_level: judgeLevel(c, t, a),
      advance_ok: kind === "advance" && total >= 70, staff_id, memo,
      ...(fixed ? { area_number: fixed[0], area_change: fixed[1], area_shape: fixed[2], area_data: fixed[3] } : areas(grade, total, studentId + tested_on.length)),
    });
  };
  // 서준: 입학 테스트 1건 / 하린: 입학 + 선행 테스트
  addTest(1, "entry", "2026-08-20", 8, 30, 32, 14, 5, "개념은 탄탄해요. 도형 서술형 풀이를 더 연습하면 좋아요.", [82, 78, 58, 74]);
  addTest(2, "entry", "2026-08-20", 7, 36, 38, 17, 5, "계산 실수가 거의 없어요. 지금처럼 꾸준히 하면 돼요.", [96, 90, 88, 92]);
  addTest(2, "advance", "2026-10-17", 8, 31, 30, 13, 2, "중2 1단원 선행 테스트를 통과했어요.", [80, 72, 70, 76]);
  db.students.filter((st) => st.id > 2).forEach((st) => {
    const en = db.enrollments.find((e) => e.student_id === st.id)!;
    const lv = db.classes.find((c) => c.id === en.class_id)!.level;
    const r = (n: number) => (st.id * n) % 7; // 학생마다 다른 점수 (재현 가능)
    const [c, t, a] = lv === "심화" ? [26 + r(3), 26 + r(5), 10 + r(2)] : [17 + r(3) * 2, 18 + r(5) * 2, 4 + r(2)];
    addTest(st.id, "entry", en.start_date === "2026-09-01" ? "2026-08-20" : "2026-09-26", st.grade, c, t, a, 5);
  });

  // 알림 시연 (김씨네): 지난 것은 읽음, 최근 것은 안 읽음
  const note = (created_at: string, student_id: number, kind: AppNotification["kind"], title: string, body: string, link: string, read: boolean) =>
    db.notifications.push({ id: db.notifications.length + 1, family_id: 1, student_id, kind, title, body, link, created_at, read_at: read ? created_at : null });
  note("2026-10-17T18:20", 2, "level_test", "하린 레벨테스트 결과가 나왔어요", "10/17 선행 테스트 74점 · 선행 통과", "/me/child/2", true);
  note("2026-10-20T19:30", 1, "absent", "서준 결석", "10/20(화) 중2 내신 대비 수업에 오지 않았어요. 보강을 신청할 수 있어요.", "/makeup", true);
  note("2026-10-22T17:11", 1, "late", "서준 지각 · 11분", "중2 내신 대비 17:00 수업 · 17:11 등원", "/attendance", true);
  note("2026-10-27T19:04", 1, "leave", "서준 하원", "중2 내신 대비 · 19:04 하원", "/attendance", false);
  note("2026-10-29T16:50", 1, "arrive", "서준 등원", "중2 내신 대비 17:00 수업 · 16:50 등원", "/attendance", false);

  // 변경 이력 시연: 수강 등록·보강 신청·수강 중단·환불 기록
  const log = (at: string, actor_type: "parent" | "staff", actor_id: number, actor_name: string, student_id: number | null, entity: ActivityLog["entity"], action: ActivityLog["action"], summary: string) =>
    db.activity_logs.push({ id: db.activity_logs.length + 1, at, actor_type, actor_id, actor_name, student_id, entity, action, summary });
  db.enrollments.forEach((e) => {
    const c = db.classes.find((x) => x.id === e.class_id)!;
    const viaApp = e.student_id <= 2;
    log(`${e.start_date === "2026-09-01" ? "2026-08-25" : "2026-09-28"}T${viaApp ? "21:10" : "15:00"}`, viaApp ? "parent" : "staff", viaApp ? 1 : 5, viaApp ? "김민정" : "한실장", e.student_id, "enrollment", "create", `수강 등록: ${c.name} (${e.start_date} 시작)`);
  });
  log("2026-09-15T21:00", "parent", 1, "김민정", 1, "makeup", "create", "보강 신청: 9/15 결석분 → 9/16 중2 심화");
  log("2026-10-12T19:40", "staff", 5, "한실장", g1.student_id, "enrollment", "end", "수강 중단: 고1 공통수학 내신 (10/12, 보호자 전화 요청)");
  log("2026-10-05T18:20", "staff", 5, "한실장", g2.student_id, "enrollment", "end", "수강 중단: 고2 수학Ⅰ·Ⅱ 수능 기초 (10/5)");
  log("2026-10-08T11:00", "staff", 5, "한실장", g2.student_id, "refund", "create", "환불 기록: 186,660원 (1/3 지나기 전 · 2/3)");
  log("2026-10-22T17:30", "staff", 2, "박선생", 1, "attendance", "update", "출결 수정 10/22 중2 내신 대비: 결석 → 지각(17:11)");
  db.activity_logs.sort((a, b) => a.at.localeCompare(b.at)).forEach((l, i) => (l.id = i + 1));

  return db;
}

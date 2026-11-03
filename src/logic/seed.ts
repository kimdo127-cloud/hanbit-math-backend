import { compareSync, hashSync } from "bcryptjs";
// 빈 화면을 보지 않게 넣는 가상 데이터. 나중에 백엔드 시드 SQL로 옮긴다.
import type { ActivityLog, AttendanceStatus, DB, Grade } from "./types";

// 목업 기준일. 백엔드를 붙이면 서버의 오늘 날짜로 바뀐다.
// 강좌 소개 (상세 화면용)
const CLASS_INFO: Record<string, { level: string; description: string; textbook: string }> = {
  "중1 개념 기본": { level: "기본", description: "중학 수학을 처음 시작하는 강좌예요. 개념을 천천히 짚고, 매 수업 끝에 확인 문제로 이해했는지 점검해요.", textbook: "개념원리 중학 수학 1-2" },
  "중2 내신 대비": { level: "기본", description: "교과서 개념과 유형 문제를 함께 다뤄요. 학교 진도에 맞춰 내신 시험 3주 전부터는 기출 위주로 준비해요.", textbook: "개념원리 중학 수학 2-2 · 쎈 중2-2" },
  "중2 심화": { level: "심화", description: "개념을 알고 있는 학생이 응용·심화 문제를 푸는 강좌예요. 서술형 풀이를 매주 첨삭해요.", textbook: "블랙라벨 중2-2" },
  "중2 금요 보충": { level: "기본", description: "주 1회 금요일에 듣는 보충 강좌예요. 한 주 동안 배운 내용을 복습하고 부족한 유형을 채워요.", textbook: "쎈 중2-2" },
  "중3 내신 + 고등 선행": { level: "내신 대비", description: "중3 내신과 고등 수학 준비를 함께 해요. 2학기에는 고1 공통수학 선행을 시작해요.", textbook: "개념원리 중학 수학 3-2 · 고등 공통수학1" },
  "고1 공통수학 내신": { level: "내신 대비", description: "고1 공통수학 내신 강좌예요. 학교별 기출을 분석해 시험 범위에 맞춘 문제를 풀어요.", textbook: "개념원리 공통수학1 · 학교 부교재" },
  "고2 수학Ⅰ·Ⅱ 수능 기초": { level: "수능 기초", description: "수학Ⅰ·Ⅱ 개념을 정리하고 수능형 문제에 익숙해지는 강좌예요.", textbook: "수학의 정석 수학Ⅰ · 수능특강" },
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
    student_contacts: [],
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
    { id: 1, family_id: 1, name: "김서준", grade: 8, school: "한빛중학교", birth_date: "2012-04-11" },
    { id: 2, family_id: 1, name: "김하린", grade: 7, school: "한빛중학교", birth_date: "2013-09-02" },
  );
  db.student_contacts.push(
    { id: 1, student_id: 1, relation: "엄마", phone: "010-1234-5678" },
    { id: 2, student_id: 1, relation: "아빠", phone: "010-8765-4321" },
    { id: 3, student_id: 2, relation: "엄마", phone: "010-1234-5678" },
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
      db.students.push({ id: studentId, family_id: familyId, name: FILLER_NAMES[nameIdx % FILLER_NAMES.length], grade, school: "한빛중학교", birth_date: "2012-01-01" });
      db.enrollments.push({ id: enrollId++, student_id: studentId, class_id: i + 1, start_date: "2026-09-01", end_date: null, refund_amount: null, refunded_at: null });
      // 보호자 연락처 (키오스크에서 뒷자리 4자리로 찾음)
      db.student_contacts.push({ id: db.student_contacts.length + 1, student_id: studentId, relation: k % 2 ? "아빠" : "엄마", phone: `010-${2000 + studentId * 13}-${String(1000 + ((studentId * 379) % 9000)).padStart(4, "0")}` });
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
  db.students.push({ id: studentId, family_id: familyId, name: "윤채원", grade: 7, school: "한빛중학교", birth_date: "2013-03-02" });
  db.enrollments.push({ id: enrollId++, student_id: studentId, class_id: 7, start_date: "2026-10-02", end_date: null, refund_amount: null, refunded_at: null });
  db.student_contacts.push({ id: db.student_contacts.length + 1, student_id: studentId, relation: "엄마", phone: "010-4455-7788" });

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
        db.attendances.push({ id: attId++, session_id: s.id, student_id: en.student_id, status, checked_at, source: status === "absent" ? "staff" : "kiosk" });
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

-- 한빛수학 hw2 스키마. 1주차 테이블과 섞이지 않게 과제용 공간(schema)을 따로 쓴다
-- 규칙 위치: 한 테이블 안에서 끝나는 규칙(중복·범위·필수값)은 DB가, 여러 테이블을 함께 봐야 하는 규칙은 백엔드가 막는다
-- id는 앱이 정한다(integer). 트랜잭션은 SERIALIZABLE이라 동시에 같은 id를 쓰면 한쪽이 다시 시도된다

CREATE SCHEMA IF NOT EXISTS __SCHEMA__;
SET search_path TO __SCHEMA__;

DROP TABLE IF EXISTS activity_logs, staff_tokens, payments, makeups, attendances, class_sessions, enrollments, class_schedules, classes, staff, student_contacts, students, parents, families CASCADE;

-- 가족: 형제를 묶는 단위 (둘째 할인)
CREATE TABLE families (
  id integer PRIMARY KEY,
  name text NOT NULL
);

-- 보호자 계정 (코어 웹). 가족당 하나
CREATE TABLE parents (
  id integer PRIMARY KEY,
  family_id integer NOT NULL UNIQUE REFERENCES families(id),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,          -- bcrypt 해시. 비밀번호 원문은 저장하지 않음
  name text NOT NULL,
  created_at date NOT NULL
);

CREATE TABLE students (
  id integer PRIMARY KEY,
  family_id integer NOT NULL REFERENCES families(id),
  name text NOT NULL,
  grade smallint NOT NULL CHECK (grade BETWEEN 7 AND 12),   -- 중1=7 … 고3=12
  school text NOT NULL,
  birth_date date NOT NULL
);

CREATE TABLE student_contacts (
  id integer PRIMARY KEY,
  student_id integer NOT NULL REFERENCES students(id),
  relation text NOT NULL,
  phone text NOT NULL CHECK (phone ~ '^[0-9-]{9,13}$')
);

-- 직원 계정 (어드민). 권한 등급: 관리자·매니저·멤버
CREATE TABLE staff (
  id integer PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text,                   -- NULL = 초대 수락 전
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'manager', 'member')),
  position text NOT NULL CHECK (position IN ('원장', '강사', '실장')),
  subject text,
  is_active boolean NOT NULL DEFAULT true
);

-- 초대·비밀번호 재설정 링크. 한 번만 쓰고 24시간 뒤 만료
CREATE TABLE staff_tokens (
  id integer PRIMARY KEY,
  staff_id integer NOT NULL REFERENCES staff(id),
  token text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  created_at timestamp NOT NULL,
  expires_at timestamp NOT NULL CHECK (expires_at > created_at),
  used_at timestamp
);

-- 강좌: 학생이 등록하는 단위
CREATE TABLE classes (
  id integer PRIMARY KEY,
  name text NOT NULL,
  target_grade smallint NOT NULL CHECK (target_grade BETWEEN 7 AND 12),
  teacher_id integer NOT NULL REFERENCES staff(id),
  capacity smallint NOT NULL CHECK (capacity > 0),
  monthly_fee integer NOT NULL CHECK (monthly_fee >= 0),
  level text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  textbook text NOT NULL DEFAULT ''
);

CREATE TABLE class_schedules (
  id integer PRIMARY KEY,
  class_id integer NOT NULL REFERENCES classes(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time time NOT NULL,
  end_time time NOT NULL,
  CHECK (end_time > start_time),
  UNIQUE (class_id, weekday)
);

-- 수강: 기록은 지우지 않고 중단일만 남긴다 (환불 계산 근거)
CREATE TABLE enrollments (
  id integer PRIMARY KEY,
  student_id integer NOT NULL REFERENCES students(id),
  class_id integer NOT NULL REFERENCES classes(id),
  start_date date NOT NULL,
  end_date date,
  refund_amount integer CHECK (refund_amount >= 0),
  refunded_at date,
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (refunded_at IS NULL OR end_date IS NOT NULL)
);
-- 같은 강좌를 동시에 두 번 수강할 수 없음 (다니는 중인 것만)
CREATE UNIQUE INDEX enrollments_one_active ON enrollments (student_id, class_id) WHERE end_date IS NULL;

-- 수업: 강좌가 실제로 열리는 날짜 한 번
CREATE TABLE class_sessions (
  id integer PRIMARY KEY,
  class_id integer NOT NULL REFERENCES classes(id),
  date date NOT NULL,
  topic text,
  UNIQUE (class_id, date)
);

CREATE TABLE attendances (
  id integer PRIMARY KEY,
  session_id integer NOT NULL REFERENCES class_sessions(id),
  student_id integer NOT NULL REFERENCES students(id),
  status text NOT NULL CHECK (status IN ('present', 'late', 'absent')),
  checked_at time,
  source text NOT NULL CHECK (source IN ('kiosk', 'staff')),
  UNIQUE (session_id, student_id),
  CHECK ((status = 'absent') = (checked_at IS NULL))   -- 결석이면 등원 시각 없음, 출석·지각이면 있음
);

-- 보강: 결석 1건에 보강 1건
CREATE TABLE makeups (
  id integer PRIMARY KEY,
  absence_id integer NOT NULL UNIQUE REFERENCES attendances(id),
  session_id integer NOT NULL REFERENCES class_sessions(id),
  requested_at timestamp NOT NULL
);

-- 납부: 학생·강좌·월마다 하나. 낸 금액은 그때 기준으로 저장
CREATE TABLE payments (
  id integer PRIMARY KEY,
  student_id integer NOT NULL REFERENCES students(id),
  class_id integer NOT NULL REFERENCES classes(id),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  paid_amount integer CHECK (paid_amount >= 0),
  paid_at date,
  UNIQUE (student_id, class_id, month),
  CHECK ((paid_amount IS NULL) = (paid_at IS NULL))
);

-- 변경 이력: 쌓기만 한다
CREATE TABLE activity_logs (
  id integer PRIMARY KEY,
  at timestamp NOT NULL,
  actor_type text NOT NULL CHECK (actor_type IN ('parent', 'staff')),
  actor_id integer NOT NULL,
  actor_name text NOT NULL,
  student_id integer REFERENCES students(id),
  entity text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'end', 'cancel')),
  summary text NOT NULL
);

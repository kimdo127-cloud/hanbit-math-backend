# hanbit-math-backend

한빛수학 코어 웹(`hanbit-math-web`)과 어드민(`hanbit-math-admin`)이 **함께 쓰는 백엔드 하나** (NestJS).
DB는 1주차 Render PostgreSQL 안의 과제용 공간 `hw2` 스키마를 쓴다.

## 구조

| 위치 | 하는 일 |
|---|---|
| `src/db/schema.sql` | hw2 표와 **DB가 지키는 규칙** (같은 강좌 동시 수강 금지, 수업당 출결 하나, 결석 1건당 보강 1건, 정원 > 0, 끝 시각 > 시작 시각 등) |
| `src/logic/web-api.ts` | 코어 웹 기능과 **백엔드가 지키는 규칙** (정원, 형제 할인, 보강 가능한 수업, 환불 계산 등 여러 표를 함께 봐야 하는 규칙) |
| `src/logic/admin-api.ts` | 어드민 기능과 권한 (관리자 · 매니저 · 멤버=담당 강좌만) |
| `src/api.controller.ts` | `POST /api/web/<함수>`, `POST /api/admin/<함수>` · 로그인 토큰(JWT) 확인 · 거절 이유를 쉬운 말로 |
| `src/db/store.ts`, `sync.ts` | 요청 하나 = SERIALIZABLE 트랜잭션 하나. 바뀐 줄만 DB에 씀 |

- 비밀번호는 bcrypt 해시로만 저장한다.
- 고객 토큰으로는 어드민 기능을, 직원 토큰으로는 고객 기능을 부를 수 없다.
- 학원 규모(학생 수십~수백 명)라 요청마다 표를 읽어 규칙을 검사한다. 규모가 커지면 기능별 SQL로 바꾼다.

## 로컬 실행

```bash
cp .env.example .env        # DATABASE_URL에 Render의 External Database URL을 넣는다 (GitHub에 올리지 않음)
npm install
npm run build
npm run db:setup            # hw2에 표와 시연 데이터를 만든다 (hw2의 한빛수학 표를 지우고 다시 만듦)
npm start                   # http://localhost:4000  · 확인: /health
```

## Render 배포 (Web Service)

| 항목 | 값 |
|---|---|
| Build Command | `npm install && npm run build` |
| Start Command | `npm start` |
| 환경 변수 | `DATABASE_URL`(**Internal** Database URL), `DB_SCHEMA=hw2`, `JWT_SECRET`(긴 무작위 문자열), `CORS_ORIGINS`(Vercel의 web·admin 주소, 쉼표로), `ALLOW_RESET=false` |

무료 서버는 15분 동안 요청이 없으면 잠든다. 첫 요청은 30초~1분 걸릴 수 있다.

## 시연 계정

- 고객: `demo@hanbit.kr` / `hanbit1234`
- 직원: `admin@hanbit.kr` / `admin1234` (관리자), `office@hanbit.kr` / `staff1234` (매니저), `park@hanbit.kr` / `staff1234` (멤버)

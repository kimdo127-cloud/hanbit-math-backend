// 설정값 읽기: 과제 폴더의 .env 한 곳(과제/.env)에서 읽는다
// 이미 있는 값은 덮어쓰지 않는다. Render에 배포하면 파일 없이 Render 환경 변수만 쓴다
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../../../../.env") });

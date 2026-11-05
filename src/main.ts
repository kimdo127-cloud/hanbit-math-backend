// 서버 시각을 한국 시간으로 (등원 시각·변경 이력). Render 서버는 기본이 UTC
process.env.TZ = "Asia/Seoul";
import "reflect-metadata";
import "./env";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  // 배포된 코어 웹·어드민 두 주소에서 오는 요청만 받는다
  const origins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins.length ? origins : true, allowedHeaders: ["Content-Type", "Authorization"], methods: ["GET", "POST"] });
  const port = Number(process.env.PORT) || 4000;
  await app.listen(port);
  console.log(`한빛수학 백엔드: http://localhost:${port}`);
}
bootstrap();

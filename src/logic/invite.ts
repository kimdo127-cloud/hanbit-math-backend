// 학부모 초대 코드: 학원이 보낸 초대 문자의 링크로만 가입하게 한다
// 코드 = 보호자 번호를 서버 비밀값으로 서명한 값 (DB에 저장하지 않음). 번호마다 다르고, 비밀값 없이는 만들 수 없다
import { createHmac, timingSafeEqual } from "crypto";

const digits = (p: string) => p.replace(/[^0-9]/g, "");

export function inviteCode(phone: string) {
  return createHmac("sha256", process.env.JWT_SECRET || "dev-only-secret")
    .update(`parent-invite:${digits(phone)}`)
    .digest("base64url")
    .slice(0, 16);
}

export function isValidInvite(phone: string, code: string | undefined) {
  if (!code) return false;
  const a = Buffer.from(inviteCode(phone));
  const b = Buffer.from(code.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

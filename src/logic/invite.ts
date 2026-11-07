// 학부모 초대 링크: 학원(직원)이 발급한 초대(invitations)의 코드로만 가입한다
// 코드는 무작위 값. DB에는 해시만 저장하고 원문은 발급할 때 한 번만 돌려준다 (초대 문자에 넣음)
import { createHash, randomBytes } from "crypto";

export const INVITE_HOURS = 72; // 3일

export function newInviteCode() {
  return randomBytes(12).toString("base64url"); // 16자
}
export function hashInviteCode(code: string) {
  return createHash("sha256").update(`parent-invite:${code.trim()}`).digest("hex");
}

// "2026-10-29T16:50" + 시간 → 같은 모양
export function addHours(at: string, hours: number) {
  const d = new Date(at + ":00");
  d.setHours(d.getHours() + hours);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

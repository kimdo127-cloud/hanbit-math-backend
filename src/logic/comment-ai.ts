// 레벨테스트 강사 코멘트 초안: 점수를 보고 AI가 한두 문장을 써 주면 강사가 고친다
// GPT_API_KEY가 있으면 OpenAI, 없거나 실패하면 규칙으로 만든 문장 (화면은 같은 방식으로 받는다)
export interface CommentInput {
  grade: string; // "중2"
  kind: string; // "정기" · "입학" · "선행"
  level: string; // 판정
  concept: number;
  type: number;
  advanced: number;
  areas: { label: string; value: number }[]; // 분야별 정답률 (중등만, 비어 있을 수 있음)
}

function ruleDraft(x: CommentInput) {
  const parts = [
    { k: "개념", r: x.concept / 40 },
    { k: "유형 문제", r: x.type / 40 },
    { k: "심화 문제", r: x.advanced / 20 },
  ].sort((a, b) => b.r - a.r);
  const strong = x.areas.length ? [...x.areas].sort((a, b) => b.value - a.value)[0].label : parts[0].k;
  const weak = x.areas.length ? [...x.areas].sort((a, b) => a.value - b.value)[0].label : parts[parts.length - 1].k;
  return `${strong}은(는) 잘 잡혀 있어요. ${weak}을(를) 조금 더 연습하면 좋아요.`;
}

export async function draftComment(x: CommentInput): Promise<{ text: string; by: "ai" | "rule" }> {
  const key = process.env.GPT_API_KEY;
  if (!key) return { text: ruleDraft(x), by: "rule" };
  const facts = [
    `${x.grade} ${x.kind} 레벨테스트, 판정 ${x.level}`,
    `개념 ${x.concept}/40, 유형 ${x.type}/40, 심화 ${x.advanced}/20`,
    ...(x.areas.length ? [`분야별 정답률: ${x.areas.map((a) => `${a.label} ${a.value}%`).join(", ")}`] : []),
  ].join("\n");
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.COMMENT_MODEL || "gpt-4o-mini",
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "너는 수학 학원 강사다. 레벨테스트 결과를 보고 학부모에게 보여 줄 코멘트를 한국어로 쓴다. 두 문장, 70자 안. 첫 문장은 잘한 점, 둘째 문장은 더 연습할 점. 점수 숫자는 다시 쓰지 않는다. 문장 끝은 반드시 '~요'로 끝내고 '~습니다'는 쓰지 않는다. 학생 이름은 쓰지 않는다. 예: 개념은 탄탄하게 잡혀 있어요. 도형 서술형 풀이를 조금 더 연습하면 좋아요.",
          },
          { role: "user", content: facts },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const out = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = out.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("empty");
    return { text, by: "ai" };
  } catch (e) {
    console.error("comment draft", (e as Error).message);
    return { text: ruleDraft(x), by: "rule" };
  }
}

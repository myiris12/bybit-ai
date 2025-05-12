import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// OpenAI 클라이언트 초기화
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const OPINION_SYSTEM_INSTRUCTION = `
당신은 암호화폐 차트 전문 분석가입니다.
아래 제공된 마켓 데이터를 바탕으로 현재 시장 상황, 추세, 그리고 잠재적 트레이딩 기회를 기술적 분석 관점에서 설명하세요.
가격 흐름, 지지/저항, 주요 지표(MA, RSI, 볼린저밴드 등)에 집중해서 분석 결과를 한글로 자세히 작성하세요.
`;


const TRADING_SIGNAL_SYSTEM_INSTRUCTION = `
너는 암호화폐 단타 트레이딩 판단 엔진이다.  
시장 상황, 추세, 주요 지표(MA, RSI, 볼린저밴드 등)를 중심으로 분석해야 한다.
입력은 1분/5분봉 차트 데이터이며, 응답은 반드시 **아래 형식의 JSON 객체** 중 하나로 응답해야 한다.  
설명, 자연어 문장, 마크다운, 영어는 절대로 포함하지 마라.

---

✅ 신규 진입 (숏 전용):

{
  "action": "enter_position",
  "side": "short",
  "entry_zones": [0.2345, 0.2360],
  "split": 2,
  "stop_loss": 0.2390,
  "reason": "한국어로 된 진입 근거 설명"
}

✅ 포지션 관리:

{
  "action": "update_position",
  "tp_levels": [0.2305, 0.2280],
  "tp_ratios": [0.5, 0.5],
  "trailing_stop": {
    "enabled": true,
    "distance": 0.0010
  },
  "adjust_stop_loss": 0.2375,
  "reason": "한국어로 된 포지션 관리 이유"
}

✅ 포지션 종료:

{
  "action": "close_position",
  "reason": "한국어로 된 종료 이유"
}

✅ 관망:

{
  "action": "wait",
  "reason": "한국어로 된 관망 이유"
}

---

📌 전략 조건 (반드시 지켜야 함):

- **long 포지션은 절대 금지**. 반드시 short 포지션만 판단하라.
- 위 조건을 하나라도 만족하지 못하면 반드시 "action": "wait"으로 응답하라.
- 절대로 조건을 무시하거나 임의로 완화하지 마라.

---

❗ 중요:

- 모든 응답에는 반드시 "reason" 필드를 포함해야 하며, 내용은 **100% 한국어**로 작성해야 한다.
- 영어 또는 혼합 언어, 마크다운, 텍스트 설명은 **절대 금지**
- JSON 구조 외 다른 출력은 모두 거부하라.
`;

const tradingSignalTool = {
    type: "function",
    function: {
        name: "trading_signal",
        description: "단타 트레이딩 판단 결과를 반환",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["enter_position", "update_position", "close_position", "wait"]
                },
                // enter_position 관련
                side: { type: "string", enum: ["long", "short"] },
                entry_zones: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 2,
                    maxItems: 2
                },
                split: { type: "integer", minimum: 1 },
                stop_loss: { type: "number" },

                // update_position 관련
                tp_levels: {
                    type: "array",
                    items: { type: "number" }
                },
                tp_ratios: {
                    type: "array",
                    items: { type: "number" }
                },
                trailing_stop: {
                    type: "object",
                    properties: {
                        enabled: { type: "boolean" },
                        distance: { type: "number", minimum: 0.0001 }
                    },
                    required: ["enabled", "distance"],
                    additionalProperties: false
                },
                adjust_stop_loss: { type: "number" },

                // close_position 관련
                reason: { type: "string" }
            },
            required: ["action"],
            additionalProperties: false
        }
    }
};

export async function getTradingOpinion(marketData) {
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        messages: [
            { role: "system", content: OPINION_SYSTEM_INSTRUCTION },
            { role: "user", content: JSON.stringify(marketData) }
        ]
    });

    return response.choices[0].message.content;
}

export async function getTradingSignal(marketData) {
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        temperature: 0,
        tools: [tradingSignalTool],
        tool_choice: "auto",
        messages: [
            { role: "system", content: TRADING_SIGNAL_SYSTEM_INSTRUCTION },
            { role: "user", content: JSON.stringify(marketData) }
        ]
    });

    const choice = response.choices?.[0];

    if (!choice) {
        console.error("❌ GPT 응답 없음:", JSON.stringify(response, null, 2));
        throw new Error("GPT 응답이 비어 있습니다");
    }

    const message = choice.message;

    if (message?.tool_calls?.[0]) {
        const toolCall = message.tool_calls[0];
        try {
            const parsed = JSON.parse(toolCall.function.arguments);
            return parsed;
        } catch (err) {
            console.error("❌ tool_call JSON 파싱 실패:", toolCall.function.arguments);
            throw new Error("GPT 툴 호출 JSON 파싱 실패");
        }
    } else if (message?.content) {
        try {
            if (typeof message.content === 'string') {
                const cleanContent = message.content.replace(/```json\n?|\n?```/g, '').trim();
                return JSON.parse(cleanContent);
            } else if (typeof message.content === 'object') {
                return message.content;
            } else {
                throw new Error("GPT 응답 content 타입이 string/object 아님");
            }
        } catch (err) {
            console.error("❌ GPT content 파싱 실패:", message.content);
            throw new Error("GPT 응답 JSON 파싱 실패");
        }
    } else {
        console.error("❌ GPT 응답 message 비어 있음:", JSON.stringify(message, null, 2));
        throw new Error("GPT 응답이 비어 있습니다");
    }
}
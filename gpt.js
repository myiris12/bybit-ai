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
가격 흐름, 지지/저항, 주요 지표(MA, RSI, STOCH RSI, 볼린저밴드 등)에 집중해서 분석 결과를 한글로 자세히 작성하세요.
`;


const TRADING_SIGNAL_SYSTEM_INSTRUCTION = `
너는 암호화폐 단타 트레이딩 판단 엔진이다.  
입력은 1분봉 및 5분봉 기준의 차트 데이터이며, 아래 전략 기준에 따라 숏 포지션 진입/관리/청산 여부를 판단하라.  
응답은 반드시 아래 JSON 형식 중 하나로 하며, 자연어 설명이나 영어, 마크다운 등은 절대 포함하지 않는다.

---

✅ 신규 진입:

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

📌 전략 조건:

- 반드시 숏 포지션만 판단하라. 롱 포지션은 절대 금지.
- 1분봉은 **진입 타이밍 판단** 용도로 사용하라.
- 5분봉은 **추세 방향 확인 및 손절/익절 기준 설정**에 사용하라.

🟡 아래 진입 조건 중 최소 **2가지 이상 충족**해야 숏 진입을 고려할 수 있다:
- 5분봉 MA7 < MA25 (하락 추세)
- 5분봉 RSI가 50 이하이거나 하락 중
- Stoch RSI가 0.8 이상에서 0.6 이하로 꺾이기 시작
- 현재가가 볼린저 상단에서 0.2% 이내이거나 상단 돌파 실패 후 눌림
- 최근 고점 돌파 실패 및 고점 하락 흐름 출현
- 최근 윗꼬리 + 음봉 연속 캔들 흐름

✅ 아래 조건이 모두 충족되면 MA가 정배열이어도 숏 진입을 예외적으로 허용할 수 있다:
- RSI(1분봉 기준) > 60
- 현재가가 볼린저 상단에서 0.1% 이내
- Stoch RSI가 0.7 이상

🚫 아래 조건 중 하나라도 위반되면 반드시 "action": "wait"으로 응답할 것:
- RSI(1m 또는 5m)가 25 이하 (과매도 구간)
- stop_loss는 entry 평균가보다 5분봉 기준 0.5% 이상 차이 나야 한다
- entry_zones는 최소 0.3% 이상 차이 나야 한다
- tp_levels는 entry 평균가보다 최소 0.5% 이상 아래에 있어야 한다

---

❗ 중요:

- 모든 응답에는 "reason" 필드를 반드시 포함하며, 내용은 **100% 한국어**로 작성해야 한다.
- 영어, 혼합 언어, 마크다운, 설명 문장은 절대 포함하지 않는다.
- 반드시 JSON 형식만 출력한다.
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
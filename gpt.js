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
  "tp_levels": [0.2305, 0.2280, 0.2260],
  "tp_ratios": [0.3, 0.3, 0.4],
  "trailing_stop": {
    "enabled": true,
    "distance": 0.0025
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
- 5분봉은 **추세 보조 지표 및 SL/TP 기준 설정**에 사용하라.

🟡 아래 진입 조건 중 **2가지 이상 충족**되면 숏 진입을 고려할 수 있다:
- MA7이 최근 3개 값 기준으로 **하락 전환됨** (예: [0.2289, 0.2287, 0.2283])
- RSI가 60 이상 (1분봉 또는 5분봉 기준)
- Stoch RSI가 0.8 이상에서 꺾이기 시작했거나 0.95 이상
- 현재가가 볼린저 밴드 상단에서 0.2% 이내에 있거나 돌파 후 눌림이 발생함
- 최근 고점 돌파 실패 또는 고점 하락 흐름이 나타남
- 최근 3개 캔들 중 2개 이상이 윗꼬리 또는 음봉

🚫 아래 조건 중 하나라도 해당되면 반드시 "action": "wait"으로 응답하라:
- RSI(1m 또는 5m) < 25 (과매도 상태)
- Stoch RSI < 0.3이면서 RSI도 45 이하
- entry_zones는 최소 **0.3% 이상** 차이가 나야 한다

📌 TP/SL 설정 규칙 (강제 적용):

- stop_loss는 entry 평균가보다 반드시 **0.7% 이상**, 가능하면 **1.0% 이상** 떨어진 위치로 설정해야 한다.
- tp_levels는 entry 평균가보다 각각 **0.8% 이상** 하단에 설정해야 하며,
  마지막 TP는 가장 깊은 목표가 되어야 한다. (예: -1.5% ~ -2.5%)
- trailing_stop.distance는 entry 평균가 기준 **1.0% 이상**으로 설정해야 한다.
- 만약 SL 또는 TP 거리가 기준보다 짧다면 "wait"을 반환하지 말고, **거리 조건을 만족하도록 값을 조정하여** 응답을 생성해야 한다.

📌 TP 분할 전략:

- 진입 시 tp_levels는 3개로 설정하고 tp_ratios는 [0.3, 0.3, 0.4]로 한다.
- tp_levels는 반드시 **점점 더 낮은 가격 순서**로 배치한다.
- update_position을 생성할 때도 동일한 구조를 유지하며,
  trailing_stop을 적극 활용하여 수익을 극대화한다.

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
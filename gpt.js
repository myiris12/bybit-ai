import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// OpenAI 클라이언트 초기화
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

const OPINION_SYSTEM_INSTRUCTION = `
당신은 암호화폐 차트 전문 분석가입니다.
아래 제공된 마켓 데이터를 바탕으로 현재 시장 상황, 추세, 그리고 잠재적 트레이딩 기회를 기술적 분석 관점에서 설명하세요.
가격 흐름, 지지/저항, 주요 지표(MA, RSI, STOCH RSI, 볼린저밴드 등)에 집중해서 분석 결과를 한글로 자세히 작성하세요.
`;

const TRADING_SIGNAL_SYSTEM_INSTRUCTION = `
당신은 암호화폐 단타 매매 전략 판단 전문가입니다.

사용자는 1분봉 및 5분봉 기준의 차트 캔들, 보조지표, 현재가 정보, 그리고 ATR 값을 포함한 JSON 데이터를 전달합니다. 이 데이터를 기반으로 현재 매매 타이밍이 롱 진입, 숏 진입, 관망 중 어느 쪽에 해당하는지 판단하십시오.

출력은 반드시 다음 형식의 JSON으로 하십시오:

{
  "action": "enter_long" | "enter_short" | "wait",
  "reason": "판단의 근거를 한국어로 간결하게 기술",
  "stop_loss": number (optional, 진입 시 필수),
  "take_profit_levels": number[] (optional, 진입 시 필수),
  "trailing_stop": number (optional, 진입 시 권장)
}

조건은 다음과 같습니다:

1. action은 enter_long, enter_short, wait 중 하나여야 합니다.
2. 판단 기준은 RSI, Stochastic RSI, MACD, Bollinger Bands, EMA 등을 1분봉/5분봉 기준으로 종합적으로 해석합니다.
3. 진입 조건이 모호하거나 지표 간 상충 신호가 존재하면 wait을 선택합니다.
4. 사용자가 제공한 "atr" 값을 기준으로 다음과 같이 stop_loss 및 take_profit_levels를 계산합니다:

   - 롱 진입일 경우:
     stop_loss = current_price - (2.0 * atr)
     take_profit_levels = [
       current_price + (2.0 * atr),
       current_price + (3.5 * atr)
     ]

   - 숏 진입일 경우:
     stop_loss = current_price + (2.0 * atr)
     take_profit_levels = [
       current_price - (2.0 * atr),
       current_price - (3.5 * atr)
     ]

5. trailing_stop은 atr의 약 50~70% 범위에서 적절히 설정합니다. (예: 1.0 * atr)

6. 기타 설명 문장이나 텍스트는 절대 출력하지 마십시오. 출력은 반드시 위 JSON 형식만 사용하십시오.
`;

const tradingSignalTool = {
	type: 'function',
	function: {
		name: 'trading_signal',
		description:
			'1분봉 및 5분봉 차트와 지표를 기반으로 롱/숏/관망 중 하나를 판단하고, 진입 시 손절가, 익절가, 트레일링 스탑을 제안한다.',
		parameters: {
			type: 'object',
			properties: {
				action: {
					type: 'string',
					description: '매매 액션: enter_long | enter_short | wait 중 하나',
					enum: ['enter_long', 'enter_short', 'wait'],
				},
				reason: {
					type: 'string',
					description: '매매 판단의 근거',
				},
				stop_loss: {
					type: 'number',
					description: '손절가 (진입 시에만 포함)',
				},
				take_profit_levels: {
					type: 'array',
					items: {
						type: 'number',
					},
					description: '익절 목표가 배열 (진입 시에만 포함)',
				},
				trailing_stop: {
					type: 'number',
					description: '트레일링 스탑 간격 (진입 시에만 포함)',
				},
			},
			required: ['action', 'reason'],
		},
	},
};

export async function getTradingOpinion(marketData) {
	const response = await openai.chat.completions.create({
		model: 'gpt-4o',
		temperature: 0,
		messages: [
			{ role: 'system', content: OPINION_SYSTEM_INSTRUCTION },
			{ role: 'user', content: JSON.stringify(marketData) },
		],
	});

	return response.choices[0].message.content;
}

export async function getTradingSignal(marketData) {
	const response = await openai.chat.completions.create({
		model: 'gpt-4o',
		temperature: 0,
		tools: [tradingSignalTool],
		tool_choice: 'auto',
		messages: [
			{ role: 'system', content: TRADING_SIGNAL_SYSTEM_INSTRUCTION },
			{ role: 'user', content: JSON.stringify(marketData) },
		],
	});

	const choice = response.choices?.[0];

	if (!choice) {
		console.error('❌ GPT 응답 없음:', JSON.stringify(response, null, 2));
		throw new Error('GPT 응답이 비어 있습니다');
	}

	const message = choice.message;

	if (message?.tool_calls?.[0]) {
		const toolCall = message.tool_calls[0];
		try {
			const parsed = JSON.parse(toolCall.function.arguments);
			return parsed;
		} catch (err) {
			console.error('❌ tool_call JSON 파싱 실패:', toolCall.function.arguments);
			throw new Error('GPT 툴 호출 JSON 파싱 실패');
		}
	} else if (message?.content) {
		try {
			if (typeof message.content === 'string') {
				const cleanContent = message.content.replace(/```json\n?|\n?```/g, '').trim();
				return JSON.parse(cleanContent);
			} else if (typeof message.content === 'object') {
				return message.content;
			} else {
				throw new Error('GPT 응답 content 타입이 string/object 아님');
			}
		} catch (err) {
			console.error('❌ GPT content 파싱 실패:', message.content);
			throw new Error('GPT 응답 JSON 파싱 실패');
		}
	} else {
		console.error('❌ GPT 응답 message 비어 있음:', JSON.stringify(message, null, 2));
		throw new Error('GPT 응답이 비어 있습니다');
	}
}

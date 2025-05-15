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

2. 진입 조건은 다음과 같습니다 (롱 기준):

   - 1분봉 기준:
     - RSI가 50 이상이며 최근 3개 값이 상승 중
     - 현재 종가가 EMA(9)보다 높음
     - 볼린저 밴드 중심선을 돌파했거나 상단 근처에 위치
   - 5분봉 기준:
     - MACD 히스토그램이 양수이며 최근 2개 값이 증가 중
     - RSI > 55
     - 볼린저 밴드 폭이 평균 이상이며 확장 중
     - 거래량이 최근 20봉 평균 이상

   위 조건을 모두 충족할 경우에만 진입하십시오. 반대 방향인 숏 진입 시 조건은 반대로 적용하십시오.

3. 횡보장 회피 조건:
   - 5분봉 볼린저 밴드 폭이 평균보다 작거나
   - 최근 3개 1분봉이 동일 가격대에서 횡보 중이면 진입하지 마십시오.

4. 손절가는 다음과 같이 계산합니다:

   - ATR 값이 0.003 이상인 경우 → stop_loss = entry_price x 0.985
   - ATR 값이 0.003 미만인 경우 → stop_loss = entry_price - (2.0 x ATR)

5. 익절가는 다음과 같이 설정합니다:

   - TP1 = entry_price + (3.2 x ATR)
   - TP2 = entry_price + (5.5 x ATR)
   - 숏일 경우는 반대로 계산하십시오.

6. TP1 도달 시 전체 물량의 60%를 청산한다고 가정하고,
   남은 40%에 대해 trailing_stop을 활성화합니다:
   - trailing_stop = 0.9 x ATR

7. 기타 설명 문장이나 텍스트는 절대 출력하지 마십시오. 출력은 반드시 위 JSON 형식만 사용하십시오.
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

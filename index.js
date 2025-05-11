import { RestClientV5 } from 'bybit-api';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

// Rate limiting 설정
const RATE_LIMIT = {
    tokensPerMinute: 30000,
    requestsPerMinute: 60,
    retryDelay: 5000, // 5초
    maxRetries: 3
};

// Rate limiting을 위한 토큰 카운터
let tokenCount = 0;
let lastResetTime = Date.now();

// 토큰 카운터 리셋 함수
function resetTokenCounter() {
    const now = Date.now();
    if (now - lastResetTime >= 60000) { // 1분마다 리셋
        tokenCount = 0;
        lastResetTime = now;
    }
}

// 토큰 사용량 체크 함수
function checkTokenLimit(estimatedTokens) {
    resetTokenCounter();
    if (tokenCount + estimatedTokens > RATE_LIMIT.tokensPerMinute) {
        const waitTime = 60000 - (Date.now() - lastResetTime);
        if (waitTime > 0) {
            throw new Error(`Rate limit reached. Please wait ${Math.ceil(waitTime / 1000)} seconds.`);
        }
    }
    tokenCount += estimatedTokens;
}

// 재시도 로직이 포함된 API 호출 함수
async function callWithRetry(fn, retries = RATE_LIMIT.maxRetries) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error.message.includes('Rate limit') && i < retries - 1) {
                console.log(`Rate limit reached. Retrying in ${RATE_LIMIT.retryDelay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, RATE_LIMIT.retryDelay));
                continue;
            }
            throw error;
        }
    }
}

// Web Crypto API polyfill for Node.js
if (!global.crypto) {
    global.crypto = crypto;
}
if (!global.crypto.subtle) {
    global.crypto.subtle = crypto.webcrypto.subtle;
}

// Bybit API 클라이언트 초기화
const client = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    testnet: false // 실제 거래소 사용
});

// OpenAI 클라이언트 초기화
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});


const SYSTEM_INSTRUCTION = `
너는 암호화폐 단타 트레이딩 판단 엔진이다.
입력은 1분/5분봉 차트 데이터이며, 결과는 반드시 JSON 객체로 응답해야 한다.

응답 형식은 다음 네 가지 중 하나이며, 설명은 절대 포함하지 않는다:

✅ 신규 진입:
{
  "action": "enter_position",
  "side": "long",
  "entry_zones": [0.2345, 0.2352],
  "split": 2,
  "leverage": 10,
  "stop_loss": 0.2320,
  "reason": "한국어로 된 진입 근거 설명"
}

✅ 포지션 관리:
{
  "action": "update_position",
  "tp_levels": [0.2375, 0.2390],
  "tp_ratios": [0.5, 0.5],
  "trailing_stop": {
    "enabled": true,
    "distance": 0.0012
  },
  "adjust_stop_loss": 0.2335,
  "reason": "한국어로 된 관리 근거 설명"
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

❗ 전략 조건:
- 절대로 long 포지션은 진입하지 마라.
- 반드시 short 포지션만 고려하여 판단하라.
- GPT는 long 포지션을 제안하면 안 된다.

❗ 중요:
- 모든 응답에는 "reason" 필드를 반드시 포함해야 하며, 그 내용은 반드시 **한국어**로 작성해야 한다.
- 영어 또는 혼합 언어는 절대 금지한다.
- 자연어, 설명, 마크다운 없이 순수 JSON 객체만 응답하라.
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
                leverage: { type: "integer", minimum: 1 },
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

async function getMarketData(symbol) {
    try {
        // 1분봉 데이터 가져오기
        const kline1m = await client.getKline({
            category: 'linear',
            symbol: symbol,
            interval: '1',
            limit: 50
        });

        // 5분봉 데이터 가져오기
        const kline5m = await client.getKline({
            category: 'linear',
            symbol: symbol,
            interval: '5',
            limit: 50
        });

        // 포지션 정보 가져오기
        const positionResponse = await client.getPositionInfo({
            category: 'linear',
            symbol: symbol
        });

        // 1분봉 응답 데이터 가공
        const candles1m = kline1m.result.list.map(candle => ({
            timestamp: parseInt(candle[0]),
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5]),
            turnover: parseFloat(candle[6])
        }));

        // 5분봉 응답 데이터 가공
        const candles5m = kline5m.result.list.map(candle => ({
            timestamp: parseInt(candle[0]),
            open: parseFloat(candle[1]),
            high: parseFloat(candle[2]),
            low: parseFloat(candle[3]),
            close: parseFloat(candle[4]),
            volume: parseFloat(candle[5]),
            turnover: parseFloat(candle[6])
        }));

        // position 데이터 가공
        let position = positionResponse.result.list.find(p => p.symbol === symbol) || null;
        const leverage = parseInt(position.leverage);
        if (position && position.size != '0') {
            position = {
                side: position.side === 'Buy' ? 'long' : 'short',
                entry_price: parseFloat(position.avgPrice),
                size_usd: parseFloat(position.positionValue),
                size_coin: parseFloat(position.size),
                stop_loss: parseFloat(position.stopLoss),
                trailing_stop: parseFloat(position.trailingStop)
            }
        } else {
            position = null;
        }

        return {
            symbol,
            leverage,
            candles_1m: candles1m,
            candles_5m: candles5m,
            position
        };
    } catch (error) {
        console.error('Error fetching market data:', error);
        throw error;
    }
}

// 🧠 GPT 판단 실행 함수
async function getTradingSignal(marketData) {
    // 대략적인 토큰 사용량 추정 (실제로는 더 정확한 계산 필요)
    const estimatedTokens = 1000;
    checkTokenLimit(estimatedTokens);

    return await callWithRetry(async () => {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            temperature: 0,
            tools: [tradingSignalTool],
            tool_choice: "auto",
            messages: [
                { role: "system", content: SYSTEM_INSTRUCTION },
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
    });
}

async function placeBybitOrder(signal, symbol, capitalUSD) {
    if (signal.action !== 'enter_position') {
        console.log('❌ 진입 시그널이 아님, 주문 생략');
        return;
    }

    if (signal.action === 'enter_position' && signal.side == 'long') {
        console.log(`🚫 [${symbol}] long 포지션 무시됨`);
        return;
    }

    const side = signal.side === 'long' ? 'Buy' : 'Sell';
    const entryPrices = signal.entry_zones;
    const numOrders = signal.split;
    const perCapital = capitalUSD / numOrders;

    console.log(`�� ${numOrders}건 분할 주문 시작 (총 자본: ${capitalUSD} USDT)`);

    // 1. 레버리지 설정
    try {
        await client.setLeverage({
            category: 'linear',
            symbol,
            buyLeverage: String(signal.leverage),
            sellLeverage: String(signal.leverage)
        });
        console.log('✅ 레버리지 설정 완료');
    } catch (e) {
        console.error('❌ 레버리지 설정 실패:', e.message || e);
        return;
    }

    // 2. 분할 주문
    for (let i = 0; i < numOrders; i++) {
        const price = entryPrices[i] || entryPrices[entryPrices.length - 1];
        const rawQty = (perCapital * signal.leverage) / price;
        const qty = Math.floor(rawQty / 10) * 10;

        const orderParams = {
            category: 'linear',
            symbol,
            side,
            orderType: 'Limit',
            qty: qty.toFixed(4),
            price: price.toFixed(4),
            timeInForce: 'GTC',
            reduceOnly: false,
            orderLinkId: `gpt-signal-${Date.now()}-${i}`
        };

        // ✅ SL만 설정
        if (signal.stop_loss) {
            orderParams.stopLoss = signal.stop_loss.toFixed(4);
        }

        console.log(`📦 주문 ${i + 1}/${numOrders} 파라미터:`, orderParams);

        try {
            const res = await client.submitOrder(orderParams);
            if (res.retCode === 0) {
                console.log(`✅ 주문 ${i + 1} 성공:`, res.result.orderId);
            } else {
                console.error(`❌ 주문 ${i + 1} 실패:`, res.retMsg);
            }
        } catch (e) {
            console.error(`❌ 주문 ${i + 1} 예외 발생:`, e.message || e);
        }
    }
}

async function updateBybitPosition(signal, symbol) {
    if (signal.action !== 'update_position') {
        console.log('❌ update_position이 아닌 응답입니다.');
        return;
    }

    const position = await client.getPositionInfo({ category: 'linear', symbol });
    const pos = position.result.list.find(p => p.symbol === symbol);

    if (!pos || pos.size === '0') {
        console.log('❌ 현재 포지션 없음, TP/SL 설정 생략');
        return;
    }

    const side = pos.side === 'Buy' ? 'long' : 'short';
    const qty = parseFloat(pos.size);

    // 1. 익절 주문 분할 등록
    if (signal.tp_levels && signal.tp_ratios) {
        for (let i = 0; i < signal.tp_levels.length; i++) {
            const tpPrice = signal.tp_levels[i];
            const ratio = signal.tp_ratios[i];
            const tpQty = Math.floor((qty * ratio) / 10) * 10;

            // 최소 주문 수량 체크 (MOVE의 경우 1)
            if (tpQty < 1) {
                console.log(`⚠️ TP 주문 ${i + 1} 건너뜀: 수량이 너무 작음 (${tpQty})`);
                continue;
            }

            const tpOrder = {
                category: 'linear',
                symbol,
                side: side === 'long' ? 'Sell' : 'Buy',
                orderType: 'Limit',
                price: tpPrice.toFixed(4),
                qty: tpQty.toFixed(4),
                timeInForce: 'GTC',
                reduceOnly: true,
                orderLinkId: `tp-${Date.now()}-${i}`
            };

            try {
                const res = await client.submitOrder(tpOrder);
                if (res.retCode === 0) {
                    console.log(`✅ TP 주문 ${i + 1} 등록 완료 (수량: ${tpQty})`);
                } else {
                    console.error(`❌ TP 주문 실패:`, res.retMsg);
                }
            } catch (e) {
                console.error(`❌ TP 예외 발생:`, e.message || e);
            }
        }
    }

    // 2. 트레일링 스탑 설정
    if (signal.trailing_stop && signal.trailing_stop.enabled) {
        try {
            await client.setTradingStop({
                category: 'linear',
                symbol,
                trailingStop: signal.trailing_stop.distance.toFixed(4)
            });
            console.log('✅ 트레일링 스탑 설정 완료');
        } catch (e) {
            console.error('❌ 트레일링 스탑 설정 실패:', e.message || e);
        }
    }

    // 3. 손절값 조정
    if (signal.adjust_stop_loss) {
        try {
            await client.setTradingStop({
                category: 'linear',
                symbol,
                stopLoss: signal.adjust_stop_loss.toFixed(4)
            });
            console.log('✅ 손절값 조정 완료');
        } catch (e) {
            console.error('❌ 손절값 조정 실패:', e.message || e);
        }
    }
}

async function cancelAllOpenOrders(symbol) {
    try {
        const res = await client.cancelAllOrders({ category: 'linear', symbol });
        console.log('🚫 기존 주문 전부 취소 완료');
    } catch (e) {
        console.error('❌ 주문 일괄 취소 실패:', e.message || e);
    }
}

async function cancelOrdersIfNoPosition(symbol) {
    const posRes = await client.getPositionInfo({ category: 'linear', symbol });
    const pos = posRes.result.list.find(p => p.symbol === symbol);
    if (!pos || pos.size === '0') {
        await cancelAllOpenOrders(symbol);
        console.log('✅ 포지션 없음 → 관련 주문 자동 취소 완료');
    }
}

async function cancelUnfilledOrdersAfterTimeout(symbol, timeoutMs = 3 * 60 * 1000) {
    console.log(`⏱ ${timeoutMs / 1000}초 안에 미체결되면 주문 자동 취소 예정`);

    setTimeout(async () => {
        try {
            const res = await client.getActiveOrders({
                category: 'linear',
                symbol: symbol
            });
            const open = res.result.list || [];
            if (open.length > 0) {
                await cancelAllOpenOrders(symbol);
                console.log('⏰ 미체결 주문 자동 취소 완료');
            } else {
                console.log('✅ 모든 주문 체결 완료 – 자동 취소 생략');
            }
        } catch (e) {
            console.error('❌ 미체결 주문 체크 실패:', e.message || e);
        }
    }, timeoutMs);
}

async function cancelOpenTPOrders(symbol) {
    try {
        const res = await client.getActiveOrders({
            category: 'linear',
            symbol: symbol
        });
        const openOrders = res.result.list || [];

        for (const order of openOrders) {
            if (order.reduceOnly) {
                await client.cancelOrder({
                    category: 'linear',
                    symbol: symbol,
                    orderId: order.orderId
                });
                console.log(`🗑 기존 TP 주문 취소: ${order.orderId} (${order.price})`);
            }
        }
    } catch (e) {
        console.error('❌ TP 주문 취소 중 오류 발생:', e.message || e);
    }
}

async function closeBybitPosition(signal, symbol) {
    try {
        // 1. 현재 포지션 확인
        const res = await client.getPositionInfo({ category: 'linear', symbol });
        const pos = res.result.list.find(p => p.symbol === symbol);

        if (!pos || pos.size === '0') {
            console.log('❌ 닫을 포지션 없음 – 이미 청산된 상태');
            return;
        }

        const side = pos.side === 'Buy' ? 'Sell' : 'Buy'; // 반대 주문
        const qty = parseFloat(pos.size);

        const order = {
            category: 'linear',
            symbol,
            side,
            orderType: 'Market',
            qty: qty.toFixed(4),
            reduceOnly: true,
            timeInForce: 'IOC',
            orderLinkId: `close-${Date.now()}`
        };

        const result = await client.submitOrder(order);

        if (result.retCode === 0) {
            console.log(`✅ 포지션 청산 완료 (${side} ${qty})`);
        } else {
            console.error(`❌ 포지션 청산 실패:`, result.retMsg);
        }
    } catch (e) {
        console.error('❌ close_position 중 예외 발생:', e.message || e);
    }
}


// 실행
async function main(symbol) {
    try {
        console.log(`🚀 Start Trading Signal: ${symbol}`);
        const marketData = await getMarketData(symbol);
        const tradingSignal = await getTradingSignal(marketData);
        console.log('Trading Signal:', tradingSignal);
        switch (tradingSignal.action) {
            case 'enter_position':
                await cancelAllOpenOrders(symbol);
                await placeBybitOrder(tradingSignal, symbol, 10);
                cancelUnfilledOrdersAfterTimeout(symbol, 1000 * 60 * 3); // 체결 안 되면 3분 후 정리
                break;
            case 'update_position':
                await cancelOpenTPOrders(symbol);
                await updateBybitPosition(tradingSignal, symbol);
                break;
            case 'close_position':
                await cancelAllOpenOrders(symbol);
                await closeBybitPosition(tradingSignal, symbol);
                break;
            case 'wait':
                console.log('🔄 관망 상태');
                break;
        }
    } catch (error) {
        console.error('Failed to fetch or analyze data:', error);
    }
}

// 심볼 목록 (확장 가능)
const symbols = [
    'MOVEUSDT',
    'XAIUSDT',
    'PYTHUSDT',
    'EOSUSDT',
    'BERAUSDT',
];

// 반복 간격 (ms)
const INTERVAL_MS = 30 * 1000;

// 루프 함수
async function runMainWithLimit() {
    console.log(`🔁 트레이딩 사이클 시작: ${new Date().toLocaleTimeString()}`);

    try {
        // 심볼을 순차적으로 처리
        for (const symbol of symbols) {
            try {
                console.log(`\n📊 ${symbol} 처리 시작`);
                await main(symbol);
                console.log(`✅ ${symbol} 처리 완료`);

                // 마지막 심볼이 아닌 경우에만 대기
                if (symbol !== symbols[symbols.length - 1]) {
                    console.log(`⏳ 다음 심볼 처리까지 10초 대기...`);
                    await new Promise(resolve => setTimeout(resolve, 10000));
                }
            } catch (err) {
                console.error(`❌ [${symbol}] 처리 실패:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ 루프 전체 실패:', err.message);
    } finally {
        // 모든 심볼 처리 후 다음 사이클까지 대기
        console.log(`\n⏳ 다음 트레이딩 사이클까지 ${INTERVAL_MS / 1000}초 대기...`);
        setTimeout(runMainWithLimit, INTERVAL_MS);
    }
}

// 시작
runMainWithLimit();
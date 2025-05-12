import { RestClientV5 } from 'bybit-api';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { calculateMA, calculateRSI, calculateBollingerBands, calculateStochRSI } from './calc.js';

// Web Crypto API polyfill
if (typeof global.crypto === 'undefined') {
    global.crypto = crypto;
}

dotenv.config();

// Bybit API 클라이언트 초기화
const client = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    testnet: false // 실제 거래소 사용
});

export async function getMarketData(symbol) {
    try {
        // 1분봉, 5분봉 데이터 가져오기
        const candles1m = await getCandles(symbol, '1', 100);
        const candles5m = await getCandles(symbol, '5', 100);

        // 포지션 정보 가져오기
        const position = await getPosition(symbol);

        // 가격 데이터 추출
        const prices1m = candles1m.map(c => c.close);
        const prices5m = candles5m.map(c => c.close);

        const result = {
            symbol,
            timeframes: {
                '1m': {
                    'ohlcv': candles1m,
                    'ma_series': {
                        'ma7': calculateMA(prices1m, 7),
                        'ma25': calculateMA(prices1m, 25),
                    },
                    'rsi14': calculateRSI(prices1m, 14),
                    'stoch_rsi': calculateStochRSI(prices1m, 14),
                    'bollinger': calculateBollingerBands(prices1m)
                },
                '5m': {
                    'ohlcv': candles5m,
                    'ma_series': {
                        'ma7': calculateMA(prices5m, 7),
                        'ma25': calculateMA(prices5m, 25),
                    },
                    'rsi14': calculateRSI(prices5m, 14),
                    'stoch_rsi': calculateStochRSI(prices5m, 14),
                    'bollinger': calculateBollingerBands(prices5m)
                }
            },
            price_info: {
                current_price: candles1m[candles1m.length - 1].close,
            },
            position
        };

        // snapshot 추가
        result.snapshot = {
            '1m': {
                'ma': {
                    'ma7': result.timeframes['1m'].ma_series.ma7[result.timeframes['1m'].ma_series.ma7.length - 1],
                    'ma25': result.timeframes['1m'].ma_series.ma25[result.timeframes['1m'].ma_series.ma25.length - 1],
                },
                'rsi14': result.timeframes['1m'].rsi14[result.timeframes['1m'].rsi14.length - 1],
                'stoch_rsi': result.timeframes['1m'].stoch_rsi[result.timeframes['1m'].stoch_rsi.length - 1],
                'bollinger': {
                    'upper': result.timeframes['1m'].bollinger.upper[result.timeframes['1m'].bollinger.upper.length - 1],
                    'middle': result.timeframes['1m'].bollinger.middle[result.timeframes['1m'].bollinger.middle.length - 1],
                    'lower': result.timeframes['1m'].bollinger.lower[result.timeframes['1m'].bollinger.lower.length - 1],
                },
                price: result.timeframes['1m'].ohlcv[result.timeframes['1m'].ohlcv.length - 1].close,
            },
            '5m': {
                'ma': {
                    'ma7': result.timeframes['5m'].ma_series.ma7[result.timeframes['5m'].ma_series.ma7.length - 1],
                    'ma25': result.timeframes['5m'].ma_series.ma25[result.timeframes['5m'].ma_series.ma25.length - 1],
                },
                'rsi14': result.timeframes['5m'].rsi14[result.timeframes['5m'].rsi14.length - 1],
                'bollinger': {
                    'upper': result.timeframes['5m'].bollinger.upper[result.timeframes['5m'].bollinger.upper.length - 1],
                    'middle': result.timeframes['5m'].bollinger.middle[result.timeframes['5m'].bollinger.middle.length - 1],
                    'lower': result.timeframes['5m'].bollinger.lower[result.timeframes['5m'].bollinger.lower.length - 1],
                },
                price: result.timeframes['5m'].ohlcv[result.timeframes['5m'].ohlcv.length - 1].close,
            }
        }
        return result;
    } catch (error) {
        console.error('Error fetching market data:', error);
        throw error;
    }
}

// 주문 및 레버리지 설정
export async function placeBybitOrder(signal, symbol, capitalUSD, leverage) {
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

    console.log(`${numOrders}건 분할 주문 시작 (총 자본: ${capitalUSD} USDT)`);

    // 1. 레버리지 설정
    try {
        await client.setLeverage({
            category: 'linear',
            symbol,
            buyLeverage: String(leverage),
            sellLeverage: String(leverage)
        });
        console.log('✅ 레버리지 설정 완료');
    } catch (e) {
        console.error('❌ 레버리지 설정 실패:', e.message || e);
        return;
    }

    // 2. 분할 주문
    for (let i = 0; i < numOrders; i++) {
        const price = entryPrices[i] || entryPrices[entryPrices.length - 1];
        const rawQty = (perCapital * leverage) / price;
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

// 포지션 업데이트
export async function updateBybitPosition(signal, symbol) {
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

// 포지션 청산
export async function closeBybitPosition(signal, symbol) {
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

// 기존 주문 전부 취소
export async function cancelAllOpenOrders(symbol) {
    try {
        await client.cancelAllOrders({ category: 'linear', symbol });
        console.log('🚫 기존 주문 전부 취소 완료');
    } catch (e) {
        console.error('❌ 주문 일괄 취소 실패:', e.message || e);
    }
}

// TP 주문 취소
export async function cancelOpenTPOrders(symbol) {
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

// 미체결 주문 자동 취소
export async function cancelUnfilledOrdersAfterTimeout(symbol, timeoutMs = 3 * 60 * 1000) {
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

async function getCandles(symbol, interval, limit) {
    const klineResponse = await client.getKline({
        category: 'linear',
        symbol: symbol,
        interval: interval,
        limit: 50
    });

    // 응답 데이터 가공
    const candles = klineResponse.result.list.map(candle => ({
        timestamp: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        turnover: parseFloat(candle[6])
    })).reverse(); // 최신 데이터가 맨 뒤로 오도록 reverse

    return candles;
}

async function getPosition(symbol) {
    const positionResponse = await client.getPositionInfo({
        category: 'linear',
        symbol: symbol
    });

    // position 데이터 가공
    let position = positionResponse.result.list.find(p => p.symbol === symbol) || null;
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

    return position;
}

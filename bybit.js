import { RestClientV5 } from 'bybit-api';
import dotenv from 'dotenv';
import crypto from 'crypto';
import {
	calculateRSI,
	calculateBollingerBands,
	calculateStochRSI,
	calculateMACD,
	calculateEMA,
	calculateATR,
} from './calc.js';

// Web Crypto API polyfill
if (typeof global.crypto === 'undefined') {
	global.crypto = crypto;
}

dotenv.config();

// Bybit API 클라이언트 초기화
const client = new RestClientV5({
	key: process.env.BYBIT_API_KEY,
	secret: process.env.BYBIT_API_SECRET,
	testnet: false, // 실제 거래소 사용
});

export async function getMarketData(symbol) {
	try {
		// 1분봉, 5분봉 데이터 가져오기
		const candles1m = await getCandles(symbol, '1', 75);
		const candles5m = await getCandles(symbol, '5', 75);

		// 포지션 정보 가져오기
		const position = await getPosition(symbol);

		// 가격 데이터 추출
		const prices1m = candles1m.map((c) => c.close);
		const prices5m = candles5m.map((c) => c.close);

		const result = {
			symbol,
			time: new Date().toISOString(),
			candles: {
				'1m': candles1m,
				'5m': candles5m,
			},
			indicators: {
				'1m': {
					rsi: calculateRSI(prices1m, 14),
					stoch_rsi: calculateStochRSI(prices1m, 14),
					bollinger: calculateBollingerBands(prices1m),
					macd: calculateMACD(prices1m),
					ema: calculateEMA(prices1m),
					current_price: candles1m[candles1m.length - 1].close,
				},
				'5m': {
					rsi: calculateRSI(prices5m, 14),
					stoch_rsi: calculateStochRSI(prices5m, 14),
					bollinger: calculateBollingerBands(prices5m),
					macd: calculateMACD(prices5m),
					ema: calculateEMA(prices5m),
					current_price: candles5m[candles5m.length - 1].close,
				},
			},
			atr: calculateATR(candles5m),
			position,
		};
		return result;
	} catch (error) {
		console.error('Error fetching market data:', error);
		throw error;
	}
}

// 주문 및 레버리지 설정
export async function placeBybitOrder(signal, symbol, side, capitalUSD, leverage) {
	// 1. 레버리지 설정
	try {
		await client.setLeverage({
			category: 'linear',
			symbol,
			buyLeverage: String(leverage),
			sellLeverage: String(leverage),
		});
		console.log('✅ 레버리지 설정 완료');
	} catch (e) {
		console.error('❌ 레버리지 설정 실패:', e.message || e);
		return;
	}

	// 2. 현재 가격 조회
	const ticker = await client.getTickers({
		category: 'linear',
		symbol: symbol,
	});

	const currentPrice = parseFloat(ticker.result.list[0].lastPrice);
	const rawQty = (capitalUSD * leverage) / currentPrice;
	const qty = Math.floor(rawQty / 10) * 10;

	// 4. 주문 정보 확인
	const orderParams = {
		category: 'linear',
		symbol,
		side,
		orderType: 'Market',
		qty: qty.toFixed(4),
		timeInForce: 'IOC',
		reduceOnly: false,
		orderLinkId: `gpt-signal-${Date.now()}`,
	};

	// 5. SL 설정
	if (signal.stop_loss) {
		// SL 가격은 현재 가격의 2.5% 이상 차이가 나지 않도록 한다.
		let stopLossPrice = getRestrictedPrice(signal.stop_loss, currentPrice, side, 0.025);
		orderParams.stopLoss = stopLossPrice.toFixed(6);
	}

	// 6. TP2 설정
	// TP 가격은 2개만 들어온다고 가정함
	if (signal.take_profit_levels && signal.take_profit_levels.length > 1) {
		// TP2 가격은 현재 가격의 10% 이상 차이가 나지 않도록 한다.
		let takeProfit2Price = getRestrictedPrice(
			signal.take_profit_levels[1],
			currentPrice,
			side === 'Sell' ? 'Buy' : 'Sell',
			0.1
		);
		orderParams.takeProfit = takeProfit2Price.toFixed(6);
	}

	console.log(`📦 주문 파라미터:`, orderParams);

	try {
		const res = await client.submitOrder(orderParams);
		if (res.retCode === 0) {
			console.log(`✅ 주문 성공:`, res.result.orderId);
		} else {
			console.error(`❌ 주문 실패:`, res.retMsg);
		}
	} catch (e) {
		console.error(`❌ 주문 예외 발생:`, e.message || e);
	}

	// 7. TP1 주문 추가, 마지막 TP2 가격은 limit 말고 take profit 으로 주문 넣을 때 설정함
	// TP 가격은 2개만 들어온다고 가정함
	if (signal.take_profit_levels) {
		// TP1 가격은 현재 가격의 5% 이상 차이가 나지 않도록 한다.
		let takeProfit1Price = getRestrictedPrice(
			signal.take_profit_levels[0],
			currentPrice,
			side === 'Sell' ? 'Buy' : 'Sell',
			0.05
		);

		const ratio = 0.6;
		const tpQty = Math.floor((qty * ratio) / 10) * 10;

		const tpOrder = {
			category: 'linear',
			symbol,
			side: side === 'Sell' ? 'Buy' : 'Sell',
			orderType: 'Limit',
			price: takeProfit1Price.toFixed(6),
			qty: tpQty.toFixed(4),
			timeInForce: 'GTC',
			reduceOnly: true,
			orderLinkId: `tp-${Date.now()}`,
		};

		try {
			const res = await client.submitOrder(tpOrder);
			if (res.retCode === 0) {
				console.log(`✅ TP 주문 등록 완료 (수량: ${tpQty})`);
			} else {
				console.error(`❌ TP 주문 실패:`, res.retMsg);
			}
		} catch (e) {
			console.error(`❌ TP 예외 발생:`, e.message || e);
		}

		// 트레일링 스탑 설정
		if (signal.trailing_stop) {
			try {
				await client.setTradingStop({
					category: 'linear',
					symbol,
					trailingStop: signal.trailing_stop.toFixed(6),
					activePrice: takeProfit1Price.toFixed(6),
				});
				console.log('✅ 트레일링 스탑 설정 완료 (활성화 가격: ' + takeProfit1Price.toFixed(6) + ')');
			} catch (e) {
				console.error('❌ 트레일링 스탑 설정 실패:', e.message || e);
			}
		}
	}
}

function getRestrictedPrice(price, currentPrice, side, maxPriceChange) {
	let restrictedPrice = price;
	if (side === 'Sell' && restrictedPrice > currentPrice * (1 + maxPriceChange)) {
		restrictedPrice = currentPrice * (1 + maxPriceChange);
	}
	if (side === 'Buy' && restrictedPrice < currentPrice * (1 - maxPriceChange)) {
		restrictedPrice = currentPrice * (1 - maxPriceChange);
	}
	return restrictedPrice;
}

// [deprecated] 포지션 업데이트
export async function updateBybitPosition(signal, symbol) {
	if (signal.action !== 'update_position') {
		console.log('❌ update_position이 아닌 응답입니다.');
		return;
	}

	const position = await client.getPositionInfo({ category: 'linear', symbol });
	const pos = position.result.list.find((p) => p.symbol === symbol);

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
				orderLinkId: `tp-${Date.now()}-${i}`,
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
				trailingStop: signal.trailing_stop.distance.toFixed(4),
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
				stopLoss: signal.adjust_stop_loss.toFixed(4),
			});
			console.log('✅ 손절값 조정 완료');
		} catch (e) {
			console.error('❌ 손절값 조정 실패:', e.message || e);
		}
	}
}

// [deprecated]포지션 청산
export async function closeBybitPosition(signal, symbol) {
	try {
		// 1. 현재 포지션 확인
		const res = await client.getPositionInfo({ category: 'linear', symbol });
		const pos = res.result.list.find((p) => p.symbol === symbol);

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
			orderLinkId: `close-${Date.now()}`,
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
			symbol: symbol,
		});
		const openOrders = res.result.list || [];

		for (const order of openOrders) {
			if (order.reduceOnly) {
				await client.cancelOrder({
					category: 'linear',
					symbol: symbol,
					orderId: order.orderId,
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
				symbol: symbol,
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

// 현재 내 포지션 전체 로그
export async function getPositionsLog() {
	let resultStr = '';

	try {
		const response = await client.getPositionInfo({
			category: 'linear',
			settleCoin: 'USDT',
		});

		if (response.retCode === 0) {
			const positions = response.result.list;

			if (positions.length === 0) {
				return;
			}
			let totalPnl = 0;
			positions.forEach((position) => {
				if (parseFloat(position.size) > 0) {
					let profit = ((position.unrealisedPnl / position.positionValue) * 100).toFixed(1);
					if (profit > 0) {
						profit = '+' + profit;
					}

					const logStr = `${position.unrealisedPnl < 0 ? '🔴' : '🟢'} (${
						position.leverage
					}x) ${position.symbol.replace('USDT', '')} ${parseInt(
						position.positionValue
					).toLocaleString()}$ [P&L] ${Number(position.unrealisedPnl).toFixed(2).padStart(8)} (${profit}%)\n`;
					resultStr += logStr;

					totalPnl += Number(position.unrealisedPnl);
				}
			});

			const logStr = `\n총 포지션 P&L: ${totalPnl.toFixed(2)}$\n`;
			resultStr += logStr;
		} else {
			console.error('에러:', response.retMsg);
		}
	} catch (error) {
		console.error('API 호출 중 에러 발생:', error.message);
	}

	if (resultStr === '') {
		return '🟢 현재 포지션 없음';
	}
	return resultStr;
}

// 심볼 하나 정보 얻기
export async function getSymbolInfo(symbol) {
	const ticker = await client.getTickers({
		category: 'linear',
		symbol: symbol,
	});

	return ticker;
}

// USDT 잔고 확인
export async function getUSDTBalance() {
	try {
		const balance = await client.getWalletBalance({
			accountType: 'UNIFIED',
			coin: 'USDT',
		});

		if (balance.retCode === 0 && balance.result?.list?.[0]) {
			return balance.result.list[0].totalEquity;
		}
		throw new Error('잔고 조회 실패');
	} catch (error) {
		console.error('USDT 잔고 조회 중 오류:', error.message);
		throw error;
	}
}

async function getCandles(symbol, interval, limit) {
	const klineResponse = await client.getKline({
		category: 'linear',
		symbol: symbol,
		interval: interval,
		limit: limit,
	});

	// 응답 데이터 가공
	const candles = klineResponse.result.list
		.map((candle) => ({
			timestamp: parseInt(candle[0]),
			open: parseFloat(candle[1]),
			high: parseFloat(candle[2]),
			low: parseFloat(candle[3]),
			close: parseFloat(candle[4]),
			volume: parseFloat(candle[5]),
		}))
		.reverse(); // 최신 데이터가 맨 뒤로 오도록 reverse

	return candles;
}

async function getPosition(symbol) {
	const positionResponse = await client.getPositionInfo({
		category: 'linear',
		symbol: symbol,
	});

	// position 데이터 가공
	let position = positionResponse.result.list.find((p) => p.symbol === symbol) || null;
	if (position && position.size != '0') {
		position = {
			side: position.side === 'Buy' ? 'long' : 'short',
			entry_price: parseFloat(position.avgPrice),
			size_usd: parseFloat(position.positionValue),
			size_coin: parseFloat(position.size),
			stop_loss: parseFloat(position.stopLoss),
			trailing_stop: parseFloat(position.trailingStop),
		};
	} else {
		position = null;
	}

	return position;
}

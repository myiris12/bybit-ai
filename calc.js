// 기술적 지표 계산 함수들
export function calculateMA(prices, period) {
	const ma = [];
	for (let i = 0; i < prices.length; i++) {
		if (i < period - 1) {
			ma.push(null);
			continue;
		}
		const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
		ma.push(sum / period);
	}
	return ma;
}

export function calculateRSI(prices, period = 14, lastN = 3) {
	if (prices.length < period + 1) {
		return null;
	}

	const rsiValues = [];
	let gains = 0;
	let losses = 0;

	// 초기 평균 계산
	for (let i = 1; i <= period; i++) {
		const diff = prices[i] - prices[i - 1];
		if (diff >= 0) {
			gains += diff;
		} else {
			losses -= diff;
		}
	}

	let avgGain = gains / period;
	let avgLoss = losses / period;

	// 나머지 기간에 대한 계산
	for (let i = period + 1; i < prices.length; i++) {
		const diff = prices[i] - prices[i - 1];
		const gain = diff > 0 ? diff : 0;
		const loss = diff < 0 ? -diff : 0;

		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;

		const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
		rsiValues.push(100 - 100 / (1 + rs));
	}

	// 마지막 N개의 RSI 값만 반환
	return rsiValues.slice(-lastN);
}

export function calculateStochRSI(prices, period = 14, kPeriod = 3, dPeriod = 3, lastN = 3) {
	if (prices.length < period * 2) {
		return null;
	}

	const rsi = calculateRSI(prices, period);
	if (!rsi) return null;

	// RSI 값들을 배열로 변환
	const rsiValues = [];
	for (let i = period; i < prices.length; i++) {
		const rsiSlice = prices.slice(i - period + 1, i + 1);
		const diff = rsiSlice[rsiSlice.length - 1] - rsiSlice[rsiSlice.length - 2];
		const gain = diff > 0 ? diff : 0;
		const loss = diff < 0 ? -diff : 0;

		const avgGain = gain / period;
		const avgLoss = loss / period;
		const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
		rsiValues.push(100 - 100 / (1 + rs));
	}

	// K값 계산
	const kValues = [];
	for (let i = kPeriod - 1; i < rsiValues.length; i++) {
		const slice = rsiValues.slice(i - kPeriod + 1, i + 1);
		const min = Math.min(...slice);
		const max = Math.max(...slice);
		const stoch = max - min === 0 ? 50 : ((slice[slice.length - 1] - min) / (max - min)) * 100;
		kValues.push(stoch);
	}

	// D값 계산 (K의 이동평균)
	const dValues = [];
	for (let i = dPeriod - 1; i < kValues.length; i++) {
		const d = kValues.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod;
		dValues.push(d);
	}

	// 마지막 N개의 K, D 값 반환
	const lastK = kValues.slice(-lastN);
	const lastD = dValues.slice(-lastN);

	return {
		k: lastK,
		d: lastD,
	};
}

export function calculateBollingerBands(prices, period = 20, multiplier = 2, lastN = 3) {
	if (prices.length < period) {
		return null;
	}

	const bands = [];

	// 각 시점별 볼린저 밴드 계산
	for (let i = period - 1; i < prices.length; i++) {
		const periodPrices = prices.slice(i - period + 1, i + 1);

		// 단순 이동평균(SMA) 계산
		const sma = periodPrices.reduce((sum, price) => sum + price, 0) / period;

		// 표준편차 계산
		const squaredDiffs = periodPrices.map((price) => Math.pow(price - sma, 2));
		const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period;
		const stdDev = Math.sqrt(variance);

		bands.push({
			middle: sma,
			upper: sma + multiplier * stdDev,
			lower: sma - multiplier * stdDev,
		});
	}

	// 마지막 N개의 밴드 값만 반환
	return bands.slice(-lastN);
}

// EMA(지수이동평균) 계산 함수
export function calculateEMA(prices, period = 20, lastN = 3) {
	if (prices.length < period) {
		return null;
	}

	const k = 2 / (period + 1);
	let ema = prices[0];
	const emaValues = [ema];

	for (let i = 1; i < prices.length; i++) {
		ema = prices[i] * k + ema * (1 - k);
		emaValues.push(ema);
	}

	// 마지막 N개의 값만 반환
	return emaValues.slice(-lastN);
}

// MACD 계산용 내부 EMA 함수
function calculateInternalEMA(prices, period) {
	const k = 2 / (period + 1);
	let ema = prices[0];
	const emaValues = [ema];

	for (let i = 1; i < prices.length; i++) {
		ema = prices[i] * k + ema * (1 - k);
		emaValues.push(ema);
	}

	return emaValues;
}

export function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9, lastN = 3) {
	if (prices.length < slowPeriod + signalPeriod) {
		return null;
	}

	// EMA 계산
	const fastEMA = calculateInternalEMA(prices, fastPeriod);
	const slowEMA = calculateInternalEMA(prices, slowPeriod);

	// MACD 라인 계산 (fastEMA - slowEMA)
	const macdLine = [];
	for (let i = slowPeriod - 1; i < prices.length; i++) {
		const macd = fastEMA[i] - slowEMA[i];
		macdLine.push(macd);
	}

	// 시그널 라인 계산 (MACD의 EMA)
	const signalLine = calculateInternalEMA(macdLine, signalPeriod);

	// 히스토그램 계산 (MACD - Signal)
	const histogram = [];
	const startIndex = signalPeriod - 1;

	for (let i = 0; i < signalLine.length; i++) {
		if (i + startIndex >= macdLine.length) break;
		const macdValue = macdLine[i + startIndex];
		const signalValue = signalLine[i];
		histogram.push(macdValue - signalValue);
	}

	// 마지막 N개의 값만 반환
	const lastValues = {
		value: macdLine.slice(-lastN),
		signal: signalLine.slice(-lastN),
		histogram: histogram.slice(-lastN),
	};

	return lastValues;
}

export function calculateATR(candles, period = 14) {
	if (candles.length < period + 1) {
		throw new Error('Not enough candles to calculate ATR');
	}

	var trs = [];

	for (var i = 1; i <= period; i++) {
		var prev = candles[i - 1];
		var curr = candles[i];

		var highLow = curr.high - curr.low;
		var highClose = Math.abs(curr.high - prev.close);
		var lowClose = Math.abs(curr.low - prev.close);

		var tr = Math.max(highLow, highClose, lowClose);
		trs.push(tr);
	}

	var sum = trs.reduce(function (acc, val) {
		return acc + val;
	}, 0);

	var atr = sum / period;
	return atr;
}

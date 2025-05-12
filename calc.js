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

export function calculateRSI(prices, period = 14) {
    const rsi = Array(period).fill(null); // 앞부분은 계산 불가로 null 채움

    let gains = 0;
    let losses = 0;

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

    let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi.push(100 - (100 / (1 + rs)));

    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;

        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;

        rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
        rsi.push(100 - (100 / (1 + rs)));
    }

    return rsi;
}

export function calculateBollingerBands(prices, period = 20, multiplier = 2) {
    const sma = calculateMA(prices, period);
    const stdDev = [];
    const upperBand = [];
    const lowerBand = [];

    for (let i = 0; i < prices.length; i++) {
        if (i < period - 1) {
            stdDev.push(null);
            upperBand.push(null);
            lowerBand.push(null);
            continue;
        }

        const slice = prices.slice(i - period + 1, i + 1);
        const mean = sma[i];
        const squaredDiffs = slice.map(price => Math.pow(price - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        const currentStdDev = Math.sqrt(variance);

        stdDev.push(currentStdDev);
        upperBand.push(mean + (multiplier * currentStdDev));
        lowerBand.push(mean - (multiplier * currentStdDev));
    }

    return {
        middle: sma,
        upper: upperBand,
        lower: lowerBand
    };
}
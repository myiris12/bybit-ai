async function getTradingInfo(marketData) {
    const { candles_1m, candles_5m, position } = marketData;

    // 1. 기본 가격 정보 계산
    const currentPrice = candles_1m[0].close;
    const prevPrice = candles_1m[1].close;
    const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;

    // 2. 이동평균선 계산 (5분봉 기준)
    const ma5 = calculateMA(candles_5m, 5);
    const ma10 = calculateMA(candles_5m, 10);
    const ma20 = calculateMA(candles_5m, 20);

    // 3. RSI 계산 (5분봉 기준)
    const rsi = calculateRSI(candles_5m, 14);

    // 4. 볼린저 밴드 계산 (5분봉 기준)
    const bb = calculateBollingerBands(candles_5m, 20, 2);

    // 5. 거래량 분석
    const volumeChange = calculateVolumeChange(candles_1m);

    // 6. 추세 분석
    const trend = analyzeTrend(candles_5m);

    // 7. 포지션 정보 (있는 경우)
    const positionInfo = position ? {
        side: position.side,
        entry_price: position.entry_price,
        current_pnl: ((currentPrice - position.entry_price) / position.entry_price) * 100 * (position.side === 'short' ? -1 : 1),
        size: position.size_coin
    } : null;

    return {
        current_price: currentPrice,
        price_change_1m: priceChange,
        technical_indicators: {
            ma5: ma5[0],
            ma10: ma10[0],
            ma20: ma20[0],
            rsi: rsi,
            bollinger_bands: {
                upper: bb.upper[0],
                middle: bb.middle[0],
                lower: bb.lower[0]
            }
        },
        volume_analysis: volumeChange,
        trend: trend,
        position: positionInfo
    };
}

// 이동평균선 계산 함수
function calculateMA(candles, period) {
    const prices = candles.map(c => c.close);
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

// RSI 계산 함수
function calculateRSI(candles, period) {
    const prices = candles.map(c => c.close);
    const changes = [];

    for (let i = 1; i < prices.length; i++) {
        changes.push(prices[i] - prices[i - 1]);
    }

    let gains = 0;
    let losses = 0;

    // 초기 평균 계산
    for (let i = 0; i < period; i++) {
        if (changes[i] > 0) gains += changes[i];
        else losses -= changes[i];
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // RSI 계산
    const rsi = [];
    rsi.push(100 - (100 / (1 + avgGain / avgLoss)));

    // 나머지 기간에 대한 RSI 계산
    for (let i = period; i < changes.length; i++) {
        const change = changes[i];
        avgGain = ((avgGain * (period - 1)) + (change > 0 ? change : 0)) / period;
        avgLoss = ((avgLoss * (period - 1)) + (change < 0 ? -change : 0)) / period;

        rsi.push(100 - (100 / (1 + avgGain / avgLoss)));
    }

    return rsi[rsi.length - 1];
}

// 볼린저 밴드 계산 함수
function calculateBollingerBands(candles, period, multiplier) {
    const prices = candles.map(c => c.close);
    const ma = calculateMA(candles, period);
    const stdDev = [];

    for (let i = period - 1; i < prices.length; i++) {
        const slice = prices.slice(i - period + 1, i + 1);
        const mean = ma[i];
        const squaredDiffs = slice.map(price => Math.pow(price - mean, 2));
        const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
        stdDev.push(Math.sqrt(variance));
    }

    const upper = ma.map((value, i) => value + (multiplier * stdDev[i]));
    const lower = ma.map((value, i) => value - (multiplier * stdDev[i]));

    return {
        upper,
        middle: ma,
        lower
    };
}

// 거래량 변화 분석 함수
function calculateVolumeChange(candles) {
    const recentVolumes = candles.slice(0, 5).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const currentVolume = recentVolumes[0];

    return {
        current_volume: currentVolume,
        avg_volume: avgVolume,
        volume_ratio: currentVolume / avgVolume
    };
}

// 추세 분석 함수
function analyzeTrend(candles) {
    const ma5 = calculateMA(candles, 5);
    const ma20 = calculateMA(candles, 20);

    const currentMA5 = ma5[0];
    const currentMA20 = ma20[0];
    const prevMA5 = ma5[1];
    const prevMA20 = ma20[1];

    let trend = 'neutral';
    let strength = 0;

    // MA5와 MA20의 교차 확인
    if (currentMA5 > currentMA20 && prevMA5 <= prevMA20) {
        trend = 'bullish';
        strength = 1;
    } else if (currentMA5 < currentMA20 && prevMA5 >= prevMA20) {
        trend = 'bearish';
        strength = 1;
    }

    // 추세 강도 계산
    const priceChange = ((candles[0].close - candles[1].close) / candles[1].close) * 100;
    strength = Math.abs(priceChange) / 2; // 2% 변화당 1 강도

    return {
        direction: trend,
        strength: Math.min(strength, 5) // 최대 강도 5로 제한
    };
}
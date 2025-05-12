import { getMarketData, placeBybitOrder, updateBybitPosition, cancelAllOpenOrders, cancelOpenTPOrders } from './bybit.js';
import { getTradingOpinion, getTradingSignal } from './gpt.js';
import fs from 'fs';
// 실행
const CAPITAL_USD = 10;
const LEVERAGE = 10;

async function main(symbol) {
    try {
        console.log(`🚀 Start Trading Signal: ${symbol}`);
        const marketData = await getMarketData(symbol);

        // JSON 파일로 저장
        // const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // const filename = `market_data_${timestamp}.json`;
        // fs.writeFileSync(filename, JSON.stringify(marketData, null, 2));


        // 트레이딩 의견 주석 처리
        // const tradingOpinion = await getTradingOpinion(marketData);
        // console.log(tradingOpinion);
        
        const tradingSignal = await getTradingSignal(marketData);
        console.log('Trading Signal:', tradingSignal);
        
        switch (tradingSignal.action) {
            case 'enter_position':
                await cancelAllOpenOrders(symbol);
                await placeBybitOrder(tradingSignal, symbol, CAPITAL_USD, LEVERAGE);
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
let symbols = ['PUNDIXUSDT'];

// 코인 별 모니터링 간격 (ms)
const COIN_INTERVAL_MS = 10 * 1000;
// 심볼 별 모니터링 간격 (ms)
const LIST_INTERVAL_MS = 30 * 1000;

// main 루프 함수
async function runMainLoop() {
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
                    console.log(`⏳ 다음 심볼 처리까지 ${COIN_INTERVAL_MS / 1000}초 대기...`);
                    await new Promise(resolve => setTimeout(resolve, COIN_INTERVAL_MS));
                }
            } catch (err) {
                console.error(`❌ [${symbol}] 처리 실패:`, err.message);
            }
        }
    } catch (err) {
        console.error('❌ 루프 전체 실패:', err.message);
    } finally {
        // 모든 심볼 처리 후 다음 사이클까지 대기
        console.log(`\n⏳ 다음 트레이딩 사이클까지 ${LIST_INTERVAL_MS / 1000}초 대기...`);
        setTimeout(runMainLoop, LIST_INTERVAL_MS);
    }
}

// 시작
runMainLoop();
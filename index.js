import {
    getMarketData,
    placeBybitOrder,
    updateBybitPosition,
    cancelAllOpenOrders,
    cancelOpenTPOrders,
    cancelUnfilledOrdersAfterTimeout,
} from './bybit.js';
import { getTradingOpinion, getTradingSignal } from './gpt.js';
import { getPositionsLog, getSymbolInfo, getUSDTBalance } from './bybit.js';
import fs from 'fs';
import telegramBot from 'node-telegram-bot-api';

// 한번 주문에 사용할 가격
const CAPITAL_USD = 100;
// 레버리지
const LEVERAGE = 10;
// 코인 별 모니터링 간격 (ms)
const COIN_INTERVAL_MS = 10 * 1000;
// 스킵 코인 별 모니터링 간격 (ms)
const SKIP_COIN_INTERVAL_MS = 3 * 1000;

// init telegram bot
const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const bot = new telegramBot(TELEGRAM_API_KEY, { polling: true });

async function checkSymbol(symbol) {
    try {
        const marketData = await getMarketData(symbol);
        if (marketData.position) {
            console.log('🔄 포지션 존재');
            return true;
        }

        // 마켓데이터 로그 JSON 파일로 저장
        if (isDebug) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const logDir = `logs/${symbol}`;
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }
            const filename = `${logDir}/market_data_${timestamp}.json`;
            fs.writeFileSync(filename, JSON.stringify(marketData, null, 2));
        }

        // Trading 시그널 받기
        const tradingSignal = await getTradingSignal(marketData);
        console.log('Trading Signal:', tradingSignal);
        let signalMessage = `✅ ${symbol} 분석 결과\nTrading Signal: ${tradingSignal.action}\n${tradingSignal.reason}`;
        if (tradingSignal.action === 'enter_long' || tradingSignal.action === 'enter_short') {
            signalMessage += `\n\nstop_loss: ${tradingSignal.stop_loss.toFixed(6)}`;
            signalMessage += `\ntake_profit_level: ${tradingSignal.take_profit_levels
                .map((level) => level.toFixed(6))
                .join(', ')}`;
            signalMessage += `\ntrailing_stop: ${tradingSignal.trailing_stop.toFixed(6)}`;
            bot.sendMessage(TELEGRAM_CHAT_ID, signalMessage);
        }

        switch (tradingSignal.action) {
            case 'enter_long':
                if (useLong) {
                    await cancelAllOpenOrders(symbol);
                    await placeBybitOrder(tradingSignal, symbol, 'Buy', CAPITAL_USD, LEVERAGE);
                }
                break;
            case 'enter_short':
                if (useShort) {
                    await cancelAllOpenOrders(symbol);
                    await placeBybitOrder(tradingSignal, symbol, 'Sell', CAPITAL_USD, LEVERAGE);
                }
                break;
            case 'wait':
                console.log('🔄 관망 상태');
                break;
        }
    } catch (error) {
        console.error('Failed to fetch or analyze data:', error);
    }

    return false;
}

// checkSymbol 루프 함수
async function runCheckSymbolLoop() {
    if (!isRunning || symbols.length === 0) {
        setTimeout(runCheckSymbolLoop, COIN_INTERVAL_MS);
        return;
    }

    try {
        // 심볼을 순차적으로 처리
        for (const symbol of symbols) {
            try {
                console.log(`\n📊 ${symbol} 분석 시작: ${new Date().toLocaleTimeString()}`);
                const skip = await checkSymbol(symbol);
                if (!skip) {
                    console.log(`✅ ${symbol} 분석 완료: ${new Date().toLocaleTimeString()}`);
                    console.log(`⏳ 다음 심볼 처리까지 ${COIN_INTERVAL_MS / 1000}초 대기...`);
                    await new Promise((resolve) => setTimeout(resolve, COIN_INTERVAL_MS));
                } else {
                    console.log(`⏳ 다음 심볼 처리까지 ${SKIP_COIN_INTERVAL_MS / 1000}초 대기...`);
                    await new Promise((resolve) => setTimeout(resolve, SKIP_COIN_INTERVAL_MS));
                }
            } catch (err) {
                console.error(`❌ [${symbol}] 분석 실패:`, err.message);
                bot.sendMessage(TELEGRAM_CHAT_ID, `❌ [${symbol}] 분석 실패: ${err.message}`);
            }
        }
    } catch (err) {
        isRunning = false;
        console.error('❌ 루프 전체 실패:', err.message);
        bot.sendMessage(TELEGRAM_CHAT_ID, `❌ 루프 전체 실패: ${err.message}`);
    } finally {
        runCheckSymbolLoop();
    }
}

// 심볼 목록 (확장 가능)
let isRunning = true;
let isDebug = false;
let symbols = [];
let useLong = true;
let useShort = true;

const main = async () => {
    bot.sendMessage(TELEGRAM_CHAT_ID, 'Initialize Bybit Trading Bot');
    bot.onText(/\/add/, async (msg) => {
        const symbol = msg.text.split(' ')[1];
        if (!symbol) {
            bot.sendMessage(TELEGRAM_CHAT_ID, '❌ 심볼을 입력해주세요. 예) /add BTCUSDT');
            return;
        }

        if (symbols.includes(`${symbol.toUpperCase()}USDT`)) {
            bot.sendMessage(TELEGRAM_CHAT_ID, `❌ ${symbol.toUpperCase()}USDT 이미 추가됨`);
            return;
        }

        const symbolInfo = await getSymbolInfo(`${symbol.toUpperCase()}USDT`);
        if (symbolInfo.retCode !== 0) {
            bot.sendMessage(TELEGRAM_CHAT_ID, `❌ ${symbol.toUpperCase()}USDT Bybit에 없음`);
            return;
        }

        symbols.push(`${symbol.toUpperCase()}USDT`);

        // 심볼 목록 파일 저장
        fs.writeFileSync('symbols.txt', symbols.join('\n'));

        bot.sendMessage(TELEGRAM_CHAT_ID, `✅ ${symbol.toUpperCase()}USDT 추가됨`);
    });

    bot.onText(/\/remove/, async (msg) => {
        const symbol = msg.text.split(' ')[1];
        if (!symbol) {
            bot.sendMessage(TELEGRAM_CHAT_ID, '❌ 심볼을 입력해주세요. 예) /remove BTC');
            return;
        }

        if (!symbols.includes(`${symbol.toUpperCase()}USDT`)) {
            bot.sendMessage(TELEGRAM_CHAT_ID, `❌ ${symbol.toUpperCase()}USDT 없음`);
            return;
        }

        symbols = symbols.filter((s) => s !== `${symbol.toUpperCase()}USDT`);

        // 심볼 목록 파일 저장
        fs.writeFileSync('symbols.txt', symbols.join('\n'));

        bot.sendMessage(TELEGRAM_CHAT_ID, `✅ ${symbol.toUpperCase()}USDT 제거됨`);
    });

    bot.onText(/\/list/, async (msg) => {
        bot.sendMessage(TELEGRAM_CHAT_ID, `✅ 현재 심볼 목록: ${symbols.join(', ')}`);
    });

    bot.onText(/\/start/, async (msg) => {
        isRunning = true;
        bot.sendMessage(TELEGRAM_CHAT_ID, 'Start Bybit Trading Bot');
    });

    bot.onText(/\/stop/, async (msg) => {
        isRunning = false;
        bot.sendMessage(TELEGRAM_CHAT_ID, 'Stop Bybit Trading Bot');
    });

    bot.onText(/\/debug/, async (msg) => {
        isDebug = !isDebug;
        bot.sendMessage(TELEGRAM_CHAT_ID, `Debug mode: ${isDebug ? 'ON' : 'OFF'}`);
    });

    bot.onText(/\/long/, async (msg) => {
        useLong = !useLong;
        bot.sendMessage(TELEGRAM_CHAT_ID, `Long mode: ${useLong ? 'ON' : 'OFF'}`);
    });

    bot.onText(/\/short/, async (msg) => {
        useShort = !useShort;
        bot.sendMessage(TELEGRAM_CHAT_ID, `Short mode: ${useShort ? 'ON' : 'OFF'}`);
    });

    bot.onText(/\/position/, async (msg) => {
        const positionLog = await getPositionsLog();
        bot.sendMessage(TELEGRAM_CHAT_ID, positionLog, {
            parse_mode: 'HTML',
        });
    });

    bot.onText(/\/balance/, async (msg) => {
        const balance = await getUSDTBalance();
        bot.sendMessage(TELEGRAM_CHAT_ID, `✅ 현재 잔고: ${balance.toLocaleString()}USDT`);
    });

    // 초기 심볼 목록 파일 읽기
    if (fs.existsSync('symbols.txt')) {
        symbols = fs.readFileSync('symbols.txt', 'utf8').split('\n');
        console.log('🔄 초기 심볼 목록:', symbols);
    }

    runCheckSymbolLoop();
};

(async () => {
    await main();
})();

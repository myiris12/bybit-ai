import {
	getMarketData,
	placeBybitOrder,
	updateBybitPosition,
	cancelAllOpenOrders,
	cancelOpenTPOrders,
	cancelUnfilledOrdersAfterTimeout,
} from './bybit.js';
import { getTradingOpinion, getTradingSignal } from './gpt.js';
import { getPositionsLog } from './bybit.js';
import fs from 'fs';
import telegramBot from 'node-telegram-bot-api';

// 한번 주문에 사용할 가격
const CAPITAL_USD = 10;
// 레버리지
const LEVERAGE = 10;
// 코인 별 모니터링 간격 (ms)
const COIN_INTERVAL_MS = 10 * 1000;

// init telegram bot
const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const bot = new telegramBot(TELEGRAM_API_KEY, { polling: true });

async function checkSymbol(symbol) {
	try {
		const marketData = await getMarketData(symbol);
		if (marketData.position) {
			console.log('🔄 포지션 존재');
			return;
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
			signalMessage += `\n\nstop_loss: ${tradingSignal.stop_loss.toFixed(4)}`;
			signalMessage += `\ntake_profit_level: ${tradingSignal.take_profit_levels
				.map((level) => level.toFixed(4))
				.join(', ')}`;
			bot.sendMessage(TELEGRAM_CHAT_ID, signalMessage);
		}

		switch (tradingSignal.action) {
			case 'enter_long':
				await cancelAllOpenOrders(symbol);
				await placeBybitOrder(tradingSignal, symbol, 'Buy', CAPITAL_USD, LEVERAGE);
				break;
			case 'enter_short':
				await cancelAllOpenOrders(symbol);
				await placeBybitOrder(tradingSignal, symbol, 'Sell', CAPITAL_USD, LEVERAGE);
				break;
			case 'wait':
				console.log('🔄 관망 상태');
				break;
		}
	} catch (error) {
		console.error('Failed to fetch or analyze data:', error);
	}
}

// checkSymbol 루프 함수
async function runCheckSymbolLoop() {
	if (!isRunning) {
		setTimeout(runCheckSymbolLoop, LIST_INTERVAL_MS);
		return;
	}

	try {
		// 심볼을 순차적으로 처리
		for (const symbol of symbols) {
			try {
				console.log(`\n📊 ${symbol} 분석 시작: ${new Date().toLocaleTimeString()}`);
				await checkSymbol(symbol);
				console.log(`✅ ${symbol} 분석 완료: ${new Date().toLocaleTimeString()}`);

				console.log(`⏳ 다음 심볼 처리까지 ${COIN_INTERVAL_MS / 1000}초 대기...`);
				await new Promise((resolve) => setTimeout(resolve, COIN_INTERVAL_MS));
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
let symbols = ['BIGTIMEUSDT'];

const main = async () => {
	bot.sendMessage(TELEGRAM_CHAT_ID, 'Initialize Bybit Trading Bot');
	bot.onText(/\/add/, async (msg) => {
		const symbol = msg.text.split(' ')[1];
		if (!symbol) {
			bot.sendMessage(TELEGRAM_CHAT_ID, '❌ 심볼을 입력해주세요. 예) /add BTCUSDT');
			return;
		}

		symbols.push(`${symbol}USDT`);
		bot.sendMessage(TELEGRAM_CHAT_ID, `✅ ${symbol}USDT 추가됨`);
	});

	bot.onText(/\/remove/, async (msg) => {
		const symbol = msg.text.split(' ')[1];
		if (!symbol) {
			bot.sendMessage(TELEGRAM_CHAT_ID, '❌ 심볼을 입력해주세요. 예) /remove BTC');
			return;
		}

		symbols = symbols.filter((s) => s !== `${symbol}USDT`);
		bot.sendMessage(TELEGRAM_CHAT_ID, `✅ ${symbol}USDT 제거됨`);
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

	bot.onText(/\/position/, async (msg) => {
		const positionLog = await getPositionsLog();
		bot.sendMessage(TELEGRAM_CHAT_ID, positionLog, {
			parse_mode: 'HTML',
		});
	});

	runCheckSymbolLoop();
};

(async () => {
	await main();
})();

import 'dotenv/config';
import { RestClientV5 } from 'bybit-api';
import crypto from 'crypto';
import moment from 'moment';
import fs from 'fs';

// Web Crypto API polyfill
if (typeof global.crypto === 'undefined') {
	global.crypto = crypto;
}

// Bybit API 클라이언트 초기화
const client = new RestClientV5({
	key: process.env.BYBIT_API_KEY,
	secret: process.env.BYBIT_API_SECRET,
	testnet: false,
});

const getClosedPositions = async (startTime, endTime) => {
	try {
		let allPositions = [];
		let cursor = null;

		do {
			const params = {
				category: 'linear',
				limit: 100,
			};

			if (startTime) {
				params.startTime = startTime;
			}
			if (endTime) {
				params.endTime = endTime;
			}

			if (cursor) {
				params.cursor = cursor;
			}

			const response = await client.getClosedPnL(params);

			if (response.retCode !== 0) {
				throw new Error(`API 에러: ${response.retMsg}`);
			}

			const positions = response.result.list;
			allPositions = allPositions.concat(positions);

			cursor = response.result.nextPageCursor;

			// API 호출 간 딜레이 추가 (rate limit 방지)
			if (cursor) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		} while (cursor);

		const statistics = {};

		allPositions.forEach((position) => {
			const symbol = position.symbol;
			if (!statistics[symbol]) {
				statistics[symbol] = {
					totalTrades: 0,
					winningTrades: 0,
					losingTrades: 0,
					totalProfit: 0,
					totalLoss: 0,
				};
			}

			const stats = statistics[symbol];
			stats.totalTrades++;

			if (parseFloat(position.closedPnl) > 0) {
				stats.winningTrades++;
				stats.totalProfit += parseFloat(position.closedPnl);
			} else {
				stats.losingTrades++;
				stats.totalLoss += parseFloat(position.closedPnl);
			}
		});

		return { statistics, positions: allPositions };
	} catch (error) {
		console.error('에러 발생:', error);
		throw error;
	}
};

const saveToCSV = (stats, filename) => {
	const header = '토큰이름,win수,loss수,승률,얻은pnl,잃은pnl,총pnl\n';
	const rows = Object.entries(stats).map(([symbol, data]) => {
		const winRate = ((data.winningTrades / data.totalTrades) * 100).toFixed(2);
		const totalPnl = data.totalProfit + data.totalLoss;
		return `${symbol},${data.winningTrades},${data.losingTrades},${winRate}%,${data.totalProfit.toFixed(
			2
		)},${data.totalLoss.toFixed(2)},${totalPnl.toFixed(2)}`;
	});

	const csvContent = header + rows.join('\n');
	fs.writeFileSync(filename, csvContent);
	console.log(`통계가 ${filename}에 저장되었습니다.`);
};

const saveDetailedTradesToCSV = (positions, filename) => {
	const header = '토큰이름,결과,PNL\n';
	const rows = positions.map((position) => {
		const result = parseFloat(position.closedPnl) > 0 ? 'win' : 'loss';
		return `${position.symbol},${result},${position.closedPnl}`;
	});

	const csvContent = header + rows.join('\n');
	fs.writeFileSync(filename, csvContent);
	console.log(`상세 거래 정보가 ${filename}에 저장되었습니다.`);
};

// 사용 예시
const main = async () => {
	const startTime = null; //moment().startOf('day').utc().valueOf();
	const endTime = moment().endOf('day').utc().valueOf();
	const summaryFilename = `bybit_stats_${moment().format('YYYY-MM-DD')}.csv`;
	const detailedFilename = `bybit_detailed_trades_${moment().format('YYYY-MM-DD')}.csv`;

	try {
		const { statistics, positions } = await getClosedPositions(startTime, endTime);
		saveToCSV(statistics, summaryFilename);
		saveDetailedTradesToCSV(positions, detailedFilename);
	} catch (error) {
		console.error('실행 중 에러 발생:', error);
	}
};

main();

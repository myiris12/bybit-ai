# Bybit Market Data Fetcher

Bybit API를 사용하여 1분봉 데이터와 포지션 정보를 가져오는 Node.js 애플리케이션입니다.

## 설치 방법

1. 저장소를 클론합니다:
```bash
git clone [repository-url]
cd bybit-ai
```

2. 의존성 패키지를 설치합니다:
```bash
npm install
```

3. `.env` 파일을 생성하고 Bybit API 키를 설정합니다:
```
BYBIT_API_KEY=your_api_key_here
BYBIT_API_SECRET=your_api_secret_here
```

## 사용 방법

애플리케이션을 실행하려면:
```bash
node index.js
```

기본적으로 BTCUSDT 심볼에 대한 데이터를 가져옵니다. 다른 심볼을 사용하려면 `getMarketData()` 함수의 파라미터를 수정하세요.

## 응답 형식

```json
{
  "symbol": "BTCUSDT",
  "candles": [
    {
      "timestamp": 1234567890000,
      "open": 50000.0,
      "high": 51000.0,
      "low": 49000.0,
      "close": 50500.0,
      "volume": 100.5
    },
    // ... 더 많은 캔들 데이터
  ],
  "position": {
    // 포지션 정보 (있는 경우)
  }
}
``` 
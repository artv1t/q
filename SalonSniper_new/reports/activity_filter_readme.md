# Activity Filter (Step 3.7) - Implementation Report

## What was changed
- **Replaced**: Old PoolSizeFilter (Jupiter-based) with new ActivityFilter (in-memory analysis)
- **Disabled**: Jupiter API calls in LocalRouteGate (3.5) and LP Protection (3.6) filters
- **Maintained**: Same filter pipeline position and interface

## Environment Variables
```env
# Activity window configuration
ACT_WINDOW_MIN=10                    # Analysis window in minutes (default: 10)
ACT_SPIKE_WINDOW_SEC=60             # Spike detection window in seconds (default: 60)

# Activity thresholds (all must be met simultaneously)
ACT_MIN_TRADES_10M=40               # Minimum trades in 10-minute window
ACT_MIN_BUYERS_10M=25               # Minimum unique buyers in 10-minute window  
ACT_MIN_NET_SOL_10M=20              # Minimum net SOL (buys - sells) in 10-minute window
ACT_MIN_BUY_SELL=1.2                # Minimum buy/sell ratio in 10-minute window
ACT_MIN_TRADES_1M=12                # Minimum trades in 1-minute window (spike detection)
```

## How to read logs
Activity filter logs one JSON per token:
```json
{
  "filter": "07_activity",
  "mint": "<MINT_ADDRESS>",
  "result": {
    "action": "passed|failed",
    "reason": "activity_ok|activity_low", 
    "critical": false,
    "meta": {
      "trades_10m": 48,
      "buyers_10m": 31,
      "net_SOL_10m": 27.4,
      "buy_sell": 1.35,
      "trades_1m": 14,
      "buyers_1m": 11,
      "spike": true
    }
  },
  "timeMs": 123
}
```

## Decision Logic
Token **PASSES** if ALL conditions are met:
- trades_10m ≥ 40 AND
- buyers_10m ≥ 25 AND  
- net_SOL_10m ≥ 20 AND
- buy_sell ≥ 1.2

Spike detection (trades_1m ≥ 12) is logged but doesn't affect pass/fail decision.

## Performance
- **No external API calls** (Jupiter removed)
- **In-memory analysis** with automatic cleanup
- **5000 mint limit** with LRU eviction
- **10-minute TTL** for activity events

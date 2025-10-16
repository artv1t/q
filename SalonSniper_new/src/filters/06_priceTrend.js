const logger = require('../utils/logging');
const { getInstance: getTradesBackfill } = require('../data/tradesBackfill');

class PriceTrendFilter {
  constructor() {
    this.name = '06_priceTrend';
    this.enabled = process.env.PRICE_TREND_FILTER_ENABLED !== 'false';
    this.critical = process.env.PRICE_TREND_CRITICAL === 'true';
    
    this.mode = process.env.PRICE_TREND_MODE || 'FLOW';
    this.nonNegative = process.env.PRICE_TREND_NON_NEGATIVE === 'true';
    this.minGain60to15Bp = parseInt(process.env.PRICE_TREND_MIN_GAIN_60_15_BP) || 0;
    
    this.windows = [5, 15, 30, 60];
    this.tradesBackfill = getTradesBackfill();
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      price_down_60_30: 0,
      price_down_30_15: 0,
      price_down_15_5: 0,
      flow_down_60_30: 0,
      flow_down_30_15: 0,
      flow_down_15_5: 0,
      rpc_error_trades_backfill: 0,
      startTime: Date.now()
    };
    
    logger.info(`📈 ${this.name}: Price Trend Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      mode: this.mode,
      nonNegative: this.nonNegative,
      minGain60to15Bp: this.minGain60to15Bp
    });
  }

  async process(tokenData) {
    const startTime = Date.now();
    this.stats.processed++;
    
    const { mint, signature } = tokenData;
    
    try {
      if (!this.enabled) {
        this.stats.passed++;
        return {
          pass: true,
          critical: false,
          scoreDelta: 0,
          reason: 'disabled',
          action: 'passed',
          processingTimeMs: Date.now() - startTime
        };
      }
      
      const trades = await this.tradesBackfill.fetchRecentTrades(mint, 60);
      
      if (trades.length === 0) {
        this.stats.rpc_error_trades_backfill++;
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -0.3,
          reason: 'rpc_error_trades_backfill',
          action: 'failed',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: No trades data`, {
          mint: mint.substring(0, 8) + '...',
          signature: signature.substring(0, 8) + '...',
          ...result
        });
        
        return result;
      }
      
      const trendResult = this.analyzePriceTrend(trades);
      
      const result = {
        pass: trendResult.pass,
        critical: this.critical && !trendResult.pass,
        scoreDelta: trendResult.pass ? 0.2 : -0.3,
        reason: trendResult.reason,
        action: trendResult.pass ? 'passed' : 'failed',
        processingTimeMs: Date.now() - startTime,
        ...trendResult.metrics
      };
      
      this.updateStats(result);
      
      if (result.pass) {
        logger.debug(`✅ ${this.name}: Token passed`, {
          stage: "TRACE",
          filter: "06_priceTrend",
          mode: this.mode,
          mint_short: mint.substring(0, 8) + '...',
          ts: Date.now(),
          win: trendResult.metrics
        });
      } else {
        logger.info(`❌ ${this.name}: Token failed`, {
          mint: mint.substring(0, 8) + '...',
          signature: signature.substring(0, 8) + '...',
          reason: result.reason,
          metrics: trendResult.metrics
        });
      }
      
      return result;
      
    } catch (error) {
      this.stats.failed++;
      this.stats.rpc_error_trades_backfill++;
      
      const result = {
        pass: false,
        critical: this.critical,
        scoreDelta: -0.5,
        reason: 'rpc_error_trades_backfill',
        action: 'failed',
        error: error.message,
        processingTimeMs: Date.now() - startTime
      };
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint: mint.substring(0, 8) + '...',
        signature: signature.substring(0, 8) + '...',
        ...result
      });
      
      return result;
    }
  }

  analyzePriceTrend(trades) {
    const now = Date.now();
    const windows = {};
    
    for (const windowMin of this.windows) {
      const cutoff = now - (windowMin * 60 * 1000);
      const windowTrades = trades.filter(t => t.ts >= cutoff);
      
      if (this.mode === 'VWAP' && windowTrades.some(t => t.tokenAmount)) {
        let totalValue = 0;
        let totalVolume = 0;
        
        for (const trade of windowTrades) {
          if (trade.tokenAmount && trade.tokenAmount > 0) {
            const price = trade.sol / trade.tokenAmount;
            totalValue += price * trade.tokenAmount;
            totalVolume += trade.tokenAmount;
          }
        }
        
        windows[windowMin] = totalVolume > 0 ? totalValue / totalVolume : 0;
      } else {
        const netSol = windowTrades.reduce((sum, trade) => {
          return sum + (trade.side === 'buy' ? trade.sol : -trade.sol);
        }, 0);
        windows[windowMin] = netSol;
      }
    }
    
    const values = [windows[60], windows[30], windows[15], windows[5]];
    
    for (let i = 0; i < values.length - 1; i++) {
      if (values[i] > values[i + 1]) {
        const reasons = [
          'price_down_60_30',
          'price_down_30_15', 
          'price_down_15_5'
        ];
        const flowReasons = [
          'flow_down_60_30',
          'flow_down_30_15',
          'flow_down_15_5'
        ];
        
        const reason = this.mode === 'VWAP' ? reasons[i] : flowReasons[i];
        
        return {
          pass: false,
          reason: reason,
          metrics: {
            5: Math.round(values[3] * 1000) / 1000,
            15: Math.round(values[2] * 1000) / 1000,
            30: Math.round(values[1] * 1000) / 1000,
            60: Math.round(values[0] * 1000) / 1000
          }
        };
      }
    }
    
    return {
      pass: true,
      reason: 'price_trend_ok',
      metrics: {
        5: Math.round(values[3] * 1000) / 1000,
        15: Math.round(values[2] * 1000) / 1000,
        30: Math.round(values[1] * 1000) / 1000,
        60: Math.round(values[0] * 1000) / 1000
      }
    };
  }

  updateStats(result) {
    if (result.pass) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
      if (this.stats[result.reason] !== undefined) {
        this.stats[result.reason]++;
      }
    }
  }

  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0
    };
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }
}

module.exports = PriceTrendFilter;

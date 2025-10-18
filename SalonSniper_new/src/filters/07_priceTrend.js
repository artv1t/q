const logger = require('../utils/logging');
const { getInstance: getTradesBackfill } = require('../data/tradesBackfill');

class PriceTrendFilter {
  constructor() {
    this.name = '07_priceTrend';
    this.enabled = process.env.PRICE_TREND_FILTER_ENABLED !== 'false';
    this.critical = process.env.PRICE_TREND_CRITICAL === 'true';
    
    const windowsStr = process.env.PRICE_TREND_WINDOWS || '15,30,60';
    this.windows = windowsStr.split(',').map(w => parseInt(w.trim()));
    
    this.mode = process.env.PRICE_TREND_MODE || 'VWAP';
    this.minRiseBps = parseInt(process.env.PRICE_TREND_MIN_RISE_BPS) || 300;
    this.allowZeroLower = process.env.PRICE_TREND_ALLOW_ZERO_LOWER === 'true';
    this.requireHistoryMinutes = parseInt(process.env.PRICE_TREND_REQUIRE_HISTORY_MINUTES) || 0;
    
    this.tradesBackfill = getTradesBackfill();
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      price_down_60_30: 0,
      price_down_30_15: 0,
      insufficient_history: 0,
      startTime: Date.now()
    };
    
    logger.info(`📈 ${this.name}: Price Trend Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      mode: this.mode,
      windows: this.windows,
      minRiseBps: this.minRiseBps
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
      
      const trades = await this.tradesBackfill.fetchRecentTrades(mint, Math.max(...this.windows));
      
      if (trades.length === 0) {
        if (this.requireHistoryMinutes === 0) {
          this.stats.insufficient_history++;
          this.stats.passed++;
          return {
            pass: true,
            critical: false,
            scoreDelta: 0,
            reason: 'insufficient_history',
            action: 'passed',
            processingTimeMs: Date.now() - startTime
          };
        } else {
          this.stats.failed++;
          return {
            pass: false,
            critical: this.critical,
            scoreDelta: -0.3,
            reason: 'no_trades_data',
            action: 'failed',
            processingTimeMs: Date.now() - startTime
          };
        }
      }
      
      const priceResult = this.analyzePriceTrend(trades);
      
      const result = {
        pass: priceResult.pass,
        critical: this.critical && !priceResult.pass,
        scoreDelta: priceResult.pass ? 0.2 : -0.3,
        reason: priceResult.reason,
        action: priceResult.pass ? 'passed' : 'failed',
        processingTimeMs: Date.now() - startTime,
        ...priceResult.metrics
      };
      
      this.updateStats(result);
      
      if (result.pass) {
        logger.debug(`✅ ${this.name}: Token passed`, {
          stage: "CHK",
          filter: "07_priceTrend",
          mode: this.mode,
          windows: this.windows,
          prices: priceResult.metrics,
          rise_bps: this.minRiseBps,
          reason: result.reason
        });
      } else {
        logger.info(`❌ ${this.name}: Token failed`, {
          mint: mint.substring(0, 8) + '...',
          signature: signature.substring(0, 8) + '...',
          reason: result.reason,
          prices: priceResult.metrics
        });
      }
      
      return result;
      
    } catch (error) {
      this.stats.failed++;
      
      const result = {
        pass: false,
        critical: this.critical,
        scoreDelta: -0.5,
        reason: 'processing_error',
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
    const prices = {};
    
    for (const windowMin of this.windows) {
      const cutoff = now - (windowMin * 60 * 1000);
      const windowTrades = trades.filter(t => t.ts >= cutoff);
      
      if (windowTrades.length === 0) {
        prices[windowMin] = 0;
        continue;
      }
      
      let totalValue = 0;
      let totalVolume = 0;
      
      for (const trade of windowTrades) {
        if (trade.tokenAmount && trade.tokenAmount > 0) {
          const price = trade.sol / trade.tokenAmount;
          totalValue += price * trade.tokenAmount;
          totalVolume += trade.tokenAmount;
        }
      }
      
      prices[windowMin] = totalVolume > 0 ? totalValue / totalVolume : 0;
    }
    
    const sortedWindows = [...this.windows].sort((a, b) => b - a); // [60, 30, 15]
    
    for (let i = 0; i < sortedWindows.length - 1; i++) {
      const largerWindow = sortedWindows[i];
      const smallerWindow = sortedWindows[i + 1];
      
      const largerPrice = prices[largerWindow];
      const smallerPrice = prices[smallerWindow];
      
      if (smallerPrice === 0 && this.allowZeroLower) {
        continue;
      }
      
      const requiredPrice = largerPrice * (1 + this.minRiseBps / 10000);
      
      if (smallerPrice < requiredPrice) {
        const reason = `price_down_${largerWindow}_${smallerWindow}`;
        
        return {
          pass: false,
          reason: reason,
          metrics: prices
        };
      }
    }
    
    return {
      pass: true,
      reason: 'price_ok',
      metrics: prices
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

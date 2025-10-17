const logger = require('../utils/logging');
const { getInstance: getTradesBackfill } = require('../data/tradesBackfill');

class VolumeTrendFilter {
  constructor() {
    this.name = '07_volumeTrend';
    this.enabled = process.env.VOL_FILTER_ENABLED !== 'false';
    this.critical = process.env.VOL_FILTER_CRITICAL === 'true';
    
    const windowsStr = process.env.VOL_WINDOWS || '5,15,30,60';
    this.windows = windowsStr.split(',').map(w => parseInt(w.trim()));
    
    this.minBuyRatio15 = parseFloat(process.env.VOL_MIN_BUY_RATIO_15) || 0.60;
    this.minBuyRatio30 = parseFloat(process.env.VOL_MIN_BUY_RATIO_30) || 0.55;
    
    this.minNetSol15 = parseFloat(process.env.VOL_MIN_NET_SOL_15) || 0.02;
    this.minNetSol30 = parseFloat(process.env.VOL_MIN_NET_SOL_30) || 0.05;
    
    this.minTrades60 = parseInt(process.env.VOL_MIN_TRADES_60) || 3;
    this.minBuyers60 = parseInt(process.env.VOL_MIN_BUYERS_60) || 2;
    
    this.use5mSoft = process.env.VOL_USE_5M_SOFT === 'true';
    
    this.tradesBackfill = getTradesBackfill();
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      vol_ratio_low_15: 0,
      vol_ratio_low_30: 0,
      net_sol_low_15: 0,
      net_sol_low_30: 0,
      trades_low_60: 0,
      buyers_low_60: 0,
      startTime: Date.now()
    };
    
    logger.info(`📊 ${this.name}: Volume Trend Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      windows: this.windows,
      minBuyRatio15: this.minBuyRatio15,
      minBuyRatio30: this.minBuyRatio30,
      minNetSol15: this.minNetSol15,
      minNetSol30: this.minNetSol30
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
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -0.3,
          reason: 'no_trades_data',
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
      
      const volumeResult = this.analyzeVolumeTrend(trades);
      
      const result = {
        pass: volumeResult.pass,
        critical: this.critical && !volumeResult.pass,
        scoreDelta: volumeResult.pass ? 0.3 : -0.4,
        reason: volumeResult.reason,
        action: volumeResult.pass ? 'passed' : 'failed',
        processingTimeMs: Date.now() - startTime,
        ...volumeResult.metrics
      };
      
      this.updateStats(result);
      
      if (result.pass) {
        logger.debug(`✅ ${this.name}: Token passed`, {
          stage: "CHK",
          filter: "07_volumeTrend",
          windows: this.windows,
          metrics: volumeResult.metrics,
          reason: result.reason
        });
      } else {
        logger.info(`❌ ${this.name}: Token failed`, {
          mint: mint.substring(0, 8) + '...',
          signature: signature.substring(0, 8) + '...',
          reason: result.reason,
          metrics: volumeResult.metrics
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

  analyzeVolumeTrend(trades) {
    const now = Date.now();
    const windowData = {};
    
    for (const windowMin of this.windows) {
      const cutoff = now - (windowMin * 60 * 1000);
      const windowTrades = trades.filter(t => t.ts >= cutoff);
      
      let buyVol = 0;
      let sellVol = 0;
      const buyers = new Set();
      
      for (const trade of windowTrades) {
        if (trade.side === 'buy') {
          buyVol += trade.sol;
          if (trade.buyer) buyers.add(trade.buyer);
        } else {
          sellVol += trade.sol;
        }
      }
      
      const totalVol = buyVol + sellVol;
      const buyRatio = totalVol > 0 ? buyVol / totalVol : 0;
      const netSol = buyVol - sellVol;
      
      windowData[windowMin] = {
        buyRatio,
        netSol,
        trades: windowTrades.length,
        buyers: buyers.size,
        buyVol,
        sellVol
      };
    }
    
    if (windowData[15] && windowData[15].buyRatio < this.minBuyRatio15) {
      return {
        pass: false,
        reason: 'vol_ratio_low_15',
        metrics: this.formatMetrics(windowData)
      };
    }
    
    if (windowData[30] && windowData[30].buyRatio < this.minBuyRatio30) {
      return {
        pass: false,
        reason: 'vol_ratio_low_30',
        metrics: this.formatMetrics(windowData)
      };
    }
    
    if (windowData[15] && windowData[15].netSol < this.minNetSol15) {
      return {
        pass: false,
        reason: 'net_sol_low_15',
        metrics: this.formatMetrics(windowData)
      };
    }
    
    if (windowData[30] && windowData[30].netSol < this.minNetSol30) {
      return {
        pass: false,
        reason: 'net_sol_low_30',
        metrics: this.formatMetrics(windowData)
      };
    }
    
    if (windowData[60]) {
      if (windowData[60].trades < this.minTrades60) {
        return {
          pass: false,
          reason: 'trades_low_60',
          metrics: { trades60: windowData[60].trades, buyers60: windowData[60].buyers }
        };
      }
      
      if (windowData[60].buyers < this.minBuyers60) {
        return {
          pass: false,
          reason: 'buyers_low_60',
          metrics: { trades60: windowData[60].trades, buyers60: windowData[60].buyers }
        };
      }
    }
    
    return {
      pass: true,
      reason: 'volume_ok',
      metrics: this.formatMetrics(windowData)
    };
  }

  formatMetrics(windowData) {
    const metrics = {};
    
    for (const windowMin of this.windows) {
      if (windowData[windowMin]) {
        metrics[`buyRatio${windowMin}`] = Math.round(windowData[windowMin].buyRatio * 1000) / 1000;
        metrics[`netSol${windowMin}`] = Math.round(windowData[windowMin].netSol * 1000) / 1000;
      }
    }
    
    return metrics;
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

module.exports = VolumeTrendFilter;

const logger = require('../utils/logging');
const { getInstance: getTradesBackfill } = require('../data/tradesBackfill');

class VolumeTrendFilter {
  constructor() {
    this.name = '07_volumeTrend';
    this.enabled = process.env.VOL_FILTER_ENABLED !== 'false';
    this.critical = process.env.VOL_FILTER_CRITICAL === 'true';
    
    this.windows = {
      5: parseInt(process.env.VOL_WIN_5M) || 5,
      15: parseInt(process.env.VOL_WIN_15M) || 15,
      30: parseInt(process.env.VOL_WIN_30M) || 30,
      60: parseInt(process.env.VOL_WIN_60M) || 60
    };
    
    this.minBuyRatios = {
      5: parseFloat(process.env.VOL_MIN_BUY_RATIO_5M) || 0.70,
      15: parseFloat(process.env.VOL_MIN_BUY_RATIO_15M) || 0.70,
      30: parseFloat(process.env.VOL_MIN_BUY_RATIO_30M) || 0.70,
      60: parseFloat(process.env.VOL_MIN_BUY_RATIO_60M) || 0.70
    };
    
    this.minNetSol = {
      5: parseFloat(process.env.VOL_MIN_NET_SOL_5M) || 0.05,
      15: parseFloat(process.env.VOL_MIN_NET_SOL_15M) || 0.15,
      30: parseFloat(process.env.VOL_MIN_NET_SOL_30M) || 0.30,
      60: parseFloat(process.env.VOL_MIN_NET_SOL_60M) || 0.50
    };
    
    this.minTrades60 = parseInt(process.env.VOL_MIN_TRADES_60M) || 0;
    this.minBuyers60 = parseInt(process.env.VOL_MIN_BUYERS_60M) || 0;
    this.maxTopBuyerShare60 = parseFloat(process.env.VOL_MAX_TOP_BUYER_SHARE_60M) || 1.0;
    
    this.tradesBackfill = getTradesBackfill();
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      vol_ratio_low_5m: 0,
      vol_ratio_low_15m: 0,
      vol_ratio_low_30m: 0,
      vol_ratio_low_60m: 0,
      vol_net_low_5m: 0,
      vol_net_low_15m: 0,
      vol_net_low_30m: 0,
      vol_net_low_60m: 0,
      low_trades_60m: 0,
      low_buyers_60m: 0,
      top_buyer_dominance_60m: 0,
      rpc_error_trades_backfill: 0,
      startTime: Date.now()
    };
    
    logger.info(`📊 ${this.name}: Volume Trend Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      windows: this.windows,
      minBuyRatios: this.minBuyRatios,
      minNetSol: this.minNetSol
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
          stage: "TRACE",
          filter: "07_volumeTrend",
          r: volumeResult.metrics.buyRatios,
          n: volumeResult.metrics.netSol,
          mint_short: mint.substring(0, 8) + '...',
          ts: Date.now()
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

  analyzeVolumeTrend(trades) {
    const now = Date.now();
    const windowData = {};
    
    for (const [windowKey, windowMin] of Object.entries(this.windows)) {
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
      
      windowData[windowKey] = {
        buyRatio,
        netSol,
        trades: windowTrades.length,
        buyers: buyers.size,
        buyVol,
        sellVol
      };
    }
    
    for (const [windowKey, data] of Object.entries(windowData)) {
      if (data.buyRatio < this.minBuyRatios[windowKey]) {
        return {
          pass: false,
          reason: `vol_ratio_low_${windowKey}m`,
          metrics: {
            buyRatios: {
              5: Math.round(windowData[5].buyRatio * 1000) / 1000,
              15: Math.round(windowData[15].buyRatio * 1000) / 1000,
              30: Math.round(windowData[30].buyRatio * 1000) / 1000,
              60: Math.round(windowData[60].buyRatio * 1000) / 1000
            },
            netSol: {
              5: Math.round(windowData[5].netSol * 1000) / 1000,
              15: Math.round(windowData[15].netSol * 1000) / 1000,
              30: Math.round(windowData[30].netSol * 1000) / 1000,
              60: Math.round(windowData[60].netSol * 1000) / 1000
            }
          }
        };
      }
    }
    
    for (const [windowKey, data] of Object.entries(windowData)) {
      if (data.netSol < this.minNetSol[windowKey]) {
        return {
          pass: false,
          reason: `vol_net_low_${windowKey}m`,
          metrics: {
            buyRatios: {
              5: Math.round(windowData[5].buyRatio * 1000) / 1000,
              15: Math.round(windowData[15].buyRatio * 1000) / 1000,
              30: Math.round(windowData[30].buyRatio * 1000) / 1000,
              60: Math.round(windowData[60].buyRatio * 1000) / 1000
            },
            netSol: {
              5: Math.round(windowData[5].netSol * 1000) / 1000,
              15: Math.round(windowData[15].netSol * 1000) / 1000,
              30: Math.round(windowData[30].netSol * 1000) / 1000,
              60: Math.round(windowData[60].netSol * 1000) / 1000
            }
          }
        };
      }
    }
    
    const data60 = windowData[60];
    
    if (this.minTrades60 > 0 && data60.trades < this.minTrades60) {
      return {
        pass: false,
        reason: 'low_trades_60m',
        metrics: { trades60: data60.trades, buyers60: data60.buyers }
      };
    }
    
    if (this.minBuyers60 > 0 && data60.buyers < this.minBuyers60) {
      return {
        pass: false,
        reason: 'low_buyers_60m',
        metrics: { trades60: data60.trades, buyers60: data60.buyers }
      };
    }
    
    return {
      pass: true,
      reason: 'volume_trend_ok',
      metrics: {
        buyRatios: {
          5: Math.round(windowData[5].buyRatio * 1000) / 1000,
          15: Math.round(windowData[15].buyRatio * 1000) / 1000,
          30: Math.round(windowData[30].buyRatio * 1000) / 1000,
          60: Math.round(windowData[60].buyRatio * 1000) / 1000
        },
        netSol: {
          5: Math.round(windowData[5].netSol * 1000) / 1000,
          15: Math.round(windowData[15].netSol * 1000) / 1000,
          30: Math.round(windowData[30].netSol * 1000) / 1000,
          60: Math.round(windowData[60].netSol * 1000) / 1000
        }
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

module.exports = VolumeTrendFilter;

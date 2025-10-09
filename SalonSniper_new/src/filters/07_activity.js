const logger = require('../utils/logging');

class ActivityFilter {
  constructor() {
    this.name = '07_activity';
    this.enabled = process.env.POOL_SIZE_ENABLED === 'true';
    this.critical = process.env.POOL_SIZE_CRITICAL === 'true';
    
    this.windowMin = parseInt(process.env.ACT_WINDOW_MIN) || 10;
    this.spikeWindowSec = parseInt(process.env.ACT_SPIKE_WINDOW_SEC) || 60;
    
    this.minTrades10m = parseInt(process.env.ACT_MIN_TRADES_10M) || 40;
    this.minBuyers10m = parseInt(process.env.ACT_MIN_BUYERS_10M) || 25;
    this.minNetSol10m = parseFloat(process.env.ACT_MIN_NET_SOL_10M) || 20;
    this.minBuySellRatio = parseFloat(process.env.ACT_MIN_BUY_SELL) || 1.2;
    this.minTrades1m = parseInt(process.env.ACT_MIN_TRADES_1M) || 12;
    
    this.recentActivityIndex = new Map(); // mint -> events[]
    this.maxMints = 5000;
    this.eventTtlMs = this.windowMin * 60 * 1000;
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      activity_ok: 0,
      activity_low: 0,
      avg_latency_ms: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    this.startCleanupTimer();
    
    logger.info(`📊 ${this.name}: Activity Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      windowMin: this.windowMin,
      thresholds: {
        minTrades10m: this.minTrades10m,
        minBuyers10m: this.minBuyers10m,
        minNetSol10m: this.minNetSol10m,
        minBuySellRatio: this.minBuySellRatio
      }
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000);
  }
  
  startCleanupTimer() {
    setInterval(() => {
      this.cleanupOldEvents();
    }, 60000); // Cleanup every minute
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    const statsData = {
      filter: this.name,
      enabled: this.enabled,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      stats: {
        processed: this.stats.processed,
        passed: this.stats.passed,
        failed: this.stats.failed,
        activity_ok: this.stats.activity_ok,
        activity_low: this.stats.activity_low,
        avg_latency_ms: this.stats.avg_latency_ms,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%'
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.processed / runtimeMinutes) * 10) / 10 : 0
      },
      indexStatus: {
        activeMints: this.recentActivityIndex.size,
        maxMints: this.maxMints
      }
    };
    
    logger.info(`📊 ${this.name}: Statistics Update`, statsData);
  }
  
  async process(tokenData) {
    if (!this.enabled) {
      return {
        pass: true,
        critical: false,
        scoreDelta: 0,
        reason: 'filter_disabled',
        action: 'skipped',
        processingTimeMs: 0
      };
    }
    
    const startTime = Date.now();
    this.stats.processed++;
    
    const { mint, signature } = tokenData;
    
    try {
      this.addActivityEvent(mint, {
        ts: Date.now(),
        side: 'buy', // Simplified - in real implementation would parse from tokenData
        sol: 0.1,    // Simplified - would extract from transaction data
        signer: 'unknown'
      });
      
      const metrics = this.calculateActivityMetrics(mint);
      
      const decision = this.makeDecision(metrics);
      
      const processingTime = Date.now() - startTime;
      this.updateStats(decision, processingTime);
      
      const result = {
        pass: decision.pass,
        critical: false,
        scoreDelta: decision.scoreDelta,
        reason: decision.reason,
        action: decision.action,
        processingTimeMs: processingTime
      };
      
      logger.info(`${decision.pass ? '✅' : '❌'} ${this.name}: ${decision.action.toUpperCase()}`, {
        filter: "07_activity",
        mint: mint,
        result: {
          action: decision.action,
          reason: decision.reason,
          critical: false,
          meta: {
            trades_10m: metrics.trades10m,
            buyers_10m: metrics.uniqueBuyers10m,
            net_SOL_10m: metrics.netSol10m,
            buy_sell: metrics.buySellRatio,
            trades_1m: metrics.trades1m,
            buyers_1m: metrics.uniqueBuyers1m,
            spike: metrics.spike
          }
        },
        timeMs: processingTime,
        signature
      });
      
      return result;
      
    } catch (error) {
      this.stats.failed++;
      
      logger.error(`💥 ${this.name}: Processing error`, {
        mint,
        signature,
        error: error.message
      });
      
      return {
        pass: false,
        critical: false,
        scoreDelta: -0.5,
        reason: 'processing_error',
        action: 'failed',
        processingTimeMs: Date.now() - startTime
      };
    }
  }
  
  addActivityEvent(mint, event) {
    if (!this.recentActivityIndex.has(mint)) {
      this.recentActivityIndex.set(mint, []);
    }
    
    const events = this.recentActivityIndex.get(mint);
    events.push(event);
    
    const cutoff = Date.now() - this.eventTtlMs;
    const filteredEvents = events.filter(e => e.ts > cutoff);
    this.recentActivityIndex.set(mint, filteredEvents);
    
    if (this.recentActivityIndex.size > this.maxMints) {
      const oldestMint = this.recentActivityIndex.keys().next().value;
      this.recentActivityIndex.delete(oldestMint);
    }
  }
  
  calculateActivityMetrics(mint) {
    const events = this.recentActivityIndex.get(mint) || [];
    const now = Date.now();
    
    const window10m = now - (this.windowMin * 60 * 1000);
    const events10m = events.filter(e => e.ts > window10m);
    
    const window1m = now - (this.spikeWindowSec * 1000);
    const events1m = events.filter(e => e.ts > window1m);
    
    const trades10m = events10m.length;
    const uniqueBuyers10m = new Set(events10m.map(e => e.signer)).size;
    const buys10m = events10m.filter(e => e.side === 'buy');
    const sells10m = events10m.filter(e => e.side === 'sell');
    const netSol10m = buys10m.reduce((sum, e) => sum + e.sol, 0) - 
                     sells10m.reduce((sum, e) => sum + e.sol, 0);
    const buySellRatio = sells10m.length > 0 ? buys10m.length / sells10m.length : buys10m.length;
    
    const trades1m = events1m.length;
    const uniqueBuyers1m = new Set(events1m.map(e => e.signer)).size;
    const spike = trades1m >= this.minTrades1m;
    
    return {
      trades10m,
      uniqueBuyers10m,
      netSol10m: Math.round(netSol10m * 100) / 100,
      buySellRatio: Math.round(buySellRatio * 100) / 100,
      trades1m,
      uniqueBuyers1m,
      spike
    };
  }
  
  makeDecision(metrics) {
    const {
      trades10m,
      uniqueBuyers10m,
      netSol10m,
      buySellRatio
    } = metrics;
    
    const baseConditionsMet = 
      trades10m >= this.minTrades10m &&
      uniqueBuyers10m >= this.minBuyers10m &&
      netSol10m >= this.minNetSol10m &&
      buySellRatio >= this.minBuySellRatio;
    
    if (baseConditionsMet) {
      this.stats.activity_ok++;
      return {
        pass: true,
        scoreDelta: 0.1,
        reason: 'activity_ok',
        action: 'passed'
      };
    } else {
      this.stats.activity_low++;
      return {
        pass: false,
        scoreDelta: -0.3,
        reason: 'activity_low',
        action: 'failed'
      };
    }
  }
  
  updateStats(decision, processingTime) {
    if (decision.pass) {
      this.stats.passed++;
    } else {
      this.stats.failed++;
    }
    
    if (this.stats.processed === 1) {
      this.stats.avg_latency_ms = processingTime;
    } else {
      this.stats.avg_latency_ms = Math.round(
        ((this.stats.avg_latency_ms * (this.stats.processed - 1)) + processingTime) / this.stats.processed
      );
    }
  }
  
  cleanupOldEvents() {
    const cutoff = Date.now() - this.eventTtlMs;
    
    for (const [mint, events] of this.recentActivityIndex.entries()) {
      const filteredEvents = events.filter(e => e.ts > cutoff);
      
      if (filteredEvents.length === 0) {
        this.recentActivityIndex.delete(mint);
      } else {
        this.recentActivityIndex.set(mint, filteredEvents);
      }
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      indexSize: this.recentActivityIndex.size,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0
    };
  }
  
  enable() {
    this.enabled = true;
    logger.info(`✅ ${this.name}: Filter enabled`);
  }
  
  disable() {
    this.enabled = false;
    logger.info(`❌ ${this.name}: Filter disabled`);
  }
}

module.exports = ActivityFilter;

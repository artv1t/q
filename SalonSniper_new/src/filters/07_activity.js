const logger = require('../utils/logging');
const { getInstance: getEventBus } = require('../core/eventBus');

class ActivityFilter {
  constructor() {
    this.name = '07_activity';
    this.enabled = process.env.ACTIVITY_FILTER_ENABLED !== 'false';
    this.critical = process.env.ACTIVITY_FILTER_CRITICAL === 'true';
    
    this.mode = process.env.ACTIVITY_MODE || 'TOTAL';
    this.minNetSolTotal = parseFloat(process.env.ACT_MIN_NET_SOL_TOTAL) || 0.20;
    this.minTradesTotal = parseInt(process.env.ACT_MIN_TRADES_TOTAL) || 3;
    this.minBuyersTotal = parseInt(process.env.ACT_MIN_BUYERS_TOTAL) || 2;
    
    this.warmupMs = parseInt(process.env.ACTIVITY_WARMUP_MS) || 1800;
    this.maxWaitMs = parseInt(process.env.ACTIVITY_MAX_WAIT_MS) || 30000;
    this.logEvents = process.env.LOG_ACTIVITY_EVENTS === 'true';
    
    this.watchlist = new Set();
    this.book = new Map();
    this.seen = new Map();
    this.maxSeenSize = 50000;
    this.seenTtlMs = 10 * 60 * 1000;
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      activity_ok: 0,
      activity_low_total: 0,
      eventsIn: 0,
      watchlistSize: 0,
      trackedMints: 0,
      startTime: Date.now()
    };
    
    this.eventBus = getEventBus();
    this.setupEventListeners();
    this.startHeartbeat();
    this.startCleanup();
    
    logger.info(`🎯 ${this.name}: New EventBus ActivityFilter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      mode: this.mode,
      thresholds: {
        netSolTotal: this.minNetSolTotal,
        tradesTotal: this.minTradesTotal,
        buyersTotal: this.minBuyersTotal
      },
      timing: {
        warmupMs: this.warmupMs,
        maxWaitMs: this.maxWaitMs
      }
    });
  }

  setupEventListeners() {
    if (!this.enabled) {
      logger.info(`📴 ${this.name}: Filter disabled`);
      return;
    }

    this.eventBus.on('trade', (tradeData) => {
      this.onTrade(tradeData);
    });

    logger.info(`🎯 ${this.name}: Subscribed to EventBus for trade events`, {
      mode: this.mode,
      thresholds: {
        netSolTotal: this.minNetSolTotal,
        tradesTotal: this.minTradesTotal,
        buyersTotal: this.minBuyersTotal
      }
    });
  }

  onTrade(tradeData) {
    const { mint, sig, buyer, seller, sol, ts } = tradeData;
    
    if (!mint || !this.watchlist.has(mint)) {
      return;
    }

    if (this.seen.has(sig)) {
      return;
    }

    this.seen.set(sig, ts);
    this.stats.eventsIn++;

    if (!this.book.has(mint)) {
      this.book.set(mint, {
        trades: [],
        buyers: new Map(),
        netSol: [],
        lastTs: ts
      });
    }

    const record = this.book.get(mint);
    record.trades.push(ts);
    record.buyers.set(buyer, ts);
    record.netSol.push({ ts, v: sol });
    record.lastTs = ts;

    if (this.logEvents) {
      logger.debug(`📈 ${this.name}: Trade recorded`, {
        mint: mint.substring(0, 8) + '...',
        buyer: buyer.substring(0, 8) + '...',
        sol,
        totalTrades: record.trades.length,
        uniqueBuyers: record.buyers.size
      });
    }

    this.cleanupSeen();
  }

  registerWatch(mint) {
    if (!mint || typeof mint !== 'string') {
      return;
    }

    this.watchlist.add(mint);
    this.stats.watchlistSize = this.watchlist.size;

    if (!this.book.has(mint)) {
      this.book.set(mint, {
        trades: [],
        buyers: new Map(),
        netSol: [],
        lastTs: Date.now()
      });
    }

    logger.debug(`👁️ ${this.name}: Registered watch`, {
      mint: mint.substring(0, 8) + '...',
      watchlistSize: this.watchlist.size
    });
  }

  startHeartbeat() {
    setInterval(() => {
      const heapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      this.stats.trackedMints = this.book.size;
      
      logger.info(`💓 ${this.name}: Heartbeat`, {
        eventsIn: this.stats.eventsIn,
        watchlistSize: this.stats.watchlistSize,
        trackedMints: this.stats.trackedMints,
        heapMB
      });
    }, 10000);
  }

  startCleanup() {
    setInterval(() => {
      this.cleanupOldRecords();
      this.cleanupSeen();
    }, 5000);
  }

  cleanupOldRecords() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;
    
    for (const [mint, record] of this.book.entries()) {
      if (!this.watchlist.has(mint) && (now - record.lastTs) > maxAge) {
        this.book.delete(mint);
      }
    }
  }

  cleanupSeen() {
    if (this.seen.size > this.maxSeenSize) {
      const now = Date.now();
      const entries = Array.from(this.seen.entries());
      
      entries.sort((a, b) => a[1] - b[1]);
      
      const toDelete = entries.slice(0, Math.floor(this.maxSeenSize * 0.3));
      for (const [sig] of toDelete) {
        this.seen.delete(sig);
      }
    }
  }

  async process(tokenData) {
    const startTime = Date.now();
    this.stats.processed++;
    
    const { mint, signature } = tokenData;
    
    try {
      if (!this.enabled) {
        this.stats.passed++;
        const result = {
          pass: true,
          critical: false,
          scoreDelta: 0,
          reason: 'disabled',
          action: 'passed',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`📴 ${this.name}: Filter disabled, passing token`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      if (!this.watchlist.has(mint)) {
        this.registerWatch(mint);
        await this.sleep(this.warmupMs);
      }
      
      const activityResult = await this.checkActivity(mint);
      
      const result = {
        pass: activityResult.pass,
        critical: this.critical && !activityResult.pass,
        scoreDelta: activityResult.pass ? 0.2 : -0.3,
        reason: activityResult.reason,
        action: activityResult.pass ? 'passed' : 'failed',
        processingTimeMs: Date.now() - startTime,
        ...activityResult.metrics
      };
      
      this.updateStats(result);
      
      logger.info(`${result.pass ? '✅' : '❌'} ${this.name}: Token ${result.action}`, {
        mint: mint.substring(0, 8) + '...',
        signature: signature.substring(0, 8) + '...',
        reason: result.reason,
        metrics: activityResult.metrics
      });
      
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

  async checkActivity(mint) {
    try {
      const record = this.book.get(mint);
      
      if (!record) {
        return {
          pass: false,
          reason: 'no_activity',
          metrics: {
            tradesTotal: 0,
            buyersTotal: 0,
            netSolTotal: 0
          }
        };
      }
      
      const tradesTotal = record.trades.length;
      const buyersTotal = record.buyers.size;
      const netSolTotal = record.netSol.reduce((sum, entry) => sum + entry.v, 0);
      
      const meetsThresholds = tradesTotal >= this.minTradesTotal && 
                             buyersTotal >= this.minBuyersTotal && 
                             netSolTotal >= this.minNetSolTotal;
      
      return {
        pass: meetsThresholds,
        reason: meetsThresholds ? 'activity_ok' : 'activity_low_total',
        metrics: {
          tradesTotal,
          buyersTotal,
          netSolTotal: Math.round(netSolTotal * 1000) / 1000
        }
      };
      
    } catch (error) {
      logger.error(`💥 ${this.name}: Activity check error`, { 
        mint: mint.substring(0, 8) + '...', 
        error: error.message 
      });
      return {
        pass: false,
        reason: 'check_error',
        metrics: {
          tradesTotal: 0,
          buyersTotal: 0,
          netSolTotal: 0
        }
      };
    }
  }

  updateStats(result) {
    if (result.pass) {
      this.stats.passed++;
      if (result.reason === 'activity_ok') {
        this.stats.activity_ok++;
      }
    } else {
      this.stats.failed++;
      if (result.reason === 'activity_low_total') {
        this.stats.activity_low_total++;
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      ...this.stats,
      watchlistSize: this.watchlist.size,
      trackedMints: this.book.size
    };
  }

  enable() {
    this.enabled = true;
  }

  disable() {
    this.enabled = false;
  }

  destroy() {
    this.eventBus.removeAllListeners('trade');
  }
}

let instance = null;

function getInstance() {
  if (!instance) {
    instance = new ActivityFilter();
  }
  return instance;
}

module.exports = { ActivityFilter, getInstance, getActivityFilter: getInstance };

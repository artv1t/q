
const logger = require('../utils/logging');
const { getJupiterQuoteUrl, getJupiterHeaders, getJupiterConfig, isMockDisabled } = require('../config/jupiterConfig');

class LocalRouteGateFilter {
  constructor() {
    this.name = '05_localRouteGate';
    this.enabled = process.env.ROUTE_GATE_FILTER_ENABLED !== 'false';
    this.critical = process.env.ROUTE_GATE_CRITICAL === 'true';
    
    // Используем единый конфиг Jupiter
    this.jupiterConfig = getJupiterConfig();
    this.jupiterQuoteUrl = getJupiterQuoteUrl();
    this.jupiterHeaders = getJupiterHeaders();
    this.jupiterApiKey = this.jupiterConfig.apiKey;
    this.jupiterFallbackUrl = this.jupiterConfig.quoteUrl; // Используем тот же URL как fallback
    this.quoteAmountSOL = parseFloat(process.env.JUPITER_QUOTE_AMOUNT_SOL) || 0.05;
    this.maxPriceImpactBps = parseInt(process.env.JUPITER_MAX_PRICE_IMPACT_BPS) || 600;
    this.requestTimeout = parseInt(process.env.JUPITER_REQUEST_TIMEOUT_MS) || 8000;
    this.retries = parseInt(process.env.JUPITER_RETRIES) || 3;
    this.concurrency = parseInt(process.env.JUPITER_REQUEST_CONCURRENCY) || 5;
    this.requestDelay = parseInt(process.env.JUPITER_REQUEST_DELAY_MS) || 100;
    this.mode = process.env.POOLGATE_MODE || 'LOG_ONLY';
    this.cacheTTL = parseInt(process.env.JUPITER_CACHE_TTL_S) * 1000 || 30000;
    this.backoffBase = parseInt(process.env.JUPITER_BACKOFF_BASE_MS) || 200;
    
    this.quoteCache = new Map();
    this.requestQueue = [];
    this.activeRequests = 0;
    this.processing = false;
    
    this.SOL_MINT = 'So11111111111111111111111111111111111111112';
    this.quoteAmountLamports = Math.floor(this.quoteAmountSOL * 1e9);
    
    this.stats = {
      processed: 0,
      passed: 0,
      failed: 0,
      routeFound: 0,
      noRoute: 0,
      highPriceImpact: 0,
      lowPriceImpact: 0,
      cacheHits: 0,
      cacheMisses: 0,
      jupiterRequests: 0,
      jupiterSuccess: 0,
      jupiterErrors: 0,
      jupiterTimeouts: 0,
      jupiter429: 0,
      apiErrors: 0,
      startTime: Date.now()
    };
    
    this.startStatsTimer();
    this.startRequestProcessor();
    
    logger.info(`🔄 ${this.name}: Jupiter RouteGate Filter initialized`, {
      enabled: this.enabled,
      critical: this.critical,
      mode: this.mode,
      jupiterQuoteUrl: this.jupiterQuoteUrl,
      quoteAmountSOL: this.quoteAmountSOL,
      maxPriceImpactBps: this.maxPriceImpactBps,
      requestTimeout: this.requestTimeout,
      retries: this.retries,
      concurrency: this.concurrency,
      requestDelay: this.requestDelay,
      cacheTTL: this.cacheTTL
    });
  }
  
  startStatsTimer() {
    setInterval(() => {
      this.logStats();
    }, 10000);
  }
  
  startRequestProcessor() {
    setInterval(() => {
      this.processRequestQueue();
    }, this.requestDelay);
  }
  
  logStats() {
    const runtime = Date.now() - this.stats.startTime;
    const runtimeMinutes = runtime / 60000;
    
    const statsData = {
      filter: this.name,
      enabled: this.enabled,
      mode: this.mode,
      runtime: {
        ms: runtime,
        minutes: Math.round(runtimeMinutes * 10) / 10
      },
      stats: {
        processed: this.stats.processed,
        passed: this.stats.passed,
        failed: this.stats.failed,
        routeFound: this.stats.routeFound,
        noRoute: this.stats.noRoute,
        highPriceImpact: this.stats.highPriceImpact,
        lowPriceImpact: this.stats.lowPriceImpact,
        cacheHits: this.stats.cacheHits,
        cacheMisses: this.stats.cacheMisses,
        jupiterRequests: this.stats.jupiterRequests,
        jupiterErrors: this.stats.jupiterErrors,
        jupiterTimeouts: this.stats.jupiterTimeouts,
        jupiter429: this.stats.jupiter429,
        apiErrors: this.stats.apiErrors,
        passRate: this.stats.processed > 0 ? 
          Math.round((this.stats.passed / this.stats.processed) * 1000) / 10 + '%' : '0%',
        routeDiscoveryRate: this.stats.processed > 0 ? 
          Math.round((this.stats.routeFound / this.stats.processed) * 1000) / 10 + '%' : '0%',
        cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0 ? 
          Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 1000) / 10 + '%' : '0%'
      },
      throughput: {
        tokensPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.processed / runtimeMinutes) * 10) / 10 : 0,
        jupiterRequestsPerMinute: runtimeMinutes > 0 ? 
          Math.round((this.stats.jupiterRequests / runtimeMinutes) * 10) / 10 : 0
      },
      queueStatus: {
        queueLength: this.requestQueue.length,
        activeRequests: this.activeRequests
      }
    };
    
    logger.info(`📊 ${this.name}: Jupiter Statistics Update`, statsData);
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
      if (!mint || typeof mint !== 'string' || mint.length < 32 || mint.length > 44) {
        this.stats.failed++;
        
        const result = {
          pass: false,
          critical: this.critical,
          scoreDelta: -1.0,
          reason: 'invalid_mint_address',
          action: 'failed',
          error: 'Invalid mint address format',
          processingTimeMs: Date.now() - startTime
        };
        
        logger.info(`❌ ${this.name}: Invalid mint address`, {
          mint,
          signature,
          ...result
        });
        
        return result;
      }
      
      this.stats.passed++;
      
      const result = {
        pass: true,
        critical: false,
        scoreDelta: 0,
        reason: 'disabled',
        action: 'passed_log_only',
        processingTimeMs: Date.now() - startTime
      };
      
      logger.info(`📝 ${this.name}: LOG_ONLY mode`, {
        filter: "05_localRouteGate",
        result: {
          action: "passed_log_only",
          reason: "disabled",
          critical: false
        },
        timeMs: result.processingTimeMs,
        mint,
        signature
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
        mint,
        signature,
        error: error.message,
        ...result
      });
      
      return result;
    }
  }
  
  async processRequestQueue() {
    if (this.processing || this.requestQueue.length === 0 || this.activeRequests >= this.concurrency) {
      return;
    }
    
    this.processing = true;
    
    while (this.requestQueue.length > 0 && this.activeRequests < this.concurrency) {
      const request = this.requestQueue.shift();
      this.activeRequests++;
      
      this.makeJupiterRequest(request)
        .finally(() => {
          this.activeRequests--;
        });
    }
    
    this.processing = false;
  }
  
  async getJupiterQuote(mint) {
    return new Promise((resolve) => {
      const request = {
        mint,
        resolve,
        timestamp: Date.now()
      };
      
      this.requestQueue.push(request);
    });
  }
  
  async makeJupiterRequest(request) {
    const { mint, resolve } = request;
    const queueWaitMs = Date.now() - request.timestamp;
    
    try {
      this.stats.jupiterRequests++;
      
      const url = new URL(getJupiterQuoteUrl());
      url.searchParams.set('inputMint', mint);
      url.searchParams.set('outputMint', this.SOL_MINT);
      url.searchParams.set('amount', this.quoteAmountLamports.toString());
      url.searchParams.set('slippageBps', '50');
      
      const requestStart = Date.now();
      
      logger.debug(`[05] JupiterRequestURL=${url.toString()}`);
      
      const response = await this.fetchWithRetry(url.toString());
      
      const requestMs = Date.now() - requestStart;
      
      logger.debug(`[05] JupiterStatus=${response.status}`);
      
      if (!response.ok) {
        if (response.status === 429) {
          this.stats.jupiter429++;
          logger.warn(`⚠️ ${this.name}: Jupiter rate limit hit`, {
            mint,
            status: response.status,
            queueWaitMs,
            requestMs
          });
        } else {
          this.stats.jupiterErrors++;
          logger.error(`💥 ${this.name}: Jupiter API error`, {
            mint,
            status: response.status,
            statusText: response.statusText,
            queueWaitMs,
            requestMs
          });
        }
        
        resolve(null);
        return;
      }
      
      const data = await response.json();
      this.stats.jupiterSuccess++;
      
      if (!data || !data.data || data.data.length === 0) {
        const result = {
          routeExists: false,
          priceImpactBps: null,
          bestRouteSummary: null,
          timings: { queueWaitMs, requestMs },
          rawResponse: data
        };
        
        logger.debug(`📝 ${this.name}: No Jupiter route found`, {
          mint,
          ...result
        });
        
        resolve(result);
        return;
      }
      
      const bestRoute = data.data[0];
      const priceImpactBps = Math.round((bestRoute.priceImpactPct || 0) * 100);
      
      const bestRouteSummary = {
        platforms: bestRoute.marketInfos?.map(m => m.label) || [],
        outAmount: bestRoute.outAmount,
        inAmount: bestRoute.inAmount,
        steps: bestRoute.routePlan?.length || 0,
        priceImpactPct: bestRoute.priceImpactPct
      };
      
      const result = {
        routeExists: true,
        priceImpactBps: priceImpactBps,
        bestRouteSummary: bestRouteSummary,
        timings: { queueWaitMs, requestMs },
        rawResponse: data
      };
      
      logger.debug(`✅ ${this.name}: Jupiter route found`, {
        mint,
        priceImpactBps,
        platforms: bestRouteSummary.platforms,
        steps: bestRouteSummary.steps,
        ...result.timings
      });
      
      resolve(result);
      
    } catch (error) {
      if (error.name === 'AbortError') {
        this.stats.jupiterTimeouts++;
        logger.warn(`⏰ ${this.name}: Jupiter request timeout`, {
          mint,
          timeout: this.requestTimeout,
          queueWaitMs
        });
      } else {
        this.stats.jupiterErrors++;
        logger.error(`💥 ${this.name}: Jupiter request error`, {
          mint,
          error: error.message,
          queueWaitMs
        });
      }
      
      resolve(null);
    }
  }
  
  async fetchWithRetry(url, attempt = 1) {
    // Если DNS не работает, используем mock данные
    if (!isMockDisabled()) {
      const JupiterMock = require('../../scripts/jupiter_mock');
      const mock = new JupiterMock();
      
      try {
        const quote = await mock.getQuote(
          url.match(/inputMint=([^&]+)/)?.[1] || 'So11111111111111111111111111111111111111112',
          url.match(/outputMint=([^&]+)/)?.[1] || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          parseInt(url.match(/amount=([^&]+)/)?.[1] || '10000000')
        );
        
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(quote)
        };
      } catch (error) {
        throw new Error(`Mock API error: ${error.message}`);
      }
    }
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);
    
    try {
      const headers = getJupiterHeaders();
      
      const response = await fetch(url, {
        method: 'GET',
        headers: headers,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (response.status === 429 && attempt <= this.retries) {
        const backoffMs = this.backoffBase * Math.pow(2, attempt - 1);
        
        logger.debug(`🔄 ${this.name}: Retrying Jupiter request`, {
          attempt,
          backoffMs,
          url: url.split('?')[0]
        });
        
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.fetchWithRetry(url, attempt + 1);
      }
      
      return response;
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      if (error.name === 'AbortError') {
        throw error;
      }
      
      // No fallback for LITE mode - let 404 errors pass through
      
      if (attempt <= this.retries) {
        const backoffMs = this.backoffBase * Math.pow(2, attempt - 1);
        
        logger.debug(`🔄 ${this.name}: Retrying Jupiter request after error`, {
          attempt,
          backoffMs,
          error: error.message,
          url: url.split('?')[0]
        });
        
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this.fetchWithRetry(url, attempt + 1);
      }
      
      throw error;
    }
  }
  
  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      mode: this.mode,
      passRate: this.stats.processed > 0 ? 
        (this.stats.passed / this.stats.processed) * 100 : 0,
      routeDiscoveryRate: this.stats.processed > 0 ? 
        (this.stats.routeFound / this.stats.processed) * 100 : 0,
      cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0 ? 
        (this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100 : 0,
      jupiterSuccessRate: this.stats.jupiterRequests > 0 ? 
        ((this.stats.jupiterRequests - this.stats.jupiterErrors - this.stats.jupiterTimeouts - this.stats.jupiter429) / this.stats.jupiterRequests) * 100 : 0
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
  
  updateConfig(config) {
    if (config.quoteAmountSOL !== undefined) {
      this.quoteAmountSOL = config.quoteAmountSOL;
      this.quoteAmountLamports = Math.floor(this.quoteAmountSOL * 1e9);
    }
    if (config.maxPriceImpactBps !== undefined) this.maxPriceImpactBps = config.maxPriceImpactBps;
    if (config.requestTimeout !== undefined) this.requestTimeout = config.requestTimeout;
    if (config.retries !== undefined) this.retries = config.retries;
    if (config.concurrency !== undefined) this.concurrency = config.concurrency;
    if (config.requestDelay !== undefined) this.requestDelay = config.requestDelay;
    if (config.mode !== undefined) this.mode = config.mode;
    if (config.cacheTTL !== undefined) this.cacheTTL = config.cacheTTL;
    if (config.critical !== undefined) this.critical = config.critical;
    
    logger.info(`🔧 ${this.name}: Jupiter configuration updated`, config);
  }
}

module.exports = LocalRouteGateFilter;

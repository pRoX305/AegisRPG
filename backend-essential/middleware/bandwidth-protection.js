const logger = require('../utils/logger');

class BandwidthProtection {
  constructor() {
    this.queryCount = 0;
    this.dataTransferred = 0;
    this.connectionCount = 0;
    this.startTime = Date.now();
    this.resetInterval = 60 * 1000; // 1 minute
    this.isCircuitOpen = false;
    this.circuitOpenTime = null;

    // Configurable limits
    this.limits = {
      maxQueriesPerMinute: parseInt(process.env.MAX_QUERIES_PER_MINUTE) || 1000,
      maxDataPerMinute: parseInt(process.env.MAX_DATA_PER_MINUTE) || 50 * 1024 * 1024, // 50MB
      maxConcurrentConnections: parseInt(process.env.MAX_CONCURRENT_CONNECTIONS) || 50,
      maxQueryDuration: parseInt(process.env.MAX_QUERY_DURATION) || 30000, // 30 seconds
      circuitBreakerThreshold: parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD) || 10,
      circuitBreakerTimeout: parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT) || 60000 // 1 minute
    };

    this.errorCount = 0;
    this.alertThresholds = {
      queries: this.limits.maxQueriesPerMinute * 0.8, // 80% threshold
      data: this.limits.maxDataPerMinute * 0.8,
      connections: this.limits.maxConcurrentConnections * 0.8
    };

    // Reset counters every minute
    setInterval(() => this.reset(), this.resetInterval);

    logger.info('🛡️  Bandwidth protection initialized:', this.limits);
  }

  reset() {
    const oldCount = this.queryCount;
    const oldData = this.dataTransferred;

    this.queryCount = 0;
    this.dataTransferred = 0;
    this.startTime = Date.now();

    if (oldCount > 0 || oldData > 0) {
      logger.debug('📊 Bandwidth stats reset:', {
        queries: oldCount,
        dataMB: Math.round(oldData / 1024 / 1024 * 100) / 100,
        connections: this.connectionCount
      });
    }

    // Reset circuit breaker if timeout expired
    if (this.isCircuitOpen &&
        this.circuitOpenTime &&
        Date.now() - this.circuitOpenTime > this.limits.circuitBreakerTimeout) {
      this.isCircuitOpen = false;
      this.circuitOpenTime = null;
      this.errorCount = 0;
      logger.info('🔄 Circuit breaker reset - resuming operations');
    }
  }

  checkCircuitBreaker() {
    if (this.isCircuitOpen) {
      const timeOpen = Date.now() - this.circuitOpenTime;
      throw new Error(`Circuit breaker is open. Try again in ${Math.ceil((this.limits.circuitBreakerTimeout - timeOpen) / 1000)} seconds`);
    }
  }

  openCircuitBreaker(reason) {
    this.isCircuitOpen = true;
    this.circuitOpenTime = Date.now();
    logger.error('🚨 Circuit breaker opened:', reason);

    // Alert via webhook or email if configured
    this.sendAlert('CIRCUIT_BREAKER', reason);
  }

  beforeQuery(queryText, params = []) {
    this.checkCircuitBreaker();

    // Check query count limit
    if (this.queryCount >= this.limits.maxQueriesPerMinute) {
      const error = new Error(`Query limit exceeded: ${this.limits.maxQueriesPerMinute}/minute`);
      error.code = 'QUERY_LIMIT_EXCEEDED';
      throw error;
    }

    // Check connection count
    if (this.connectionCount >= this.limits.maxConcurrentConnections) {
      const error = new Error(`Connection limit exceeded: ${this.limits.maxConcurrentConnections}`);
      error.code = 'CONNECTION_LIMIT_EXCEEDED';
      throw error;
    }

    // Detect potentially expensive queries
    const suspiciousPatterns = [
      /SELECT \* FROM .+ WHERE .+ LIKE '%.*%'/i, // Wildcard searches
      /SELECT .+ FROM .+ ORDER BY .+ LIMIT \d{4,}/i, // Large limits
      /DELETE FROM .+ WHERE/i, // Bulk deletes without specific conditions
      /UPDATE .+ SET .+ WHERE .+ LIKE/i // Bulk updates
    ];

    const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(queryText));
    if (isSuspicious && process.env.NODE_ENV === 'production') {
      logger.warn('⚠️  Suspicious query detected:', {
        query: queryText.substring(0, 100) + '...',
        params: params.length
      });
    }

    this.queryCount++;

    // Alert if approaching limits
    if (this.queryCount > this.alertThresholds.queries) {
      this.sendAlert('HIGH_QUERY_USAGE', {
        current: this.queryCount,
        limit: this.limits.maxQueriesPerMinute
      });
    }

    return {
      startTime: Date.now(),
      queryId: `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    };
  }

  afterQuery(queryInfo, result, error = null) {
    const duration = Date.now() - queryInfo.startTime;

    // Track data transfer (approximate)
    if (result && result.rows) {
      const estimatedSize = JSON.stringify(result.rows).length;
      this.dataTransferred += estimatedSize;

      // Check data transfer limit
      if (this.dataTransferred > this.limits.maxDataPerMinute) {
        const overageError = new Error(`Data transfer limit exceeded: ${Math.round(this.limits.maxDataPerMinute / 1024 / 1024)}MB/minute`);
        overageError.code = 'DATA_LIMIT_EXCEEDED';
        logger.error('🚨 Data transfer limit exceeded:', {
          transferred: Math.round(this.dataTransferred / 1024 / 1024 * 100) / 100 + 'MB',
          limit: Math.round(this.limits.maxDataPerMinute / 1024 / 1024) + 'MB'
        });
        this.openCircuitBreaker(overageError.message);
        throw overageError;
      }

      // Alert if approaching data limit
      if (this.dataTransferred > this.alertThresholds.data) {
        this.sendAlert('HIGH_DATA_USAGE', {
          currentMB: Math.round(this.dataTransferred / 1024 / 1024 * 100) / 100,
          limitMB: Math.round(this.limits.maxDataPerMinute / 1024 / 1024)
        });
      }
    }

    // Check query duration
    if (duration > this.limits.maxQueryDuration) {
      logger.warn('🐌 Slow query detected:', {
        duration: duration + 'ms',
        queryId: queryInfo.queryId
      });
    }

    // Handle errors for circuit breaker
    if (error) {
      this.errorCount++;
      if (this.errorCount >= this.limits.circuitBreakerThreshold) {
        this.openCircuitBreaker(`Too many errors: ${this.errorCount}`);
      }
    } else {
      // Reset error count on successful query
      this.errorCount = Math.max(0, this.errorCount - 1);
    }

    logger.debug('📊 Query completed:', {
      queryId: queryInfo.queryId,
      duration: duration + 'ms',
      rows: result?.rowCount || 0,
      error: error?.message
    });
  }

  onConnectionOpen() {
    this.connectionCount++;

    if (this.connectionCount > this.alertThresholds.connections) {
      this.sendAlert('HIGH_CONNECTION_USAGE', {
        current: this.connectionCount,
        limit: this.limits.maxConcurrentConnections
      });
    }
  }

  onConnectionClose() {
    this.connectionCount = Math.max(0, this.connectionCount - 1);
  }

  sendAlert(type, data) {
    const alert = {
      timestamp: new Date().toISOString(),
      type,
      data,
      server: process.env.NODE_ENV || 'development',
      limits: this.limits
    };

    logger.warn(`🚨 ALERT [${type}]:`, data);

    // Send to monitoring service if configured
    if (process.env.WEBHOOK_ALERT_URL) {
      fetch(process.env.WEBHOOK_ALERT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert)
      }).catch(err => logger.error('Failed to send alert webhook:', err));
    }

    // Store alert in database for later analysis
    if (this.queryCount < this.limits.maxQueriesPerMinute - 10) { // Leave buffer for alerts
      this.storeAlert(alert).catch(err => logger.error('Failed to store alert:', err));
    }
  }

  async storeAlert(alert) {
    // This would use your database connection
    // Keeping it simple to avoid circular dependencies
    logger.info('💾 Alert stored:', alert.type);
  }

  getStats() {
    const uptime = Date.now() - this.startTime;
    return {
      uptime: uptime,
      queries: {
        count: this.queryCount,
        limit: this.limits.maxQueriesPerMinute,
        percentage: Math.round((this.queryCount / this.limits.maxQueriesPerMinute) * 100)
      },
      data: {
        transferredMB: Math.round(this.dataTransferred / 1024 / 1024 * 100) / 100,
        limitMB: Math.round(this.limits.maxDataPerMinute / 1024 / 1024),
        percentage: Math.round((this.dataTransferred / this.limits.maxDataPerMinute) * 100)
      },
      connections: {
        active: this.connectionCount,
        limit: this.limits.maxConcurrentConnections,
        percentage: Math.round((this.connectionCount / this.limits.maxConcurrentConnections) * 100)
      },
      circuitBreaker: {
        isOpen: this.isCircuitOpen,
        errorCount: this.errorCount,
        threshold: this.limits.circuitBreakerThreshold
      }
    };
  }

  // Express middleware
  middleware() {
    return (req, res, next) => {
      // Add protection stats to request
      req.bandwidthStats = this.getStats();

      // Add protection methods to request
      req.checkBandwidth = () => this.checkCircuitBreaker();

      next();
    };
  }
}

// Singleton instance
const bandwidthProtection = new BandwidthProtection();

module.exports = bandwidthProtection;

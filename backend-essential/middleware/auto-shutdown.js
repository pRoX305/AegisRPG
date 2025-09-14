const logger = require('../utils/logger');
const db = require('../database/connection');

class AutoShutdown {
  constructor() {
    // Configurable timeouts (in milliseconds)
    this.idleTimeout = parseInt(process.env.AUTO_SHUTDOWN_IDLE_MINUTES) * 60 * 1000 || 2 * 60 * 60 * 1000; // 2 hours default
    this.warningTime = parseInt(process.env.AUTO_SHUTDOWN_WARNING_MINUTES) * 60 * 1000 || 10 * 60 * 1000; // 10 minutes warning
    this.graceTime = parseInt(process.env.AUTO_SHUTDOWN_GRACE_MINUTES) * 60 * 1000 || 5 * 60 * 1000; // 5 minutes grace period

    // Activity tracking
    this.lastActivity = Date.now();
    this.totalRequests = 0;
    this.totalQueries = 0;
    this.connections = 0;
    this.isShuttingDown = false;
    this.warningIssued = false;

    // Activity types that count as "usage"
    this.activityTypes = {
      HTTP_REQUEST: 'http_request',
      DATABASE_QUERY: 'database_query',
      WEBSOCKET_CONNECTION: 'websocket_connection',
      AUTH_ACTION: 'auth_action',
      GAME_ACTION: 'game_action'
    };

    // Skip auto-shutdown in development by default
    this.enabled = process.env.AUTO_SHUTDOWN_ENABLED === 'true' || process.env.NODE_ENV === 'production';

    if (this.enabled) {
      this.startMonitoring();
      logger.info('🕒 Auto-shutdown enabled:', {
        idleTimeout: this.idleTimeout / 1000 / 60 + ' minutes',
        warningTime: this.warningTime / 1000 / 60 + ' minutes',
        graceTime: this.graceTime / 1000 / 60 + ' minutes'
      });
    } else {
      logger.info('🕒 Auto-shutdown disabled (development mode)');
    }
  }

  recordActivity(type = this.activityTypes.HTTP_REQUEST, details = {}) {
    if (!this.enabled || this.isShuttingDown) return;

    this.lastActivity = Date.now();
    this.warningIssued = false; // Reset warning flag on activity

    // Update counters
    switch (type) {
    case this.activityTypes.HTTP_REQUEST:
      this.totalRequests++;
      break;
    case this.activityTypes.DATABASE_QUERY:
      this.totalQueries++;
      break;
    case this.activityTypes.WEBSOCKET_CONNECTION:
      this.connections++;
      break;
    }

    logger.debug('📊 Activity recorded:', {
      type,
      details,
      timeSinceStart: Date.now() - this.startTime,
      totalRequests: this.totalRequests,
      totalQueries: this.totalQueries
    });
  }

  recordDisconnection() {
    this.connections = Math.max(0, this.connections - 1);
  }

  getIdleTime() {
    return Date.now() - this.lastActivity;
  }

  getTimeUntilShutdown() {
    const idleTime = this.getIdleTime();
    return Math.max(0, this.idleTimeout - idleTime);
  }

  isIdle() {
    return this.getIdleTime() > this.idleTimeout;
  }

  shouldWarn() {
    return this.getTimeUntilShutdown() <= this.warningTime && !this.warningIssued;
  }

  async issueShutdownWarning() {
    if (this.warningIssued) return;

    this.warningIssued = true;
    const timeUntilShutdown = Math.round(this.getTimeUntilShutdown() / 1000 / 60);

    logger.warn(`⚠️  AUTO-SHUTDOWN WARNING: Server will shutdown in ${timeUntilShutdown} minutes due to inactivity`);

    // Send alert if webhook configured
    await this.sendAlert({
      type: 'SHUTDOWN_WARNING',
      message: `Server will auto-shutdown in ${timeUntilShutdown} minutes`,
      timeUntilShutdown: timeUntilShutdown,
      lastActivity: new Date(this.lastActivity).toISOString(),
      uptime: this.getUptime()
    });
  }

  async sendAlert(alert) {
    // Send to webhook if configured
    if (process.env.AUTO_SHUTDOWN_WEBHOOK) {
      try {
        await fetch(process.env.AUTO_SHUTDOWN_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...alert,
            server: process.env.NODE_ENV || 'development',
            timestamp: new Date().toISOString(),
            stats: this.getStats()
          })
        });
      } catch (error) {
        logger.error('Failed to send auto-shutdown alert:', error);
      }
    }
  }

  async performShutdown() {
    if (this.isShuttingDown) return;

    this.isShuttingDown = true;

    logger.info('🛑 INITIATING AUTO-SHUTDOWN due to inactivity');

    const shutdownInfo = {
      reason: 'Auto-shutdown due to inactivity',
      lastActivity: new Date(this.lastActivity).toISOString(),
      idleTime: Math.round(this.getIdleTime() / 1000 / 60) + ' minutes',
      uptime: this.getUptime(),
      stats: this.getStats()
    };

    logger.info('📊 Final server statistics:', shutdownInfo.stats);

    // Send final alert
    await this.sendAlert({
      type: 'AUTO_SHUTDOWN_INITIATED',
      message: 'Server shutting down due to inactivity',
      ...shutdownInfo
    });

    // Record shutdown with startup detector
    const startupDetector = require('../scripts/startup-detector');
    startupDetector.handleAutoShutdownComplete(this.getStats());

    // Graceful shutdown sequence
    try {
      // Give a grace period for any final operations
      logger.info(`⏳ Grace period: ${this.graceTime / 1000} seconds for final operations...`);
      await new Promise(resolve => setTimeout(resolve, this.graceTime));

      // Stop monitoring
      this.stopMonitoring();

      // Close database connections
      logger.info('🔌 Closing database connections...');
      await db.close();

      // Log final shutdown message
      logger.info('✅ Auto-shutdown completed successfully');
      logger.info('💡 Server will restart automatically when accessed again');

      // Exit process
      process.exit(0);

    } catch (error) {
      logger.error('❌ Error during auto-shutdown:', error);
      process.exit(1);
    }
  }

  getUptime() {
    const uptimeMs = Date.now() - this.startTime;
    const hours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const minutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${hours}h ${minutes}m`;
  }

  getStats() {
    return {
      uptime: this.getUptime(),
      totalRequests: this.totalRequests,
      totalQueries: this.totalQueries,
      activeConnections: this.connections,
      lastActivity: new Date(this.lastActivity).toISOString(),
      idleTime: Math.round(this.getIdleTime() / 1000 / 60) + ' minutes',
      timeUntilShutdown: Math.round(this.getTimeUntilShutdown() / 1000 / 60) + ' minutes',
      isIdle: this.isIdle(),
      isShuttingDown: this.isShuttingDown
    };
  }

  startMonitoring() {
    this.startTime = Date.now();

    // Check every minute
    this.monitoringInterval = setInterval(() => {
      if (this.isShuttingDown) return;

      // Issue warning if approaching shutdown
      if (this.shouldWarn()) {
        this.issueShutdownWarning();
      }

      // Perform shutdown if idle
      if (this.isIdle()) {
        this.performShutdown();
      }

      // Debug log every 15 minutes in development
      if (process.env.NODE_ENV === 'development' && Date.now() % (15 * 60 * 1000) < 60 * 1000) {
        logger.debug('🕒 Auto-shutdown status:', this.getStats());
      }

    }, 60 * 1000); // Check every minute

    // Log status every hour
    this.statusInterval = setInterval(() => {
      if (!this.isShuttingDown) {
        logger.info('📊 Server activity status:', this.getStats());
      }
    }, 60 * 60 * 1000); // Every hour
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }

  // Express middleware
  middleware() {
    return (req, res, next) => {
      // Record HTTP activity
      this.recordActivity(this.activityTypes.HTTP_REQUEST, {
        method: req.method,
        path: req.path,
        ip: req.ip
      });

      // Add shutdown info to response headers (for monitoring)
      res.set('X-Auto-Shutdown-Enabled', this.enabled.toString());
      if (this.enabled) {
        res.set('X-Time-Until-Shutdown', Math.round(this.getTimeUntilShutdown() / 1000).toString());
        res.set('X-Idle-Time', Math.round(this.getIdleTime() / 1000).toString());
      }

      next();
    };
  }

  // Method to extend idle time (useful for long operations)
  extendIdleTime(additionalMinutes = 30) {
    if (!this.enabled) return;

    this.lastActivity = Date.now() + (additionalMinutes * 60 * 1000);
    this.warningIssued = false;

    logger.info(`⏱️  Idle timer extended by ${additionalMinutes} minutes for long operation`);
  }

  // Method to prevent shutdown (for critical operations)
  preventShutdown() {
    if (!this.enabled) return;

    this.recordActivity(this.activityTypes.HTTP_REQUEST, { type: 'shutdown_prevention' });
    logger.info('🔒 Shutdown prevention activated');
  }
}

// Singleton instance
const autoShutdown = new AutoShutdown();

module.exports = autoShutdown;

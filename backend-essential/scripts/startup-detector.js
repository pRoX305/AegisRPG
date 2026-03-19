require('dotenv').config();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class StartupDetector {
  constructor() {
    // Use /tmp directory in production (App Engine), local logs directory in development
    const logsDir = process.env.NODE_ENV === 'production'
      ? '/tmp/logs'
      : path.join(__dirname, '..', 'logs');

    this.startupFile = path.join(logsDir, 'last-startup.json');
    this.shutdownFile = path.join(logsDir, 'last-shutdown.json');
    this.pidFile = path.join(logsDir, 'server.pid');

    // Ensure logs directory exists
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
    } catch (error) {
      // If we can't create the logs directory, disable file operations
      console.warn('Warning: Could not create logs directory for startup detector:', error.message);
      this.disabled = true;
    }
  }

  recordStartup() {
    const startupInfo = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      env: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 3000,
      autoShutdownEnabled: process.env.AUTO_SHUTDOWN_ENABLED === 'true',
      idleTimeout: parseInt(process.env.AUTO_SHUTDOWN_IDLE_MINUTES) || 120,
      reason: 'manual_start' // Will be updated if auto-restart
    };

    // Skip file operations if disabled
    if (this.disabled) {
      logger.info('📝 Startup recorded (file operations disabled):', {
        timestamp: startupInfo.timestamp,
        reason: startupInfo.reason,
        pid: startupInfo.pid
      });
      return startupInfo;
    }

    // Check if this is a restart after auto-shutdown
    const lastShutdown = this.getLastShutdown();
    if (lastShutdown && this.wasAutoShutdown(lastShutdown)) {
      startupInfo.reason = 'auto_restart_after_shutdown';
      startupInfo.lastShutdown = lastShutdown;

      const downtime = new Date(startupInfo.timestamp) - new Date(lastShutdown.timestamp);
      startupInfo.downtimeMinutes = Math.round(downtime / 1000 / 60);

      logger.info('🔄 Server auto-restarted after shutdown:', {
        downtime: startupInfo.downtimeMinutes + ' minutes',
        lastShutdownReason: lastShutdown.reason
      });
    }

    // Write startup info
    try {
      fs.writeFileSync(this.startupFile, JSON.stringify(startupInfo, null, 2));
      fs.writeFileSync(this.pidFile, process.pid.toString());

      logger.info('📝 Startup recorded:', {
        timestamp: startupInfo.timestamp,
        reason: startupInfo.reason,
        pid: startupInfo.pid
      });
    } catch (error) {
      logger.error('Failed to record startup:', error);
    }

    return startupInfo;
  }

  recordShutdown(reason = 'manual', additionalInfo = {}) {
    const shutdownInfo = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      reason,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      ...additionalInfo
    };

    if (this.disabled) {
      logger.info('📝 Shutdown recorded (file operations disabled):', {
        timestamp: shutdownInfo.timestamp,
        reason: shutdownInfo.reason,
        uptime: Math.round(shutdownInfo.uptime / 60) + ' minutes'
      });
      return shutdownInfo;
    }

    try {
      fs.writeFileSync(this.shutdownFile, JSON.stringify(shutdownInfo, null, 2));

      // Remove PID file
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }

      logger.info('📝 Shutdown recorded:', {
        timestamp: shutdownInfo.timestamp,
        reason: shutdownInfo.reason,
        uptime: Math.round(shutdownInfo.uptime / 60) + ' minutes'
      });
    } catch (error) {
      logger.error('Failed to record shutdown:', error);
    }

    return shutdownInfo;
  }

  getLastStartup() {
    if (this.disabled) return null;

    try {
      if (fs.existsSync(this.startupFile)) {
        const data = fs.readFileSync(this.startupFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to read startup file:', error);
    }
    return null;
  }

  getLastShutdown() {
    if (this.disabled) return null;

    try {
      if (fs.existsSync(this.shutdownFile)) {
        const data = fs.readFileSync(this.shutdownFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to read shutdown file:', error);
    }
    return null;
  }

  wasAutoShutdown(shutdownInfo) {
    return shutdownInfo && shutdownInfo.reason === 'auto_shutdown';
  }

  isServerRunning() {
    try {
      if (fs.existsSync(this.pidFile)) {
        const pid = parseInt(fs.readFileSync(this.pidFile, 'utf8'));

        // Check if process is still running
        try {
          process.kill(pid, 0); // Signal 0 checks if process exists
          return { running: true, pid };
        } catch (error) {
          // Process doesn't exist
          fs.unlinkSync(this.pidFile); // Clean up stale PID file
          return { running: false, pid: null };
        }
      }
    } catch (error) {
      logger.error('Failed to check server status:', error);
    }
    return { running: false, pid: null };
  }

  getStartupStats() {
    const lastStartup = this.getLastStartup();
    const lastShutdown = this.getLastShutdown();
    const serverStatus = this.isServerRunning();

    const stats = {
      current: {
        running: serverStatus.running,
        pid: serverStatus.pid,
        uptime: process.uptime(),
        startTime: new Date(Date.now() - process.uptime() * 1000).toISOString()
      },
      lastStartup,
      lastShutdown,
      history: this.getStartupHistory()
    };

    // Calculate restart frequency
    if (stats.history.length > 1) {
      const recentRestarts = stats.history.filter(h => {
        const age = Date.now() - new Date(h.timestamp);
        return age < 24 * 60 * 60 * 1000; // Last 24 hours
      });

      stats.metrics = {
        restartsLast24h: recentRestarts.length,
        autoRestarts: recentRestarts.filter(h => h.reason === 'auto_restart_after_shutdown').length,
        averageUptimeMinutes: recentRestarts.reduce((sum, h) => sum + (h.uptime || 0), 0) / Math.max(1, recentRestarts.length - 1)
      };
    }

    return stats;
  }

  getStartupHistory() {
    // This could be enhanced to read from a rotating log file
    // For now, just return current startup info
    const current = this.getLastStartup();
    return current ? [current] : [];
  }

  cleanupOldLogs(daysToKeep = 7) {
    // In a full implementation, you'd clean up rotating log files here
    // const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

    // For now, just log the cleanup action
    logger.debug(`🧹 Log cleanup: keeping ${daysToKeep} days of startup/shutdown logs`);
  }

  // Helper method to create a startup webhook
  async sendStartupNotification(startupInfo) {
    if (process.env.STARTUP_WEBHOOK_URL) {
      try {
        await fetch(process.env.STARTUP_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'SERVER_STARTUP',
            message: `Last Aegis server started (${startupInfo.reason})`,
            data: startupInfo,
            timestamp: startupInfo.timestamp
          })
        });

        logger.info('📤 Startup notification sent');
      } catch (error) {
        logger.error('Failed to send startup notification:', error);
      }
    }
  }

  // Integration with auto-shutdown system
  handleAutoShutdownComplete(shutdownStats) {
    this.recordShutdown('auto_shutdown', {
      stats: shutdownStats,
      idleTime: shutdownStats.idleTime,
      lastActivity: shutdownStats.lastActivity
    });
  }
}

// Singleton instance
const startupDetector = new StartupDetector();

module.exports = startupDetector;

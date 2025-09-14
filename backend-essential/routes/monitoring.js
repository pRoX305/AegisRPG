const express = require('express');
const router = express.Router();
const db = require('../database/connection');
const bandwidthProtection = require('../middleware/bandwidth-protection');
const autoShutdown = require('../middleware/auto-shutdown');
const logger = require('../utils/logger');

// Health check with bandwidth stats
router.get('/health', async(req, res) => {
  try {
    const status = db.getStatus();
    const health = {
      status: status.isConnected ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      database: {
        connected: status.isConnected,
        connections: {
          total: status.totalCount,
          idle: status.idleCount,
          waiting: status.waitingCount
        }
      },
      bandwidth: status.bandwidth,
      autoShutdown: autoShutdown.getStats(),
      server: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        env: process.env.NODE_ENV || 'development'
      }
    };

    // Check if any limits are exceeded
    const isOverLimit = status.bandwidth.queries.percentage > 90 ||
                       status.bandwidth.data.percentage > 90 ||
                       status.bandwidth.connections.percentage > 90 ||
                       status.bandwidth.circuitBreaker.isOpen;

    if (isOverLimit) {
      health.status = 'warning';
      health.alerts = [];

      if (status.bandwidth.queries.percentage > 90) {
        health.alerts.push('High query usage');
      }
      if (status.bandwidth.data.percentage > 90) {
        health.alerts.push('High data transfer');
      }
      if (status.bandwidth.connections.percentage > 90) {
        health.alerts.push('High connection usage');
      }
      if (status.bandwidth.circuitBreaker.isOpen) {
        health.alerts.push('Circuit breaker is open');
      }
    }

    res.json(health);
  } catch (error) {
    logger.error('Health check failed:', error);
    res.status(503).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Detailed bandwidth statistics
router.get('/bandwidth', (req, res) => {
  try {
    const stats = bandwidthProtection.getStats();

    res.json({
      timestamp: new Date().toISOString(),
      ...stats,
      recommendations: generateRecommendations(stats)
    });
  } catch (error) {
    logger.error('Bandwidth stats failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Force circuit breaker reset (admin only)
router.post('/circuit-breaker/reset', (req, res) => {
  try {
    // Simple auth check - in production, use proper authentication
    const adminKey = req.headers['x-admin-key'];
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    bandwidthProtection.isCircuitOpen = false;
    bandwidthProtection.circuitOpenTime = null;
    bandwidthProtection.errorCount = 0;

    logger.info('🔄 Circuit breaker manually reset by admin');

    res.json({
      message: 'Circuit breaker reset successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Circuit breaker reset failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Database query metrics (last 100 queries)
router.get('/query-metrics', async(req, res) => {
  try {
    // This would ideally come from a metrics store
    // For now, return current bandwidth stats
    const stats = bandwidthProtection.getStats();

    res.json({
      timestamp: new Date().toISOString(),
      current_period: stats,
      alerts: generateAlerts(stats),
      cost_estimate: calculateCostEstimate(stats)
    });
  } catch (error) {
    logger.error('Query metrics failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint to simulate load (development only)
router.post('/test-load', async(req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Not available in production' });
  }

  try {
    const { queries = 10, dataSize = 1000 } = req.body;

    logger.info(`🧪 Simulating load: ${queries} queries, ${dataSize} bytes each`);

    const results = [];
    for (let i = 0; i < queries; i++) {
      try {
        // Simulate a query
        const result = await db.query('SELECT NOW(), $1::text as data', ['x'.repeat(dataSize)]);
        results.push({ success: true, rows: result.rowCount });
      } catch (error) {
        results.push({ success: false, error: error.message });
      }
    }

    const stats = bandwidthProtection.getStats();

    res.json({
      message: 'Load test completed',
      results,
      final_stats: stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Load test failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

function generateRecommendations(stats) {
  const recommendations = [];

  if (stats.queries.percentage > 70) {
    recommendations.push({
      type: 'performance',
      message: 'Consider implementing query caching or reducing query frequency',
      severity: stats.queries.percentage > 90 ? 'high' : 'medium'
    });
  }

  if (stats.data.percentage > 70) {
    recommendations.push({
      type: 'bandwidth',
      message: 'Consider implementing data pagination or compression',
      severity: stats.data.percentage > 90 ? 'high' : 'medium'
    });
  }

  if (stats.connections.percentage > 70) {
    recommendations.push({
      type: 'connections',
      message: 'Consider implementing connection pooling optimization',
      severity: stats.connections.percentage > 90 ? 'high' : 'medium'
    });
  }

  if (stats.circuitBreaker.errorCount > 5) {
    recommendations.push({
      type: 'reliability',
      message: 'High error rate detected - investigate database issues',
      severity: 'high'
    });
  }

  return recommendations;
}

function generateAlerts(stats) {
  const alerts = [];

  if (stats.queries.percentage > 80) {
    alerts.push({
      type: 'QUERY_USAGE_HIGH',
      message: `Query usage at ${stats.queries.percentage}%`,
      threshold: '80%',
      current: stats.queries.count,
      limit: stats.queries.limit
    });
  }

  if (stats.data.percentage > 80) {
    alerts.push({
      type: 'DATA_USAGE_HIGH',
      message: `Data transfer at ${stats.data.percentage}%`,
      threshold: '80%',
      current: stats.data.transferredMB + 'MB',
      limit: stats.data.limitMB + 'MB'
    });
  }

  if (stats.circuitBreaker.isOpen) {
    alerts.push({
      type: 'CIRCUIT_BREAKER_OPEN',
      message: 'Circuit breaker is open - database operations suspended',
      severity: 'critical'
    });
  }

  return alerts;
}

function calculateCostEstimate(stats) {
  // Rough Google Cloud SQL cost estimation
  const baseInstanceCost = 0.0575; // $0.0575/hour for db-f1-micro
  const storageGBCost = 0.17; // $0.17/GB/month
  const networkEgressCost = 0.12; // $0.12/GB for network egress

  const hoursInMonth = 24 * 30;
  const estimatedMonthlyCost = {
    instance: baseInstanceCost * hoursInMonth,
    storage: storageGBCost * 10, // Assuming 10GB storage
    network: networkEgressCost * (stats.data.transferredMB / 1024), // Per hour estimate
    total: 0
  };

  estimatedMonthlyCost.total =
    estimatedMonthlyCost.instance +
    estimatedMonthlyCost.storage +
    (estimatedMonthlyCost.network * hoursInMonth);

  return {
    currency: 'USD',
    period: 'monthly',
    breakdown: estimatedMonthlyCost,
    notes: [
      'Estimates based on Google Cloud SQL pricing',
      'Actual costs may vary based on usage patterns',
      'Network costs calculated from current transfer rate'
    ]
  };
}

// Auto-shutdown control endpoints
router.get('/shutdown/status', (req, res) => {
  try {
    res.json({
      timestamp: new Date().toISOString(),
      autoShutdown: autoShutdown.getStats(),
      enabled: autoShutdown.enabled
    });
  } catch (error) {
    logger.error('Shutdown status failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Extend idle time (useful for long operations)
router.post('/shutdown/extend', (req, res) => {
  try {
    const { minutes = 30 } = req.body;
    autoShutdown.extendIdleTime(minutes);

    res.json({
      message: `Idle timer extended by ${minutes} minutes`,
      newStats: autoShutdown.getStats(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Extend idle time failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Prevent shutdown temporarily
router.post('/shutdown/prevent', (req, res) => {
  try {
    autoShutdown.preventShutdown();

    res.json({
      message: 'Shutdown prevention activated',
      stats: autoShutdown.getStats(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Prevent shutdown failed:', error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;

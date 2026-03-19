require('dotenv').config();
const logger = require('../utils/logger');
const bandwidthProtection = require('../middleware/bandwidth-protection');

class CostMonitor {
  constructor() {
    this.dailyBudget = parseFloat(process.env.DAILY_BUDGET) || 10; // $10/day default
    this.monthlyBudget = parseFloat(process.env.MONTHLY_BUDGET) || 200; // $200/month default
    this.alertThreshold = parseFloat(process.env.BUDGET_ALERT_THRESHOLD) || 0.8; // 80%

    this.costs = {
      instance: 0.0575, // $0.0575/hour for db-f1-micro
      storage: 0.17 / 30 / 24, // $0.17/GB/month converted to hourly
      networkEgress: 0.12 / 1024, // $0.12/GB converted to MB
      operations: 0.002 / 1000 // $0.002 per 1000 operations
    };

    this.startTime = new Date();
    this.resetHour = parseInt(process.env.BUDGET_RESET_HOUR) || 0; // Midnight UTC

    // Track usage
    this.usage = {
      queries: 0,
      dataMB: 0,
      hoursRunning: 0
    };

    logger.info('💰 Cost monitor initialized:', {
      dailyBudget: this.dailyBudget,
      monthlyBudget: this.monthlyBudget,
      alertThreshold: this.alertThreshold
    });
  }

  calculateCurrentCost() {
    const hoursRunning = (Date.now() - this.startTime) / (1000 * 60 * 60);
    const stats = bandwidthProtection.getStats();

    const costs = {
      instance: this.costs.instance * hoursRunning,
      storage: this.costs.storage * 10 * hoursRunning, // Assuming 10GB
      network: this.costs.networkEgress * stats.data.transferredMB,
      operations: this.costs.operations * stats.queries.count,
      total: 0
    };

    costs.total = costs.instance + costs.storage + costs.network + costs.operations;

    return {
      current: costs,
      projected: {
        daily: costs.total * (24 / hoursRunning),
        monthly: costs.total * (24 * 30 / hoursRunning)
      },
      budget: {
        daily: this.dailyBudget,
        monthly: this.monthlyBudget,
        dailyUsed: costs.total,
        dailyRemaining: Math.max(0, this.dailyBudget - costs.total),
        dailyPercentage: (costs.total / this.dailyBudget) * 100
      }
    };
  }

  checkBudgetLimits() {
    const costInfo = this.calculateCurrentCost();
    const alerts = [];

    // Check daily budget
    if (costInfo.budget.dailyPercentage > this.alertThreshold * 100) {
      alerts.push({
        type: 'BUDGET_ALERT',
        severity: costInfo.budget.dailyPercentage > 95 ? 'critical' : 'warning',
        message: `Daily budget ${costInfo.budget.dailyPercentage.toFixed(1)}% used`,
        budget: costInfo.budget.daily,
        used: costInfo.budget.dailyUsed,
        remaining: costInfo.budget.dailyRemaining
      });
    }

    // Check if projected monthly cost exceeds budget
    if (costInfo.projected.monthly > this.monthlyBudget) {
      alerts.push({
        type: 'MONTHLY_PROJECTION_EXCEEDED',
        severity: 'warning',
        message: `Projected monthly cost $${costInfo.projected.monthly.toFixed(2)} exceeds budget $${this.monthlyBudget}`,
        projection: costInfo.projected.monthly,
        budget: this.monthlyBudget
      });
    }

    // Emergency shutdown if daily budget exceeded by 20%
    if (costInfo.budget.dailyPercentage > 120) {
      alerts.push({
        type: 'EMERGENCY_SHUTDOWN',
        severity: 'critical',
        message: 'Daily budget exceeded by 20% - emergency mode activated',
        budget: costInfo.budget.daily,
        used: costInfo.budget.dailyUsed
      });

      this.activateEmergencyMode();
    }

    return alerts;
  }

  activateEmergencyMode() {
    logger.error('🚨 EMERGENCY MODE ACTIVATED - Budget limit exceeded');

    // Reduce limits drastically
    bandwidthProtection.limits.maxQueriesPerMinute = 50;
    bandwidthProtection.limits.maxDataPerMinute = 1024 * 1024; // 1MB
    bandwidthProtection.limits.maxConcurrentConnections = 5;

    // Send critical alert
    this.sendAlert({
      type: 'EMERGENCY_BUDGET_SHUTDOWN',
      message: 'Database limits reduced due to budget overage',
      timestamp: new Date().toISOString()
    });

    logger.warn('⚠️  Database limits reduced to emergency levels');
  }

  sendAlert(alert) {
    logger.warn('💰 COST ALERT:', alert);

    // Send to webhook if configured
    if (process.env.COST_ALERT_WEBHOOK) {
      fetch(process.env.COST_ALERT_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...alert,
          server: process.env.NODE_ENV || 'development',
          timestamp: new Date().toISOString()
        })
      }).catch(err => logger.error('Failed to send cost alert:', err));
    }
  }

  generateCostReport() {
    const costInfo = this.calculateCurrentCost();
    const stats = bandwidthProtection.getStats();

    return {
      timestamp: new Date().toISOString(),
      period: {
        start: this.startTime.toISOString(),
        duration_hours: (Date.now() - this.startTime) / (1000 * 60 * 60)
      },
      costs: costInfo,
      usage: {
        queries: stats.queries.count,
        data_mb: stats.data.transferredMB,
        connections: stats.connections.active
      },
      efficiency: {
        cost_per_query: costInfo.current.total / Math.max(1, stats.queries.count),
        cost_per_mb: costInfo.current.total / Math.max(1, stats.data.transferredMB),
        queries_per_dollar: Math.max(1, stats.queries.count) / Math.max(0.01, costInfo.current.total)
      },
      recommendations: this.generateCostRecommendations(costInfo, stats)
    };
  }

  generateCostRecommendations(costInfo, stats) {
    const recommendations = [];

    if (costInfo.projected.monthly > this.monthlyBudget * 0.8) {
      recommendations.push({
        type: 'budget',
        priority: 'high',
        message: 'Consider upgrading to a more cost-effective instance tier',
        details: 'Current usage patterns suggest a larger instance with better pricing'
      });
    }

    if (stats.data.transferredMB > 100) {
      recommendations.push({
        type: 'optimization',
        priority: 'medium',
        message: 'Implement data compression or caching to reduce transfer costs',
        savings: 'Could reduce costs by 20-40%'
      });
    }

    if (stats.queries.count > 1000) {
      recommendations.push({
        type: 'optimization',
        priority: 'medium',
        message: 'Implement query caching or batch operations',
        savings: 'Could reduce query costs by 30-50%'
      });
    }

    return recommendations;
  }

  // Start monitoring (call this in your server startup)
  startMonitoring() {
    // Check budget every 15 minutes
    setInterval(() => {
      const alerts = this.checkBudgetLimits();
      alerts.forEach(alert => this.sendAlert(alert));
    }, 15 * 60 * 1000);

    // Generate hourly reports
    setInterval(() => {
      const report = this.generateCostReport();
      logger.info('📊 Hourly cost report:', {
        current_cost: report.costs.current.total.toFixed(4),
        daily_projection: report.costs.projected.daily.toFixed(2),
        budget_used: report.costs.budget.dailyPercentage.toFixed(1) + '%'
      });
    }, 60 * 60 * 1000);

    logger.info('💰 Cost monitoring started');
  }
}

// Singleton instance
const costMonitor = new CostMonitor();

module.exports = costMonitor;

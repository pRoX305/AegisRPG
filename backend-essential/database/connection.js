const { Pool } = require('pg');
const logger = require('../utils/logger');
const bandwidthProtection = require('../middleware/bandwidth-protection');
const autoShutdown = require('../middleware/auto-shutdown');

class DatabaseConnection {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  async initialize() {
    try {
      // Cloud SQL configuration takes precedence
      let config;
      
      if (process.env.CLOUD_SQL_CONNECTION_STRING) {
        // Use Cloud SQL connection string (recommended)
        this.pool = new Pool({
          connectionString: process.env.CLOUD_SQL_CONNECTION_STRING,
          ssl: { rejectUnauthorized: false },
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });
      } else if (process.env.DATABASE_URL) {
        // Use DATABASE_URL if provided (for production)
        this.pool = new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
          max: 20,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });
      } else {
        // Use individual environment variables (local development)
        config = {
          host: process.env.DATABASE_HOST || process.env.CLOUD_SQL_HOST || 'localhost',
          port: parseInt(process.env.DATABASE_PORT || process.env.CLOUD_SQL_PORT) || 5432,
          database: process.env.DATABASE_NAME || process.env.CLOUD_SQL_DATABASE || 'last_aegis',
          user: process.env.DATABASE_USER || process.env.CLOUD_SQL_USER || 'lastaegis_user',
          password: process.env.DATABASE_PASSWORD || process.env.CLOUD_SQL_PASSWORD,
          ssl: process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
          max: 20, // Maximum number of clients in pool
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        };
        
        this.pool = new Pool(config);
      }

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      this.isConnected = true;
      logger.info('✅ Database connection established');
      
      // Set up connection error handlers
      this.pool.on('error', (err) => {
        logger.error('Database pool error:', err);
        this.isConnected = false;
      });

      this.pool.on('connect', () => {
        logger.debug('New database client connected');
        bandwidthProtection.onConnectionOpen();
      });

      this.pool.on('remove', () => {
        logger.debug('Database client removed from pool');
        bandwidthProtection.onConnectionClose();
      });

    } catch (error) {
      logger.error('❌ Database connection failed:', error);
      this.isConnected = false;
      throw error;
    }
  }

  async query(text, params = []) {
    if (!this.isConnected || !this.pool) {
      throw new Error('Database not initialized');
    }

    // Bandwidth protection: check before query
    const queryInfo = bandwidthProtection.beforeQuery(text, params);
    
    let result = null;
    let error = null;
    
    try {
      result = await this.pool.query(text, params);
      const duration = Date.now() - queryInfo.startTime;
      
      // Record database activity for auto-shutdown
      autoShutdown.recordActivity('database_query', {
        duration,
        rows: result.rowCount,
        queryId: queryInfo.queryId
      });
      
      logger.debug('Database query executed', {
        query: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        duration: `${duration}ms`,
        rows: result.rowCount,
        queryId: queryInfo.queryId
      });

      return result;
    } catch (queryError) {
      error = queryError;
      const duration = Date.now() - queryInfo.startTime;
      logger.error('Database query failed', {
        query: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        error: queryError.message,
        duration: `${duration}ms`,
        queryId: queryInfo.queryId
      });
      throw queryError;
    } finally {
      // Bandwidth protection: track after query
      bandwidthProtection.afterQuery(queryInfo, result, error);
    }
  }

  async transaction(callback) {
    if (!this.isConnected || !this.pool) {
      throw new Error('Database not initialized');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.isConnected = false;
      logger.info('Database connection closed');
    }
  }

  getStatus() {
    const poolStatus = {
      isConnected: this.isConnected,
      totalCount: this.pool?.totalCount || 0,
      idleCount: this.pool?.idleCount || 0,
      waitingCount: this.pool?.waitingCount || 0
    };

    const bandwidthStats = bandwidthProtection.getStats();
    
    return {
      ...poolStatus,
      bandwidth: bandwidthStats
    };
  }
}

// Create singleton instance
const db = new DatabaseConnection();

module.exports = db;
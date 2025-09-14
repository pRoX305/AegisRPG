require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// Import database connection
const db = require('./database/connection');

// Import passport configuration
const passport = require('./config/passport');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const matchmakingRoutes = require('./routes/matchmaking');
const monitoringRoutes = require('./routes/monitoring');

// Import middleware
const errorHandler = require('./middleware/errorHandler');
const bandwidthProtection = require('./middleware/bandwidth-protection');
const autoShutdown = require('./middleware/auto-shutdown');
const costMonitor = require('./scripts/cost-monitor');
const startupDetector = require('./scripts/startup-detector');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS configuration
const corsOptions = {
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      process.env.CLIENT_URL || 'http://localhost:8080',
      'lastaegis://', // Custom scheme for mobile app
      /^https:\/\/.*\.lastaegis\.com$/ // Subdomains
    ];

    const isAllowed = allowedOrigins.some(allowed => {
      if (typeof allowed === 'string') return origin === allowed;
      if (allowed instanceof RegExp) return allowed.test(origin);
      return false;
    });

    callback(isAllowed ? null : new Error('Not allowed by CORS'), isAllowed);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));
app.use(compression());

// Request logging
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
} else {
  app.use(morgan('dev'));
}

// Bandwidth protection middleware
app.use(bandwidthProtection.middleware());

// Auto-shutdown middleware
app.use(autoShutdown.middleware());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Initialize Passport
app.use(passport.initialize());

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutes
  max: process.env.RATE_LIMIT_MAX || 100, // limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000, // 15 minutes
  max: process.env.RATE_LIMIT_AUTH_MAX || 5, // limit each IP to 5 auth requests per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.',
    code: 'AUTH_RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(generalLimiter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// API routes
const apiVersion = process.env.API_VERSION || 'v1';

// Monitoring routes (no rate limiting for health checks)
app.use('/monitoring', monitoringRoutes);

app.use(`/api/${apiVersion}/auth`, authLimiter, authRoutes);
app.use(`/api/${apiVersion}/user`, userRoutes);
app.use(`/api/${apiVersion}/matchmaking`, matchmakingRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Last Aegis Authentication Server',
    version: process.env.npm_package_version || '1.0.0',
    apiVersion: apiVersion,
    documentation: `${req.protocol}://${req.get('host')}/docs`,
    endpoints: {
      health: '/health',
      auth: `/api/${apiVersion}/auth`,
      user: `/api/${apiVersion}/user`,
      matchmaking: `/api/${apiVersion}/matchmaking`
    }
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'ENDPOINT_NOT_FOUND',
    path: req.originalUrl,
    method: req.method
  });
});

// Global error handler
app.use(errorHandler);


// Initialize database and start server
async function startServer() {
  try {
    // Record startup
    const startupInfo = startupDetector.recordStartup();
    await startupDetector.sendStartupNotification(startupInfo);

    // Initialize database connection
    logger.info('🔗 Initializing database connection...');
    await db.initialize();
    logger.info('✅ Database connected successfully');

    // Start cost monitoring
    costMonitor.startMonitoring();

    // Start server
    const server = app.listen(PORT, () => {
      logger.info(`🚀 Last Aegis Auth Server running on port ${PORT}`);
      logger.info(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
      logger.info(`🔗 API Base URL: http://localhost:${PORT}/api/${apiVersion}`);

      if (process.env.NODE_ENV === 'development') {
        logger.info('📚 Available endpoints:');
        logger.info(`   POST /api/${apiVersion}/auth/register`);
        logger.info(`   POST /api/${apiVersion}/auth/login`);
        logger.info(`   POST /api/${apiVersion}/auth/refresh`);
        logger.info(`   POST /api/${apiVersion}/auth/logout`);
        logger.info(`   POST /api/${apiVersion}/auth/forgot-password`);
        logger.info(`   GET  /api/${apiVersion}/user/profile`);
        logger.info(`   PUT  /api/${apiVersion}/user/profile`);
        logger.info(`   GET  /api/${apiVersion}/user/stats`);
        logger.info(`   POST /api/${apiVersion}/matchmaking/queue`);
        logger.info(`   GET  /api/${apiVersion}/matchmaking/queue/status`);
        logger.info('   GET  /monitoring/health');
        logger.info('   GET  /monitoring/bandwidth');
      }

      logger.info('🛡️ Bandwidth protection enabled');
      logger.info('💰 Cost monitoring active');
      if (autoShutdown.enabled) {
        logger.info(`🕒 Auto-shutdown enabled: ${process.env.AUTO_SHUTDOWN_IDLE_MINUTES || 120} minutes idle timeout`);
      } else {
        logger.info('🕒 Auto-shutdown disabled (development mode)');
      }
    });

    // Graceful shutdown handlers
    const gracefulShutdown = async(signal) => {
      logger.info(`${signal} received, shutting down gracefully`);

      // Record shutdown
      startupDetector.recordShutdown('manual_signal', { signal });

      server.close(async() => {
        logger.info('HTTP server closed');

        try {
          autoShutdown.stopMonitoring();
          await db.close();
          logger.info('Database connection closed');
        } catch (error) {
          logger.error('Error closing database:', error);
        }

        logger.info('Process terminated');
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();

module.exports = app;

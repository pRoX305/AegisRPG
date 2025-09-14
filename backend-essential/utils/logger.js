const winston = require('winston');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let log = `${timestamp} [${level}] ${message}`;

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
      log += ` ${JSON.stringify(meta)}`;
    }

    return log;
  })
);

// Define transports
const transports = [];

// Console transport (always enabled in development)
if (process.env.NODE_ENV !== 'production') {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.LOG_LEVEL || 'debug'
    })
  );
}

// File transports
transports.push(
  // Combined log file
  new winston.transports.File({
    filename: path.join(logsDir, 'app.log'),
    format: logFormat,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    level: process.env.LOG_LEVEL || 'info'
  }),

  // Error log file
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    format: logFormat,
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 5,
    level: 'error'
  })
);

// Create logger instance
const logger = winston.createLogger({
  format: logFormat,
  transports,
  exitOnError: false,

  // Handle uncaught exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'exceptions.log'),
      format: logFormat
    })
  ],

  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logsDir, 'rejections.log'),
      format: logFormat
    })
  ]
});

// Add console transport in production for critical errors
if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.Console({
      format: consoleFormat,
      level: 'error'
    })
  );
}

// Custom methods for structured logging
logger.security = (message, meta = {}) => {
  logger.info(message, { ...meta, category: 'security' });
};

logger.auth = (message, meta = {}) => {
  logger.info(message, { ...meta, category: 'auth' });
};

logger.db = (message, meta = {}) => {
  logger.debug(message, { ...meta, category: 'database' });
};

logger.api = (message, meta = {}) => {
  logger.info(message, { ...meta, category: 'api' });
};

// Performance logging
logger.perf = (message, duration, meta = {}) => {
  logger.info(message, {
    ...meta,
    duration: `${duration}ms`,
    category: 'performance'
  });
};

// Request logging helper
logger.request = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const { method, url, ip } = req;
    const { statusCode } = res;

    const level = statusCode >= 400 ? 'warn' : 'info';

    logger[level]('HTTP Request', {
      method,
      url,
      statusCode,
      duration: `${duration}ms`,
      ip,
      userAgent: req.get('User-Agent'),
      category: 'http'
    });
  });

  if (next) next();
};

module.exports = logger;

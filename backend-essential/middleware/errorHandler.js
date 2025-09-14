const logger = require('../utils/logger');

/**
 * Global error handling middleware
 * This should be the last middleware in the chain
 */
function errorHandler(err, req, res, next) {
  // If response was already sent, delegate to default Express error handler
  if (res.headersSent) {
    return next(err);
  }

  // Log the error
  logger.error('Unhandled error:', {
    error: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    userId: req.user?.id,
    timestamp: new Date().toISOString()
  });

  // Handle different types of errors
  let statusCode = 500;
  let errorCode = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';

  // Validation errors (express-validator)
  if (err.type === 'ValidationError' || err.name === 'ValidationError') {
    statusCode = 400;
    errorCode = 'VALIDATION_ERROR';
    message = 'Validation failed';
  }

  // Database errors
  if (err.code) {
    switch (err.code) {
    case '23505': // Unique violation
      statusCode = 409;
      errorCode = 'DUPLICATE_ENTRY';
      message = 'Resource already exists';
      break;
    case '23503': // Foreign key violation
      statusCode = 400;
      errorCode = 'FOREIGN_KEY_VIOLATION';
      message = 'Referenced resource does not exist';
      break;
    case '23502': // Not null violation
      statusCode = 400;
      errorCode = 'REQUIRED_FIELD_MISSING';
      message = 'Required field is missing';
      break;
    case '42P01': // Undefined table
      statusCode = 500;
      errorCode = 'DATABASE_ERROR';
      message = 'Database configuration error';
      break;
    case 'ECONNREFUSED':
      statusCode = 503;
      errorCode = 'DATABASE_UNAVAILABLE';
      message = 'Database connection failed';
      break;
    }
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    errorCode = 'INVALID_TOKEN';
    message = 'Invalid authentication token';
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    errorCode = 'TOKEN_EXPIRED';
    message = 'Authentication token expired';
  }

  // Rate limiting errors
  if (err.type === 'rate_limit_exceeded') {
    statusCode = 429;
    errorCode = 'RATE_LIMIT_EXCEEDED';
    message = 'Too many requests, please try again later';
  }

  // File upload errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    statusCode = 413;
    errorCode = 'FILE_TOO_LARGE';
    message = 'File size exceeds limit';
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    statusCode = 400;
    errorCode = 'UNEXPECTED_FILE';
    message = 'Unexpected file in upload';
  }

  // Custom application errors
  if (err.statusCode) {
    statusCode = err.statusCode;
    errorCode = err.code || errorCode;
    message = err.message || message;
  }

  // Don't expose internal error details in production
  const isDevelopment = process.env.NODE_ENV !== 'production';

  const errorResponse = {
    success: false,
    error: message,
    code: errorCode,
    timestamp: new Date().toISOString(),
    requestId: req.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  };

  // Add additional error details in development
  if (isDevelopment) {
    errorResponse.details = {
      originalError: err.message,
      stack: err.stack?.split('\n').slice(0, 10), // Limit stack trace
      url: req.url,
      method: req.method
    };
  }

  // Special handling for 404 errors
  if (statusCode === 404) {
    errorResponse.error = 'Resource not found';
    errorResponse.code = 'NOT_FOUND';
  }

  res.status(statusCode).json(errorResponse);
}

/**
 * 404 handler - should be used before the error handler
 */
function notFoundHandler(req, res, next) {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  error.code = 'NOT_FOUND';
  next(error);
}

/**
 * Async error wrapper
 * Wraps async route handlers to catch promise rejections
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Create custom error
 */
function createError(message, statusCode = 500, code = 'CUSTOM_ERROR') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/**
 * Validation error helper
 */
function validationError(message = 'Validation failed', details = []) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  error.details = details;
  return error;
}

/**
 * Authentication error helper
 */
function authError(message = 'Authentication failed', code = 'AUTH_ERROR') {
  const error = new Error(message);
  error.statusCode = 401;
  error.code = code;
  return error;
}

/**
 * Authorization error helper
 */
function authzError(message = 'Insufficient permissions', code = 'INSUFFICIENT_PERMISSIONS') {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  return error;
}

/**
 * Not found error helper
 */
function notFoundError(message = 'Resource not found', code = 'NOT_FOUND') {
  const error = new Error(message);
  error.statusCode = 404;
  error.code = code;
  return error;
}

/**
 * Conflict error helper
 */
function conflictError(message = 'Resource conflict', code = 'CONFLICT') {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  return error;
}

module.exports = {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  createError,
  validationError,
  authError,
  authzError,
  notFoundError,
  conflictError
};

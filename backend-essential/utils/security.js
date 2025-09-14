const db = require('../database/connection');
const logger = require('./logger');
const crypto = require('crypto');

// Security event types
const SECURITY_EVENTS = {
  USER_REGISTERED: 'USER_REGISTERED',
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_ATTEMPT_INVALID_EMAIL: 'LOGIN_ATTEMPT_INVALID_EMAIL',
  LOGIN_ATTEMPT_INVALID_PASSWORD: 'LOGIN_ATTEMPT_INVALID_PASSWORD',
  LOGIN_ATTEMPT_INACTIVE_ACCOUNT: 'LOGIN_ATTEMPT_INACTIVE_ACCOUNT',
  REGISTRATION_ATTEMPT_DUPLICATE: 'REGISTRATION_ATTEMPT_DUPLICATE',
  TOKEN_REFRESH_SUCCESS: 'TOKEN_REFRESH_SUCCESS',
  TOKEN_REFRESH_FAILED: 'TOKEN_REFRESH_FAILED',
  LOGOUT_SUCCESS: 'LOGOUT_SUCCESS',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',
  DATA_BREACH_ATTEMPT: 'DATA_BREACH_ATTEMPT',
  UNAUTHORIZED_ACCESS_ATTEMPT: 'UNAUTHORIZED_ACCESS_ATTEMPT'
};

// Severity levels
const SEVERITY = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL'
};

/**
 * Log a security event to the database
 */
async function logSecurityEvent(userId, eventType, severity, details = {}, ipAddress = null, userAgent = null) {
  try {
    const result = await db.query(`
      INSERT INTO security_events (user_id, event_type, severity, details, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [userId, eventType, severity, JSON.stringify(details), ipAddress, userAgent]);

    const eventId = result.rows[0].id;

    // Log to application logger as well
    logger.security(`Security event: ${eventType}`, {
      eventId,
      userId,
      severity,
      details,
      ipAddress,
      userAgent
    });

    // Trigger alerts for critical events
    if (severity === SEVERITY.CRITICAL) {
      await handleCriticalSecurityEvent(eventType, userId, details, ipAddress);
    }

    return eventId;
  } catch (error) {
    logger.error('Failed to log security event:', error);
    throw error;
  }
}

/**
 * Handle critical security events
 */
async function handleCriticalSecurityEvent(eventType, userId, details, ipAddress) {
  logger.error(`🚨 CRITICAL SECURITY EVENT: ${eventType}`, {
    userId,
    details,
    ipAddress,
    timestamp: new Date().toISOString()
  });

  // In production, this would trigger alerts, emails, etc.
  // For now, just log the critical event
}

/**
 * Check for suspicious login patterns
 */
async function checkSuspiciousActivity(userId, ipAddress, userAgent) {
  try {
    // Check for multiple failed login attempts from same IP in last 15 minutes
    const recentFailures = await db.query(`
      SELECT COUNT(*) as failure_count
      FROM security_events 
      WHERE ip_address = $1 
        AND event_type IN ('LOGIN_ATTEMPT_INVALID_EMAIL', 'LOGIN_ATTEMPT_INVALID_PASSWORD')
        AND created_at > NOW() - INTERVAL '15 minutes'
    `, [ipAddress]);

    if (parseInt(recentFailures.rows[0].failure_count) >= 5) {
      await logSecurityEvent(userId, SECURITY_EVENTS.SUSPICIOUS_ACTIVITY, SEVERITY.WARNING, {
        reason: 'Multiple failed login attempts from same IP',
        failureCount: recentFailures.rows[0].failure_count
      }, ipAddress, userAgent);
      return true;
    }

    // Check for login from new location (simplified)
    const recentLogins = await db.query(`
      SELECT DISTINCT ip_address
      FROM security_events 
      WHERE user_id = $1 
        AND event_type = 'LOGIN_SUCCESS'
        AND created_at > NOW() - INTERVAL '30 days'
      LIMIT 10
    `, [userId]);

    const knownIPs = recentLogins.rows.map(row => row.ip_address);
    if (!knownIPs.includes(ipAddress) && knownIPs.length > 0) {
      await logSecurityEvent(userId, SECURITY_EVENTS.SUSPICIOUS_ACTIVITY, SEVERITY.INFO, {
        reason: 'Login from new IP address',
        newIP: ipAddress,
        knownIPs: knownIPs.slice(0, 3) // Only log first 3 for privacy
      }, ipAddress, userAgent);
    }

    return false;
  } catch (error) {
    logger.error('Failed to check suspicious activity:', error);
    return false;
  }
}

/**
 * Generate secure random token
 */
function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Hash password with salt
 */
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
}

/**
 * Generate salt for password hashing
 */
function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Verify password against hash
 */
function verifyPassword(password, salt, hash) {
  const computedHash = hashPassword(password, salt);
  return computedHash === hash;
}

/**
 * Sanitize user input to prevent XSS
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') {
    return input;
  }

  return input
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .trim()
    .substring(0, 1000); // Limit length
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Check password strength
 */
function checkPasswordStrength(password) {
  const requirements = {
    minLength: password.length >= 8,
    hasUppercase: /[A-Z]/.test(password),
    hasLowercase: /[a-z]/.test(password),
    hasNumbers: /\d/.test(password),
    hasSpecialChars: /[!@#$%^&*(),.?":{}|<>]/.test(password)
  };

  const score = Object.values(requirements).filter(Boolean).length;

  return {
    score,
    maxScore: 5,
    requirements,
    isStrong: score >= 4,
    isValid: requirements.minLength && requirements.hasUppercase &&
             requirements.hasLowercase && requirements.hasNumbers
  };
}

/**
 * Rate limiting check
 */
async function checkRateLimit(identifier, action, windowMs = 15 * 60 * 1000, maxRequests = 100) {
  try {
    const windowStart = new Date(Date.now() - windowMs);

    // Clean up old entries
    await db.query('DELETE FROM rate_limits WHERE expires_at < NOW()');

    // Check current count
    const result = await db.query(`
      SELECT COUNT(*) as request_count
      FROM rate_limits
      WHERE identifier = $1 AND action = $2 AND window_start > $3
    `, [identifier, action, windowStart]);

    const currentCount = parseInt(result.rows[0].request_count);

    if (currentCount >= maxRequests) {
      await logSecurityEvent(null, SECURITY_EVENTS.RATE_LIMIT_EXCEEDED, SEVERITY.WARNING, {
        identifier,
        action,
        currentCount,
        maxRequests
      });
      return { allowed: false, remaining: 0, resetTime: windowStart };
    }

    // Record this request
    await db.query(`
      INSERT INTO rate_limits (identifier, action, window_start, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (identifier, action, window_start) 
      DO UPDATE SET count = rate_limits.count + 1
    `, [identifier, action, windowStart, new Date(Date.now() + windowMs)]);

    return {
      allowed: true,
      remaining: maxRequests - currentCount - 1,
      resetTime: new Date(Date.now() + windowMs)
    };
  } catch (error) {
    logger.error('Rate limit check failed:', error);
    return { allowed: true, remaining: maxRequests - 1 }; // Fail open for availability
  }
}

module.exports = {
  SECURITY_EVENTS,
  SEVERITY,
  logSecurityEvent,
  checkSuspiciousActivity,
  generateSecureToken,
  hashPassword,
  generateSalt,
  verifyPassword,
  sanitizeInput,
  isValidEmail,
  checkPasswordStrength,
  checkRateLimit
};

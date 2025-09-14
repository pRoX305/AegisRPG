const { verifyAccessToken, extractTokenFromHeader } = require('../utils/jwt');
const db = require('../database/connection');
const logger = require('../utils/logger');

/**
 * Middleware to authenticate requests using JWT tokens
 */
async function authenticateToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractTokenFromHeader(authHeader);

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Access token is required',
        code: 'TOKEN_REQUIRED'
      });
    }

    // Verify the token
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired token',
        code: 'TOKEN_INVALID'
      });
    }

    // Check if session exists and is active
    const sessionResult = await db.query(`
      SELECT us.*, u.email, u.username, u.is_active, u.is_verified
      FROM user_sessions us
      JOIN users u ON us.user_id = u.id
      WHERE us.session_token = $1 AND us.is_active = true AND us.expires_at > NOW()
    `, [token]);

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Session not found or expired',
        code: 'SESSION_INVALID'
      });
    }

    const session = sessionResult.rows[0];

    // Check if user account is still active
    if (!session.is_active) {
      return res.status(401).json({
        success: false,
        error: 'Account is deactivated',
        code: 'ACCOUNT_INACTIVE'
      });
    }

    // Update session last used time
    await db.query(
      'UPDATE user_sessions SET last_used = NOW() WHERE id = $1',
      [session.id]
    );

    // Attach user info to request
    req.user = {
      id: decoded.userId,
      email: session.email,
      username: session.username,
      is_verified: session.is_verified,
      session_id: session.id
    };

    req.token = token;

    logger.debug('Authentication successful', {
      userId: req.user.id,
      username: req.user.username,
      sessionId: req.user.session_id
    });

    next();
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
      code: 'AUTH_ERROR'
    });
  }
}

/**
 * Middleware to optionally authenticate requests
 * If token is provided, it will be validated, but won't fail if missing
 */
async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = extractTokenFromHeader(authHeader);

    if (!token) {
      // No token provided, continue without authentication
      req.user = null;
      req.token = null;
      return next();
    }

    // If token is provided, validate it
    const decoded = verifyAccessToken(token);
    if (!decoded) {
      req.user = null;
      req.token = null;
      return next();
    }

    // Check session
    const sessionResult = await db.query(`
      SELECT us.*, u.email, u.username, u.is_active, u.is_verified
      FROM user_sessions us
      JOIN users u ON us.user_id = u.id
      WHERE us.session_token = $1 AND us.is_active = true AND us.expires_at > NOW()
    `, [token]);

    if (sessionResult.rows.length > 0) {
      const session = sessionResult.rows[0];

      if (session.is_active) {
        req.user = {
          id: decoded.userId,
          email: session.email,
          username: session.username,
          is_verified: session.is_verified,
          session_id: session.id
        };
        req.token = token;

        // Update last used time
        await db.query(
          'UPDATE user_sessions SET last_used = NOW() WHERE id = $1',
          [session.id]
        );
      }
    }

    next();
  } catch (error) {
    logger.error('Optional auth middleware error:', error);
    req.user = null;
    req.token = null;
    next();
  }
}

/**
 * Middleware to require email verification
 */
function requireEmailVerification(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED'
    });
  }

  if (!req.user.is_verified) {
    return res.status(403).json({
      success: false,
      error: 'Email verification required',
      code: 'EMAIL_VERIFICATION_REQUIRED'
    });
  }

  next();
}

/**
 * Middleware to check if user is premium
 */
async function requirePremium(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTH_REQUIRED'
      });
    }

    const profileResult = await db.query(`
      SELECT is_premium, premium_expires
      FROM player_profiles
      WHERE user_id = $1
    `, [req.user.id]);

    if (profileResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Player profile not found',
        code: 'PROFILE_NOT_FOUND'
      });
    }

    const profile = profileResult.rows[0];

    if (!profile.is_premium || (profile.premium_expires && new Date(profile.premium_expires) < new Date())) {
      return res.status(403).json({
        success: false,
        error: 'Premium subscription required',
        code: 'PREMIUM_REQUIRED'
      });
    }

    next();
  } catch (error) {
    logger.error('Premium check middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Premium check failed',
      code: 'PREMIUM_CHECK_ERROR'
    });
  }
}

/**
 * Middleware to check if user has specific role/permission
 */
async function requireRole(role) {
  return async(req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
          code: 'AUTH_REQUIRED'
        });
      }

      // For now, we'll check if user is admin based on email
      // In a real system, you'd have a proper roles table
      const isAdmin = req.user.email === 'admin@lastaegis.com';

      if (role === 'admin' && !isAdmin) {
        logger.warn('Unauthorized admin access attempt', {
          userId: req.user.id,
          email: req.user.email,
          requiredRole: role
        });

        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions',
          code: 'INSUFFICIENT_PERMISSIONS'
        });
      }

      next();
    } catch (error) {
      logger.error('Role check middleware error:', error);
      res.status(500).json({
        success: false,
        error: 'Role check failed',
        code: 'ROLE_CHECK_ERROR'
      });
    }
  };
}

module.exports = {
  authenticateToken,
  optionalAuth,
  requireEmailVerification,
  requirePremium,
  requireRole
};

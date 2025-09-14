const jwt = require('jsonwebtoken');
const logger = require('./logger');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

function generateTokens(userId, payload = {}) {
  try {
    const accessTokenPayload = {
      userId,
      type: 'access',
      ...payload
    };

    const refreshTokenPayload = {
      userId,
      type: 'refresh'
    };

    const accessToken = jwt.sign(accessTokenPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
      issuer: 'last-aegis-auth',
      subject: userId.toString()
    });

    const refreshToken = jwt.sign(refreshTokenPayload, JWT_SECRET, {
      expiresIn: JWT_REFRESH_EXPIRES_IN,
      issuer: 'last-aegis-auth',
      subject: userId.toString()
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: JWT_EXPIRES_IN
    };
  } catch (error) {
    logger.error('Token generation failed:', error);
    throw new Error('Failed to generate tokens');
  }
}

function verifyAccessToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type !== 'access') {
      throw new Error('Invalid token type');
    }

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.debug('Access token expired');
      return null;
    }

    if (error.name === 'JsonWebTokenError') {
      logger.warn('Invalid access token:', error.message);
      return null;
    }

    logger.error('Access token verification failed:', error);
    return null;
  }
}

function verifyRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.type !== 'refresh') {
      throw new Error('Invalid token type');
    }

    return decoded;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      logger.debug('Refresh token expired');
      return null;
    }

    if (error.name === 'JsonWebTokenError') {
      logger.warn('Invalid refresh token:', error.message);
      return null;
    }

    logger.error('Refresh token verification failed:', error);
    return null;
  }
}

function extractTokenFromHeader(authHeader) {
  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

function getTokenExpiration(token) {
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.exp) {
      return new Date(decoded.exp * 1000);
    }
    return null;
  } catch (error) {
    logger.error('Failed to decode token for expiration:', error);
    return null;
  }
}

module.exports = {
  generateTokens,
  verifyAccessToken,
  verifyRefreshToken,
  extractTokenFromHeader,
  getTokenExpiration
};

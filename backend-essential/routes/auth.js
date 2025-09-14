const express = require('express');
const bcrypt = require('bcrypt');
// const jwt = require('jsonwebtoken'); // TODO: Remove if not used
const { body, validationResult } = require('express-validator');
const passport = require('passport');

const db = require('../database/connection');
const { generateTokens, verifyRefreshToken } = require('../utils/jwt');
// const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/email'); // TODO: Implement email functionality
const logger = require('../utils/logger');
const { logSecurityEvent } = require('../utils/security');

const router = express.Router();

// Validation middleware
const registerValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('username')
    .isLength({ min: 3, max: 20 })
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username must be 3-20 characters and contain only letters, numbers, and underscores'),
  body('password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, and numbers')
];

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
];

// Register new user
router.post('/register', registerValidation, async(req, res) => {
  try {
    // Check validation results
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, username, password } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Check if user already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE email = $1 OR username = $2',
      [email, username]
    );

    if (existingUser.rows.length > 0) {
      await logSecurityEvent(null, 'REGISTRATION_ATTEMPT_DUPLICATE', 'WARNING', {
        email, username, ip: clientIp
      });

      return res.status(409).json({
        success: false,
        error: 'User with this email or username already exists',
        code: 'USER_EXISTS'
      });
    }

    // Hash password
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const salt = await bcrypt.genSalt(saltRounds);
    const passwordHash = await bcrypt.hash(password, salt);

    // Create user
    const userResult = await db.query(`
      INSERT INTO users (email, username, password_hash, salt, is_verified)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email, username, created_at
    `, [email, username, passwordHash, salt, process.env.ENABLE_EMAIL_VERIFICATION !== 'true']);

    const user = userResult.rows[0];

    // Create player profile
    await db.query(`
      INSERT INTO player_profiles (user_id, skill_rating, level, region)
      VALUES ($1, $2, $3, $4)
    `, [user.id, 1000, 1, req.body.region || 'NA']);

    // Log security event
    await logSecurityEvent(user.id, 'USER_REGISTERED', 'INFO', {
      email, username, ip: clientIp
    });

    // Send verification email if enabled
    if (process.env.ENABLE_EMAIL_VERIFICATION === 'true') {
      // Generate verification token and send email
      // Implementation depends on email service setup
      logger.info(`Verification email would be sent to ${email}`);
    }

    // Generate tokens
    const tokens = generateTokens(user.id, { email, username });

    // Store session
    await db.query(`
      INSERT INTO user_sessions (user_id, session_token, refresh_token, expires_at, refresh_expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      clientIp,
      userAgent
    ]);

    logger.info(`User registered successfully: ${username} (${email})`);

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        created_at: user.created_at
      },
      tokens: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: '7d'
      }
    });

  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed',
      code: 'REGISTRATION_ERROR'
    });
  }
});

// Login user
router.post('/login', loginValidation, async(req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const { email, password } = req.body;
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    // Get user with profile
    const userResult = await db.query(`
      SELECT 
        u.id, u.email, u.username, u.password_hash, u.is_verified, u.is_active,
        pp.skill_rating, pp.level, pp.region, pp.is_premium, pp.total_matches, pp.total_wins
      FROM users u
      JOIN player_profiles pp ON u.id = pp.user_id
      WHERE u.email = $1
    `, [email]);

    if (userResult.rows.length === 0) {
      await logSecurityEvent(null, 'LOGIN_ATTEMPT_INVALID_EMAIL', 'WARNING', {
        email, ip: clientIp
      });

      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const user = userResult.rows[0];

    // Check if account is active
    if (!user.is_active) {
      await logSecurityEvent(user.id, 'LOGIN_ATTEMPT_INACTIVE_ACCOUNT', 'WARNING', {
        email, ip: clientIp
      });

      return res.status(401).json({
        success: false,
        error: 'Account is deactivated',
        code: 'ACCOUNT_INACTIVE'
      });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      await logSecurityEvent(user.id, 'LOGIN_ATTEMPT_INVALID_PASSWORD', 'WARNING', {
        email, ip: clientIp
      });

      return res.status(401).json({
        success: false,
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    // Generate tokens
    const tokens = generateTokens(user.id, {
      email: user.email,
      username: user.username,
      skill_rating: user.skill_rating
    });

    // Store session
    await db.query(`
      INSERT INTO user_sessions (user_id, session_token, refresh_token, expires_at, refresh_expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      clientIp,
      userAgent
    ]);

    // Log successful login
    await logSecurityEvent(user.id, 'LOGIN_SUCCESS', 'INFO', {
      email, ip: clientIp
    });

    logger.info(`User logged in successfully: ${user.username} (${user.email})`);

    res.json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        skill_rating: user.skill_rating,
        level: user.level,
        region: user.region,
        is_premium: user.is_premium,
        total_matches: user.total_matches,
        total_wins: user.total_wins
      },
      tokens: {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: '7d'
      }
    });

  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
      code: 'LOGIN_ERROR'
    });
  }
});

// Refresh token
router.post('/refresh', async(req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token is required',
        code: 'REFRESH_TOKEN_REQUIRED'
      });
    }

    // Verify refresh token
    const decoded = verifyRefreshToken(refresh_token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        error: 'Invalid refresh token',
        code: 'INVALID_REFRESH_TOKEN'
      });
    }

    // Check if session exists and is active
    const sessionResult = await db.query(`
      SELECT us.*, u.email, u.username, pp.skill_rating
      FROM user_sessions us
      JOIN users u ON us.user_id = u.id
      JOIN player_profiles pp ON u.id = pp.user_id
      WHERE us.refresh_token = $1 AND us.is_active = true AND us.refresh_expires_at > NOW()
    `, [refresh_token]);

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Session not found or expired',
        code: 'SESSION_INVALID'
      });
    }

    const session = sessionResult.rows[0];

    // Generate new tokens
    const newTokens = generateTokens(session.user_id, {
      email: session.email,
      username: session.username,
      skill_rating: session.skill_rating
    });

    // Update session with new tokens
    await db.query(`
      UPDATE user_sessions 
      SET session_token = $1, expires_at = $2, last_used = NOW()
      WHERE id = $3
    `, [
      newTokens.accessToken,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      session.id
    ]);

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      tokens: {
        access_token: newTokens.accessToken,
        refresh_token: refresh_token, // Keep same refresh token
        expires_in: '7d'
      }
    });

  } catch (error) {
    logger.error('Token refresh error:', error);
    res.status(500).json({
      success: false,
      error: 'Token refresh failed',
      code: 'REFRESH_ERROR'
    });
  }
});

// Logout
router.post('/logout', async(req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      // Deactivate session
      await db.query(
        'UPDATE user_sessions SET is_active = false WHERE session_token = $1',
        [token]
      );
    }

    res.json({
      success: true,
      message: 'Logged out successfully'
    });

  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed',
      code: 'LOGOUT_ERROR'
    });
  }
});

// Password reset request
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail()
], async(req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Valid email is required'
      });
    }

    const { email } = req.body;

    // Always return success to prevent email enumeration
    res.json({
      success: true,
      message: 'If an account with that email exists, password reset instructions have been sent.'
    });

    // Check if user exists (but don't reveal this to client)
    const userResult = await db.query('SELECT id FROM users WHERE email = $1', [email]);

    if (userResult.rows.length > 0) {
      // Generate reset token and send email
      // Implementation depends on email service setup
      logger.info(`Password reset would be sent to ${email}`);
    }

  } catch (error) {
    logger.error('Password reset error:', error);
    res.status(500).json({
      success: false,
      error: 'Password reset failed'
    });
  }
});

// OAuth Routes
// Google OAuth
router.get('/google', passport.authenticate('google', {
  scope: ['profile', 'email']
}));

router.get('/google/callback', passport.authenticate('google', {
  session: false,
  failureRedirect: process.env.ERROR_REDIRECT || 'lastaegis://auth/error'
}), async(req, res) => {
  try {
    const { user, isNewUser } = req.user;

    // Generate tokens
    const tokens = generateTokens(user.id, {
      email: user.email,
      username: user.username
    });

    // Store session
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    await db.query(`
      INSERT INTO user_sessions (user_id, session_token, refresh_token, expires_at, refresh_expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      clientIp,
      userAgent
    ]);

    // Log the OAuth login
    await logSecurityEvent(user.id, isNewUser ? 'OAUTH_REGISTRATION' : 'OAUTH_LOGIN_SUCCESS', 'INFO', {
      provider: 'google',
      email: user.email,
      isNewUser,
      ip: clientIp
    });

    const redirectUrl = `${process.env.SUCCESS_REDIRECT || 'lastaegis://auth/success'}?access_token=${tokens.accessToken}&refresh_token=${tokens.refreshToken}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('Google OAuth callback error:', error);
    res.redirect(process.env.ERROR_REDIRECT || 'lastaegis://auth/error');
  }
});

// Apple OAuth
router.get('/apple', passport.authenticate('apple', {
  scope: ['name', 'email']
}));

router.post('/apple/callback', passport.authenticate('apple', {
  session: false,
  failureRedirect: process.env.ERROR_REDIRECT || 'lastaegis://auth/error'
}), async(req, res) => {
  try {
    const { user, isNewUser } = req.user;

    // Generate tokens
    const tokens = generateTokens(user.id, {
      email: user.email,
      username: user.username
    });

    // Store session
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    await db.query(`
      INSERT INTO user_sessions (user_id, session_token, refresh_token, expires_at, refresh_expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      clientIp,
      userAgent
    ]);

    // Log the OAuth login
    await logSecurityEvent(user.id, isNewUser ? 'OAUTH_REGISTRATION' : 'OAUTH_LOGIN_SUCCESS', 'INFO', {
      provider: 'apple',
      email: user.email,
      isNewUser,
      ip: clientIp
    });

    const redirectUrl = `${process.env.SUCCESS_REDIRECT || 'lastaegis://auth/success'}?access_token=${tokens.accessToken}&refresh_token=${tokens.refreshToken}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('Apple OAuth callback error:', error);
    res.redirect(process.env.ERROR_REDIRECT || 'lastaegis://auth/error');
  }
});

// Facebook OAuth
router.get('/facebook', passport.authenticate('facebook', {
  scope: ['email', 'public_profile']
}));

router.get('/facebook/callback', passport.authenticate('facebook', {
  session: false,
  failureRedirect: process.env.ERROR_REDIRECT || 'lastaegis://auth/error'
}), async(req, res) => {
  try {
    const { user, isNewUser } = req.user;

    // Generate tokens
    const tokens = generateTokens(user.id, {
      email: user.email,
      username: user.username
    });

    // Store session
    const clientIp = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    await db.query(`
      INSERT INTO user_sessions (user_id, session_token, refresh_token, expires_at, refresh_expires_at, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      user.id,
      tokens.accessToken,
      tokens.refreshToken,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      clientIp,
      userAgent
    ]);

    // Log the OAuth login
    await logSecurityEvent(user.id, isNewUser ? 'OAUTH_REGISTRATION' : 'OAUTH_LOGIN_SUCCESS', 'INFO', {
      provider: 'facebook',
      email: user.email,
      isNewUser,
      ip: clientIp
    });

    const redirectUrl = `${process.env.SUCCESS_REDIRECT || 'lastaegis://auth/success'}?access_token=${tokens.accessToken}&refresh_token=${tokens.refreshToken}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('Facebook OAuth callback error:', error);
    res.redirect(process.env.ERROR_REDIRECT || 'lastaegis://auth/error');
  }
});

module.exports = router;

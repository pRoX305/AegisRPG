const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');

const db = require('../database/connection');
const { authenticateToken, requireEmailVerification } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');
const { logSecurityEvent } = require('../utils/security');

const router = express.Router();

// Get user profile
router.get('/profile', authenticateToken, asyncHandler(async(req, res) => {
  const userResult = await db.query(`
    SELECT 
      u.id, u.email, u.username, u.created_at, u.last_login, u.is_verified,
      pp.skill_rating, pp.level, pp.experience_points, pp.region, pp.is_premium, pp.premium_expires,
      pp.total_matches, pp.total_wins, pp.total_kills, pp.total_deaths, pp.best_placement,
      pp.currency_coins, pp.currency_gems,
      CASE WHEN pp.total_matches > 0 THEN ROUND((pp.total_wins::DECIMAL / pp.total_matches) * 100, 2) ELSE 0 END as win_rate,
      CASE WHEN pp.total_deaths > 0 THEN ROUND(pp.total_kills::DECIMAL / pp.total_deaths, 2) ELSE pp.total_kills END as kd_ratio
    FROM users u
    JOIN player_profiles pp ON u.id = pp.user_id
    WHERE u.id = $1
  `, [req.user.id]);

  if (userResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'User profile not found',
      code: 'PROFILE_NOT_FOUND'
    });
  }

  const profile = userResult.rows[0];

  // Get recent match history
  const matchHistory = await db.query(`
    SELECT 
      m.id, m.game_mode, m.map_name, m.status, m.start_time, m.end_time,
      mp.placement, mp.kills, mp.deaths, mp.damage_dealt, mp.survival_time
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.user_id = $1
    ORDER BY m.created_at DESC
    LIMIT 10
  `, [req.user.id]);

  res.json({
    success: true,
    user: {
      id: profile.id,
      email: profile.email,
      username: profile.username,
      created_at: profile.created_at,
      last_login: profile.last_login,
      is_verified: profile.is_verified,
      profile: {
        skill_rating: profile.skill_rating,
        level: profile.level,
        experience_points: profile.experience_points,
        region: profile.region,
        is_premium: profile.is_premium,
        premium_expires: profile.premium_expires,
        stats: {
          total_matches: profile.total_matches,
          total_wins: profile.total_wins,
          total_kills: profile.total_kills,
          total_deaths: profile.total_deaths,
          best_placement: profile.best_placement,
          win_rate: parseFloat(profile.win_rate),
          kd_ratio: parseFloat(profile.kd_ratio)
        },
        currency: {
          coins: profile.currency_coins,
          gems: profile.currency_gems
        }
      },
      recent_matches: matchHistory.rows
    }
  });
}));

// Update user profile
router.put('/profile', [
  authenticateToken,
  body('region').optional().isIn(['NA', 'EU', 'AS', 'SA', 'OCE']).withMessage('Invalid region'),
  body('username').optional().isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/).withMessage('Invalid username format')
], asyncHandler(async(req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array()
    });
  }

  const { region, username } = req.body;
  const updates = [];
  const values = [];
  let paramIndex = 1;

  // Check if username is being changed and is available
  if (username && username !== req.user.username) {
    const existingUser = await db.query(
      'SELECT id FROM users WHERE username = $1 AND id != $2',
      [username, req.user.id]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Username already taken',
        code: 'USERNAME_TAKEN'
      });
    }

    updates.push(`username = $${paramIndex}`);
    values.push(username);
    paramIndex++;
  }

  // Update region in player_profiles
  if (region) {
    await db.query(
      'UPDATE player_profiles SET region = $1, updated_at = NOW() WHERE user_id = $2',
      [region, req.user.id]
    );
  }

  // Update users table if needed
  if (updates.length > 0) {
    values.push(req.user.id);
    await db.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${paramIndex}`,
      values
    );
  }

  await logSecurityEvent(req.user.id, 'PROFILE_UPDATED', 'INFO', {
    changes: { region, username }
  });

  logger.info(`Profile updated for user: ${req.user.username}`, {
    userId: req.user.id,
    changes: { region, username }
  });

  res.json({
    success: true,
    message: 'Profile updated successfully'
  });
}));

// Change password
router.put('/password', [
  authenticateToken,
  requireEmailVerification,
  body('current_password').notEmpty().withMessage('Current password is required'),
  body('new_password')
    .isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must be at least 8 characters with uppercase, lowercase, and numbers')
], asyncHandler(async(req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array()
    });
  }

  const { current_password, new_password } = req.body;

  // Get current password hash
  const userResult = await db.query(
    'SELECT password_hash FROM users WHERE id = $1',
    [req.user.id]
  );

  if (userResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'User not found',
      code: 'USER_NOT_FOUND'
    });
  }

  // Verify current password
  const isValidPassword = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
  if (!isValidPassword) {
    await logSecurityEvent(req.user.id, 'PASSWORD_CHANGE_ATTEMPT_INVALID', 'WARNING', {
      ip: req.ip
    });

    return res.status(401).json({
      success: false,
      error: 'Current password is incorrect',
      code: 'INVALID_CURRENT_PASSWORD'
    });
  }

  // Hash new password
  const saltRounds = parseInt(process.env.BCRYPT_ROUNDS) || 12;
  const newPasswordHash = await bcrypt.hash(new_password, saltRounds);

  // Update password
  await db.query(
    'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
    [newPasswordHash, req.user.id]
  );

  // Invalidate all other sessions (force re-login on all devices)
  await db.query(
    'UPDATE user_sessions SET is_active = false WHERE user_id = $1 AND session_token != $2',
    [req.user.id, req.token]
  );

  await logSecurityEvent(req.user.id, 'PASSWORD_CHANGED', 'INFO', {
    sessions_invalidated: true,
    ip: req.ip
  });

  logger.info(`Password changed for user: ${req.user.username}`, {
    userId: req.user.id
  });

  res.json({
    success: true,
    message: 'Password changed successfully. Other sessions have been logged out.'
  });
}));

// Get user statistics
router.get('/stats', authenticateToken, asyncHandler(async(req, res) => {
  const statsResult = await db.query(`
    SELECT 
      pp.*,
      CASE WHEN pp.total_matches > 0 THEN ROUND((pp.total_wins::DECIMAL / pp.total_matches) * 100, 2) ELSE 0 END as win_rate,
      CASE WHEN pp.total_deaths > 0 THEN ROUND(pp.total_kills::DECIMAL / pp.total_deaths, 2) ELSE pp.total_kills END as kd_ratio
    FROM player_profiles pp
    WHERE pp.user_id = $1
  `, [req.user.id]);

  if (statsResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Player profile not found',
      code: 'PROFILE_NOT_FOUND'
    });
  }

  const stats = statsResult.rows[0];

  // Get ranking information
  const rankingResult = await db.query(`
    SELECT 
      COUNT(*) + 1 as rank,
      (SELECT COUNT(*) FROM player_profiles WHERE skill_rating > $1) as players_above
    FROM player_profiles 
    WHERE skill_rating > $1
  `, [stats.skill_rating]);

  const ranking = rankingResult.rows[0];

  // Get recent performance (last 10 matches)
  const recentPerformance = await db.query(`
    SELECT 
      AVG(mp.kills) as avg_kills,
      AVG(mp.placement) as avg_placement,
      COUNT(CASE WHEN mp.placement = 1 THEN 1 END) as recent_wins,
      COUNT(*) as recent_matches
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.user_id = $1 AND m.status = 'COMPLETED'
    ORDER BY m.created_at DESC
    LIMIT 10
  `, [req.user.id]);

  const performance = recentPerformance.rows[0];

  res.json({
    success: true,
    stats: {
      skill_rating: stats.skill_rating,
      level: stats.level,
      experience_points: stats.experience_points,
      region: stats.region,
      is_premium: stats.is_premium,
      total_matches: stats.total_matches,
      total_wins: stats.total_wins,
      total_kills: stats.total_kills,
      total_deaths: stats.total_deaths,
      best_placement: stats.best_placement,
      win_rate: parseFloat(stats.win_rate),
      kd_ratio: parseFloat(stats.kd_ratio),
      ranking: {
        current_rank: parseInt(ranking.rank),
        percentile: ranking.players_above > 0 ?
          Math.round((ranking.players_above / (parseInt(ranking.rank) + ranking.players_above)) * 100) : 100
      },
      recent_performance: {
        avg_kills: parseFloat(performance.avg_kills) || 0,
        avg_placement: parseFloat(performance.avg_placement) || 0,
        recent_wins: parseInt(performance.recent_wins) || 0,
        recent_matches: parseInt(performance.recent_matches) || 0,
        recent_win_rate: parseInt(performance.recent_matches) > 0 ?
          Math.round((parseInt(performance.recent_wins) / parseInt(performance.recent_matches)) * 100) : 0
      },
      currency: {
        coins: stats.currency_coins,
        gems: stats.currency_gems
      }
    }
  });
}));

// Get user inventory
router.get('/inventory', authenticateToken, asyncHandler(async(req, res) => {
  const inventoryResult = await db.query(`
    SELECT item_type, item_id, quantity, acquired_at
    FROM player_inventory
    WHERE user_id = $1
    ORDER BY item_type, acquired_at DESC
  `, [req.user.id]);

  // Group items by type
  const inventory = {};
  inventoryResult.rows.forEach(item => {
    if (!inventory[item.item_type]) {
      inventory[item.item_type] = [];
    }
    inventory[item.item_type].push({
      id: item.item_id,
      quantity: item.quantity,
      acquired_at: item.acquired_at
    });
  });

  res.json({
    success: true,
    inventory
  });
}));

// Get user's active sessions
router.get('/sessions', authenticateToken, asyncHandler(async(req, res) => {
  const sessionsResult = await db.query(`
    SELECT 
      id, ip_address, user_agent, created_at, last_used, expires_at,
      CASE WHEN session_token = $2 THEN true ELSE false END as is_current
    FROM user_sessions
    WHERE user_id = $1 AND is_active = true AND expires_at > NOW()
    ORDER BY last_used DESC
  `, [req.user.id, req.token]);

  res.json({
    success: true,
    sessions: sessionsResult.rows.map(session => ({
      id: session.id,
      ip_address: session.ip_address,
      user_agent: session.user_agent,
      created_at: session.created_at,
      last_used: session.last_used,
      expires_at: session.expires_at,
      is_current: session.is_current
    }))
  });
}));

// Revoke a session
router.delete('/sessions/:sessionId', authenticateToken, asyncHandler(async(req, res) => {
  const { sessionId } = req.params;

  // Verify the session belongs to the user
  const sessionResult = await db.query(
    'SELECT id FROM user_sessions WHERE id = $1 AND user_id = $2',
    [sessionId, req.user.id]
  );

  if (sessionResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND'
    });
  }

  // Deactivate the session
  await db.query(
    'UPDATE user_sessions SET is_active = false WHERE id = $1',
    [sessionId]
  );

  await logSecurityEvent(req.user.id, 'SESSION_REVOKED', 'INFO', {
    revoked_session_id: sessionId,
    ip: req.ip
  });

  res.json({
    success: true,
    message: 'Session revoked successfully'
  });
}));

module.exports = router;

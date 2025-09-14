const express = require('express');
const { body, validationResult } = require('express-validator');

const db = require('../database/connection');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const router = express.Router();

// Game modes
const GAME_MODES = {
  BATTLE_ROYALE_SOLO: 'BATTLE_ROYALE_SOLO',
  BATTLE_ROYALE_DUO: 'BATTLE_ROYALE_DUO',
  BATTLE_ROYALE_SQUAD: 'BATTLE_ROYALE_SQUAD',
  RANKED_SOLO: 'RANKED_SOLO',
  CUSTOM: 'CUSTOM'
};

// Join matchmaking queue
router.post('/queue', [
  authenticateToken,
  body('game_mode').isIn(Object.values(GAME_MODES)).withMessage('Invalid game mode'),
  body('region').optional().isIn(['NA', 'EU', 'AS', 'SA', 'OCE']).withMessage('Invalid region'),
  body('preferences').optional().isObject().withMessage('Preferences must be an object')
], asyncHandler(async(req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array()
    });
  }

  const { game_mode, region, preferences = {} } = req.body;

  // Get player profile for skill rating and region
  const profileResult = await db.query(`
    SELECT skill_rating, region as default_region
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
  const playerRegion = region || profile.default_region;
  const skillRating = profile.skill_rating;

  // Check if player is already in queue
  const existingQueue = await db.query(
    'SELECT id FROM matchmaking_queue WHERE user_id = $1 AND status = $2',
    [req.user.id, 'WAITING']
  );

  if (existingQueue.rows.length > 0) {
    return res.status(409).json({
      success: false,
      error: 'Already in matchmaking queue',
      code: 'ALREADY_IN_QUEUE'
    });
  }

  // Calculate estimated wait time based on current queue
  const queueStats = await db.query(`
    SELECT COUNT(*) as queue_count, AVG(EXTRACT(EPOCH FROM (NOW() - queue_time))) as avg_wait_time
    FROM matchmaking_queue
    WHERE game_mode = $1 AND region = $2 AND status = 'WAITING'
    AND ABS(skill_rating - $3) <= 200
  `, [game_mode, playerRegion, skillRating]);

  const stats = queueStats.rows[0];
  const estimatedWait = Math.max(30, Math.min(300, parseInt(stats.avg_wait_time) || 60)); // 30s - 5min

  // Add to queue
  const queueResult = await db.query(`
    INSERT INTO matchmaking_queue (user_id, game_mode, skill_rating, region, estimated_wait, preferences)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, queue_time
  `, [req.user.id, game_mode, skillRating, playerRegion, estimatedWait, JSON.stringify(preferences)]);

  const queueEntry = queueResult.rows[0];

  logger.info(`Player joined matchmaking queue: ${req.user.username}`, {
    userId: req.user.id,
    gameMode: game_mode,
    skillRating,
    region: playerRegion,
    queueId: queueEntry.id
  });

  res.status(201).json({
    success: true,
    message: 'Joined matchmaking queue',
    queue: {
      id: queueEntry.id,
      game_mode,
      skill_rating: skillRating,
      region: playerRegion,
      queue_time: queueEntry.queue_time,
      estimated_wait: estimatedWait,
      preferences
    }
  });
}));

// Leave matchmaking queue
router.delete('/queue', authenticateToken, asyncHandler(async(req, res) => {
  const result = await db.query(
    'UPDATE matchmaking_queue SET status = $1 WHERE user_id = $2 AND status = $3 RETURNING id',
    ['CANCELLED', req.user.id, 'WAITING']
  );

  if (result.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Not currently in matchmaking queue',
      code: 'NOT_IN_QUEUE'
    });
  }

  logger.info(`Player left matchmaking queue: ${req.user.username}`, {
    userId: req.user.id
  });

  res.json({
    success: true,
    message: 'Left matchmaking queue'
  });
}));

// Get queue status
router.get('/queue/status', authenticateToken, asyncHandler(async(req, res) => {
  const queueResult = await db.query(`
    SELECT id, game_mode, skill_rating, region, queue_time, estimated_wait, preferences, status
    FROM matchmaking_queue
    WHERE user_id = $1 AND status IN ('WAITING', 'MATCHED')
    ORDER BY queue_time DESC
    LIMIT 1
  `, [req.user.id]);

  if (queueResult.rows.length === 0) {
    return res.json({
      success: true,
      in_queue: false,
      queue: null
    });
  }

  const queue = queueResult.rows[0];
  const waitTime = Math.floor((Date.now() - new Date(queue.queue_time).getTime()) / 1000);

  res.json({
    success: true,
    in_queue: true,
    queue: {
      id: queue.id,
      game_mode: queue.game_mode,
      skill_rating: queue.skill_rating,
      region: queue.region,
      queue_time: queue.queue_time,
      wait_time: waitTime,
      estimated_wait: queue.estimated_wait,
      preferences: JSON.parse(queue.preferences || '{}'),
      status: queue.status
    }
  });
}));

// Get match history
router.get('/matches', authenticateToken, asyncHandler(async(req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const offset = (page - 1) * limit;

  const matchesResult = await db.query(`
    SELECT 
      m.id, m.match_code, m.game_mode, m.map_name, m.status, m.start_time, m.end_time,
      m.max_players, m.current_players,
      mp.placement, mp.kills, mp.deaths, mp.damage_dealt, mp.survival_time, mp.team_id
    FROM match_participants mp
    JOIN matches m ON mp.match_id = m.id
    WHERE mp.user_id = $1
    ORDER BY m.created_at DESC
    LIMIT $2 OFFSET $3
  `, [req.user.id, limit, offset]);

  const totalResult = await db.query(
    'SELECT COUNT(*) FROM match_participants WHERE user_id = $1',
    [req.user.id]
  );

  const total = parseInt(totalResult.rows[0].count);
  const totalPages = Math.ceil(total / limit);

  res.json({
    success: true,
    matches: matchesResult.rows.map(match => ({
      id: match.id,
      match_code: match.match_code,
      game_mode: match.game_mode,
      map_name: match.map_name,
      status: match.status,
      start_time: match.start_time,
      end_time: match.end_time,
      max_players: match.max_players,
      current_players: match.current_players,
      player_stats: {
        placement: match.placement,
        kills: match.kills,
        deaths: match.deaths,
        damage_dealt: match.damage_dealt,
        survival_time: match.survival_time,
        team_id: match.team_id
      }
    })),
    pagination: {
      page,
      limit,
      total,
      total_pages: totalPages,
      has_next: page < totalPages,
      has_prev: page > 1
    }
  });
}));

// Get match details
router.get('/matches/:matchId', authenticateToken, asyncHandler(async(req, res) => {
  const { matchId } = req.params;

  // Get match info and verify player participated
  const matchResult = await db.query(`
    SELECT 
      m.*,
      mp.placement as player_placement, mp.kills as player_kills, mp.deaths as player_deaths,
      mp.damage_dealt as player_damage, mp.survival_time as player_survival_time, mp.team_id as player_team
    FROM matches m
    JOIN match_participants mp ON m.id = mp.match_id
    WHERE m.id = $1 AND mp.user_id = $2
  `, [matchId, req.user.id]);

  if (matchResult.rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'Match not found or you did not participate in this match',
      code: 'MATCH_NOT_FOUND'
    });
  }

  const match = matchResult.rows[0];

  // Get all participants (for leaderboard)
  const participantsResult = await db.query(`
    SELECT 
      mp.placement, mp.kills, mp.deaths, mp.damage_dealt, mp.survival_time, mp.team_id,
      u.username, pp.level
    FROM match_participants mp
    JOIN users u ON mp.user_id = u.id
    JOIN player_profiles pp ON u.id = pp.user_id
    WHERE mp.match_id = $1
    ORDER BY mp.placement ASC NULLS LAST, mp.kills DESC
  `, [matchId]);

  res.json({
    success: true,
    match: {
      id: match.id,
      match_code: match.match_code,
      game_mode: match.game_mode,
      map_name: match.map_name,
      region: match.region,
      status: match.status,
      start_time: match.start_time,
      end_time: match.end_time,
      max_players: match.max_players,
      current_players: match.current_players,
      winner_user_id: match.winner_user_id,
      match_data: JSON.parse(match.match_data || '{}'),
      player_stats: {
        placement: match.player_placement,
        kills: match.player_kills,
        deaths: match.player_deaths,
        damage_dealt: match.player_damage,
        survival_time: match.player_survival_time,
        team_id: match.player_team
      },
      leaderboard: participantsResult.rows
    }
  });
}));

// Get queue statistics
router.get('/queue/stats', asyncHandler(async(req, res) => {
  const { game_mode, region } = req.query;

  let whereClause = 'WHERE status = \'WAITING\'';
  const params = [];

  if (game_mode) {
    params.push(game_mode);
    whereClause += ` AND game_mode = $${params.length}`;
  }

  if (region) {
    params.push(region);
    whereClause += ` AND region = $${params.length}`;
  }

  const statsResult = await db.query(`
    SELECT 
      COUNT(*) as total_waiting,
      AVG(EXTRACT(EPOCH FROM (NOW() - queue_time))) as avg_wait_time,
      MIN(skill_rating) as min_skill,
      MAX(skill_rating) as max_skill,
      AVG(skill_rating) as avg_skill
    FROM matchmaking_queue
    ${whereClause}
  `, params);

  // Get stats by game mode
  const modeStatsResult = await db.query(`
    SELECT 
      game_mode,
      COUNT(*) as players_waiting,
      AVG(EXTRACT(EPOCH FROM (NOW() - queue_time))) as avg_wait_time
    FROM matchmaking_queue
    WHERE status = 'WAITING'
    ${region ? 'AND region = $1' : ''}
    GROUP BY game_mode
    ORDER BY players_waiting DESC
  `, region ? [region] : []);

  // Get stats by region
  const regionStatsResult = await db.query(`
    SELECT 
      region,
      COUNT(*) as players_waiting,
      AVG(EXTRACT(EPOCH FROM (NOW() - queue_time))) as avg_wait_time
    FROM matchmaking_queue
    WHERE status = 'WAITING'
    ${game_mode ? 'AND game_mode = $1' : ''}
    GROUP BY region
    ORDER BY players_waiting DESC
  `, game_mode ? [game_mode] : []);

  const stats = statsResult.rows[0];

  res.json({
    success: true,
    queue_stats: {
      total_waiting: parseInt(stats.total_waiting) || 0,
      avg_wait_time: Math.round(parseFloat(stats.avg_wait_time)) || 0,
      skill_range: {
        min: parseInt(stats.min_skill) || 0,
        max: parseInt(stats.max_skill) || 0,
        avg: Math.round(parseFloat(stats.avg_skill)) || 0
      },
      by_game_mode: modeStatsResult.rows.map(row => ({
        game_mode: row.game_mode,
        players_waiting: parseInt(row.players_waiting),
        avg_wait_time: Math.round(parseFloat(row.avg_wait_time)) || 0
      })),
      by_region: regionStatsResult.rows.map(row => ({
        region: row.region,
        players_waiting: parseInt(row.players_waiting),
        avg_wait_time: Math.round(parseFloat(row.avg_wait_time)) || 0
      }))
    }
  });
}));

module.exports = router;

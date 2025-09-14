const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const ServerAuthority = require('./ServerAuthority');
const MatchManager = require('./MatchManager');

/**
 * GameServer handles real-time game mechanics using WebSocket connections
 * Manages tick system for turn-based battle royale gameplay
 */
class GameServer {
  constructor(httpServer) {
    this.httpServer = httpServer;
    this.wss = null;

    // Server Authority - handles all anti-cheat and critical functions
    this.serverAuthority = new ServerAuthority();

    // Match Management - handles match lifecycle and server-side map generation
    this.matchManager = new MatchManager();

    // Game state (server-authoritative)
    this.matches = new Map(); // matchId -> MatchState (legacy - moving to MatchManager)
    this.players = new Map(); // playerId -> PlayerConnection
    this.playersByMatch = new Map(); // matchId -> Set<playerId>

    // Tick system timers
    this.autoAttackInterval = null;
    this.skillInterval = null;
    this.cleanupInterval = null;
    this.isRunning = false;

    // Tick configuration
    this.AUTOATTACK_INTERVAL = 1500; // 1.5 seconds
    this.SKILL_INTERVAL = 3000; // 3.0 seconds
    this.CLEANUP_INTERVAL = 30000; // 30 seconds cleanup

    console.log('GameServer initialized with ServerAuthority anti-cheat system');
  }

  /**
   * Start the WebSocket server and tick system
   */
  start() {
    if (this.isRunning) {
      console.warn('GameServer already running');
      return;
    }

    // Create WebSocket server
    this.wss = new WebSocket.Server({
      server: this.httpServer,
      path: '/game'
    });

    this.wss.on('connection', (ws, req) => {
      this.handleNewConnection(ws, req);
    });

    // Start tick system
    this.startTickSystem();
    this.startCleanupSystem();
    this.isRunning = true;

    console.log('GameServer started with WebSocket on /game and ServerAuthority');
  }

  /**
   * Stop the game server and cleanup
   */
  stop() {
    if (!this.isRunning) return;

    this.stopTickSystem();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.matches.clear();
    this.players.clear();
    this.playersByMatch.clear();
    this.isRunning = false;

    console.log('GameServer stopped with ServerAuthority cleanup');
  }

  /**
   * Handle new WebSocket connection
   */
  handleNewConnection(ws, req) {
    console.log('New WebSocket connection');

    // Parse connection parameters
    const url = new URL(req.url, `http://${req.headers.host}`);
    const matchId = url.searchParams.get('match') || 'lobby';
    // const token = url.searchParams.get('token') || 'guest_token'; // Future: auth validation
    const playerId = url.searchParams.get('player') || this.generatePlayerId();
    const username = url.searchParams.get('username') || `Player_${playerId.slice(-4)}`;

    console.log(`Player connection: ${username} (${playerId}) joining ${matchId}`);

    // TODO: Validate token with main authentication system
    // For now, accept all connections with valid parameters

    // Create enhanced player connection with status tracking
    const playerConnection = {
      ws,
      playerId,
      username,
      matchId,
      connectedAt: new Date(),
      lastPing: Date.now(),
      status: 'connecting', // connecting, connected, in_game, disconnected
      isAlive: true,
      ping: 0,
      gameState: {
        position: {
          world: { x: 0, y: 0 }, // MAP view position
          room: { x: 3, y: 4 }   // ROOM view position
        },
        health: 100,
        maxHealth: 100,
        inCombat: false,
        ready: false,
        alive: true,
        stats: {
          attack: 10,
          defense: 5,
          speed: 5
        },
        lastAttackTime: 0,
        lastMoveTime: Date.now(),
        lastValidPosition: { world: { x: 0, y: 0 }, room: { x: 3, y: 4 } },
        kills: 0,
        lastCombatTime: 0
      }
    };

    // Add to collections
    this.players.set(playerId, playerConnection);

    if (!this.playersByMatch.has(matchId)) {
      this.playersByMatch.set(matchId, new Set());
    }
    this.playersByMatch.get(matchId).add(playerId);

    // Initialize match if needed using MatchManager
    if (!this.matchManager.getMatchState(matchId)) {
      this.createNewMatch(matchId, [{ playerId, username }]);
    } else {
      // Add player to existing match
      this.matchManager.updatePlayerPosition(matchId, playerId, playerConnection.gameState.position);
    }

    // Setup connection handlers
    this.setupConnectionHandlers(playerConnection);

    // Send connection confirmation with player list and map data
    const matchState = this.matchManager.getMatchState(matchId);
    this.sendToPlayer(playerId, {
      type: 'CONNECTION_ESTABLISHED',
      matchId,
      playerId,
      username,
      timestamp: Date.now(),
      connectedPlayers: this.getConnectedPlayersList(matchId),
      mapData: matchState ? {
        seed: matchState.map.seed,
        landmarks: Array.from(matchState.map.landmarks.values())
      } : null
    });

    // Update player status and notify others
    this.updatePlayerStatus(playerId, 'connected');
    this.broadcastPlayerJoined(playerConnection);

    console.log(`Player ${username} (${playerId}) connected to match ${matchId}`);
  }

  /**
   * Setup WebSocket event handlers for a player connection
   */
  setupConnectionHandlers(playerConnection) {
    const { ws, playerId, matchId: _matchId } = playerConnection;

    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handlePlayerMessage(playerId, message);
      } catch (error) {
        console.error(`Invalid message from player ${playerId}:`, error);
      }
    });

    ws.on('close', () => {
      this.handlePlayerDisconnection(playerId);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for player ${playerId}:`, error);
      this.handlePlayerDisconnection(playerId);
    });

    ws.on('pong', () => {
      playerConnection.lastPing = Date.now();
    });
  }

  /**
   * Handle incoming message from player
   */
  handlePlayerMessage(playerId, message) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection) return;

    const { matchId } = playerConnection;

    switch (message.type) {
    case 'PING':
      this.sendToPlayer(playerId, { type: 'PONG', timestamp: Date.now() });
      playerConnection.lastPing = Date.now();
      break;

    case 'MOVE_REQUEST':
      this.handleMoveRequest(playerId, message);
      break;

    case 'POSITION_UPDATE':
      this.handlePositionUpdate(playerId, message);
      break;

    case 'ATTACK_REQUEST':
      this.handleAttackRequest(playerId, message);
      break;

    case 'ITEM_ACTION':
      this.handleItemAction(playerId, message);
      break;

    case 'QUEUE_ACTION':
      this.handleActionQueue(playerId, matchId, message.action);
      break;

    case 'PLAYER_READY':
      this.handlePlayerReady(playerId, matchId);
      break;

    case 'STATUS_UPDATE':
      this.handleStatusUpdate(playerId, message);
      break;

    default:
      console.warn(`Unknown message type from player ${playerId}:`, message.type);
    }
  }

  /**
   * Handle player disconnection
   */
  handlePlayerDisconnection(playerId) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection) return;

    const { matchId } = playerConnection;

    // Remove from collections
    this.players.delete(playerId);

    if (this.playersByMatch.has(matchId)) {
      this.playersByMatch.get(matchId).delete(playerId);

      // Clean up empty match
      if (this.playersByMatch.get(matchId).size === 0) {
        this.playersByMatch.delete(matchId);
        this.matches.delete(matchId);
      }
    }

    console.log(`Player ${playerId} disconnected from match ${matchId}`);
  }

  /**
   * Initialize a new match
   */
  initializeMatch(matchId) {
    const matchState = {
      id: matchId,
      status: 'WAITING',
      players: new Map(), // playerId -> PlayerState
      actionQueues: new Map(), // playerId -> ActionQueue
      roundNumber: 0,
      createdAt: Date.now()
    };

    this.matches.set(matchId, matchState);
    console.log(`Initialized match ${matchId}`);
  }

  /**
   * Create a new match using MatchManager with server-side map generation
   */
  createNewMatch(matchId, players) {
    const matchState = this.matchManager.createMatch(players);

    // Override matchId if provided (for testing/specific cases)
    if (matchId !== matchState.matchId) {
      console.log(`Creating match with specific ID: ${matchId} (generated: ${matchState.matchId})`);
      // We'll use the MatchManager's generated ID and map it to the requested ID
      // This ensures consistent map generation while allowing custom match IDs
    }

    // Start the match
    this.matchManager.startMatch(matchState.matchId);

    console.log(`Created and started match ${matchState.matchId} with server-generated map (seed: ${matchState.map.seed})`);
    return matchState;
  }

  /**
   * Start the tick system
   */
  startTickSystem() {
    // AutoAttack tick every 1.5 seconds
    this.autoAttackInterval = setInterval(() => {
      this.processAutoAttackTick();
    }, this.AUTOATTACK_INTERVAL);

    // Skill tick every 3.0 seconds
    this.skillInterval = setInterval(() => {
      this.processSkillTick();
    }, this.SKILL_INTERVAL);

    console.log(`Tick system started - AutoAttack: ${this.AUTOATTACK_INTERVAL}ms, Skills: ${this.SKILL_INTERVAL}ms`);
  }

  /**
   * Stop the tick system
   */
  stopTickSystem() {
    if (this.autoAttackInterval) {
      clearInterval(this.autoAttackInterval);
      this.autoAttackInterval = null;
    }

    if (this.skillInterval) {
      clearInterval(this.skillInterval);
      this.skillInterval = null;
    }

    console.log('Tick system stopped');
  }

  /**
   * Process autoattack tick for all active matches
   */
  processAutoAttackTick() {
    const timestamp = Date.now();

    for (const [matchId, matchState] of this.matches) {
      if (matchState.status !== 'ACTIVE') continue;

      matchState.roundNumber++;

      // Calculate autoattack results
      const results = this.calculateAutoAttacks(matchId);

      // Broadcast tick to all players in match
      this.broadcastToMatch(matchId, {
        type: 'AUTOATTACK_TICK',
        matchId,
        round: matchState.roundNumber,
        timestamp,
        results
      });
    }

    console.log(`Processed autoattack tick for ${this.matches.size} matches`);
  }

  /**
   * Process skill tick for all active matches
   */
  processSkillTick() {
    const timestamp = Date.now();

    for (const [matchId, matchState] of this.matches) {
      if (matchState.status !== 'ACTIVE') continue;

      // Calculate skill/spell results
      const results = this.calculateSkillsAndSpells(matchId);

      // Broadcast tick to all players in match
      this.broadcastToMatch(matchId, {
        type: 'SKILL_TICK',
        matchId,
        round: matchState.roundNumber,
        timestamp,
        results
      });
    }

    console.log(`Processed skill tick for ${this.matches.size} matches`);
  }

  /**
   * Calculate autoattack results for a match
   */
  calculateAutoAttacks(matchId) {
    // TODO: Implement actual combat logic
    // For now, return mock results
    return {
      combatResults: [],
      playerUpdates: {},
      message: 'AutoAttack round processed'
    };
  }

  /**
   * Calculate skill and spell results for a match
   */
  calculateSkillsAndSpells(matchId) {
    // TODO: Implement actual skill/spell logic
    // For now, return mock results
    return {
      skillResults: [],
      spellResults: [],
      playerUpdates: {},
      message: 'Skill/Spell round processed'
    };
  }

  /**
   * Handle action queuing from players
   */
  handleActionQueue(playerId, matchId, action) {
    const matchState = this.matches.get(matchId);
    if (!matchState) return;

    // TODO: Implement action queuing logic
    console.log(`Player ${playerId} queued action:`, action);
  }

  /**
   * Handle player ready status
   */
  handlePlayerReady(playerId, matchId) {
    const matchState = this.matches.get(matchId);
    if (!matchState) return;

    const playerConnection = this.players.get(playerId);
    if (playerConnection) {
      playerConnection.gameState.ready = true;
      this.updatePlayerStatus(playerId, 'ready');
    }

    console.log(`Player ${playerId} is ready in match ${matchId}`);
  }

  /**
   * SERVER-AUTHORITATIVE: Handle movement request
   */
  handleMoveRequest(playerId, message) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection || !playerConnection.gameState.alive) return;

    const fromPos = playerConnection.gameState.position;
    const toPos = message.position;
    const timestamp = message.timestamp || Date.now();

    // Validate movement with ServerAuthority
    const validatedPosition = this.serverAuthority.validateMovement(
      playerId, fromPos, toPos, timestamp, playerConnection
    );

    if (validatedPosition) {
      // Update server-side position
      playerConnection.gameState.position = validatedPosition;
      playerConnection.gameState.lastValidPosition = validatedPosition;
      playerConnection.gameState.lastMoveTime = timestamp;

      // Broadcast validated position to all players in match
      this.broadcastToMatch(playerConnection.matchId, {
        type: 'PLAYER_MOVED',
        playerId,
        position: validatedPosition,
        timestamp: Date.now()
      });

      console.log(`Player ${playerId} moved to:`, validatedPosition);
    } else {
      // Send correction to client
      this.sendToPlayer(playerId, {
        type: 'POSITION_CORRECTION',
        position: playerConnection.gameState.lastValidPosition,
        reason: 'Invalid movement detected',
        timestamp: Date.now()
      });

      console.log(`Movement correction sent to player ${playerId}`);
    }
  }

  /**
   * SERVER-AUTHORITATIVE: Handle attack request
   */
  handleAttackRequest(playerId, message) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection || !playerConnection.gameState.alive) return;

    const targetId = message.targetId;
    const timestamp = message.timestamp || Date.now();

    // Validate and process combat with ServerAuthority
    const combatResult = this.serverAuthority.validateCombatAction(
      playerId, targetId, 'ATTACK', timestamp, {
        players: this.players,
        matches: this.matches
      }
    );

    if (combatResult) {
      // Broadcast combat result to all players in match
      this.broadcastToMatch(playerConnection.matchId, {
        type: 'COMBAT_RESULT',
        ...combatResult
      });

      // Check for player death
      if (combatResult.isDead) {
        this.handlePlayerDeath(targetId, playerId, timestamp);
      }

      console.log(`Combat: ${playerId} -> ${targetId}, damage: ${combatResult.damage}`);
    } else {
      // Send rejection to client
      this.sendToPlayer(playerId, {
        type: 'ATTACK_REJECTED',
        reason: 'Invalid attack request',
        timestamp: Date.now()
      });
    }
  }

  /**
   * SERVER-AUTHORITATIVE: Handle item action
   */
  handleItemAction(playerId, message) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection || !playerConnection.gameState.alive) return;

    const itemId = message.itemId;
    const actionType = message.actionType; // 'PICKUP', 'USE', 'DROP'
    const timestamp = message.timestamp || Date.now();

    // Validate item action with ServerAuthority
    const itemResult = this.serverAuthority.validateItemAction(
      playerId, itemId, actionType, timestamp, {
        players: this.players,
        matches: this.matches
      }
    );

    if (itemResult) {
      // Broadcast item action result
      this.broadcastToMatch(playerConnection.matchId, {
        type: 'ITEM_ACTION_RESULT',
        playerId,
        itemId,
        actionType,
        result: itemResult,
        timestamp: Date.now()
      });

      console.log(`Item action: ${playerId} ${actionType} ${itemId}`);
    } else {
      this.sendToPlayer(playerId, {
        type: 'ITEM_ACTION_REJECTED',
        itemId,
        actionType,
        reason: 'Invalid item action',
        timestamp: Date.now()
      });
    }
  }

  /**
   * Handle status update request
   */
  handleStatusUpdate(playerId, message) {
    const requestedStatus = message.status;

    // Only allow certain status changes
    const allowedStatuses = ['ready', 'not_ready', 'in_game', 'spectating'];
    if (allowedStatuses.includes(requestedStatus)) {
      this.updatePlayerStatus(playerId, requestedStatus);
    } else {
      console.warn(`Invalid status change request from ${playerId}: ${requestedStatus}`);
    }
  }

  /**
   * Handle player death
   */
  handlePlayerDeath(deadPlayerId, killerId, timestamp) {
    const deadPlayer = this.players.get(deadPlayerId);
    if (!deadPlayer) return;

    deadPlayer.gameState.alive = false;
    deadPlayer.gameState.health = 0;
    deadPlayer.gameState.deathTime = timestamp;
    deadPlayer.status = 'dead';

    // Broadcast death event
    this.broadcastToMatch(deadPlayer.matchId, {
      type: 'PLAYER_DIED',
      deadPlayerId,
      killerId,
      timestamp: Date.now()
    });

    console.log(`Player ${deadPlayerId} was killed by ${killerId}`);
  }

  /**
   * Add cleanup system
   */
  startCleanupSystem() {
    this.cleanupInterval = setInterval(() => {
      this.serverAuthority.cleanup();
      this.cleanupInactivePlayers();
    }, this.CLEANUP_INTERVAL);

    console.log(`Cleanup system started - interval: ${this.CLEANUP_INTERVAL}ms`);
  }

  /**
   * Clean up inactive players
   */
  cleanupInactivePlayers() {
    const now = Date.now();
    const timeout = 60000; // 60 seconds timeout

    for (const [playerId, playerConnection] of this.players.entries()) {
      const timeSinceLastPing = now - playerConnection.lastPing;

      if (timeSinceLastPing > timeout && playerConnection.isAlive) {
        console.log(`Cleaning up inactive player: ${playerId}`);
        playerConnection.isAlive = false;
        this.handlePlayerDisconnection(playerId);
      }
    }
  }

  /**
   * Send message to specific player
   */
  sendToPlayer(playerId, message) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection || !playerConnection.isAlive) return;

    try {
      playerConnection.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`Failed to send message to player ${playerId}:`, error);
      this.handlePlayerDisconnection(playerId);
    }
  }

  /**
   * Broadcast message to all players in a match
   */
  broadcastToMatch(matchId, message) {
    const playerIds = this.playersByMatch.get(matchId);
    if (!playerIds) return;

    let sentCount = 0;
    for (const playerId of playerIds) {
      this.sendToPlayer(playerId, message);
      sentCount++;
    }

    console.log(`Broadcasted ${message.type} to ${sentCount} players in match ${matchId}`);
  }

  /**
   * Generate a unique player ID
   */
  generatePlayerId() {
    return uuidv4();
  }

  /**
   * Update player status and notify others
   */
  updatePlayerStatus(playerId, status) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection) return;

    playerConnection.status = status;
    playerConnection.lastPing = Date.now();

    // Broadcast status update to match
    this.broadcastToMatch(playerConnection.matchId, {
      type: 'PLAYER_STATUS_UPDATE',
      playerId,
      username: playerConnection.username,
      status,
      timestamp: Date.now()
    });
  }

  /**
   * Get list of connected players in a match
   */
  getConnectedPlayersList(matchId) {
    const playerIds = this.playersByMatch.get(matchId);
    if (!playerIds) return [];

    const players = [];
    for (const playerId of playerIds) {
      const player = this.players.get(playerId);
      if (player && player.isAlive) {
        players.push({
          playerId: player.playerId,
          username: player.username,
          status: player.status,
          connectedAt: player.connectedAt,
          ping: player.ping,
          gameState: player.gameState
        });
      }
    }

    return players;
  }

  /**
   * Broadcast player joined notification
   */
  broadcastPlayerJoined(playerConnection) {
    this.broadcastToMatchExcluding(playerConnection.matchId, {
      type: 'PLAYER_JOINED',
      player: {
        playerId: playerConnection.playerId,
        username: playerConnection.username,
        status: playerConnection.status,
        connectedAt: playerConnection.connectedAt
      },
      totalPlayers: this.getConnectedPlayersList(playerConnection.matchId).length,
      timestamp: Date.now()
    }, playerConnection.playerId); // Exclude the joining player
  }

  /**
   * Broadcast player left notification
   */
  broadcastPlayerLeft(playerId, matchId, username) {
    this.broadcastToMatch(matchId, {
      type: 'PLAYER_LEFT',
      playerId,
      username,
      totalPlayers: this.getConnectedPlayersList(matchId).length,
      timestamp: Date.now()
    });
  }

  /**
   * Get comprehensive connection status for all matches
   */
  getConnectionStatus() {
    const status = {
      serverStatus: 'running',
      totalMatches: this.matches.size,
      totalPlayers: this.players.size,
      timestamp: new Date(),
      matches: {}
    };

    for (const [matchId, playerIds] of this.playersByMatch) {
      status.matches[matchId] = {
        players: this.getConnectedPlayersList(matchId),
        playerCount: playerIds.size,
        matchState: this.matches.get(matchId)?.status || 'waiting'
      };
    }

    return status;
  }

  /**
   * Enhanced broadcast method with exclusions
   */
  broadcastToMatchExcluding(matchId, message, excludePlayerId) {
    const playerIds = this.playersByMatch.get(matchId);
    if (!playerIds) return;

    let sentCount = 0;
    for (const playerId of playerIds) {
      if (playerId !== excludePlayerId) {
        this.sendToPlayer(playerId, message);
        sentCount++;
      }
    }

    console.log(`Broadcasted ${message.type} to ${sentCount} players in match ${matchId}`);
  }

  /**
   * Handle position update from client (for server-side map sync)
   */
  handlePositionUpdate(playerId, message) {
    const playerConnection = this.players.get(playerId);
    if (!playerConnection) return;

    const position = message.position;
    const viewMode = message.viewMode;
    const timestamp = message.timestamp || Date.now();

    // Update player position in MatchManager for consistent map generation
    const updated = this.matchManager.updatePlayerPosition(playerConnection.matchId, playerId, {
      world: viewMode === 'MAP' ? position : playerConnection.gameState.position.world,
      room: viewMode === 'ROOM' ? position : playerConnection.gameState.position.room
    });

    if (updated) {
      // Update local player connection
      if (viewMode === 'MAP') {
        playerConnection.gameState.position.world = position;
      } else {
        playerConnection.gameState.position.room = position;
      }
      playerConnection.gameState.lastMoveTime = timestamp;

      // Check if player needs room data for this position
      if (viewMode === 'MAP') {
        const roomData = this.matchManager.getRoomData(playerConnection.matchId, position.x, position.y);
        if (roomData) {
          this.sendToPlayer(playerId, {
            type: 'ROOM_DATA',
            worldPos: { x: position.x, y: position.y },
            roomData: {
              terrainType: roomData.terrainType,
              terrain: roomData.terrain,
              entities: roomData.entities,
              size: roomData.size
            },
            timestamp: Date.now()
          });
        }
      }

      console.log(`Position update: ${playerId} moved to ${JSON.stringify(position)} in ${viewMode} view`);
    }
  }

  /**
   * Get current server statistics
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      totalMatches: this.matches.size,
      totalPlayers: this.players.size,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      connectionStatus: this.getConnectionStatus(),
      antiCheat: this.serverAuthority.getAntiCheatStats(),
      serverAuthority: {
        totalValidations: this.players.size, // Placeholder - could track more
        systemEnabled: true,
        lastCleanup: Date.now()
      }
    };
  }
}

module.exports = GameServer;

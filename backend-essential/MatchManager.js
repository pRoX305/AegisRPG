const { v4: uuidv4 } = require('uuid');

/**
 * MatchManager - Handles match lifecycle and server-side map generation
 * Ensures all players in a match see the same world
 */
class MatchManager {
  constructor() {
    // Active matches
    this.matches = new Map(); // matchId -> MatchState
    this.matchQueue = new Map(); // queueId -> QueuedPlayers

    // Match configuration
    this.MAX_PLAYERS_PER_MATCH = 4;
    this.MIN_PLAYERS_TO_START = 2;
    this.MATCH_DURATION = 300000; // 5 minutes
    this.MAP_SEED = 12345; // Base seed for consistent map generation

    // Terrain accessibility rules
    this.TERRAIN_ACCESS = {
      // ACCESSIBLE - Player can enter and explore rooms
      'grass': { accessible: true, roomType: 'field', description: 'Open grassland' },
      'forest': { accessible: true, roomType: 'forest', description: 'Light forest with trees' },
      'hills': { accessible: true, roomType: 'hills', description: 'Rolling hills' },
      'water': { accessible: true, roomType: 'shore', description: 'Shallow water, beach access' },
      'beach': { accessible: true, roomType: 'beach', description: 'Sandy coastline' },
      'desert': { accessible: true, roomType: 'desert', description: 'Arid desert terrain' },
      'road': { accessible: true, roomType: 'road', description: 'Clear travel path' },
      'bridge': { accessible: true, roomType: 'bridge', description: 'River crossing' },
      'swamp': { accessible: true, roomType: 'swamp', description: 'Dangerous wetlands' },
      'ruins': { accessible: true, roomType: 'ruins', description: 'Ancient ruins to explore' },
      'cave': { accessible: true, roomType: 'cave', description: 'Dark cave entrance' },
      'camp': { accessible: true, roomType: 'camp', description: 'Temporary encampment' },
      'portal': { accessible: true, roomType: 'portal', description: 'Magical portal site' },
      'temple': { accessible: true, roomType: 'temple', description: 'Sacred temple grounds' },

      // ACCESSIBLE SETTLEMENTS - Safe zones with NPCs
      'town': { accessible: true, roomType: 'town', description: 'Bustling town center' },
      'city': { accessible: true, roomType: 'city', description: 'Large city district' },
      'village': { accessible: true, roomType: 'village', description: 'Small village' },
      'tower': { accessible: true, roomType: 'tower', description: 'Wizard tower interior' },

      // ACCESSIBLE DUNGEONS - Dangerous but explorable
      'dungeon': { accessible: true, roomType: 'dungeon', description: 'Dangerous dungeon entrance' },

      // INACCESSIBLE - Player cannot enter, no room generation needed
      'deep_water': { accessible: false, roomType: null, description: 'Deep ocean waters - impassable' },
      'dense_forest': { accessible: false, roomType: null, description: 'Impenetrable thick forest' },
      'mountain': { accessible: false, roomType: null, description: 'Steep mountain cliffs - impassable' },
      'cliff': { accessible: false, roomType: null, description: 'Sheer cliff face - impassable' }
    };

    console.log('MatchManager initialized with terrain accessibility system');
  }

  /**
   * Create a new match with server-generated map
   */
  createMatch(players) {
    const matchId = uuidv4();
    const matchSeed = this.generateMatchSeed();

    const matchState = {
      matchId,
      seed: matchSeed,
      status: 'STARTING',
      players: new Map(), // playerId -> PlayerState
      map: this.generateServerMap(matchSeed),
      rooms: new Map(), // "x,y" -> RoomData
      startTime: Date.now(),
      endTime: null,
      winner: null,
      stats: {
        kills: new Map(),
        deaths: new Map(),
        itemsCollected: new Map(),
        roomsExplored: new Map()
      }
    };

    // Initialize player states
    for (const player of players) {
      matchState.players.set(player.playerId, {
        playerId: player.playerId,
        username: player.username,
        status: 'ALIVE',
        position: { world: { x: 0, y: 0 }, room: { x: 3, y: 4 } },
        health: 100,
        kills: 0,
        deaths: 0,
        itemsCollected: 0,
        roomsExplored: new Set(),
        damageDealt: 0,
        damageTaken: 0,
        deathTime: null,
        firstKillTime: null,
        lastActivity: Date.now()
      });
    }

    this.matches.set(matchId, matchState);
    console.log(`Match created: ${matchId} with ${players.length} players (seed: ${matchSeed})`);

    return matchState;
  }

  /**
   * Generate a unique seed for each match to ensure consistent but varied maps
   */
  generateMatchSeed() {
    return this.MAP_SEED + Math.floor(Math.random() * 1000000);
  }

  /**
   * Generate server-side map that all players will share
   */
  generateServerMap(seed) {
    const mapData = {
      seed,
      landmarks: new Map(),
      terrainCache: new Map(),
      bounds: { minX: -50, maxX: 50, minY: -50, maxY: 50 }
    };

    // Pre-generate important landmarks with consistent positions
    const landmarks = [
      { x: 0, y: 0, type: 'town', name: 'Central Town' },
      { x: 5, y: -3, type: 'village', name: 'Riverside Village' },
      { x: -7, y: 4, type: 'dungeon', name: 'Dark Depths' },
      { x: 2, y: 8, type: 'ruins', name: 'Ancient Ruins' },
      { x: -4, y: -6, type: 'cave', name: 'Crystal Cave' },
      { x: 10, y: 2, type: 'tower', name: 'Wizard Tower' },
      { x: -10, y: -10, type: 'village', name: 'Northern Outpost' },
      { x: 15, y: 15, type: 'dungeon', name: 'Eastern Stronghold' }
    ];

    for (const landmark of landmarks) {
      mapData.landmarks.set(`${landmark.x},${landmark.y}`, landmark);
    }

    console.log(`Generated server map with seed ${seed} and ${landmarks.length} landmarks`);
    return mapData;
  }

  /**
   * Get terrain type for a specific world position using server map
   */
  getTerrainType(matchId, worldX, worldY) {
    const match = this.matches.get(matchId);
    if (!match) return 'grass';

    const key = `${worldX},${worldY}`;

    // Check cache first
    if (match.map.terrainCache.has(key)) {
      return match.map.terrainCache.get(key);
    }

    // Check for landmarks
    if (match.map.landmarks.has(key)) {
      const landmark = match.map.landmarks.get(key);
      match.map.terrainCache.set(key, landmark.type);
      return landmark.type;
    }

    // Generate terrain using match seed
    // Use simple deterministic generation
    const terrain = this.generateTerrainType(worldX, worldY, match.map.seed);
    match.map.terrainCache.set(key, terrain);

    return terrain;
  }

  /**
   * Simple deterministic terrain generation
   */
  generateTerrainType(x, y, seed) {
    // Simple hash-based generation for consistency
    const hash = this.hashCoords(x, y, seed);
    const value = (hash % 1000) / 1000; // Normalize to 0-1

    // Road system
    if (y === 0 && Math.abs(x) <= 5) return 'road';

    // Terrain based on noise-like value
    if (value > 0.8) return 'mountain';
    if (value > 0.6) return 'forest';
    if (value > 0.4) return 'hills';
    if (value > 0.2) return 'grass';
    if (value > 0.1) return 'water';
    return 'deep_water';
  }

  /**
   * Simple hash function for coordinate-based generation
   */
  hashCoords(x, y, seed) {
    let hash = seed;
    hash = ((hash << 5) + hash) + x;
    hash = ((hash << 5) + hash) + y;
    return Math.abs(hash);
  }

  /**
   * Check if a terrain type is accessible to players
   */
  isTerrainAccessible(terrainType) {
    const accessInfo = this.TERRAIN_ACCESS[terrainType];
    return accessInfo && accessInfo.accessible;
  }

  /**
   * Get terrain access information
   */
  getTerrainAccessInfo(terrainType) {
    return this.TERRAIN_ACCESS[terrainType] || {
      accessible: false,
      roomType: null,
      description: 'Unknown terrain - impassable'
    };
  }

  /**
   * Check if player can move to a specific world position
   */
  canMoveToPosition(matchId, worldX, worldY) {
    const terrainType = this.getTerrainType(matchId, worldX, worldY);
    return this.isTerrainAccessible(terrainType);
  }

  /**
   * Generate or get cached room data for a specific world position
   */
  generateRoomData(matchId, worldX, worldY) {
    const match = this.matches.get(matchId);
    if (!match) return null;

    const key = `${worldX},${worldY}`;

    // Check if room already generated
    if (match.rooms.has(key)) {
      return match.rooms.get(key);
    }

    // Check if terrain is accessible
    const terrainType = this.getTerrainType(matchId, worldX, worldY);
    const accessInfo = this.getTerrainAccessInfo(terrainType);

    if (!accessInfo.accessible) {
      console.log(`Cannot generate room for ${terrainType} at (${worldX},${worldY}) - terrain is inaccessible`);
      return null; // Don't generate rooms for inaccessible terrain
    }

    // Generate new room based on terrain type
    const roomSeed = this.hashCoords(worldX, worldY, match.map.seed);

    const roomData = {
      worldPos: { x: worldX, y: worldY },
      terrainType,
      roomType: accessInfo.roomType,
      seed: roomSeed,
      size: { x: 20, y: 20 },
      terrain: this.generateRoomTerrain(accessInfo.roomType, roomSeed),
      entities: this.generateRoomEntities(accessInfo.roomType, roomSeed),
      discovered: false,
      exploredBy: new Set(),
      description: accessInfo.description
    };

    match.rooms.set(key, roomData);
    console.log(`Generated ${accessInfo.roomType} room for match ${matchId} at (${worldX},${worldY}) - ${terrainType}`);

    return roomData;
  }

  /**
   * Generate room terrain layout based on room type
   */
  generateRoomTerrain(roomType, seed) {
    const size = 20;
    const terrain = [];

    for (let y = 0; y < size; y++) {
      const row = [];
      for (let x = 0; x < size; x++) {
        // Border walls
        if (x === 0 || x === size - 1 || y === 0 || y === size - 1) {
          row.push('wall');
        } else {
          const hash = this.hashCoords(x, y, seed);
          const value = (hash % 100) / 100;

          // Room-specific generation
          switch (roomType) {
          case 'town':
          case 'city':
          case 'village':
            // Structured settlements with buildings
            row.push((x === 5 || x === 15) && y >= 2 && y <= 17 ? 'wall' : 'floor');
            break;

          case 'dungeon':
            // Maze-like dungeon layout
            row.push(value > 0.75 ? 'wall' : 'floor');
            break;

          case 'cave':
            // Natural cave formations
            row.push(value > 0.8 ? 'wall' : 'floor');
            break;

          case 'forest':
            // Dense tree layout
            row.push(value > 0.65 ? 'wall' : 'floor'); // Trees block movement
            break;

          case 'shore':
            // Water shoreline - mix of water and sand
            if (y < 5) row.push('water'); // North side water
            else if (y < 8) row.push(value > 0.7 ? 'water' : 'floor'); // Mixed shore
            else row.push('floor'); // South side beach
            break;

          case 'beach':
            // Sandy beach with occasional rocks
            row.push(value > 0.9 ? 'wall' : 'floor'); // Very few obstacles
            break;

          case 'swamp':
            // Dangerous swampland with water patches
            if (value > 0.8) row.push('water');
            else if (value > 0.9) row.push('wall'); // Occasional tree
            else row.push('floor');
            break;

          case 'desert':
            // Open desert with rare oases
            if (value > 0.95) row.push('water'); // Rare water
            else if (value > 0.98) row.push('wall'); // Very rare rocks
            else row.push('floor');
            break;

          case 'ruins':
            // Destroyed structures
            row.push(value > 0.6 ? 'wall' : 'floor'); // Many broken walls
            break;

          case 'temple':
            // Sacred temple layout
            if ((x === 10 && y >= 8 && y <= 12) || (y === 10 && x >= 8 && x <= 12)) {
              row.push('floor'); // Central cross pattern
            } else if (value > 0.7) {
              row.push('wall');
            } else {
              row.push('floor');
            }
            break;

          case 'tower':
            // Interior of a tower
            if (x >= 6 && x <= 14 && y >= 6 && y <= 14) {
              row.push('floor'); // Central room
            } else {
              row.push('wall'); // Thick walls
            }
            break;

          case 'bridge':
            // Bridge crossing
            if (y >= 8 && y <= 12) row.push('floor'); // Bridge path
            else row.push('water'); // Water on sides
            break;

          case 'road':
            // Clear travel path
            row.push(value > 0.98 ? 'wall' : 'floor'); // Almost no obstacles
            break;

          case 'hills':
            // Rolling hills terrain
            row.push(value > 0.85 ? 'wall' : 'floor'); // Some rocky outcrops
            break;

          case 'portal':
            // Magical portal site
            if (x === 10 && y === 10) row.push('portal'); // Central portal
            else if (value > 0.9) row.push('wall'); // Mystical barriers
            else row.push('floor');
            break;

          case 'camp':
            // Temporary encampment
            if ((x === 8 || x === 12) && (y === 8 || y === 12)) row.push('wall'); // Tents
            else row.push('floor');
            break;

          default:
          case 'field':
            // Open field
            row.push(value > 0.95 ? 'wall' : 'floor'); // Very few obstacles
            break;
          }
        }
      }
      terrain.push(row);
    }

    return terrain;
  }

  /**
   * Generate room entities based on room type
   */
  generateRoomEntities(roomType, seed) {
    const size = 20;
    const entities = [];

    for (let y = 0; y < size; y++) {
      const row = [];
      for (let x = 0; x < size; x++) {
        const hash = this.hashCoords(x + 100, y + 100, seed); // Offset for different pattern
        const value = (hash % 1000) / 1000;

        let entity = 'NONE';

        // Room-specific entity generation
        switch (roomType) {
        case 'town':
        case 'city':
          // Dense NPC population and shops
          if ((x === 7 && y === 5) || (x === 13 && y === 5)) entity = 'NPC';
          else if (x === 10 && y === 15) entity = 'CHEST';
          else if (value > 0.95) entity = 'NPC';
          break;

        case 'village':
          // Smaller settlement
          if (x === 10 && y === 5) entity = 'NPC';
          else if (value > 0.97) entity = 'ITEM';
          else if (value > 0.99) entity = 'NPC';
          break;

        case 'dungeon':
          // High danger, high reward
          if (value > 0.96) entity = 'ENEMY';
          else if (value > 0.93) entity = 'TRAP';
          else if (value > 0.89) entity = 'CHEST';
          break;

        case 'cave':
          // Natural dangers and treasures
          if (value > 0.97) entity = 'ENEMY';
          else if (value > 0.94) entity = 'CHEST';
          else if (value > 0.98) entity = 'TRAP';
          break;

        case 'forest':
          // Wildlife and natural resources
          if (value > 0.96) entity = 'ENEMY'; // Wild animals
          else if (value > 0.92) entity = 'ITEM'; // Herbs/berries
          break;

        case 'shore':
        case 'beach':
          // Coastal creatures and treasures
          if (value > 0.98) entity = 'ENEMY'; // Sea creatures
          else if (value > 0.95) entity = 'ITEM'; // Shells/driftwood
          else if (value > 0.99) entity = 'CHEST'; // Shipwreck treasure
          break;

        case 'swamp':
          // Dangerous environment
          if (value > 0.95) entity = 'ENEMY'; // Swamp creatures
          else if (value > 0.97) entity = 'TRAP'; // Natural hazards
          else if (value > 0.93) entity = 'ITEM'; // Rare plants
          break;

        case 'desert':
          // Sparse but valuable
          if (value > 0.98) entity = 'ENEMY'; // Desert predators
          else if (value > 0.96) entity = 'ITEM'; // Rare minerals
          else if (value > 0.99) entity = 'CHEST'; // Buried treasure
          break;

        case 'ruins':
          // Ancient secrets
          if (value > 0.94) entity = 'CHEST'; // Ancient treasure
          else if (value > 0.97) entity = 'TRAP'; // Ancient traps
          else if (value > 0.98) entity = 'ENEMY'; // Guardians
          break;

        case 'temple':
          // Sacred site
          if (x === 10 && y === 10) entity = 'NPC'; // Priest
          else if (value > 0.96) entity = 'CHEST'; // Sacred relics
          else if (value > 0.98) entity = 'ITEM'; // Holy items
          break;

        case 'tower':
          // Wizard's domain
          if (x === 10 && y === 10) entity = 'NPC'; // Wizard
          else if (value > 0.94) entity = 'CHEST'; // Magical items
          else if (value > 0.97) entity = 'ITEM'; // Spell components
          break;

        case 'bridge':
          // Crossing point
          if (value > 0.99) entity = 'NPC'; // Bridge keeper
          else if (value > 0.97) entity = 'ITEM'; // Dropped items
          break;

        case 'road':
          // Travel route
          if (value > 0.98) entity = 'NPC'; // Travelers
          else if (value > 0.995) entity = 'ITEM'; // Lost items
          break;

        case 'hills':
          // Highland terrain
          if (value > 0.97) entity = 'ITEM'; // Mountain herbs
          else if (value > 0.99) entity = 'ENEMY'; // Hill bandits
          break;

        case 'portal':
          // Magical site
          if (value > 0.95) entity = 'ITEM'; // Magical essence
          else if (value > 0.98) entity = 'ENEMY'; // Portal guardians
          break;

        case 'camp':
          // Temporary settlement
          if (value > 0.96) entity = 'NPC'; // Campers
          else if (value > 0.98) entity = 'ITEM'; // Supplies
          break;

        default:
        case 'field':
          // Open grassland
          if (value > 0.99) entity = 'ITEM'; // Very rare finds
          else if (value > 0.995) entity = 'ENEMY'; // Occasional wildlife
          break;
        }

        row.push(entity);
      }
      entities.push(row);
    }

    return entities;
  }

  /**
   * Start a match
   */
  startMatch(matchId) {
    const match = this.matches.get(matchId);
    if (!match) return false;

    match.status = 'ACTIVE';
    match.startTime = Date.now();
    match.endTime = match.startTime + this.MATCH_DURATION;

    console.log(`Match ${matchId} started with ${match.players.size} players`);

    // Schedule match end
    setTimeout(() => {
      this.endMatch(matchId, 'TIME_LIMIT');
    }, this.MATCH_DURATION);

    return true;
  }

  /**
   * End a match and calculate stats
   */
  endMatch(matchId, reason = 'COMPLETED') {
    const match = this.matches.get(matchId);
    if (!match) return null;

    match.status = 'ENDED';
    match.endTime = Date.now();

    // Calculate final stats
    const finalStats = this.calculateMatchStats(match);

    console.log(`Match ${matchId} ended (${reason}) - Duration: ${match.endTime - match.startTime}ms`);

    // Remove match after a delay to allow stats collection
    setTimeout(() => {
      this.matches.delete(matchId);
      console.log(`Match ${matchId} cleaned up`);
    }, 30000); // 30 second cleanup delay

    return {
      matchId,
      reason,
      duration: match.endTime - match.startTime,
      stats: finalStats
    };
  }

  /**
   * Calculate final match statistics
   */
  calculateMatchStats(match) {
    const matchDuration = (match.endTime || Date.now()) - match.startTime;

    const stats = {
      matchId: match.matchId,
      totalPlayers: match.players.size,
      duration: matchDuration,
      winner: null,
      playerStats: [],
      playerRankings: {
        byKills: [],
        byExploration: [],
        byItems: [],
        byDamage: [],
        bySurvival: []
      },
      matchStats: {
        totalKills: 0,
        totalDeaths: 0,
        totalItemsCollected: 0,
        totalRoomsExplored: new Set(),
        averageRoomsPerPlayer: 0,
        mostDeadlyPlayer: null,
        mostExplorativePlayer: null,
        mostCollectorPlayer: null,
        longestSurvivor: null
      },
      mapStats: {
        totalRoomsGenerated: match.rooms.size,
        seedUsed: match.map.seed,
        accessibleTerrainTypes: Object.keys(this.TERRAIN_ACCESS).filter(t => this.TERRAIN_ACCESS[t].accessible),
        roomTypesGenerated: [...new Set([...match.rooms.values()].map(r => r.roomType))]
      },
      timestamps: {
        matchStart: match.startTime,
        matchEnd: match.endTime || Date.now(),
        firstKill: null,
        lastActivity: Math.max(...[...match.players.values()].map(p => p.lastActivity))
      }
    };

    // Calculate detailed player statistics
    let firstKillTime = null;
    let maxKills = -1;
    let maxExploration = -1;
    let maxItems = -1;
    let maxDamageDealt = -1;
    let longestSurvivalTime = -1;

    for (const [playerId, playerState] of match.players) {
      // Calculate survival time
      const survivalTime = playerState.status === 'ALIVE' ? matchDuration :
        (playerState.deathTime || match.endTime || Date.now()) - match.startTime;

      const playerStats = {
        playerId,
        username: playerState.username,
        // Combat stats
        kills: playerState.kills,
        deaths: playerState.deaths,
        damageDealt: playerState.damageDealt || 0,
        damageTaken: playerState.damageTaken || 0,
        kdr: playerState.deaths > 0 ? (playerState.kills / playerState.deaths).toFixed(2) : playerState.kills,
        // Exploration stats
        itemsCollected: playerState.itemsCollected,
        roomsExplored: playerState.roomsExplored.size,
        uniqueTerrainTypes: this.getUniqueTerrainTypesExplored(match, playerState.roomsExplored),
        // Survival stats
        finalStatus: playerState.status,
        survived: playerState.status === 'ALIVE',
        survivalTime: survivalTime,
        survivalPercentage: ((survivalTime / matchDuration) * 100).toFixed(1),
        // Activity stats
        lastActivity: playerState.lastActivity,
        totalPlayTime: playerState.lastActivity - match.startTime,
        // Performance ratings
        combatScore: this.calculateCombatScore(playerState),
        explorationScore: this.calculateExplorationScore(playerState),
        survivalScore: this.calculateSurvivalScore(playerState, matchDuration)
      };

      // Calculate overall performance score
      playerStats.overallScore = (
        playerStats.combatScore * 0.4 +
        playerStats.explorationScore * 0.3 +
        playerStats.survivalScore * 0.3
      ).toFixed(1);

      stats.playerStats.push(playerStats);

      // Track maximums for awards
      if (playerState.kills > maxKills || (playerState.kills === maxKills && playerState.status === 'ALIVE')) {
        maxKills = playerState.kills;
        stats.winner = playerStats;
      }

      if (playerState.kills > 0 && !firstKillTime) {
        firstKillTime = playerState.firstKillTime || match.startTime + 60000; // Estimate if not tracked
      }

      // Update match totals
      stats.matchStats.totalKills += playerState.kills;
      stats.matchStats.totalDeaths += playerState.deaths;
      stats.matchStats.totalItemsCollected += playerState.itemsCollected;

      // Add explored rooms to total set
      for (const roomKey of playerState.roomsExplored) {
        stats.matchStats.totalRoomsExplored.add(roomKey);
      }

      // Track record holders
      if (playerState.kills > maxKills) {
        maxKills = playerState.kills;
        stats.matchStats.mostDeadlyPlayer = playerStats;
      }

      if (playerState.roomsExplored.size > maxExploration) {
        maxExploration = playerState.roomsExplored.size;
        stats.matchStats.mostExplorativePlayer = playerStats;
      }

      if (playerState.itemsCollected > maxItems) {
        maxItems = playerState.itemsCollected;
        stats.matchStats.mostCollectorPlayer = playerStats;
      }

      if ((playerState.damageDealt || 0) > maxDamageDealt) {
        maxDamageDealt = playerState.damageDealt || 0;
      }

      if (survivalTime > longestSurvivalTime) {
        longestSurvivalTime = survivalTime;
        stats.matchStats.longestSurvivor = playerStats;
      }
    }

    // Calculate match averages
    stats.matchStats.totalRoomsExplored = stats.matchStats.totalRoomsExplored.size;
    stats.matchStats.averageRoomsPerPlayer = (stats.matchStats.totalRoomsExplored / stats.totalPlayers).toFixed(1);
    stats.timestamps.firstKill = firstKillTime;

    // Create rankings
    stats.playerRankings.byKills = [...stats.playerStats].sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.deaths !== b.deaths) return a.deaths - b.deaths;
      return b.survived ? 1 : -1;
    });

    stats.playerRankings.byExploration = [...stats.playerStats].sort((a, b) => b.roomsExplored - a.roomsExplored);
    stats.playerRankings.byItems = [...stats.playerStats].sort((a, b) => b.itemsCollected - a.itemsCollected);
    stats.playerRankings.byDamage = [...stats.playerStats].sort((a, b) => b.damageDealt - a.damageDealt);
    stats.playerRankings.bySurvival = [...stats.playerStats].sort((a, b) => b.survivalTime - a.survivalTime);

    return stats;
  }

  /**
   * Get unique terrain types explored by a player
   */
  getUniqueTerrainTypesExplored(match, roomsExploredSet) {
    const terrainTypes = new Set();
    for (const roomKey of roomsExploredSet) {
      const [x, y] = roomKey.split(',').map(Number);
      const terrainType = this.getTerrainType(match.matchId, x, y);
      terrainTypes.add(terrainType);
    }
    return terrainTypes.size;
  }

  /**
   * Calculate combat performance score (0-100)
   */
  calculateCombatScore(playerState) {
    const kills = playerState.kills;
    const deaths = playerState.deaths;
    const damageDealt = playerState.damageDealt || 0;

    // Base score from kills (up to 50 points)
    let score = Math.min(kills * 10, 50);

    // Bonus for good KDR (up to 25 points)
    if (deaths === 0 && kills > 0) {
      score += 25;
    } else if (deaths > 0) {
      const kdr = kills / deaths;
      score += Math.min(kdr * 5, 25);
    }

    // Bonus for damage dealt (up to 25 points)
    score += Math.min(damageDealt / 50, 25);

    return Math.min(score, 100).toFixed(1);
  }

  /**
   * Calculate exploration performance score (0-100)
   */
  calculateExplorationScore(playerState) {
    const roomsExplored = playerState.roomsExplored.size;
    const itemsCollected = playerState.itemsCollected;

    // Base score from exploration (up to 60 points)
    let score = Math.min(roomsExplored * 3, 60);

    // Bonus for item collection (up to 40 points)
    score += Math.min(itemsCollected * 2, 40);

    return Math.min(score, 100).toFixed(1);
  }

  /**
   * Calculate survival performance score (0-100)
   */
  calculateSurvivalScore(playerState, matchDuration) {
    const survivalTime = playerState.status === 'ALIVE' ? matchDuration :
      (playerState.deathTime || matchDuration) - 0;
    const survivalPercentage = (survivalTime / matchDuration) * 100;

    // Base score from survival percentage (up to 70 points)
    let score = Math.min(survivalPercentage * 0.7, 70);

    // Bonus for staying alive (30 points)
    if (playerState.status === 'ALIVE') {
      score += 30;
    }

    return Math.min(score, 100).toFixed(1);
  }

  /**
   * Update player position and track room exploration
   */
  updatePlayerPosition(matchId, playerId, position) {
    const match = this.matches.get(matchId);
    if (!match) return false;

    const player = match.players.get(playerId);
    if (!player) return false;

    // const oldWorldPos = player.position.world; // Future: track position changes
    player.position = position;
    player.lastActivity = Date.now();

    // Track room exploration
    const worldKey = `${position.world.x},${position.world.y}`;
    if (!player.roomsExplored.has(worldKey)) {
      player.roomsExplored.add(worldKey);

      // Mark room as discovered
      const roomData = this.generateRoomData(matchId, position.world.x, position.world.y);
      if (roomData) {
        roomData.discovered = true;
        roomData.exploredBy.add(playerId);
      }
    }

    return true;
  }

  /**
   * Record player kill
   */
  recordPlayerKill(matchId, killerId, victimId) {
    const match = this.matches.get(matchId);
    if (!match) return false;

    const killer = match.players.get(killerId);
    const victim = match.players.get(victimId);

    if (!killer || !victim) return false;

    const currentTime = Date.now();

    killer.kills++;
    victim.deaths++;
    victim.status = 'DEAD';
    victim.deathTime = currentTime;

    // Track first kill time
    if (killer.kills === 1) {
      killer.firstKillTime = currentTime;
    }

    // Update match stats
    match.stats.kills.set(killerId, (match.stats.kills.get(killerId) || 0) + 1);
    match.stats.deaths.set(victimId, (match.stats.deaths.get(victimId) || 0) + 1);

    console.log(`Player ${killerId} killed player ${victimId} in match ${matchId} at ${currentTime}`);
    return true;
  }

  /**
   * Record item collection
   */
  recordItemCollection(matchId, playerId, itemType, quantity = 1) {
    const match = this.matches.get(matchId);
    if (!match) return false;

    const player = match.players.get(playerId);
    if (!player) return false;

    player.itemsCollected += quantity;

    // Update match stats
    const playerItems = match.stats.itemsCollected.get(playerId) || {};
    playerItems[itemType] = (playerItems[itemType] || 0) + quantity;
    match.stats.itemsCollected.set(playerId, playerItems);

    console.log(`Player ${playerId} collected ${quantity} ${itemType} in match ${matchId}`);
    return true;
  }

  /**
   * Record player damage dealt/taken
   */
  recordPlayerDamage(matchId, attackerId, targetId, damage) {
    const match = this.matches.get(matchId);
    if (!match) return false;

    const attacker = match.players.get(attackerId);
    const target = match.players.get(targetId);

    if (!attacker || !target) return false;

    // Initialize damage stats if needed
    if (!attacker.damageDealt) attacker.damageDealt = 0;
    if (!target.damageTaken) target.damageTaken = 0;

    attacker.damageDealt += damage;
    target.damageTaken += damage;
    target.health = Math.max(0, target.health - damage);

    console.log(`Player ${attackerId} dealt ${damage} damage to player ${targetId} in match ${matchId}`);
    return true;
  }

  /**
   * Get match state for a player
   */
  getMatchState(matchId) {
    return this.matches.get(matchId);
  }

  /**
   * Get room data for a specific position in a match
   */
  getRoomData(matchId, worldX, worldY) {
    return this.generateRoomData(matchId, worldX, worldY);
  }

  /**
   * Check if match exists and is active
   */
  isMatchActive(matchId) {
    const match = this.matches.get(matchId);
    return match && match.status === 'ACTIVE';
  }

  /**
   * Get all active matches
   */
  getActiveMatches() {
    const activeMatches = [];
    for (const [matchId, match] of this.matches) {
      if (match.status === 'ACTIVE') {
        activeMatches.push({
          matchId,
          playerCount: match.players.size,
          startTime: match.startTime,
          timeRemaining: match.endTime - Date.now()
        });
      }
    }
    return activeMatches;
  }

  /**
   * Get detailed match statistics for a specific match
   */
  getDetailedMatchStats(matchId) {
    const match = this.matches.get(matchId);
    if (!match) return null;

    // Return live stats if match is still active
    if (match.status === 'ACTIVE') {
      return this.calculateMatchStats(match);
    }

    // Return final stats if match is ended
    return this.calculateMatchStats(match);
  }

  /**
   * Get player achievements and awards for a match
   */
  getPlayerAchievements(matchId, playerId) {
    const match = this.matches.get(matchId);
    if (!match) return null;

    const player = match.players.get(playerId);
    if (!player) return null;

    const stats = this.calculateMatchStats(match);
    const playerStats = stats.playerStats.find(p => p.playerId === playerId);
    if (!playerStats) return null;

    const achievements = [];

    // Combat achievements
    if (playerStats.kills >= 5) achievements.push({ title: 'Slayer', description: 'Eliminated 5+ players', category: 'combat' });
    if (playerStats.kills >= 10) achievements.push({ title: 'Destroyer', description: 'Eliminated 10+ players', category: 'combat' });
    if (playerStats.kdr >= 2) achievements.push({ title: 'Elite Fighter', description: 'K/D ratio of 2.0 or higher', category: 'combat' });
    if (playerStats.kills > 0 && playerStats.deaths === 0) achievements.push({ title: 'Flawless Victory', description: 'Won without dying', category: 'combat' });
    if (playerStats.damageDealt >= 1000) achievements.push({ title: 'Heavy Hitter', description: 'Dealt 1000+ damage', category: 'combat' });

    // Exploration achievements
    if (playerStats.roomsExplored >= 20) achievements.push({ title: 'Explorer', description: 'Explored 20+ rooms', category: 'exploration' });
    if (playerStats.roomsExplored >= 50) achievements.push({ title: 'Pathfinder', description: 'Explored 50+ rooms', category: 'exploration' });
    if (playerStats.uniqueTerrainTypes >= 8) achievements.push({ title: 'Terrain Master', description: 'Explored 8+ different terrain types', category: 'exploration' });
    if (playerStats.itemsCollected >= 25) achievements.push({ title: 'Collector', description: 'Collected 25+ items', category: 'exploration' });
    if (playerStats.itemsCollected >= 50) achievements.push({ title: 'Hoarder', description: 'Collected 50+ items', category: 'exploration' });

    // Survival achievements
    if (playerStats.survived) achievements.push({ title: 'Survivor', description: 'Survived until match end', category: 'survival' });
    if (playerStats.survivalPercentage >= 90) achievements.push({ title: 'Endurance Runner', description: 'Survived 90%+ of match', category: 'survival' });
    if (playerStats.survived && playerStats.roomsExplored >= 30) achievements.push({ title: 'Cautious Explorer', description: 'Survived while exploring extensively', category: 'survival' });

    // Special achievements
    if (stats.matchStats.mostDeadlyPlayer && stats.matchStats.mostDeadlyPlayer.playerId === playerId) {
      achievements.push({ title: 'Most Deadly', description: 'Highest kill count in match', category: 'award' });
    }
    if (stats.matchStats.mostExplorativePlayer && stats.matchStats.mostExplorativePlayer.playerId === playerId) {
      achievements.push({ title: 'Greatest Explorer', description: 'Most rooms explored in match', category: 'award' });
    }
    if (stats.matchStats.mostCollectorPlayer && stats.matchStats.mostCollectorPlayer.playerId === playerId) {
      achievements.push({ title: 'Master Collector', description: 'Most items collected in match', category: 'award' });
    }
    if (stats.matchStats.longestSurvivor && stats.matchStats.longestSurvivor.playerId === playerId) {
      achievements.push({ title: 'Longest Survivor', description: 'Survived longest in match', category: 'award' });
    }
    if (stats.winner && stats.winner.playerId === playerId) {
      achievements.push({ title: 'Match Winner', description: 'Won the match', category: 'victory' });
    }

    // Performance tier achievements
    const overallScore = parseFloat(playerStats.overallScore);
    if (overallScore >= 90) achievements.push({ title: 'Legendary Performance', description: 'Overall score 90+', category: 'performance' });
    else if (overallScore >= 75) achievements.push({ title: 'Excellent Performance', description: 'Overall score 75+', category: 'performance' });
    else if (overallScore >= 60) achievements.push({ title: 'Good Performance', description: 'Overall score 60+', category: 'performance' });

    return {
      playerId,
      username: playerStats.username,
      achievements,
      playerStats,
      matchRank: stats.playerRankings.byKills.findIndex(p => p.playerId === playerId) + 1
    };
  }

  /**
   * Get match leaderboard with various sorting options
   */
  getMatchLeaderboard(matchId, sortBy = 'overall') {
    const match = this.matches.get(matchId);
    if (!match) return null;

    const stats = this.calculateMatchStats(match);

    const leaderboard = {
      matchId,
      matchStatus: match.status,
      sortedBy: sortBy,
      totalPlayers: stats.totalPlayers,
      rankings: []
    };

    switch (sortBy) {
    case 'kills':
      leaderboard.rankings = stats.playerRankings.byKills;
      break;
    case 'exploration':
      leaderboard.rankings = stats.playerRankings.byExploration;
      break;
    case 'items':
      leaderboard.rankings = stats.playerRankings.byItems;
      break;
    case 'damage':
      leaderboard.rankings = stats.playerRankings.byDamage;
      break;
    case 'survival':
      leaderboard.rankings = stats.playerRankings.bySurvival;
      break;
    case 'overall':
    default:
      leaderboard.rankings = [...stats.playerStats].sort((a, b) => parseFloat(b.overallScore) - parseFloat(a.overallScore));
      break;
    }

    // Add rank positions
    leaderboard.rankings = leaderboard.rankings.map((player, index) => ({
      ...player,
      rank: index + 1
    }));

    return leaderboard;
  }

  /**
   * Debug method to create a test match with sample data
   */
  createTestMatch() {
    const testPlayers = [
      { playerId: 'test1', username: 'TestPlayer1' },
      { playerId: 'test2', username: 'TestPlayer2' },
      { playerId: 'test3', username: 'TestPlayer3' },
      { playerId: 'test4', username: 'TestPlayer4' }
    ];

    const match = this.createMatch(testPlayers);
    this.startMatch(match.matchId);

    // Simulate some game events
    const matchId = match.matchId;

    // Simulate exploration
    this.updatePlayerPosition(matchId, 'test1', { world: { x: 1, y: 0 }, room: { x: 3, y: 4 } });
    this.updatePlayerPosition(matchId, 'test1', { world: { x: 2, y: 0 }, room: { x: 3, y: 4 } });
    this.updatePlayerPosition(matchId, 'test1', { world: { x: 3, y: 0 }, room: { x: 3, y: 4 } });

    this.updatePlayerPosition(matchId, 'test2', { world: { x: 0, y: 1 }, room: { x: 3, y: 4 } });
    this.updatePlayerPosition(matchId, 'test2', { world: { x: 0, y: 2 }, room: { x: 3, y: 4 } });

    // Simulate item collection
    this.recordItemCollection(matchId, 'test1', 'CHEST', 3);
    this.recordItemCollection(matchId, 'test1', 'ITEM', 5);
    this.recordItemCollection(matchId, 'test2', 'ITEM', 2);

    // Simulate combat
    this.recordPlayerDamage(matchId, 'test1', 'test3', 50);
    this.recordPlayerDamage(matchId, 'test1', 'test3', 30);
    this.recordPlayerKill(matchId, 'test1', 'test3');

    this.recordPlayerDamage(matchId, 'test2', 'test4', 40);
    this.recordPlayerDamage(matchId, 'test2', 'test4', 35);
    this.recordPlayerKill(matchId, 'test2', 'test4');

    console.log(`Test match created: ${matchId}`);
    return matchId;
  }
}

module.exports = MatchManager;

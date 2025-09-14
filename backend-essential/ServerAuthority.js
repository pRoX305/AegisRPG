// const { v4: uuidv4 } = require('uuid'); // Future: unique IDs

/**
 * ServerAuthority - Comprehensive anti-cheat and server-authoritative system
 * All critical game functions are handled server-side to prevent cheating
 */
class ServerAuthority {
  constructor() {
    // Game world configuration
    this.worldBounds = {
      minX: 0,
      maxX: 1000,
      minY: 0,
      maxY: 1000
    };

    // Movement limits and validation
    this.maxMovementSpeed = 5.0; // units per second
    this.maxMovementPerTick = 10.0; // maximum movement distance per tick

    // Item system
    this.gameItems = new Map(); // itemId -> item data
    this.playerInventories = new Map(); // playerId -> inventory
    this.itemSpawnLocations = new Map(); // locationId -> item spawns
    this.itemIdCounter = 1;

    // Item type definitions
    this.itemTypes = {
      WEAPON: {
        category: 'equipment',
        stackable: false,
        maxStack: 1,
        stats: ['attack', 'criticalChance', 'attackSpeed']
      },
      ARMOR: {
        category: 'equipment',
        stackable: false,
        maxStack: 1,
        stats: ['defense', 'health', 'healthRegen']
      },
      CONSUMABLE: {
        category: 'consumable',
        stackable: true,
        maxStack: 99,
        effects: ['health', 'mana', 'buff', 'debuff']
      },
      MATERIAL: {
        category: 'material',
        stackable: true,
        maxStack: 999,
        craftable: true
      },
      KEY_ITEM: {
        category: 'quest',
        stackable: false,
        maxStack: 1,
        tradeable: false
      }
    };

    // Pre-defined items database
    this.itemDatabase = {
      // Weapons
      'iron_sword': {
        id: 'iron_sword',
        name: 'Iron Sword',
        type: 'WEAPON',
        rarity: 'common',
        stats: { attack: 15, criticalChance: 5 },
        description: 'A sturdy iron sword suitable for basic combat.'
      },
      'steel_dagger': {
        id: 'steel_dagger',
        name: 'Steel Dagger',
        type: 'WEAPON',
        rarity: 'common',
        stats: { attack: 12, criticalChance: 15, attackSpeed: 1.2 },
        description: 'A quick steel dagger for swift strikes.'
      },

      // Armor
      'leather_armor': {
        id: 'leather_armor',
        name: 'Leather Armor',
        type: 'ARMOR',
        rarity: 'common',
        stats: { defense: 8, health: 20 },
        description: 'Basic leather protection for adventurers.'
      },
      'chain_mail': {
        id: 'chain_mail',
        name: 'Chain Mail',
        type: 'ARMOR',
        rarity: 'uncommon',
        stats: { defense: 15, health: 40, healthRegen: 1 },
        description: 'Interlocked metal rings providing good protection.'
      },

      // Consumables
      'health_potion': {
        id: 'health_potion',
        name: 'Health Potion',
        type: 'CONSUMABLE',
        rarity: 'common',
        effects: { health: 50 },
        description: 'Restores 50 health points instantly.'
      },
      'mana_potion': {
        id: 'mana_potion',
        name: 'Mana Potion',
        type: 'CONSUMABLE',
        rarity: 'common',
        effects: { mana: 30 },
        description: 'Restores 30 mana points instantly.'
      },

      // Materials
      'iron_ore': {
        id: 'iron_ore',
        name: 'Iron Ore',
        type: 'MATERIAL',
        rarity: 'common',
        description: 'Raw iron ore for crafting weapons and armor.'
      },
      'magic_crystal': {
        id: 'magic_crystal',
        name: 'Magic Crystal',
        type: 'MATERIAL',
        rarity: 'rare',
        description: 'A glowing crystal infused with magical energy.'
      }
    };

    // Initialize item spawn system
    this.initializeItemSpawns();

    // Combat configuration (server-only)
    this.combatRules = {
      maxAttackRange: 50.0,
      attackCooldown: 1500, // ms, matches autoattack tick
      maxDamagePerHit: 25,
      minDamagePerHit: 5,
      maxHealth: 100,
      healthRegenRate: 0.5, // per second when not in combat
      combatTimeout: 5000 // ms before leaving combat state
    };

    // Anti-cheat thresholds
    this.cheatDetection = {
      maxActionsPerSecond: 10,
      maxMovementSpeedMultiplier: 2.0, // Allow 2x speed briefly for lag compensation
      suspiciousActionThreshold: 5,
      autoKickThreshold: 10
    };

    // Player action tracking for anti-cheat
    this.playerActions = new Map(); // playerId -> action history
    this.suspiciousPlayers = new Map(); // playerId -> violation count

    console.log('ServerAuthority initialized with anti-cheat measures');
  }

  /**
   * Validate and process player movement request
   * Returns the authoritative position or null if invalid
   */
  validateMovement(playerId, fromPos, toPos, timestamp, playerData) {
    // Basic boundary validation
    if (!this.isPositionInBounds(toPos)) {
      this.flagSuspiciousActivity(playerId, 'OUT_OF_BOUNDS', {
        position: toPos,
        bounds: this.worldBounds
      });
      return null;
    }

    // Calculate movement distance and time
    const distance = this.calculateDistance(fromPos, toPos);
    const timeDelta = timestamp - (playerData.lastMoveTime || timestamp);
    const maxAllowedDistance = this.calculateMaxMovementDistance(timeDelta);

    // Speed hacking detection
    if (distance > maxAllowedDistance) {
      this.flagSuspiciousActivity(playerId, 'SPEED_HACK', {
        distance,
        maxAllowed: maxAllowedDistance,
        timeDelta,
        speed: distance / (timeDelta / 1000)
      });

      // Teleport back to last known valid position
      return playerData.lastValidPosition || fromPos;
    }

    // Obstacle collision (simplified - expand based on game map)
    if (this.hasObstacleCollision(fromPos, toPos)) {
      this.flagSuspiciousActivity(playerId, 'WALL_HACK', { fromPos, toPos });
      return playerData.lastValidPosition || fromPos;
    }

    // Movement is valid
    this.recordPlayerAction(playerId, 'MOVEMENT', { fromPos, toPos, distance, timeDelta });
    return toPos;
  }

  /**
   * Validate and process combat action
   * Returns combat result or null if invalid
   */
  validateCombatAction(attackerId, targetId, actionType, timestamp, gameState) {
    const attacker = gameState.players.get(attackerId);
    const target = gameState.players.get(targetId);

    if (!attacker || !target) {
      this.flagSuspiciousActivity(attackerId, 'INVALID_TARGET', { targetId });
      return null;
    }

    // Check if attacker is alive
    if (attacker.gameState.health <= 0) {
      this.flagSuspiciousActivity(attackerId, 'DEAD_PLAYER_ACTION', { health: attacker.gameState.health });
      return null;
    }

    // Check attack cooldown
    const lastAttack = attacker.gameState.lastAttackTime || 0;
    const timeSinceLastAttack = timestamp - lastAttack;

    if (timeSinceLastAttack < this.combatRules.attackCooldown) {
      this.flagSuspiciousActivity(attackerId, 'ATTACK_SPEED_HACK', {
        timeSinceLastAttack,
        requiredCooldown: this.combatRules.attackCooldown
      });
      return null;
    }

    // Check attack range
    const distance = this.calculateDistance(attacker.gameState.position, target.gameState.position);
    if (distance > this.combatRules.maxAttackRange) {
      this.flagSuspiciousActivity(attackerId, 'RANGE_HACK', {
        distance,
        maxRange: this.combatRules.maxAttackRange
      });
      return null;
    }

    // Calculate server-side damage (never trust client damage values)
    const damage = this.calculateDamage(attacker, target, actionType);

    // Apply damage server-side
    const combatResult = this.applyCombatDamage(attackerId, targetId, damage, timestamp, gameState);

    this.recordPlayerAction(attackerId, 'COMBAT', {
      target: targetId,
      damage,
      actionType,
      distance
    });

    return combatResult;
  }

  /**
   * Server-side damage calculation (never trust client)
   */
  calculateDamage(attacker, target, _actionType) {
    // Base damage calculation
    const baseDamage = 15; // Base autoattack damage

    // Apply attacker stats (server-controlled)
    const attackPower = attacker.gameState.stats?.attack || 10;
    const defense = target.gameState.stats?.defense || 5;

    // Calculate final damage
    let finalDamage = Math.max(1, baseDamage + attackPower - defense);

    // Add randomness (server-controlled)
    finalDamage += Math.floor(Math.random() * 5) - 2; // ±2 random damage

    // Clamp to valid range
    finalDamage = Math.max(this.combatRules.minDamagePerHit,
      Math.min(this.combatRules.maxDamagePerHit, finalDamage));

    return finalDamage;
  }

  /**
   * Apply combat damage server-side
   */
  applyCombatDamage(attackerId, targetId, damage, timestamp, gameState) {
    const attacker = gameState.players.get(attackerId);
    const target = gameState.players.get(targetId);

    // Update attacker state
    attacker.gameState.lastAttackTime = timestamp;
    attacker.gameState.inCombat = true;
    attacker.gameState.lastCombatTime = timestamp;

    // Apply damage to target
    const oldHealth = target.gameState.health;
    target.gameState.health = Math.max(0, target.gameState.health - damage);
    target.gameState.inCombat = true;
    target.gameState.lastCombatTime = timestamp;

    // Check for death
    const isDead = target.gameState.health <= 0;
    if (isDead) {
      this.handlePlayerDeath(targetId, attackerId, timestamp, gameState);
    }

    return {
      attackerId,
      targetId,
      damage,
      oldHealth,
      newHealth: target.gameState.health,
      isDead,
      timestamp
    };
  }

  /**
   * Handle player death server-side
   */
  handlePlayerDeath(deadPlayerId, killerId, timestamp, gameState) {
    const deadPlayer = gameState.players.get(deadPlayerId);
    const killer = gameState.players.get(killerId);

    if (deadPlayer) {
      deadPlayer.gameState.alive = false;
      deadPlayer.gameState.deathTime = timestamp;
      deadPlayer.gameState.killedBy = killerId;
      deadPlayer.status = 'dead';
    }

    if (killer) {
      killer.gameState.kills = (killer.gameState.kills || 0) + 1;
    }

    console.log(`Player ${deadPlayerId} killed by ${killerId}`);
  }

  /**
   * Validate item usage/pickup
   */
  validateItemAction(playerId, itemId, actionType, timestamp, gameState) {
    const player = gameState.players.get(playerId);
    if (!player) return null;

    // Check if player is alive
    if (player.gameState.health <= 0) {
      this.flagSuspiciousActivity(playerId, 'DEAD_PLAYER_ITEM_USE', { itemId });
      return null;
    }

    // Validate item exists and is in range
    const item = this.findItemById(itemId, gameState);
    if (!item) {
      this.flagSuspiciousActivity(playerId, 'INVALID_ITEM', { itemId });
      return null;
    }

    const distance = this.calculateDistance(player.gameState.position, item.position);
    if (distance > 30.0) { // Max pickup range
      this.flagSuspiciousActivity(playerId, 'ITEM_RANGE_HACK', { distance, itemId });
      return null;
    }

    // Process item action server-side
    return this.processItemAction(playerId, item, actionType, timestamp, gameState);
  }

  /**
   * Anti-cheat: Record and analyze player actions
   */
  recordPlayerAction(playerId, actionType, data) {
    if (!this.playerActions.has(playerId)) {
      this.playerActions.set(playerId, []);
    }

    const actions = this.playerActions.get(playerId);
    const now = Date.now();

    actions.push({
      type: actionType,
      timestamp: now,
      data
    });

    // Keep only recent actions (last 10 seconds)
    const cutoff = now - 10000;
    const recentActions = actions.filter(action => action.timestamp > cutoff);
    this.playerActions.set(playerId, recentActions);

    // Check for suspicious action frequency
    this.checkActionFrequency(playerId, recentActions);
  }

  /**
   * Check for suspicious action frequency (anti-cheat)
   */
  checkActionFrequency(playerId, actions) {
    const actionsPerSecond = actions.length / 10;

    if (actionsPerSecond > this.cheatDetection.maxActionsPerSecond) {
      this.flagSuspiciousActivity(playerId, 'HIGH_ACTION_FREQUENCY', {
        actionsPerSecond,
        maxAllowed: this.cheatDetection.maxActionsPerSecond
      });
    }
  }

  /**
   * Flag suspicious activity and take action
   */
  flagSuspiciousActivity(playerId, violationType, details) {
    if (!this.suspiciousPlayers.has(playerId)) {
      this.suspiciousPlayers.set(playerId, { violations: [], count: 0 });
    }

    const playerViolations = this.suspiciousPlayers.get(playerId);
    playerViolations.violations.push({
      type: violationType,
      timestamp: Date.now(),
      details
    });
    playerViolations.count++;

    console.log(`🚨 CHEAT DETECTION: Player ${playerId} - ${violationType}`, details);

    // Take action based on violation severity
    if (playerViolations.count >= this.cheatDetection.autoKickThreshold) {
      console.log(`🔨 AUTO-KICKING player ${playerId} for repeated violations`);
      return { action: 'kick', reason: 'Repeated cheat violations' };
    } else if (playerViolations.count >= this.cheatDetection.suspiciousActionThreshold) {
      console.log(`⚠️ Player ${playerId} flagged as suspicious`);
      return { action: 'flag', reason: 'Suspicious activity detected' };
    }

    return { action: 'warn', reason: violationType };
  }

  /**
   * Utility functions
   */
  isPositionInBounds(pos) {
    return pos.x >= this.worldBounds.minX && pos.x <= this.worldBounds.maxX &&
           pos.y >= this.worldBounds.minY && pos.y <= this.worldBounds.maxY;
  }

  calculateDistance(pos1, pos2) {
    const dx = pos1.x - pos2.x;
    const dy = pos1.y - pos2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  calculateMaxMovementDistance(timeDelta) {
    const timeInSeconds = timeDelta / 1000;
    return this.maxMovementSpeed * timeInSeconds * this.cheatDetection.maxMovementSpeedMultiplier;
  }

  hasObstacleCollision(_fromPos, _toPos) {
    // Simplified collision detection - expand based on actual game map
    // For now, just check for obvious impossible moves
    return false;
  }

  findItemById(itemId, _gameState) {
    // Find item in game world items
    return this.gameItems.get(itemId) || null;
  }

  processItemAction(playerId, item, actionType, timestamp, gameState) {
    switch (actionType) {
    case 'pickup':
      return this.pickupItem(playerId, item, timestamp);
    case 'use':
      return this.useItem(playerId, item, timestamp, gameState);
    case 'drop':
      return this.dropItem(playerId, item, timestamp, gameState);
    case 'equip':
      return this.equipItem(playerId, item, timestamp);
    case 'unequip':
      return this.unequipItem(playerId, item, timestamp);
    default:
      console.log(`Unknown item action: ${actionType}`);
      return { success: false, reason: 'Unknown action' };
    }
  }

  /**
   * Item System Implementation
   */

  // Initialize item spawns across the game world
  initializeItemSpawns() {
    // Define spawn areas and their possible item types
    const spawnAreas = {
      'starting_area': {
        position: { x: 0, y: 0 },
        radius: 50,
        spawnChance: 0.3,
        itemPool: ['health_potion', 'iron_ore', 'leather_armor']
      },
      'forest_area': {
        position: { x: 200, y: 300 },
        radius: 100,
        spawnChance: 0.4,
        itemPool: ['health_potion', 'mana_potion', 'iron_ore', 'magic_crystal']
      },
      'dungeon_area': {
        position: { x: -200, y: 150 },
        radius: 75,
        spawnChance: 0.6,
        itemPool: ['iron_sword', 'steel_dagger', 'chain_mail', 'magic_crystal']
      }
    };

    // Spawn initial items
    for (const [areaId, area] of Object.entries(spawnAreas)) {
      this.itemSpawnLocations.set(areaId, area);
      this.spawnItemsInArea(areaId);
    }

    console.log('Item spawns initialized');
  }

  // Spawn items in a specific area
  spawnItemsInArea(areaId) {
    const area = this.itemSpawnLocations.get(areaId);
    if (!area) return;

    // Spawn 2-5 items per area
    const itemCount = Math.floor(Math.random() * 4) + 2;

    for (let i = 0; i < itemCount; i++) {
      if (Math.random() < area.spawnChance) {
        const itemId = area.itemPool[Math.floor(Math.random() * area.itemPool.length)];
        this.spawnItem(itemId, area.position, area.radius);
      }
    }
  }

  // Spawn a specific item at a location
  spawnItem(itemTemplateId, centerPos, radius = 0) {
    const template = this.itemDatabase[itemTemplateId];
    if (!template) {
      console.log(`Unknown item template: ${itemTemplateId}`);
      return null;
    }

    // Generate unique item ID
    const uniqueItemId = `${itemTemplateId}_${this.itemIdCounter++}`;

    // Random position within radius
    const angle = Math.random() * 2 * Math.PI;
    const distance = Math.random() * radius;
    const position = {
      x: centerPos.x + Math.cos(angle) * distance,
      y: centerPos.y + Math.sin(angle) * distance
    };

    // Create item instance
    const item = {
      id: uniqueItemId,
      templateId: itemTemplateId,
      ...template,
      position,
      spawnTime: Date.now(),
      quantity: this.itemTypes[template.type].stackable ?
        Math.floor(Math.random() * 5) + 1 : 1
    };

    this.gameItems.set(uniqueItemId, item);
    console.log(`Spawned ${item.name} at (${position.x.toFixed(1)}, ${position.y.toFixed(1)})`);

    return item;
  }

  // Initialize player inventory
  initializePlayerInventory(playerId) {
    if (this.playerInventories.has(playerId)) {
      return this.playerInventories.get(playerId);
    }

    const inventory = {
      playerId,
      items: new Map(), // slotId -> item
      equipped: new Map(), // slot -> item (weapon, armor, etc.)
      maxSlots: 20,
      createdAt: Date.now()
    };

    this.playerInventories.set(playerId, inventory);
    console.log(`Initialized inventory for player ${playerId}`);

    return inventory;
  }

  // Pickup item
  pickupItem(playerId, item, timestamp) {
    const inventory = this.initializePlayerInventory(playerId);

    // Check if inventory has space
    if (inventory.items.size >= inventory.maxSlots) {
      return { success: false, reason: 'Inventory full' };
    }

    // Check if item is stackable and player has same item
    if (this.itemTypes[item.type].stackable) {
      const existingSlot = this.findItemInInventory(playerId, item.templateId);
      if (existingSlot) {
        const existingItem = inventory.items.get(existingSlot);
        const maxStack = this.itemTypes[item.type].maxStack;
        const newQuantity = existingItem.quantity + item.quantity;

        if (newQuantity <= maxStack) {
          // Stack items
          existingItem.quantity = newQuantity;
          this.gameItems.delete(item.id); // Remove from world

          return {
            success: true,
            action: 'stacked',
            item: existingItem,
            slot: existingSlot
          };
        }
      }
    }

    // Find empty slot
    let emptySlot = null;
    for (let i = 0; i < inventory.maxSlots; i++) {
      if (!inventory.items.has(i)) {
        emptySlot = i;
        break;
      }
    }

    if (emptySlot === null) {
      return { success: false, reason: 'No empty slots' };
    }

    // Add to inventory
    inventory.items.set(emptySlot, { ...item, pickedUpAt: timestamp });
    this.gameItems.delete(item.id); // Remove from world

    console.log(`Player ${playerId} picked up ${item.name}`);

    return {
      success: true,
      action: 'picked_up',
      item: item,
      slot: emptySlot
    };
  }

  // Use/consume item
  useItem(playerId, item, timestamp, gameState) {
    const inventory = this.playerInventories.get(playerId);
    if (!inventory) {
      return { success: false, reason: 'No inventory' };
    }

    const player = gameState.players.get(playerId);
    if (!player) {
      return { success: false, reason: 'Player not found' };
    }

    // Only consumables can be used
    if (item.type !== 'CONSUMABLE') {
      return { success: false, reason: 'Item not usable' };
    }

    // Apply item effects
    const effects = this.applyItemEffects(player, item);

    // Remove one from stack or delete item
    item.quantity = Math.max(0, item.quantity - 1);
    if (item.quantity <= 0) {
      // Find and remove item from inventory
      const slot = this.findItemSlotInInventory(playerId, item.id);
      if (slot !== null) {
        inventory.items.delete(slot);
      }
    }

    console.log(`Player ${playerId} used ${item.name}, effects:`, effects);

    return {
      success: true,
      action: 'consumed',
      item: item,
      effects,
      timestamp
    };
  }

  // Apply consumable item effects to player
  applyItemEffects(player, item) {
    const effects = {};

    if (item.effects) {
      // Health restoration
      if (item.effects.health) {
        const oldHealth = player.gameState.health;
        const maxHealth = this.combatRules.maxHealth;
        player.gameState.health = Math.min(maxHealth, oldHealth + item.effects.health);
        effects.healthRestored = player.gameState.health - oldHealth;
      }

      // Mana restoration
      if (item.effects.mana) {
        const oldMana = player.gameState.mana || 100;
        const maxMana = player.gameState.maxMana || 100;
        player.gameState.mana = Math.min(maxMana, oldMana + item.effects.mana);
        effects.manaRestored = player.gameState.mana - oldMana;
      }

      // Buffs/debuffs would be implemented here
      if (item.effects.buff) {
        effects.buff = item.effects.buff;
        // Apply temporary buff to player
      }
    }

    return effects;
  }

  // Equip item
  equipItem(playerId, item, timestamp) {
    const inventory = this.playerInventories.get(playerId);
    if (!inventory) {
      return { success: false, reason: 'No inventory' };
    }

    // Only equipment can be equipped
    if (!['WEAPON', 'ARMOR'].includes(item.type)) {
      return { success: false, reason: 'Item not equippable' };
    }

    // Check if slot is occupied
    const equipSlot = this.getEquipmentSlot(item);
    const currentlyEquipped = inventory.equipped.get(equipSlot);

    if (currentlyEquipped) {
      // Unequip current item first
      this.unequipItem(playerId, currentlyEquipped, timestamp);
    }

    // Equip new item
    inventory.equipped.set(equipSlot, item);

    console.log(`Player ${playerId} equipped ${item.name} to ${equipSlot}`);

    return {
      success: true,
      action: 'equipped',
      item: item,
      slot: equipSlot,
      previousItem: currentlyEquipped || null
    };
  }

  // Unequip item
  unequipItem(playerId, item, _timestamp) {
    const inventory = this.playerInventories.get(playerId);
    if (!inventory) {
      return { success: false, reason: 'No inventory' };
    }

    const equipSlot = this.getEquipmentSlot(item);
    inventory.equipped.delete(equipSlot);

    console.log(`Player ${playerId} unequipped ${item.name} from ${equipSlot}`);

    return {
      success: true,
      action: 'unequipped',
      item: item,
      slot: equipSlot
    };
  }

  // Drop item back into world
  dropItem(playerId, item, timestamp, gameState) {
    const inventory = this.playerInventories.get(playerId);
    const player = gameState.players.get(playerId);

    if (!inventory || !player) {
      return { success: false, reason: 'Player or inventory not found' };
    }

    // Remove from inventory
    const slot = this.findItemSlotInInventory(playerId, item.id);
    if (slot !== null) {
      inventory.items.delete(slot);
    }

    // Add to world near player
    const worldItem = {
      ...item,
      id: `dropped_${item.id}_${Date.now()}`,
      position: {
        x: player.gameState.position.x + (Math.random() - 0.5) * 10,
        y: player.gameState.position.y + (Math.random() - 0.5) * 10
      },
      droppedAt: timestamp,
      droppedBy: playerId
    };

    this.gameItems.set(worldItem.id, worldItem);

    console.log(`Player ${playerId} dropped ${item.name}`);

    return {
      success: true,
      action: 'dropped',
      item: worldItem
    };
  }

  // Helper methods
  findItemInInventory(playerId, templateId) {
    const inventory = this.playerInventories.get(playerId);
    if (!inventory) return null;

    for (const [slot, item] of inventory.items) {
      if (item.templateId === templateId) {
        return slot;
      }
    }
    return null;
  }

  findItemSlotInInventory(playerId, itemId) {
    const inventory = this.playerInventories.get(playerId);
    if (!inventory) return null;

    for (const [slot, item] of inventory.items) {
      if (item.id === itemId) {
        return slot;
      }
    }
    return null;
  }

  getEquipmentSlot(item) {
    switch (item.type) {
    case 'WEAPON':
      return 'weapon';
    case 'ARMOR':
      return 'chest'; // Could expand to helmet, chest, legs, boots
    default:
      return 'misc';
    }
  }

  // Get player's current inventory
  getPlayerInventory(playerId) {
    return this.playerInventories.get(playerId);
  }

  // Get all items in world within radius of position
  getItemsNearPosition(position, radius) {
    const nearbyItems = [];

    for (const [, item] of this.gameItems) {
      const distance = this.calculateDistance(position, item.position);
      if (distance <= radius) {
        nearbyItems.push(item);
      }
    }

    return nearbyItems;
  }

  /**
   * Get anti-cheat statistics
   */
  getAntiCheatStats() {
    const totalPlayers = this.playerActions.size;
    const suspiciousCount = this.suspiciousPlayers.size;
    const totalViolations = Array.from(this.suspiciousPlayers.values())
      .reduce((sum, player) => sum + player.count, 0);

    return {
      totalPlayers,
      suspiciousPlayers: suspiciousCount,
      totalViolations,
      cheatDetectionRate: totalPlayers > 0 ? (suspiciousCount / totalPlayers) * 100 : 0
    };
  }

  /**
   * Clean up old tracking data
   */
  cleanup() {
    const cutoff = Date.now() - 300000; // 5 minutes

    // Clean old action history
    for (const [playerId, actions] of this.playerActions.entries()) {
      const recentActions = actions.filter(action => action.timestamp > cutoff);
      if (recentActions.length === 0) {
        this.playerActions.delete(playerId);
      } else {
        this.playerActions.set(playerId, recentActions);
      }
    }

    // Clean old violations
    for (const [playerId, violations] of this.suspiciousPlayers.entries()) {
      const recentViolations = violations.violations.filter(v => v.timestamp > cutoff);
      if (recentViolations.length === 0) {
        this.suspiciousPlayers.delete(playerId);
      } else {
        violations.violations = recentViolations;
        violations.count = recentViolations.length;
      }
    }
  }
}

module.exports = ServerAuthority;

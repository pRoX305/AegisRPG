-- Last Aegis Database Schema
-- PostgreSQL 14+

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table - Main player accounts
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_login TIMESTAMP WITH TIME ZONE,
    is_verified BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    verification_token VARCHAR(255),
    reset_token VARCHAR(255),
    reset_token_expires TIMESTAMP WITH TIME ZONE
);

-- Player profiles and game data
CREATE TABLE player_profiles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_rating INTEGER DEFAULT 1000,
    level INTEGER DEFAULT 1,
    experience_points INTEGER DEFAULT 0,
    region VARCHAR(10) DEFAULT 'NA',
    is_premium BOOLEAN DEFAULT FALSE,
    premium_expires TIMESTAMP WITH TIME ZONE,
    total_matches INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    total_kills INTEGER DEFAULT 0,
    total_deaths INTEGER DEFAULT 0,
    best_placement INTEGER,
    currency_coins INTEGER DEFAULT 0,
    currency_gems INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- OAuth provider accounts
CREATE TABLE oauth_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL, -- 'apple', 'google', 'facebook'
    provider_id VARCHAR(255) NOT NULL,
    provider_email VARCHAR(255),
    provider_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(provider, provider_id)
);

-- User sessions for authentication
CREATE TABLE user_sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) NOT NULL UNIQUE,
    refresh_token VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    refresh_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Security audit log
CREATE TABLE security_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL, -- 'INFO', 'WARNING', 'ERROR', 'CRITICAL'
    details JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Rate limiting tracking
CREATE TABLE rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identifier VARCHAR(255) NOT NULL, -- IP, user_id, or session_id
    action VARCHAR(50) NOT NULL,
    count INTEGER DEFAULT 1,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(identifier, action, window_start)
);

-- Matchmaking queue
CREATE TABLE matchmaking_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    game_mode VARCHAR(50) NOT NULL,
    skill_rating INTEGER NOT NULL,
    region VARCHAR(10) NOT NULL,
    queue_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    estimated_wait INTEGER, -- seconds
    preferences JSONB,
    status VARCHAR(20) DEFAULT 'WAITING' -- WAITING, MATCHED, CANCELLED
);

-- Active matches
CREATE TABLE matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_code VARCHAR(20) UNIQUE NOT NULL,
    game_mode VARCHAR(50) NOT NULL,
    map_name VARCHAR(50) NOT NULL,
    region VARCHAR(10) NOT NULL,
    server_ip INET,
    server_port INTEGER,
    max_players INTEGER NOT NULL,
    current_players INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'LOBBY', -- LOBBY, IN_PROGRESS, COMPLETED
    start_time TIMESTAMP WITH TIME ZONE,
    end_time TIMESTAMP WITH TIME ZONE,
    winner_user_id UUID REFERENCES users(id),
    match_data JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Match participants
CREATE TABLE match_participants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    match_id UUID NOT NULL REFERENCES matches(id),
    user_id UUID NOT NULL REFERENCES users(id),
    placement INTEGER,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    damage_dealt INTEGER DEFAULT 0,
    survival_time INTEGER, -- seconds
    team_id INTEGER,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    left_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(match_id, user_id)
);

-- Player inventory and items
CREATE TABLE player_inventory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    item_type VARCHAR(50) NOT NULL, -- 'weapon', 'skin', 'emote', etc.
    item_id VARCHAR(100) NOT NULL,
    quantity INTEGER DEFAULT 1,
    acquired_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, item_type, item_id)
);

-- Indexes for performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_created_at ON users(created_at);

CREATE INDEX idx_player_profiles_user_id ON player_profiles(user_id);
CREATE INDEX idx_player_profiles_skill_rating ON player_profiles(skill_rating);
CREATE INDEX idx_player_profiles_region ON player_profiles(region);

CREATE INDEX idx_oauth_accounts_user_id ON oauth_accounts(user_id);
CREATE INDEX idx_oauth_accounts_provider ON oauth_accounts(provider, provider_id);

CREATE INDEX idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

CREATE INDEX idx_security_events_user_id ON security_events(user_id);
CREATE INDEX idx_security_events_type ON security_events(event_type);
CREATE INDEX idx_security_events_created ON security_events(created_at);

CREATE INDEX idx_rate_limits_identifier ON rate_limits(identifier, action);
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);

CREATE INDEX idx_matchmaking_queue_mode ON matchmaking_queue(game_mode, region);
CREATE INDEX idx_matchmaking_queue_skill ON matchmaking_queue(skill_rating);
CREATE INDEX idx_matchmaking_queue_time ON matchmaking_queue(queue_time);

CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_matches_region ON matches(region);
CREATE INDEX idx_matches_created ON matches(created_at);

CREATE INDEX idx_match_participants_match ON match_participants(match_id);
CREATE INDEX idx_match_participants_user ON match_participants(user_id);

CREATE INDEX idx_inventory_user ON player_inventory(user_id);

-- Functions and triggers for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_player_profiles_updated_at BEFORE UPDATE ON player_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_oauth_accounts_updated_at BEFORE UPDATE ON oauth_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Default admin user (for testing)
INSERT INTO users (email, username, password_hash, salt, is_verified) VALUES 
('admin@lastaegis.com', 'admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewsG7RLzNZJMtTaq', 'admin_salt', true);

INSERT INTO player_profiles (user_id, skill_rating, level, region, is_premium) 
SELECT id, 2000, 50, 'NA', true FROM users WHERE username = 'admin';

-- Sample data for testing
INSERT INTO users (email, username, password_hash, salt, is_verified) VALUES 
('player1@test.com', 'TestPlayer1', '$2b$12$hash1', 'salt1', true),
('player2@test.com', 'TestPlayer2', '$2b$12$hash2', 'salt2', true),
('player3@test.com', 'TestPlayer3', '$2b$12$hash3', 'salt3', true);

INSERT INTO player_profiles (user_id, skill_rating, level, region) 
SELECT id, 
    1000 + (RANDOM() * 1000)::INTEGER,
    1 + (RANDOM() * 30)::INTEGER,
    CASE WHEN RANDOM() > 0.5 THEN 'NA' ELSE 'EU' END
FROM users WHERE username LIKE 'TestPlayer%';

-- Views for common queries
CREATE VIEW user_stats AS
SELECT 
    u.id,
    u.username,
    u.email,
    pp.skill_rating,
    pp.level,
    pp.total_matches,
    pp.total_wins,
    pp.total_kills,
    CASE WHEN pp.total_matches > 0 THEN ROUND((pp.total_wins::DECIMAL / pp.total_matches) * 100, 2) ELSE 0 END as win_rate,
    pp.region,
    pp.is_premium
FROM users u
JOIN player_profiles pp ON u.id = pp.user_id
WHERE u.is_active = true;

CREATE VIEW active_sessions AS
SELECT 
    us.*,
    u.username,
    u.email
FROM user_sessions us
JOIN users u ON us.user_id = u.id
WHERE us.is_active = true 
AND us.expires_at > NOW();

-- Security functions
CREATE OR REPLACE FUNCTION log_security_event(
    p_user_id UUID,
    p_event_type VARCHAR(50),
    p_severity VARCHAR(20),
    p_details JSONB DEFAULT '{}',
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    event_id UUID;
BEGIN
    INSERT INTO security_events (user_id, event_type, severity, details, ip_address, user_agent)
    VALUES (p_user_id, p_event_type, p_severity, p_details, p_ip_address, p_user_agent)
    RETURNING id INTO event_id;
    
    RETURN event_id;
END;
$$ LANGUAGE plpgsql;
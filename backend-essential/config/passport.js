const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;
const AppleStrategy = require('passport-apple').Strategy;
const fs = require('fs');
const path = require('path');

const db = require('../database/connection');
const logger = require('../utils/logger');
const { generateSecureToken } = require('../utils/security');

// Helper function to find or create user from OAuth profile
async function findOrCreateOAuthUser(provider, profile) {
  try {
    const providerId = profile.id;
    const email = profile.emails && profile.emails[0] ? profile.emails[0].value : null;
    const displayName = profile.displayName || `${profile.name?.givenName || ''} ${profile.name?.familyName || ''}`.trim();

    // First, check if OAuth account already exists
    const oauthResult = await db.query(
      'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_id = $2',
      [provider, providerId]
    );

    if (oauthResult.rows.length > 0) {
      // OAuth account exists, get user data
      const userId = oauthResult.rows[0].user_id;
      const userResult = await db.query(`
        SELECT u.id, u.email, u.username, u.is_active,
               pp.skill_rating, pp.level, pp.region
        FROM users u
        JOIN player_profiles pp ON u.id = pp.user_id
        WHERE u.id = $1
      `, [userId]);

      if (userResult.rows.length === 0) {
        throw new Error('User account not found for OAuth link');
      }

      return { user: userResult.rows[0], isNewUser: false };
    }

    // OAuth account doesn't exist, check if user exists by email
    let user = null;
    let isNewUser = true;

    if (email) {
      const userResult = await db.query(
        'SELECT id, email, username, is_active FROM users WHERE email = $1',
        [email]
      );

      if (userResult.rows.length > 0) {
        user = userResult.rows[0];
        isNewUser = false;

        // Link OAuth account to existing user
        await db.query(`
          INSERT INTO oauth_accounts (user_id, provider, provider_id, provider_email, provider_data)
          VALUES ($1, $2, $3, $4, $5)
        `, [
          user.id, 
          provider, 
          providerId, 
          email, 
          JSON.stringify({
            displayName,
            profileUrl: profile.profileUrl,
            photos: profile.photos
          })
        ]);

        logger.info(`OAuth account linked to existing user: ${user.username}`, {
          provider,
          userId: user.id,
          providerId
        });
      }
    }

    // Create new user if none exists
    if (!user) {
      if (!email) {
        throw new Error(`Email is required for ${provider} registration`);
      }

      // Generate username from display name or email
      let username = displayName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      if (!username || username.length < 3) {
        username = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      }

      // Ensure username is unique
      let uniqueUsername = username;
      let counter = 1;
      while (true) {
        const existingUser = await db.query(
          'SELECT id FROM users WHERE username = $1',
          [uniqueUsername]
        );
        
        if (existingUser.rows.length === 0) break;
        
        uniqueUsername = `${username}${counter}`;
        counter++;
      }

      // Create user account
      const userResult = await db.query(`
        INSERT INTO users (email, username, password_hash, salt, is_verified)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, email, username, created_at
      `, [
        email,
        uniqueUsername,
        generateSecureToken(32), // Dummy password hash for OAuth users
        generateSecureToken(16), // Dummy salt
        true // OAuth users are pre-verified
      ]);

      user = userResult.rows[0];

      // Create player profile
      await db.query(`
        INSERT INTO player_profiles (user_id, skill_rating, level, region)
        VALUES ($1, $2, $3, $4)
      `, [user.id, 1000, 1, 'NA']);

      // Create OAuth account link
      await db.query(`
        INSERT INTO oauth_accounts (user_id, provider, provider_id, provider_email, provider_data)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        user.id,
        provider,
        providerId,
        email,
        JSON.stringify({
          displayName,
          profileUrl: profile.profileUrl,
          photos: profile.photos
        })
      ]);

      logger.info(`New user created via OAuth: ${user.username}`, {
        provider,
        userId: user.id,
        email: user.email
      });

      isNewUser = true;
    }

    // Get complete user data with profile
    const completeUserResult = await db.query(`
      SELECT u.id, u.email, u.username, u.is_active,
             pp.skill_rating, pp.level, pp.region
      FROM users u
      JOIN player_profiles pp ON u.id = pp.user_id
      WHERE u.id = $1
    `, [user.id]);

    return { user: completeUserResult.rows[0], isNewUser };

  } catch (error) {
    logger.error(`OAuth user creation/lookup failed for ${provider}:`, error);
    throw error;
  }
}

// Google OAuth Strategy
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_REDIRECT_URI || '/api/v1/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const result = await findOrCreateOAuthUser('google', profile);
      return done(null, result);
    } catch (error) {
      logger.error('Google OAuth strategy error:', error);
      return done(error, null);
    }
  }));
} else {
  logger.warn('Google OAuth not configured - missing CLIENT_ID or CLIENT_SECRET');
}

// Facebook OAuth Strategy
if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
  passport.use(new FacebookStrategy({
    clientID: process.env.FACEBOOK_APP_ID,
    clientSecret: process.env.FACEBOOK_APP_SECRET,
    callbackURL: process.env.FACEBOOK_REDIRECT_URI || '/api/v1/auth/facebook/callback',
    profileFields: ['id', 'emails', 'name', 'displayName']
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const result = await findOrCreateOAuthUser('facebook', profile);
      return done(null, result);
    } catch (error) {
      logger.error('Facebook OAuth strategy error:', error);
      return done(error, null);
    }
  }));
} else {
  logger.warn('Facebook OAuth not configured - missing APP_ID or APP_SECRET');
}

// Apple OAuth Strategy
if (process.env.APPLE_TEAM_ID && process.env.APPLE_CLIENT_ID && process.env.APPLE_KEY_ID && process.env.APPLE_PRIVATE_KEY_PATH) {
  try {
    const privateKeyPath = path.resolve(process.env.APPLE_PRIVATE_KEY_PATH);
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

    passport.use(new AppleStrategy({
      clientID: process.env.APPLE_CLIENT_ID,
      teamID: process.env.APPLE_TEAM_ID,
      keyID: process.env.APPLE_KEY_ID,
      privateKey: privateKey,
      callbackURL: process.env.APPLE_REDIRECT_URI || '/api/v1/auth/apple/callback',
      scope: ['name', 'email']
    }, async (accessToken, refreshToken, decodedIdToken, profile, done) => {
      try {
        // Apple returns user info differently
        const appleProfile = {
          id: decodedIdToken.sub,
          emails: decodedIdToken.email ? [{ value: decodedIdToken.email }] : [],
          displayName: profile?.name?.firstName && profile?.name?.lastName ? 
            `${profile.name.firstName} ${profile.name.lastName}` : 
            (decodedIdToken.email ? decodedIdToken.email.split('@')[0] : 'Apple User'),
          name: profile?.name || {},
          provider: 'apple'
        };

        const result = await findOrCreateOAuthUser('apple', appleProfile);
        return done(null, result);
      } catch (error) {
        logger.error('Apple OAuth strategy error:', error);
        return done(error, null);
      }
    }));
  } catch (error) {
    logger.error('Apple OAuth configuration error:', error);
    logger.warn('Apple OAuth not configured - private key file not found or invalid');
  }
} else {
  logger.warn('Apple OAuth not configured - missing required environment variables');
}

// Passport serialization (not used in JWT strategy, but required)
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
const nodemailer = require('nodemailer');
const logger = require('./logger');

class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;
    this.initialize();
  }

  initialize() {
    try {
      // Check if email configuration is available
      if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        logger.warn('Email service not configured - missing SMTP credentials');
        return;
      }

      this.transporter = nodemailer.createTransporter({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: {
          ciphers: 'SSLv3'
        }
      });

      this.isConfigured = true;
      logger.info('✅ Email service configured');
    } catch (error) {
      logger.error('❌ Email service configuration failed:', error);
      this.isConfigured = false;
    }
  }

  async sendEmail(to, subject, htmlContent, textContent = null) {
    if (!this.isConfigured) {
      logger.warn('Email service not configured - email not sent');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const mailOptions = {
        from: `${process.env.FROM_NAME || 'Last Aegis'} <${process.env.FROM_EMAIL}>`,
        to,
        subject,
        html: htmlContent,
        text: textContent || this.stripHtml(htmlContent)
      };

      const info = await this.transporter.sendMail(mailOptions);

      logger.info('Email sent successfully', {
        to,
        subject,
        messageId: info.messageId
      });

      return { success: true, messageId: info.messageId };
    } catch (error) {
      logger.error('Failed to send email:', error);
      return { success: false, error: error.message };
    }
  }

  async sendVerificationEmail(email, username, verificationToken) {
    const verificationUrl = `${process.env.CLIENT_URL}/verify-email?token=${verificationToken}`;

    const subject = 'Welcome to Last Aegis - Verify Your Email';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Last Aegis</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #0a0a0a; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1a1a1a; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 28px; font-weight: 600; }
          .content { padding: 40px 20px; color: #e0e0e0; }
          .content h2 { color: #667eea; margin-top: 0; }
          .verify-button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: 600; margin: 20px 0; }
          .verify-button:hover { opacity: 0.9; }
          .footer { background-color: #0a0a0a; padding: 20px; text-align: center; color: #666; font-size: 14px; }
          .token { background-color: #2a2a2a; padding: 10px; border-radius: 5px; font-family: monospace; word-break: break-all; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🛡️ Last Aegis</h1>
          </div>
          <div class="content">
            <h2>Welcome, ${username}!</h2>
            <p>Thank you for joining Last Aegis, the ultimate battle royale experience. You're just one step away from entering the arena!</p>
            
            <p>Click the button below to verify your email address and complete your registration:</p>
            
            <p style="text-align: center;">
              <a href="${verificationUrl}" class="verify-button">Verify Email Address</a>
            </p>
            
            <p>If the button doesn't work, you can also copy and paste this link into your browser:</p>
            <div class="token">${verificationUrl}</div>
            
            <p><strong>This verification link will expire in 24 hours.</strong></p>
            
            <p>If you didn't create an account with Last Aegis, you can safely ignore this email.</p>
            
            <hr style="border: none; border-top: 1px solid #333; margin: 30px 0;">
            
            <p>Ready to drop into the arena? Here's what awaits you:</p>
            <ul>
              <li>🎯 Skill-based matchmaking</li>
              <li>🏆 Competitive ranking system</li>
              <li>🎮 Multiple game modes</li>
              <li>🌍 Global tournaments</li>
              <li>🛡️ Advanced anti-cheat protection</li>
            </ul>
          </div>
          <div class="footer">
            <p>Last Aegis Battle Royale</p>
            <p>This email was sent to ${email}. If you have any questions, contact our support team.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(email, subject, htmlContent);
  }

  async sendPasswordResetEmail(email, username, resetToken) {
    const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${resetToken}`;

    const subject = 'Last Aegis - Password Reset Request';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset - Last Aegis</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #0a0a0a; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1a1a1a; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 28px; font-weight: 600; }
          .content { padding: 40px 20px; color: #e0e0e0; }
          .content h2 { color: #667eea; margin-top: 0; }
          .reset-button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: 600; margin: 20px 0; }
          .reset-button:hover { opacity: 0.9; }
          .warning { background-color: #2a1810; border-left: 4px solid #ff6b35; padding: 15px; margin: 20px 0; border-radius: 5px; }
          .footer { background-color: #0a0a0a; padding: 20px; text-align: center; color: #666; font-size: 14px; }
          .token { background-color: #2a2a2a; padding: 10px; border-radius: 5px; font-family: monospace; word-break: break-all; margin: 10px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🛡️ Last Aegis</h1>
          </div>
          <div class="content">
            <h2>Password Reset Request</h2>
            <p>Hello ${username},</p>
            
            <p>We received a request to reset your password for your Last Aegis account. If you made this request, click the button below to reset your password:</p>
            
            <p style="text-align: center;">
              <a href="${resetUrl}" class="reset-button">Reset Password</a>
            </p>
            
            <p>If the button doesn't work, you can also copy and paste this link into your browser:</p>
            <div class="token">${resetUrl}</div>
            
            <div class="warning">
              <p><strong>⚠️ Security Notice:</strong></p>
              <ul>
                <li>This reset link will expire in 1 hour</li>
                <li>The link can only be used once</li>
                <li>If you didn't request this reset, someone may be trying to access your account</li>
              </ul>
            </div>
            
            <p>If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.</p>
            
            <p>For security reasons, we recommend:</p>
            <ul>
              <li>Using a strong, unique password</li>
              <li>Enabling two-factor authentication</li>
              <li>Never sharing your login credentials</li>
            </ul>
          </div>
          <div class="footer">
            <p>Last Aegis Battle Royale</p>
            <p>This email was sent to ${email}. If you have any security concerns, contact our support team immediately.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(email, subject, htmlContent);
  }

  async sendWelcomeEmail(email, username) {
    const subject = 'Welcome to Last Aegis - Let\'s Drop In!';
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Last Aegis</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background-color: #0a0a0a; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1a1a1a; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center; }
          .header h1 { color: white; margin: 0; font-size: 28px; font-weight: 600; }
          .content { padding: 40px 20px; color: #e0e0e0; }
          .content h2 { color: #667eea; margin-top: 0; }
          .play-button { display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 15px 30px; text-decoration: none; border-radius: 25px; font-weight: 600; margin: 20px 0; }
          .play-button:hover { opacity: 0.9; }
          .footer { background-color: #0a0a0a; padding: 20px; text-align: center; color: #666; font-size: 14px; }
          .feature { background-color: #2a2a2a; padding: 15px; margin: 10px 0; border-radius: 10px; border-left: 4px solid #667eea; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🛡️ Last Aegis</h1>
          </div>
          <div class="content">
            <h2>Welcome to the Arena, ${username}!</h2>
            <p>Your email has been verified and you're now ready to experience Last Aegis - the most intense battle royale game ever created.</p>
            
            <p style="text-align: center;">
              <a href="${process.env.CLIENT_URL || 'lastaegis://play'}" class="play-button">🚀 Start Playing Now</a>
            </p>
            
            <div class="feature">
              <h3>🎯 Your First Match</h3>
              <p>Jump into the training area to learn the basics, or dive straight into a match. The choice is yours!</p>
            </div>
            
            <div class="feature">
              <h3>🏆 Ranking System</h3>
              <p>You start at 1000 skill rating. Win matches to climb the ranks and unlock exclusive rewards!</p>
            </div>
            
            <div class="feature">
              <h3>👥 Find Your Squad</h3>
              <p>Team up with friends or get matched with players of similar skill level for the ultimate squad experience.</p>
            </div>
            
            <p>Need help getting started? Check out our:</p>
            <ul>
              <li>📖 <a href="${process.env.CLIENT_URL}/guide" style="color: #667eea;">New Player Guide</a></li>
              <li>🎮 <a href="${process.env.CLIENT_URL}/controls" style="color: #667eea;">Controls & Settings</a></li>
              <li>💬 <a href="${process.env.CLIENT_URL}/community" style="color: #667eea;">Community Discord</a></li>
            </ul>
            
            <p>See you in the arena, champion!</p>
          </div>
          <div class="footer">
            <p>Last Aegis Battle Royale</p>
            <p>Follow us for updates and tips: <a href="#" style="color: #667eea;">@LastAegisGame</a></p>
          </div>
        </div>
      </body>
      </html>
    `;

    return await this.sendEmail(email, subject, htmlContent);
  }

  stripHtml(html) {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }
}

// Create singleton instance
const emailService = new EmailService();

module.exports = {
  sendVerificationEmail: (email, username, token) => emailService.sendVerificationEmail(email, username, token),
  sendPasswordResetEmail: (email, username, token) => emailService.sendPasswordResetEmail(email, username, token),
  sendWelcomeEmail: (email, username) => emailService.sendWelcomeEmail(email, username),
  sendEmail: (to, subject, html, text) => emailService.sendEmail(to, subject, html, text)
};

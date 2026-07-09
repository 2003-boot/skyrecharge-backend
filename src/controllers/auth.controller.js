import bcrypt from 'bcryptjs';
import db from '../config/database.js';
import { generateOTP, getOTPExpiry } from '../utils/otp.js';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { sendOTPSMS } from '../services/sms.js';

// ─── CLIENT ───────────────────────────────────────

// POST /api/auth/register
export const register = async (req, res) => {
  try {
    const { first_name, phone } = req.body;

    if (!first_name || !phone) {
      return errorResponse(res, 'Prénom et numéro requis', 400);
    }

    // Vérifier si le numéro existe déjà
    const existing = await db.query(
      'SELECT id FROM users WHERE phone = $1',
      [phone]
    );

    if (existing.rows.length > 0) {
      return errorResponse(res, 'Ce numéro est déjà enregistré', 409);
    }

    // Générer OTP
    const otp = generateOTP(6);
    const expiresAt = getOTPExpiry(10);

    // Invalider les anciens OTP pour ce numéro
    await db.query(
      'UPDATE otp_codes SET is_used = TRUE WHERE phone = $1 AND is_used = FALSE',
      [phone]
    );

    // Sauvegarder le nouvel OTP
    await db.query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
      [phone, otp, expiresAt]
    );

    // Envoyer le SMS
    await sendOTPSMS(phone, otp);

    // Stocker temporairement les infos user en attendant la vérification
    await db.query(
      `INSERT INTO users (first_name, phone, is_active)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (phone) DO UPDATE SET first_name = $1`,
      [first_name, phone]
    );

    return successResponse(res, { phone }, 'Code OTP envoyé avec succès', 201);
  } catch (error) {
    console.error('Erreur register:', error);
    return errorResponse(res, 'Erreur lors de l\'inscription', 500);
  }
};

// POST /api/auth/verify-otp
export const verifyOTP = async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return errorResponse(res, 'Numéro et code requis', 400);
    }

    // Vérifier le code OTP
    const otpResult = await db.query(
      `SELECT * FROM otp_codes
       WHERE phone = $1
         AND code = $2
         AND is_used = FALSE
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [phone, code]
    );

    if (otpResult.rows.length === 0) {
      return errorResponse(res, 'Code invalide ou expiré', 400);
    }

    // Invalider le code
    await db.query(
      'UPDATE otp_codes SET is_used = TRUE WHERE id = $1',
      [otpResult.rows[0].id]
    );

    // Activer l'utilisateur
    const userResult = await db.query(
      `UPDATE users SET is_active = TRUE, updated_at = NOW()
       WHERE phone = $1
       RETURNING id, first_name, phone, wave_number`,
      [phone]
    );

    const user = userResult.rows[0];

    // Générer les tokens
    const accessToken = generateAccessToken({ id: user.id, role: 'user' });
    const refreshToken = generateRefreshToken({ id: user.id, role: 'user' });

    return successResponse(res, {
      user,
      accessToken,
      refreshToken,
    }, 'Inscription réussie');
  } catch (error) {
    console.error('Erreur verifyOTP:', error);
    return errorResponse(res, 'Erreur lors de la vérification', 500);
  }
};

// POST /api/auth/login
export const login = async (req, res) => {
  try {
    const { phone, pin } = req.body;

    if (!phone) {
      return errorResponse(res, 'Numéro requis', 400);
    }

    const userResult = await db.query(
      'SELECT * FROM users WHERE phone = $1 AND is_active = TRUE',
      [phone]
    );

    const user = userResult.rows[0];
    if (!user) {
      return errorResponse(res, 'Compte introuvable', 404);
    }

    // Connexion par PIN si activé et PIN fourni
    if (user.pin_enabled && pin) {
      const validPin = await bcrypt.compare(pin, user.pin_hash);
      if (!validPin) {
        return errorResponse(res, 'PIN incorrect', 401);
      }

      // PIN correct → connecter directement sans OTP
      const accessToken = generateAccessToken({ id: user.id, role: 'user' });
      const refreshToken = generateRefreshToken({ id: user.id, role: 'user' });

      return successResponse(res, {
        user: {
          id: user.id,
          first_name: user.first_name,
          phone: user.phone,
          wave_number: user.wave_number,
          pin_enabled: user.pin_enabled,
          notifications_enabled: user.notifications_enabled,
        },
        accessToken,
        refreshToken,
        requiresOTP: false,
        pinEnabled: true,
      }, 'Connexion réussie');
    }

    // Pas de PIN → envoyer un OTP
    const otp = generateOTP(6);
    const expiresAt = getOTPExpiry(10);

    await db.query(
      'UPDATE otp_codes SET is_used = TRUE WHERE phone = $1 AND is_used = FALSE',
      [phone]
    );

    await db.query(
      'INSERT INTO otp_codes (phone, code, expires_at) VALUES ($1, $2, $3)',
      [phone, otp, expiresAt]
    );

    await sendOTPSMS(phone, otp);

    return successResponse(res, {
      phone,
      requiresOTP: true,
      pinEnabled: user.pin_enabled || false,
    }, 'Code OTP envoyé');

  } catch (error) {
    console.error('Erreur login:', error);
    return errorResponse(res, 'Erreur lors de la connexion', 500);
  }
};

// POST /api/auth/refresh
export const refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return errorResponse(res, 'Refresh token manquant', 400);
    }

    const decoded = verifyRefreshToken(refreshToken);
    const accessToken = generateAccessToken({
      id: decoded.id,
      role: decoded.role,
    });

    return successResponse(res, { accessToken }, 'Token renouvelé');
  } catch (error) {
    return errorResponse(res, 'Refresh token invalide ou expiré', 401);
  }
};

// POST /api/auth/logout
export const logout = async (req, res) => {
  return successResponse(res, {}, 'Déconnexion réussie');
};

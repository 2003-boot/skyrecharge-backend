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

// POST /api/auth/recover-otp
// Distinct de register() : celle-ci sert à un compte qui existe déjà et a
// oublié son PIN (lien "PIN oublié ?" sur pin-login.tsx) -- register()
// refuse volontairement les numéros déjà enregistrés, ce qui est correct
// pour l'inscription mais rendait la récupération impossible (le seul
// chemin d'envoi d'OTP disponible pour ce cas était register()).
//
// Limite anti-spam : 3 envois par semaine calendaire max par compte (le
// SMS coûte réellement de l'argent) -- au-delà, on demande de passer par
// le support plutôt que de continuer à spammer le numéro.
const RECOVERY_OTP_WEEKLY_LIMIT = 3;

export const sendRecoveryOTP = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return errorResponse(res, 'Numéro requis', 400);

    const userResult = await db.query(
      'SELECT id FROM users WHERE phone = $1 AND is_active = TRUE',
      [phone]
    );
    if (userResult.rows.length === 0) {
      return errorResponse(res, 'Compte introuvable', 404);
    }

    const weeklyCountResult = await db.query(
      `SELECT COUNT(*) FROM otp_codes
       WHERE phone = $1 AND purpose = 'recovery'
         AND created_at >= date_trunc('week', CURRENT_DATE)`,
      [phone]
    );
    if (parseInt(weeklyCountResult.rows[0].count) >= RECOVERY_OTP_WEEKLY_LIMIT) {
      return errorResponse(
        res,
        'Limite de récupération par SMS atteinte pour cette semaine. Contactez le support pour récupérer votre compte.',
        429
      );
    }

    const otp = generateOTP(6);
    const expiresAt = getOTPExpiry(10);

    await db.query(
      'UPDATE otp_codes SET is_used = TRUE WHERE phone = $1 AND is_used = FALSE',
      [phone]
    );

    await db.query(
      `INSERT INTO otp_codes (phone, code, expires_at, purpose) VALUES ($1, $2, $3, 'recovery')`,
      [phone, otp, expiresAt]
    );

    await sendOTPSMS(phone, otp);

    return successResponse(res, { phone }, 'Code OTP envoyé avec succès');
  } catch (error) {
    console.error('Erreur sendRecoveryOTP:', error);
    return errorResponse(res, "Erreur lors de l'envoi du code", 500);
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

    // Connexion par PIN — dès que le compte a un PIN configuré, l'OTP ne
    // doit JAMAIS être envoyé pour se connecter, qu'il soit fourni ou non
    // dans cet appel. Le flux mobile appelle d'abord /login avec juste le
    // numéro (pour savoir si ce compte utilise un PIN et rediriger vers le
    // bon écran), PUIS rappelle /login avec le PIN une fois saisi. Avant ce
    // correctif, le premier appel (sans PIN) tombait dans la branche OTP
    // ci-dessous et envoyait un SMS inutile à chaque connexion.
    if (user.pin_enabled) {
      if (!pin) {
        // On sait déjà que ce compte utilise un PIN — on informe juste le
        // client d'aller demander le PIN, sans envoyer d'OTP.
        return successResponse(res, {
          phone,
          requiresOTP: true,
          pinEnabled: true,
        }, 'PIN requis');
      }

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

    // Compte sans PIN configuré — cas exceptionnel uniquement (ex:
    // inscription interrompue avant l'étape pin-setup obligatoire). Seul
    // cas restant où l'OTP est envoyé au login.
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

// ─── ADMIN ────────────────────────────────────────

// POST /api/auth/admin/login
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return errorResponse(res, 'Email et mot de passe requis', 400);
    }

    const adminResult = await db.query(
      'SELECT * FROM admins WHERE email = $1 AND is_active = TRUE',
      [email]
    );

    const admin = adminResult.rows[0];
    if (!admin) {
      return errorResponse(res, 'Identifiants incorrects', 401);
    }

    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      return errorResponse(res, 'Identifiants incorrects', 401);
    }

    const accessToken = generateAccessToken({ id: admin.id, role: 'admin' });
    const refreshToken = generateRefreshToken({ id: admin.id, role: 'admin' });

    return successResponse(res, {
      admin: { id: admin.id, name: admin.name, email: admin.email },
      accessToken,
      refreshToken,
    }, 'Connexion réussie');
  } catch (error) {
    console.error('Erreur adminLogin:', error);
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
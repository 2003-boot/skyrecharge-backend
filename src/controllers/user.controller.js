import bcrypt from 'bcryptjs';
import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';

export const updateProfile = async (req, res) => {
  try {
    const { first_name, wave_number, notifications_enabled, pin_enabled, pin } = req.body;

    let pinHash = null;
    if (pin) {
      pinHash = await bcrypt.hash(pin, 12);
    }
    console.log('updateProfile reçu:', { first_name, wave_number, pin_enabled, pin: pin ? 'OUI' : 'NON' });
    const result = await db.query(
      `UPDATE users
       SET first_name = COALESCE($1, first_name),
           wave_number = COALESCE($2, wave_number),
           notifications_enabled = COALESCE($3, notifications_enabled),
           pin_enabled = COALESCE($4, pin_enabled),
           pin_hash = CASE WHEN $5::text IS NOT NULL THEN $5 ELSE pin_hash END,
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, first_name, phone, wave_number,
                 notifications_enabled, pin_enabled`,
      [
        first_name || null,
        wave_number || null,
        notifications_enabled ?? null,
        pin_enabled ?? null,
        pinHash,
        req.user.id,
      ]
    );

    return successResponse(res, { user: result.rows[0] }, 'Profil mis à jour');
  } catch (error) {
    console.error('Erreur updateProfile:', error);
    return errorResponse(res, 'Erreur mise à jour profil', 500);
  }
};

// ─── POST /api/users/push-token ─────────────────────────────────────────────
// Appelé automatiquement par l'app au démarrage (une fois la permission
// notifications accordée) -- pas une action utilisateur explicite, d'où
// un endpoint dédié plutôt que de le glisser dans updateProfile.
export const registerPushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return errorResponse(res, 'Token requis', 400);
    }

    await db.query(
      `UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2`,
      [token, req.user.id]
    );

    return successResponse(res, {}, 'Token enregistré');
  } catch (error) {
    console.error('Erreur registerPushToken:', error);
    return errorResponse(res, "Erreur lors de l'enregistrement du token", 500);
  }
};
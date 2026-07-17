import bcrypt from 'bcryptjs';
import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';

export const updateProfile = async (req, res) => {
  try {
    const { first_name, wave_number, notifications_enabled, pin_enabled, pin, current_pin } = req.body;

    // Défense en profondeur : la vérification de l'ancien PIN se fait déjà
    // côté app (écran pin-setup.tsx), mais un appel direct à cette API
    // pourrait la contourner -- on revérifie donc ici aussi. Exigé quand un
    // PIN existe déjà (pas lors de la toute première configuration, où il
    // n'y a rien à prouver) -- SAUF si l'identité vient d'être prouvée par
    // un code OTP (cas "PIN oublié" -- voir viaOtp dans verifyOTP), auquel
    // cas demander l'ancien PIN n'aurait aucun sens.
    const userResult = await db.query(`SELECT pin_hash, pin_enabled FROM users WHERE id = $1`, [req.user.id]);
    const existingUser = userResult.rows[0];

    if (pin && existingUser?.pin_enabled && existingUser?.pin_hash && !req.user.viaOtp) {
      if (!current_pin) {
        return errorResponse(res, 'PIN actuel requis', 400);
      }
      const validCurrentPin = await bcrypt.compare(current_pin, existingUser.pin_hash);
      if (!validCurrentPin) {
        return errorResponse(res, 'PIN actuel incorrect', 401);
      }
    }

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
// ─── POST /api/users/verify-pin ─────────────────────────────────────────────
// Utilisé par l'écran pin-setup.tsx (mode "modifier le PIN") pour vérifier
// l'ancien PIN immédiatement, avant de laisser l'utilisateur choisir un
// nouveau PIN -- plutôt que de ne découvrir l'erreur qu'à la toute fin du
// parcours (après avoir déjà saisi + confirmé le nouveau).
export const verifyPin = async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) {
      return errorResponse(res, 'PIN requis', 400);
    }

    const userResult = await db.query(`SELECT pin_hash FROM users WHERE id = $1`, [req.user.id]);
    const existingUser = userResult.rows[0];
    if (!existingUser?.pin_hash) {
      return errorResponse(res, 'Aucun PIN configuré', 400);
    }

    const valid = await bcrypt.compare(pin, existingUser.pin_hash);
    if (!valid) {
      return errorResponse(res, 'PIN incorrect', 401);
    }

    return successResponse(res, {}, 'PIN valide');
  } catch (error) {
    console.error('Erreur verifyPin:', error);
    return errorResponse(res, 'Erreur lors de la vérification', 500);
  }
};

export const registerPushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return errorResponse(res, 'Token requis', 400);
    }

    // Un même token Expo identifie un APPAREIL, pas un compte -- si
    // quelqu'un a testé/utilisé plusieurs comptes sur ce même téléphone
    // (courant en dev, mais possible aussi pour un vrai utilisateur qui
    // change de compte), le token pouvait rester associé à l'ancien compte
    // EN PLUS du nouveau. Un push "à tous" partait alors deux fois vers le
    // même appareil. On le retire d'abord de tout autre compte avant de
    // l'associer au compte courant -- un token, un seul propriétaire.
    await db.query(
      `UPDATE users SET fcm_token = NULL WHERE fcm_token = $1 AND id != $2`,
      [token, req.user.id]
    );

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
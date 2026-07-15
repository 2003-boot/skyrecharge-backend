import db from '../config/database.js';
import { successResponse, errorResponse } from '../utils/response.js';

// ─── GET /api/notifications ─────────────────────────────────────────────────
export const getMyNotifications = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, title, body, data, is_read, sent_at
       FROM notifications
       WHERE recipient_type = 'user' AND recipient_id = $1
       ORDER BY sent_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    return successResponse(res, { notifications: result.rows }, 'Notifications récupérées');
  } catch (error) {
    console.error('Erreur getMyNotifications:', error);
    return errorResponse(res, 'Erreur lors de la récupération des notifications', 500);
  }
};

// ─── GET /api/notifications/unread-count ────────────────────────────────────
// Endpoint léger dédié -- appelé plus souvent que la liste complète (ex: au
// lancement de l'app pour le point rouge sur la cloche), pas la peine de
// renvoyer 50 lignes juste pour un chiffre.
export const getUnreadCount = async (req, res) => {
  try {
    const result = await db.query(
      `SELECT COUNT(*) FROM notifications
       WHERE recipient_type = 'user' AND recipient_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    return successResponse(res, { count: parseInt(result.rows[0].count) }, 'Compteur récupéré');
  } catch (error) {
    console.error('Erreur getUnreadCount:', error);
    return errorResponse(res, 'Erreur lors du comptage', 500);
  }
};

// ─── PATCH /api/notifications/:id/read ──────────────────────────────────────
export const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE id = $1 AND recipient_type = 'user' AND recipient_id = $2
       RETURNING id`,
      [id, req.user.id]
    );
    if (!result.rows[0]) return errorResponse(res, 'Notification introuvable', 404);
    return successResponse(res, {}, 'Notification marquée comme lue');
  } catch (error) {
    console.error('Erreur markNotificationRead:', error);
    return errorResponse(res, 'Erreur lors de la mise à jour', 500);
  }
};

// ─── PATCH /api/notifications/read-all ──────────────────────────────────────
export const markAllNotificationsRead = async (req, res) => {
  try {
    await db.query(
      `UPDATE notifications SET is_read = TRUE
       WHERE recipient_type = 'user' AND recipient_id = $1 AND is_read = FALSE`,
      [req.user.id]
    );
    return successResponse(res, {}, 'Toutes les notifications marquées comme lues');
  } catch (error) {
    console.error('Erreur markAllNotificationsRead:', error);
    return errorResponse(res, 'Erreur lors de la mise à jour', 500);
  }
};
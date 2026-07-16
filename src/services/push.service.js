import { Expo } from 'expo-server-sdk';
import db from '../config/database.js';

// Service de push via Expo — pas de credentials Firebase à gérer, Expo
// route en interne vers FCM (Android) et APNs (iOS). `users.fcm_token`
// stocke en réalité un Expo Push Token (ExponentPushToken[...]), pas un
// vrai token FCM — le nom de colonne est un héritage, mais le format
// stocké dedans a changé volontairement pour cette approche plus simple.
const expo = new Expo();

// ─── Envoi bas niveau (un seul destinataire) ───────────────────────────────
const sendExpoPush = async (expoPushToken, title, body, data = {}) => {
  if (!expoPushToken || !Expo.isExpoPushToken(expoPushToken)) {
    return { success: false, error: 'invalid_token' };
  }

  // channelId explicite obligatoire : depuis le passage à FCM V1, Expo ne
  // route plus automatiquement vers le canal "default" si channelId est
  // omis -- Android crée alors un canal de secours
  // (fcm_fallback_notification_channel) qui a le popup à l'écran DÉSACTIVÉ
  // par défaut. Sans cette ligne, la notif arrive (visible dans le tiroir)
  // mais sans jamais de popup ni de son.
  const message = { to: expoPushToken, sound: 'sky_chime.wav', title, body, data, channelId: 'default' };

  try {
    const tickets = await expo.sendPushNotificationsAsync([message]);
    const ticket = tickets[0];
    if (ticket.status === 'error') {
      console.error(`❌ Erreur push (${ticket.details?.error}):`, ticket.message);
      return { success: false, error: ticket.details?.error || 'unknown' };
    }
    return { success: true, ticketId: ticket.id };
  } catch (error) {
    console.error('❌ Erreur envoi push Expo:', error.message);
    return { success: false, error: error.message };
  }
};

// ─── Enregistre la notif en base (visible dans l'écran notifications.tsx),
// que l'envoi push ait techniquement réussi ou non -- l'utilisateur doit
// pouvoir consulter l'historique même si son token push était périmé.
// Exportée séparément de sendPushToUser : certains évènements (ex. succès
// de recharge) doivent apparaître dans l'historique in-app SANS déclencher
// de notification push, car le client est déjà en train de regarder
// l'écran de succès en direct au moment où ça se produit.
export const recordNotification = async (userId, title, body, data = {}) => {
  try {
    await db.query(
      `INSERT INTO notifications (recipient_type, recipient_id, title, body, data)
       VALUES ('user', $1, $2, $3, $4)`,
      [userId, title, body, JSON.stringify(data)]
    );
  } catch (error) {
    console.error('❌ Erreur enregistrement notification en base:', error.message);
  }
};

// ─── Envoi à UN utilisateur (par id) ────────────────────────────────────────
export const sendPushToUser = async (userId, title, body, data = {}) => {
  await recordNotification(userId, title, body, data);

  const result = await db.query(`SELECT fcm_token FROM users WHERE id = $1`, [userId]);
  const token = result.rows[0]?.fcm_token;
  if (!token) return { success: false, error: 'no_token' };

  return sendExpoPush(token, title, body, data);
};

// ─── Envoi à TOUS les utilisateurs actifs ayant un token enregistré ────────
// Traite par lots de 100 -- limite recommandée par Expo par requête.
export const broadcastPush = async (title, body, data = {}) => {
  const result = await db.query(
    `SELECT id, fcm_token FROM users WHERE is_active = TRUE AND fcm_token IS NOT NULL`
  );

  let sent = 0;
  let failed = 0;
  const CHUNK_SIZE = 100;

  for (let i = 0; i < result.rows.length; i += CHUNK_SIZE) {
    const chunk = result.rows.slice(i, i + CHUNK_SIZE);
    const messages = chunk
      .filter(u => Expo.isExpoPushToken(u.fcm_token))
      .map(u => ({ to: u.fcm_token, sound: 'sky_chime.wav', title, body, data, channelId: 'default' }));

    // La notif est enregistrée en base pour chaque utilisateur, même ceux
    // dont le token s'avérerait invalide au moment de l'envoi -- ils la
    // verront quand même dans leur historique in-app.
    await Promise.all(chunk.map(u => recordNotification(u.id, title, body, data)));

    if (messages.length === 0) continue;

    try {
      const tickets = await expo.sendPushNotificationsAsync(messages);
      tickets.forEach(t => { if (t.status === 'error') failed++; else sent++; });
    } catch (error) {
      console.error('❌ Erreur envoi push (lot):', error.message);
      failed += messages.length;
    }
  }

  console.log(`📲 Push broadcast — envoyé: ${sent}, échoué: ${failed}`);
  return { sent, failed };
};
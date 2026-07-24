import db from '../config/database.js';
import { triggerRefund, checkAndResolvePaymentStatus } from '../controllers/payment.controller.js';

// ─── Filet de sécurité durable pour les commandes bloquées ──────────────────
//
// Le timeout de 8 minutes (file d'attente) et 180s (traitement actif) dans
// ussd.service.js vit ENTIÈREMENT en mémoire du processus Node -- un
// setTimeout récursif à l'intérieur d'une promesse. Si le backend redémarre
// (déploiement, crash, manque de mémoire...) pendant qu'une commande est à
// 'in_progress', ce suivi disparaît avec le processus : plus rien ne
// surveille cette commande, elle reste bloquée indéfiniment sans jamais
// être remboursée automatiquement.
//
// Ce module recherche, directement en base (donc résistant à n'importe quel
// redémarrage), les commandes 'in_progress' depuis anormalement longtemps,
// et déclenche pour elles le même remboursement que ussd.service.js aurait
// déclenché lui-même si son timeout avait pu s'exécuter normalement.
//
// Seuil volontairement large (15 min) -- largement au-delà du pire cas
// légitime (8 min file + 180s traitement = 11 min max en fonctionnement
// normal), pour ne jamais interrompre une commande qui serait juste
// derrière beaucoup d'autres dans une file très chargée.
const STUCK_THRESHOLD_MINUTES = 15;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Toutes les 5 min, comme les autres moniteurs

const checkStuckOrders = async () => {
  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE status = 'in_progress'
         AND updated_at < NOW() - INTERVAL '${STUCK_THRESHOLD_MINUTES} minutes'`
    );

    if (result.rows.length === 0) return;

    console.warn(`🧹 [SWEEP] ${result.rows.length} commande(s) bloquée(s) à 'in_progress' depuis plus de ${STUCK_THRESHOLD_MINUTES} min -- probablement un redémarrage backend survenu en cours de traitement.`);

    for (const order of result.rows) {
      // Re-vérification juste avant d'agir : réduit (sans l'éliminer
      // complètement -- ce serait un verrou distribué, hors de proportion
      // ici) la fenêtre de course avec un résultat qui arriverait du
      // worker au même moment. Le pire cas résiduel (le worker répond
      // dans la poignée de millisecondes entre ce SELECT et l'appel
      // triggerRefund) est extrêmement improbable après 15 min d'silence.
      const recheck = await db.query(`SELECT status FROM orders WHERE id = $1`, [order.id]);
      if (recheck.rows[0]?.status !== 'in_progress') {
        console.log(`✅ [SWEEP] Commande ${order.id} résolue entre-temps, ignorée.`);
        continue;
      }

      console.error(`🚨 [SWEEP] Remboursement automatique déclenché pour la commande bloquée ${order.id}`);
      await triggerRefund(
        order,
        `Commande bloquée à 'in_progress' depuis plus de ${STUCK_THRESHOLD_MINUTES} min (redémarrage backend probable pendant le traitement)`,
        'technical'
      );
    }
  } catch (error) {
    console.error('❌ Erreur checkStuckOrders:', error.message);
  }
};

// Seuil pour les commandes 'queued' -- plus court que pour 'in_progress'
// (10 min contre 15) : une confirmation de paiement doit normalement
// arriver en quelques secondes à quelques minutes maximum en
// fonctionnement sain, webhook ou pas -- un statut 'queued' qui traîne
// aussi longtemps sans jamais avancer est fortement suspect.
const STUCK_QUEUED_THRESHOLD_MINUTES = 10;

// Pour les commandes 'queued', contrairement à 'in_progress', on ne peut
// pas juste rembourser directement : on ne sait pas encore si l'argent a
// réellement été pris ou non (c'est justement ce qu'on n'a jamais pu
// vérifier). On interroge Babimo directement pour le savoir avant d'agir
// -- exactement le même filet que le polling de processing.tsx, mais
// utilisable même si AUCUN écran n'a jamais pu tourner pour le faire (ex:
// l'app a été tuée en arrière-plan pendant le paiement Wave et a atterri
// sur l'accueil au retour au lieu de processing.tsx -- scénario réel qui
// a coûté une vraie recharge non livrée à un client).
const checkStuckQueuedOrders = async () => {
  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE status = 'queued'
         AND pay_token IS NOT NULL
         AND updated_at < NOW() - INTERVAL '${STUCK_QUEUED_THRESHOLD_MINUTES} minutes'`
    );

    if (result.rows.length === 0) return;

    console.warn(`🧹 [SWEEP] ${result.rows.length} commande(s) bloquée(s) à 'queued' depuis plus de ${STUCK_QUEUED_THRESHOLD_MINUTES} min -- vérification directe auprès de Babimo pour chacune.`);

    for (const order of result.rows) {
      try {
        // checkAndResolvePaymentStatus se charge de tout : si Babimo
        // confirme un paiement réussi (le cas qui nous intéresse ici --
        // argent pris, jamais su côté backend), elle déclenche elle-même
        // la recharge USSD comme si de rien n'était. Si Babimo dit échoué
        // /annulé, elle marque la commande 'failed' proprement (rien n'a
        // été pris, pas de remboursement nécessaire).
        await checkAndResolvePaymentStatus(order.pay_token);
      } catch (err) {
        console.error(`❌ [SWEEP] Échec vérification Babimo pour la commande ${order.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error('❌ Erreur checkStuckQueuedOrders:', error.message);
  }
};

export const startStuckOrdersMonitor = () => {
  console.log(`🧹 Filet de sécurité commandes bloquées démarré (vérification toutes les ${CHECK_INTERVAL_MS / 1000}s, seuils ${STUCK_THRESHOLD_MINUTES} min / ${STUCK_QUEUED_THRESHOLD_MINUTES} min)`);
  setInterval(checkStuckOrders, CHECK_INTERVAL_MS);
  setInterval(checkStuckQueuedOrders, CHECK_INTERVAL_MS);
  setInterval(checkRecentlyCancelledOrders, CHECK_INTERVAL_MS);
};

// Fenêtre de revérification des commandes annulées -- 1h suffit largement
// (un paiement qui finit par se confirmer arrive presque toujours dans
// les toutes premières minutes suivant l'annulation, pas des heures
// après). Au-delà, on arrête de vérifier pour ne pas spammer l'API
// Babimo indéfiniment sur de vieilles commandes.
const CANCELLED_RECHECK_WINDOW_MINUTES = 60;

// Filet complémentaire à handleSuccessfulPayment (voir payment.controller.js
// -- double perte détectée quand webhook/checkStatus arrivent APRÈS
// l'annulation). Celui-ci couvre le cas où AUCUN webhook n'arrive jamais
// du tout : sans ce balayage, une commande annulée par timeout dont le
// paiement a quand même réussi resterait 'cancelled' pour toujours, sans
// jamais être remboursée -- personne ne revérifie plus rien une fois
// l'annulation posée. checkAndResolvePaymentStatus interroge Babimo
// directement, ce qui déclenche handleSuccessfulPayment et donc, s'il y a
// bien double perte, le remboursement automatique qu'on vient d'ajouter.
const checkRecentlyCancelledOrders = async () => {
  try {
    const result = await db.query(
      `SELECT * FROM orders
       WHERE status = 'cancelled'
         AND pay_token IS NOT NULL
         AND updated_at > NOW() - INTERVAL '${CANCELLED_RECHECK_WINDOW_MINUTES} minutes'`
    );

    if (result.rows.length === 0) return;

    console.warn(`🧹 [SWEEP] ${result.rows.length} commande(s) annulée(s) récemment -- revérification auprès de Babimo au cas où le paiement aurait quand même fini par réussir.`);

    for (const order of result.rows) {
      try {
        await checkAndResolvePaymentStatus(order.pay_token);
      } catch (err) {
        console.error(`❌ [SWEEP] Échec revérification commande annulée ${order.id}:`, err.message);
      }
    }
  } catch (error) {
    console.error('❌ Erreur checkRecentlyCancelledOrders:', error.message);
  }
};
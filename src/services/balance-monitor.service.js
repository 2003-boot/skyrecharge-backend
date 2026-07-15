import redisClient from '../config/redis.js';
import db from '../config/database.js';
import { sendSMS } from './sms.js';

const BALANCE_KEY_PREFIX = 'modem_balance:';
const ALERT_COOLDOWN_KEY_PREFIX = 'balance_alert_sent:';

// Seuil d'alerte — lu depuis la table config (clé balance_alert_threshold,
// éditable sans redéploiement) plutôt que figé en dur, pour rester
// cohérent avec le seuil utilisé par le dashboard admin (même définition
// de "solde bas" partout). 5000 en secours si la config est indisponible.
const DEFAULT_BALANCE_THRESHOLD = 5000;

const getBalanceThreshold = async () => {
  try {
    const result = await db.query(`SELECT value FROM config WHERE key = 'balance_alert_threshold'`);
    const parsed = parseFloat(result.rows[0]?.value);
    return Number.isFinite(parsed) ? parsed : DEFAULT_BALANCE_THRESHOLD;
  } catch {
    return DEFAULT_BALANCE_THRESHOLD;
  }
};

// Anti-spam : une fois alerté, on ne rappelle pas le fournisseur avant
// 6h, même si le solde reste bas entre-temps.
const ALERT_COOLDOWN_SECONDS = 6 * 60 * 60;

// Fréquence à laquelle on vérifie les soldes connus (pas des requêtes
// USSD — juste une lecture de ce que le worker a déjà écrit dans Redis).
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

const OPERATOR_LABELS = { moov: 'Moov', orange: 'Orange' };

const SUPPLIER_PHONES = {
  moov: process.env.MOOV_SUPPLIER_PHONE,
  orange: process.env.ORANGE_SUPPLIER_PHONE,
};

// Le numéro EVD/commission à recharger — distinct du numéro du fournisseur
// (SUPPLIER_PHONES ci-dessus, qui reçoit juste le SMS d'alerte). Inclus
// dans le message pour que le fournisseur sache directement sur quel
// numéro faire le versement, sans avoir à demander.
const RECHARGE_NUMBERS = {
  moov: process.env.MOOV_RECHARGE_NUMBER,
  orange: process.env.ORANGE_RECHARGE_NUMBER,
};

// Les numéros fournisseurs sont stockés au format local (ex: 0101308007)
// — HSMS attend le numéro complet à 10 chiffres, 0 initial INCLUS, avec
// juste "225" devant (ex: "2250101308007") — confirmé par l'exemple
// officiel de la doc HSMS ("2250700000001") et par des tests réels. Un 0
// retiré ici produit un numéro que HSMS rejette avec "invalid_phone".
const toInternational = (localPhone) => {
  if (!localPhone) return null;
  const digits = localPhone.replace(/\s/g, '');
  return `225${digits}`;
};

const checkOperatorBalance = async (operator) => {
  try {
    const raw = await redisClient.get(`${BALANCE_KEY_PREFIX}${operator}`);
    if (!raw) return; // Pas encore de solde connu pour cet opérateur

    const { balance, checked_at } = JSON.parse(raw);
    const threshold = await getBalanceThreshold();
    if (typeof balance !== 'number' || balance >= threshold) return;

    const cooldownKey = `${ALERT_COOLDOWN_KEY_PREFIX}${operator}`;
    const alreadyAlerted = await redisClient.get(cooldownKey);
    if (alreadyAlerted) return; // Déjà alerté récemment, on n'insiste pas

    const phone = toInternational(SUPPLIER_PHONES[operator]);
    if (!phone) {
      console.warn(`⚠️ Aucun numéro fournisseur configuré pour ${operator} (MOOV_SUPPLIER_PHONE/ORANGE_SUPPLIER_PHONE manquant) — alerte impossible.`);
      return;
    }

    const label = OPERATOR_LABELS[operator] || operator;
    const rechargeNumber = RECHARGE_NUMBERS[operator];
    const message = rechargeNumber
      ? `Bonjour, le solde ${label} SkyRecharge est bas : ${balance} FCFA restants sur le ${rechargeNumber}. Merci de recharger dès que possible.`
      : `Bonjour, le solde ${label} SkyRecharge est bas : ${balance} FCFA restants. Merci de recharger dès que possible.`;

    const result = await sendSMS(phone, message);

    if (result.success) {
      console.log(`📱 Alerte solde envoyée — ${label}: ${balance} FCFA (mesuré le ${new Date(checked_at * 1000).toLocaleString('fr-FR')}) → ${phone}`);
      await redisClient.set(cooldownKey, '1', { EX: ALERT_COOLDOWN_SECONDS });
    } else {
      console.error(`❌ Échec envoi alerte solde ${label}:`, result.error);
    }

  } catch (error) {
    console.error(`❌ Erreur vérification solde ${operator}:`, error.message);
  }
};

export const startBalanceMonitor = () => {
  console.log(`💰 Monitoring de solde démarré (seuil configurable via 'balance_alert_threshold', vérification toutes les ${CHECK_INTERVAL_MS / 60000} min)`);
  setInterval(() => {
    checkOperatorBalance('moov');
    checkOperatorBalance('orange');
  }, CHECK_INTERVAL_MS);
};

// ─── Alerte instantanée sur échec réel "solde insuffisant" ─────────────────
// Le check périodique ci-dessus (checkOperatorBalance, toutes les 10 min)
// reste utile en préventif, mais laisse toujours un angle mort : le solde
// peut s'épuiser juste après un check. Dès qu'une VRAIE commande échoue
// avec cette cause précise, on le sait avec certitude et sans latence --
// appelé directement depuis payment.controller.js au moment de l'échec,
// pas besoin d'attendre le prochain sondage. Réutilise le même
// cooldown (6h) que le check périodique : les deux alertent sur le même
// problème, pas de raison d'avoir deux compteurs anti-spam séparés.
export const alertInsufficientBalanceNow = async (operator, orderId) => {
  try {
    const opKey = (operator || '').toLowerCase();
    if (!SUPPLIER_PHONES[opKey]) return; // opérateur inconnu (ex: MTN, pas encore de fournisseur configuré)

    const cooldownKey = `${ALERT_COOLDOWN_KEY_PREFIX}${opKey}`;
    const alreadyAlerted = await redisClient.get(cooldownKey);
    if (alreadyAlerted) return; // Déjà alerté récemment (périodique ou une commande précédente)

    const phone = toInternational(SUPPLIER_PHONES[opKey]);
    if (!phone) {
      console.warn(`⚠️ Aucun numéro fournisseur configuré pour ${opKey} — alerte solde insuffisant (commande ${orderId}) impossible à envoyer.`);
      return;
    }

    const label = OPERATOR_LABELS[opKey] || operator;
    const rechargeNumber = RECHARGE_NUMBERS[opKey];
    const message = rechargeNumber
      ? `Bonjour, une recharge SkyRecharge vient d'échouer par manque de solde ${label} sur le ${rechargeNumber} (commande ${orderId}). Merci de recharger dès que possible.`
      : `Bonjour, une recharge SkyRecharge vient d'échouer par manque de solde ${label} (commande ${orderId}). Merci de recharger dès que possible.`;

    const result = await sendSMS(phone, message);
    if (result.success) {
      console.log(`📱 Alerte solde insuffisant envoyée IMMÉDIATEMENT — ${label} (commande ${orderId}) → ${phone}`);
      await redisClient.set(cooldownKey, '1', { EX: ALERT_COOLDOWN_SECONDS });
    } else {
      console.error(`❌ Échec envoi alerte solde insuffisant immédiate ${label}:`, result.error);
    }
  } catch (error) {
    console.error(`❌ Erreur alerte solde insuffisant immédiate (${operator}):`, error.message);
  }
};

// ─── Traitement des alertes "double perte" ─────────────────────────────────
// Le worker Pi pousse dans cette liste Redis l'id de toute commande où la
// recharge a fini par réussir APRÈS que le backend ait déjà abandonné et
// remboursé le client (course entre le timeout et un traitement plus lent
// que prévu — voir worker.py). L'argent est déjà parti côté opérateur à ce
// stade, impossible d'annuler — on réutilise le mécanisme de "revue
// manuelle" déjà existant sur le dashboard admin (refund_status =
// 'manual_required') plutôt que de construire un système d'alerte séparé
// que personne n'ira consulter.
const DOUBLE_LOSS_ALERT_LIST = 'double_loss_alerts';
const DOUBLE_LOSS_CHECK_INTERVAL_MS = 60 * 1000; // Vérifié toutes les minutes

const processDoubleLossAlerts = async () => {
  try {
    // Vide la liste entièrement à chaque passage (pas juste un élément) —
    // au cas où plusieurs se seraient accumulés entre deux vérifications.
    let orderId = await redisClient.rPop(DOUBLE_LOSS_ALERT_LIST);
    while (orderId) {
      console.error(`🚨🚨🚨 [DOUBLE PERTE] Commande ${orderId} — remboursée par timeout MAIS la recharge a quand même réussi. Signalée pour information (rien à traiter, le remboursement a déjà eu lieu normalement).`);
      try {
        // needs_reconciliation SEUL -- ne touche jamais refund_status, qui
        // garde sa vraie valeur (le remboursement a bien été fait, ce
        // n'est pas ce qui doit être "traité" ici).
        await db.query(
          `UPDATE orders
           SET needs_reconciliation = TRUE,
               failure_reason = COALESCE(failure_reason, '') || ' | DOUBLE PERTE: recharge réussie après remboursement automatique — vérifier le solde client avant tout nouveau remboursement/geste commercial',
               updated_at = NOW()
           WHERE id = $1`,
          [orderId]
        );
      } catch (dbError) {
        // Si l'écriture en base échoue, on ne perd pas l'alerte pour
        // autant -- elle reste visible dans les logs (déjà loggée
        // ci-dessus par le worker ET par cette fonction), à traiter
        // manuellement en dernier recours.
        console.error(`❌ Impossible de marquer la commande ${orderId} pour réconciliation:`, dbError.message);
      }
      orderId = await redisClient.rPop(DOUBLE_LOSS_ALERT_LIST);
    }
  } catch (error) {
    console.error('❌ Erreur traitement alertes double perte:', error.message);
  }
};

export const startDoubleLossMonitor = () => {
  console.log(`🚨 Monitoring des doubles pertes démarré (vérification toutes les ${DOUBLE_LOSS_CHECK_INTERVAL_MS / 1000}s)`);
  setInterval(processDoubleLossAlerts, DOUBLE_LOSS_CHECK_INTERVAL_MS);
};
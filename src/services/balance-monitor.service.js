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

// Les numéros fournisseurs sont stockés au format local (ex: 0101308007)
// — HSMS attend le format international sans "+" (ex: 225101308007).
const toInternational = (localPhone) => {
  if (!localPhone) return null;
  const digits = localPhone.replace(/\s/g, '').replace(/^0/, '');
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
    const message = `Bonjour, le solde ${label} SkyRecharge est bas : ${balance} FCFA restants. Merci de recharger dès que possible.`;

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
      console.error(`🚨🚨🚨 [DOUBLE PERTE] Commande ${orderId} — remboursée par timeout MAIS la recharge a quand même réussi. Passage en revue manuelle sur le dashboard.`);
      try {
        await db.query(
          `UPDATE orders
           SET refund_status = 'manual_required',
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
        console.error(`❌ Impossible de marquer la commande ${orderId} en revue manuelle:`, dbError.message);
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
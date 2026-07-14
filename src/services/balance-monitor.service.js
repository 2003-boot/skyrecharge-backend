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
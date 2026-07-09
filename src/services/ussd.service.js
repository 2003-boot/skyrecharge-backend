import redisClient from '../config/redis.js';

const QUEUE_NAME = 'ussd_queue';
const RESULT_PREFIX = 'ussd_result:';
const POLL_INTERVAL = 1000; // Vérifier toutes les secondes

// Envoyer une commande USSD au Pi via Redis
export const sendUSSD = async (orderId, ussdCode, ussdSteps = null, modemUrl = null) => {
  try {
    const command = JSON.stringify({
      order_id: orderId,
      ussd_code: ussdCode,
      ussd_steps: ussdSteps,
      modem_url: modemUrl, // ← nouveau
    });

    console.log(`📤 Envoi commande USSD: ${ussdCode} pour commande ${orderId}`);
    console.log(`📡 Modem: ${modemUrl}`);
    await redisClient.lPush(QUEUE_NAME, command);
    console.log(`✅ Commande ajoutée dans Redis`);

    const result = await waitForResult(orderId);
    return result;

  } catch (error) {
    console.error('❌ Erreur sendUSSD:', error.message);
    throw error;
  }
};

// Attendre le résultat du Pi dans Redis — sans timeout
const waitForResult = (orderId) => {
  return new Promise((resolve, reject) => {
    const resultKey = `${RESULT_PREFIX}${orderId}`;

    console.log(`⏳ Attente résultat Pi pour: ${resultKey}`);

    const checkResult = async () => {
      try {
        const result = await redisClient.get(resultKey);

        if (result) {
          const parsed = JSON.parse(result);
          console.log(`📥 Résultat reçu du Pi:`, parsed);
          await redisClient.del(resultKey);
          resolve(parsed);
          return;
        }

        // Pas de timeout — on attend indéfiniment
        setTimeout(checkResult, POLL_INTERVAL);

      } catch (error) {
        reject(error);
      }
    };

    checkResult();
  });
};

// Générer le code USSD selon le type de commande
export const generateUSSDCode = (beneficiaryPhone) => {
  const phone = beneficiaryPhone.replace('+225', '').replace(/\s/g, '');
  return `*410*${phone}*200*2003#`;
};
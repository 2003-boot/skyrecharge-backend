import config from '../config/index.js';

// En développement on simule l'envoi SMS
// En production remplace par Africa's Talking ou Twilio
export const sendSMS = async (phone, message) => {
  if (config.nodeEnv === 'development') {
    console.log(`📱 SMS simulé vers ${phone}: ${message}`);
    return { success: true, simulated: true };
  }

  // TODO: Intégrer Africa's Talking en production
  // import AfricasTalking from 'africastalking';
  // const AT = AfricasTalking({ apiKey: config.africastalking.apiKey, username: config.africastalking.username });
  // const sms = AT.SMS;
  // return await sms.send({ to: [phone], message, from: config.africastalking.senderId });
};

export const sendOTPSMS = async (phone, otp) => {
  const message = `Votre code de vérification SkyRecharge est : ${otp}. Valable 10 minutes. Ne le partagez pas.`;
  return await sendSMS(phone, message);
};
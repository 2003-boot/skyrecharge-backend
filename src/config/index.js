import dotenv from 'dotenv';
dotenv.config();

export default {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },
  wave: {
    apiKey: process.env.WAVE_API_KEY,
    apiUrl: process.env.WAVE_API_URL,
  },
  africastalking: {
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME,
    senderId: process.env.AT_SENDER_ID,
  },
  whatsapp: {
    number: process.env.WHATSAPP_NUMBER,
  },
};
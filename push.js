const { Expo } = require('expo-server-sdk');
const expo = new Expo();

async function sendPushNotification(pushToken, { title, body, data }) {
  if (!Expo.isExpoPushToken(pushToken)) {
    console.warn('Invalid push token:', pushToken);
    return;
  }
  const messages = [{ to: pushToken, title, body, data, sound: 'default', priority: 'high', channelId: 'default' }];
  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (e) {
      console.error('Push error:', e);
    }
  }
}

module.exports = { sendPushNotification };

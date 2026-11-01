// Prints fresh random secrets to paste into your .env file.
import crypto from 'node:crypto';
console.log('SESSION_SECRET=' + crypto.randomBytes(48).toString('base64url'));
console.log('ENCRYPTION_KEY=' + crypto.randomBytes(32).toString('base64'));
console.log('WHATSAPP_VERIFY_TOKEN=' + crypto.randomBytes(18).toString('base64url'));
console.log('\n# Keep ENCRYPTION_KEY safe and never change it after accounts are connected —');
console.log('# stored account tokens can only be read with this exact key.');

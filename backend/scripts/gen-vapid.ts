import webpush from "web-push";
const k = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}`);
console.log(`VAPID_SUBJECT=mailto:admin@example.com`);
